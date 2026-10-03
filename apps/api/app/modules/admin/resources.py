"""Scoped, reviewed floor originals and external VR links.

Uploads are raw PNG/JPEG bodies. Files remain private until an independent review
publishes a floor revision through the same importer used for delivery bundles.
"""

import asyncio
import shutil
import tempfile
import unicodedata
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, RedirectResponse
from PIL import Image
from sqlalchemy import func, select

from app.api import DB, envelope, get_point, require_campus
from app.contracts import (
    AdminResource,
    CampusId,
    Envelope,
    FloorContent,
    FloorImage,
    FloorUpload,
    Pagination,
    Panorama,
    PanoramaContent,
    PanoramaDirectoryItem,
    ResourceChange,
    ResourceDraftData,
    ResourceDraftSave,
    ResourceRetireRequest,
    ReviewRequest,
)
from app.core.errors import DomainError
from app.models import (
    CampusRecord,
    FloorRecord,
    FloorUploadRecord,
    MapRecord,
    PanoramaRecord,
    PanoramaVerificationRecord,
    PointRecord,
    ResourceChangeRecord,
    now_utc,
)
from app.modules import content_control_service as control
from app.modules.admin.router import STAFF, WRITE
from app.modules.admin.security import (
    PERMISSIONS,
    Actor,
    audit,
    point_scope,
    require_point,
    require_recent_mfa,
    utc,
)
from app.modules.admin.service import conflict
from app.modules.floors.import_bundle import (
    MAX_BYTES,
    BundleFloor,
    BundleImage,
    FloorBundle,
    contained,
    import_bundle,
    inspect_image,
)
from app.modules.uploads import inspect_upload, reserve_copy, storage_guard, upload_slot
from app.modules.vr import (
    StaffVRCheck,
    StaffVRChecks,
    VRCheckSave,
    check_fingerprint,
    evidence_source,
    latest_manual_checks,
    private_check,
    public_checks,
    public_panorama,
    validate_cover,
)

router = APIRouter(tags=["resources"])
ACTIVE = {"draft", "in_review", "rejected"}


def published_content(record):
    if isinstance(record, FloorRecord):
        return FloorContent(
            label=record.label,
            ordinal=record.ordinal,
            attribution=record.attribution,
            description=record.description,
            images=[
                {
                    "section": i.get("section", "main"),
                    "section_label": i.get("section_label"),
                    "description": i.get("description", ""),
                }
                for i in record.images
                if i["variant"] == "labeled"
            ],
        )
    if record:
        return PanoramaContent.model_validate(record)
    return None


def load_resource(db, actor, resource_id, *, lock=False):
    key = str(resource_id)
    current = db.get(FloorRecord, key) or db.get(PanoramaRecord, key)
    change = db.get(ResourceChangeRecord, key)
    point_id = current.point_id if current else change.point_id if change else None
    if not point_id:
        raise DomainError("NOT_FOUND", "资料不存在", 404)
    point = require_point(db, actor.user, point_id, lock=lock)
    if lock:
        # Another editor may have created the first draft while we waited for this point.
        current = db.get(FloorRecord, key, populate_existing=True) or db.get(
            PanoramaRecord, key, populate_existing=True
        )
        change = db.get(ResourceChangeRecord, key, populate_existing=True)
    return point, current, change


def resolved_images(db, root, point_id, content, current):
    """Resolve only DB-owned paths; a client cannot submit a path or arbitrary URL."""
    result = []
    for image in content.images:
        if image.upload_id:
            upload = db.get(FloorUploadRecord, str(image.upload_id))
            if not upload or upload.point_id != point_id:
                raise DomainError("INVALID_UPLOAD", "图片不属于当前建筑或已不可用", 422)
            meta = upload.image
            path = root / ".uploads" / upload.id / meta["filename"]
            contributor = upload.uploaded_by
        else:
            source_images = current.images if current else []
            source_revision = image.source_revision or (current.revision if current else None)
            if current and source_revision != current.revision:
                from app.content_control_models import ContentVersionRecord

                historical = db.scalars(
                    select(ContentVersionRecord)
                    .where(
                        ContentVersionRecord.entity_type == "floor",
                        ContentVersionRecord.entity_id == current.id,
                        ContentVersionRecord.published_revision == source_revision,
                    )
                    .order_by(ContentVersionRecord.created_at.desc())
                ).all()
                source = next(
                    (
                        item.content.get("published")
                        for item in historical
                        if item.content.get("published") and item.content["published"].get("images")
                    ),
                    None,
                )
                source_images = source["images"] if source else []
            meta = (
                next(
                    (
                        a
                        for a in source_images
                        if a["variant"] == "labeled" and a.get("section", "main") == image.section
                    ),
                    None,
                )
                if current
                else None
            )
            if not meta:
                raise DomainError("IMAGE_REQUIRED", "新增楼层或分区需要上传标注图", 422)
            path = root / current.id / str(source_revision) / meta["filename"]
            contributor = None
        suffix = "" if image.section == "main" else "-" + image.section
        extension = "png" if meta["media_type"] == "image/png" else "jpg"
        asset = BundleImage(
            **{
                k: v
                for k, v in meta.items()
                if k not in {"filename", "variant", "section", "section_label", "description"}
            },
            variant="labeled",
            section=image.section,
            section_label=image.section_label,
            description=image.description,
            filename=f"labeled{suffix}.{extension}",
        )
        result.append((asset, contained(path, root), contributor))
    return result


