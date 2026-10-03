"""Scoped real HTTP export/selection and reimport without silent data loss."""

import hashlib
from uuid import uuid4

import pytest
from test_admin import content as point_content
from test_admin import login, seed_staff
from test_experiences import content, publish, save
from test_import_jobs import commit, upload, vr
from test_resources import make_resource_point

from app.models import ExperienceRecord, PointChangeRecord, ResourceChangeRecord
from app.modules.imports.service import COLUMNS, literal_cell, safe_csv_cell


@pytest.fixture
def imports(client, db, tmp_path):
    users, map_record = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "exports"
    point = make_resource_point(db)
    login(client)
    return users, map_record, point


def exported(client, kind, key, campus="nku-jinnan"):
    preview = client.get(f"/api/v1/admin/import-exports/{kind}/preview", params={"campus_id": campus, "ids": key})
    assert preview.status_code == 200, preview.text
    manifest = preview.json()["data"]
    result = client.get(f"/api/v1/admin/import-exports/{kind}", params={"campus_id": campus, "ids": key, "expected_sha256": manifest["sha256"]})
    assert result.status_code == 200, result.text
    assert hashlib.sha256(result.content).hexdigest() == manifest["sha256"]
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    return result.content, manifest


def upload_body(client, kind, body):
    result = client.post("/api/v1/admin/import-jobs", params={"kind": kind, "file_type": "csv", "operation_id": str(uuid4()), "source_sha256": hashlib.sha256(body).hexdigest(), "filename": "roundtrip.csv"}, content=body)
    assert result.status_code == 201, result.text
    return result.json()["data"]


