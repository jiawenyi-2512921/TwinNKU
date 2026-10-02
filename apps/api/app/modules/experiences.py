"""Independently reviewed media, check-in suggestions and ordered campus tours.

Tour stops describe a presentation sequence, never an invented walking path.
Owned media is served through authorization on every request, including ranges.
"""

import hashlib
import json
import shutil
import subprocess
import unicodedata
import warnings
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import Field, TypeAdapter, field_validator, model_validator
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from app.api import DB, envelope
from app.contracts import (
    DTO,
    CampusId,
    Envelope,
    PanoramaContent,
    ResourceRetireRequest,
    ReviewRequest,
)
from app.core.errors import DomainError
from app.models import (
    AdminAuditRecord,
    CampusRecord,
    ExperienceRecord,
    ExperienceUploadRecord,
    PointRecord,
    now_utc,
)
from app.modules.admin.router import STAFF, WRITE
from app.modules.admin.security import Actor, audit, require_point
from app.modules.admin.service import conflict
from app.modules.floors.import_bundle import contained

router = APIRouter(tags=["experiences"])
PUBLIC = {"x-implementation-status": "implemented", "x-module": "M06", "x-auth": "public"}
EXPERIENCE_STAFF = {**STAFF, "x-module": "M06"}
EXPERIENCE_WRITE = {**WRITE, "x-module": "M06"}
ACTIVE = {"draft", "in_review", "rejected"}
MAX_MEDIA_BYTES = 100 * 1024 * 1024
MIME_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "video/mp4": "mp4",
    "video/webm": "webm",
}
ExperienceKind = Literal["media", "checkin", "tour"]
ExperienceState = Literal["draft", "in_review", "rejected", "published", "discarded"]


class ExperienceBase(DTO):
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=8000)
    source_note: str = Field(min_length=1, max_length=2000)

    @field_validator("title", "source_note")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("text is required")
        return value.strip()


class ExperienceMediaContent(ExperienceBase):
    point_id: UUID
    kind: Literal["media"] = "media"
    media_type: Literal["image", "video"]
    upload_id: UUID | None = None
    url: str | None = Field(default=None, max_length=2048)

    @field_validator("url")
    @classmethod
    def safe_url(cls, value):
        return PanoramaContent.safe_external_url(value) if value is not None else None

    @model_validator(mode="after")
    def source(self):
        if bool(self.upload_id) == bool(self.url):
            raise ValueError("choose exactly one upload or HTTPS URL")
        return self


class ExperienceCheckinContent(ExperienceBase):
    point_id: UUID
    kind: Literal["checkin"] = "checkin"
    image_id: UUID | None = None


class ExperienceStop(DTO):
    point_id: UUID
    narrative: str = Field(default="", max_length=8000)
    video_id: UUID | None = None
    checkin_id: UUID | None = None
    prompt_timing: Literal["on_arrival", "after_intro", "manual"] = "manual"


class ExperienceTourContent(ExperienceBase):
    campus_id: CampusId
    kind: Literal["tour"] = "tour"
    stops: list[ExperienceStop] = Field(min_length=1, max_length=50)


ExperienceContent = Annotated[
    ExperienceMediaContent | ExperienceCheckinContent | ExperienceTourContent,
    Field(discriminator="kind"),
]
CONTENT = TypeAdapter(ExperienceContent)


class ExperienceSave(DTO):
    expected_revision: int = Field(ge=0)
    expected_published_revision: int = Field(ge=0)
    content: ExperienceContent


class PublicExperience(DTO):
    campus_id: CampusId
    id: UUID
    revision: int
    content: ExperienceContent
    media_url: str | None = None


class AdminExperience(DTO):
    campus_id: CampusId
    id: UUID
    revision: int
    published_revision: int
    operation: Literal["upsert", "retire"]
    state: ExperienceState
    status: Literal["draft", "published", "retired"]
    content: ExperienceContent | None
    published_content: ExperienceContent | None
    contributor_ids: list[UUID]
    submitted_by: UUID | None
    review_note: str
    media_url: str | None = None


