"""Independently reviewed media, check-in suggestions and ordered campus tours.

Tour stops describe a presentation sequence, never an invented walking path.
Owned media is served through authorization on every request, including ranges.
"""

import asyncio
import copy
import hashlib
import json
import shutil
import unicodedata
from datetime import datetime, timedelta
from functools import wraps
from inspect import signature
from types import SimpleNamespace
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import Field, TypeAdapter, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.api import DB, envelope
from app.content_history_models import (
    ExperienceOperationRecord,
    ExperienceSubmissionRecord,
    ExperienceVersionRecord,
)
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
    FloorRecord,
    PanoramaRecord,
    PointRecord,
    now_utc,
)
from app.modules.admin.router import STAFF, WRITE
from app.modules.admin.security import Actor, audit, require_point, require_recent_mfa, utc
from app.modules.admin.service import conflict
from app.modules.captions import MAX_CAPTION_BYTES, inspect_captions
from app.modules.configuration_schemas import ConfigurationIssue, ConfigurationPreflight
from app.modules.floors.import_bundle import contained
from app.modules.floors.service import public_floors
from app.modules.uploads import inspect_upload, storage_guard, upload_slot

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
    title: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=8000)
    source_note: str = Field(default="", max_length=2000)

    @field_validator("title", "source_note")
    @classmethod
    def nonempty(cls, value):
        return value.strip()


class ExperienceMediaContent(ExperienceBase):
    point_id: UUID
    kind: Literal["media"] = "media"
    media_type: Literal["image", "video"]
    upload_id: UUID | None = None
    url: str | None = Field(default=None, max_length=2048)
    alternative_text: str = Field(default="", max_length=4000)
    transcript: str = Field(default="", max_length=20000)
    caption_upload_id: UUID | None = None
    caption_language: str = Field(
        default="zh-CN", max_length=35, pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$"
    )
    caption_label: str = Field(default="中文字幕", min_length=1, max_length=64)
    video_visual_information: Literal["unassessed", "audio_complete", "description_required", "silent"] = "unassessed"
    video_accessibility_note: str = Field(default="", max_length=2000)
    audio_description_video_id: UUID | None = None
    audio_description_video_revision: int | None = Field(default=None, ge=1)

    @field_validator("url")
    @classmethod
    def safe_url(cls, value):
        return PanoramaContent.safe_external_url(value) if value is not None else None

    @model_validator(mode="after")
    def source(self):
        if bool(self.upload_id) == bool(self.url):
            raise ValueError("choose exactly one upload or HTTPS URL")
        if self.caption_upload_id and self.media_type != "video":
            raise ValueError("only videos can reference captions")
        if not self.caption_label.strip():
            raise ValueError("caption label is required")
        if (self.audio_description_video_id is None) != (self.audio_description_video_revision is None):
            raise ValueError("description video ID and revision must be supplied together")
        if self.media_type != "video" and (
            self.video_visual_information != "unassessed" or self.video_accessibility_note
            or self.audio_description_video_id is not None
        ):
            raise ValueError("only videos can contain video accessibility decisions")
        if self.audio_description_video_id and self.video_visual_information != "description_required":
            raise ValueError("only description-required videos can reference an alternative")
        return self


class ExperienceCheckinContent(ExperienceBase):
    point_id: UUID
    kind: Literal["checkin"] = "checkin"
    image_id: UUID | None = None


class TourResource(DTO):
    type: Literal["image", "floor", "video", "vr", "checkin"]
    id: UUID
    revision: int = Field(ge=1)


class TourMapView(DTO):
    type: Literal["map"] = "map"


class TourAssetView(DTO):
    type: Literal["image", "floor", "video", "vr_entry"]
    id: UUID
    revision: int = Field(ge=1)
    section_id: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def floor_section_only(self):
        if self.section_id is not None and self.type != "floor":
            raise ValueError("only a floor view can select a section")
        return self


class TourSegment(DTO):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    title: str = Field(default="", max_length=120)
    observation_prompt: str = Field(default="", max_length=800)
    takeaway: str = Field(default="", max_length=500)
    narration_asset_id: UUID | None = None
    text: str = Field(default="", max_length=8000)
    source_note: str = Field(default="", max_length=2000)
    main_view: Annotated[TourMapView | TourAssetView, Field(discriminator="type")] = Field(
        default_factory=TourMapView
    )
    resources: list[TourResource] = Field(default_factory=list, max_length=25)

    @model_validator(mode="after")
    def unique_resources(self):
        keys = [(resource.type, resource.id) for resource in self.resources]
        if len(keys) != len(set(keys)):
            raise ValueError("segment resource references must be unique")
        return self


class ExperienceStop(DTO):
    point_id: UUID
    title: str | None = Field(default=None, max_length=120)
    # None preserves the original narrative/media timing. An explicit sequence is ordered.
    segments: list[TourSegment] | None = Field(default=None, min_length=1, max_length=50)
    narrative: str = Field(default="", max_length=8000)
    video_id: UUID | None = None
    checkin_id: UUID | None = None
    prompt_timing: Literal["on_arrival", "after_intro", "manual"] = "manual"
    legacy_media_compat: bool = False


class CoverFocus(DTO):
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)


class ExperienceTourContent(ExperienceBase):
    campus_id: CampusId
    kind: Literal["tour"] = "tour"
    stops: list[ExperienceStop] = Field(max_length=50)
    cover_image_id: UUID | None = None
    cover_image_revision: int | None = Field(default=None, ge=1)
    lead: str = Field(default="", max_length=800)
    outcomes: list[str] = Field(default_factory=list, max_length=3)
    sort_order: int = Field(default=0, ge=0, le=10000)
    cover_focus: CoverFocus = Field(default_factory=CoverFocus)
    narration_mode: Literal["text", "recorded"] = "text"

    @field_validator("outcomes")
    @classmethod
    def bounded_outcomes(cls, values):
        if any(not value.strip() or len(value) > 200 for value in values):
            raise ValueError("each outcome must contain 1 to 200 characters")
        return [value.strip() for value in values]

    @model_validator(mode="after")
    def segment_identity(self):
        ids = [segment.id for stop in self.stops for segment in (stop.segments or [])]
        if len(ids) != len(set(ids)):
            raise ValueError("segment IDs must be unique across the tour")
        if (self.cover_image_id is None) != (self.cover_image_revision is None):
            raise ValueError("cover image ID and revision must be supplied together")
        return self


ExperienceContent = Annotated[
    ExperienceMediaContent | ExperienceCheckinContent | ExperienceTourContent,
    Field(discriminator="kind"),
]
CONTENT = TypeAdapter(ExperienceContent)


class ExperienceSave(DTO):
    expected_revision: int = Field(ge=0)
    expected_published_revision: int = Field(ge=0)
    content: ExperienceContent
    operation_id: UUID | None = None
    note: str = Field(default="", max_length=500)


class ExperienceDraftAction(DTO):
    expected_revision: int = Field(ge=1)
    expected_published_revision: int = Field(ge=0)
    operation_id: UUID
    note: str = Field(default="", max_length=500)


