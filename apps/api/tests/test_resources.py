"""Exercise scoped uploads and review/publication over the actual HTTP boundary."""

from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import select
from test_admin import BASE, login, seed_staff

from app.models import AdminAuditRecord, PointRecord


def image_bytes(color="green"):
    result = BytesIO()
    Image.new("RGB", (24, 20), color).save(result, format="PNG")
    return result.getvalue()


@pytest.fixture
def resources(client, db, tmp_path):
    staff, _ = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "floors"
    return staff, make_resource_point(db)


def make_resource_point(db):
    point = PointRecord(
        id=str(uuid4()),
        campus_id="nku-jinnan",
        name="资料测试楼",
        aliases=[],
        category="academic",
        summary="",
        status="published",
        visibility="public",
        revision=1,
    )
    db.add(point)
    db.commit()
    return point


def upload(client, point, data=None):
    data = data or image_bytes()
    r = client.post(
        f"{BASE}/points/{point.id}/floor-images",
        content=data,
        headers={"Content-Type": "image/png"},
    )
    assert r.status_code == 201, r.text
    result = r.json()["data"]
    assert client.get(result["image"]["url"]).content == data
    return result


def save(client, point, content, previous=None, expected=201):
    r = client.request(
        "PUT" if previous else "POST",
        f"{BASE}/resources/{previous['id']}" if previous else f"{BASE}/points/{point.id}/resources",
        json={
            "content": content,
            "source_note": "用户提供并核对的标注资料",
            "expected_revision": previous["draft"]["revision"]
            if previous and previous["draft"]
            else 0,
            "expected_published_revision": previous["published_revision"] if previous else 0,
        },
    )
    assert r.status_code == expected, r.text
    return r.json().get("data")


def action(client, resource, verb, expected=200):
    r = client.post(
        f"{BASE}/resources/{resource['id']}/review/{verb}",
        json={"expected_revision": resource["draft"]["revision"], "note": "已核对当前资料"},
    )
    assert r.status_code == expected, r.text
    return r.json().get("data")


def floor_content(*uploads):
    return {
        "kind": "floor",
        "label": "1层",
        "ordinal": 1,
        "attribution": "用户整理的标注图",
        "images": [
            {"section": chr(97 + i), "section_label": chr(65 + i) + "区", "upload_id": u["id"]}
            for i, u in enumerate(uploads)
        ],
    }


def test_floor_upload_review_replace_retire_restore(client, db, resources):
    exercise_floor_workflow(client, db, resources)


def exercise_floor_workflow(client, db, resources):
    _, point = resources
    login(client)
    a, b = upload(client, point), upload(client, point, image_bytes("blue"))
    r = save(client, point, floor_content(a, b))
    assert client.get(r["images"][0]["url"]).content == image_bytes()
    assert client.get(f"/api/v1/points/{point.id}/floors").json()["data"] == []
    assert client.get(f"/api/v1/floors/{r['id']}").status_code == 404
    submitted = action(client, r, "submit")
    action(client, submitted, "publish", 403)
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    floor = client.get(f"/api/v1/floors/{r['id']}").json()["data"]
    assert floor["revision"] == 1 and len(floor["images"]) == 2
    assert client.get(floor["images"][1]["url"]).content == image_bytes("blue")
    assert client.get(a["image"]["url"]).headers["Cache-Control"] == "no-store"
    login(client)
    content = published["current"]
    content["label"] = "一层（含A/B区）"
    draft = save(client, point, content, published, expected=200)
    save(client, point, content, published, expected=409)
    assert client.get(f"/api/v1/floors/{r['id']}").json()["data"]["label"] == "1层"
    submitted = action(client, draft, "submit")
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    assert published["published_revision"] == 2
    assert client.get(floor["images"][0]["url"]).status_code == 404
    floor2 = client.get(f"/api/v1/floors/{r['id']}").json()["data"]
    assert client.get(floor2["images"][0]["url"]).content == image_bytes()
    login(client)
    response = client.post(
        f"{BASE}/resources/{r['id']}/retire",
        json={
            "expected_revision": published["draft"]["revision"],
            "expected_published_revision": 2,
            "note": "暂停展示",
        },
    )
    assert response.status_code == 200, response.text
    pending = response.json()["data"]
    assert client.get(pending["images"][0]["url"]).status_code == 200
    login(client, "reviewer")
    retired = action(client, pending, "publish")
    assert client.get(floor2["images"][0]["url"]).status_code == 404
    login(client)
    draft = save(client, point, retired["current"], retired, expected=200)
    submitted = action(client, draft, "submit")
    login(client, "reviewer")
    restored = action(client, submitted, "publish")
    assert restored["published_revision"] == 3
    db.refresh(point)
    assert point.revision == 1 and point.name == "资料测试楼"
    assert db.scalar(select(AdminAuditRecord).where(AdminAuditRecord.action == "resource.retired"))


