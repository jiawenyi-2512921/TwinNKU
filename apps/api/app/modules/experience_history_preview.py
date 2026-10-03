"""Authenticated immutable history reads; no saves, synthesis or latest-resource substitution."""

import hashlib
import json
from typing import Literal
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, RedirectResponse

from app.api import DB, envelope
from app.content_history_models import ExperienceVersionRecord
from app.contracts import DTO, Envelope, Floor, Panorama
from app.core.errors import DomainError
from app.models import ExperienceRecord, ExperienceUploadRecord
from app.modules.admin.security import Actor, require_point
from app.modules.experiences import (
    EXPERIENCE_STAFF,
    ExperienceTourContent,
    PublicExperience,
    TourAssetView,
    TourResource,
    authorize_history,
    caption_upload,
    content_points,
    media_path,
    public_view,
    referenced_tour_resource,
    require_record,
    stored_content,
)
from app.modules.floors.service import as_floor
from app.modules.narration.router import NarrationManifest, manifest, serve_chunk
from app.modules.narration.service import asset_matches, chunk_path
from app.modules.vr import public_panorama
from app.narration_models import NarrationAsset

router = APIRouter(tags=["experience-history"])
Snapshot = Literal["draft", "published"]
ResourceKind = Literal["image", "video", "floor", "vr", "checkin", "narration"]


class HistoricalResource(DTO):
    path: str
    type: ResourceKind
    id: UUID
    point_id: UUID | None = None
    revision: int | None = None
    segment_id: str | None = None
    state: Literal["ready", "unavailable", "changed", "unversioned"]
    message: str = ""
    item: PublicExperience | None = None
    floor: Floor | None = None
    panorama: Panorama | None = None
    narration: NarrationManifest | None = None


class ExperienceHistoryPreview(DTO):
    experience_id: UUID
    version_id: UUID
    snapshot: Snapshot
    revision: int
    published_revision: int
    content_sha256: str
    snapshot_sha256: str
    stop_index: int
    item: PublicExperience
    resources: list[HistoricalResource]
    map_context: Literal["current_public_reference"] = "current_public_reference"


def historical_source(db, actor, experience_id, version_id, snapshot):
    actor.require("points.read")
    record = require_record(db, actor, experience_id)
    version = db.get(ExperienceVersionRecord, str(version_id))
    if not version or version.experience_id != record.id:
        raise DomainError("NOT_FOUND", "历史版本不存在或不属于该内容", 404)
    # Preserve the same current scope as history listing/restoration. A version
    # outside that scope is not exposed through a partial-preview bypass.
    authorize_history(db, actor, record, version)
    payload = version.content if snapshot == "draft" else version.published_content
    if not payload:
        raise DomainError("HISTORY_SNAPSHOT_EMPTY", "该历史记录没有所选快照", 404)
    content = stored_content(record, payload)
    revision = version.revision if snapshot == "draft" else version.published_revision
    return record, version, content, revision


def primary_reference_entries(db, content, stop_index):
    """A single station bounds checks to 50 segments and 25 references each."""
    if content.kind != "tour":
        if stop_index:
            raise DomainError("HISTORY_STOP_INVALID", "该内容没有路线站点", 422)
        yield "self", content.media_type if content.kind == "media" else "checkin", None, str(content.point_id), None, None
        return
    if not content.stops:
        if stop_index:
            raise DomainError("HISTORY_STOP_INVALID", "历史路线没有该站", 422)
        return
    if stop_index >= len(content.stops):
        raise DomainError("HISTORY_STOP_INVALID", "历史路线没有该站", 422)
    if content.cover_image_id:
        cover = db.get(ExperienceRecord, str(content.cover_image_id))
        point_id = cover.point_id if cover else None
        yield "cover_image_id", "image", str(content.cover_image_id), point_id, content.cover_image_revision, None
    stop = content.stops[stop_index]
    prefix, point_id = f"stops.{stop_index}", str(stop.point_id)
    if stop.segments is None or stop.legacy_media_compat:
        if stop.video_id:
            yield prefix + ".video_id", "video", str(stop.video_id), point_id, None, None
        if stop.checkin_id:
            yield prefix + ".checkin_id", "checkin", str(stop.checkin_id), point_id, None, None
    for index, segment in enumerate(stop.segments or []):
        path = prefix + f".segments.{index}"
        if segment.main_view.type != "map":
            view = segment.main_view
            yield path + ".main_view", "vr" if view.type == "vr_entry" else view.type, str(view.id), point_id, view.revision, view.section_id
        for offset, ref in enumerate(segment.resources):
            yield path + f".resources.{offset}", ref.type, str(ref.id), point_id, ref.revision, None
        if segment.narration_asset_id:
            yield path + ".narration_asset_id", "narration", str(segment.narration_asset_id), point_id, None, segment.id


