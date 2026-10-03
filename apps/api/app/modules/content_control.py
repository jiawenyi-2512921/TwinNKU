"""Scoped content checkpoints, private recovery and resource dependency read models."""

import copy
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import select

from app.api import DB, envelope
from app.content_control_models import ContentVersionRecord
from app.contracts import (
    DTO,
    Envelope,
    PointDraftInput,
    PointDraftUpdate,
    ResourceDraftData,
    ResourceDraftSave,
)
from app.core.errors import DomainError
from app.models import CampusRecord, ExperienceRecord, now_utc
from app.modules import content_control_service as control
from app.modules.admin.security import Actor, audit, require_point, utc
from app.modules.configuration_schemas import ConfigurationIssue, ConfigurationPreflight
from app.modules.uploads import storage_guard

router = APIRouter(tags=["content-control"])
STAFF = {"x-implementation-status": "implemented", "x-module": "M58", "x-auth": "staff"}
EntityType = Literal["point", "floor", "vr", "navigation"]


class ContentAction(DTO):
    expected_revision: int = Field(ge=0)
    expected_published_revision: int = Field(ge=0)
    operation_id: UUID
    note: str = Field(default="", max_length=1000)


class ContentHistory(DTO):
    id: UUID
    entity_type: EntityType
    entity_id: UUID
    event: str
    revision: int
    published_revision: int
    content: dict
    content_sha256: str
    contributor_ids: list[UUID]
    actor_id: UUID | None
    created_at: datetime


class ContentDependency(DTO):
    id: UUID
    entity_type: Literal["experience", "configuration", "navigation", "vr"]
    title: str
    state: str
    revision: int
    published_revision: int
    locations: list[str]


def current_view(db, settings, kind, key, current, change):
    if kind == "point":
        from app.modules.admin.service import as_admin_point

        return as_admin_point(db, current).model_dump(mode="json")
    if kind in {"floor", "vr"}:
        from app.modules.admin.resources import as_resource

        point, resource = current
        return as_resource(db, settings, key, point, resource, change).model_dump(mode="json")
    from app.modules.navigation import view

    return view(change, key).model_dump(mode="json")


def checked_current(db, actor, kind, key, payload):
    current, change = control.owned(db, actor, kind, key, lock=True)
    snapshot = control.capture(db, kind, key)
    if (
        payload.expected_revision != snapshot["revision"]
        or payload.expected_published_revision != snapshot["published_revision"]
    ):
        raise DomainError("REVISION_CONFLICT", "内容或正式版本已改变，请重新加载", 409)
    return current, change


def historical_scope(db, actor, kind, item):
    value = item.content
    if kind == "point":
        draft = value.get("draft")
        geometries = (
            [draft["geometry"]] if draft else value.get("published", {}).get("geometries", [])
        )
        from app.models import MapRecord

        for geometry in geometries:
            m = db.get(MapRecord, str(geometry["map_id"]))
            if not m or (actor.user.role != "admin" and m.campus_id not in actor.user.campus_ids):
                raise DomainError("NOT_FOUND", "历史底图不在当前范围", 404)
    elif kind == "navigation":
        for payload in (value.get("draft"), value.get("published")):
            for node in (payload or {}).get("nodes", []):
                if node.get("point_id"):
                    require_point(db, actor.user, node["point_id"])


