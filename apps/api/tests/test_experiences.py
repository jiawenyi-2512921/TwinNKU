"""Real HTTP boundaries for reviewed media, check-ins and tour references."""

import shutil
import subprocess
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_admin import BASE, login, seed_staff
from test_resources import image_bytes, make_resource_point

from app.models import AdminAuditRecord, ExperienceRecord

PUBLIC = "/api/v1/experiences"
ADMIN = BASE + "/experiences"


@pytest.fixture
def experiences(client, db, tmp_path):
    users, _ = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "media"
    return users, make_resource_point(db), make_resource_point(db)


def upload(client, point, data=None, mime="image/png", expected=201):
    response = client.post(
        f"{BASE}/points/{point.id}/experience-media",
        content=image_bytes() if data is None else data,
        headers={"Content-Type": mime},
    )
    assert response.status_code == expected, response.text
    return response.json().get("data")


def content(point, kind="media", **values):
    base = {
        "kind": kind,
        "point_id": point.id,
        "title": "已核对素材",
        "description": "校园参观素材",
        "source_note": "测试夹具，不是学校实际资料",
    }
    if kind == "media":
        base.update(media_type="image", url="https://example.com/test.png")
    return {**base, **values}


def save(client, data, previous=None, expected=None):
    response = client.request(
        "PUT" if previous else "POST",
        ADMIN + ("/" + previous["id"] if previous else ""),
        json={
            "expected_revision": previous["revision"] if previous else 0,
            "expected_published_revision": previous["published_revision"] if previous else 0,
            "content": data,
        },
    )
    assert response.status_code == (expected or (200 if previous else 201)), response.text
    return response.json().get("data")


def action(client, item, verb, expected=200):
    response = client.post(
        f"{ADMIN}/{item['id']}/review/{verb}",
        json={"expected_revision": item["revision"], "note": "已核对来源和公开权限"},
    )
    assert response.status_code == expected, response.text
    return response.json().get("data")


def publish(client, data):
    login(client)
    item = action(client, save(client, data), "submit")
    login(client, "reviewer")
    return action(client, item, "publish")


def retire(client, item):
    login(client)
    response = client.post(
        f"{ADMIN}/{item['id']}/retire",
        json={
            "expected_revision": item["revision"],
            "expected_published_revision": item["published_revision"],
            "note": "测试下架",
        },
    )
    assert response.status_code == 200, response.text
    pending = response.json()["data"]
    assert pending["operation"] == "retire" and pending["state"] == "in_review"
    login(client, "reviewer")
    return action(client, pending, "publish")


def test_experience_media_publication_ranges_replacement_and_revocation(client, db, experiences):
    exercise_experience_workflow(client, db, experiences)


def exercise_experience_workflow(client, db, experiences):
    _, point, _ = experiences
    login(client)
    asset = upload(client, point)
    assert client.get(asset["url"]).content == image_bytes()
    media = save(client, content(point, upload_id=asset["id"], url=None))
    url = f"{PUBLIC}/{media['id']}/media"
    assert client.get(url).status_code == 404
    assert client.get(PUBLIC).json()["data"] == []
    submitted = action(client, media, "submit")
    login(client, "admin")
    # Uploader/editor cannot exploit admin role for self review.
    login(client)
    action(client, submitted, "publish", expected=403)
    login(client, "reviewer")
    media = action(client, submitted, "publish")
    result = client.get(url, headers={"Range": "bytes=0-15"})
    assert result.status_code == 206 and result.content == image_bytes()[:16]
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["content-range"].startswith("bytes 0-15/")
    assert client.get(url, headers={"Range": "bytes=999999-"}).status_code == 416
    checkin = publish(client, content(point, "checkin", image_id=media["id"]))
    assert client.get(f"{PUBLIC}/{checkin['id']}").status_code == 200
    retired = retire(client, media)
    assert client.get(url, headers={"Range": "bytes=0-15"}).status_code == 404
    assert client.get(f"{PUBLIC}/{checkin['id']}").status_code == 404
    assert client.get(PUBLIC).json()["data"] == []
    login(client)
    updated = save(client, content(point, upload_id=asset["id"], url=None), retired)
    submitted = action(client, updated, "submit")
    login(client, "reviewer")
    action(client, submitted, "publish")
    assert client.get(url).status_code == 200
    point.visibility = "internal"
    db.commit()
    assert client.get(url).status_code == 404
    assert client.get(f"{PUBLIC}/{checkin['id']}").status_code == 404
    assert db.scalar(
        select(AdminAuditRecord).where(AdminAuditRecord.action == "experience.retired")
    )