def reference_entries(db, content, stop_index):
    for entry in primary_reference_entries(db, content, stop_index):
        yield entry
        path, kind, key, point_id, revision, _ = entry
        if kind != "video":
            continue
        parent = content if path == "self" else None
        if parent is None and revision is not None:
            target = db.get(ExperienceRecord, key)
            if target and target.status == "published" and target.published_revision == revision and target.published:
                parent = stored_content(target, target.published)
        if parent and parent.kind == "media" and parent.audio_description_video_id:
            yield path + ".audio_description_video_id", "video", str(parent.audio_description_video_id), point_id, parent.audio_description_video_revision, None


def history_prefix(record, version):
    return f"/api/v1/admin/experiences/{record.id}/history/{version.id}"


def media_projection(db, actor, record, version, source, source_revision, entry, snapshot, stop_index, settings):
    path, kind, key, point_id, expected, _ = entry
    if path == "self":
        target, content, revision = record, source, source_revision
    else:
        if expected is None:
            raise DomainError("HISTORY_UNVERSIONED", "原引用没有资源版本，不能确认历史画面", 409)
        if point_id is None or point_id not in content_points(source):
            raise DomainError("HISTORY_RESOURCE_UNAVAILABLE", "历史引用的地点无法确认", 409)
        require_point(db, actor.user, point_id)
        target = referenced_tour_resource(db, TourResource(type=kind, id=key, revision=expected), point_id)
        content = stored_content(target, target.published)
        revision = target.published_revision
    result = public_view(target, content).model_copy(update={"revision": revision})
    if path.endswith(".audio_description_video_id") and (
        content.kind != "media" or content.media_type != "video"
        or content.video_visual_information != "audio_complete" or content.audio_description_video_id
    ):
        raise DomainError("HISTORY_DESCRIPTION_UNAVAILABLE", "原口述描述版现在无法核验", 409)
    query = urlencode({"snapshot": snapshot, "stop_index": stop_index, "path": path})
    if content.kind == "media":
        if content.upload_id:
            upload = db.get(ExperienceUploadRecord, str(content.upload_id))
            if not upload or upload.point_id != str(content.point_id) or upload.media_type != content.media_type:
                raise DomainError("HISTORY_RESOURCE_UNAVAILABLE", "历史媒体文件归属无法确认", 409)
            actual = media_path(settings, upload)
            if actual.stat().st_size != upload.size_bytes:
                raise DomainError("HISTORY_RESOURCE_UNAVAILABLE", "历史媒体文件大小已改变", 409)
        result.media_url = history_prefix(record, version) + "/media?" + query
        result.caption_url = None
        if content.caption_upload_id:
            caption_upload(db, settings, content.caption_upload_id, content.point_id)
            result.caption_url = history_prefix(record, version) + "/captions?" + query
    return result


def resolve_entry(db, actor, record, version, source, revision, entry, snapshot, stop_index, settings):
    path, kind, key, point_id, expected, section_id = entry
    row = HistoricalResource(path=path, type=kind, id=key or record.id, point_id=point_id,
                             revision=expected, state="ready")
    try:
        if path != "self" and expected is None and kind != "narration":
            row.state, row.message = "unversioned", "原引用未保存资源版本，历史预览不使用当前新版替代。"
            return row
        if kind == "narration":
            stop = source.stops[stop_index]
            segment = next(s for s in stop.segments if s.id == section_id)
            row.segment_id = segment.id
            asset = db.get(NarrationAsset, key)
            if not asset_matches(asset, record, stop, segment):
                raise DomainError("HISTORY_AUDIO_UNAVAILABLE", "历史音频与原段落身份或原文不匹配", 409)
            for chunk in asset.chunks:
                chunk_path(settings, asset.id, chunk)
            prefix = history_prefix(record, version) + f"/narration/{segment.id}/{asset.id}"
            row.narration = manifest(asset, prefix, urlencode({"snapshot": snapshot, "stop_index": stop_index}))
        elif kind in {"image", "video", "checkin"}:
            row.item = media_projection(db, actor, record, version, source, revision, entry,
                                        snapshot, stop_index, settings)
        else:
            if point_id not in content_points(source):
                raise DomainError("HISTORY_RESOURCE_UNAVAILABLE", "历史引用的地点无法确认", 409)
            require_point(db, actor.user, point_id)
            ref = TourAssetView(type="floor", id=key, revision=expected, section_id=section_id) if kind == "floor" else TourResource(type="vr", id=key, revision=expected)
            target = referenced_tour_resource(db, ref, point_id)
            if kind == "floor":
                row.floor = as_floor(target)
            else:
                row.panorama = public_panorama(db, target)
    except DomainError as exc:
        row.item = row.floor = row.panorama = row.narration = None
        row.state = "changed" if exc.code == "RESOURCE_REVISION_CHANGED" else "unavailable"
        row.message = "引用的正式版本已变化，未使用新版替代。" if row.state == "changed" else "原引用已撤回、缺失或当前无法读取，仍可阅读历史原文。"
    except (OSError, ValueError, StopIteration):
        row.item = row.floor = row.panorama = row.narration = None
        row.state, row.message = "unavailable", "历史文件或音频校验失败，仍可阅读历史原文。"
    return row