class ExperienceCopy(ExperienceDraftAction):
    title: str | None = Field(default=None, min_length=1, max_length=120)


class ExperienceReviewRequest(ReviewRequest):
    expected_published_revision: int | None = Field(default=None, ge=0)
    operation_id: UUID | None = None
    video_accessibility_confirmed: bool = False


class ExperienceRetireRequest(ResourceRetireRequest):
    operation_id: UUID | None = None


class PublicExperience(DTO):
    campus_id: CampusId
    id: UUID
    revision: int
    content: ExperienceContent
    media_url: str | None = None
    caption_url: str | None = None


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
    caption_url: str | None = None
    content_sha256: str = ""
    updated_at: datetime | None = None
    submitted_at: datetime | None = None


class ExperienceHistory(DTO):
    id: UUID
    experience_id: UUID
    event: str
    revision: int
    published_revision: int
    operation: Literal["upsert", "retire"]
    content: ExperienceContent | None
    published_content: ExperienceContent | None
    content_sha256: str
    contributor_ids: list[UUID]
    actor_id: UUID | None
    created_at: datetime


class ExperienceUpload(DTO):
    id: UUID
    point_id: UUID
    media_type: Literal["image", "video"]
    mime_type: str
    filename: str
    size_bytes: int
    url: str


class ExperienceCaptionUpload(DTO):
    id: UUID
    point_id: UUID
    mime_type: Literal["text/vtt"] = "text/vtt"
    filename: str
    size_bytes: int
    sha256: str
    cue_count: int
    url: str