class ExperienceUpload(DTO):
    id: UUID
    point_id: UUID
    media_type: Literal["image", "video"]
    mime_type: str
    filename: str
    size_bytes: int
    url: str


def content_points(content):
    if isinstance(content, ExperienceTourContent):
        return {str(stop.point_id) for stop in content.stops}
    return {str(content.point_id)}


def experience_anchor(content):
    """Compatibility focus for an assistant/map action, never a tour's ownership."""
    return (
        content.stops[0].point_id
        if isinstance(content, ExperienceTourContent)
        else content.point_id
    )


def stored_content(record, payload):
    """Read old published JSON without mutating the reviewed snapshot or its revision."""
    value = dict(payload)
    if value.get("kind") == "tour":
        value.pop("point_id", None)
        value.setdefault("campus_id", record.campus_id)
    return CONTENT.validate_python(value)


def require_campus_scope(db, actor, campus_id):
    campus = db.get(CampusRecord, campus_id)
    if not campus or (actor.user.role != "admin" and campus_id not in actor.user.campus_ids):
        raise DomainError("NOT_FOUND", "校区不存在或不在授权范围内", 404)
    return campus


def experience_audit(db, user, action, *, record, note="", details=None):
    db.add(
        AdminAuditRecord(
            actor_id=user.id,
            actor_name=user.display_name,
            action=action,
            campus_id=record.campus_id,
            point_id=record.point_id,
            note=note,
            details=details or {},
        )
    )


def public_point(db, point_id):
    return db.scalar(
        select(PointRecord)
        .join(CampusRecord, CampusRecord.id == PointRecord.campus_id)
        .where(
            PointRecord.id == str(point_id),
            PointRecord.status == "published",
            PointRecord.visibility == "public",
            CampusRecord.is_active.is_(True),
        )
    )


def public_record(db, key):
    record = db.get(ExperienceRecord, str(key))
    if not record or record.status != "published" or not record.published:
        raise DomainError("NOT_FOUND", "内容未发布或已不可用", 404)
    content = stored_content(record, record.published)
    campus = db.get(CampusRecord, record.campus_id)
    if (
        not campus
        or not campus.is_active
        or (isinstance(content, ExperienceTourContent) and content.campus_id != record.campus_id)
    ):
        raise DomainError("NOT_FOUND", "所属校区已不可用", 404)
    for point_id in content_points(content):
        point = public_point(db, point_id)
        if not point or point.campus_id != record.campus_id:
            raise DomainError("NOT_FOUND", "关联地点已不可用或已变更校区", 404)
    # Referenced media must remain independently published and bound to the same point.
    if isinstance(content, ExperienceCheckinContent) and content.image_id:
        referenced_media(db, content.image_id, "image", content.point_id)
    elif isinstance(content, ExperienceTourContent):
        for stop in content.stops:
            if stop.video_id:
                referenced_media(db, stop.video_id, "video", stop.point_id)
            if stop.checkin_id:
                referenced_checkin(db, stop.checkin_id, stop.point_id)
    return record, content


def referenced_media(db, key, media_type, point_id):
    record = db.get(ExperienceRecord, str(key))
    if not record or record.kind != "media" or record.status != "published" or not record.published:
        raise DomainError("MEDIA_NOT_PUBLIC", "引用的媒体未发布或已下架", 409)
    try:
        record, content = public_record(db, key)
    except DomainError as exc:
        raise DomainError("MEDIA_NOT_PUBLIC", "引用的媒体或所属地点已不可用", 409) from exc
    if (
        content.media_type != media_type
        or str(content.point_id) != str(point_id)
        or not public_point(db, point_id)
    ):
        raise DomainError("MEDIA_NOT_PUBLIC", "媒体类型或所属地点不匹配", 409)
    return record, content


