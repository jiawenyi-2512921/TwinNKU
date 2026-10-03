"""Authenticated historical reads preserve source and never substitute a new revision."""

import copy
from uuid import uuid4

from sqlalchemy import func, select
from test_admin import login
from test_experiences import ADMIN, action, content, publish, retire, save, upload
from test_experiences import experiences as experiences
from test_narration import adopt, generate, wav_bytes
from test_narration import narration as narration
from test_resources import action as resource_action
from test_resources import floor_content, image_bytes
from test_resources import save as resource_save
from test_resources import upload as floor_upload

from app.content_history_models import ExperienceVersionRecord
from app.models import AdminAuditRecord, ExperienceRecord
from app.narration_models import NarrationJob


def version(client, item):
    checkpoint = client.post(f"{ADMIN}/{item['id']}/checkpoint", json={
        "expected_revision": item["revision"], "expected_published_revision": item["published_revision"],
        "operation_id": str(uuid4()), "note": "历史只读验收检查点",
    })
    assert checkpoint.status_code == 200, checkpoint.text
    response = client.get(f"{ADMIN}/{item['id']}/history")
    assert response.status_code == 200, response.text
    return next(row for row in response.json()["data"] if row["event"] == "checkpoint")


def preview(client, item, old, **query):
    return client.get(f"{ADMIN}/{item['id']}/history/{old['id']}/preview", params=query)


def modern(point, ref, *, repeat=False):
    stop = {"point_id": point.id, "segments": [{
        "id": "original-segment", "text": "历史原文，不能重写。",
        "main_view": {"type": "map"}, "resources": [ref],
    }]}
    second = copy.deepcopy(stop)
    second["segments"][0]["id"] = "repeated-point-segment"
    return content(point, "tour", stops=[stop, second] if repeat else [stop])


def test_reviewer_read_is_private_immutable_and_has_two_explicit_snapshots(client, db, experiences):
    _, point, _ = experiences
    item = publish(client, content(point, "tour", stops=[{"point_id": point.id, "narrative": "正式原文"}]))
    login(client)
    candidate = {**item["published_content"], "description": "后续私有草稿"}
    item = save(client, candidate, item)
    old = version(client, item)
    login(client, "reviewer")
    before = (copy.deepcopy(db.get(ExperienceRecord, item["id"]).draft),
              db.scalar(select(func.count()).select_from(ExperienceVersionRecord)),
              db.scalar(select(func.count()).select_from(AdminAuditRecord)))
    draft = preview(client, item, old, snapshot="draft")
    formal = preview(client, item, old, snapshot="published")
    assert draft.status_code == formal.status_code == 200
    assert draft.json()["data"]["item"]["content"]["description"] == "后续私有草稿"
    assert formal.json()["data"]["item"]["content"] == item["published_content"]
    assert formal.json()["data"]["snapshot_sha256"] != draft.json()["data"]["snapshot_sha256"]
    assert formal.json()["data"]["map_context"] == "current_public_reference"
    assert before == (db.get(ExperienceRecord, item["id"]).draft,
                      db.scalar(select(func.count()).select_from(ExperienceVersionRecord)),
                      db.scalar(select(func.count()).select_from(AdminAuditRecord)))
    client.cookies.clear()
    assert preview(client, item, old).status_code == 401


def test_version_ownership_scope_and_empty_snapshot_are_not_bypassed(client, db, experiences):
    users, point, other = experiences
    login(client)
    first = save(client, content(point, "tour", stops=[{"point_id": point.id}]))
    old = version(client, first)
    other_item = save(client, content(other))
    assert preview(client, other_item, old).status_code == 404
    assert preview(client, first, old, snapshot="published").status_code == 404
    first = save(client, content(point, "tour", stops=[{"point_id": other.id}]), first)
    users["editor"].point_ids = [other.id]
    db.commit()
    assert client.get(f"{ADMIN}/{first['id']}").status_code == 200
    assert preview(client, first, old).status_code == 404
    assert preview(client, first, {"id": str(uuid4())}).status_code == 404


