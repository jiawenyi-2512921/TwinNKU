"""Real authorized issue navigation, keyset pagination and read-only budgets."""

import copy
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from test_admin import BASE, login, seed_staff
from test_admin import create as point_create
from test_configurations import create as config_create
from test_experience_segments import reference, segment
from test_experiences import action, content, publish, save
from test_experiences import experiences as experiences
from test_resources import make_resource_point

from app.configuration_models import ConfigurationGrantRecord
from app.models import AdminAuditRecord, ExperienceRecord, MapRecord, StaffSessionRecord, now_utc
from app.modules.admin.security import COOKIE, digest, utc

ISSUES = BASE + "/workbench/issues"


def check(client, **params):
    response = client.get(ISSUES, params=params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_issues_require_auth_typed_filters_and_never_create_state(client, db):
    seed_staff(client, db)
    assert client.get(ISSUES).status_code == 401
    login(client)
    for params in [
        dict(limit=0),
        dict(limit=21),
        dict(entity_type="script"),
        dict(entity_id=str(uuid4())),
        dict(cursor="%%%"),
    ]:
        assert client.get(ISSUES, params=params).status_code == 422
    assert check(client) == {
        "coverage": "saved_entity_page",
        "checked_entity_count": 0,
        "issue_count": 0,
        "items": [],
        "has_more": False,
        "next_cursor": None,
        "omitted_issue_count": 0,
    }
    assert check(client, entity_type="tour", entity_id=str(uuid4()))["items"] == []
    assert client.get(ISSUES, params={"campus_id": "unauthorized-campus"}).status_code == 404


def test_real_stale_reference_locates_repeated_stop_segment_and_versions(client, db, experiences):
    _, point, _ = experiences
    image = publish(client, content(point))
    login(client)
    item = save(
        client,
        content(
            point,
            "tour",
            stops=[
                {"point_id": point.id, "segments": [segment("first")]},
                {
                    "point_id": point.id,
                    "segments": [segment("second", resources=[reference(image)])],
                },
            ],
        ),
    )
    resource = db.get(ExperienceRecord, image["id"])
    resource.published_revision += 1
    db.commit()
    session = db.get(StaffSessionRecord, digest(client.cookies[COOKIE]))
    old_activity = session.last_activity_at = now_utc() - timedelta(minutes=2)
    db.commit()
    previous = copy.deepcopy(db.get(ExperienceRecord, item["id"]).draft)
    audits = db.scalar(select(func.count()).select_from(AdminAuditRecord))
    result = check(client, entity_type="tour", entity_id=item["id"])
    issue = next(i for i in result["items"] if i["code"] == "RESOURCE_REVISION_CHANGED")
    assert (issue["stop_index"], issue["segment_id"], issue["path"]) == (
        1,
        "second",
        "stops.1.segments.0.resources.0",
    )
    assert issue["resource_id"] == image["id"] and issue["resource_type"] == "image"
    assert issue["expected_revision"] == image["published_revision"]
    assert issue["current_revision"] == resource.published_revision
    assert issue["revision"] == item["revision"] and "replace_reference" in issue["actions"]
    assert result["checked_entity_count"] == 1 and not result["has_more"]
    assert "真实资料由编辑填写" not in str(result) and "source_note" not in str(result)
    db.expire_all()
    assert utc(db.get(StaffSessionRecord, session.token_hash).last_activity_at) == utc(old_activity)
    assert db.get(ExperienceRecord, item["id"]).draft == previous
    assert db.scalar(select(func.count()).select_from(AdminAuditRecord)) == audits


def test_scope_is_before_paging_for_both_tour_snapshots_and_no_private_counts(
    client, db, experiences
):
    users, first, second = experiences
    login(client)
    allowed = save(client, content(first, title="Allowed draft"))
    hidden = save(
        client,
        content(
            first,
            "tour",
            title="Private other-stop title",
            stops=[{"point_id": first.id}, {"point_id": second.id}],
        ),
    )
    row = db.get(ExperienceRecord, hidden["id"])
    # Older still-public snapshot keeps the second stop in the detail guard.
    row.published = copy.deepcopy(row.draft)
    row.draft = {**row.draft, "stops": [{"point_id": first.id}]}
    row.updated_at = now_utc() + timedelta(seconds=20)
    users["reviewer"].point_ids = [first.id]
    db.commit()
    login(client, "reviewer")
    result = check(client, limit=1)
    assert result["checked_entity_count"] == 1 and not result["has_more"]
    assert {i["entity_id"] for i in result["items"]} == {allowed["id"]}
    assert "Private other-stop title" not in str(result)
    assert check(client, entity_type="tour", entity_id=hidden["id"])["checked_entity_count"] == 0
    # Draft-only denied stop is equally excluded before the page boundary.
    row.draft, row.published = row.published, row.draft
    db.commit()
    assert check(client, entity_type="tour")["checked_entity_count"] == 0


def test_keyset_pages_can_reach_old_saved_content_and_cursor_binds_scope(client, db, experiences):
    users, point, _ = experiences
    login(client)
    items = [save(client, content(point, title=f"Saved {i}")) for i in range(4)]
    timestamp = now_utc() - timedelta(days=15)
    for item in items:
        db.get(ExperienceRecord, item["id"]).updated_at = timestamp
    db.commit()
    seen, cursor, first_cursor = [], None, None
    for n in range(4):
        page = check(client, entity_type="media", limit=1, **({"cursor": cursor} if cursor else {}))
        seen.append(page["items"][0]["entity_id"])
        assert page["has_more"] == (n < 3)
        cursor = page["next_cursor"]
        first_cursor = first_cursor or cursor
    assert set(seen) == {i["id"] for i in items} and len(set(seen)) == 4
    assert (
        client.get(ISSUES, params={"entity_type": "tour", "cursor": first_cursor}).status_code
        == 422
    )
    users["editor"].point_ids = [point.id]
    db.commit()
    assert (
        client.get(ISSUES, params={"entity_type": "media", "cursor": first_cursor}).status_code
        == 422
    )


def test_actions_keep_independent_review_and_reviewer_read_only(client, db, experiences):
    users, point, _ = experiences
    login(client)
    item = action(client, save(client, content(point)), "submit")
    own = check(client, entity_type="media", entity_id=item["id"])["items"][0]
    assert (
        "withdraw" in own["actions"]
        and "review" not in own["actions"]
        and "edit" not in own["actions"]
    )
    login(client, "reviewer")
    other = check(client, entity_type="media", entity_id=item["id"])["items"][0]
    assert other["actions"] == ["open", "review"]
    row = db.get(ExperienceRecord, item["id"])
    row.contributor_ids = [*row.contributor_ids, users["reviewer"].id]
    db.commit()
    assert check(client, entity_type="media", entity_id=item["id"])["items"][0]["actions"] == [
        "open"
    ]
    login(client, "viewer")
    assert check(client, entity_type="media")["items"][0]["actions"] == ["open"]


def test_configuration_requires_explicit_grants_and_hides_foreign_resource_version(client, db):
    users, _ = seed_staff(client, db)
    first, other = make_resource_point(db), make_resource_point(db)
    image = publish(client, content(other))
    grant = ConfigurationGrantRecord(
        user_id=users["editor"].id,
        permission="configurations.edit",
        scope="global",
        granted_by=users["admin"].id,
        note="test",
    )
    db.add(grant)
    db.commit()
    login(client)
    config = config_create(
        client,
        content={
            "kind": "presentation",
            "modules": [
                {
                    "id": "hero",
                    "type": "hero",
                    "image": {
                        "type": "image",
                        "id": image["id"],
                        "revision": image["published_revision"],
                    },
                    "alt": "Image",
                }
            ],
        },
    )
    users["editor"].point_ids = [first.id]
    image_row = db.get(ExperienceRecord, image["id"])
    image_row.published_revision += 1
    db.commit()
    result = check(client, entity_type="configuration", entity_id=config["id"])
    issue = next(i for i in result["items"] if i["path"] == "modules.0.image")
    assert issue["resource_id"] is None and issue["current_revision"] is None
    assert issue["actions"] == ["open", "edit", "replace_reference"]
    login(client, "admin")
    assert (
        check(client, entity_type="configuration")["checked_entity_count"] == 0
    )  # role alone never grants config access
    db.add(
        ConfigurationGrantRecord(
            user_id=users["reviewer"].id,
            permission="configurations.review",
            scope="global",
            granted_by=users["admin"].id,
            note="test",
        )
    )
    db.commit()
    login(client, "reviewer")
    assert check(client, entity_type="configuration")["items"][0]["actions"] == ["open"]


def test_large_validation_budget_reports_deferred_instead_of_false_health(
    client, db, experiences, monkeypatch
):
    from app.modules.admin import issues

    _, point, _ = experiences
    login(client)
    item = save(
        client,
        content(
            point,
            "tour",
            stops=[{"point_id": point.id, "segments": [segment("one"), segment("two")]}],
        ),
    )
    monkeypatch.setattr(issues, "MAX_REFERENCE_CHECKS", 1)
    result = check(client, entity_type="tour", entity_id=item["id"])
    assert result["checked_entity_count"] == 1
    assert any(i["code"] == "DETAIL_CHECK_REQUIRED" for i in result["items"])


def test_unpublished_repeated_point_locates_each_stop(client, db, experiences):
    _, first, second = experiences
    login(client)
    item = save(
        client,
        content(
            first,
            "tour",
            stops=[
                {"point_id": first.id, "segments": [segment("one")]},
                {"point_id": second.id, "segments": [segment("two")]},
                {"point_id": first.id, "segments": [segment("three")]},
            ],
        ),
    )
    first.status = "retired"
    db.commit()
    result = check(client, entity_type="tour", entity_id=item["id"])
    issues = [i for i in result["items"] if i["code"] == "POINT_NOT_PUBLIC"]
    assert [(i["stop_index"], i["path"]) for i in issues] == [(0, "stops.0"), (2, "stops.2")]
    assert all(i["resource_id"] == first.id and i["resource_type"] == "point" for i in issues)


def test_legacy_stops_count_against_validation_budget(client, db, experiences, monkeypatch):
    from app.modules.admin import issues

    _, point, _ = experiences
    login(client)
    item = save(client, content(point, "tour", stops=[{"point_id": point.id} for _ in range(4)]))
    monkeypatch.setattr(issues, "MAX_REFERENCE_CHECKS", 2)
    result = check(client, entity_type="tour", entity_id=item["id"])
    assert any(i["code"] == "DETAIL_CHECK_REQUIRED" for i in result["items"])


def test_null_retirement_draft_is_a_real_pending_action_then_disappears(client, db, experiences):
    _, point, _ = experiences
    item = publish(client, content(point))
    login(client)
    response = client.post(
        BASE + f"/experiences/{item['id']}/retire",
        json={
            "expected_revision": item["revision"],
            "expected_published_revision": item["published_revision"],
            "note": "test retirement",
        },
    )
    assert response.status_code == 200, response.text
    pending = response.json()["data"]
    assert db.get(ExperienceRecord, item["id"]).draft is None
    result = check(client, entity_type="media", entity_id=item["id"])
    assert result["checked_entity_count"] == 1 and result["items"][0]["code"] == "REVIEW_PENDING"
    login(client, "reviewer")
    action(client, pending, "publish")
    assert check(client, entity_type="media", entity_id=item["id"])["checked_entity_count"] == 0


def test_point_stale_map_exposes_only_authorized_revision_and_exact_geometry_path(client, db):
    _, map_info = seed_staff(client, db)
    login(client)
    item = point_create(client, map_info)
    m = db.get(MapRecord, map_info.id)
    m.revision += 1
    db.commit()
    result = check(client, entity_type="point", entity_id=item["point"]["id"])
    issue = next(i for i in result["items"] if i["severity"] == "error")
    assert issue["path"] == "geometry" and issue["resource_type"] == "map"
    assert (
        issue["resource_id"] == m.id
        and issue["expected_revision"] == 1
        and issue["current_revision"] == 2
    )


@pytest.mark.parametrize("state,code", [("rejected", "REVIEW_REJECTED"), ("draft", "DRAFT_SAVED")])
def test_workflow_states_are_real_and_never_include_private_rejection_body(
    client, db, experiences, state, code
):
    _, point, _ = experiences
    login(client)
    item = save(client, content(point))
    row = db.get(ExperienceRecord, item["id"])
    row.state, row.review_note = state, "private reviewer paragraph not returned"
    db.commit()
    result = check(client, entity_type="media", entity_id=item["id"])
    assert result["items"][0]["code"] == code
    assert "private reviewer paragraph" not in str(result)
