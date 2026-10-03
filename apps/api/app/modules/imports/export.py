"""Bounded scoped, editable CSV exports; no implicit publication or truncation."""

import csv
import io
import json

from sqlalchemy import select

from app.core.errors import DomainError
from app.models import (
    ExperienceRecord,
    PanoramaRecord,
    PointChangeRecord,
    PointGeometryRecord,
    PointRecord,
    ResourceChangeRecord,
)
from app.modules.admin.resources import ACTIVE, load_resource, published_content
from app.modules.admin.security import point_scope, require_point
from app.modules.experiences import (
    authorize_retained_reference,
    candidate_references,
    require_campus_scope,
    require_record,
    stored_content,
)
from app.modules.imports.parser import MAX_BYTES, MAX_CELL, MAX_ROWS, TableError, cell_text
from app.modules.imports.service import (
    COLUMNS,
    EXPORT_SCHEMA,
    STOP_SETTINGS,
    TOUR_SETTINGS,
    safe_csv_cell,
)
from app.modules.narration.service import sha


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def cannot_export(message):
    raise DomainError("EXPORT_NOT_REPRESENTABLE", message + "；请使用后台表单，不能以残缺表格覆盖原资料", 409)


def point_rows(db, actor, point, warnings):
    require_point(db, actor.user, point.id)
    draft = db.get(PointChangeRecord, point.id)
    if draft and draft.state in ACTIVE and draft.operation == "retire":
        cannot_export("地点正在处理下架；更新模板不能表达下架流程")
    data = draft.payload if draft and draft.state in ACTIVE and draft.operation == "upsert" and draft.payload else None
    geometry = data.get("geometry") if data else None
    if not geometry:
        current = list(db.scalars(select(PointGeometryRecord).where(PointGeometryRecord.point_id == point.id).order_by(PointGeometryRecord.map_id)))
        if len(current) != 1:
            cannot_export("地点没有唯一可回填的校园底图；多底图应分别通过地点表单维护")
        geometry = {name: getattr(current[0], name) for name in ("map_id", "map_revision", "anchor", "polygon", "label_on_map")}
        if current[0].entrance_ids:
            cannot_export("地点几何具有入口关联，当前地点模板不能无损回填")
    source = data.get("source_note", "") if data else ((draft.payload or {}).get("source_note", "") if draft else "")
    if not source:
        warnings.append({"id": point.id, "code": "SOURCE_REQUIRED", "message": "该历史地点没有已保存的来源说明；导入更新前请由内容人员补充真实来源", "fields": ["source_note"]})
    data = data or {name: getattr(point, name) for name in ("campus_id", "name", "aliases", "category", "summary", "visibility")}
    return [{"id": point.id, "expected_revision": draft.revision if draft else 0,
        "expected_published_revision": point.revision, "source_note": source,
        **{name: data.get(name, "") for name in ("campus_id", "name", "category", "summary", "visibility")},
        "aliases": "|".join(data.get("aliases", [])), "aliases_json": compact(data.get("aliases", [])),
        "map_id": geometry["map_id"], "map_revision": geometry["map_revision"],
        "x": geometry["anchor"]["x"], "y": geometry["anchor"]["y"],
        "polygon": ";".join(f'{vertex["x"]},{vertex["y"]}' for vertex in geometry["polygon"]),
        "label_on_map": "是" if geometry.get("label_on_map", False) else "否"}]