def test_exact_reference_and_repeated_stop_paths_then_new_public_version_is_placeholder(client, db, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    login(client)
    item = save(client, modern(point, {"type": "image", "id": image["id"], "revision": 1}, repeat=True))
    old = version(client, item)
    for index in range(2):
        response = preview(client, item, old, stop_index=index)
        assert response.status_code == 200, response.text
        row = response.json()["data"]["resources"][0]
        assert row["state"] == "ready" and row["path"] == f"stops.{index}.segments.0.resources.0"
        assert row["revision"] == row["item"]["revision"] == 1
        assert "/history/" in row["item"]["media_url"]
    assert preview(client, item, old, stop_index=2).status_code == 422
    image = action(client, save(client, {**image["published_content"], "title": "最新图片，不能代替旧版"}, image), "submit")
    login(client, "reviewer")
    action(client, image, "publish")
    result = preview(client, item, old).json()["data"]
    assert result["item"]["content"] == item["content"]
    assert result["resources"][0]["state"] == "changed"
    assert result["resources"][0]["item"] is None
    assert "最新图片" not in str(result)
    path = f"{ADMIN}/{item['id']}/history/{old['id']}/media"
    assert client.get(path, params={"path": "stops.0.segments.0.resources.0"}, follow_redirects=False).status_code == 409


def test_legacy_unversioned_media_does_not_fetch_current_version(client, db, experiences):
    _, point, _ = experiences
    video = publish(client, content(point, media_type="video", url="https://example.com/video.mp4"))
    checkin = publish(client, content(point, "checkin"))
    login(client)
    item = save(client, content(point, "tour", stops=[{
        "point_id": point.id, "video_id": video["id"], "checkin_id": checkin["id"],
        "narrative": "旧讲解", "prompt_timing": "after_intro",
    }]))
    old = version(client, item)
    rows = preview(client, item, old).json()["data"]["resources"]
    assert len(rows) == 2 and all(row["state"] == "unversioned" and row["item"] is None for row in rows)
    assert client.get(f"{ADMIN}/{item['id']}/history/{old['id']}/media", params={"path": "stops.0.video_id"}).status_code == 409


def test_self_media_old_upload_read_and_caption_recheck_do_not_use_new_draft(client, db, experiences):
    users, point, other = experiences
    login(client)
    original = upload(client, point)
    vtt = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHistory caption\n"
    # Images cannot adopt captions, so first check owned immutable image bytes.
    item = save(client, content(point, upload_id=original["id"], url=None))
    old = version(client, item)
    second = upload(client, point, image_bytes("red"))
    item = save(client, content(point, upload_id=second["id"], url=None), item)
    row = preview(client, item, old).json()["data"]["resources"][0]
    response = client.get(row["item"]["media_url"])
    assert response.status_code == 200 and response.content == image_bytes()
    assert response.headers["cache-control"] == "no-store"
    assert client.get(row["item"]["media_url"].replace("path=self", "path=other")).status_code == 404
    caption = client.post(f"/api/v1/admin/points/{point.id}/experience-captions", content=vtt, headers={"Content-Type": "text/vtt"})
    assert caption.status_code == 201, caption.text
    video = save(client, content(point, media_type="video", url="https://example.com/history.mp4", caption_upload_id=caption.json()["data"]["id"]))
    video_old = version(client, video)
    projected = preview(client, video, video_old).json()["data"]["item"]
    assert client.get(projected["caption_url"]).content == vtt
    assert client.get(projected["media_url"], follow_redirects=False).headers["location"] == "https://example.com/history.mp4"
    users["editor"].point_ids = [other.id]
    db.commit()
    assert client.get(projected["caption_url"]).status_code == 404
    assert client.get(row["item"]["media_url"]).status_code == 404


def test_withdrawn_resource_preserves_text_without_media(client, db, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    login(client)
    item = save(client, modern(point, {"type": "image", "id": image["id"], "revision": 1}))
    old = version(client, item)
    retire(client, image)
    response = preview(client, item, old)
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["resources"][0]["state"] == "unavailable"
    assert result["resources"][0]["item"] is None
    assert result["item"]["content"]["stops"][0]["segments"][0]["text"] == "历史原文，不能重写。"


def test_historical_adopted_audio_reads_original_after_text_change_without_generation(client, db, narration):
    item, factory = narration
    job = generate(client, db, item, factory)
    item = adopt(client, item, job["asset_id"])
    old = version(client, item)
    candidate = copy.deepcopy(item["content"])
    candidate["stops"][0]["segments"][0]["text"] = "后来修改过的正文"
    candidate["stops"][0]["segments"][0]["narration_asset_id"] = None
    save(client, candidate, item)
    count = db.scalar(select(func.count()).select_from(NarrationJob))
    login(client, "reviewer")
    response = preview(client, item, old)
    assert response.status_code == 200, response.text
    row = response.json()["data"]["resources"][0]
    assert row["state"] == "ready" and row["type"] == "narration"
    chunk = row["narration"]["chunks"][0]
    assert client.get(chunk["url"]).content == wav_bytes()
    assert client.get(chunk["url"].replace("first-segment", "forged-segment")).status_code == 404
    assert db.scalar(select(func.count()).select_from(NarrationJob)) == count


def test_audio_description_child_is_exact_and_parent_update_cannot_create_new_dependency(client, db, experiences):
    _, point, _ = experiences
    description = publish(client, content(point, media_type="video", url="https://example.com/described.mp4"))
    original = publish(client, content(point, media_type="video", url="https://example.com/original.mp4",
        video_visual_information="description_required", audio_description_video_id=description["id"], audio_description_video_revision=1))
    login(client)
    item = save(client, modern(point, {"type": "video", "id": original["id"], "revision": 1}))
    old = version(client, item)
    rows = preview(client, item, old).json()["data"]["resources"]
    assert len(rows) == 2 and all(row["state"] == "ready" for row in rows)
    assert rows[1]["path"].endswith(".audio_description_video_id")
    assert rows[0]["item"]["content"]["audio_description_video_revision"] == 1
    original = action(client, save(client, {**original["published_content"], "title": "新视频版本"}, original), "submit")
    login(client, "reviewer")
    action(client, original, "publish")
    rows = preview(client, item, old).json()["data"]["resources"]
    assert len(rows) == 1 and rows[0]["state"] == "changed"


def test_floor_section_and_vr_are_exact_public_versions_and_remain_placeholders_after_change(client, db, experiences):
    _, point, _ = experiences
    login(client)
    image = floor_upload(client, point)
    floor = resource_action(client, resource_save(client, point, floor_content(image)), "submit")
    vr = resource_action(client, resource_save(client, point, {
        "kind": "panorama", "title": "历史入口", "url": "https://example.com/tour?scene=old",
        "description": "原场景说明",
    }), "submit")
    login(client, "reviewer")
    floor = resource_action(client, floor, "publish")
    vr = resource_action(client, vr, "publish")
    login(client)
    item = save(client, content(point, "tour", stops=[{
        "point_id": point.id, "segments": [{"id": "floor-and-vr", "text": "原文",
          "main_view": {"type": "floor", "id": floor["id"], "revision": 1, "section_id": "a"},
          "resources": [{"type": "vr", "id": vr["id"], "revision": 1}]}],
    }]))
    old = version(client, item)
    rows = preview(client, item, old).json()["data"]["resources"]
    assert rows[0]["state"] == rows[1]["state"] == "ready"
    assert rows[0]["floor"]["images"][0]["section"] == "a"
    assert rows[1]["panorama"]["url"] == "https://example.com/tour?scene=old"
    from app.models import FloorRecord, PanoramaRecord
    db.get(FloorRecord, floor["id"]).revision += 1
    db.get(PanoramaRecord, vr["id"]).revision += 1
    db.commit()
    rows = preview(client, item, old).json()["data"]["resources"]
    assert all(row["state"] in {"changed", "unavailable"} and row["floor"] is None and row["panorama"] is None for row in rows)
