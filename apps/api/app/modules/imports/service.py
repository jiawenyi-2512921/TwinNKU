"""Translate table fields into existing typed draft commands, then recheck scope."""

import csv
import io
import json
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import ValidationError

from app.api import require_campus
from app.contracts import PanoramaContent, PointDraftInput, PointDraftUpdate, ResourceDraftSave
from app.core.errors import DomainError
from app.models import (
    ExperienceRecord,
    FloorRecord,
    PointChangeRecord,
    PointGeometryRecord,
    ResourceChangeRecord,
)
from app.modules.admin import resources
from app.modules.admin import service as points
from app.modules.admin.security import require_point
from app.modules.experiences import (
    ExperienceSave,
    require_campus_scope,
    require_record,
    stored_content,
    validate_candidate,
)
from app.modules.narration.service import canonical, sha

# Templates are self-describing; explicit mapping accepts these keys or labels.
COMMON = {"id": "记录ID（新增留空）", "expected_revision": "草稿版本", "expected_published_revision": "公开版本", "source_note": "公开来源说明"}
COLUMNS = {
    "point": {**COMMON, "campus_id": "校区代码", "name": "地点名称", "aliases": "别名（竖线分隔）", "category": "分类代码", "summary": "地点介绍", "visibility": "可见范围", "map_id": "底图ID", "map_revision": "底图版本", "x": "锚点X", "y": "锚点Y", "polygon": "点击轮廓（x,y用分号分隔）", "label_on_map": "地图显示名称"},
    "vr": {**COMMON, "point_id": "所属地点ID", "title": "全景名称", "url": "完整HTTPS链接", "description": "场景说明"},
    "media": {**COMMON, "point_id": "所属地点ID", "title": "资料名称", "media_type": "资料类型（image或video）", "upload_id": "已上传文件ID", "url": "完整HTTPS链接", "description": "资料说明", "alternative_text": "图片替代说明", "transcript": "视频文字稿"},
    "tour": {**COMMON, "batch_key": "本批路线编号", "campus_id": "校区代码", "title": "路线名称", "description": "路线简介", "stop_order": "站次", "point_id": "地点ID", "stop_title": "站点标题", "segment_order": "段序", "segment_id": "段落ID（新增留空）", "segment_title": "段落标题", "text": "讲解正文", "segment_source": "段落公开来源", "main_type": "主画面类型", "main_id": "主画面资源ID", "main_revision": "主画面资源版本", "section_id": "楼层分区", "observation_prompt": "观察提示", "takeaway": "回顾要点", **{key: label for kind, title in (("image", "图片"), ("floor", "楼层"), ("video", "视频"), ("vr", "VR"), ("checkin", "打卡")) for key, label in ((kind + "_id", title + "资源ID"), (kind + "_revision", title + "资源版本"))}},
}
COLUMNS["point"]["aliases_json"] = "别名保留数据（勿删除）"
COLUMNS["vr"].update(observation_prompt="全景观察提示", cover_image_id="全景封面图片ID",
    cover_image_revision="全景封面图片版本", sort_order="全景目录顺序")
COLUMNS["media"].update(caption_upload_id="已上传字幕文件ID", caption_language="字幕语言", caption_label="字幕名称")
COLUMNS["media"].update(video_visual_information="关键画面判断（unassessed或audio_complete或description_required或silent）",
    video_accessibility_note="画面与声音核对说明", audio_description_video_id="口述描述版视频ID",
    audio_description_video_revision="口述描述版视频正式版本")
COLUMNS["tour"].update(row_type="行类型（segment或legacy或empty）",
    tour_settings="路线展示保留数据（勿删除）", stop_settings="站点触发保留数据（勿删除）",
    resources_json="完整素材保留数据（勿删除）")
TOUR_SETTINGS = {"cover_image_id", "cover_image_revision", "lead", "outcomes", "sort_order", "cover_focus", "narration_mode"}
STOP_SETTINGS = {"title", "narrative", "video_id", "checkin_id", "prompt_timing", "legacy_media_compat"}
EXPORT_SCHEMA = "twinnku-table-v1"
for _columns in COLUMNS.values():
    _columns["export_schema"] = "导出格式（勿修改或删除保留列）"