def test_experience_scope_upload_contributor_and_conflicts(client, db, experiences):
    users, point, other = experiences
    assert (
        client.post(
            f"{BASE}/points/{point.id}/experience-media",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        ).status_code
        == 401
    )
    login(client, "viewer")
    upload(client, point, expected=403)
    login(client, "admin")
    asset = upload(client, point)
    login(client)
    media = save(client, content(point, upload_id=asset["id"], url=None))
    save(client, content(other, upload_id=asset["id"], url=None), expected=422)
    changed = save(client, content(point, upload_id=asset["id"], url=None, title="修改标题"), media)
    save(client, content(point), media, expected=409)
    pending = action(client, changed, "submit")
    login(client, "admin")
    action(client, pending, "publish", expected=403)
    users["viewer"].point_ids = [other.id]
    db.commit()
    login(client, "viewer")
    assert client.get(asset["url"]).status_code == 404
    assert client.get(f"{ADMIN}/{media['id']}").status_code == 404
    assert client.get(ADMIN).json()["data"] == []
    login(client)
    del client.headers["x-csrf-token"]
    upload(client, point, expected=403)


def test_tour_scope_stale_points_and_video_references(client, db, experiences):
    users, point, other = experiences
    video = publish(client, content(other, media_type="video", url="https://example.com/video.mp4"))
    data = content(
        point,
        "tour",
        stops=[
            {"point_id": point.id, "narrative": "第一站"},
            {
                "point_id": other.id,
                "video_id": video["id"],
                "narrative": "第二站",
                "prompt_timing": "after_intro",
            },
        ],
    )
    tour = publish(client, data)
    result = client.get(f"{PUBLIC}/{tour['id']}").json()["data"]
    assert result["content"]["stops"][1]["prompt_timing"] == "after_intro"
    users["viewer"].point_ids = [point.id]
    db.commit()
    login(client, "viewer")
    assert client.get(f"{ADMIN}/{tour['id']}").status_code == 404
    assert client.get(ADMIN).json()["data"] == []
    users["editor"].point_ids = [point.id]
    db.commit()
    login(client)
    save(client, data, expected=404)
    users["editor"].point_ids = []
    other.status = "retired"
    db.commit()
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 404
    assert client.get(PUBLIC).json()["data"] == []
    other.status = "published"
    db.commit()
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 200
    retire(client, video)
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 404


def test_media_invalid_uploads_urls_and_size(client, experiences, monkeypatch):
    _, point, _ = experiences
    login(client)
    upload(client, point, b"not-png", expected=422)
    upload(client, point, image_bytes(), "video/mp4", expected=422)
    upload(client, point, b"<svg/>", "image/svg+xml", expected=415)
    upload(client, point, b"", expected=422)
    for url in (
        "javascript:alert(1)",
        "https://127.0.0.1/a",
        "https://user:pass@example.com/a",
        "http://example.com/a",
    ):
        save(client, content(point, url=url), expected=422)
    save(client, content(point, upload_id=str(uuid4())), expected=422)
    save(client, content(point, "checkin", image_id=str(uuid4())), expected=409)
    monkeypatch.setattr("app.modules.experiences.MAX_MEDIA_BYTES", 10)
    upload(client, point, expected=413)


def test_review_reject_discard_and_published_snapshot(client, db, experiences):
    _, point, _ = experiences
    item = publish(client, content(point, "checkin"))
    login(client)
    changed = save(client, content(point, "checkin", title="待审核标题"), item)
    assert client.get(f"{PUBLIC}/{item['id']}").json()["data"]["content"]["title"] == "已核对素材"
    pending = action(client, changed, "submit")
    login(client, "reviewer")
    rejected = action(client, pending, "reject")
    login(client)
    discarded = action(client, rejected, "discard")
    assert discarded["state"] == "discarded"
    assert db.get(ExperienceRecord, item["id"]).published["title"] == "已核对素材"
    action(client, discarded, "submit", expected=409)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is required for real video fixture")
def test_real_video_validation_and_byte_ranges(client, experiences, tmp_path):
    _, point, _ = experiences
    path = tmp_path / "fixture.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=16x16:rate=1",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )
    raw = path.read_bytes()
    login(client)
    asset = upload(client, point, raw, "video/mp4")
    item = publish(client, content(point, media_type="video", upload_id=asset["id"], url=None))
    response = client.get(f"{PUBLIC}/{item['id']}/media", headers={"Range": "bytes=-20"})
    assert response.status_code == 206 and response.content == raw[-20:]
    assert response.headers["content-type"] == "video/mp4"
    login(client)
    upload(client, point, raw, "video/webm", expected=422)
