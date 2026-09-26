"""Authorization and public/draft isolation through the real HTTP endpoints."""

from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.models import (
    CampusRecord,
    MapRecord,
    PointGeometryRecord,
    PointRecord,
    StaffSessionRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.security import COOKIE, digest, hash_password

BASE = "/api/v1/admin"
TEST_PASSWORD = "test-only-Passphrase-712!"


def seed_staff(client, db):
    client.app.state.settings.admin_enabled = True
    client.headers["origin"] = "http://testserver"
    encoded = hash_password(TEST_PASSWORD)
    users = {}
    for role in ["admin", "editor", "reviewer", "viewer"]:
        u = StaffUserRecord(
            username=role,
            display_name=role,
            role=role,
            campus_ids=[] if role == "admin" else ["nku-jinnan"],
            point_ids=[],
            password_hash=encoded,
            must_change_password=False,
        )
        db.add(u)
        users[role] = u
    m = MapRecord(
        id=str(uuid4()),
        campus_id="nku-jinnan",
        title="Reviewed test map",
        revision=1,
        width_px=1000,
        height_px=800,
        image_asset_id=str(uuid4()),
        source_sha256="a" * 64,
        tile_size=512,
        max_native_zoom=1,
        attribution="Test",
        status="published",
        visibility="public",
    )
    db.add(m)
    db.commit()
    return users, m


@pytest.fixture
def staff(client, db):
    return seed_staff(client, db)


def login(client, name="editor", password=TEST_PASSWORD):
    result = client.post(BASE + "/auth/login", json={"username": name, "password": password})
    assert result.status_code == 200, result.text
    client.headers["x-csrf-token"] = result.json()["data"]["csrf_token"]
    return result.json()["data"]


def content(m, **overrides):
    return dict(
        campus_id="nku-jinnan",
        name="测试景点",
        aliases=[],
        category="patriotic",
        summary="审核用资料",
        visibility="public",
        source_note="测试用正式资料",
        geometry={
            "map_id": m.id,
            "map_revision": 1,
            "anchor": {"x": 100, "y": 100},
            "polygon": [
                {"x": 80, "y": 80},
                {"x": 120, "y": 80},
                {"x": 120, "y": 120},
                {"x": 80, "y": 120},
            ],
            "label_on_map": True,
        },
        **overrides,
    )


def create(client, m):
    r = client.post(BASE + "/points", json=content(m))
    assert r.status_code == 201, r.text
    return r.json()["data"]


def action(client, p, verb, expected=200):
    r = client.post(
        f"{BASE}/points/{p['point']['id']}/{verb}",
        json={"expected_revision": p["draft"]["revision"], "note": "已核对资料、定位和点击范围"},
    )
    assert r.status_code == expected, r.text
    return r.json().get("data")


def publish_new(client, m):
    login(client)
    p = action(client, create(client, m), "submit")
    login(client, "reviewer")
    return action(client, p, "publish")


def test_auth_cookie_csrf_origin_and_disabled(client, staff, db):
    assert client.get(BASE + "/points").status_code == 401
    session = login(client)
    raw = client.cookies.get(COOKIE)
    assert db.get(StaffSessionRecord, raw) is None
    assert db.get(StaffSessionRecord, digest(raw)) is not None
    assert "password_hash" not in str(session)
    del client.headers["x-csrf-token"]
    assert client.post(BASE + "/points", json=content(staff[1])).status_code == 403
    client.headers["x-csrf-token"] = session["csrf_token"]
    client.headers["origin"] = "https://other.example"
    assert client.post(BASE + "/points", json=content(staff[1])).status_code == 403
    assert (
        client.post(
            BASE + "/auth/login", json={"username": "editor", "password": TEST_PASSWORD}
        ).status_code
        == 403
    )
    client.app.state.settings.admin_enabled = False
    assert client.get(BASE + "/session").status_code == 404


def exercise_review_workflow(client, staff):
    _, m = staff
    login(client)
    p = create(client, m)
    pid = p["point"]["id"]
    assert client.get("/api/v1/points/" + pid).status_code == 404
    p = action(client, p, "submit")
    login(client, "admin")  # admin did not contribute; allowed review
    p = action(client, p, "publish")
    assert client.get("/api/v1/points/" + pid).json()["data"]["name"] == "测试景点"
    login(client)
    data = content(m)
    data["name"] = "新名称"
    data["geometry"]["anchor"] = {"x": 150, "y": 150}
    data.update(
        expected_revision=p["draft"]["revision"], expected_point_revision=p["point"]["revision"]
    )
    changed = client.put(BASE + "/points/" + pid, json=data)
    assert changed.status_code == 200, changed.text
    p = changed.json()["data"]
    assert client.get("/api/v1/points/" + pid).json()["data"]["name"] == "测试景点"
    assert (
        client.get(f"/api/v1/maps/{m.id}/features").json()["data"]["points"][0]["anchor"]["x"]
        == 100
    )
    assert client.put(BASE + "/points/" + pid, json=data).status_code == 409
    p = action(client, p, "submit")
    action(client, p, "publish", 403)  # editor cannot review
    login(client, "reviewer")
    p = action(client, p, "reject")
    login(client)
    p = action(client, p, "submit")
    login(client, "reviewer")
    p = action(client, p, "publish")
    assert client.get("/api/v1/points/" + pid).json()["data"]["name"] == "新名称"
    assert (
        client.get(f"/api/v1/maps/{m.id}/features").json()["data"]["points"][0]["label_on_map"]
        is True
    )
    login(client)
    r = client.post(
        BASE + "/points/" + pid + "/retire",
        json={
            "expected_revision": p["draft"]["revision"],
            "expected_point_revision": p["point"]["revision"],
            "note": "位置合并，申请下架",
        },
    )
    assert r.status_code == 200, r.text
    p = r.json()["data"]
    assert client.get("/api/v1/points/" + pid).status_code == 200
    login(client, "reviewer")
    p = action(client, p, "publish")
    assert client.get("/api/v1/points/" + pid).status_code == 404
    assert client.get(f"/api/v1/maps/{m.id}/features").json()["data"]["points"] == []
    login(client)
    data.update(
        expected_revision=p["draft"]["revision"], expected_point_revision=p["point"]["revision"]
    )
    p = client.put(BASE + "/points/" + pid, json=data).json()["data"]
    p = action(client, p, "submit")
    login(client, "reviewer")
    action(client, p, "publish")
    assert client.get("/api/v1/points/" + pid).status_code == 200
    audit = client.get(BASE + "/audit").json()["data"]
    assert any(
        e["action"] == "point.retired"
        and e["details"]["before"]["status"] == "published"
        and e["details"]["after"]["status"] == "retired"
        for e in audit
    )
    assert TEST_PASSWORD not in str(audit)


def test_complete_review_edit_retire_restore_keeps_public_snapshot(client, staff):
    exercise_review_workflow(client, staff)


def test_no_self_review_even_admin_and_map_change_conflict(client, staff, db):
    login(client, "admin")
    p = action(client, create(client, staff[1]), "submit")
    action(client, p, "publish", 403)
    login(client, "reviewer")
    staff[1].revision += 1
    db.commit()
    action(client, p, "publish", 409)
    action(client, p, "reject")


def test_scope_and_viewer_cannot_escalate(client, staff, db):
    users, m = staff
    p = publish_new(client, m)
    pid = p["point"]["id"]
    other = PointRecord(
        id=str(uuid4()),
        campus_id="nku-jinnan",
        name="Other",
        category="academic",
        status="published",
        visibility="public",
    )
    db.add(other)
    db.flush()
    db.add(
        PointGeometryRecord(
            map_id=m.id,
            point_id=other.id,
            map_revision=1,
            anchor={"x": 25, "y": 25},
            polygon=[{"x": 20, "y": 20}, {"x": 30, "y": 20}, {"x": 25, "y": 30}],
            entrance_ids=[],
        )
    )
    users["editor"].point_ids = [pid]
    db.commit()
    login(client)
    assert client.get(BASE + "/points").json()["meta"]["pagination"]["total"] == 1
    assert client.get(BASE + "/points/" + other.id).status_code == 404
    assert client.get(BASE + "/audit?point_id=" + other.id).status_code == 404
    assert [i["id"] for i in client.get(f"{BASE}/maps/{m.id}/points").json()["data"]] == [pid]
    assert client.post(BASE + "/points", json=content(m)).status_code == 403
    assert client.get(BASE + "/users").status_code == 403
    login(client, "viewer")
    assert client.get(BASE + "/points").status_code == 200
    assert client.post(BASE + "/points", json=content(m)).status_code == 403
    assert client.get(BASE + "/audit").status_code == 403
    db.add(CampusRecord(id="other-campus", name="Other campus"))
    db.commit()
    users["reviewer"].campus_ids = ["other-campus"]
    db.commit()
    login(client, "reviewer")
    assert client.get(BASE + "/points/" + pid).status_code == 404
    assert client.get(BASE + "/maps").json()["data"] == []


@pytest.mark.parametrize("kind", ["out", "cross", "duplicate", "flat", "version", "blank"])
def test_geometry_is_validated(client, staff, kind):
    login(client)
    payload = content(staff[1])
    g = payload["geometry"]
    if kind == "out":
        g["anchor"]["x"] = 1001
    if kind == "cross":
        g["polygon"] = [
            {"x": 10, "y": 10},
            {"x": 70, "y": 60},
            {"x": 10, "y": 80},
            {"x": 60, "y": 10},
        ]
    if kind == "duplicate":
        g["polygon"].append(g["polygon"][0])
    if kind == "flat":
        g["polygon"] = [{"x": 10, "y": 10}, {"x": 20, "y": 20}, {"x": 30, "y": 30}]
    if kind == "version":
        g["map_revision"] = 999
    if kind == "blank":
        payload["name"] = "   "
    r = client.post(BASE + "/points", json=payload)
    assert r.status_code == (409 if kind == "version" else 422), r.text


def test_account_lifecycle_password_forced_revocation_and_self_protection(client, staff, db):
    users, _ = staff
    login(client, "admin")
    payload = {
        "username": "new.editor",
        "display_name": "新编辑",
        "role": "editor",
        "campus_ids": ["nku-jinnan"],
        "point_ids": [],
        "password": TEST_PASSWORD,
    }
    r = client.post(BASE + "/users", json=payload)
    assert r.status_code == 201, r.text
    user = r.json()["data"]
    login(client, "new.editor")
    assert client.get(BASE + "/points").status_code == 403
    replacement = TEST_PASSWORD + "-changed"
    r = client.post(
        BASE + "/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": replacement},
    )
    assert r.status_code == 200, r.text
    assert client.get(BASE + "/session").status_code == 401
    login(client, "new.editor", replacement)
    assert client.get(BASE + "/points").status_code == 200
    token = client.cookies.get(COOKIE)
    login(client, "admin")
    user = next(u for u in client.get(BASE + "/users").json()["data"] if u["id"] == user["id"])
    update = {k: user[k] for k in ["display_name", "role", "campus_ids", "point_ids"]}
    update.update(expected_revision=user["revision"], is_active=False)
    assert client.put(BASE + "/users/" + user["id"], json=update).status_code == 200
    assert db.get(StaffSessionRecord, digest(token)) is None
    assert client.put(BASE + "/users/" + user["id"], json=update).status_code == 409
    me = client.get(BASE + "/session").json()["data"]["user"]
    own = {k: me[k] for k in ["display_name", "role", "campus_ids", "point_ids"]}
    own.update(expected_revision=me["revision"], is_active=False)
    assert client.put(BASE + "/users/" + me["id"], json=own).status_code == 403
    assert TEST_PASSWORD not in client.get(BASE + "/audit").text
    assert "password_hash" not in client.get(BASE + "/users").text


def test_login_limit_expiry_logout_and_secure_cookie(client, staff, db):
    for _ in range(8):
        r = client.post(
            BASE + "/auth/login", json={"username": "unknown", "password": TEST_PASSWORD}
        )
        assert r.status_code == 401
    assert (
        client.post(
            BASE + "/auth/login", json={"username": "unknown", "password": TEST_PASSWORD}
        ).status_code
        == 429
    )
    login(client)
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    session.expires_at = now_utc() - timedelta(seconds=1)
    db.commit()
    assert client.get(BASE + "/session").status_code == 401
    login(client)
    assert client.post(BASE + "/auth/logout").status_code == 200
    assert client.get(BASE + "/session").status_code == 401
    client.app.state.settings.app_env = "production"
    client.app.state.settings.admin_public_origin = (
        "http://testserver"  # only cookie behavior; config validator tested separately
    )
    r = client.post(BASE + "/auth/login", json={"username": "editor", "password": TEST_PASSWORD})
    cookie = r.headers["set-cookie"]
    assert (
        "Secure" in cookie
        and "HttpOnly" in cookie
        and "SameSite=strict" in cookie
        and "Path=/api/v1/admin" in cookie
    )
    assert db.scalar(select(StaffSessionRecord.token_hash)) is not None