@router.get(
    "/api/v1/admin/content-history",
    response_model=Envelope[list[ContentHistory]],
    operation_id="listContentHistory",
    openapi_extra=STAFF,
)
def history(entity_type: EntityType, entity_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    key = str(entity_id)
    control.owned(db, actor, entity_type, key)
    versions = db.scalars(
        select(ContentVersionRecord)
        .where(
            ContentVersionRecord.entity_type == entity_type, ContentVersionRecord.entity_id == key
        )
        .order_by(ContentVersionRecord.created_at.desc(), ContentVersionRecord.id)
    ).all()
    result = []
    for item in versions:
        try:
            historical_scope(db, actor, entity_type, item)
        except DomainError:
            continue
        result.append(
            ContentHistory(
                id=item.id,
                entity_type=entity_type,
                entity_id=key,
                event=item.event,
                revision=item.revision,
                published_revision=item.published_revision,
                content=item.content,
                content_sha256=item.content_sha256,
                contributor_ids=item.contributor_ids,
                actor_id=item.actor_id,
                created_at=utc(item.created_at),
            )
        )
    return envelope(request, result)


@router.post(
    "/api/v1/admin/content/{entity_type}/{entity_id}/checkpoint",
    response_model=Envelope[dict],
    operation_id="checkpointContent",
    openapi_extra=STAFF,
)
@control.write_guard
def checkpoint(
    entity_type: EntityType,
    entity_id: UUID,
    payload: ContentAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.edit")
    key = str(entity_id)
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        "checkpoint",
        key,
        payload.model_dump(mode="json"),
    )
    if old is not None:
        return envelope(request, old)
    current, change = checked_current(db, actor, entity_type, key, payload)
    if change and change.state == "in_review":
        raise DomainError("DRAFT_FROZEN", "待审稿不能新增草稿检查点，请先撤回", 409)
    control.record_history(db, entity_type, key, "checkpoint", actor, force=True)
    audit(
        db,
        actor.user,
        "content.checkpoint",
        note=payload.note,
        details={"entity_type": entity_type, "entity_id": key},
    )
    result = current_view(db, request.app.state.settings, entity_type, key, current, change)
    control.finish_operation(
        db, actor, payload.operation_id, entity_type, key, "checkpoint", fingerprint, result
    )
    db.commit()
    return envelope(request, result)


@router.post(
    "/api/v1/admin/content/{entity_type}/{entity_id}/withdraw",
    response_model=Envelope[dict],
    operation_id="withdrawContent",
    openapi_extra=STAFF,
)
@control.write_guard
def withdraw(
    entity_type: EntityType,
    entity_id: UUID,
    payload: ContentAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.edit")
    key = str(entity_id)
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        "withdraw",
        key,
        payload.model_dump(mode="json"),
    )
    if old is not None:
        return envelope(request, old)
    current, change = checked_current(db, actor, entity_type, key, payload)
    if not change or change.state != "in_review":
        raise DomainError("REVISION_CONFLICT", "只有待审稿可以撤回修改", 409)
    if actor.user.role != "admin" and actor.user.id not in change.contributor_ids:
        raise DomainError("FORBIDDEN", "只能撤回自己参与的稿件", 403)
    change.state, change.revision, change.updated_at = "draft", change.revision + 1, now_utc()
    if entity_type != "navigation":
        change.submitted_by = change.submitted_at = None
    control.unfreeze(db, entity_type, key)
    db.flush()
    control.record_history(db, entity_type, key, "withdraw", actor, force=True)
    audit(
        db,
        actor.user,
        "content.withdraw",
        note=payload.note,
        details={"entity_type": entity_type, "entity_id": key},
    )
    result = current_view(db, request.app.state.settings, entity_type, key, current, change)
    control.finish_operation(
        db, actor, payload.operation_id, entity_type, key, "withdraw", fingerprint, result
    )
    db.commit()
    return envelope(request, result)


@router.post(
    "/api/v1/admin/content/{entity_type}/{entity_id}/preflight",
    response_model=Envelope[ConfigurationPreflight],
    operation_id="preflightContent",
    openapi_extra=STAFF,
)
def preflight(
    entity_type: EntityType,
    entity_id: UUID,
    payload: ContentAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.read")
    key = str(entity_id)
    current, change = checked_current(db, actor, entity_type, key, payload)
    return envelope(
        request,
        content_preflight(db, actor, entity_type, key, request.app.state.settings, current, change),
    )


def content_preflight(db, actor, entity_type, key, settings, current=None, change=None):
    """Read-only shared validation; no commit, activity refresh or supplier call."""
    if current is None:
        current, change = control.owned(db, actor, entity_type, key)
    value, issues, dependencies = control.capture(db, entity_type, key), [], []
    try:
        if not change or (entity_type == "navigation" and not change.draft):
            raise DomainError("DRAFT_REQUIRED", "请先保存草稿", 409)
        if entity_type == "point":
            from app.modules.admin.service import validate_location

            if change.operation != "retire":
                candidate = PointDraftInput.model_validate(change.payload)
                validate_location(db, current.campus_id, candidate.geometry)
                dependencies.append(
                    {
                        "map_id": str(candidate.geometry.map_id),
                        "revision": candidate.geometry.map_revision,
                    }
                )
            if current.revision != change.base_revision:
                raise DomainError("REVISION_CONFLICT", "正式点位已改变，请重新保存核对", 409)
        elif entity_type in {"floor", "vr"}:
            from app.modules.admin.resources import validate_candidate

            point, resource = current
            if (resource.revision if resource else 0) != change.base_revision:
                raise DomainError("REVISION_CONFLICT", "正式资料已改变，请重新保存核对", 409)
            if change.operation != "retire":
                candidate = ResourceDraftData.model_validate(change.payload)
                validate_candidate(
                    db,
                    point,
                    key,
                    candidate.content,
                    resource,
                    settings.floor_assets_dir.resolve(),
                )
                if (
                    point.status != "published"
                    or point.visibility != "public"
                    or not db.get(CampusRecord, point.campus_id).is_active
                ):
                    raise DomainError("POINT_NOT_PUBLIC", "所属地点须先公开发布", 409)
                dependencies.append({"point_id": point.id, "revision": point.revision})
                if entity_type == "vr" and candidate.content.cover_image_id:
                    from app.models import ExperienceRecord

                    cover = db.get(ExperienceRecord, str(candidate.content.cover_image_id))
                    dependencies.append({"image_id": cover.id, "revision": cover.published_revision})
        else:
            from app.modules.navigation import RoadGraph, validate_graph

            validate_graph(db, current, RoadGraph.model_validate(change.draft), publish=True)
            dependencies.append({"map_id": current.id, "revision": current.revision})
    except DomainError as exc:
        issues.append(
            ConfigurationIssue(
                code=exc.code,
                severity="error",
                path="content"
                if entity_type in {"floor", "vr"}
                else "geometry"
                if entity_type == "point"
                else "graph",
                message=exc.message,
            )
        )
    return ConfigurationPreflight(
        valid=not issues,
        revision=value["revision"],
        content_sha256=control.digest(value),
        dependency_sha256=control.digest(dependencies),
        issues=issues,
    )


@router.post(
    "/api/v1/admin/content/{entity_type}/{entity_id}/history/{version_id}/restore-draft",
    response_model=Envelope[dict],
    operation_id="restoreContentDraft",
    openapi_extra=STAFF,
)
@control.write_guard
def restore(
    entity_type: EntityType,
    entity_id: UUID,
    version_id: UUID,
    payload: ContentAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.edit")
    key = str(entity_id)
    fingerprint, old = control.operation(
        db,
        actor,
        payload.operation_id,
        entity_type,
        "restore",
        key,
        {**payload.model_dump(mode="json"), "version_id": str(version_id)},
    )
    if old is not None:
        return envelope(request, old)
    current, change = checked_current(db, actor, entity_type, key, payload)
    if change and change.state == "in_review":
        raise DomainError("DRAFT_FROZEN", "请先撤回待审稿", 409)
    item = db.get(ContentVersionRecord, str(version_id))
    if not item or item.entity_type != entity_type or item.entity_id != key:
        raise DomainError("NOT_FOUND", "历史版本不存在", 404)
    historical_scope(db, actor, entity_type, item)
    value = copy.deepcopy(item.content)
    with storage_guard(request.app.state.settings):
        if entity_type == "point":
            from app.modules.admin.service import save_draft

            candidate = value.get("draft")
            if candidate is None:
                published = value.get("published") or {}
                previous = published.get("raw") or published.get("point") or {}
                geometry = next(iter(published.get("geometries", [])), None)
                if not geometry or not payload.note.strip():
                    raise DomainError(
                        "HISTORY_DRAFT_UNAVAILABLE",
                        "此历史缺少定位或来源说明，请核对后填写恢复说明",
                        409,
                    )
                candidate = {
                    name: previous[name]
                    for name in ("campus_id", "name", "aliases", "category", "summary")
                }
                candidate.update(
                    visibility=published.get("visibility", previous.get("visibility", "public")),
                    source_note=payload.note,
                    geometry={
                        name: geometry[name]
                        for name in ("map_id", "map_revision", "anchor", "polygon", "label_on_map")
                    },
                )
            candidate = PointDraftUpdate.model_validate(
                {
                    **candidate,
                    "expected_revision": payload.expected_revision,
                    "expected_point_revision": payload.expected_published_revision,
                }
            )
            prior_revision = change.revision if change else 0
            save_draft(db, actor, candidate, key)
            current, change = control.owned(db, actor, entity_type, key)
            if change.revision == prior_revision:
                change.revision += 1
        elif entity_type in {"floor", "vr"}:
            from app.modules.admin.resources import _save_resource

            candidate = value.get("draft") or {
                "content": value["published"]["content"],
                "source_note": payload.note,
            }
            if candidate.get("content", {}).get("kind") == "floor":
                source_revision = (value.get("published") or {}).get("revision")
                for image in candidate["content"]["images"]:
                    if not image.get("upload_id") and source_revision:
                        image["source_revision"] = source_revision
            candidate = ResourceDraftSave.model_validate(
                {
                    **candidate,
                    "expected_revision": payload.expected_revision,
                    "expected_published_revision": payload.expected_published_revision,
                }
            )
            point, resource = current
            prior_revision = change.revision if change else 0
            _save_resource(point.id, key, candidate, request, actor, db, commit=False)
            current, change = control.owned(db, actor, entity_type, key)
            if change.revision == prior_revision:
                change.revision += 1
        else:
            from app.modules.navigation import RoadGraph, validate_graph

            candidate = RoadGraph.model_validate(value.get("draft") or value.get("published"))
            validate_graph(db, current, candidate)
            change.draft = candidate.model_dump(mode="json")
            change.revision += 1
        change.state, change.updated_at = "draft", now_utc()
        change.contributor_ids = sorted(
            set(change.contributor_ids + item.contributor_ids + [actor.user.id])
        )
        if entity_type != "navigation":
            change.submitted_by = change.submitted_at = None
        control.unfreeze(db, entity_type, key)
        db.flush()
        control.record_history(db, entity_type, key, "restore", actor, force=True)
        audit(
            db,
            actor.user,
            "content.restore",
            note=payload.note,
            details={"entity_type": entity_type, "entity_id": key, "version_id": str(version_id)},
        )
        result = current_view(db, request.app.state.settings, entity_type, key, current, change)
        control.finish_operation(
            db, actor, payload.operation_id, entity_type, key, "restore", fingerprint, result
        )
        db.commit()
    return envelope(request, result)


@router.get(
    "/api/v1/admin/resources/{resource_type}/{resource_id}/dependencies",
    response_model=Envelope[list[ContentDependency]],
    operation_id="resourceDependencies",
    openapi_extra=STAFF,
)
def dependencies(
    resource_type: Literal["point", "map", "image", "video", "checkin", "tour", "floor", "vr"],
    resource_id: UUID,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("points.read")
    key = str(resource_id)
    if resource_type == "point":
        require_point(db, actor.user, key)
    elif resource_type == "map":
        from app.modules.navigation import scoped_map

        scoped_map(db, actor, key)
    elif resource_type in {"floor", "vr"}:
        control.owned(db, actor, resource_type, key)
    else:
        from app.modules.experiences import require_record

        source = require_record(db, actor, key)
        payload = source.draft or source.published or {}
        actual_type = payload.get("media_type") if source.kind == "media" else source.kind
        if actual_type != resource_type:
            raise DomainError("NOT_FOUND", "资料类型不匹配", 404)
    result = []

    def locations(payload, prefix):
        found = []

        def inspect(value, path):
            if isinstance(value, dict):
                if str(value.get("id")) == key and value.get("type") in {
                    resource_type,
                    "vr_entry" if resource_type == "vr" else resource_type,
                }:
                    found.append(path)
                for name, child in value.items():
                    if str(child) == key and (
                        (resource_type == "point" and name == "point_id")
                        or (resource_type == "map" and name == "map_id")
                        or (resource_type == "image" and name in {"cover_image_id", "image_id"})
                        or (resource_type == "video" and name in {"video_id", "audio_description_video_id"})
                        or (resource_type == "checkin" and name == "checkin_id")
                    ):
                        found.append(path + "." + name)
                    inspect(child, path + "." + name)
            elif isinstance(value, list):
                for i, child in enumerate(value):
                    inspect(child, path + "." + str(i))

        inspect(payload, prefix)
        return found

    from app.modules.experiences import require_record

    for row in db.scalars(select(ExperienceRecord).order_by(ExperienceRecord.id)):
        try:
            require_record(db, actor, row.id)
        except DomainError:
            continue
        paths = locations(row.draft, "draft") + locations(row.published, "published")
        if paths:
            result.append(
                ContentDependency(
                    id=row.id,
                    entity_type="experience",
                    title=(row.draft or row.published or {}).get("title", ""),
                    state=row.state,
                    revision=row.revision,
                    published_revision=row.published_revision,
                    locations=sorted(set(paths)),
                )
            )
    from app.configuration_models import ConfigurationRecord
    from app.models import PanoramaRecord, ResourceChangeRecord

    for vr in db.scalars(select(PanoramaRecord).order_by(PanoramaRecord.id)):
        try:
            require_point(db, actor.user, vr.point_id)
        except DomainError:
            continue
        change = db.get(ResourceChangeRecord, vr.id)
        draft = change.payload if change and change.state in {"draft", "in_review", "rejected"} else None
        paths = locations(draft, "draft") + locations({"cover_image_id": vr.cover_image_id}, "published")
        if paths:
            result.append(ContentDependency(id=vr.id, entity_type="vr", title=vr.title,
                state=change.state if change else vr.status, revision=change.revision if change else 0,
                published_revision=vr.revision, locations=sorted(set(paths))))
    # Newly created panorama drafts do not yet have a published PanoramaRecord.
    for change in db.scalars(select(ResourceChangeRecord).where(ResourceChangeRecord.kind == "panorama")):
        if db.get(PanoramaRecord, change.resource_id) or change.state not in {"draft", "in_review", "rejected"}:
            continue
        try:
            require_point(db, actor.user, change.point_id)
        except DomainError:
            continue
        paths = locations(change.payload, "draft")
        if paths:
            result.append(ContentDependency(id=change.resource_id, entity_type="vr",
                title=(change.payload or {}).get("content", {}).get("title", ""), state=change.state,
                revision=change.revision, published_revision=0, locations=sorted(set(paths))))
    from app.modules.configurations import record_for

    for row in db.scalars(select(ConfigurationRecord).order_by(ConfigurationRecord.id)):
        try:
            record_for(db, actor, row.id)
        except DomainError:
            continue
        paths = locations(row.draft, "draft") + locations(row.published, "published")
        if paths:
            result.append(
                ContentDependency(
                    id=row.id,
                    entity_type="configuration",
                    title=f"{row.kind} · {row.scope}",
                    state=row.state,
                    revision=row.revision,
                    published_revision=row.published_revision,
                    locations=sorted(set(paths)),
                )
            )
    from app.models import NavigationRecord

    for row in db.scalars(select(NavigationRecord).order_by(NavigationRecord.map_id)):
        try:
            m, _ = control.owned(db, actor, "navigation", row.map_id)
        except DomainError:
            continue
        paths = locations(row.draft, "draft") + locations(row.published, "published")
        if resource_type == "map" and row.map_id == key:
            paths += ["map_id"]
        if paths:
            result.append(
                ContentDependency(
                    id=row.map_id,
                    entity_type="navigation",
                    title=m.title,
                    state=row.state,
                    revision=row.revision,
                    published_revision=row.published_revision,
                    locations=sorted(set(paths)),
                )
            )
    return envelope(request, result)