def test_vr_export_preserves_stable_identity_cas_and_formula_literal(client, db, imports):
    _, _, point = imports
    item = upload(client, "vr", [vr(point)]).json()["data"]
    key = commit(client, item).json()["data"]["result"][0]["id"]
    draft = db.get(ResourceChangeRecord, key)
    draft.payload = {**draft.payload, "content": {**draft.payload["content"], "title": "=HYPERLINK(1)", "description": "'=原始单引号\n@正文"}}
    db.commit()
    before = draft.revision
    body, manifest = exported(client, "vr", key)
    assert manifest["record_count"] == manifest["row_count"] == 1 and manifest["warnings"] == []
    assert "'=HYPERLINK" in body.decode("utf-8-sig")
    checked = upload_body(client, "vr", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    assert db.get(ResourceChangeRecord, key).revision == before
    assert db.get(ResourceChangeRecord, key).payload["content"]["title"] == "=HYPERLINK(1)"


def test_vr_display_fields_export_roundtrip_and_legacy_omission_do_not_clear_cover(client, db, imports):
    _, _, point = imports
    image = publish(client, content(point))
    login(client)
    values = {**vr(point), "observation_prompt": "'=保留观察提示", "sort_order": "27",
              "cover_image_id": image["id"], "cover_image_revision": str(image["published_revision"])}
    checked = upload(client, "vr", [values]).json()["data"]
    key = commit(client, checked).json()["data"]["result"][0]["id"]
    before = db.get(ResourceChangeRecord, key).revision
    body, _ = exported(client, "vr", key)
    checked = upload_body(client, "vr", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    draft = db.get(ResourceChangeRecord, key)
    assert draft.revision == before
    assert (draft.payload["content"]["observation_prompt"], draft.payload["content"]["sort_order"]) == ("=保留观察提示", 27)
    # An old manually prepared table changes its title but does not silently
    # erase presentation fields it never mapped.
    checked = upload(client, "vr", [{**vr(point, "修改名称"), "id": key, "expected_revision": str(before), "expected_published_revision": "0"}]).json()["data"]
    assert commit(client, checked).status_code == 200
    draft = db.get(ResourceChangeRecord, key)
    assert draft.payload["content"]["cover_image_id"] == image["id"]
    assert draft.payload["content"]["cover_image_revision"] == image["published_revision"]
    assert draft.payload["content"]["sort_order"] == 27


def test_vr_cover_choice_is_same_point_and_rechecked_at_commit(client, db, imports):
    _, _, point = imports
    other = make_resource_point(db)
    wrong = publish(client, content(other))
    image = publish(client, content(point))
    login(client)
    item = upload(client, "vr", [vr(point)]).json()["data"]

    def select_cover(record):
        response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={
            "expected_preview_sha256": item["preview_sha256"],
            "bindings": [{"rows": [2], "field": "cover_image_id", "kind": "image", "id": record["id"], "revision": record["published_revision"]}]})
        assert response.status_code == 200, response.text
        return response.json()["data"]

    item = select_cover(wrong)
    assert item["preview"][0]["action"] == "error"
    assert commit(client, item).status_code == 409
    item = select_cover(image)
    assert item["preview"][0]["action"] == "create"
    record = db.get(ExperienceRecord, image["id"])
    record.published_revision += 1
    db.commit()
    assert commit(client, item).status_code == 409
    assert db.query(ResourceChangeRecord).count() == 0


@pytest.mark.parametrize("values", [
    {"cover_image_id": str(uuid4())}, {"cover_image_revision": "1"},
    {"sort_order": "10001"}, {"observation_prompt": "x" * 1001},
])
def test_vr_new_fields_incomplete_or_out_of_bounds_block_private_import(client, db, imports, values):
    _, _, point = imports
    item = upload(client, "vr", [{**vr(point), **values}]).json()["data"]
    assert item["preview"][0]["action"] == "error"
    assert commit(client, item).status_code == 409
    assert db.query(ResourceChangeRecord).count() == 0


def test_point_export_roundtrip_keeps_aliases_geometry_boolean_and_zero(client, db, imports):
    _, map_record, _ = imports
    data = {**point_content(map_record), "aliases": ["甲|乙", "单独别名"], "summary": "+这是一段文字"}
    data["geometry"]["anchor"] = {"x": 0, "y": 0}
    data["geometry"]["label_on_map"] = False
    response = client.post("/api/v1/admin/points", json=data)
    assert response.status_code == 201, response.text
    key = response.json()["data"]["point"]["id"]
    body, _ = exported(client, "point", key)
    checked = upload_body(client, "point", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    assert db.get(PointChangeRecord, key).payload["aliases"] == ["甲|乙", "单独别名"]
    assert db.get(PointChangeRecord, key).payload["geometry"]["anchor"] == {"x": 0, "y": 0}


def test_tour_roundtrip_multiple_same_type_resources_order_display_and_legacy_trigger(client, db, imports):
    _, _, point = imports
    a = publish(client, content(point, title="第一张素材"))
    b = publish(client, content(point, title="第二张素材", url="https://example.com/second.png"))
    login(client)
    route = save(client, content(point, "tour", lead="路线导语", outcomes=["观察"], sort_order=7,
        cover_focus={"x": 0.25, "y": 0.75}, stops=[{"point_id": point.id, "title": None, "narrative": "旧叙述完整保留",
            "prompt_timing": "after_intro", "legacy_media_compat": True,
            "segments": [{"id": "stable-first", "title": "段落标题", "text": "原文", "source_note": "原出处",
                "resources": [{"type": "image", "id": b["id"], "revision": b["published_revision"]}, {"type": "image", "id": a["id"], "revision": a["published_revision"]}]}]}]))
    body, manifest = exported(client, "tour", route["id"])
    assert manifest["row_count"] == 1
    checked = upload_body(client, "tour", body)
    assert checked["preview"][0]["action"] == "skip", checked
    original = db.get(ExperienceRecord, route["id"]).draft
    assert commit(client, checked).status_code == 200
    assert db.get(ExperienceRecord, route["id"]).draft == original


@pytest.mark.parametrize("stops", [[], "legacy"])
def test_empty_and_legacy_route_export_reimports_exact_shape(client, db, imports, stops):
    _, _, point = imports
    stops = [] if stops == [] else [{"point_id": point.id, "narrative": "原单段讲解", "prompt_timing": "on_arrival"}]
    route = save(client, content(point, "tour", stops=stops))
    body, _ = exported(client, "tour", route["id"])
    checked = upload_body(client, "tour", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    actual = db.get(ExperienceRecord, route["id"])
    assert actual.revision == route["revision"]
    if stops:
        assert actual.draft["stops"][0]["segments"] is None


def test_export_scope_and_catalog_are_current_no_count_or_selection_leak(client, db, imports):
    users, _, permitted = imports
    hidden = make_resource_point(db)
    hidden.name = "不能泄露的地点名"
    users["editor"].point_ids = [permitted.id]
    db.commit()
    refs = client.get("/api/v1/admin/import-references", params={"kind": "point", "campus_id": permitted.campus_id}).json()
    assert refs["meta"]["pagination"]["total"] == 1
    assert "不能泄露" not in str(refs)
    assert client.get("/api/v1/admin/import-references", params={"kind": "vr", "point_id": hidden.id}).status_code == 404
    response = client.get("/api/v1/admin/import-exports/point", params={"campus_id": permitted.campus_id, "ids": hidden.id})
    assert response.status_code == 404 and "不能泄露" not in response.text
    login(client, "viewer")
    assert client.get("/api/v1/admin/import-exports/point", params={"campus_id": permitted.campus_id}).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/admin/import-references", params={"kind": "point"}).status_code == 401


def test_reference_selection_by_name_not_automatic_and_revision_rechecked(client, db, imports):
    users, _, point = imports
    duplicate = make_resource_point(db)
    assert duplicate.name == point.name
    refs = client.get("/api/v1/admin/import-references", params={"kind": "point", "q": point.name, "page_size": 100}).json()["data"]
    assert {item["id"] for item in refs} == {point.id, duplicate.id}
    checked = upload(client, "vr", [{**vr(point), "point_id": point.name}]).json()["data"]
    assert checked["preview"][0]["action"] == "error"  # No implicit same-name match.
    selected = client.post(f"/api/v1/admin/import-jobs/{checked['id']}/references", json={"expected_preview_sha256": checked["preview_sha256"],
        "bindings": [{"rows": [2], "field": "point_id", "kind": "point", "id": duplicate.id, "revision": duplicate.revision}]})
    assert selected.status_code == 200, selected.text
    selected = selected.json()["data"]
    assert selected["preview"][0]["action"] == "create"
    assert selected["reference_bindings"][0]["id"] == duplicate.id
    assert client.get(f"/api/v1/admin/import-jobs/{checked['id']}").json()["data"]["reference_bindings"] == selected["reference_bindings"]
    duplicate.revision += 1
    db.commit()
    assert commit(client, selected).status_code == 409
    assert db.query(ResourceChangeRecord).count() == 0


def test_reference_selection_scope_csrf_and_wrong_resource_type(client, db, imports):
    users, _, point = imports
    hidden = make_resource_point(db)
    users["editor"].point_ids = [point.id]
    db.commit()
    item = upload(client, "vr", [vr(point)]).json()["data"]
    url = f"/api/v1/admin/import-jobs/{item['id']}/references"
    body = {"expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "point_id", "kind": "point", "id": hidden.id, "revision": 1}]}
    assert client.post(url, json=body).status_code == 404
    body["bindings"][0]["id"] = point.id
    csrf = client.headers.pop("x-csrf-token")
    assert client.post(url, json=body).status_code == 403
    client.headers["x-csrf-token"] = csrf
    body["bindings"][0]["kind"] = "tour"
    assert client.post(url, json=body).status_code == 422


def test_export_preview_digest_rejects_changed_contents(client, db, imports):
    _, _, point = imports
    item = upload(client, "vr", [vr(point)]).json()["data"]
    key = commit(client, item).json()["data"]["result"][0]["id"]
    _, manifest = exported(client, "vr", key)
    draft = db.get(ResourceChangeRecord, key)
    draft.payload = {**draft.payload, "content": {**draft.payload["content"], "description": "已修改"}}
    db.commit()
    response = client.get("/api/v1/admin/import-exports/vr", params={"campus_id": point.campus_id, "ids": key, "expected_sha256": manifest["sha256"]})
    assert response.status_code == 409


def test_export_refuses_overflow_instead_of_truncating_route_rows(client, db, imports, monkeypatch):
    from app.modules.imports import export

    _, _, point = imports
    route = save(client, content(point, "tour", stops=[{"point_id": point.id, "segments": [{"id": "one", "text": "1"}, {"id": "two", "text": "2"}]}]))
    monkeypatch.setattr(export, "MAX_ROWS", 1)
    response = client.get("/api/v1/admin/import-exports/tour", params={"campus_id": point.campus_id, "ids": route["id"]})
    assert response.status_code == 413
    assert db.get(ExperienceRecord, route["id"]).draft["stops"][0]["segments"][1]["text"] == "2"


def test_preserved_unknown_fields_block_whole_import_and_formula_escape_is_reversible(client, db, imports):
    _, _, point = imports
    base = {"campus_id": point.campus_id, "title": "路线", "source_note": "来源", "stop_order": "1", "point_id": point.id, "segment_order": "1", "text": "内容", "tour_settings": '{"arbitrary_script":"run"}'}
    checked = upload(client, "tour", [base]).json()["data"]
    assert checked["preview"][0]["code"] == "IMPORT_PRESERVED_DATA"
    assert commit(client, checked).status_code == 409
    for value in ["=SUM(1)", " +内容", "'正常单引号", "'=字面量", "\t=1", "\ufeff=1", 0, False]:
        assert literal_cell(safe_csv_cell(value)) == str(value)
    assert len(COLUMNS["tour"]) <= 64


def test_history_source_missing_warns_instead_of_fabricating_or_overwriting(client, db, imports):
    _, _, point = imports
    from app.models import PanoramaRecord

    record = PanoramaRecord(id=str(uuid4()), point_id=point.id, title="历史全景", url="https://example.com/view", description="",
        status="published", revision=1)
    db.add(record)
    db.commit()
    body, manifest = exported(client, "vr", record.id)
    assert manifest["warnings"][0]["code"] == "SOURCE_REQUIRED"
    checked = upload_body(client, "vr", body)
    assert checked["preview"][0]["action"] == "error"
    assert commit(client, checked).status_code == 409


def test_catalog_public_filter_not_draft_title_attached_to_published_revision(client, db, imports):
    _, _, point = imports
    record = publish(client, content(point, title="已审核素材标题"))
    login(client)
    draft = save(client, content(point, title="未审核标题"), previous=record)
    catalog = client.get("/api/v1/admin/import-references", params={"kind": "image", "point_id": point.id}).json()["data"]
    assert len(catalog) == 1 and catalog[0]["title"] == "已审核素材标题"
    assert catalog[0]["revision"] == record["published_revision"]
    assert catalog[0]["draft_revision"] == draft["revision"]
    point.status = "retired"
    db.commit()
    assert client.get("/api/v1/admin/import-references", params={"kind": "image", "point_id": point.id}).json()["data"] == []


def test_media_caption_export_roundtrip_and_cross_point_rejected(client, db, imports):
    from test_accessible_resources import caption_upload

    _, _, point = imports
    caption = caption_upload(client, point)
    media = save(client, content(point, media_type="video", url="https://example.com/movie.mp4", transcript="完整稿",
        caption_upload_id=caption["id"], caption_language="en-US", caption_label="英文字幕"))
    body, _ = exported(client, "media", media["id"])
    checked = upload_body(client, "media", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    actual = db.get(ExperienceRecord, media["id"]).draft
    assert actual["caption_upload_id"] == caption["id"] and actual["caption_label"] == "英文字幕"
    other = make_resource_point(db)
    checked = upload(client, "media", [{"point_id": other.id, "title": "另一地点视频", "media_type": "video", "url": "https://example.com/other.mp4", "source_note": "真实来源须团队填写", "caption_upload_id": caption["id"]}]).json()["data"]
    assert checked["preview"][0]["action"] == "error"
    assert commit(client, checked).status_code == 409


def test_dropping_export_preservation_column_mapping_blocks_confirmation(client, db, imports):
    _, _, point = imports
    route = save(client, content(point, "tour", stops=[{"point_id": point.id, "narrative": "不能被隐藏列遗漏擦除", "prompt_timing": "after_intro"}]))
    body, _ = exported(client, "tour", route["id"])
    checked = upload_body(client, "tour", body)
    mapping = {key: value for key, value in checked["mapping"].items() if value != "stop_settings"}
    result = client.post(f"/api/v1/admin/import-jobs/{checked['id']}/mapping", json={"expected_preview_sha256": checked["preview_sha256"], "mapping": mapping})
    assert result.status_code == 200, result.text
    checked = result.json()["data"]
    assert checked["preview"][0]["code"] == "IMPORT_PRESERVED_DATA"
    assert commit(client, checked).status_code == 409
    assert db.get(ExperienceRecord, route["id"]).draft["stops"][0]["narrative"] == "不能被隐藏列遗漏擦除"


def test_export_rechecks_retained_cover_scope_before_counts_or_body(client, db, imports):
    users, _, point = imports
    other = make_resource_point(db)
    cover = publish(client, content(other, title="受限封面"))
    login(client)
    data = content(point, "tour", cover_image_id=cover["id"], cover_image_revision=cover["published_revision"], stops=[{"point_id": point.id, "narrative": "路线正文"}, {"point_id": other.id, "narrative": "原第二站"}])
    route = save(client, data)
    route = save(client, {**data, "stops": data["stops"][:1]}, previous=route)
    users["editor"].point_ids = [point.id]
    db.commit()
    response = client.get("/api/v1/admin/import-exports/tour/preview", params={"campus_id": point.campus_id, "ids": route["id"]})
    assert response.status_code == 404 and "受限封面" not in response.text
    response = client.get("/api/v1/admin/import-exports/tour/preview", params={"campus_id": point.campus_id})
    assert response.status_code == 200 and response.json()["data"]["record_count"] == 0


def test_selection_read_rechecks_revoked_scope_and_unrepresentable_export_fails(client, db, imports):
    users, _, point = imports
    item = upload(client, "vr", [vr(point)]).json()["data"]
    response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={"expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "point_id", "kind": "point", "id": point.id, "revision": 1}]})
    assert response.status_code == 200
    users["editor"].campus_ids = []
    db.commit()
    assert client.get(f"/api/v1/admin/import-jobs/{item['id']}").status_code == 404
    users["editor"].campus_ids = [point.campus_id]
    db.commit()
    draft = save(client, content(point, description="不能由数据解析器接受\x00"))
    response = client.get("/api/v1/admin/import-exports/media", params={"campus_id": point.campus_id, "ids": draft["id"]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "EXPORT_NOT_REPRESENTABLE"


def test_published_vr_catalog_and_tour_resource_choice_use_actual_supplier_free_revision(client, db, imports):
    from test_resources import action
    from test_resources import save as resource_save

    _, _, point = imports
    draft = resource_save(client, point, {"kind": "panorama", "title": "正式全景", "description": "场景", "url": "https://example.com/vr"})
    submitted = action(client, draft, "submit")
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    login(client)
    catalog = client.get("/api/v1/admin/import-references", params={"kind": "vr", "point_id": point.id}).json()["data"]
    assert len(catalog) == 1 and catalog[0]["revision"] == published["published_revision"]
    row = {"campus_id": point.campus_id, "title": "导入路线", "source_note": "测试夹具", "stop_order": "1", "segment_order": "1", "point_id": point.id, "text": "正文"}
    item = upload(client, "tour", [row]).json()["data"]
    response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={"expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "main_id", "kind": "vr", "id": catalog[0]["id"], "revision": catalog[0]["revision"]}]})
    assert response.status_code == 200, response.text
    selected = response.json()["data"]
    saved = commit(client, selected)
    assert saved.status_code == 200, saved.text
    route = db.get(ExperienceRecord, saved.json()["data"]["result"][0]["id"])
    assert route.draft["stops"][0]["segments"][0]["main_view"] == {"type": "vr_entry", "id": catalog[0]["id"], "revision": catalog[0]["revision"], "section_id": None}
