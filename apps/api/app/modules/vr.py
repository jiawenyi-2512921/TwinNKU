"""VR presentation references and manual evidence; never performs network probes."""

import hashlib
import json
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import aliased

from app.contracts import DTO, Panorama, PanoramaContent, PublicVRCheck, PublicVRChecks
from app.core.errors import DomainError
from app.models import PanoramaVerificationRecord
from app.modules.admin.security import utc

Dimension = Literal["technical", "scene", "device"]
Platform = Literal["desktop", "android", "ios", "wechat"]
Result = Literal["passed", "failed", "uncertain"]
Reason = Literal["none", "authentication_required", "network_unavailable", "upstream_unavailable", "scene_not_matched", "visual_not_checked", "device_failure", "other_uncertain"]
REASONS = {
    "technical": {"authentication_required", "network_unavailable", "upstream_unavailable", "visual_not_checked", "other_uncertain"},
    "scene": {"scene_not_matched", "visual_not_checked", "other_uncertain"},
    "device": {"authentication_required", "network_unavailable", "upstream_unavailable", "device_failure", "other_uncertain"},
}


class VRCheckSave(DTO):
    operation_id: UUID
    expected_revision: int = Field(ge=0)
    expected_published_revision: int = Field(ge=0)
    dimension: Dimension
    platform: Platform | None = None
    result: Result
    reason: Reason = "none"
    environment: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=1000)

    @field_validator("environment", "notes")
    @classmethod
    def plain_private_text(cls, value):
        if any(unicodedata.category(character) in {"Cc", "Cf"} and character not in "\n\r\t" for character in value):
            raise ValueError("control characters are not accepted")
        return value.strip()

    @model_validator(mode="after")
    def dimensions_match(self):
        if (self.dimension == "device") != (self.platform is not None):
            raise ValueError("only device evidence requires a device platform")
        if (self.result == "passed" and self.reason != "none") or (self.result != "passed" and self.reason not in REASONS[self.dimension]):
            raise ValueError("use a controlled reason appropriate to the result and dimension")
        if self.dimension == "device" and not self.environment:
            raise ValueError("record the private browser/device environment")
        return self


class StaffVRCheck(DTO):
    id: UUID
    operation_id: UUID
    dimension: Dimension
    platform: Platform | None
    result: Result
    reason: Reason
    environment: str
    notes: str
    recorded_by: UUID
    recorded_at: datetime
    method: Literal["manual"] = "manual"
    stale: bool


class StaffVRChecks(DTO):
    resource_id: UUID
    expected_revision: int
    expected_published_revision: int
    items: list[StaffVRCheck]
    latest: list[StaffVRCheck] = Field(default_factory=list)
    has_more: bool = False


def url_fingerprint(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def evidence_source(current, content):
    generation = current.verification_generation if current else 1
    if current and current.url != content.url:
        generation += 1
    return generation, url_fingerprint(content.url)


def check_fingerprint(resource_id, payload):
    value = [str(resource_id), payload.model_dump(mode="json", exclude={"operation_id"})]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def private_check(row, source):
    return StaffVRCheck(
        **{field: getattr(row, field) for field in ("id", "operation_id", "dimension", "platform", "result", "reason", "environment", "notes", "recorded_by")},
        recorded_at=utc(row.recorded_at),
        stale=(row.generation, row.url_sha256) != source,
    )


def validate_cover(db, point_id, content):
    if not content.cover_image_id:
        return None
    from app.modules.experiences import referenced_media

    record, image = referenced_media(db, content.cover_image_id, "image", point_id)
    if record.published_revision != content.cover_image_revision:
        raise DomainError("RESOURCE_REVISION_CHANGED", "VR封面图片已更新，请重新选择当前正式版本", 409)
    return image.url or f"/api/v1/experiences/{record.id}/media"


def ranked_checks(filters):
    ranked = select(PanoramaVerificationRecord, func.row_number().over(
        partition_by=(PanoramaVerificationRecord.resource_id, PanoramaVerificationRecord.dimension, PanoramaVerificationRecord.platform),
        order_by=(PanoramaVerificationRecord.recorded_at.desc(), PanoramaVerificationRecord.id.desc()),
    ).label("position")).where(filters).subquery()
    return select(aliased(PanoramaVerificationRecord, ranked)).where(ranked.c.position == 1)


def latest_manual_checks(db, resource_id, point_id, source):
    rows = db.scalars(ranked_checks(and_(
        PanoramaVerificationRecord.resource_id == str(resource_id),
        PanoramaVerificationRecord.point_id == point_id,
        PanoramaVerificationRecord.generation == source[0],
        PanoramaVerificationRecord.url_sha256 == source[1],
    )))
    return [private_check(row, source) for row in rows]


def public_checks(db, records):
    """One bounded batch query selects the latest record in each separate dimension."""
    if not records:
        return {}
    source = [and_(PanoramaVerificationRecord.resource_id == record.id,
                   PanoramaVerificationRecord.point_id == record.point_id,
                   PanoramaVerificationRecord.generation == record.verification_generation,
                   PanoramaVerificationRecord.url_sha256 == url_fingerprint(record.url)) for record in records]
    items = db.scalars(ranked_checks(or_(*source)))
    summaries = {}
    for row in items:
        summary = summaries.setdefault(row.resource_id, PublicVRChecks())
        safe = PublicVRCheck(result=row.result, method="manual", recorded_at=utc(row.recorded_at))
        if row.dimension == "device":
            summary.devices[row.platform] = safe
        else:
            setattr(summary, row.dimension, safe)
    return summaries


def public_panorama(db, record, checks=None):
    content = PanoramaContent.model_validate(record)
    try:
        valid = validate_cover(db, record.point_id, content)
        cover = (f"/api/v1/points/{record.point_id}/panoramas/{record.id}/cover/"
                 f"{record.revision}/{content.cover_image_id}/{content.cover_image_revision}") if valid else None
    except DomainError:
        cover = None  # A withdrawn dependent image must never replace the original VR link.
    return Panorama(**content.model_dump(), id=record.id, point_id=record.point_id,
                    revision=record.revision, cover_image_url=cover,
                    checks=(checks if checks is not None else public_checks(db, [record])).get(record.id, PublicVRChecks()))
