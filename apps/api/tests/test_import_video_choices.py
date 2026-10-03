"""Real scoped name choices and explicit version binding for described video."""

from uuid import uuid4

from test_admin import login
from test_experiences import PUBLIC, content, publish
from test_import_exports import imports as imports
from test_import_jobs import commit, upload
from test_resources import make_resource_point

from app.models import ExperienceRecord


def video(point, **kwargs):
    return content(point, media_type="video", url="https://example.com/test.mp4", **kwargs)


def test_name_catalog_filters_audio_complete_before_paging_and_exact_preview(client, db, imports):
    _, _, point = imports
    target = publish(client, video(point, title="正式口述描述夹具"))
    publish(client, video(point, title="无声夹具", video_visual_information="silent", transcript="等价说明"))
    publish(client, video(make_resource_point(db), title="其他地点夹具"))
    login(client)
    params = {"kind": "video", "point_id": point.id, "purpose": "audio_description", "page_size": 1}
    response = client.get("/api/v1/admin/import-references", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["meta"]["pagination"]["total"] == 1
    candidate = body["data"][0]
    assert candidate["id"] == target["id"] and candidate["audio_description_eligible"]
    assert candidate["preview_url"] == f"{PUBLIC}/{target['id']}/media/{target['published_revision']}"
    preview = client.get(candidate["preview_url"], follow_redirects=False)
    assert preview.status_code == 307 and preview.headers["cache-control"] == "no-store"
    assert client.get(candidate["preview_url"] + "0").status_code == 404
    assert client.get("/api/v1/admin/import-references", params={"kind": "image", "purpose": "audio_description", "point_id": point.id}).status_code == 422
    assert client.get("/api/v1/admin/import-references", params={"kind": "video", "purpose": "audio_description"}).status_code == 422
    point.visibility = "internal"
    db.commit()
    assert client.get(candidate["preview_url"]).status_code == 404
    assert client.get("/api/v1/admin/import-references", params=params).json()["data"] == []


def test_import_description_name_choice_rechecks_exact_revision_at_commit(client, db, imports):
    _, _, point = imports
    target = publish(client, video(point))
    login(client)
    item = upload(client, "media", [{"point_id": point.id, "media_type": "video", "title": "新原版夹具",
        "url": "https://example.com/original.mp4", "source_note": "仅测试", "video_visual_information": "description_required",
        "video_accessibility_note": "人工核对说明"}]).json()["data"]
    response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={
        "expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "audio_description_video_id",
        "kind": "video", "id": target["id"], "revision": target["published_revision"]}]})
    assert response.status_code == 200, response.text
    item = response.json()["data"]
    assert item["preview"][0]["action"] == "create", item
    record = db.get(ExperienceRecord, target["id"])
    record.published_revision += 1
    db.commit()
    assert commit(client, item).status_code == 409
    assert client.get(f"{PUBLIC}/{target['id']}/media/1").status_code == 404


def test_description_choice_cannot_bind_incomplete_or_wrong_point(client, db, imports):
    _, _, point = imports
    wrong = publish(client, video(make_resource_point(db)))
    silent = publish(client, video(point, video_visual_information="silent", transcript="等价说明"))
    login(client)
    item = upload(client, "media", [{"point_id": point.id, "media_type": "video", "title": "原版",
        "url": "https://example.com/original.mp4", "source_note": "仅测试", "video_visual_information": "description_required",
        "video_accessibility_note": "人工核对说明"}]).json()["data"]
    for candidate in (wrong, silent):
        response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={
            "expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "audio_description_video_id",
                "kind": "video", "id": candidate["id"], "revision": candidate["published_revision"]}]})
        assert response.status_code in {200, 409}, response.text
        if response.status_code == 200:
            item = response.json()["data"]
            assert item["preview"][0]["action"] == "error"
            assert commit(client, item).status_code == 409
    response = client.post(f"/api/v1/admin/import-jobs/{item['id']}/references", json={
        "expected_preview_sha256": item["preview_sha256"], "bindings": [{"rows": [2], "field": "audio_description_video_id",
            "kind": "image", "id": str(uuid4()), "revision": 1}]})
    assert response.status_code == 422