def test_resource_scope_csrf_and_uploader_cannot_review(client, db, resources):
    users, point = resources
    assert (
        client.post(
            f"{BASE}/points/{point.id}/floor-images",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        ).status_code
        == 401
    )
    login(client, "viewer")
    assert (
        client.post(
            f"{BASE}/points/{point.id}/floor-images",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        ).status_code
        == 403
    )
    login(client, "admin")
    original = upload(client, point)
    login(client)
    r = save(client, point, floor_content(original))
    submitted = action(client, r, "submit")
    login(client, "admin")
    action(client, submitted, "publish", 403)
    users["viewer"].point_ids = [str(uuid4())]
    db.commit()
    login(client, "viewer")
    assert client.get(original["image"]["url"]).status_code == 404
    assert client.get(f"{BASE}/resources/{r['id']}").status_code == 404
    assert client.get(BASE + "/resources").json()["data"] == []
    login(client)
    del client.headers["x-csrf-token"]
    assert (
        client.post(
            f"{BASE}/points/{point.id}/floor-images",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        ).status_code
        == 403
    )


def test_invalid_upload_and_cross_point_reference(client, db, resources, monkeypatch):
    _, point = resources
    login(client)
    url = f"{BASE}/points/{point.id}/floor-images"
    assert (
        client.post(url, content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}).status_code
        == 415
    )
    assert (
        client.post(url, content=b"not an image", headers={"Content-Type": "image/png"}).status_code
        == 422
    )
    original = upload(client, point)
    corrupt = bytearray(image_bytes())
    corrupt[45] ^= 1
    assert (
        client.post(url, content=bytes(corrupt), headers={"Content-Type": "image/png"}).status_code
        == 422
    )
    other = PointRecord(
        id=str(uuid4()),
        campus_id="nku-jinnan",
        name="另一栋",
        aliases=[],
        category="academic",
        summary="",
        status="published",
        visibility="public",
        revision=1,
    )
    db.add(other)
    db.commit()
    save(client, other, floor_content(original), expected=422)
    monkeypatch.setattr("app.modules.admin.resources.MAX_BYTES", 10)
    assert (
        client.post(url, content=image_bytes(), headers={"Content-Type": "image/png"}).status_code
        == 413
    )


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "http://example.com",
        "https://user:secret@example.com/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://localhost/",
        "https://localhost./",
        "https://host.local/",
        "https://example.com:8443/",
        "https://example.com/\nsecret",
    ],
)
def test_invalid_vr_links(client, resources, url):
    _, point = resources
    login(client)
    save(client, point, {"kind": "panorama", "title": "全景", "url": url}, expected=422)


def test_vr_publication_reject_withdraw_and_private_parent(client, db, resources):
    _, point = resources
    login(client)
    r = save(
        client,
        point,
        {
            "kind": "panorama",
            "title": "入口全景",
            "url": "https://example.com/tour?scene=1",
            "description": "从入口开始参观",
        },
    )
    endpoint = f"/api/v1/points/{point.id}/panoramas"
    assert client.get(endpoint).json()["data"] == []
    submitted = action(client, r, "submit")
    login(client, "reviewer")
    rejected = action(client, submitted, "reject")
    assert client.get(endpoint).json()["data"] == []
    login(client)
    submitted = action(client, rejected, "submit")
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    assert client.get(endpoint).json()["data"][0]["url"] == "https://example.com/tour?scene=1"
    assert client.get("/api/v1/system/status").json()["data"]["capabilities"]["vr"]
    client.app.state.settings.vr_enabled = False
    assert client.get(endpoint).json()["data"] == []
    assert not client.get("/api/v1/system/status").json()["data"]["capabilities"]["vr"]
    client.app.state.settings.vr_enabled = True
    point.visibility = "internal"
    db.commit()
    assert client.get(endpoint).status_code == 404
    point.visibility = "public"
    db.commit()
    login(client)
    pending = client.post(
        f"{BASE}/resources/{r['id']}/retire",
        json={
            "expected_revision": published["draft"]["revision"],
            "expected_published_revision": 1,
            "note": "暂停全景",
        },
    ).json()["data"]
    login(client, "reviewer")
    rejected = action(client, pending, "reject")
    login(client)
    resubmitted = action(client, rejected, "submit")
    login(client, "reviewer")
    action(client, resubmitted, "publish")
    assert client.get(endpoint).json()["data"] == []