def suggested_mapping(kind, columns):
    allowed = COLUMNS[kind]
    reverse = {label: key for key, label in allowed.items()}
    return {column: column if column in allowed else reverse[column] for column in columns if column in allowed or column in reverse}


def validate_mapping(job, mapping):
    if (not mapping or any(key not in job.columns or value not in COLUMNS[job.kind] for key, value in mapping.items())
            or len(set(mapping.values())) != len(mapping)):
        raise DomainError("IMPORT_MAPPING", "请为资料列选择唯一的模板字段，或忽略不导入的列", 422)


def template_csv(kind):
    output = io.StringIO(newline="")
    csv.writer(output).writerow(COLUMNS[kind].values())
    return output.getvalue().encode("utf-8-sig")


def safe_csv_cell(value):
    value = "" if value is None else str(value)
    # Escape original apostrophes as well, preserving literal formula-looking
    # prose. Decoding below is data only; no spreadsheet expression is evaluated.
    return "'" + value if value.startswith("'") or formula_like(value) or value.startswith(("\t", "\r")) else value


def formula_like(value):
    return value.lstrip("\ufeff \t\r\n\v\f").startswith(("=", "+", "-", "@"))


def literal_cell(value):
    if value.startswith("'"):
        rest = value[1:]
        if rest.startswith(("'", "\t", "\r")) or formula_like(rest):
            return rest
    return value


def json_field(values, key, allowed=None, *, array=False):
    raw = values.get(key, "")
    if not raw:
        return [] if array else {}
    try:
        result = json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise DomainError("IMPORT_PRESERVED_DATA", "保留数据不是有效纯数据JSON，请恢复原导出或在后台表单修改", 422) from exc
    if (array and not isinstance(result, list)) or (not array and (not isinstance(result, dict) or set(result) - set(allowed or []))):
        raise DomainError("IMPORT_PRESERVED_DATA", "保留数据包含未支持的字段，不能静默忽略", 422)
    return result


def integer(values, key, default=0):
    raw = values.get(key, "").strip()
    if not raw:
        return default
    try:
        result = int(raw)
        if result < 0:
            raise ValueError
        return result
    except ValueError as exc:
        raise DomainError("IMPORT_VALUE", f"{key}需要填写非负整数", 422) from exc


def identity(values, key, optional=False):
    value = values.get(key, "").strip()
    if not value and optional:
        return None
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise DomainError("IMPORT_VALUE", f"{key}需要填写有效ID", 422) from exc


def boolean(value, default=True):
    if not value:
        return default
    if value.lower() in {"true", "1", "是"}:
        return True
    if value.lower() in {"false", "0", "否"}:
        return False
    raise DomainError("IMPORT_VALUE", "地图显示名称需要填写是或否", 422)


