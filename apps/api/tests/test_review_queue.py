"""Per-item queue over real HTTP, with mandatory actual session step-up."""

from datetime import timedelta
from uuid import uuid4

import pytest
from test_admin import action as point_action
from test_admin import create as point_create
from test_admin import login
from test_configurations import action as config_action
from test_configurations import create as config_create
from test_experiences import action, content, save
from test_experiences import experiences as experiences
from test_navigation import setup_roads
from test_resources import action as resource_action
from test_resources import floor_content
from test_resources import save as resource_save
from test_resources import upload as floor_upload

from app.configuration_models import ConfigurationGrantRecord
from app.models import MapRecord, StaffSessionRecord, now_utc
from app.modules.admin.security import COOKIE, digest

QUEUE = "/api/v1/admin/review-queue/publish"


def step_up(client, db, minutes=0):
    # Only this isolated test DB models a completed verifier. Real cryptographic
    # verification/replay/UV is covered by the WebAuthn protocol tests.
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    session.mfa_verified_at = now_utc() - timedelta(minutes=minutes)
    db.commit()


def payload(item, kind="media", **values):
    return {"kind": kind, "id": item["id"], "expected_revision": item["revision"],
        "expected_published_revision": item["published_revision"], "operation_id": str(uuid4()),
        "note": "逐项独立核对测试", "video_accessibility_confirmed": True, **values}


def pending(client, point, kind="media"):
    login(client)
    values = {"media_type": "video", "url": "https://example.com/test.mp4"} if kind == "media" else {}
    return action(client, save(client, content(point, kind, **values)), "submit")


@pytest.mark.parametrize("minutes", [None, 5, 6, -1])
def test_queue_requires_real_recent_mfa_even_during_staged_enrollment(client, db, experiences, minutes):
    _, point, _ = experiences
    item = pending(client, point)
    login(client, "reviewer")
    assert not client.app.state.settings.admin_mfa_enforced
    if minutes is not None:
        step_up(client, db, minutes)
    response = client.post(QUEUE, json=payload(item))
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    assert client.get(f"/api/v1/experiences/{item['id']}").status_code == 404


def test_video_confirmation_exact_versions_and_unknown_receipt_query(client, db, experiences):
    _, point, _ = experiences
    item = pending(client, point)
    login(client, "reviewer")
    step_up(client, db)
    response = client.post(QUEUE, json=payload(item, video_accessibility_confirmed=False))
    assert response.status_code == 409 and response.json()["error"]["code"] == "VIDEO_REVIEW_REQUIRED"
    assert client.post(QUEUE, json=payload(item, expected_revision=999)).status_code == 409
    assert client.post(QUEUE, json=payload(item, expected_published_revision=999)).status_code == 409
    values = payload(item)
    first = client.post(QUEUE, json=values)
    assert first.status_code == 200, first.text
    receipt = client.get(f"/api/v1/admin/operations/{values['operation_id']}")
    assert receipt.status_code == 200
    assert receipt.json()["data"]["target_id"] == item["id"]
    assert receipt.json()["data"]["action"] == "experience.publish"
    assert receipt.json()["data"]["result"] == first.json()["data"]
    again = client.post(QUEUE, json=values)
    assert again.status_code == 200 and again.json()["data"] == first.json()["data"]
    step_up(client, db, 6)
    assert client.post(QUEUE, json=values).status_code == 403, "replay still requires recent MFA"
    assert client.get(f"/api/v1/admin/operations/{values['operation_id']}").status_code == 200, "unknown query remains read-only"


def test_queue_cannot_bypass_role_self_review_scope_csrf_or_type(client, db, experiences):
    users, point, other = experiences
    item = pending(client, point)
    users["editor"].role = "admin"
    db.commit()
    step_up(client, db)
    assert client.post(QUEUE, json=payload(item)).status_code == 403
    login(client, "viewer")
    step_up(client, db)
    assert client.post(QUEUE, json=payload(item)).status_code == 403
    users["reviewer"].point_ids = [other.id]
    db.commit()
    login(client, "reviewer")
    step_up(client, db)
    assert client.post(QUEUE, json=payload(item)).status_code == 404
    users["reviewer"].point_ids = []
    db.commit()
    assert client.post(QUEUE, json=payload(item, "tour")).status_code == 404
    assert client.post(QUEUE, json=payload(item, "administrator")).status_code == 422
    assert client.post(QUEUE, json={**payload(item), "action": "reject"}).status_code == 422
    del client.headers["x-csrf-token"]
    assert client.post(QUEUE, json=payload(item)).status_code == 403