def check_images(images):
    for asset, path, _ in images:
        try:
            actual = inspect_image(path)
        except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
            raise DomainError("IMAGE_UNAVAILABLE", "标注原图损坏或不可用，请重新上传", 422) from exc
        if any(actual[k] != getattr(asset, k) for k in actual):
            raise DomainError("IMAGE_CHANGED", "原图校验不一致，请重新上传", 409)


def as_resource(db, settings, resource_id, point, current, change):
    pending = change and change.state in ACTIVE
    candidate = (
        ResourceDraftData.model_validate(change.payload).content
        if pending and change.payload
        else published_content(current)
    )
    images = []
    if isinstance(candidate, FloorContent):
        # Stale drafts remain inspectable as metadata, but cannot preview or publish stale sources.
        if not pending or not current or change.base_revision == current.revision:
            for asset, _, _ in resolved_images(
                db, settings.floor_assets_dir.resolve(), point.id, candidate, current
            ):
                images.append(
                    FloorImage(
                        **asset.model_dump(exclude={"filename"}),
                        url=f"/api/v1/admin/resources/{resource_id}/images/{change.revision if pending and change.payload else 0}/{asset.section}",
                    )
                )
    draft = ResourceChange.model_validate(change) if change else None
    if draft:
        draft.updated_at = utc(draft.updated_at)
    return AdminResource(
        id=resource_id,
        point_id=point.id,
        point_name=point.name,
        kind=change.kind if change else "floor" if isinstance(current, FloorRecord) else "panorama",
        published_revision=current.revision if current else 0,
        status=current.status if current else "draft",
        current=published_content(current),
        draft=draft,
        images=images,
    )


def validate_candidate(db, point, resource_id, content, current, root):
    if isinstance(content, FloorContent):
        if isinstance(current, FloorRecord) and current.ordinal != content.ordinal:
            raise DomainError(
                "FLOOR_IDENTITY_IMMUTABLE", "已有楼层的层号不可修改；请为另一层新增资料", 422
            )
        collision = db.scalar(
            select(FloorRecord.id).where(
                FloorRecord.point_id == point.id,
                FloorRecord.ordinal == content.ordinal,
                FloorRecord.id != resource_id,
            )
        )
        pending = db.scalars(
            select(ResourceChangeRecord).where(
                ResourceChangeRecord.point_id == point.id,
                ResourceChangeRecord.kind == "floor",
                ResourceChangeRecord.resource_id != resource_id,
                ResourceChangeRecord.state.in_(ACTIVE),
            )
        )
        if collision or any(
            c.payload and c.payload["content"]["ordinal"] == content.ordinal for c in pending
        ):
            raise DomainError("FLOOR_EXISTS", "该层已有资料或待处理草稿，请编辑已有楼层", 409)
        images = resolved_images(db, root, point.id, content, current)
        check_images(images)
        return images
    validate_cover(db, point.id, content)
    return []