def point_command(db, actor, values):
    key = identity(values, "id", optional=True)
    existing = require_point(db, actor.user, key) if key else None
    draft = db.get(PointChangeRecord, key) if key else None
    geometry = draft.payload.get("geometry") if draft and draft.payload else None
    if not geometry and key:
        from sqlalchemy import select
        current = db.scalar(select(PointGeometryRecord).where(PointGeometryRecord.point_id == key))
        if current:
            geometry = {name: getattr(current, name) for name in ("map_id", "map_revision", "anchor", "polygon", "label_on_map")}
    if values.get("map_id"):
        try:
            polygon = [{"x": float(pair.split(",")[0]), "y": float(pair.split(",")[1])} for pair in values.get("polygon", "").split(";")]
            geometry = {"map_id": identity(values, "map_id"), "map_revision": integer(values, "map_revision"), "anchor": {"x": float(values.get("x", "")), "y": float(values.get("y", ""))}, "polygon": polygon, "label_on_map": boolean(values.get("label_on_map", ""))}
        except (ValueError, IndexError) as exc:
            raise DomainError("IMPORT_GEOMETRY", "请填写有效锚点与至少三个轮廓顶点", 422) from exc
    if not geometry:
        raise DomainError("IMPORT_GEOMETRY", "新增地点需要完整的底图、锚点和点击轮廓", 422)
    aliases = [v.strip() for v in values.get("aliases", "").split("|") if v.strip()]
    if values.get("aliases_json"):
        preserved = json_field(values, "aliases_json", array=True)
        if not all(isinstance(value, str) for value in preserved):
            raise DomainError("IMPORT_PRESERVED_DATA", "别名保留数据必须为文字列表", 422)
        if values.get("aliases", "") == "|".join(preserved):
            aliases = preserved
    data = {"campus_id": values.get("campus_id", ""), "name": values.get("name", ""), "aliases": aliases, "category": values.get("category", ""), "summary": values.get("summary", ""), "visibility": values.get("visibility") or "public", "source_note": values.get("source_note", ""), "geometry": geometry}
    if key:
        data.update(expected_revision=integer(values, "expected_revision"), expected_point_revision=integer(values, "expected_published_revision"))
    payload = (PointDraftUpdate if key else PointDraftInput).model_validate(data)
    points.validate_location(db, payload.campus_id, payload.geometry)
    if existing:
        if (existing.campus_id != payload.campus_id or existing.revision != payload.expected_point_revision
                or (draft.revision if draft else 0) != payload.expected_revision or (draft and draft.state == "in_review")):
            raise DomainError("REVISION_CONFLICT", "地点已变化或正在审核，请重新检查", 409)
    elif actor.user.role != "admin" and (payload.campus_id not in actor.user.campus_ids or actor.user.point_ids):
        raise DomainError("FORBIDDEN", "没有本校区新增地点权限", 403)
    return {"kind": "point", "id": key, "payload": payload.model_dump(mode="json")}


def resource_command(db, actor, values, settings):
    key, point_id = identity(values, "id", optional=True), identity(values, "point_id")
    point = require_point(db, actor.user, point_id)
    _, current, change = resources.load_resource(db, actor, key) if key else (point, None, None)
    if current and isinstance(current, FloorRecord) or change and change.kind != "panorama":
        raise DomainError("IMPORT_KIND", "该ID不是VR资料", 422)
    if (current and current.point_id != point_id) or (change and change.point_id != point_id):
        raise DomainError("IMPORT_POINT", "已有VR不能转移到其他地点", 422)
    # Legacy manual tables need not know newly introduced display fields. Their
    # omission retains current values; an explicit empty cover pair removes it.
    original = ((change.payload or {}).get("content", {}) if change and change.state in resources.ACTIVE
                else resources.published_content(current).model_dump(mode="json") if current else {})
    data = {**original, "title": values.get("title", ""), "url": values.get("url", ""),
            "description": values.get("description", "")}
    if "observation_prompt" in values:
        data["observation_prompt"] = values["observation_prompt"]
    if "sort_order" in values:
        data["sort_order"] = integer(values, "sort_order")
    if "cover_image_id" in values or "cover_image_revision" in values:
        data["cover_image_id"] = identity(values, "cover_image_id", optional=True)
        data["cover_image_revision"] = integer(values, "cover_image_revision") if values.get("cover_image_revision", "").strip() else None
    payload = ResourceDraftSave(content=PanoramaContent.model_validate(data), source_note=values.get("source_note", ""), expected_revision=integer(values, "expected_revision"), expected_published_revision=integer(values, "expected_published_revision"))
    if ((change.revision if change else 0) != payload.expected_revision or (current.revision if current else 0) != payload.expected_published_revision or (change and change.state == "in_review")):
        raise DomainError("REVISION_CONFLICT", "VR已变化或正在审核，请重新检查", 409)
    resources.validate_candidate(db, point, key, payload.content, current, settings.floor_assets_dir.resolve())
    return {"kind": "vr", "id": key, "point_id": point_id, "payload": payload.model_dump(mode="json")}


