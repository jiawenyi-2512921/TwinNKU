"""Ordered route authoring and private previews use the same public resource rules."""

import copy
from uuid import uuid4

import pytest
from test_admin import BASE, login
from test_experiences import ADMIN, PUBLIC, action, content, publish, retire, save
from test_experiences import experiences as experiences
from test_resources import action as resource_action
from test_resources import floor_content
from test_resources import save as resource_save
from test_resources import upload as floor_upload

from app.models import ExperienceRecord, FloorRecord, PanoramaRecord


def segment(key="chapter-1", **values):
    return {"id": key, "text": "真实资料由编辑填写", "source_note": "测试来源", **values}


def reference(item, kind="image"):
    return {"type": kind, "id": item["id"], "revision": item["published_revision"]}


def test_ordered_segments_cover_and_repeated_points(client, db, experiences):
    _, point, other = experiences
    image = publish(client, content(point))
    video = publish(client, content(point, media_type="video", url="https://example.com/v.mp4"))
    checkin = publish(client, content(point, "checkin", image_id=image["id"]))
    stops = [
        {
            "point_id": point.id,
            "title": "同地点第一站",
            "segments": [
                segment("image-first", main_view=reference(image)),
                segment(
                    "video-next",
                    resources=[reference(video, "video"), reference(checkin, "checkin")],
                ),
            ],
        },
        {"point_id": other.id, "segments": [segment("other-stop")]},
        {"point_id": point.id, "segments": [segment("return-stop")]},
    ]
    item = publish(
        client,
        content(
            point,
            "tour",
            stops=stops,
            cover_image_id=image["id"],
            cover_image_revision=image["published_revision"],
        ),
    )
    data = client.get(f"{PUBLIC}/{item['id']}").json()["data"]["content"]
    assert [s["point_id"] for s in data["stops"]] == [point.id, other.id, point.id]
    assert [s["id"] for s in data["stops"][0]["segments"]] == ["image-first", "video-next"]
    assert data["cover_image_id"] == image["id"]


def test_legacy_fifty_stops_are_read_without_rewriting_snapshot(client, db, experiences):
    _, point, _ = experiences
    video = publish(client, content(point, media_type="video", url="https://example.com/v.mp4"))
    item = publish(
        client,
        content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "narrative": f"原文 {i}",
                    "video_id": video["id"],
                    "prompt_timing": "after_intro",
                }
                for i in range(50)
            ],
        ),
    )
    record = db.get(ExperienceRecord, item["id"])
    old = copy.deepcopy(record.published)
    old.pop("cover_image_id", None)
    old.pop("cover_image_revision", None)
    for stop in old["stops"]:
        stop.pop("segments", None)
        stop.pop("title", None)
    record.published = old
    db.commit()
    revision = record.published_revision
    result = client.get(f"{PUBLIC}/{item['id']}")
    assert result.status_code == 200
    assert len(result.json()["data"]["content"]["stops"]) == 50
    assert result.json()["data"]["content"]["stops"][49]["narrative"] == "原文 49"
    db.refresh(record)
    assert record.published == old and record.published_revision == revision


@pytest.mark.parametrize(
    "stops",
    [
        lambda point: [{"point_id": point.id, "segments": [segment("same"), segment("same")]}],
        lambda point: [
            {"point_id": point.id, "segments": [segment("same")]},
            {"point_id": point.id, "segments": [segment("same")]},
        ],
        lambda point: [{"point_id": point.id, "segments": []}],
        lambda point: [{"point_id": point.id, "segments": [segment("has spaces")]}],
    ],
)
def test_invalid_segment_identity_is_rejected(client, db, experiences, stops):
    _, point, _ = experiences
    login(client)
    save(client, content(point, "tour", stops=stops(point)), expected=422)


@pytest.mark.parametrize(
    "mutation",
    ["wrong_point", "wrong_type", "stale_revision", "unknown", "duplicate", "invalid_main_view"],
)
def test_typed_references_are_validated_at_save(client, db, experiences, mutation):
    _, point, other = experiences
    image = publish(client, content(point))
    ref = reference(image)
    stop = {"point_id": point.id, "segments": [segment(resources=[ref])]}
    expected = 409
    if mutation == "wrong_point":
        stop["point_id"] = other.id
    elif mutation == "wrong_type":
        ref["type"] = "video"
    elif mutation == "stale_revision":
        ref["revision"] += 1
    elif mutation == "unknown":
        ref["id"] = str(uuid4())
    elif mutation == "duplicate":
        stop["segments"][0]["resources"].append(dict(ref))
        expected = 422
    else:
        stop["segments"][0]["main_view"] = {**ref, "type": "video"}
        expected = 422
    login(client)
    save(client, content(point, "tour", stops=[stop]), expected=expected)