def vr_rows(db, actor, key, warnings):
    point, current, change = load_resource(db, actor, key)
    if change and change.state in ACTIVE and change.operation == "retire":
        cannot_export("VR正在处理下架；更新模板不能表达下架流程")
    if (current and not isinstance(current, PanoramaRecord)) or (change and change.kind != "panorama"):
        raise DomainError("NOT_FOUND", "VR资料不存在或不在授权范围内", 404)
    data = change.payload if change and change.state in ACTIVE and change.operation == "upsert" and change.payload else None
    content = data["content"] if data else published_content(current).model_dump(mode="json") if current else None
    if not content:
        cannot_export("VR没有可导出的当前稿件或正式正文")
    if content.get("cover_image_id"):
        authorize_retained_reference(db, actor, (point.id, "image", str(content["cover_image_id"]), content.get("cover_image_revision"), None))
    source = data.get("source_note", "") if data else ((change.payload or {}).get("source_note", "") if change else "")
    if not source:
        warnings.append({"id": str(key), "code": "SOURCE_REQUIRED", "message": "该历史VR没有已保存的来源说明；导入更新前请由内容人员补充真实来源", "fields": ["source_note"]})
    return [{"id": str(key), "point_id": point.id, "expected_revision": change.revision if change else 0,
        "expected_published_revision": current.revision if current else 0, "source_note": source,
        **{name: content.get(name, "" if name == "observation_prompt" else 0 if name == "sort_order" else None)
           for name in ("title", "description", "url", "observation_prompt", "cover_image_id", "cover_image_revision", "sort_order")}}]


def experience_rows(db, actor, record, kind):
    require_record(db, actor, record.id)
    if record.operation == "retire" and record.state in ACTIVE:
        cannot_export("资料正在处理下架；更新模板不能表达下架流程")
    if record.kind != kind:
        raise DomainError("NOT_FOUND", "资料类型不匹配或不在授权范围内", 404)
    content = stored_content(record, record.draft or record.published).model_dump(mode="json")
    for ref in candidate_references(stored_content(record, content)):
        authorize_retained_reference(db, actor, ref)
    common = {"id": record.id, "expected_revision": record.revision, "expected_published_revision": record.published_revision,
        **{key: content[key] for key in ("title", "description", "source_note")}}
    if kind == "media":
        return [{**common, **{key: content[key] for key in ("point_id", "media_type", "upload_id", "url", "alternative_text", "transcript")},
            "caption_upload_id": content.get("caption_upload_id"), "caption_language": content.get("caption_language", "zh-CN"),
            "caption_label": content.get("caption_label", "中文字幕"),
            **{key: content.get(key, "unassessed" if key == "video_visual_information" else "" if key == "video_accessibility_note" else None)
                for key in ("video_visual_information", "video_accessibility_note", "audio_description_video_id", "audio_description_video_revision")}}]
    common.update(batch_key=record.id, campus_id=content["campus_id"],
        tour_settings=compact({key: content[key] for key in TOUR_SETTINGS}))
    if not content["stops"]:
        return [{**common, "row_type": "empty", "stop_order": 0, "segment_order": 0}]
    rows = []
    for number, stop in enumerate(content["stops"], 1):
        base = {**common, "stop_order": number, "point_id": stop["point_id"], "stop_title": stop["title"],
            "stop_settings": compact({key: stop[key] for key in STOP_SETTINGS})}
        if stop["segments"] is None:
            rows.append({**base, "row_type": "legacy", "segment_order": 0})
            continue
        for order, part in enumerate(stop["segments"], 1):
            row = {**base, "row_type": "segment", "segment_order": order, "segment_id": part["id"],
                "segment_title": part["title"], "text": part["text"], "segment_source": part["source_note"],
                "observation_prompt": part["observation_prompt"], "takeaway": part["takeaway"],
                "main_type": part["main_view"]["type"], "main_id": part["main_view"].get("id"),
                "main_revision": part["main_view"].get("revision"), "section_id": part["main_view"].get("section_id"),
                "resources_json": compact(part["resources"])}
            for ref in part["resources"]:
                row.setdefault(ref["type"] + "_id", ref["id"])
                row.setdefault(ref["type"] + "_revision", ref["revision"])
            # Audio is never accepted from a spreadsheet. An update reuses only
            # the same existing point/segment/exact text; copies require adoption.
            rows.append(row)
    return rows