def experience_command(db, actor, values, content, settings):
    key = identity(values, "id", optional=True)
    record = require_record(db, actor, key) if key else None
    if record and (record.draft or record.published):
        original = stored_content(record, record.draft or record.published).model_dump(mode="json")
        content = {**original, **content}
        if original["kind"] == "tour" and content["kind"] == "tour":
            # Preserve non-tabular display settings and exact unchanged audio
            # bindings, while imported station/paragraph order is explicit.
            if not values.get("tour_settings"):
                content["narration_mode"] = original.get("narration_mode", "text")
            segments = {(stop["point_id"], part["id"]): part for stop in original["stops"] for part in stop.get("segments") or []}
            for stop in content["stops"]:
                for part in stop.get("segments") or []:
                    old = segments.get((stop["point_id"], part["id"]))
                    if old and old["text"] == part["text"]:
                        part["narration_asset_id"] = old.get("narration_asset_id")
    payload = ExperienceSave(content=content, expected_revision=integer(values, "expected_revision"), expected_published_revision=integer(values, "expected_published_revision"))
    if ((record.revision if record else 0) != payload.expected_revision or (record.published_revision if record else 0) != payload.expected_published_revision or (record and record.state == "in_review")):
        raise DomainError("REVISION_CONFLICT", "资料已变化或正在审核，请重新检查", 409)
    validate_candidate(db, actor, payload.content, settings, for_publication=False, previous=record)
    if record and (record.kind != payload.content.kind
                   or (record.point_id and record.point_id != str(payload.content.point_id))
                   or (record.kind == "tour" and record.campus_id != payload.content.campus_id)):
        raise DomainError("IMPORT_KIND", "不能改变已有资料的类型或所属地点", 422)
    return {"kind": "experience", "id": key, "payload": payload.model_dump(mode="json")}


