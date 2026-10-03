"""VR drafts and independent, point-bound manual evidence over actual HTTP."""

from importlib import import_module
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, func, select, text
from test_admin import BASE, login
from test_experiences import content, publish, upload
from test_resources import action, image_bytes, make_resource_point, save
from test_resources import resources as resources

from app.models import (
    AdminAuditRecord,
    ExperienceRecord,
    PanoramaRecord,
    PanoramaVerificationRecord,
)


def vr(**values):
    return {"kind": "panorama", "title": "原始景点名", "url": "https://example.com/tour?scene=0138&language=zh", **values}


def publish_vr(client, point, values=None, previous=None):
    login(client)
    item = save(client, point, values or vr(), previous, expected=200 if previous else 201)
    submitted = action(client, item, "submit")
    login(client, "reviewer")
    return action(client, submitted, "publish")


def checks_path(item):
    return f"{BASE}/resources/{item['id']}/vr-checks"


def manual(client, item, expected=201, **values):
    body = {"operation_id": str(uuid4()), "expected_revision": item["draft"]["revision"],
            "expected_published_revision": item["published_revision"], "dimension": "technical",
            "result": "passed", **values}
    response = client.post(checks_path(item), json=body)
    assert response.status_code == expected, response.text
    return response, body


def public(client, point):
    response = client.get(f"/api/v1/points/{point.id}/panoramas")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_reviewed_vr_fields_preserve_original_and_draft_isolation(client, db, resources):
    _, point = resources
    login(client)
    item = save(client, point, vr(observation_prompt="观察真实场景中的标注", sort_order=8))
    assert public(client, point) == []
    item = action(client, item, "submit")
    action(client, item, "publish", expected=403)
    login(client, "reviewer")
    item = action(client, item, "publish")
    assert public(client, point)[0]["observation_prompt"] == "观察真实场景中的标注"
    login(client)
    item = save(client, point, vr(observation_prompt="新稿提示", sort_order=2), item, expected=200)
    old = public(client, point)[0]
    assert old["title"] == "原始景点名" and old["url"] == vr()["url"]
    assert old["sort_order"] == 8 and old["observation_prompt"] != "新稿提示"
    assert old["cover_image_url"] is None
    assert old["checks"]["technical"]["result"] == "unchecked"


@pytest.mark.parametrize("values", [
    {"cover_image_id": str(uuid4())}, {"cover_image_revision": 1},
    {"sort_order": -1}, {"sort_order": 10001}, {"observation_prompt": "长" * 1001},
])
def test_vr_field_bounds_and_complete_cover(client, resources, values):
    _, point = resources
    login(client)
    save(client, point, vr(**values), expected=422)


def test_cover_same_point_exact_formal_revision_and_withdrawal_fallback(client, db, resources):
    _, point = resources
    image = publish(client, content(point))
    cover = {"cover_image_id": image["id"], "cover_image_revision": image["published_revision"]}
    item = publish_vr(client, point, vr(**cover))
    cover_url = public(client, point)[0]["cover_image_url"]
    assert f"/panoramas/{item['id']}/cover/1/{image['id']}/1" in cover_url
    response = client.get(cover_url, follow_redirects=False)
    assert response.status_code == 307 and response.headers["location"] == "https://example.com/test.png"
    login(client)
    save(client, make_resource_point(db), vr(**cover), expected=409)
    save(client, point, vr(**{**cover, "cover_image_revision": 2}), expected=409)
    record = db.get(ExperienceRecord, image["id"])
    record.status = "retired"
    db.commit()
    value = public(client, point)[0]
    assert value["id"] == item["id"] and value["url"] == vr()["url"]
    assert value["cover_image_url"] is None
    assert client.get(cover_url, follow_redirects=False).status_code in {404, 409}
    save(client, point, vr(**cover), expected=409)


def test_cover_rechecked_during_publication(client, db, resources):
    _, point = resources
    image = publish(client, content(point))
    login(client)
    item = action(client, save(client, point, vr(cover_image_id=image["id"], cover_image_revision=1)), "submit")
    record = db.get(ExperienceRecord, image["id"])
    record.published_revision += 1
    db.commit()
    login(client, "reviewer")
    action(client, item, "publish", expected=409)
    assert public(client, point) == []


