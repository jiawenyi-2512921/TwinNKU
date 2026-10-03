"""Reviewed, point-bound alternatives for the visual information in a video.

These are human content decisions, not an automated accessibility certification.
No remote URL is fetched or inferred from the submitted description.
"""

import hashlib
import json

from app.core.errors import DomainError
from app.models import ExperienceRecord


def validate_description_video(db, content, *, source_id=None):
    from app.modules.experiences import public_record, stored_content

    key = content.audio_description_video_id
    if not key:
        raise DomainError("AUDIO_DESCRIPTION_REQUIRED", "请关联同地点已发布的口述描述版视频", 409)
    if source_id is not None and str(key) == str(source_id):
        raise DomainError("DESCRIPTION_SELF_REFERENCE", "口述描述版不能指向当前视频自身", 409)
    target = db.get(ExperienceRecord, str(key))
    if not target or target.kind != "media" or target.status != "published" or not target.published:
        raise DomainError("DESCRIPTION_NOT_PUBLIC", "口述描述版视频未发布或已下架", 409)
    alternative = stored_content(target, target.published)
    if (
        alternative.kind != "media"
        or alternative.media_type != "video"
        or str(alternative.point_id) != str(content.point_id)
        or target.point_id != str(content.point_id)
    ):
        raise DomainError("DESCRIPTION_POINT_MISMATCH", "口述描述版须是同地点的视频", 409)
    # A single independently reviewed audio-complete alternative is sufficient.
    # Refusing chains before public_record also prevents cycles and recursive reads.
    if (
        alternative.video_visual_information != "audio_complete"
        or not alternative.video_accessibility_note.strip()
        or alternative.audio_description_video_id is not None
    ):
        raise DomainError(
            "DESCRIPTION_NOT_COMPLETE",
            "口述描述版须已审核为声音完整表达关键画面，不能再关联其他版本",
            409,
        )
    if target.published_revision != content.audio_description_video_revision:
        raise DomainError(
            "RESOURCE_REVISION_CHANGED", "口述描述版已更新，请重新选择当前正式版本", 409
        )
    public_record(db, key)
    return target, alternative


def validate_video_accessibility(db, content, *, source_id=None):
    if content.media_type != "video":
        return None
    if (
        content.video_visual_information == "unassessed"
        or not content.video_accessibility_note.strip()
    ):
        raise DomainError(
            "VIDEO_ASSESSMENT_REQUIRED", "请判断视频关键画面是否由声音完整表达，并填写核对说明", 409
        )
    if content.video_visual_information == "silent" and not content.transcript.strip():
        raise DomainError(
            "SILENT_VIDEO_EQUIVALENT_REQUIRED", "无声视频须提供说明关键画面的等价文字稿", 409
        )
    if content.video_visual_information == "description_required":
        return validate_description_video(db, content, source_id=source_id)
    return None


def review_evidence(db, record, content):
    target = validate_video_accessibility(db, content, source_id=record.id)
    dependency = (
        {
            "id": target[0].id,
            "revision": target[0].published_revision,
            "content_sha256": hashlib.sha256(
                json.dumps(
                    target[0].published, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                ).encode()
            ).hexdigest(),
        }
        if target
        else None
    )
    value = {
        "source_id": record.id,
        "draft_revision": record.revision,
        "published_revision": record.published_revision + 1,
        "assessment": content.video_visual_information,
        "source_content_sha256": hashlib.sha256(content.model_dump_json().encode()).hexdigest(),
        "description_video": dependency,
    }
    value["dependency_sha256"] = hashlib.sha256(
        json.dumps(dependency, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return value