def test_cover_cannot_reference_another_point_or_route(client, db, experiences):
    _, point, other = experiences
    image = publish(client, content(other))
    login(client)
    data = content(point, "tour", stops=[{"point_id": point.id}])
    save(
        client,
        {
            **data,
            "cover_image_id": image["id"],
            "cover_image_revision": image["published_revision"],
        },
        expected=409,
    )
    draft = save(client, data)
    save(
        client,
        {**data, "cover_image_id": draft["id"], "cover_image_revision": 1},
        draft,
        expected=409,
    )


def test_retired_reference_blocks_submit_review_and_whole_public_route(client, db, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    data = content(
        point,
        "tour",
        stops=[{"point_id": point.id, "segments": [segment(main_view=reference(image))]}],
    )
    item = publish(client, data)
    login(client)
    editing = save(client, data, item)
    pending = action(client, editing, "submit")
    retire(client, image)
    assert client.get(f"{PUBLIC}/{item['id']}").status_code == 404
    assert not any(row["id"] == item["id"] for row in client.get(PUBLIC).json()["data"])
    login(client, "reviewer")
    action(client, pending, "publish", expected=409)
    login(client)
    discarded = action(client, pending, "discard")
    # Invalid references are also blocked before a new draft can be saved.
    save(client, data, discarded, expected=409)


def test_private_saved_preview_requires_session_scope_and_current_revision(client, db, experiences):
    users, point, other = experiences
    login(client)
    item = save(
        client, content(point, "tour", stops=[{"point_id": point.id, "segments": [segment()]}])
    )
    path = f"{ADMIN}/{item['id']}/preview?expected_revision={item['revision']}"
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["data"]["content"]["stops"][0]["segments"][0]["id"] == "chapter-1"
    assert client.get(path.replace("expected_revision=1", "expected_revision=2")).status_code == 409
    assert client.get(f"{PUBLIC}/{item['id']}").status_code == 404
    users["editor"].point_ids = [other.id]
    db.commit()
    assert client.get(path).status_code == 404
    users["editor"].point_ids = []
    db.commit()
    client.post(f"{BASE}/auth/logout")
    assert client.get(path).status_code == 401


def test_reference_retirement_between_save_and_submit_is_rechecked(client, db, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    login(client)
    draft = save(
        client,
        content(
            point,
            "tour",
            stops=[{"point_id": point.id, "segments": [segment(resources=[reference(image)])]}],
        ),
    )
    retire(client, image)
    login(client)
    action(client, draft, "submit", expected=409)
    assert db.get(ExperienceRecord, draft["id"]).state == "draft"


@pytest.mark.parametrize("kind", ["floor", "vr"])
def test_floor_and_vr_references_require_the_exact_public_point_and_revision(
    client, db, experiences, kind
):
    _, point, other = experiences
    login(client)
    candidate = (
        floor_content(floor_upload(client, point))
        if kind == "floor"
        else {"kind": "panorama", "title": "真实来源测试", "url": "https://example.com/scene"}
    )
    pending = resource_action(client, resource_save(client, point, candidate), "submit")
    login(client, "reviewer")
    published = resource_action(client, pending, "publish")
    ref = {"type": kind, "id": published["id"], "revision": published["published_revision"]}
    data = content(
        point, "tour", stops=[{"point_id": point.id, "segments": [segment(resources=[ref])]}]
    )
    tour = publish(client, data)
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 200
    login(client)
    wrong_point = content(
        other, "tour", stops=[{"point_id": other.id, "segments": [segment(resources=[ref])]}]
    )
    save(client, wrong_point, expected=409)
    save(
        client,
        content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [segment(resources=[{**ref, "revision": ref["revision"] + 1}])],
                }
            ],
        ),
        expected=409,
    )
    record = db.get(FloorRecord if kind == "floor" else PanoramaRecord, ref["id"])
    record.status = "retired"
    db.commit()
    assert client.get(f"{PUBLIC}/{tour['id']}").status_code == 404
