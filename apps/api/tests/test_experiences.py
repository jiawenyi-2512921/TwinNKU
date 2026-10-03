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
    if kind == "tour":
        base.pop("point_id")
        base["campus_id"] = point.campus_id
    if kind == "media":
        base.update(media_type="image", url="https://example.com/test.png")
    result = {**base, **values}
    if result.get("media_type") == "video":
        result.setdefault("video_visual_information", "audio_complete")
        result.setdefault("video_accessibility_note", "测试夹具：人工核对声音已描述关键画面；不代表真实内容验收")
    return result


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
        json={"expected_revision": item["revision"], "note": "已核对来源和公开权限",
              "video_accessibility_confirmed": True},
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


def test_tour_references_published_checkin_and_video_at_the_same_station(client, db, experiences):
    users, point, other = experiences
    image = publish(client, content(point))
    checkin = publish(client, content(point, "checkin", image_id=image["id"]))
    video = publish(client, content(point, media_type="video", url="https://example.com/video.mp4"))
    data = content(
        point,
        "tour",
        stops=[
            {
                "point_id": point.id,
                "checkin_id": checkin["id"],
                "video_id": video["id"],
            }
        ],
    )
    tour = publish(client, data)
    result = client.get(f"{PUBLIC}/{tour['id']}").json()["data"]
    assert result["content"]["stops"][0]["checkin_id"] == checkin["id"]
    assert result["content"]["stops"][0]["video_id"] == video["id"]
    login(client)
    # Upload-only/draft resources do not become route candidates or valid references.
    unpublished = save(client, content(point, "checkin"))
    assert unpublished["id"] not in {
        row["id"] for row in client.get(f"{ADMIN}?kind=checkin&referenceable=true").json()["data"]
    }
    for ref in (unpublished["id"], image["id"], str(uuid4())):
        save(
            client,
            content(point, "tour", stops=[{"point_id": point.id, "checkin_id": ref}]),
            expected=409,
        )
    save(
        client,
        content(other, "tour", stops=[{"point_id": other.id, "checkin_id": checkin["id"]}]),
        expected=409,
    )
    save(
        client,
        content(other, "tour", stops=[{"point_id": other.id, "video_id": video["id"]}]),
        expected=409,
    )
    # Editing an already published checkin leaves its reviewed version referenceable.
    pending = save(
        client, content(point, "checkin", image_id=image["id"], title="尚未审核"), checkin
    )
    candidates = client.get(f"{ADMIN}?kind=checkin&referenceable=true").json()["data"]
    assert (
        next(row for row in candidates if row["id"] == checkin["id"])["published_content"]["title"]
        != "尚未审核"
    )
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 200
    # A scoped outsider cannot discover any referenced resource at this station.
    users["viewer"].point_ids = [other.id]
    db.commit()
    login(client, "viewer")
    assert client.get(f"{ADMIN}?kind=checkin&referenceable=true").json()["data"] == []
    login(client)
    discarded = action(client, pending, "discard")
    retire(client, discarded)
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 404
    login(client)
    assert client.get(f"{ADMIN}?kind=checkin&referenceable=true").json()["data"] == []


def test_tour_checkin_reference_rechecks_images_and_publication_at_review(client, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    checkin = publish(client, content(point, "checkin", image_id=image["id"]))
    login(client)
    pending = action(
        client,
        save(
            client,
            content(
                point,
                "tour",
                stops=[
                    {
                        "point_id": point.id,
                        "checkin_id": checkin["id"],
                    }
                ],
            ),
        ),
        "submit",
    )
    retire(client, image)
    action(client, pending, "publish", expected=409)
    assert client.get(f"{PUBLIC}/{checkin['id']}").status_code == 404
    assert client.get(f"{PUBLIC}/{pending['id']}").status_code == 404
    login(client)
    assert client.get(f"{ADMIN}?kind=checkin&referenceable=true").json()["data"] == []


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
    checkin = publish(client, content(point, "checkin"))
    tour = publish(
        client,
        content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "video_id": item["id"],
                    "checkin_id": checkin["id"],
                }
            ],
        ),
    )
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 200
    response = client.get(f"{PUBLIC}/{item['id']}/media", headers={"Range": "bytes=-20"})
    assert response.status_code == 206 and response.content == raw[-20:]
    assert response.headers["content-type"] == "video/mp4"
    login(client)
    upload(client, point, raw, "video/webm", expected=422)