def referenced_checkin(db, key, point_id):
    record = db.get(ExperienceRecord, str(key))
    if not record or record.kind != "checkin":
        raise DomainError("CHECKIN_NOT_PUBLIC", "引用的打卡未发布或已下架", 409)
    try:
        record, content = public_record(db, key)
    except DomainError as exc:
        raise DomainError("CHECKIN_NOT_PUBLIC", "引用的打卡或参考资料已不可用", 409) from exc
    if str(content.point_id) != str(point_id):
        raise DomainError("CHECKIN_NOT_PUBLIC", "打卡所属地点与路线站点不匹配", 409)
    return record, content


def public_view(record, content):
    url = None
    if isinstance(content, ExperienceMediaContent):
        url = content.url or f"/api/v1/experiences/{record.id}/media"
    return PublicExperience(
        id=record.id,
        campus_id=record.campus_id,
        revision=record.published_revision,
        content=content,
        media_url=url,
    )


def get_published_experience(db, experience_id):
    try:
        return public_view(*public_record(db, experience_id))
    except DomainError as exc:
        raise DomainError("NOT_FOUND", "内容未发布或关联资料已不可用", 404) from exc


def published_experiences(db, *, point_id=None, kind=None, campus_id=None):
    query = select(ExperienceRecord).where(ExperienceRecord.status == "published")
    if kind:
        query = query.where(ExperienceRecord.kind == kind)
    if campus_id:
        query = query.where(ExperienceRecord.campus_id == campus_id)
    result = []
    for record in db.scalars(
        query.order_by(ExperienceRecord.updated_at.desc(), ExperienceRecord.id)
    ):
        try:
            item = get_published_experience(db, record.id)
            if not point_id or str(point_id) in content_points(item.content):
                result.append(item)
        except DomainError:
            continue
    return result


def require_record(db, actor, key, *, lock=False):
    query = select(ExperienceRecord).where(ExperienceRecord.id == str(key))
    if lock:
        query = query.with_for_update()
    record = db.scalar(query.execution_options(populate_existing=True))
    if record is None:
        raise DomainError("NOT_FOUND", "内容不存在", 404)
    require_campus_scope(db, actor, record.campus_id)
    if record.point_id:
        require_point(db, actor.user, record.point_id)
    # Scope applies to all stops, including both draft and still-public versions.
    for payload in (record.draft, record.published):
        if payload:
            for point_id in content_points(stored_content(record, payload)):
                require_point(db, actor.user, point_id)
    return record


def media_path(settings, upload):
    root = settings.floor_assets_dir.resolve()
    path = contained(root / ".experience-media" / upload.id / upload.filename, root)
    if not path.is_file():
        raise DomainError("NOT_FOUND", "媒体文件不可用", 404)
    return path


def validate_candidate(db, actor, content, settings):
    points = [require_point(db, actor.user, key) for key in sorted(content_points(content))]
    if len({point.campus_id for point in points}) != 1:
        raise DomainError("CAMPUS_MISMATCH", "路线中的地点须属于同一校区", 422)
    if isinstance(content, ExperienceTourContent):
        require_campus_scope(db, actor, content.campus_id)
        if any(point.campus_id != content.campus_id for point in points):
            raise DomainError("CAMPUS_MISMATCH", "路线站点须属于选择的校区", 422)
    contributors = set()
    if isinstance(content, ExperienceMediaContent) and content.upload_id:
        upload = db.get(ExperienceUploadRecord, str(content.upload_id))
        if (
            not upload
            or upload.point_id != str(content.point_id)
            or upload.media_type != content.media_type
        ):
            raise DomainError("INVALID_UPLOAD", "上传文件类型或所属地点不匹配", 422)
        media_path(settings, upload)
        contributors.add(upload.uploaded_by)
    elif isinstance(content, ExperienceCheckinContent) and content.image_id:
        referenced_media(db, content.image_id, "image", content.point_id)
    elif isinstance(content, ExperienceTourContent):
        for stop in content.stops:
            if stop.video_id:
                referenced_media(db, stop.video_id, "video", stop.point_id)
            if stop.checkin_id:
                referenced_checkin(db, stop.checkin_id, stop.point_id)
    return contributors