def build_export(db, actor, kind, campus_id, ids):
    actor.require("points.edit")
    require_campus_scope(db, actor, campus_id)
    points = list(db.scalars(select(PointRecord).where(point_scope(actor.user), PointRecord.campus_id == campus_id)))
    authorized = {point.id: point for point in points}
    selected = [str(value) for value in ids]
    if len(selected) != len(set(selected)):
        raise DomainError("EXPORT_SELECTION", "同一导出记录不能重复选择", 422)
    if kind == "point":
        if selected:
            for key in selected:
                point = require_point(db, actor.user, key)
                if point.campus_id != campus_id:
                    raise DomainError("NOT_FOUND", "地点不属于所选校区", 404)
        keys = selected or sorted(key for key, value in authorized.items() if value.status != "retired")
    elif kind == "vr":
        keys = selected or sorted({value for value in db.scalars(select(PanoramaRecord.id).where(PanoramaRecord.point_id.in_(authorized), PanoramaRecord.status != "retired"))}
            | {value for value in db.scalars(select(ResourceChangeRecord.resource_id).where(ResourceChangeRecord.point_id.in_(authorized), ResourceChangeRecord.kind == "panorama", ResourceChangeRecord.state.in_(ACTIVE), ResourceChangeRecord.operation == "upsert"))})
    else:
        keys = selected or list(db.scalars(select(ExperienceRecord.id).where(ExperienceRecord.campus_id == campus_id, ExperienceRecord.kind == kind,
            ExperienceRecord.status != "retired", ExperienceRecord.state != "discarded").order_by(ExperienceRecord.id)))
    if kind in {"point", "vr"} and len(keys) > MAX_ROWS:
        raise DomainError("EXPORT_SIZE", "记录超过500条，请选择较小的一组后导出", 413)
    rows, warnings, count = [], [], 0
    for key in keys:
        if kind == "point":
            batch = point_rows(db, actor, authorized[key], warnings)
        elif kind == "vr":
            point, _, _ = load_resource(db, actor, key)
            if point.campus_id != campus_id:
                raise DomainError("NOT_FOUND", "VR不属于所选校区", 404)
            batch = vr_rows(db, actor, key, warnings)
        else:
            try:
                record = require_record(db, actor, key)
            except DomainError:
                if selected:
                    raise
                continue  # Omit unauthorized records before any content/count.
            if record.campus_id != campus_id or record.kind != kind:
                raise DomainError("NOT_FOUND", "资料不属于所选校区或类型", 404)
            try:
                batch = experience_rows(db, actor, record, kind)
            except DomainError as exc:
                if not selected and exc.code in {"NOT_FOUND", "FORBIDDEN", "RESOURCE_POINT_CHANGED"}:
                    continue
                raise
        rows.extend(batch)
        count += 1
        if len(rows) > MAX_ROWS:
            raise DomainError("EXPORT_SIZE", "站点段落超过500行，请选择较小的一组路线后导出", 413)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS[kind].values())
    for number, row in enumerate(rows, 2):
        row["export_schema"] = EXPORT_SCHEMA
        values = [safe_csv_cell(row.get(key)) for key in COLUMNS[kind]]
        if any(len(value) > MAX_CELL for value in values):
            cannot_export("存在超过20000字符的单元格或转义后超限的正文")
        try:
            for column, value in enumerate(values, 1):
                cell_text(value, number, column)
        except TableError:
            cannot_export("正文包含当前数据导入器不允许的控制字符")
        writer.writerow(values)
    body = output.getvalue().encode("utf-8-sig")
    if len(body) > MAX_BYTES:
        raise DomainError("EXPORT_SIZE", "文件超过10MB，请缩小导出范围", 413)
    manifest = {"kind": kind, "campus_id": campus_id, "record_count": count, "row_count": len(rows), "sha256": sha(body),
        "filename": f"twinnku-{kind}-{campus_id}.csv", "warnings": warnings}
    return body, manifest
