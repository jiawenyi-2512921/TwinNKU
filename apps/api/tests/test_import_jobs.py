"""Real API checks for bounded parsing, private preflight and atomic draft imports."""

import csv
import hashlib
import io
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_admin import login, seed_staff
from test_resources import make_resource_point

from app.core.errors import DomainError
from app.import_models import ImportJob
from app.models import ExperienceRecord, PointRecord, ResourceChangeRecord
from app.modules.imports import router as importer


@pytest.fixture
def imports(client, db, tmp_path):
    users, map_record = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "import-fixture"
    point = make_resource_point(db)
    login(client)
    return users, map_record, point


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8-sig")


def upload(client, kind, rows, operation=None):
    body = csv_bytes(rows)
    return client.post("/api/v1/admin/import-jobs", params={"kind": kind, "file_type": "csv", "operation_id": operation or str(uuid4()), "source_sha256": hashlib.sha256(body).hexdigest(), "filename": "test.csv"}, content=body, headers={"Content-Type": "text/csv"})


def commit(client, item, operation=None):
    return client.post(f"/api/v1/admin/import-jobs/{item['id']}/commit", json={"expected_preview_sha256": item["preview_sha256"], "operation_id": operation or str(uuid4())})


def vr(point, title="测试VR"):
    return {"point_id": point.id, "title": title, "url": "https://example.com/panorama?scene=1", "source_note": "测试夹具公开来源"}


def test_vr_check_writes_no_business_and_commit_is_private_idempotent(client, db, imports):
    _, _, point = imports
    op = str(uuid4())
    response = upload(client, "vr", [vr(point), vr(point, "第二场景")], op)
    assert response.status_code == 201, response.text
    item = response.json()["data"]
    assert [row["action"] for row in item["preview"]] == ["create", "create"]
    assert db.scalar(select(ResourceChangeRecord)) is None
    assert upload(client, "vr", [vr(point), vr(point, "第二场景")], op).json()["data"]["id"] == item["id"]
    assert upload(client, "vr", [vr(point)], op).status_code == 409
    commit_op = str(uuid4())
    result = commit(client, item, commit_op)
    assert result.status_code == 200, result.text
    actual = result.json()["data"]
    assert actual["state"] == "committed" and len(actual["result"]) == 2
    assert commit(client, item, commit_op).json()["data"] == actual
    drafts = db.scalars(select(ResourceChangeRecord)).all()
    assert len(drafts) == 2 and all(row.state == "draft" for row in drafts)
    assert db.get(ImportJob, item["id"]).rows == []
    login(client, "admin")
    assert client.get(f"/api/v1/admin/import-jobs/{item['id']}").status_code == 404
    assert client.get("/api/v1/admin/import-jobs", params={"operation_id": op}).json()["data"] == []


def test_one_bad_row_blocks_entire_batch_and_reports_actual_line(client, db, imports):
    _, _, point = imports
    response = upload(client, "vr", [vr(point), {**vr(point), "url": "http://127.0.0.1/"}])
    item = response.json()["data"]
    assert item["preview"][1]["action"] == "error"
    assert item["preview"][1]["rows"] == [3]
    assert commit(client, item).status_code == 409
    assert db.scalar(select(ResourceChangeRecord)) is None