def experience_digest(record):
    return hashlib.sha256(
        json.dumps(
            {"content": record.draft, "operation": record.operation},
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def history_write_guard(function):
    parameters = signature(function)

    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (IntegrityError, StaleDataError):
            parameters.bind(*args, **kwargs).arguments["db"].rollback()
            conflict()

    return guarded


def history_snapshot(db, record, event, actor):
    db.add(
        ExperienceVersionRecord(
            experience_id=record.id,
            event=event,
            revision=record.revision,
            published_revision=record.published_revision,
            operation=record.operation,
            content=copy.deepcopy(record.draft),
            published_content=copy.deepcopy(record.published),
            content_sha256=experience_digest(record),
            contributor_ids=list(record.contributor_ids),
            actor_id=actor.user.id,
        )
    )
    old = db.scalars(
        select(ExperienceVersionRecord)
        .where(
            ExperienceVersionRecord.experience_id == record.id,
            ExperienceVersionRecord.event.in_(["autosave", "checkpoint"]),
        )
        .order_by(ExperienceVersionRecord.created_at.desc(), ExperienceVersionRecord.id)
    ).all()
    for version in old[50:]:
        db.delete(version)


def experience_operation(db, actor, operation_id, action, target_id, payload):
    digest_value = hashlib.sha256(
        json.dumps(
            {"action": action, "target": target_id, "payload": payload},
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    if operation_id is None:
        return digest_value, None
    from app.configuration_models import ConfigurationOperationRecord
    from app.content_control_models import ContentOperationRecord

    if db.get(ConfigurationOperationRecord, (actor.user.id, str(operation_id))) or db.get(
        ContentOperationRecord, (actor.user.id, str(operation_id))
    ):
        raise DomainError("OPERATION_CONFLICT", "操作编号已用于配置请求", 409)
    result = db.get(ExperienceOperationRecord, (actor.user.id, str(operation_id)))
    if result:
        if result.fingerprint != digest_value:
            raise DomainError("OPERATION_CONFLICT", "此操作编号已用于不同的请求", 409)
        authorize_operation_result(db, actor, result)
        actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
        return digest_value, result.result
    return digest_value, None


def finish_experience(db, actor, record, operation_id, action, fingerprint, *, commit=True):
    result = admin_view(record, db).model_dump(mode="json")
    if operation_id:
        db.add(
            ExperienceOperationRecord(
                user_id=actor.user.id,
                id=str(operation_id),
                target_id=record.id,
                action=action,
                fingerprint=fingerprint,
                result=result,
            )
        )
    if not commit:
        db.flush()
        return result
    try:
        db.commit()
    except (IntegrityError, StaleDataError):
        db.rollback()
        if operation_id:
            old = db.get(ExperienceOperationRecord, (actor.user.id, str(operation_id)))
            if old and old.fingerprint == fingerprint:
                authorize_operation_result(db, actor, old)
                return old.result
        conflict()
    return result


def freeze_submission(db, record):
    submission = db.get(ExperienceSubmissionRecord, record.id)
    if not submission:
        submission = ExperienceSubmissionRecord(experience_id=record.id)
        db.add(submission)
    submission.revision, submission.content_sha256 = record.revision, experience_digest(record)
    submission.contributor_ids, submission.submitted_by = (
        list(record.contributor_ids),
        record.submitted_by,
    )
    submission.submitted_at = now_utc()


def require_frozen(db, record):
    submission = db.get(ExperienceSubmissionRecord, record.id)
    if (
        not submission
        or submission.revision != record.revision
        or submission.content_sha256 != experience_digest(record)
        or set(submission.contributor_ids) != set(record.contributor_ids)
        or submission.submitted_by != record.submitted_by
    ):
        raise DomainError("SUBMISSION_CHANGED", "待审稿件或贡献记录已改变，请撤回后重新提审", 409)


def validate_complete(content):
    if not content.title.strip() or not content.source_note.strip():
        raise DomainError("CONTENT_INCOMPLETE", "请填写名称和公开来源说明", 409)
    if isinstance(content, ExperienceTourContent) and not content.stops:
        raise DomainError("TOUR_STOPS_REQUIRED", "导览至少需要一个真实地点", 409)


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
    validate_complete(content)
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
    if isinstance(content, ExperienceMediaContent) and content.caption_upload_id:
        upload = db.get(ExperienceUploadRecord, str(content.caption_upload_id))
        if (
            not upload
            or upload.point_id != str(content.point_id)
            or upload.media_type != "subtitle"
            or upload.mime_type != "text/vtt"
        ):
            raise DomainError("NOT_FOUND", "字幕所属资料已不可用", 404)
    if isinstance(content, ExperienceMediaContent) and content.audio_description_video_id:
        from app.modules.video_accessibility import validate_description_video

        validate_description_video(db, content, source_id=record.id)
    # Referenced media must remain independently published and bound to the same point.
    if isinstance(content, ExperienceCheckinContent) and content.image_id:
        referenced_media(db, content.image_id, "image", content.point_id)
    elif isinstance(content, ExperienceTourContent):
        validate_tour_resources(db, content)
        from app.modules.narration.service import validate_bindings

        validate_bindings(db, record, content, require_ready=True)
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


def referenced_tour_resource(db, resource, point_id):
    """Every reference is point-bound, public and pinned to the currently reviewed revision."""
    if resource.type in {"image", "video"}:
        record, _ = referenced_media(db, resource.id, resource.type, point_id)
        revision = record.published_revision
    elif resource.type == "checkin":
        record, _ = referenced_checkin(db, resource.id, point_id)
        revision = record.published_revision
    elif resource.type == "floor":
        record = db.scalar(public_floors().where(FloorRecord.id == str(resource.id)))
        if not record or record.point_id != str(point_id):
            raise DomainError("RESOURCE_NOT_PUBLIC", "楼层未公开或与站点不匹配", 409)
        revision = record.revision
    else:
        record = db.get(PanoramaRecord, str(resource.id))
        if (
            not record
            or record.status != "published"
            or record.point_id != str(point_id)
            or not public_point(db, point_id)
        ):
            raise DomainError("RESOURCE_NOT_PUBLIC", "VR未公开或与站点不匹配", 409)
        revision = record.revision
    if revision != resource.revision:
        raise DomainError("RESOURCE_REVISION_CHANGED", "引用资料已更新，请重新选择当前版本", 409)
    if resource.type == "floor" and getattr(resource, "section_id", None):
        # Sections are stored in the published floor image manifest.
        from app.modules.floors.service import as_floor

        floor = as_floor(record)
        if not any(image.section == resource.section_id for image in floor.images):
            raise DomainError("RESOURCE_REVISION_CHANGED", "楼层分区已更新，请重新选择", 409)
    return record


def validate_tour_resources(db, content):
    if content.cover_image_id:
        cover = db.get(ExperienceRecord, str(content.cover_image_id))
        if not cover or cover.kind != "media":
            raise DomainError("INVALID_COVER", "封面须为路线站点的已发布图片", 409)
        record, image = public_record(db, content.cover_image_id)
        if (
            not isinstance(image, ExperienceMediaContent)
            or image.media_type != "image"
            or str(image.point_id) not in content_points(content)
            or record.campus_id != content.campus_id
        ):
            raise DomainError("INVALID_COVER", "封面须为路线站点的已发布图片", 409)
        if record.published_revision != content.cover_image_revision:
            raise DomainError("RESOURCE_REVISION_CHANGED", "封面图片已更新，请重新选择", 409)
    for stop in content.stops:
        if stop.segments is None or stop.legacy_media_compat:
            if stop.video_id:
                referenced_media(db, stop.video_id, "video", stop.point_id)
            if stop.checkin_id:
                referenced_checkin(db, stop.checkin_id, stop.point_id)
            if stop.segments is None:
                continue
        for segment in stop.segments or []:
            if segment.main_view.type != "map":
                referenced_tour_resource(db, segment.main_view, stop.point_id)
            for resource in segment.resources:
                referenced_tour_resource(db, resource, stop.point_id)


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
        caption_url=(
            f"/api/v1/experiences/{record.id}/captions/{record.published_revision}/{content.caption_upload_id}"
            if isinstance(content, ExperienceMediaContent) and content.caption_upload_id
            else None
        ),
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


def caption_upload(db, settings, key, point_id):
    upload = db.get(ExperienceUploadRecord, str(key))
    if (
        not upload
        or upload.point_id != str(point_id)
        or upload.media_type != "subtitle"
        or upload.mime_type != "text/vtt"
        or upload.filename != "original.vtt"
    ):
        raise DomainError("INVALID_CAPTIONS", "字幕文件类型或所属地点不匹配", 422)
    try:
        path = media_path(settings, upload)
        with path.open("rb") as source:
            actual = inspect_captions(source.read(MAX_CAPTION_BYTES + 1))
        if actual["sha256"] != upload.sha256 or actual["size_bytes"] != upload.size_bytes:
            raise ValueError("caption bytes changed")
    except (ValueError, OSError, UnicodeError) as exc:
        raise DomainError("INVALID_CAPTIONS", "字幕文件校验失败，请重新上传", 422) from exc
    return upload


def candidate_references(content):
    if isinstance(content, ExperienceMediaContent) and content.audio_description_video_id:
        yield str(content.point_id), "video", str(content.audio_description_video_id), content.audio_description_video_revision, None
    if isinstance(content, ExperienceCheckinContent) and content.image_id:
        yield str(content.point_id), "image", str(content.image_id), None, None
    if isinstance(content, ExperienceTourContent):
        if content.cover_image_id:
            yield "cover", "image", str(content.cover_image_id), content.cover_image_revision, None
        for stop in content.stops:
            if stop.segments is None or stop.legacy_media_compat:
                if stop.video_id:
                    yield str(stop.point_id), "video", str(stop.video_id), None, None
                if stop.checkin_id:
                    yield str(stop.point_id), "checkin", str(stop.checkin_id), None, None
            for segment in stop.segments or []:
                views = [*segment.resources]
                if segment.main_view.type != "map":
                    views.append(segment.main_view)
                for ref in views:
                    yield (
                        str(stop.point_id),
                        "vr" if ref.type == "vr_entry" else ref.type,
                        str(ref.id),
                        ref.revision,
                        getattr(ref, "section_id", None),
                    )


def retained_references(db, previous):
    result = set()
    if previous:
        for payload in (previous.draft, previous.published):
            if payload:
                result.update(candidate_references(stored_content(previous, payload)))
    return result


def authorize_retained_reference(db, actor, reference):
    point_id, kind, key, _, _ = reference
    model = FloorRecord if kind == "floor" else PanoramaRecord if kind == "vr" else ExperienceRecord
    resource = db.get(model, key)
    if resource and resource.point_id:
        require_point(db, actor.user, resource.point_id)
        if point_id != "cover" and resource.point_id != point_id:
            raise DomainError("RESOURCE_POINT_CHANGED", "资料所属地点已改变，不能沿用此引用", 409)


def validate_candidate(db, actor, content, settings, *, for_publication=True, previous=None):
    if for_publication:
        validate_complete(content)
    points = [require_point(db, actor.user, key) for key in sorted(content_points(content))]
    if points and len({point.campus_id for point in points}) != 1:
        raise DomainError("CAMPUS_MISMATCH", "路线中的地点须属于同一校区", 422)
    if isinstance(content, ExperienceTourContent):
        require_campus_scope(db, actor, content.campus_id)
        if any(point.campus_id != content.campus_id for point in points):
            raise DomainError("CAMPUS_MISMATCH", "路线站点须属于选择的校区", 422)
    contributors = set()
    if isinstance(content, ExperienceMediaContent) and content.media_type == "video":
        from app.modules.video_accessibility import (
            validate_description_video,
            validate_video_accessibility,
        )

        if for_publication:
            validate_video_accessibility(db, content, source_id=previous.id if previous else None)
        elif content.audio_description_video_id:
            reference = next(candidate_references(content))
            if previous and str(content.audio_description_video_id) == previous.id:
                raise DomainError("DESCRIPTION_SELF_REFERENCE", "口述描述版不能指向当前视频自身", 409)
            if reference in retained_references(db, previous):
                authorize_retained_reference(db, actor, reference)
            else:
                validate_description_video(db, content, source_id=previous.id if previous else None)
    if isinstance(content, ExperienceMediaContent) and content.caption_upload_id:
        caption = caption_upload(db, settings, content.caption_upload_id, content.point_id)
        contributors.add(caption.uploaded_by)
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
    elif isinstance(content, (ExperienceCheckinContent, ExperienceTourContent)):
        allowed = retained_references(db, previous) if not for_publication else set()
        references = list(candidate_references(content))
        if references and all(ref in allowed for ref in references):
            for ref in references:
                authorize_retained_reference(db, actor, ref)
        elif isinstance(content, ExperienceCheckinContent) and content.image_id:
            referenced_media(db, content.image_id, "image", content.point_id)
        elif isinstance(content, ExperienceTourContent):
            if allowed:
                for reference in references:
                    if reference in allowed:
                        authorize_retained_reference(db, actor, reference)
                    elif reference[0] == "cover":
                        cover_only = content.model_copy(deep=True)
                        cover_only.stops = [
                            s.model_copy(
                                update={"segments": None, "video_id": None, "checkin_id": None}
                            )
                            for s in content.stops
                        ]
                        validate_tour_resources(db, cover_only)
                    else:
                        point_id, kind, key, revision, section_id = reference
                        if revision is not None:
                            ref = (
                                TourAssetView(
                                    type="floor", id=key, revision=revision, section_id=section_id
                                )
                                if kind == "floor"
                                else TourResource(type=kind, id=key, revision=revision)
                            )
                            referenced_tour_resource(db, ref, point_id)
                        elif kind == "video":
                            referenced_media(db, key, kind, point_id)
                        else:
                            referenced_checkin(db, key, point_id)
            else:
                validate_tour_resources(db, content)
    return contributors


def admin_view(record, db=None):
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
        caption_url=(
            f"/api/v1/admin/experience-captions/{preview.caption_upload_id}"
            if isinstance(preview, ExperienceMediaContent) and preview.caption_upload_id
            else None
        ),
        content_sha256=experience_digest(record),
        updated_at=utc(record.updated_at),
        submitted_at=(
            utc(submission.submitted_at)
            if (submission := db.get(ExperienceSubmissionRecord, record.id) if db else None)
            and submission.submitted_at
            else None
        ),
    )


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
    filename = "original." + MIME_EXTENSIONS[mime]
    path = folder / filename
    total, digest = 0, hashlib.sha256()
    try:
        settings = request.app.state.settings
        with upload_slot(
            db, settings, actor.user, point, kind="media", upload_id=key, max_bytes=MAX_MEDIA_BYTES
        ) as slot:
            async with asyncio.timeout(slot.timeout_seconds):
                folder.mkdir(parents=True)
                with path.open("xb") as target:
                    async for chunk in request.stream():
                        total += len(chunk)
                        if total > MAX_MEDIA_BYTES:
                            raise DomainError("UPLOAD_TOO_LARGE", "单个媒体文件不能超过100MiB", 413)
                        digest.update(chunk)
                        target.write(chunk)
                if not total:
                    raise DomainError("INVALID_MEDIA", "文件为空", 422)
                await inspect_upload(path, mime, kind="media", settings=settings)
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
                slot.complete(db, total)
                db.commit()
    except TimeoutError as exc:
        raise DomainError("UPLOAD_TIMEOUT", "上传超过处理时限，请重新上传", 408) from exc
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


@router.post(
    "/api/v1/admin/points/{point_id}/experience-captions",
    status_code=201,
    response_model=Envelope[ExperienceCaptionUpload],
    operation_id="uploadExperienceCaptions",
    openapi_extra={**WRITE, "x-module": "M02"},
)
async def upload_captions(point_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    point = require_point(db, actor.user, point_id)
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "text/vtt":
        raise DomainError("UNSUPPORTED_CAPTIONS", "请上传UTF-8纯文本WebVTT字幕", 415)
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > MAX_CAPTION_BYTES):
        raise DomainError("UPLOAD_TOO_LARGE", "字幕文件不能超过1MiB", 413)
    key, filename = str(uuid4()), "original.vtt"
    settings = request.app.state.settings
    folder = settings.floor_assets_dir.resolve() / ".experience-media" / key
    path = folder / filename
    try:
        with upload_slot(
            db,
            settings,
            actor.user,
            point,
            kind="media",
            upload_id=key,
            max_bytes=MAX_CAPTION_BYTES,
        ) as slot:
            async with asyncio.timeout(slot.timeout_seconds):
                raw = bytearray()
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > MAX_CAPTION_BYTES:
                        raise DomainError("UPLOAD_TOO_LARGE", "字幕文件不能超过1MiB", 413)
                    raw.extend(chunk)
                try:
                    meta = inspect_captions(bytes(raw))
                except (ValueError, UnicodeError) as exc:
                    raise DomainError(
                        "INVALID_CAPTIONS",
                        "字幕须有有效时间和纯文本cue，不支持标签、样式或控制字符",
                        422,
                    ) from exc
                folder.mkdir(parents=True)
                with path.open("xb") as target:
                    target.write(raw)
                db.add(
                    ExperienceUploadRecord(
                        id=key,
                        point_id=point.id,
                        uploaded_by=actor.user.id,
                        media_type="subtitle",
                        mime_type="text/vtt",
                        filename=filename,
                        size_bytes=meta["size_bytes"],
                        sha256=meta["sha256"],
                    )
                )
                audit(
                    db,
                    actor.user,
                    "experience.uploaded",
                    point=point,
                    details={
                        "upload_id": key,
                        "mime_type": "text/vtt",
                        "size_bytes": meta["size_bytes"],
                    },
                )
                slot.complete(db, meta["size_bytes"])
                db.commit()
    except BaseException as exc:
        shutil.rmtree(folder, ignore_errors=True)
        if isinstance(exc, TimeoutError):
            raise DomainError("UPLOAD_TIMEOUT", "字幕上传超过处理时限", 408) from exc
        raise
    return envelope(
        request,
        ExperienceCaptionUpload(
            id=key,
            point_id=point.id,
            filename=filename,
            **{k: meta[k] for k in ("size_bytes", "sha256", "cue_count")},
            url=f"/api/v1/admin/experience-captions/{key}",
        ),
    )


@router.get(
    "/api/v1/admin/experience-captions/{upload_id}",
    response_class=FileResponse,
    operation_id="previewExperienceCaptions",
    openapi_extra={**STAFF, "x-module": "M02"},
)
def preview_captions(upload_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    upload = db.get(ExperienceUploadRecord, str(upload_id))
    if not upload:
        raise DomainError("NOT_FOUND", "字幕不存在", 404)
    require_point(db, actor.user, upload.point_id)
    caption_upload(db, request.app.state.settings, upload_id, upload.point_id)
    return caption_response(request.app.state.settings, upload)


def caption_response(settings, upload):
    return FileResponse(
        media_path(settings, upload),
        media_type="text/vtt",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
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


def exact_description(db, source_id, source_revision, target_id, target_revision):
    source = get_published_experience(db, source_id)
    if (
        not isinstance(source.content, ExperienceMediaContent)
        or source.revision != source_revision
        or source.content.audio_description_video_id != target_id
        or source.content.audio_description_video_revision != target_revision
    ):
        raise DomainError("NOT_FOUND", "当前视频或口述描述关联版本已不可用", 404)
    target = get_published_experience(db, target_id)
    if target.revision != target_revision:
        raise DomainError("NOT_FOUND", "口述描述版已更新", 404)
    return target


@router.get(
    "/api/v1/experiences/{source_id}/audio-description/{source_revision}/{target_id}/{target_revision}",
    response_model=Envelope[PublicExperience],
    operation_id="getAudioDescriptionVideo", openapi_extra=PUBLIC,
)
def get_description(source_id: UUID, source_revision: int, target_id: UUID, target_revision: int,
                    request: Request, db: DB):
    target = exact_description(db, source_id, source_revision, target_id, target_revision)
    target.media_url = f"/api/v1/experiences/{source_id}/audio-description/{source_revision}/{target_id}/{target_revision}/media"
    return envelope(request, target)


@router.get(
    "/api/v1/experiences/{source_id}/audio-description/{source_revision}/{target_id}/{target_revision}/media",
    operation_id="getAudioDescriptionMedia", openapi_extra=PUBLIC,
)
def description_media(source_id: UUID, source_revision: int, target_id: UUID, target_revision: int,
                      request: Request, db: DB):
    target = exact_description(db, source_id, source_revision, target_id, target_revision)
    if target.content.upload_id:
        return public_media(target_id, request, db)
    return RedirectResponse(target.content.url, status_code=307,
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


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
    "/api/v1/experiences/{experience_id}/captions/{revision}/{upload_id}",
    response_class=FileResponse,
    operation_id="getExperienceCaptions",
    openapi_extra={**PUBLIC, "x-module": "M02"},
)
def public_captions(experience_id: UUID, revision: int, upload_id: UUID, request: Request, db: DB):
    item = get_published_experience(db, experience_id)
    if (
        not isinstance(item.content, ExperienceMediaContent)
        or item.content.media_type != "video"
        or item.revision != revision
        or item.content.caption_upload_id != upload_id
    ):
        raise DomainError("NOT_FOUND", "字幕版本未发布或已不可用", 404)
    try:
        upload = caption_upload(db, request.app.state.settings, upload_id, item.content.point_id)
    except DomainError as exc:
        raise DomainError("NOT_FOUND", "字幕文件不可用", 404) from exc
    return caption_response(request.app.state.settings, upload)


@router.get(
    "/api/v1/experiences/{experience_id}/media/{revision}",
    operation_id="getExperienceMediaRevision", openapi_extra=PUBLIC,
)
def public_media_revision(experience_id: UUID, revision: int, request: Request, db: DB):
    item = get_published_experience(db, experience_id)
    if not isinstance(item.content, ExperienceMediaContent) or item.revision != revision:
        raise DomainError("NOT_FOUND", "媒体正式版本已不可用", 404)
    if item.content.upload_id:
        return public_media(experience_id, request, db)
    return RedirectResponse(item.content.url, status_code=307,
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


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
    return envelope(request, admin_view(require_record(db, actor, experience_id), db))


@router.get(
    "/api/v1/admin/experiences/{experience_id}/preview",
    response_model=Envelope[PublicExperience],
    operation_id="previewExperienceTour",
    openapi_extra=EXPERIENCE_STAFF,
)
def preview_tour(
    experience_id: UUID,
    request: Request,
    actor: Actor,
    db: DB,
    expected_revision: int = Query(ge=1),
):
    actor.require("points.read")
    record = require_record(db, actor, experience_id)
    if record.revision != expected_revision:
        conflict()
    payload = record.draft if record.state in ACTIVE else record.published
    if not payload:
        raise DomainError("NOT_FOUND", "没有可预览的路线", 404)
    content = stored_content(record, payload)
    if not isinstance(content, ExperienceTourContent):
        raise DomainError("TOUR_REQUIRED", "此入口仅预览校园导览", 422)
    validate_candidate(
        db, actor, content, request.app.state.settings, for_publication=False, previous=record
    )
    return envelope(
        request,
        PublicExperience(
            id=record.id, campus_id=record.campus_id, revision=record.revision, content=content
        ),
    )


@history_write_guard
def save_experience(key, payload, request, actor, db, *, commit=True):
    with storage_guard(request.app.state.settings):
        return _save_experience(key, payload, request, actor, db, commit=commit)


def _save_experience(key, payload, request, actor, db, *, commit=True):
    actor.require("points.edit")
    fingerprint, old = experience_operation(
        db,
        actor,
        payload.operation_id,
        "save",
        str(key) if key else None,
        payload.model_dump(mode="json"),
    )
    if old:
        return envelope(request, old)
    record = require_record(db, actor, key, lock=True) if key else None
    if payload.expected_revision != (
        record.revision if record else 0
    ) or payload.expected_published_revision != (record.published_revision if record else 0):
        conflict()
    if record and record.state == "in_review":
        conflict("请先撤回审核中的修改")
    content = payload.content
    contributors = validate_candidate(
        db, actor, content, request.app.state.settings, for_publication=False, previous=record
    )
    if isinstance(content, ExperienceTourContent):
        from app.modules.narration.service import validate_bindings

        contributors.update(validate_bindings(db, record, content, allow_stale_existing=True))
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
    if record and record.operation == "upsert" and record.draft == content.model_dump(mode="json"):
        return envelope(
            request,
            finish_experience(
                db, actor, record, payload.operation_id, "save", fingerprint, commit=commit
            ),
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
    db.flush([record])
    submitted = db.get(ExperienceSubmissionRecord, record.id)
    if submitted:
        db.delete(submitted)
    latest = db.scalar(
        select(ExperienceVersionRecord)
        .where(ExperienceVersionRecord.experience_id == record.id)
        .order_by(ExperienceVersionRecord.created_at.desc())
        .limit(1)
    )
    if not latest or utc(latest.created_at) + timedelta(minutes=5) <= now_utc():
        history_snapshot(db, record, "created" if latest is None else "autosave", actor)
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
    return envelope(
        request,
        finish_experience(
            db, actor, record, payload.operation_id, "save", fingerprint, commit=commit
        ),
    )


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
    experience_id: UUID, payload: ExperienceRetireRequest, request: Request, actor: Actor, db: DB
):
    with storage_guard(request.app.state.settings):
        return _retire(experience_id, payload, request, actor, db)


@history_write_guard
def _retire(experience_id, payload, request, actor, db):
    actor.require("points.edit")
    fingerprint, old = experience_operation(
        db,
        actor,
        payload.operation_id,
        "retire",
        str(experience_id),
        payload.model_dump(mode="json"),
    )
    if old:
        return envelope(request, old)
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
    freeze_submission(db, record)
    history_snapshot(db, record, "retire_request", actor)
    return envelope(
        request, finish_experience(db, actor, record, payload.operation_id, "retire", fingerprint)
    )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/review/{action}",
    response_model=Envelope[AdminExperience],
    operation_id="reviewExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
def review(
    experience_id: UUID,
    action: Literal["submit", "publish", "reject", "discard"],
    payload: ExperienceReviewRequest,
    request: Request,
    actor: Actor,
    db: DB,
):
    with storage_guard(request.app.state.settings):
        return _review(experience_id, action, payload, request, actor, db)


@history_write_guard
def _review(experience_id, action, payload, request, actor, db):
    actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
    if action == "publish":
        require_recent_mfa(actor)
    fingerprint, old = experience_operation(
        db, actor, payload.operation_id, action, str(experience_id), payload.model_dump(mode="json")
    )
    if old:
        return envelope(request, old)
    record = require_record(db, actor, experience_id, lock=True)
    if record.revision != payload.expected_revision:
        conflict()
    if (
        payload.expected_published_revision is not None
        and record.published_revision != payload.expected_published_revision
    ):
        conflict()
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写操作说明", 422)
    if action == "submit":
        if record.state not in {"draft", "rejected"}:
            conflict("当前状态不能提交")
        if record.operation == "upsert":
            validate_candidate(
                db, actor, stored_content(record, record.draft), request.app.state.settings, previous=record
            )
            from app.modules.narration.service import validate_bindings

            validate_bindings(db, record, stored_content(record, record.draft), require_ready=True)
        elif record.status != "published":
            conflict("当前内容已不可用")
        record.state, record.submitted_by = "in_review", actor.user.id
        record.contributor_ids = sorted(set(record.contributor_ids + [actor.user.id]))
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
        require_frozen(db, record)
        if action == "reject":
            record.state = "rejected"
        else:
            before = record.published
            if record.operation == "retire":
                record.status = "retired"
            else:
                content = stored_content(record, record.draft)
                validate_candidate(db, actor, content, request.app.state.settings, previous=record)
                video_review = None
                if isinstance(content, ExperienceMediaContent) and content.media_type == "video":
                    if not payload.video_accessibility_confirmed:
                        raise DomainError("VIDEO_REVIEW_REQUIRED", "审核人员须明确确认本版本的视频画面信息判断与口述描述关联", 409)
                    from app.modules.video_accessibility import review_evidence

                    video_review = review_evidence(db, record, content)
                from app.modules.narration.service import validate_bindings

                validate_bindings(db, record, content, require_ready=True)
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
                    **({"video_accessibility_review": video_review} if record.operation == "upsert" and video_review else {}),
                },
            )
    record.revision += 1
    record.review_note, record.updated_at = payload.note.strip(), now_utc()
    if action == "submit":
        freeze_submission(db, record)
    else:
        submission = db.get(ExperienceSubmissionRecord, record.id)
        if submission:
            db.delete(submission)
    history_snapshot(db, record, action, actor)
    if action != "publish":
        experience_audit(
            db,
            actor.user,
            "experience." + action,
            record=record,
            note=payload.note,
            details={"experience_id": record.id, "revision": record.revision},
        )
    return envelope(
        request, finish_experience(db, actor, record, payload.operation_id, action, fingerprint)
    )


def action_record(db, actor, experience_id, payload, *, edit=True):
    actor.require("points.edit" if edit else "points.read")
    record = require_record(db, actor, experience_id, lock=edit)
    if (
        record.revision != payload.expected_revision
        or record.published_revision != payload.expected_published_revision
    ):
        conflict()
    return record


def experience_preflight(db, actor, record, settings):
    issues, dependencies = [], []
    if record.operation == "retire":
        return ConfigurationPreflight(
            valid=record.status == "published",
            revision=record.revision,
            content_sha256=experience_digest(record),
            dependency_sha256=hashlib.sha256(b"retire").hexdigest(),
            issues=[],
        )
    content = stored_content(record, record.draft)
    if not content.title.strip():
        issues.append(
            ConfigurationIssue(
                code="TITLE_REQUIRED", severity="error", path="title", message="请填写名称"
            )
        )
    if not content.source_note.strip():
        issues.append(
            ConfigurationIssue(
                code="SOURCE_REQUIRED",
                severity="error",
                path="source_note",
                message="请填写公开来源说明",
            )
        )
    if isinstance(content, ExperienceTourContent) and not content.stops:
        issues.append(
            ConfigurationIssue(
                code="TOUR_STOPS_REQUIRED", severity="error", path="stops", message="请添加真实地点"
            )
        )
    for point_id in sorted(content_points(content)):
        point = public_point(db, point_id)
        if point is None or point.campus_id != record.campus_id:
            issues.append(
                ConfigurationIssue(
                    code="POINT_NOT_PUBLIC",
                    severity="error",
                    path="stops" if isinstance(content, ExperienceTourContent) else "point_id",
                    message="涉及地点须公开且属于原校区",
                )
            )
        else:
            dependencies.append({"type": "point", "id": point.id, "revision": point.revision})

    def inspect_reference(path, kind, key, point_id, revision=None, section_id=None):
        try:
            if kind in {"image", "video"}:
                target, _ = referenced_media(db, key, kind, point_id)
                current_revision = target.published_revision
            elif kind == "checkin":
                target, _ = referenced_checkin(db, key, point_id)
                current_revision = target.published_revision
            else:
                ref = (
                    TourAssetView(type="floor", id=key, revision=revision, section_id=section_id)
                    if kind == "floor"
                    else TourResource(
                        type="vr" if kind == "vr_entry" else kind, id=key, revision=revision
                    )
                )
                target = referenced_tour_resource(db, ref, point_id)
                current_revision = target.revision
            if revision is not None and revision != current_revision:
                issues.append(
                    ConfigurationIssue(
                        code="RESOURCE_REVISION_CHANGED",
                        severity="error",
                        path=path,
                        message="引用资料已改变，请重新选择",
                        expected_revision=revision,
                        actual_revision=current_revision,
                    )
                )
            dependencies.append({"type": kind, "id": str(key), "revision": current_revision})
        except DomainError as exc:
            issues.append(
                ConfigurationIssue(
                    code=exc.code,
                    severity="error",
                    path=path,
                    message=exc.message,
                    expected_revision=revision,
                )
            )

    if isinstance(content, ExperienceCheckinContent) and content.image_id:
        inspect_reference("image_id", "image", content.image_id, content.point_id)
    if isinstance(content, ExperienceMediaContent) and content.upload_id:
        try:
            validate_candidate(db, actor, content, settings, for_publication=False, previous=record)
        except DomainError as exc:
            issues.append(
                ConfigurationIssue(
                    code=exc.code, severity="error", path="upload_id", message=exc.message
                )
            )
    if isinstance(content, ExperienceMediaContent) and content.media_type == "video":
        from app.modules.video_accessibility import validate_video_accessibility

        try:
            target = validate_video_accessibility(db, content, source_id=record.id)
            if target:
                dependencies.append({"type": "video", "id": target[0].id,
                                     "revision": target[0].published_revision})
        except DomainError as exc:
            issues.append(ConfigurationIssue(code=exc.code, severity="error",
                path="audio_description_video_id" if content.video_visual_information == "description_required" else "video_visual_information",
                message=exc.message))
    if isinstance(content, ExperienceTourContent):
        if content.cover_image_id:
            cover = db.get(ExperienceRecord, str(content.cover_image_id))
            point_id = cover.point_id if cover else str(uuid4())
            inspect_reference(
                "cover_image_id",
                "image",
                content.cover_image_id,
                point_id,
                content.cover_image_revision,
            )
            if (
                not cover
                or cover.point_id not in content_points(content)
                or cover.campus_id != record.campus_id
            ):
                issues.append(
                    ConfigurationIssue(
                        code="INVALID_COVER",
                        severity="error",
                        path="cover_image_id",
                        message="封面须来自路线地点的图片",
                    )
                )
        from app.modules.narration.service import asset_matches
        from app.narration_models import NarrationAsset

        for stop_index, stop in enumerate(content.stops):
            prefix = f"stops.{stop_index}"
            if stop.segments is None or stop.legacy_media_compat:
                if stop.video_id:
                    inspect_reference(prefix + ".video_id", "video", stop.video_id, stop.point_id)
                if stop.checkin_id:
                    inspect_reference(
                        prefix + ".checkin_id", "checkin", stop.checkin_id, stop.point_id
                    )
                if (
                    stop.segments is None
                    and content.narration_mode == "recorded"
                    and stop.narrative.strip()
                ):
                    issues.append(
                        ConfigurationIssue(
                            code="LEGACY_CONVERSION_REQUIRED",
                            severity="error",
                            path=prefix + ".segments",
                            message="请明确转换旧讲稿，再制作正式音频",
                        )
                    )
            for segment_index, segment in enumerate(stop.segments or []):
                path = prefix + f".segments.{segment_index}"
                if segment.main_view.type != "map":
                    view = segment.main_view
                    inspect_reference(
                        path + ".main_view",
                        view.type,
                        view.id,
                        stop.point_id,
                        view.revision,
                        view.section_id,
                    )
                for resource_index, ref in enumerate(segment.resources):
                    inspect_reference(
                        path + f".resources.{resource_index}",
                        ref.type,
                        ref.id,
                        stop.point_id,
                        ref.revision,
                    )
                if segment.narration_asset_id:
                    asset = db.get(NarrationAsset, str(segment.narration_asset_id))
                    if not asset_matches(asset, record, stop, segment):
                        issues.append(
                            ConfigurationIssue(
                                code="NARRATION_SOURCE_CHANGED",
                                severity="error",
                                path=path + ".narration_asset_id",
                                message="已采用音频与文字或身份不匹配",
                            )
                        )
                    else:
                        dependencies.append(
                            {
                                "type": "narration",
                                "id": asset.id,
                                "manifest_sha256": asset.manifest_sha256,
                                "text_sha256": asset.text_sha256,
                            }
                        )
                elif content.narration_mode == "recorded" and segment.text.strip():
                    issues.append(
                        ConfigurationIssue(
                            code="NARRATION_REQUIRED",
                            severity="error",
                            path=path + ".narration_asset_id",
                            message="此段需要生成、试听并采用正式音频",
                        )
                    )
    return ConfigurationPreflight(
        valid=not any(i.severity == "error" for i in issues),
        revision=record.revision,
        content_sha256=experience_digest(record),
        dependency_sha256=hashlib.sha256(
            json.dumps(dependencies, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
        issues=issues,
    )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/preflight",
    response_model=Envelope[ConfigurationPreflight],
    operation_id="preflightExperience",
    openapi_extra=EXPERIENCE_STAFF,
)
def preflight_experience(
    experience_id: UUID, payload: ExperienceDraftAction, request: Request, actor: Actor, db: DB
):
    record = action_record(db, actor, experience_id, payload, edit=False)
    return envelope(request, experience_preflight(db, actor, record, request.app.state.settings))


@router.get(
    "/api/v1/admin/experiences/{experience_id}/history",
    response_model=Envelope[list[ExperienceHistory]],
    operation_id="experienceHistory",
    openapi_extra=EXPERIENCE_STAFF,
)
def experience_history(experience_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    record = require_record(db, actor, experience_id)
    items = db.scalars(
        select(ExperienceVersionRecord)
        .where(ExperienceVersionRecord.experience_id == record.id)
        .order_by(ExperienceVersionRecord.created_at.desc(), ExperienceVersionRecord.id)
    ).all()
    accessible = []
    for item in items:
        try:
            authorize_history(db, actor, record, item)
        except DomainError:
            continue
        accessible.append(
            ExperienceHistory(
                id=item.id,
                experience_id=record.id,
                event=item.event,
                revision=item.revision,
                published_revision=item.published_revision,
                operation=item.operation,
                content=stored_content(record, item.content) if item.content else None,
                published_content=stored_content(record, item.published_content)
                if item.published_content
                else None,
                content_sha256=item.content_sha256,
                contributor_ids=item.contributor_ids,
                actor_id=item.actor_id,
                created_at=utc(item.created_at),
            )
        )
    return envelope(request, accessible)


def authorize_history(db, actor, record, item):
    """Historical content is checked against today's scope before it is returned."""
    require_campus_scope(db, actor, record.campus_id)
    for payload in (item.content, item.published_content):
        if not payload:
            continue
        content = stored_content(record, payload)
        for point_id in content_points(content):
            require_point(db, actor.user, point_id)
        for ref in candidate_references(content):
            authorize_retained_reference(db, actor, ref)


def authorize_operation_result(db, actor, item):
    record = require_record(db, actor, item.target_id)
    historical = SimpleNamespace(
        content=item.result.get("content"), published_content=item.result.get("published_content")
    )
    authorize_history(db, actor, record, historical)
    return record


@router.post(
    "/api/v1/admin/experiences/{experience_id}/checkpoint",
    response_model=Envelope[AdminExperience],
    operation_id="checkpointExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
@history_write_guard
def checkpoint_experience(
    experience_id: UUID, payload: ExperienceDraftAction, request: Request, actor: Actor, db: DB
):
    actor.require("points.edit")
    fingerprint, old = experience_operation(
        db,
        actor,
        payload.operation_id,
        "checkpoint",
        str(experience_id),
        payload.model_dump(mode="json"),
    )
    if old:
        return envelope(request, old)
    record = action_record(db, actor, experience_id, payload)
    if record.state == "in_review":
        conflict("待审稿冻结，不能新增草稿检查点")
    history_snapshot(db, record, "checkpoint", actor)
    experience_audit(db, actor.user, "experience.checkpoint", record=record, note=payload.note)
    return envelope(
        request,
        finish_experience(db, actor, record, payload.operation_id, "checkpoint", fingerprint),
    )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/withdraw",
    response_model=Envelope[AdminExperience],
    operation_id="withdrawExperience",
    openapi_extra=EXPERIENCE_WRITE,
)
@history_write_guard
def withdraw_experience(
    experience_id: UUID, payload: ExperienceDraftAction, request: Request, actor: Actor, db: DB
):
    actor.require("points.edit")
    fingerprint, old = experience_operation(
        db,
        actor,
        payload.operation_id,
        "withdraw",
        str(experience_id),
        payload.model_dump(mode="json"),
    )
    if old:
        return envelope(request, old)
    record = action_record(db, actor, experience_id, payload)
    if record.state != "in_review":
        conflict("只有待审稿可以撤回修改")
    if actor.user.role != "admin" and actor.user.id not in record.contributor_ids:
        raise DomainError("FORBIDDEN", "只能撤回自己参与的稿件", 403)
    record.state, record.submitted_by, record.revision, record.updated_at = (
        "draft",
        None,
        record.revision + 1,
        now_utc(),
    )
    submission = db.get(ExperienceSubmissionRecord, record.id)
    if submission:
        db.delete(submission)
    history_snapshot(db, record, "withdraw", actor)
    experience_audit(db, actor.user, "experience.withdraw", record=record, note=payload.note)
    return envelope(
        request, finish_experience(db, actor, record, payload.operation_id, "withdraw", fingerprint)
    )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/copy",
    response_model=Envelope[AdminExperience],
    operation_id="copyExperienceDraft",
    openapi_extra=EXPERIENCE_WRITE,
)
@history_write_guard
def copy_experience(
    experience_id: UUID, payload: ExperienceCopy, request: Request, actor: Actor, db: DB
):
    with storage_guard(request.app.state.settings):
        actor.require("points.edit")
        fingerprint, old = experience_operation(
            db,
            actor,
            payload.operation_id,
            "copy",
            str(experience_id),
            payload.model_dump(mode="json"),
        )
        if old:
            return envelope(request, old)
        source = action_record(db, actor, experience_id, payload)
        content = stored_content(source, source.draft or source.published).model_copy(deep=True)
        if payload.title:
            content.title = payload.title
        if isinstance(content, ExperienceTourContent):
            for stop in content.stops:
                for segment in stop.segments or []:
                    segment.id, segment.narration_asset_id = "segment-" + uuid4().hex, None
        contributors = validate_candidate(
            db, actor, content, request.app.state.settings, for_publication=False, previous=source
        )
        contributors.update(source.contributor_ids)
        contributors.add(actor.user.id)
        record = ExperienceRecord(
            id=str(uuid4()),
            kind=source.kind,
            campus_id=source.campus_id,
            point_id=source.point_id,
            revision=1,
            published_revision=0,
            state="draft",
            status="draft",
            operation="upsert",
            draft=content.model_dump(mode="json"),
            published=None,
            contributor_ids=sorted(contributors),
            submitted_by=None,
            review_note=payload.note,
            updated_at=now_utc(),
        )
        db.add(record)
        db.flush([record])
        history_snapshot(db, record, "copy", actor)
        experience_audit(
            db,
            actor.user,
            "experience.copy",
            record=record,
            note=payload.note,
            details={"source_id": source.id, "source_revision": source.revision},
        )
        return envelope(
            request, finish_experience(db, actor, record, payload.operation_id, "copy", fingerprint)
        )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/convert-legacy",
    response_model=Envelope[AdminExperience],
    operation_id="convertLegacyExperienceDraft",
    openapi_extra=EXPERIENCE_WRITE,
)
@history_write_guard
def convert_legacy(
    experience_id: UUID, payload: ExperienceDraftAction, request: Request, actor: Actor, db: DB
):
    with storage_guard(request.app.state.settings):
        actor.require("points.edit")
        fingerprint, old = experience_operation(
            db,
            actor,
            payload.operation_id,
            "convert",
            str(experience_id),
            payload.model_dump(mode="json"),
        )
        if old:
            return envelope(request, old)
        record = action_record(db, actor, experience_id, payload)
        if record.state == "in_review":
            conflict("待审稿冻结，请先撤回")
        content = stored_content(record, record.draft or record.published).model_copy(deep=True)
        if not isinstance(content, ExperienceTourContent):
            raise DomainError("TOUR_REQUIRED", "仅导览路线需要转换旧讲稿", 422)
        changed = False
        for stop in content.stops:
            if stop.segments is not None:
                continue
            resources = []
            if stop.video_id:
                media, _ = referenced_media(db, stop.video_id, "video", stop.point_id)
                resources.append(
                    TourResource(type="video", id=media.id, revision=media.published_revision)
                )
            if stop.checkin_id:
                checkin, _ = referenced_checkin(db, stop.checkin_id, stop.point_id)
                resources.append(
                    TourResource(type="checkin", id=checkin.id, revision=checkin.published_revision)
                )
            stop.segments = [
                TourSegment(
                    id="segment-" + uuid4().hex,
                    text=stop.narrative,
                    source_note=content.source_note,
                    resources=resources,
                )
            ]
            stop.legacy_media_compat, changed = True, True
        if changed:
            record.draft, record.revision, record.state, record.operation = (
                content.model_dump(mode="json"),
                record.revision + 1,
                "draft",
                "upsert",
            )
            record.submitted_by = None
            record.contributor_ids = sorted(set(record.contributor_ids + [actor.user.id]))
            record.updated_at, record.review_note = now_utc(), payload.note
            history_snapshot(db, record, "convert", actor)
            experience_audit(db, actor.user, "experience.convert", record=record, note=payload.note)
        return envelope(
            request,
            finish_experience(db, actor, record, payload.operation_id, "convert", fingerprint),
        )


@router.post(
    "/api/v1/admin/experiences/{experience_id}/history/{version_id}/restore-draft",
    response_model=Envelope[AdminExperience],
    operation_id="restoreExperienceDraft",
    openapi_extra=EXPERIENCE_WRITE,
)
@history_write_guard
def restore_experience_draft(
    experience_id: UUID,
    version_id: UUID,
    payload: ExperienceDraftAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    with storage_guard(request.app.state.settings):
        actor.require("points.edit")
        fingerprint, old = experience_operation(
            db,
            actor,
            payload.operation_id,
            "restore",
            str(experience_id),
            {**payload.model_dump(mode="json"), "version_id": str(version_id)},
        )
        if old:
            return envelope(request, old)
        record = action_record(db, actor, experience_id, payload)
        if record.state == "in_review":
            conflict("待审稿冻结，请先撤回")
        item = db.get(ExperienceVersionRecord, str(version_id))
        if item is None or item.experience_id != record.id:
            raise DomainError("NOT_FOUND", "历史版本不存在", 404)
        authorize_history(db, actor, record, item)
        content = stored_content(record, item.content or item.published_content)
        historical = SimpleNamespace(
            id=record.id,
            campus_id=record.campus_id,
            draft=item.content,
            published=item.published_content,
        )
        contributors = validate_candidate(
            db,
            actor,
            content,
            request.app.state.settings,
            for_publication=False,
            previous=historical,
        )
        if isinstance(content, ExperienceTourContent):
            from app.modules.narration.service import validate_bindings

            contributors.update(
                validate_bindings(db, historical, content, allow_stale_existing=True)
            )
        record.draft, record.revision, record.state, record.operation = (
            content.model_dump(mode="json"),
            record.revision + 1,
            "draft",
            "upsert",
        )
        record.submitted_by, record.review_note, record.updated_at = None, payload.note, now_utc()
        record.contributor_ids = sorted(
            set(record.contributor_ids + item.contributor_ids + [actor.user.id]) | contributors
        )
        history_snapshot(db, record, "restore", actor)
        experience_audit(
            db,
            actor.user,
            "experience.restore",
            record=record,
            note=payload.note,
            details={"version_id": str(version_id)},
        )
        return envelope(
            request,
            finish_experience(db, actor, record, payload.operation_id, "restore", fingerprint),
        )