def tour_content(job, rows):
    first = rows[0][1]
    constant = ("id", "expected_revision", "expected_published_revision", "campus_id", "title", "description", "source_note", "tour_settings")
    settings = json_field(first, "tour_settings", TOUR_SETTINGS)
    base = {"kind": "tour", "campus_id": first.get("campus_id", ""), "title": first.get("title", ""), "description": first.get("description", ""), "source_note": first.get("source_note", ""), "narration_mode": "text", **settings}
    if first.get("row_type") == "empty":
        if len(rows) != 1 or integer(first, "stop_order") or integer(first, "segment_order") or first.get("point_id"):
            raise DomainError("IMPORT_ORDER", "空路线保留行不能包含站点或其他资料行", 422)
        return {**base, "stops": []}
    stops = {}
    for number, values in rows:
        if any(values.get(key, "") != first.get(key, "") for key in constant):
            raise DomainError("IMPORT_GROUP", "同一路线的基本信息和版本必须一致", 422)
        order, segment_order = integer(values, "stop_order"), integer(values, "segment_order")
        mode = values.get("row_type") or "segment"
        if mode not in {"segment", "legacy"} or not 1 <= order <= 50 or (mode == "segment" and not 1 <= segment_order <= 50) or (mode == "legacy" and segment_order):
            raise DomainError("IMPORT_ORDER", "站次和段序必须在1至50之间", 422)
        point_id = identity(values, "point_id")
        extras = json_field(values, "stop_settings", STOP_SETTINGS)
        title = values.get("stop_title", "")
        if not title and "title" in extras and extras["title"] is None:
            title = None
        stop = stops.setdefault(order, {**extras, "point_id": point_id, "title": title, "segments": {}})
        if (stop["point_id"] != point_id or stop["title"] != title or segment_order in stop["segments"]
                or any(stop.get(key) != extras.get(key) for key in STOP_SETTINGS - {"title"})):
            raise DomainError("IMPORT_ORDER", "同一站点归属不一致或段序重复", 422)
        if mode == "legacy":
            if stop["segments"]:
                raise DomainError("IMPORT_ORDER", "旧单段站点不能混合新分段行", 422)
            stop["segments"][0] = None
            continue
        if 0 in stop["segments"]:
            raise DomainError("IMPORT_ORDER", "旧单段站点不能混合新分段行", 422)
        main_type = values.get("main_type") or "map"
        main = {"type": main_type}
        if main_type != "map":
            main.update(id=identity(values, "main_id"), revision=integer(values, "main_revision"))
            if values.get("section_id"):
                main["section_id"] = values["section_id"]
        from app.modules.experiences import TourResource

        refs = [TourResource.model_validate(item).model_dump(mode="json") for item in json_field(values, "resources_json", array=True)]
        # Columns edit the first reference of each type; the retained list keeps
        # additional references and original display order. Omitted columns do
        # not delete references; an explicitly emptied column removes its slot.
        for kind in ("image", "floor", "video", "vr", "checkin"):
            if kind + "_id" not in values:
                continue
            index = next((index for index, item in enumerate(refs) if item["type"] == kind), None)
            candidate = {"type": kind, "id": identity(values, kind + "_id"), "revision": integer(values, kind + "_revision")} if values.get(kind + "_id") else None
            if index is not None:
                if candidate is None:
                    del refs[index]
                else:
                    refs[index] = candidate
            elif candidate:
                refs.append(candidate)
        stop["segments"][segment_order] = {"id": values.get("segment_id") or str(uuid5(NAMESPACE_URL, job.id + ":" + str(number))), "title": values.get("segment_title", ""), "text": values.get("text", ""), "source_note": values.get("segment_source", ""), "main_view": main, "resources": refs, "observation_prompt": values.get("observation_prompt", ""), "takeaway": values.get("takeaway", "")}
    if sorted(stops) != list(range(1, len(stops) + 1)):
        raise DomainError("IMPORT_ORDER", "站次应从1开始连续排列", 422)
    ordered = []
    for order in sorted(stops):
        stop = stops[order]
        parts = stop["segments"]
        if 0 in parts:
            ordered.append({**stop, "segments": None})
            continue
        if sorted(parts) != list(range(1, len(parts) + 1)):
            raise DomainError("IMPORT_ORDER", "每站段序应从1开始连续排列", 422)
        ordered.append({**stop, "segments": [parts[key] for key in sorted(parts)]})
    return {**base, "stops": ordered}


