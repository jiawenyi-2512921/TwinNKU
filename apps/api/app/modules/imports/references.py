"""Thin catalog for explicit imports choices, using existing authorization paths."""

import unicodedata

from sqlalchemy import select

from app.core.errors import DomainError
from app.models import (
    ExperienceRecord,
    FloorRecord,
    MapRecord,
    PanoramaRecord,
    PointChangeRecord,
    PointRecord,
    ResourceChangeRecord,
)
from app.modules.admin.security import point_scope, require_point
from app.modules.experiences import (
    public_point,
    public_record,
    require_campus_scope,
    require_record,
    stored_content,
)
from app.modules.floors.service import public_floors


def ref_item(db, actor, kind, key, settings):
    if kind == "point":
        record = require_point(db, actor.user, key)
        draft = db.get(PointChangeRecord, record.id)
        title = (draft.payload or {}).get("name", record.name) if draft and draft.state in {"draft", "in_review", "rejected"} else record.name
        return {"id": record.id, "title": title, "kind": kind, "campus_id": record.campus_id,
            "point_id": record.id, "point_name": title, "revision": record.revision,
            "draft_revision": draft.revision if draft else 0, "referenceable": public_point(db, key) is not None,
            "thumbnail_url": None}
    if kind == "map":
        record = db.get(MapRecord, str(key))
        if not record or record.kind != "campus" or record.status != "published" or record.visibility != "public":
            raise DomainError("NOT_FOUND", "底图不存在或不可用", 404)
        campus = require_campus_scope(db, actor, record.campus_id)
        if not campus.is_active:
            raise DomainError("NOT_FOUND", "所属校区已经停用", 404)
        return {"id": record.id, "title": record.title, "kind": kind, "campus_id": record.campus_id,
            "point_id": None, "point_name": "", "revision": record.revision, "draft_revision": 0,
            "referenceable": True, "thumbnail_url": None}
    if kind in {"floor", "vr"}:
        from app.modules.admin.resources import load_resource

        point, current, change = load_resource(db, actor, key)
        actual = "floor" if isinstance(current, FloorRecord) else "vr" if isinstance(current, PanoramaRecord) else "floor" if change.kind == "floor" else "vr"
        if actual != kind:
            raise DomainError("NOT_FOUND", "资料类型不匹配", 404)
        pending = (change.payload or {}).get("content", {}) if change and change.state in {"draft", "in_review", "rejected"} else {}
        title = pending.get("title") or pending.get("label") or (current.label if kind == "floor" else current.title) if current else pending.get("label") or pending.get("title") or "资料"
        valid = bool(current and current.status == "published" and (kind != "floor" or current.visibility == "public") and public_point(db, point.id))
        thumbnail = None
        if kind == "floor":
            valid = bool(valid and db.scalar(public_floors().where(FloorRecord.id == str(key))) is not None)
            if valid:
                image = next((image for image in current.images if image.get("variant") == "labeled"), None)
                if image:
                    from urllib.parse import urlencode

                    thumbnail = f"/api/v1/floors/{key}/images/{current.revision}/labeled?" + urlencode({"section": image.get("section", "main")})
        if valid:
            title = current.label if kind == "floor" else current.title
        return {"id": str(key), "title": title, "kind": kind, "campus_id": point.campus_id,
            "point_id": point.id, "point_name": point.name, "revision": current.revision if current else 0,
            "draft_revision": change.revision if change else 0, "referenceable": valid, "thumbnail_url": thumbnail}
    record = require_record(db, actor, key)
    content = stored_content(record, record.draft or record.published)
    actual = content.media_type if content.kind == "media" else content.kind
    if actual != kind:
        raise DomainError("NOT_FOUND", "资料类型不匹配", 404)
    valid, public = False, None
    try:
        _, public = public_record(db, key)
        valid = True
    except DomainError:
        pass
    # Only an owned local image is previewed automatically; external images are
    # not fetched here and their arbitrary URL is never a catalog thumbnail.
    thumbnail = f"/api/v1/experiences/{key}/media" if valid and kind == "image" and public.upload_id else None
    point = require_point(db, actor.user, record.point_id) if record.point_id else None
    return {"id": record.id, "title": (public or content).title, "kind": kind, "campus_id": record.campus_id,
        "point_id": record.point_id, "point_name": point.name if point else "", "revision": record.published_revision,
        "draft_revision": record.revision, "referenceable": valid, "thumbnail_url": thumbnail,
        "audio_description_eligible": bool(valid and kind == "video" and public.video_visual_information == "audio_complete"
            and public.video_accessibility_note.strip() and public.audio_description_video_id is None),
        "preview_url": f"/api/v1/experiences/{key}/media/{record.published_revision}" if valid and kind == "video" else None}