@router.post(
    "/api/v1/admin/points/{point_id}/floor-images",
    response_model=Envelope[FloorUpload],
    status_code=201,
    operation_id="uploadFloorOriginal",
    openapi_extra={
        **WRITE,
        "requestBody": {
            "required": True,
            "content": {
                t: {"schema": {"type": "string", "format": "binary"}}
                for t in ["image/png", "image/jpeg"]
            },
        },
    },
)
async def upload_image(point_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    point = require_point(db, actor.user, point_id)
    media_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if media_type not in {"image/png", "image/jpeg"}:
        raise DomainError("IMAGE_TYPE", "请上传 PNG 或 JPEG 标注原图", 415)
    settings = request.app.state.settings
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > MAX_BYTES):
        raise DomainError("IMAGE_TOO_LARGE", "每张图片不得超过32 MiB", 413)
    root = settings.floor_assets_dir.resolve() / ".uploads"
    root.mkdir(parents=True, exist_ok=True)
    upload_id = str(uuid4())
    target = root / upload_id
    try:
        with upload_slot(
            db, settings, actor.user, point, kind="floor", upload_id=upload_id, max_bytes=MAX_BYTES
        ) as slot:
            async with asyncio.timeout(slot.timeout_seconds):
                target.mkdir()
                path = target / "original"
                size = 0
                with path.open("xb") as file:
                    async for chunk in request.stream():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise DomainError("IMAGE_TOO_LARGE", "每张图片不得超过32 MiB", 413)
                        file.write(chunk)
                meta = await inspect_upload(path, media_type, kind="floor", settings=settings)
                filename = "labeled.png" if media_type == "image/png" else "labeled.jpg"
                path.rename(target / filename)
                record = FloorUploadRecord(
                    id=upload_id,
                    point_id=point.id,
                    uploaded_by=actor.user.id,
                    image={"filename": filename, **meta},
                )
                db.add(record)
                audit(
                    db,
                    actor.user,
                    "resource.image_uploaded",
                    point=point,
                    details={"upload_id": upload_id, **meta},
                )
                slot.complete(db, size)
                db.commit()
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        raise
    return envelope(
        request,
        FloorUpload(
            id=upload_id,
            image=FloorImage(
                variant="labeled", **meta, url=f"/api/v1/admin/floor-images/{upload_id}"
            ),
        ),
    )