def test_owned_cover_bytes_pin_both_resource_versions_and_public_point(client, db, resources):
    _, point = resources
    login(client)
    original = upload(client, point)
    image = publish(client, content(point, upload_id=original["id"], url=None))
    item = publish_vr(client, point, vr(cover_image_id=image["id"], cover_image_revision=1))
    path = public(client, point)[0]["cover_image_url"]
    response = client.get(path)
    assert response.status_code == 200 and response.content == image_bytes()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get(path.replace("/cover/1/", "/cover/2/")).status_code == 404
    assert client.get(path[:-1] + "2").status_code == 404
    point.visibility = "internal"
    db.commit()
    assert client.get(path).status_code == 404
    point.visibility = "public"
    db.commit()
    client.app.state.settings.vr_enabled = False
    assert client.get(path).status_code == 404
    client.app.state.settings.vr_enabled = True
    db.get(PanoramaRecord, item["id"]).revision += 1
    db.commit()
    assert client.get(path).status_code == 404


def test_manual_checks_are_independent_scoped_and_private(client, db, resources):
    users, point = resources
    item = publish_vr(client, point)
    before = item["draft"].copy()
    client.cookies.clear()
    assert client.get(checks_path(item)).status_code == 401
    login(client, "viewer")
    manual(client, item, expected=403)
    login(client, "reviewer")
    row, _ = manual(client, item, notes="内部核查备注，不得公开", environment="私有浏览器信息")
    assert row.json()["data"]["method"] == "manual" and not row.json()["data"]["stale"]
    detail = client.get(f"{BASE}/resources/{item['id']}").json()["data"]
    assert detail["draft"] == before
    assert detail["published_revision"] == item["published_revision"]
    record = public(client, point)[0]
    assert record["checks"]["technical"]["result"] == "passed"
    assert record["checks"]["scene"]["result"] == "unchecked" and record["checks"]["devices"] == {}
    serialized = str(record)
    for private in ("内部核查备注", "私有浏览器信息", users["reviewer"].id, "recorded_by", "url_sha256", "operation_id"):
        assert private not in serialized
    users["reviewer"].campus_ids = ["nku-balitai"]
    db.commit()
    assert client.get(checks_path(item)).status_code == 404
    manual(client, item, expected=404)


@pytest.mark.parametrize("values", [
    {"dimension": "technical", "platform": "ios"},
    {"dimension": "device", "platform": "android"},
    {"result": "passed", "reason": "network_unavailable"},
    {"result": "failed", "reason": "none"},
    {"dimension": "scene", "result": "failed", "reason": "network_unavailable"},
    {"notes": "invisible\u202econtrol"}, {"environment": "bad\x00text"},
    {"notes": "x" * 1001}, {"url": "http://127.0.0.1/"},
    {"recorded_at": "2099-01-01T00:00:00Z"},
])
def test_manual_evidence_validated_not_arbitrary_probe(client, resources, values):
    _, point = resources
    item = publish_vr(client, point)
    manual(client, item, expected=422, **values)


def test_manual_exact_version_and_idempotent_replay(client, db, resources):
    _, point = resources
    item = publish_vr(client, point)
    manual(client, item, expected=409, expected_revision=0)
    response, body = manual(client, item)
    operation_path = checks_path(item) + "/operations/" + body["operation_id"]
    assert client.get(operation_path).json()["data"] == response.json()["data"]
    assert client.get(checks_path(item) + "/operations/" + str(uuid4())).json()["data"] is None
    repeated = client.post(checks_path(item), json=body)
    assert repeated.status_code == 201 and repeated.json()["data"] == response.json()["data"]
    assert db.scalar(select(func.count()).select_from(PanoramaVerificationRecord)) == 1
    assert db.scalar(select(func.count()).select_from(AdminAuditRecord).where(AdminAuditRecord.action == "vr.manual_check_recorded")) == 1
    changed = client.post(checks_path(item), json={**body, "notes": "另一个载荷"})
    assert changed.status_code == 409
    login(client)
    assert client.get(operation_path).json()["data"] is None
    assert client.post(checks_path(item), json=body).status_code == 409