@router.get("/api/v1/admin/experiences/{experience_id}/history/{version_id}/preview",
            response_model=Envelope[ExperienceHistoryPreview], operation_id="previewExperienceHistory", openapi_extra=EXPERIENCE_STAFF)
def preview(experience_id: UUID, version_id: UUID, request: Request, actor: Actor, db: DB,
            snapshot: Snapshot = "draft", stop_index: int = Query(default=0, ge=0, le=49)):
    record, version, content, revision = historical_source(db, actor, experience_id, version_id, snapshot)
    entries = list(reference_entries(db, content, stop_index))
    # 50 segments × (25 resources + main scene + narration), with at most
    # one exact audio-description child per video, fits this finite budget.
    if len(entries) > 3000:
        raise DomainError("HISTORY_PREVIEW_LIMIT", "本站历史引用超过检查边界", 422)
    resources = [resolve_entry(db, actor, record, version, content, revision, entry, snapshot, stop_index,
                               request.app.state.settings) for entry in entries]
    own = next((row.item for row in resources if row.path == "self" and row.item), None)
    item = own or PublicExperience(id=record.id, campus_id=record.campus_id, revision=revision, content=content)
    digest = hashlib.sha256(json.dumps(content.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return envelope(request, ExperienceHistoryPreview(experience_id=record.id, version_id=version.id,
        snapshot=snapshot, revision=version.revision, published_revision=version.published_revision,
        content_sha256=version.content_sha256, snapshot_sha256=digest, stop_index=stop_index,
        item=item, resources=resources))


def historical_media(db, actor, experience_id, version_id, snapshot, stop_index, path, settings):
    record, version, source, revision = historical_source(db, actor, experience_id, version_id, snapshot)
    entry = next((item for item in reference_entries(db, source, stop_index) if item[0] == path), None)
    if not entry or entry[1] not in {"image", "video"}:
        raise DomainError("NOT_FOUND", "该历史快照没有这份媒体引用", 404)
    result = media_projection(db, actor, record, version, source, revision, entry, snapshot, stop_index, settings)
    return result.content


@router.get("/api/v1/admin/experiences/{experience_id}/history/{version_id}/media",
            operation_id="getExperienceHistoryMedia", openapi_extra=EXPERIENCE_STAFF)
def media(experience_id: UUID, version_id: UUID, request: Request, actor: Actor, db: DB,
          snapshot: Snapshot = "draft", stop_index: int = Query(default=0, ge=0, le=49),
          path: str = Query(max_length=180)):
    content = historical_media(db, actor, experience_id, version_id, snapshot, stop_index, path, request.app.state.settings)
    if content.upload_id:
        upload = db.get(ExperienceUploadRecord, str(content.upload_id))
        return FileResponse(media_path(request.app.state.settings, upload), media_type=upload.mime_type,
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if content.url:
        return RedirectResponse(content.url, status_code=307, headers={"Cache-Control": "no-store"})
    raise DomainError("NOT_FOUND", "历史媒体文件不可用", 404)


@router.get("/api/v1/admin/experiences/{experience_id}/history/{version_id}/captions",
            operation_id="getExperienceHistoryCaptions", openapi_extra=EXPERIENCE_STAFF)
def captions(experience_id: UUID, version_id: UUID, request: Request, actor: Actor, db: DB,
             snapshot: Snapshot = "draft", stop_index: int = Query(default=0, ge=0, le=49),
             path: str = Query(max_length=180)):
    content = historical_media(db, actor, experience_id, version_id, snapshot, stop_index, path, request.app.state.settings)
    if not content.caption_upload_id:
        raise DomainError("NOT_FOUND", "历史媒体没有字幕", 404)
    upload = caption_upload(db, request.app.state.settings, content.caption_upload_id, content.point_id)
    return FileResponse(media_path(request.app.state.settings, upload), media_type="text/vtt",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/api/v1/admin/experiences/{experience_id}/history/{version_id}/narration/{segment_id}/{asset_id}/chunks/{chunk_id}",
            operation_id="getExperienceHistoryNarrationChunk", openapi_extra=EXPERIENCE_STAFF)
def narration_chunk(experience_id: UUID, version_id: UUID, segment_id: str, asset_id: UUID,
                    chunk_id: str, request: Request, actor: Actor, db: DB,
                    snapshot: Snapshot = "draft", stop_index: int = Query(default=0, ge=0, le=49)):
    record, _, content, _ = historical_source(db, actor, experience_id, version_id, snapshot)
    if not isinstance(content, ExperienceTourContent) or stop_index >= len(content.stops):
        raise DomainError("NOT_FOUND", "历史段落不存在", 404)
    stop = content.stops[stop_index]
    segment = next((s for s in stop.segments or [] if s.id == segment_id), None)
    asset = db.get(NarrationAsset, str(asset_id))
    if not segment or str(segment.narration_asset_id) != str(asset_id) or not asset_matches(asset, record, stop, segment):
        raise DomainError("NOT_FOUND", "音频没有用于该历史段落", 404)
    return serve_chunk(asset, chunk_id, request)