def test_campus_tour_has_no_building_owner_and_first_stop_is_editable(client, db, experiences):
    from app.models import CampusRecord

    users, first, second = experiences
    data = content(first, "tour", stops=[{"point_id": first.id}, {"point_id": second.id}])
    published = publish(client, data)
    stored = db.get(ExperienceRecord, published["id"])
    assert stored.point_id is None and stored.campus_id == first.campus_id
    public = client.get(f"{PUBLIC}/{published['id']}").json()["data"]
    assert public["campus_id"] == first.campus_id
    assert public["content"]["campus_id"] == first.campus_id
    assert "point_id" not in public["content"]
    assert (
        client.get(PUBLIC, params={"point_id": second.id}).json()["data"][0]["id"]
        == published["id"]
    )
    login(client)
    reversed_stops = {**data, "stops": list(reversed(data["stops"]))}
    draft = save(client, reversed_stops, published)
    save(client, reversed_stops, published, expected=409)
    assert (
        client.get(f"{PUBLIC}/{published['id']}").json()["data"]["content"]["stops"][0]["point_id"]
        == first.id
    )
    pending = action(client, draft, "submit")
    login(client, "reviewer")
    published = action(client, pending, "publish")
    assert (
        client.get(f"{PUBLIC}/{published['id']}").json()["data"]["content"]["stops"][0]["point_id"]
        == second.id
    )
    assert db.get(ExperienceRecord, published["id"]).point_id is None
    event = db.scalar(
        select(AdminAuditRecord).where(AdminAuditRecord.action == "experience.published")
    )
    assert event.campus_id == first.campus_id and event.point_id is None
    # Removing a stop in draft must not reveal the still-published stop to a scoped outsider.
    login(client)
    draft = save(client, {**data, "stops": [{"point_id": second.id}]}, published)
    users["viewer"].point_ids = [second.id]
    db.commit()
    login(client, "viewer")
    assert client.get(f"{ADMIN}/{published['id']}").status_code == 404
    assert client.get(ADMIN).json()["data"] == []
    # Campus IDs are real and all route stops must belong to the selected campus.
    db.add(CampusRecord(id="other-campus", name="Test other campus"))
    db.commit()
    login(client, "admin")
    save(client, {**data, "campus_id": "other-campus"}, expected=422)
    save(client, {**data, "point_id": first.id}, expected=422)
    db.get(CampusRecord, first.campus_id).is_active = False
    db.commit()
    assert client.get(f"{PUBLIC}/{published['id']}").status_code == 404


def test_legacy_tour_snapshot_normalizes_without_mutation_or_anchor_dependency(
    client, db, experiences
):
    _, old_owner, actual_stop = experiences
    legacy = {
        "kind": "tour",
        "point_id": old_owner.id,
        "title": "已审核旧路线",
        "description": "旧版真实快照结构的测试夹具",
        "source_note": "测试资料",
        "stops": [{"point_id": actual_stop.id, "narrative": "原有讲解", "prompt_timing": "manual"}],
    }
    row = ExperienceRecord(
        id=str(uuid4()),
        point_id=None,
        campus_id=old_owner.campus_id,
        kind="tour",
        revision=5,
        published_revision=2,
        state="published",
        status="published",
        draft=legacy,
        published=legacy,
    )
    db.add(row)
    old_owner.status = "retired"
    db.commit()
    response = client.get(f"{PUBLIC}/{row.id}")
    assert response.status_code == 200, response.text
    normalized = response.json()["data"]["content"]
    assert normalized["campus_id"] == old_owner.campus_id and "point_id" not in normalized
    assert normalized["stops"][0]["narrative"] == "原有讲解"
    assert normalized["stops"][0]["checkin_id"] is None
    assert row.published == legacy and row.draft == legacy
    assert row.revision == 5 and row.published_revision == 2
    login(client)
    detail = client.get(f"{ADMIN}/{row.id}").json()["data"]
    assert "point_id" not in detail["content"]
    assert client.get(PUBLIC, params={"campus_id": "other-campus"}).json()["data"] == []
    assert (
        client.get(PUBLIC, params={"campus_id": old_owner.campus_id}).json()["data"][0]["id"]
        == row.id
    )
    actual_stop.status = "retired"
    db.commit()
    assert client.get(f"{PUBLIC}/{row.id}").status_code == 404