def test_failure_after_first_save_rolls_back_all_drafts_and_audit(client, db, imports, monkeypatch):
    _, _, point = imports
    item = upload(client, "vr", [vr(point), vr(point, "第二场景")]).json()["data"]
    original = importer.resources._save_resource
    calls = []

    def fail_second(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise DomainError("TEST_CONFLICT", "测试并发冲突", 409)
        return original(*args, **kwargs)

    monkeypatch.setattr(importer.resources, "_save_resource", fail_second)
    assert commit(client, item).status_code == 409
    assert len(calls) == 2 and db.scalar(select(ResourceChangeRecord)) is None
    assert db.get(ImportJob, item["id"]).state == "checked"


def test_commit_rechecks_current_scope(client, db, imports):
    users, _, point = imports
    item = upload(client, "vr", [vr(point)]).json()["data"]
    users["editor"].campus_ids = []
    db.commit()
    assert commit(client, item).status_code in {403, 409}
    assert db.scalar(select(ResourceChangeRecord)) is None


def test_tour_rows_preserve_repeated_places_and_explicit_order(client, db, imports):
    _, _, point = imports
    base = {"batch_key": "route-a", "campus_id": point.campus_id, "title": "测试路线", "source_note": "测试夹具", "point_id": point.id, "stop_order": "1", "segment_order": "1", "text": "第一段"}
    rows = [base, {**base, "segment_order": "2", "text": "第二段"}, {**base, "stop_order": "2", "text": "重复地点另一次参观"}]
    checked = upload(client, "tour", rows)
    assert checked.status_code == 201, checked.text
    item = checked.json()["data"]
    assert item["preview"][0]["action"] == "create", item
    saved = commit(client, item)
    assert saved.status_code == 200, saved.text
    record = db.scalar(select(ExperienceRecord))
    assert record.state == "draft" and record.published is None
    assert len(record.draft["stops"]) == 2
    ids = [part["id"] for stop in record.draft["stops"] for part in stop["segments"]]
    assert len(set(ids)) == 3


def test_point_and_media_templates_create_only_valid_scoped_drafts(client, db, imports):
    _, map_record, point = imports
    values = {"campus_id": point.campus_id, "name": "导入测试景点", "category": "landscape", "source_note": "测试夹具", "map_id": map_record.id, "map_revision": "1", "x": "100", "y": "100", "polygon": "80,80;120,80;120,120;80,120", "label_on_map": "否"}
    item = upload(client, "point", [values]).json()["data"]
    assert item["preview"][0]["action"] == "create", item
    assert commit(client, item).status_code == 200
    created = db.scalar(select(PointRecord).where(PointRecord.name == values["name"]))
    assert created.status == "draft"
    media = {"point_id": point.id, "title": "图片资料", "media_type": "image", "url": "https://example.com/photo.png", "source_note": "测试夹具", "alternative_text": "测试图片说明"}
    item = upload(client, "media", [media]).json()["data"]
    saved = commit(client, item)
    assert saved.status_code == 200, saved.text
    assert db.scalar(select(ExperienceRecord)).draft["alternative_text"] == "测试图片说明"


def test_column_mapping_and_formula_safe_error_export(client, db, imports):
    _, _, point = imports
    rows = [{"场景标题": "测试场景", "地点": point.id, "网址": "https://example.com/view", "来源": "测试夹具"}]
    item = upload(client, "vr", rows).json()["data"]
    assert item["preview"][0]["code"] == "IMPORT_MAPPING"
    response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/mapping", json={"expected_preview_sha256": item["preview_sha256"], "mapping": {"场景标题": "title", "地点": "point_id", "网址": "url", "来源": "source_note"}})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["preview"][0]["action"] == "create"
    job = db.get(ImportJob, item["id"])
    job.preview = [{**job.preview[0], "title": "=HYPERLINK(1)"}]
    db.commit()
    exported = client.get(f"/api/v1/admin/import-jobs/{item['id']}/report.csv")
    assert "'=HYPERLINK" in exported.content.decode("utf-8-sig")
    login(client, "viewer")
    assert client.get("/api/v1/admin/import-templates/point").status_code == 403


def test_recheck_prevents_stale_update_and_noop_skips_revision(client, db, imports):
    _, _, point = imports
    initial = upload(client, "vr", [vr(point)]).json()["data"]
    first = commit(client, initial).json()["data"]
    key = first["result"][0]["id"]
    change = db.get(ResourceChangeRecord, key)
    rows = [{**vr(point), "id": key, "expected_revision": str(change.revision), "expected_published_revision": "0"}]
    same = upload(client, "vr", rows).json()["data"]
    assert same["preview"][0]["action"] == "skip", same
    revision = change.revision
    assert commit(client, same).status_code == 200
    assert db.get(ResourceChangeRecord, key).revision == revision
    rows[0]["title"] = "导入的新名称"
    checked = upload(client, "vr", rows).json()["data"]
    change.revision += 1
    db.commit()
    assert commit(client, checked).status_code == 409
    assert db.get(ResourceChangeRecord, key).payload["content"]["title"] == "测试VR"


def test_xlsx_reaches_real_private_check_endpoint(client, db, imports):
    from xml.sax.saxutils import escape

    from test_import_parser import MAIN, workbook

    _, _, point = imports
    values = vr(point)
    xml_rows = []
    for number, row in enumerate((list(values), list(values.values())), 1):
        cells = "".join(f'<c r="{chr(65 + column)}{number}" t="inlineStr"><is><t>{escape(value)}</t></is></c>' for column, value in enumerate(row))
        xml_rows.append(f'<row r="{number}">{cells}</row>')
    data = workbook(sheet=f'<worksheet xmlns="{MAIN[1:-1]}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
    result = client.post("/api/v1/admin/import-jobs", params={"kind": "vr", "file_type": "xlsx", "operation_id": str(uuid4()), "source_sha256": hashlib.sha256(data).hexdigest(), "filename": "test.xlsx"}, content=data)
    assert result.status_code == 201, result.text
    assert result.json()["data"]["preview"][0]["action"] == "create"
    assert db.scalar(select(ResourceChangeRecord)) is None