@router.get(
    "/api/v1/admin/floor-images/{upload_id}",
    response_class=FileResponse,
    operation_id="previewUploadedFloor",
    openapi_extra=STAFF,
)
def uploaded_image(upload_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    image = db.get(FloorUploadRecord, str(upload_id))
    if not image:
        raise DomainError("NOT_FOUND", "图片不存在", 404)
    require_point(db, actor.user, image.point_id)
    root = request.app.state.settings.floor_assets_dir.resolve()
    path = contained(root / ".uploads" / image.id / image.image["filename"], root)
    if not path.is_file():
        raise DomainError("NOT_FOUND", "图片不可用", 404)
    return FileResponse(path, media_type=image.image["media_type"])


@router.get(
    "/api/v1/admin/resources",
    response_model=Envelope[list[AdminResource]],
    operation_id="listAdminResources",
    openapi_extra=STAFF,
)
def list_resources(
    request: Request,
    actor: Actor,
    db: DB,
    point_id: UUID | None = None,
    state: Literal["draft", "in_review", "rejected"] | None = None,
    kind: Literal["floor", "panorama"] | None = None,
    q: str = Query("", max_length=120),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
):
    actor.require("points.read")
    points = select(PointRecord).where(point_scope(actor.user))
    if point_id:
        require_point(db, actor.user, point_id)
        points = points.where(PointRecord.id == str(point_id))
    points = {p.id: p for p in db.scalars(points)}
    changes = {
        c.resource_id: c
        for c in db.scalars(
            select(ResourceChangeRecord).where(ResourceChangeRecord.point_id.in_(points))
        )
    }
    current = {
        r.id: r
        for model in (FloorRecord, PanoramaRecord)
        for r in db.scalars(select(model).where(model.point_id.in_(points)))
    }
    keys = sorted(set(current) | set(changes))
    if state:
        keys = [k for k in keys if k in changes and changes[k].state == state]
    else:
        keys = [k for k in keys if k in current or changes[k].state != "discarded"]

    def catalog_info(key):
        change, record = changes.get(key), current.get(key)
        resource_kind = (
            change.kind if change else ("floor" if isinstance(record, FloorRecord) else "panorama")
        )
        content = (
            (change.payload or {}).get("content", {}) if change and change.state in ACTIVE else {}
        )
        title = (
            content.get("title")
            or content.get("label")
            or (
                record.label
                if isinstance(record, FloorRecord)
                else record.title
                if record
                else "资料"
            )
        )
        point = points[(record or change).point_id]
        return resource_kind, point.name, title

    term = unicodedata.normalize("NFKC", q.strip()).casefold()
    info = {key: catalog_info(key) for key in keys}
    keys = [
        key
        for key in keys
        if (not kind or info[key][0] == kind)
        and (not term or term in unicodedata.normalize("NFKC", " ".join(info[key][1:])).casefold())
    ]
    keys.sort(key=lambda key: (*info[key][1:], key))
    selected = keys[(page - 1) * page_size : page * page_size]
    result = [
        as_resource(
            db,
            request.app.state.settings,
            k,
            points[(current.get(k) or changes[k]).point_id],
            current.get(k),
            changes.get(k),
        )
        for k in selected
    ]
    return envelope(request, result, Pagination(page=page, page_size=page_size, total=len(keys)))


@router.get(
    "/api/v1/admin/resources/{resource_id}",
    response_model=Envelope[AdminResource],
    operation_id="getAdminResource",
    openapi_extra=STAFF,
)
def get_resource(resource_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(
        request,
        as_resource(
            db, request.app.state.settings, str(resource_id), *load_resource(db, actor, resource_id)
        ),
    )


@control.write_guard
def save_resource(point_id, resource_id, payload, request, actor, db, *, commit=True):
    with storage_guard(request.app.state.settings):
        return _save_resource(point_id, resource_id, payload, request, actor, db, commit=commit)


def _save_resource(point_id, resource_id, payload, request, actor, db, *, commit=True):
    actor.require("points.edit")
    entity_type = "floor" if payload.content.kind == "floor" else "vr"
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        "save",
        str(resource_id) if resource_id else None,
        payload.model_dump(mode="json"),
    )
    if old is not None:
        return envelope(request, old)
    if resource_id:
        point, current, change = load_resource(db, actor, resource_id, lock=True)
        key = str(resource_id)
    else:
        point = require_point(db, actor.user, point_id, lock=True)
        current, change, key = None, None, str(uuid4())
    if (change.revision if change else 0) != payload.expected_revision or (
        current.revision if current else 0
    ) != payload.expected_published_revision:
        conflict()
    if change and change.state == "in_review":
        conflict("资料正在审核，请先撤回或等待审核结果")
    kind = (
        change.kind
        if change
        else published_content(current).kind
        if current
        else payload.content.kind
    )
    if kind != payload.content.kind:
        raise DomainError("RESOURCE_KIND_IMMUTABLE", "不能改变资料类型", 422)
    images = validate_candidate(
        db,
        point,
        key,
        payload.content,
        current,
        request.app.state.settings.floor_assets_dir.resolve(),
    )
    values = payload.model_dump(
        mode="json", exclude={"expected_revision", "expected_published_revision", "operation_id"}
    )
    if change and change.operation == "upsert" and change.payload == values:
        result = as_resource(
            db, request.app.state.settings, key, point, current, change
        ).model_dump(mode="json")
        control.finish_operation(
            db, actor, payload.operation_id, entity_type, key, "save", fingerprint, result
        )
        if commit:
            db.commit()
        return envelope(request, result)
    contributors = (
        set(change.contributor_ids) if change and change.state in {"draft", "rejected"} else set()
    )
    contributors.add(actor.user.id)
    contributors.update(user for _, _, user in images if user)
    # Reusing a published original still includes its real uploader. The exact
    # point and verified byte digest bind provenance without inventing an actor
    # for files imported before upload attribution existed.
    reused_hashes = {asset.sha256 for asset, _, user in images if not user}
    if reused_hashes:
        contributors.update(
            upload.uploaded_by
            for upload in db.scalars(
                select(FloorUploadRecord).where(FloorUploadRecord.point_id == point.id)
            )
            if upload.image.get("sha256") in reused_hashes
        )
    if change is None:
        change = ResourceChangeRecord(resource_id=key, point_id=point.id, kind=kind, revision=1)
        db.add(change)
    else:
        change.revision += 1
    change.base_revision = current.revision if current else 0
    change.payload = values
    change.contributor_ids = sorted(contributors)
    change.editor_id = actor.user.id
    change.state, change.operation = "draft", "upsert"
    change.submitted_by = change.submitted_at = None
    change.review_note, change.updated_at = "", now_utc()
    audit(
        db,
        actor.user,
        "resource.draft_saved",
        point=point,
        note=payload.source_note,
        details={
            "resource_id": key,
            "kind": kind,
            "revision": change.revision,
            "payload": change.payload,
        },
    )
    db.flush()
    control.unfreeze(db, entity_type, key)
    control.record_history(db, entity_type, key, "autosave", actor)
    result = as_resource(db, request.app.state.settings, key, point, current, change).model_dump(
        mode="json"
    )
    control.finish_operation(
        db, actor, payload.operation_id, entity_type, key, "save", fingerprint, result
    )
    if commit:
        db.commit()
    else:
        db.flush()
    return envelope(request, result)


@router.post(
    "/api/v1/admin/points/{point_id}/resources",
    response_model=Envelope[AdminResource],
    status_code=201,
    operation_id="createResourceDraft",
    openapi_extra=WRITE,
)
def create_resource(
    point_id: UUID, payload: ResourceDraftSave, request: Request, actor: Actor, db: DB
):
    return save_resource(point_id, None, payload, request, actor, db)


@router.put(
    "/api/v1/admin/resources/{resource_id}",
    response_model=Envelope[AdminResource],
    operation_id="updateResourceDraft",
    openapi_extra=WRITE,
)
def update_resource(
    resource_id: UUID, payload: ResourceDraftSave, request: Request, actor: Actor, db: DB
):
    return save_resource(None, resource_id, payload, request, actor, db)


@router.get(
    "/api/v1/admin/resources/{resource_id}/images/{draft_revision}/{section}",
    response_class=FileResponse,
    operation_id="previewResourceFloor",
    openapi_extra=STAFF,
)
def preview_resource(
    resource_id: UUID, draft_revision: int, section: str, request: Request, actor: Actor, db: DB
):
    actor.require("points.read")
    point, current, change = load_resource(db, actor, resource_id)
    if draft_revision:
        if (
            not change
            or change.revision != draft_revision
            or change.state not in ACTIVE
            or not change.payload
        ):
            raise DomainError("NOT_FOUND", "草稿版本已改变，请重新加载", 404)
        if (current.revision if current else 0) != change.base_revision:
            conflict("正式楼层已更新，请重新保存草稿")
        content = ResourceDraftData.model_validate(change.payload).content
    else:
        content = published_content(current)
    if not isinstance(content, FloorContent):
        raise DomainError("NOT_FOUND", "楼层图片不存在", 404)
    images = resolved_images(
        db, request.app.state.settings.floor_assets_dir.resolve(), point.id, content, current
    )
    for asset, path, _ in images:
        if asset.section == section and path.is_file():
            return FileResponse(path, media_type=asset.media_type)
    raise DomainError("NOT_FOUND", "楼层图片不存在", 404)


def publish_floor(db, settings, point, key, content, current, actor, source_note):
    root = settings.floor_assets_dir.resolve()
    images = validate_candidate(db, point, key, content, current, root)
    floor = BundleFloor(
        id=key,
        point_id=point.id,
        map_id=current.map_id if current else uuid5(UUID(key), "map"),
        label=content.label,
        ordinal=content.ordinal,
        attribution=content.attribution,
        description=content.description,
        revision=current.revision + 1 if current else 1,
        images=[a for a, _, _ in images],
    )
    reserve_copy(
        db,
        settings,
        actor.user,
        point,
        asset_id=f"{key}/{floor.revision}",
        size_bytes=sum(asset.size_bytes for asset, _, _ in images),
    )
    with tempfile.TemporaryDirectory(prefix=".review-", dir=root) as tmp:
        bundle_root = Path(tmp)
        folder = bundle_root / key / str(floor.revision)
        folder.mkdir(parents=True)
        for asset, path, _ in images:
            shutil.copyfile(path, folder / asset.filename)
        bundle = FloorBundle(schema_version=1, source_note=source_note, floors=[floor])
        (bundle_root / "manifest.json").write_text(
            bundle.model_dump_json(exclude_defaults=True), encoding="utf-8"
        )
        try:
            import_bundle(
                bundle_root,
                root,
                db,
                reviewer=actor.user.display_name,
                rights_note=source_note,
                publish=True,
            )
        except ValueError as exc:
            raise DomainError(
                "FLOOR_PUBLISH_CONFLICT", "楼层版本或资源不一致，请重新核对后发布", 409
            ) from exc


@router.post(
    "/api/v1/admin/resources/{resource_id}/retire",
    response_model=Envelope[AdminResource],
    operation_id="requestResourceRetirement",
    openapi_extra=WRITE,
)
def retire_resource(
    resource_id: UUID, payload: ResourceRetireRequest, request: Request, actor: Actor, db: DB
):
    actor.require("points.edit")
    point, current, change = load_resource(db, actor, resource_id, lock=True)
    entity_type = (
        "floor" if (change.kind if change else published_content(current).kind) == "floor" else "vr"
    )
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        "retire",
        str(resource_id),
        payload.model_dump(mode="json"),
    )
    if old is not None:
        return envelope(request, old)
    if not current or current.status != "published" or (change and change.state in ACTIVE):
        conflict("请先处理已有草稿；只能为已发布资料申请下架")
    if (
        current.revision != payload.expected_published_revision
        or (change.revision if change else 0) != payload.expected_revision
    ):
        conflict()
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写下架原因", 422)
    if change is None:
        change = ResourceChangeRecord(
            resource_id=str(resource_id),
            point_id=point.id,
            kind=published_content(current).kind,
            revision=1,
        )
        db.add(change)
    else:
        change.revision += 1
    change.base_revision, change.state, change.operation, change.payload = (
        current.revision,
        "in_review",
        "retire",
        None,
    )
    change.editor_id, change.contributor_ids = actor.user.id, [actor.user.id]
    change.submitted_by, change.submitted_at = actor.user.id, now_utc()
    change.review_note, change.updated_at = payload.note.strip(), now_utc()
    audit(
        db,
        actor.user,
        "resource.retire_requested",
        point=point,
        note=payload.note,
        details={"resource_id": str(resource_id), "revision": change.revision},
    )
    db.flush()
    control.freeze(db, entity_type, str(resource_id))
    control.record_history(db, entity_type, str(resource_id), "retire_request", actor, force=True)
    result = as_resource(
        db, request.app.state.settings, str(resource_id), point, current, change
    ).model_dump(mode="json")
    control.finish_operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        str(resource_id),
        "retire",
        fingerprint,
        result,
    )
    db.commit()
    return envelope(request, result)