@pytest.mark.parametrize("kind", ["checkin", "tour"])
def test_experience_services_are_reused_for_non_video_items(client, db, experiences, kind):
    _, point, _ = experiences
    values = {"stops": [{"point_id": point.id}]} if kind == "tour" else {}
    login(client)
    item = action(client, save(client, content(point, kind, **values)), "submit")
    login(client, "reviewer")
    step_up(client, db)
    result = client.post(QUEUE, json=payload(item, kind))
    assert result.status_code == 200, result.text
    assert result.json()["data"]["state"] == "published"


@pytest.mark.parametrize("kind", ["floor", "panorama"])
def test_resources_reuse_original_publication_and_storage_guard(client, db, experiences, kind):
    _, point, _ = experiences
    login(client)
    data = floor_content(floor_upload(client, point)) if kind == "floor" else {
        "kind": "panorama", "title": "人工测试入口", "url": "https://example.com/vr"}
    item = resource_action(client, resource_save(client, point, data), "submit")
    login(client, "reviewer")
    step_up(client, db)
    values = {"id": item["id"], "revision": item["draft"]["revision"], "published_revision": item["published_revision"]}
    result = client.post(QUEUE, json=payload(values, kind))
    assert result.status_code == 200, result.text
    assert result.json()["data"]["published_revision"] == 1


def test_point_service_and_configuration_specific_grants_are_preserved(client, db, experiences):
    users, _, _ = experiences
    m = db.query(MapRecord).first()
    login(client)
    point = point_action(client, point_create(client, m), "submit")
    login(client, "reviewer")
    step_up(client, db)
    values = {"id": point["point"]["id"], "revision": point["draft"]["revision"], "published_revision": point["point"]["revision"]}
    result = client.post(QUEUE, json=payload(values, "point"))
    assert result.status_code == 200, result.text
    db.add(ConfigurationGrantRecord(user_id=users["editor"].id, permission="configurations.edit", scope="global", granted_by=users["admin"].id, note="测试"))
    db.commit()
    login(client)
    config = config_action(client, config_create(client), "submit")
    login(client, "reviewer")
    step_up(client, db)
    assert client.post(QUEUE, json=payload(config, "configuration")).status_code == 404
    db.add(ConfigurationGrantRecord(user_id=users["reviewer"].id, permission="configurations.review", scope="global", granted_by=users["admin"].id, note="测试"))
    db.commit()
    result = client.post(QUEUE, json=payload(config, "configuration"))
    assert result.status_code == 200, result.text
    assert result.json()["data"]["published_revision"] == 1


def test_navigation_uses_frozen_graph_and_independent_contributor_checks(client, db):
    users, m, _, graph = setup_roads(client, db)
    login(client)
    url = f"/api/v1/admin/navigation/{m.id}"
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 200
    result = client.post(url + "/review", json={"expected_revision": 1, "action": "submit", "note": "测试提审"})
    assert result.status_code == 200
    values = {"id": m.id, "revision": 2, "published_revision": 0}
    users["editor"].role = "admin"
    db.commit()
    step_up(client, db)
    assert client.post(QUEUE, json=payload(values, "navigation")).status_code == 403
    login(client, "reviewer")
    step_up(client, db)
    done = client.post(QUEUE, json=payload(values, "navigation"))
    assert done.status_code == 200, done.text
    assert done.json()["data"]["published_revision"] == 1


def test_items_commit_independently_with_auditable_partial_success(client, db, experiences):
    _, point, _ = experiences
    first = pending(client, point)
    second = pending(client, point)
    login(client, "reviewer")
    step_up(client, db)
    result = client.post(QUEUE, json=payload(first))
    assert result.status_code == 200
    result = client.post(QUEUE, json=payload(second, video_accessibility_confirmed=False))
    assert result.status_code == 409
    assert client.get(f"/api/v1/experiences/{first['id']}").status_code == 200
    assert client.get(f"/api/v1/experiences/{second['id']}").status_code == 404