def commands_and_report(db, actor, job, settings):
    actor.require("points.edit")
    validate_mapping(job, job.mapping)
    groups = {}
    for row in job.rows:
        values = {destination: literal_cell(row["values"].get(source, "")) for source, destination in job.mapping.items()}
        from app.modules.imports.references import binding_values

        try:
            for binding in row.get("_references", {}).values():
                values.update(binding_values(db, actor, job.kind, binding, settings))
        except DomainError as exc:
            values["_binding_error"] = exc
        group = (values.get("batch_key") or values.get("id") or "default") if job.kind == "tour" else str(row["row"])
        groups.setdefault(group, []).append((row["row"], values))
    commands, report, targets = [], [], set()
    for rows in groups.values():
        numbers, values = [number for number, _ in rows], rows[0][1]
        title = values.get("name") or values.get("title") or "未命名资料"
        try:
            if values.get("export_schema"):
                if values["export_schema"] != EXPORT_SCHEMA:
                    raise DomainError("IMPORT_EXPORT_VERSION", "导出表格格式版本不支持，请用当前后台重新导出", 422)
                if set(COLUMNS[job.kind]) - set(values):
                    raise DomainError("IMPORT_PRESERVED_DATA", "导出表格的资料或保留列未完整映射；为防丢失本批不能确认", 422)
                if job.kind == "point" and not values.get("aliases_json"):
                    raise DomainError("IMPORT_PRESERVED_DATA", "地点的别名保留数据被清空，请恢复原导出", 422)
                if job.kind == "tour":
                    for _, candidate in rows:
                        mode = candidate.get("row_type")
                        if (not candidate.get("tour_settings") or (mode != "empty" and not candidate.get("stop_settings"))
                                or (mode == "segment" and not candidate.get("resources_json"))):
                            raise DomainError("IMPORT_PRESERVED_DATA", "路线保留数据被清空，请恢复原导出或使用后台表单修改", 422)
            for _, candidate in rows:
                if "_binding_error" in candidate:
                    raise candidate["_binding_error"]
            if job.kind == "point":
                command = point_command(db, actor, values)
            elif job.kind == "vr":
                command = resource_command(db, actor, values, settings)
            elif job.kind == "media":
                content = {"kind": "media", "point_id": identity(values, "point_id"), "title": values.get("title", ""), "description": values.get("description", ""), "source_note": values.get("source_note", ""), "media_type": values.get("media_type", ""), "upload_id": identity(values, "upload_id", optional=True), "url": values.get("url") or None, "alternative_text": values.get("alternative_text", ""), "transcript": values.get("transcript", "")}
                for key in ("caption_upload_id", "caption_language", "caption_label"):
                    if key in values:
                        content[key] = identity(values, key, optional=True) if key == "caption_upload_id" else values[key] or ("zh-CN" if key == "caption_language" else "中文字幕")
                for key in ("video_visual_information", "video_accessibility_note", "audio_description_video_id", "audio_description_video_revision"):
                    if key in values:
                        content[key] = (identity(values, key, optional=True) if key == "audio_description_video_id"
                            else integer(values, key) if key == "audio_description_video_revision" and values[key]
                            else None if key == "audio_description_video_revision"
                            else values[key] or ("unassessed" if key == "video_visual_information" else ""))
                command = experience_command(db, actor, values, content, settings)
            else:
                content = tour_content(job, rows)
                require_campus(db, content["campus_id"])
                require_campus_scope(db, actor, content["campus_id"])
                command = experience_command(db, actor, values, content, settings)
            target = (command["kind"], command["id"])
            if command["id"] and target in targets:
                raise DomainError("IMPORT_DUPLICATE", "同一记录不能在一批中重复更新", 422)
            targets.add(target)
            command["rows"] = numbers
            before, after = None, None
            if command["id"]:
                if command["kind"] == "experience":
                    record = db.get(ExperienceRecord, command["id"])
                    before = stored_content(record, record.draft or record.published).model_dump(mode="json")
                    after = command["payload"]["content"]
                elif command["kind"] == "vr":
                    record = db.get(ResourceChangeRecord, command["id"])
                    before = record.payload if record else None
                    after = {key: value for key, value in command["payload"].items() if key not in {"expected_revision", "expected_published_revision", "operation_id"}}
                else:
                    record = db.get(PointChangeRecord, command["id"])
                    before = record.payload if record else None
                    after = {key: value for key, value in command["payload"].items() if key not in {"expected_revision", "expected_point_revision", "operation_id"}}
            command["skip"] = before is not None and before == after
            changed = sorted(key for key in set(before or {}) | set(after or {}) if (before or {}).get(key) != (after or {}).get(key)) if command["id"] else []
            commands.append(command)
            action = "skip" if command["skip"] else "update" if command["id"] else "create"
            message = "内容一致，将跳过此记录" if command["skip"] else "检查通过；确认后仅生成草稿"
            if job.kind == "tour" and action == "update":
                message = "将按表格替换整条路线的站点与段落；保留未列出的封面和展示设置，仅保存草稿"
            report.append({"rows": numbers, "title": title, "action": action, "code": "", "message": message, "fields": changed})
        except ValidationError as exc:
            fields = [".".join(map(str, error["loc"])) for error in exc.errors()]
            report.append({"rows": numbers, "title": title, "action": "error", "code": "VALIDATION_ERROR", "message": "字段格式不符合要求，请对照模板修改", "fields": fields})
        except DomainError as exc:
            report.append({"rows": numbers, "title": title, "action": "error", "code": exc.code, "message": exc.message, "fields": []})
    return commands, report


def preview_digest(job, commands, report):
    return sha(canonical({"source": job.source_sha256, "mapping": job.mapping, "commands": commands, "report": report}))