@router.post(
    "/api/v1/admin/resources/{resource_id}/review/{action}",
    response_model=Envelope[AdminResource],
    operation_id="transitionResourceReview",
    openapi_extra=WRITE,
)
def review_resource(
    resource_id: UUID,
    action: Literal["submit", "publish", "reject", "discard"],
    payload: ReviewRequest,
    request: Request,
    actor: Actor,
    db: DB,
):
    with storage_guard(request.app.state.settings):
        return _review_resource(resource_id, action, payload, request, actor, db)


@control.write_guard
def _review_resource(resource_id, action, payload, request, actor, db):
    actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
    if action == "publish":
        require_recent_mfa(actor)
    point, current, change = load_resource(db, actor, resource_id, lock=True)
    entity_type = (
        "floor" if (change.kind if change else published_content(current).kind) == "floor" else "vr"
    )
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        action,
        str(resource_id),
        payload.model_dump(mode="json"),
    )
    if old is not None:
        return envelope(request, old)
    if payload.expected_published_revision is not None and payload.expected_published_revision != (
        current.revision if current else 0
    ):
        conflict()
    if not change or change.revision != payload.expected_revision:
        conflict()
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写操作说明", 422)
    if action == "submit":
        if (
            change.state not in {"draft", "rejected"}
            or (current.revision if current else 0) != change.base_revision
        ):
            conflict("正式资料或草稿状态已改变，请重新保存草稿")
        if change.operation == "retire":
            if not current or current.status != "published":
                conflict("只能为已发布资料提交下架申请")
        else:
            content = ResourceDraftData.model_validate(change.payload).content
            validate_candidate(
                db,
                point,
                str(resource_id),
                content,
                current,
                request.app.state.settings.floor_assets_dir.resolve(),
            )
        change.state, change.submitted_by, change.submitted_at = (
            "in_review",
            actor.user.id,
            now_utc(),
        )
    elif action == "discard":
        if change.state not in ACTIVE:
            conflict("当前没有可撤回的草稿")
        if actor.user.role != "admin" and actor.user.id not in change.contributor_ids:
            raise DomainError("FORBIDDEN", "只能撤回自己参与编辑的草稿", 403)
        change.state = "discarded"
    else:
        if change.state != "in_review":
            conflict("只能审核已提交的资料")
        if actor.user.id in change.contributor_ids or actor.user.id == change.submitted_by:
            raise DomainError("SELF_REVIEW_DENIED", "不能审核自己上传、编辑或提交的资料", 403)
        control.check_frozen(db, entity_type, str(resource_id))
        if action == "reject":
            change.state = "rejected"
        else:
            if (current.revision if current else 0) != change.base_revision:
                conflict("正式资料已改变，请退回后重新核对")
            before = published_content(current)
            if change.operation == "retire":
                current.status = "retired"
                if isinstance(current, FloorRecord):
                    db.get(MapRecord, current.map_id).status = "retired"
                # A withdrawal changes availability, not immutable floor image bytes.
            else:
                campus = db.get(CampusRecord, point.campus_id)
                if (
                    point.status != "published"
                    or point.visibility != "public"
                    or not campus.is_active
                ):
                    raise DomainError("POINT_NOT_PUBLIC", "请先发布所属地点，再发布其资料", 409)
                candidate = ResourceDraftData.model_validate(change.payload)
                if isinstance(candidate.content, FloorContent):
                    publish_floor(
                        db,
                        request.app.state.settings,
                        point,
                        str(resource_id),
                        candidate.content,
                        current,
                        actor,
                        candidate.source_note,
                    )
                    current = db.get(FloorRecord, str(resource_id))
                else:
                    validate_candidate(db, point, str(resource_id), candidate.content, current,
                                       request.app.state.settings.floor_assets_dir.resolve())
                    values = candidate.content.model_dump(mode="json", exclude={"kind"})
                    if current is None:
                        current = PanoramaRecord(
                            id=str(resource_id), point_id=point.id, revision=1, **values
                        )
                        db.add(current)
                    else:
                        if current.url != candidate.content.url:
                            current.verification_generation += 1
                        for k, v in values.items():
                            setattr(current, k, v)
                        current.revision += 1
                    current.status = "published"
            change.state = "published"
            audit(
                db,
                actor.user,
                "resource.published" if change.operation == "upsert" else "resource.retired",
                point=point,
                note=payload.note,
                details={
                    "resource_id": str(resource_id),
                    "before": before.model_dump(mode="json") if before else None,
                    "after": published_content(current).model_dump(mode="json"),
                    "status": current.status,
                },
            )
    change.revision += 1
    change.review_note, change.updated_at = payload.note.strip(), now_utc()
    if action != "publish":
        audit(
            db,
            actor.user,
            "resource." + action,
            point=point,
            note=payload.note,
            details={"resource_id": str(resource_id), "revision": change.revision},
        )
    db.flush()
    if action == "submit":
        control.freeze(db, entity_type, str(resource_id))
    else:
        control.unfreeze(db, entity_type, str(resource_id))
    control.record_history(db, entity_type, str(resource_id), action, actor, force=True)
    result = as_resource(
        db, request.app.state.settings, str(resource_id), point, current, change
    ).model_dump(mode="json")
    control.finish_operation(
        db, actor, payload.operation_id, entity_type, str(resource_id), action, fingerprint, result
    )
    db.commit()
    return envelope(request, result)