def catalog(db, actor, settings, kind, campus_id, point_id, q, referenceable, *, purpose="general"):
    actor.require("points.read")
    if campus_id:
        require_campus_scope(db, actor, campus_id)
    if point_id:
        point = require_point(db, actor.user, point_id)
        if campus_id and point.campus_id != campus_id:
            raise DomainError("NOT_FOUND", "地点不属于所选校区", 404)
    points_query = select(PointRecord).where(point_scope(actor.user))
    if campus_id:
        points_query = points_query.where(PointRecord.campus_id == campus_id)
    if point_id:
        points_query = points_query.where(PointRecord.id == str(point_id))
    points = list(db.scalars(points_query))
    ids = [point.id for point in points]
    if kind == "point":
        keys = ids
    elif kind == "map":
        campuses = {campus_id} if campus_id else set(actor.user.campus_ids) if actor.user.role != "admin" else {point.campus_id for point in points}
        keys = list(db.scalars(select(MapRecord.id).where(MapRecord.campus_id.in_(campuses), MapRecord.kind == "campus", MapRecord.status == "published", MapRecord.visibility == "public")))
    elif kind in {"floor", "vr"}:
        model = FloorRecord if kind == "floor" else PanoramaRecord
        keys = sorted(set(db.scalars(select(model.id).where(model.point_id.in_(ids)))) |
            set(db.scalars(select(ResourceChangeRecord.resource_id).where(ResourceChangeRecord.point_id.in_(ids), ResourceChangeRecord.kind == ("floor" if kind == "floor" else "panorama"), ResourceChangeRecord.state.in_({"draft", "in_review", "rejected"})))))
    else:
        query = select(ExperienceRecord.id).where(ExperienceRecord.kind == ("media" if kind in {"image", "video"} else kind))
        if campus_id:
            query = query.where(ExperienceRecord.campus_id == campus_id)
        if actor.user.role != "admin":
            query = query.where(ExperienceRecord.campus_id.in_(actor.user.campus_ids))
        if point_id and kind != "tour":
            query = query.where(ExperienceRecord.point_id == str(point_id))
        keys = list(db.scalars(query))
    term = unicodedata.normalize("NFKC", q.strip()).casefold()
    result = []
    for key in keys:
        try:
            item = ref_item(db, actor, kind, key, settings)
        except DomainError:
            continue
        if referenceable and kind != "point" and not item["referenceable"]:
            continue
        if purpose == "audio_description" and not item.get("audio_description_eligible"):
            continue
        if point_id and kind == "tour":
            from app.modules.experiences import content_points

            record = require_record(db, actor, key)
            if not any(str(point_id) in content_points(stored_content(record, content)) for content in (record.draft, record.published) if content):
                continue
        if term and term not in unicodedata.normalize("NFKC", item["title"] + " " + item["point_name"]).casefold():
            continue
        result.append(item)
    return sorted(result, key=lambda item: (item["point_name"], item["title"], item["id"]))


def binding_values(db, actor, job_kind, binding, settings):
    field, kind = binding["field"], binding["kind"]
    if field == "point_id" and job_kind in {"vr", "media", "tour"} and kind == "point":
        expected_kind = "point"
    elif field == "map_id" and job_kind == "point" and kind == "map":
        expected_kind = "map"
    elif field == "cover_image_id" and job_kind == "vr" and kind == "image":
        expected_kind = "image"
    elif field == "audio_description_video_id" and job_kind == "media" and kind == "video":
        expected_kind = "video"
    elif job_kind == "tour" and field in {"image_id", "video_id", "floor_id", "vr_id", "checkin_id"} and kind == field[:-3]:
        expected_kind = kind
    elif job_kind == "tour" and field == "main_id" and kind in {"image", "video", "floor", "vr"}:
        expected_kind = kind
    else:
        raise DomainError("IMPORT_REFERENCE_FIELD", "请选择与此模板关联字段一致的地点或素材类型", 422)
    item = ref_item(db, actor, expected_kind, binding["id"], settings)
    if field == "audio_description_video_id" and not item.get("audio_description_eligible"):
        raise DomainError("DESCRIPTION_NOT_COMPLETE", "口述描述候选须已审核声音完整表达关键画面", 409)
    if kind not in {"point", "map"} and not item["referenceable"]:
        raise DomainError("IMPORT_REFERENCE_UNAVAILABLE", "关联素材当前未正式发布或已不可用", 409)
    if item["revision"] != binding["revision"]:
        raise DomainError("REVISION_CONFLICT", "所选对象版本已变化，请重新选择", 409)
    values = {field: str(binding["id"])}
    if field == "main_id":
        values.update(main_type="vr_entry" if kind == "vr" else kind, main_revision=str(item["revision"]))
        # A former floor section cannot carry over to another source/type.
        values["section_id"] = ""
    elif field != "point_id":
        values[field[:-3] + "_revision"] = str(item["revision"])
    return values