def admin_view(record):
    content = stored_content(record, record.draft) if record.draft else None
    current = stored_content(record, record.published) if record.published else None
    preview = content if record.state in ACTIVE else current
    media_url = None
    if isinstance(preview, ExperienceMediaContent):
        media_url = preview.url or f"/api/v1/admin/experience-media/{preview.upload_id}"
    return AdminExperience(
        id=record.id,
        campus_id=record.campus_id,
        revision=record.revision,
        published_revision=record.published_revision,
        state=record.state,
        operation=record.operation,
        status=record.status,
        content=content,
        published_content=current,
        contributor_ids=record.contributor_ids,
        submitted_by=record.submitted_by,
        review_note=record.review_note,
        media_url=media_url,
    )


def inspect_media(path, mime):
    if mime.startswith("image/"):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    expected = "PNG" if mime == "image/png" else "JPEG"
                    if image.format != expected or image.width * image.height > 40_000_000:
                        raise ValueError("image type or dimensions")
                    image.verify()
                with Image.open(path) as image:
                    image.load()
        except (
            OSError,
            ValueError,
            SyntaxError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise DomainError("INVALID_MEDIA", "图片无效、过大或类型不匹配", 422) from exc
        return
    with path.open("rb") as source:
        header = source.read(16)
    if (mime == "video/mp4" and header[4:8] != b"ftyp") or (
        mime == "video/webm" and header[:4] != b"\x1a\x45\xdf\xa3"
    ):
        raise DomainError("INVALID_MEDIA", "视频文件头与声明类型不匹配", 422)
    executable = shutil.which("ffprobe")
    if not executable:
        raise DomainError("VIDEO_VALIDATION_UNAVAILABLE", "服务器尚未安装视频校验组件", 503)
    try:
        result = subprocess.run(
            [
                executable,
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                "mov,matroska,webm",
                "-show_entries",
                "format=format_name,duration:stream=codec_type,codec_name",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            timeout=15,
            check=True,
        )
        info = json.loads(result.stdout)
        formats = info.get("format", {}).get("format_name", "").split(",")
        valid_format = "mp4" in formats if mime == "video/mp4" else "webm" in formats
        valid_video = any(
            s.get("codec_type") == "video"
            and s.get("codec_name")
            in ({"h264", "hevc", "av1"} if mime == "video/mp4" else {"vp8", "vp9", "av1"})
            for s in info.get("streams", [])
        )
        if (
            not valid_format
            or not valid_video
            or float(info.get("format", {}).get("duration", 0)) <= 0
        ):
            raise ValueError("invalid video container")
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        raise DomainError(
            "INVALID_MEDIA", "视频无效或格式不支持，请使用MP4或WebM视频", 422
        ) from exc


@router.post(
    "/api/v1/admin/points/{point_id}/experience-media",
    status_code=201,
    response_model=Envelope[ExperienceUpload],
    operation_id="uploadExperienceMedia",
    openapi_extra={**WRITE, "x-module": "M02"},
)
async def upload_media(point_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    point = require_point(db, actor.user, point_id)
    mime = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if mime not in MIME_EXTENSIONS:
        raise DomainError("UNSUPPORTED_MEDIA", "请上传PNG/JPEG图片或MP4/WebM视频", 415)
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > MAX_MEDIA_BYTES):
        raise DomainError("UPLOAD_TOO_LARGE", "单个媒体文件不能超过100MiB", 413)
    key = str(uuid4())
    root = request.app.state.settings.floor_assets_dir.resolve()
    folder = root / ".experience-media" / key
    folder.mkdir(parents=True)
    filename = "original." + MIME_EXTENSIONS[mime]
    path = folder / filename
    total, digest = 0, hashlib.sha256()
    try:
        with path.open("xb") as target:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_MEDIA_BYTES:
                    raise DomainError("UPLOAD_TOO_LARGE", "单个媒体文件不能超过100MiB", 413)
                digest.update(chunk)
                target.write(chunk)
        if not total:
            raise DomainError("INVALID_MEDIA", "文件为空", 422)
        await run_in_threadpool(inspect_media, path, mime)
        upload = ExperienceUploadRecord(
            id=key,
            point_id=point.id,
            uploaded_by=actor.user.id,
            media_type="image" if mime.startswith("image/") else "video",
            mime_type=mime,
            filename=filename,
            size_bytes=total,
            sha256=digest.hexdigest(),
        )
        db.add(upload)
        audit(
            db,
            actor.user,
            "experience.uploaded",
            point=point,
            details={"upload_id": key, "mime_type": mime, "size_bytes": total},
        )
        db.commit()
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return envelope(
        request,
        ExperienceUpload(
            id=key,
            point_id=point.id,
            media_type=upload.media_type,
            mime_type=mime,
            filename=filename,
            size_bytes=total,
            url=f"/api/v1/admin/experience-media/{key}",
        ),
    )


@router.get(
    "/api/v1/admin/experience-media/{upload_id}",
    response_class=FileResponse,
    operation_id="previewExperienceMedia",
    openapi_extra={**STAFF, "x-module": "M02"},
)
def preview_media(upload_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    upload = db.get(ExperienceUploadRecord, str(upload_id))
    if not upload:
        raise DomainError("NOT_FOUND", "媒体不存在", 404)
    require_point(db, actor.user, upload.point_id)
    return FileResponse(
        media_path(request.app.state.settings, upload),
        media_type=upload.mime_type,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get(
    "/api/v1/experiences",
    response_model=Envelope[list[PublicExperience]],
    operation_id="listExperiences",
    openapi_extra=PUBLIC,
)
def list_public(
    request: Request,
    db: DB,
    point_id: UUID | None = None,
    kind: ExperienceKind | None = None,
    campus_id: str | None = None,
):
    return envelope(
        request, published_experiences(db, point_id=point_id, kind=kind, campus_id=campus_id)
    )


@router.get(
    "/api/v1/experiences/{experience_id}",
    response_model=Envelope[PublicExperience],
    operation_id="getExperience",
    openapi_extra=PUBLIC,
)
def get_public(experience_id: UUID, request: Request, db: DB):
    return envelope(request, get_published_experience(db, experience_id))


@router.get(
    "/api/v1/experiences/{experience_id}/media",
    response_class=FileResponse,
    operation_id="getExperienceMedia",
    openapi_extra={**PUBLIC, "x-module": "M02"},
)
def public_media(experience_id: UUID, request: Request, db: DB):
    item = get_published_experience(db, experience_id)
    if not isinstance(item.content, ExperienceMediaContent) or not item.content.upload_id:
        raise DomainError("NOT_FOUND", "无可用的本地媒体", 404)
    upload = db.get(ExperienceUploadRecord, str(item.content.upload_id))
    if not upload or upload.point_id != str(item.content.point_id):
        raise DomainError("NOT_FOUND", "媒体不存在", 404)
    return FileResponse(
        media_path(request.app.state.settings, upload),
        media_type=upload.mime_type,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get(
    "/api/v1/admin/experiences",
    response_model=Envelope[list[AdminExperience]],
    operation_id="listAdminExperiences",
    openapi_extra=EXPERIENCE_STAFF,
)
def list_admin(
    request: Request,
    actor: Actor,
    db: DB,
    point_id: UUID | None = None,
    kind: ExperienceKind | None = None,
    state: ExperienceState | None = None,
    campus_id: str | None = None,
    referenceable: bool = False,
    q: str = Query("", max_length=120),
):
    actor.require("points.read")
    query = select(ExperienceRecord)
    if actor.user.role != "admin":
        query = query.where(ExperienceRecord.campus_id.in_(actor.user.campus_ids))
    if kind:
        query = query.where(ExperienceRecord.kind == kind)
    if state:
        query = query.where(ExperienceRecord.state == state)
    if campus_id:
        query = query.where(ExperienceRecord.campus_id == campus_id)
    term = unicodedata.normalize("NFKC", q.strip()).casefold()
    result = []
    for record in db.scalars(
        query.order_by(ExperienceRecord.updated_at.desc(), ExperienceRecord.id)
    ):
        try:
            require_record(db, actor, record.id)
            if referenceable:
                public_record(db, record.id)
        except DomainError:
            continue
        item = admin_view(record)
        if point_id and not any(
            value and str(point_id) in content_points(value)
            for value in (item.content, item.published_content)
        ):
            continue
        content = item.content or item.published_content
        if (
            term
            and term
            not in unicodedata.normalize(
                "NFKC", content.title + " " + content.description
            ).casefold()
        ):
            continue
        result.append(item)
    return envelope(request, result)


@router.get(
    "/api/v1/admin/experiences/{experience_id}",
    response_model=Envelope[AdminExperience],
    operation_id="getAdminExperience",
    openapi_extra=EXPERIENCE_STAFF,
)
def get_admin(experience_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(request, admin_view(require_record(db, actor, experience_id)))


def save_experience(key, payload, request, actor, db):
    actor.require("points.edit")
    record = require_record(db, actor, key, lock=True) if key else None
    if payload.expected_revision != (
        record.revision if record else 0
    ) or payload.expected_published_revision != (record.published_revision if record else 0):
        conflict()
    if record and record.state == "in_review":
        conflict("请先撤回审核中的修改")
    content = payload.content
    contributors = validate_candidate(db, actor, content, request.app.state.settings)
    point_id = None if isinstance(content, ExperienceTourContent) else str(content.point_id)
    campus_id = (
        content.campus_id
        if isinstance(content, ExperienceTourContent)
        else db.get(PointRecord, point_id).campus_id
    )
    if record and (
        record.kind != content.kind or record.point_id != point_id or record.campus_id != campus_id
    ):
        raise DomainError(
            "IDENTITY_IMMUTABLE", "不能修改内容类型、所属校区或媒体地点，请新建内容", 422
        )
    contributors.add(actor.user.id)
    if record and record.state in {"draft", "rejected"}:
        contributors.update(record.contributor_ids)
    if not record:
        record = ExperienceRecord(
            id=str(uuid4()),
            point_id=point_id,
            campus_id=campus_id,
            kind=content.kind,
            revision=1,
            published_revision=0,
            status="draft",
        )
        db.add(record)
    else:
        record.revision += 1
    record.draft = content.model_dump(mode="json")
    record.state, record.operation, record.submitted_by = "draft", "upsert", None
    record.contributor_ids, record.review_note, record.updated_at = (
        sorted(contributors),
        "",
        now_utc(),
    )
    experience_audit(
        db,
        actor.user,
        "experience.draft_saved",
        record=record,
        note=content.source_note,
        details={
            "experience_id": record.id,
            "revision": record.revision,
            "kind": record.kind,
            "payload": record.draft,
        },
    )
    db.commit()
    return envelope(request, admin_view(record))


@router.post(
    "/api/v1/admin/experiences",
    response_model=Envelope[AdminExperience],
    status_code=201,
    operation_id="createExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
def create(payload: ExperienceSave, request: Request, actor: Actor, db: DB):
    return save_experience(None, payload, request, actor, db)


@router.put(
    "/api/v1/admin/experiences/{experience_id}",
    response_model=Envelope[AdminExperience],
    operation_id="saveExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
def update(experience_id: UUID, payload: ExperienceSave, request: Request, actor: Actor, db: DB):
    return save_experience(experience_id, payload, request, actor, db)


@router.post(
    "/api/v1/admin/experiences/{experience_id}/retire",
    response_model=Envelope[AdminExperience],
    operation_id="retireExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
def retire(
    experience_id: UUID, payload: ResourceRetireRequest, request: Request, actor: Actor, db: DB
):
    actor.require("points.edit")
    record = require_record(db, actor, experience_id, lock=True)
    if (
        record.revision != payload.expected_revision
        or record.published_revision != payload.expected_published_revision
    ):
        conflict()
    if record.state in ACTIVE or record.status != "published":
        conflict("请先处理草稿；只能申请下架已发布内容")
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写下架原因", 422)
    record.revision += 1
    record.state, record.operation = "in_review", "retire"
    record.draft = None
    record.contributor_ids, record.submitted_by = [actor.user.id], actor.user.id
    record.review_note, record.updated_at = payload.note.strip(), now_utc()
    experience_audit(
        db,
        actor.user,
        "experience.retire_requested",
        record=record,
        note=payload.note,
        details={"experience_id": record.id, "revision": record.revision},
    )
    db.commit()
    return envelope(request, admin_view(record))


@router.post(
    "/api/v1/admin/experiences/{experience_id}/review/{action}",
    response_model=Envelope[AdminExperience],
    operation_id="reviewExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
def review(
    experience_id: UUID,
    action: Literal["submit", "publish", "reject", "discard"],
    payload: ReviewRequest,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
    record = require_record(db, actor, experience_id, lock=True)
    if record.revision != payload.expected_revision:
        conflict()
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写操作说明", 422)
    if action == "submit":
        if record.state not in {"draft", "rejected"}:
            conflict("当前状态不能提交")
        if record.operation == "upsert":
            validate_candidate(
                db, actor, stored_content(record, record.draft), request.app.state.settings
            )
        elif record.status != "published":
            conflict("当前内容已不可用")
        record.state, record.submitted_by = "in_review", actor.user.id
    elif action == "discard":
        if record.state not in ACTIVE:
            conflict("当前没有可撤回的草稿")
        if actor.user.role != "admin" and actor.user.id not in record.contributor_ids:
            raise DomainError("FORBIDDEN", "只能撤回自己参与编辑的草稿", 403)
        record.state = "discarded"
    else:
        if record.state != "in_review":
            conflict("只能审核已提交的内容")
        if actor.user.id in record.contributor_ids or actor.user.id == record.submitted_by:
            raise DomainError("SELF_REVIEW_DENIED", "不能审核自己上传、编辑或提交的内容", 403)
        if action == "reject":
            record.state = "rejected"
        else:
            before = record.published
            if record.operation == "retire":
                record.status = "retired"
            else:
                content = stored_content(record, record.draft)
                validate_candidate(db, actor, content, request.app.state.settings)
                if any(not public_point(db, p) for p in content_points(content)):
                    raise DomainError("POINT_NOT_PUBLIC", "请先发布路线及内容涉及的所有地点", 409)
                record.published, record.status = content.model_dump(mode="json"), "published"
            record.published_revision += 1
            record.state = "published"
            experience_audit(
                db,
                actor.user,
                "experience.retired" if record.operation == "retire" else "experience.published",
                record=record,
                note=payload.note,
                details={
                    "experience_id": record.id,
                    "before": before,
                    "after": record.published,
                    "published_revision": record.published_revision,
                    "status": record.status,
                },
            )
    record.revision += 1
    record.review_note, record.updated_at = payload.note.strip(), now_utc()
    if action != "publish":
        experience_audit(
            db,
            actor.user,
            "experience." + action,
            record=record,
            note=payload.note,
            details={"experience_id": record.id, "revision": record.revision},
        )
    db.commit()
    return envelope(request, admin_view(record))