@router.get(
    "/api/v1/points/{point_id}/panoramas",
    response_model=Envelope[list[Panorama]],
    operation_id="listPointPanoramas",
    openapi_extra={"x-implementation-status": "implemented", "x-module": "M02"},
)
def public_panoramas(point_id: UUID, request: Request, db: DB):
    get_point(point_id, request, db)
    if not request.app.state.settings.vr_enabled:
        return envelope(request, [])
    rows = db.scalars(
        select(PanoramaRecord)
        .where(PanoramaRecord.point_id == str(point_id), PanoramaRecord.status == "published")
        .order_by(PanoramaRecord.sort_order, PanoramaRecord.title, PanoramaRecord.id)
    ).all()
    checks = public_checks(db, rows)
    return envelope(request, [public_panorama(db, row, checks) for row in rows])


@router.get(
    "/api/v1/points/{point_id}/panoramas/{resource_id}/cover/{revision}/{image_id}/{image_revision}",
    response_class=FileResponse, operation_id="getPanoramaCover", openapi_extra={"x-implementation-status": "implemented", "x-module": "M02"},
)
def public_panorama_cover(point_id: UUID, resource_id: UUID, revision: int, image_id: UUID,
                          image_revision: int, request: Request, db: DB):
    get_point(point_id, request, db)
    current = db.get(PanoramaRecord, str(resource_id))
    if (not request.app.state.settings.vr_enabled or not current or current.status != "published"
        or current.point_id != str(point_id) or current.revision != revision
        or current.cover_image_id != str(image_id) or current.cover_image_revision != image_revision):
        raise DomainError("NOT_FOUND", "VR封面引用已更新或不可用", 404)
    from app.modules.experiences import public_media, referenced_media

    record, content = referenced_media(db, image_id, "image", point_id)
    if record.published_revision != image_revision:
        raise DomainError("NOT_FOUND", "VR封面图片版本已改变", 404)
    if content.url:
        return RedirectResponse(content.url, status_code=307, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return public_media(image_id, request, db)


@router.get(
    "/api/v1/campuses/{campus_id}/panoramas",
    response_model=Envelope[list[PanoramaDirectoryItem]],
    operation_id="listCampusPanoramas",
    openapi_extra={"x-implementation-status": "implemented", "x-module": "M02"},
)
def public_panorama_directory(
    campus_id: CampusId,
    request: Request,
    db: DB,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=100),
):
    require_campus(db, campus_id)
    query = (
        select(PanoramaRecord, PointRecord)
        .join(PointRecord)
        .where(
            PointRecord.campus_id == campus_id,
            PointRecord.status == "published",
            PointRecord.visibility == "public",
            PanoramaRecord.status == "published",
        )
    )
    if not request.app.state.settings.vr_enabled:
        return envelope(request, [], Pagination(page=page, page_size=page_size, total=0))
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.execute(
        query.order_by(PanoramaRecord.sort_order, PanoramaRecord.title, PanoramaRecord.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    checks = public_checks(db, [panorama for panorama, _ in rows])
    return envelope(
        request,
        [
            PanoramaDirectoryItem(
                **public_panorama(db, panorama, checks).model_dump(),
                campus_id=point.campus_id,
                point_name=point.name,
                point_category=point.category,
            )
            for panorama, point in rows
        ],
        Pagination(page=page, page_size=page_size, total=total),
    )


def vr_check_target(db, actor, resource_id, *, lock=False):
    point, current, change = load_resource(db, actor, resource_id, lock=lock)
    content = (ResourceDraftData.model_validate(change.payload).content
               if change and change.state in ACTIVE and change.payload
               else published_content(current))
    if not isinstance(content, PanoramaContent):
        raise DomainError("NOT_FOUND", "VR资料不存在", 404)
    return point, current, change, content


@router.get(
    "/api/v1/admin/resources/{resource_id}/vr-checks",
    response_model=Envelope[StaffVRChecks], operation_id="listVRManualChecks", openapi_extra=STAFF,
)
def list_vr_checks(resource_id: UUID, request: Request, actor: Actor, db: DB,
                   limit: int = Query(50, ge=1, le=100)):
    actor.require("points.read")
    point, current, change, content = vr_check_target(db, actor, resource_id)
    rows = db.scalars(select(PanoramaVerificationRecord).where(
        PanoramaVerificationRecord.resource_id == str(resource_id),
        PanoramaVerificationRecord.point_id == point.id,
    ).order_by(PanoramaVerificationRecord.recorded_at.desc(), PanoramaVerificationRecord.id.desc()).limit(limit + 1)).all()
    source = evidence_source(current, content)
    return envelope(request, StaffVRChecks(resource_id=resource_id,
        expected_revision=change.revision if change else 0,
        expected_published_revision=current.revision if current else 0,
        items=[private_check(row, source) for row in rows[:limit]],
        latest=latest_manual_checks(db, resource_id, point.id, source), has_more=len(rows) > limit))


@router.post(
    "/api/v1/admin/resources/{resource_id}/vr-checks",
    response_model=Envelope[StaffVRCheck], status_code=201,
    operation_id="recordVRManualCheck", openapi_extra=WRITE,
)
def record_vr_check(resource_id: UUID, payload: VRCheckSave, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    if not PERMISSIONS[actor.user.role].intersection({"points.edit", "points.review"}):
        raise DomainError("FORBIDDEN", "账号没有登记核查记录的权限", 403)
    point, current, change, content = vr_check_target(db, actor, resource_id, lock=True)
    source = evidence_source(current, content)
    fingerprint = check_fingerprint(resource_id, payload)
    old = db.scalar(select(PanoramaVerificationRecord).where(PanoramaVerificationRecord.operation_id == str(payload.operation_id)))
    if old:
        if old.recorded_by != actor.user.id or old.payload_sha256 != fingerprint:
            conflict("原核查操作已使用，请先查询历史记录")
        return envelope(request, private_check(old, source))
    if (change.revision if change else 0) != payload.expected_revision or (current.revision if current else 0) != payload.expected_published_revision:
        conflict("VR草稿或正式链接已改变，请重新读取后登记人工核查")
    row = PanoramaVerificationRecord(operation_id=str(payload.operation_id), payload_sha256=fingerprint,
        resource_id=str(resource_id), point_id=point.id, generation=source[0], url_sha256=source[1],
        dimension=payload.dimension, platform=payload.platform, result=payload.result, reason=payload.reason,
        environment=payload.environment, notes=payload.notes, recorded_by=actor.user.id, recorded_at=now_utc())
    db.add(row)
    db.flush()
    audit(db, actor.user, "vr.manual_check_recorded", point=point, details={"resource_id":str(resource_id),
        "check_id":row.id,"dimension":row.dimension,"platform":row.platform,"result":row.result,
        "method":"manual","generation":row.generation})
    db.commit()
    return envelope(request, private_check(row, source))


@router.get(
    "/api/v1/admin/resources/{resource_id}/vr-checks/operations/{operation_id}",
    response_model=Envelope[StaffVRCheck | None], operation_id="getVRManualCheckOperation", openapi_extra=STAFF,
)
def vr_check_operation(resource_id: UUID, operation_id: UUID, request: Request, actor: Actor, db: DB):
    """A missing receipt is only an observation; this GET never repeats a write."""
    actor.require("points.read")
    point, current, change, content = vr_check_target(db, actor, resource_id)
    row = db.scalar(select(PanoramaVerificationRecord).where(
        PanoramaVerificationRecord.operation_id == str(operation_id),
        PanoramaVerificationRecord.resource_id == str(resource_id),
        PanoramaVerificationRecord.point_id == point.id,
        PanoramaVerificationRecord.recorded_by == actor.user.id,
    ))
    return envelope(request, private_check(row, evidence_source(current, content)) if row else None)