def test_link_generation_draft_and_change_back_never_revive_old_evidence(client, db, resources):
    _, point = resources
    item = publish_vr(client, point)
    manual(client, item)
    login(client)
    new = save(client, point, vr(url="https://example.com/tour?scene=0250"), item, expected=200)
    old = client.get(checks_path(new)).json()["data"]["items"]
    assert old[0]["stale"]
    # Evidence of the saved next URL stays private until that exact URL is independently published.
    manual(client, new, dimension="scene")
    assert public(client, point)[0]["checks"]["technical"]["result"] == "passed"
    submitted = action(client, new, "submit")
    login(client, "reviewer")
    item = action(client, submitted, "publish")
    assert db.get(PanoramaRecord, item["id"]).verification_generation == 2
    current = public(client, point)[0]["checks"]
    assert current["technical"]["result"] == "unchecked" and current["scene"]["result"] == "passed"
    item = publish_vr(client, point, vr(), item)
    assert db.get(PanoramaRecord, item["id"]).verification_generation == 3
    assert public(client, point)[0]["checks"]["technical"]["result"] == "unchecked"
    assert all(row["stale"] for row in client.get(checks_path(item)).json()["data"]["items"])


def test_dimensions_and_all_four_devices_remain_independent(client, resources):
    _, point = resources
    item = publish_vr(client, point)
    manual(client, item)
    manual(client, item, result="failed", reason="upstream_unavailable")
    manual(client, item, dimension="scene", result="uncertain", reason="visual_not_checked")
    for platform in ("desktop", "android", "ios", "wechat"):
        manual(client, item, dimension="device", platform=platform, environment="人工使用测试设备检查",
               result="passed" if platform == "desktop" else "failed",
               reason="none" if platform == "desktop" else "device_failure")
    value = public(client, point)[0]
    assert value["url"] == vr()["url"]
    assert value["checks"]["technical"]["result"] == "failed"
    assert value["checks"]["scene"]["result"] == "uncertain"
    assert len(value["checks"]["devices"]) == 4
    assert value["checks"]["devices"]["desktop"]["result"] == "passed"
    assert value["checks"]["devices"]["ios"]["result"] == "failed"
    assert all(check["method"] == "manual" and check["recorded_at"] for check in value["checks"]["devices"].values())
    overview = client.get(checks_path(item) + "?limit=1").json()["data"]
    assert len(overview["items"]) == 1 and overview["has_more"]
    assert len(overview["latest"]) == 6  # Summary cannot lose dimensions outside the history page.


def test_public_directory_order_pagination_and_public_parent(client, db, resources):
    _, point = resources
    a = publish_vr(client, point, vr(title="Z原名", sort_order=1))
    b = publish_vr(client, point, vr(title="A原名", sort_order=9))
    path = f"/api/v1/campuses/{point.campus_id}/panoramas?page_size=1"
    assert client.get(path).json()["data"][0]["id"] == a["id"]
    assert client.get(path + "&page=2").json()["data"][0]["id"] == b["id"]
    point.visibility = "internal"
    db.commit()
    assert client.get(path).json()["data"] == []


def test_vr_migration_preserves_existing_original_fields_and_downgrades():
    engine = create_engine("sqlite://")
    migration = import_module("migrations.versions.0019_vr_checks")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE panoramas(id VARCHAR(36) PRIMARY KEY, title TEXT, url TEXT, description TEXT)"))
        connection.execute(text("CREATE TABLE points(id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE staff_users(id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("INSERT INTO panoramas VALUES('original', '原始名称', 'https://example.com/?scene=0138&x=1', '原始说明')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            row = connection.execute(text("SELECT title,url,description,observation_prompt,sort_order,verification_generation FROM panoramas")).one()
            assert tuple(row) == ("原始名称", "https://example.com/?scene=0138&x=1", "原始说明", "", 0, 1)
            migration.downgrade()
        assert connection.execute(text("SELECT title,url,description FROM panoramas")).one() == tuple(row[:3])
    engine.dispose()