def test_campus_tour_migration_preserves_reviewed_snapshots_and_revisions(tmp_path):
    import os
    import sys
    from pathlib import Path

    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session

    from app.models import CampusRecord, PointRecord

    api_root = Path(__file__).resolve().parents[1]
    url = "sqlite:///" + str(tmp_path / "migration.db")
    env = {**os.environ, "APP_ENV": "test", "DATABASE_URL": url}

    def migrate(*args):
        subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=api_root,
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )

    migrate("upgrade", "0007_experiences")
    engine = create_engine(url)
    point_id, row_id = str(uuid4()), str(uuid4())
    with Session(engine) as session:
        session.add(CampusRecord(id="test-campus", name="Migration test"))
        session.commit()
        session.add(
            PointRecord(
                id=point_id,
                campus_id="test-campus",
                name="Test stop",
                category="academic",
                status="published",
                visibility="public",
            )
        )
        session.commit()
    legacy = {
        "kind": "tour",
        "point_id": point_id,
        "title": "Kept title",
        "source_note": "fixture",
        "stops": [{"point_id": point_id, "narrative": "Kept narrative"}],
    }
    import json

    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO experiences (id,point_id,kind,revision,published_revision,state,status,operation,draft,published,contributor_ids,review_note,updated_at) VALUES (:id,:point_id,'tour',7,3,'published','published','upsert',:payload,:payload,'[]','Kept review','2026-09-29 00:00:00')"
            ),
            {"id": row_id, "point_id": point_id, "payload": json.dumps(legacy)},
        )
    migrate("upgrade", "head")
    migrate("check")
    with engine.connect() as connection:
        row = (
            connection.execute(text("SELECT * FROM experiences WHERE id=:id"), {"id": row_id})
            .mappings()
            .one()
        )
        assert row["campus_id"] == "test-campus" and row["point_id"] is None
        assert row["revision"] == 7 and row["published_revision"] == 3
        assert json.loads(row["published"]) == legacy
        assert json.loads(row["draft"]) == legacy
        assert row["review_note"] == "Kept review"
    second_point_id, new_row_id = str(uuid4()), str(uuid4())
    with Session(engine) as session:
        session.add(
            PointRecord(
                id=second_point_id,
                campus_id="test-campus",
                name="Second stop",
                category="academic",
                status="published",
                visibility="public",
            )
        )
        session.commit()
        published = {
            "kind": "tour",
            "campus_id": "test-campus",
            "title": "Campus tour",
            "source_note": "fixture",
            "stops": [{"point_id": point_id, "narrative": "Public A"}],
        }
        draft = {**published, "stops": [{"point_id": second_point_id, "narrative": "Draft B"}]}
        session.add(
            ExperienceRecord(
                id=new_row_id,
                campus_id="test-campus",
                point_id=None,
                kind="tour",
                status="published",
                state="draft",
                revision=4,
                published_revision=1,
                published=published,
                draft=draft,
            )
        )
        session.commit()
    migrate("downgrade", "0007_experiences")
    with engine.connect() as connection:
        row = (
            connection.execute(text("SELECT * FROM experiences WHERE id=:id"), {"id": row_id})
            .mappings()
            .one()
        )
        assert row["point_id"] == point_id and row["revision"] == 7
        assert json.loads(row["published"]) == legacy
        current = (
            connection.execute(text("SELECT * FROM experiences WHERE id=:id"), {"id": new_row_id})
            .mappings()
            .one()
        )
        public_content, draft_content = (
            json.loads(current["published"]),
            json.loads(current["draft"]),
        )
        assert (
            current["point_id"]
            == public_content["point_id"]
            == draft_content["point_id"]
            == point_id
        )
        assert public_content["stops"] == published["stops"]
        assert draft_content["stops"] == draft["stops"]
        assert current["revision"] == 4 and current["published_revision"] == 1
    engine.dispose()


def test_campus_tour_audit_visible_to_campus_members_not_partial_scopes(client, db, experiences):
    from app.models import CampusRecord

    users, first, second = experiences
    tour = publish(
        client, content(first, "tour", stops=[{"point_id": first.id}, {"point_id": second.id}])
    )
    media = publish(client, content(first))
    db.add(CampusRecord(id="unrelated-campus", name="Other campus test"))
    db.commit()
    db.add(
        AdminAuditRecord(
            actor_id=users["admin"].id,
            actor_name="admin",
            action="experience.published",
            campus_id="unrelated-campus",
            point_id=None,
            note="Private other campus",
            details={"experience_id": "unrelated"},
        )
    )
    db.commit()

    def visible_ids():
        response = client.get(BASE + "/audit", params={"category": "experience", "page_size": 100})
        assert response.status_code == 200, response.text
        return {row["details"].get("experience_id") for row in response.json()["data"]}

    for role in ("editor", "reviewer"):
        login(client, role)
        assert tour["id"] in visible_ids() and media["id"] in visible_ids()
        assert "unrelated" not in visible_ids()
        users[role].point_ids = [first.id]
        db.commit()
        assert tour["id"] not in visible_ids()
        assert media["id"] in visible_ids()
        users[role].point_ids = []
        db.commit()
    login(client, "admin")
    assert "unrelated" in visible_ids()
