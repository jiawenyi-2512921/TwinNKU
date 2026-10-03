"""Real HTTP idempotency, historical scope and exact reviewed experience snapshots."""

import copy
from datetime import timedelta
from importlib import import_module
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, func, select
from test_admin import BASE, login
from test_experiences import ADMIN, PUBLIC, action, content, publish, retire, save
from test_experiences import experiences as experiences
from test_narration import adopt, generate
from test_narration import narration as narration

from app.content_history_models import (
    ExperienceOperationRecord,
    ExperienceSubmissionRecord,
    ExperienceVersionRecord,
)
from app.models import ExperienceRecord, StaffSessionRecord, StaffUserRecord, now_utc
from app.modules.admin.security import COOKIE, digest
from app.modules.experiences import experience_digest


def body(item, **values):
    return {
        "expected_revision": item["revision"],
        "expected_published_revision": item["published_revision"],
        "operation_id": str(uuid4()),
        "note": "明确人工操作",
        **values,
    }


def draft_action(client, item, verb, expected=200, payload=None):
    response = client.post(f"{ADMIN}/{item['id']}/{verb}", json=payload or body(item))
    assert response.status_code == expected, response.text
    return response.json().get("data")


def test_empty_private_draft_requires_completion_before_submission(client, db, experiences):
    _, point, _ = experiences
    login(client)
    item = save(client, {"kind": "tour", "campus_id": point.campus_id, "stops": []})
    assert item["content"]["stops"] == []
    preflight = draft_action(client, item, "preflight")
    assert not preflight["valid"]
    assert {i["path"] for i in preflight["issues"]} == {"title", "source_note", "stops"}
    action(client, item, "submit", expected=409)
    assert client.get(f"{PUBLIC}/{item['id']}").status_code == 404
    item = save(client, content(point, "tour", stops=[{"point_id": point.id}]), item)
    assert draft_action(client, item, "preflight")["valid"]
    assert action(client, item, "submit")["submitted_at"]


def test_create_save_and_operation_replay_do_not_duplicate_or_increment_noops(
    client, db, experiences
):
    users, point, _ = experiences
    login(client)
    payload = {
        "expected_revision": 0,
        "expected_published_revision": 0,
        "operation_id": str(uuid4()),
        "content": content(point),
    }
    first = client.post(ADMIN, json=payload)
    replay = client.post(ADMIN, json=payload)
    assert first.status_code == replay.status_code == 201
    item = first.json()["data"]
    assert replay.json()["data"] == item
    assert db.scalar(select(func.count()).select_from(ExperienceRecord)) == 1
    same = body(item, content=item["content"])
    no_op = client.put(f"{ADMIN}/{item['id']}", json=same)
    assert no_op.status_code == 200 and no_op.json()["data"]["revision"] == item["revision"]
    assert db.scalar(select(func.count()).select_from(ExperienceVersionRecord)) == 1
    assert (
        client.get(f"{BASE}/operations/{same['operation_id']}").json()["data"]["action"]
        == "experience.save"
    )
    altered = {**same, "content": {**item["content"], "title": "不同请求"}}
    assert client.put(f"{ADMIN}/{item['id']}", json=altered).status_code == 409
    login(client, "reviewer")
    assert client.get(f"{BASE}/operations/{same['operation_id']}").status_code == 404
    assert db.get(ExperienceOperationRecord, (users["editor"].id, same["operation_id"]))


def test_exact_submission_hash_blocks_same_revision_mutation(client, db, experiences):
    _, point, _ = experiences
    login(client)
    pending = action(client, save(client, content(point)), "submit")
    record = db.get(ExperienceRecord, pending["id"])
    record.draft = {**record.draft, "description": "未经重新提审的数据库修改"}
    db.commit()
    login(client, "reviewer")
    response = client.post(f"{ADMIN}/{pending['id']}/review/publish", json=body(pending))
    assert response.status_code == 409 and response.json()["error"]["code"] == "SUBMISSION_CHANGED"
    assert record.published is None
    assert db.get(ExperienceSubmissionRecord, pending["id"]).content_sha256 != experience_digest(
        record
    )


def test_publish_requires_recent_mfa_even_when_role_and_scope_are_valid(client, db, experiences):
    users, point, _ = experiences
    login(client)
    pending = action(client, save(client, content(point)), "submit")
    login(client, "reviewer")
    users["reviewer"].mfa_enabled = True
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    response = client.post(f"{ADMIN}/{pending['id']}/review/publish", json=body(pending))
    assert (
        response.status_code == 403 and response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    )


def test_checkpoint_restore_only_creates_new_draft_and_preserves_formal_snapshot(
    client, db, experiences
):
    _, point, _ = experiences
    item = publish(client, content(point))
    formal = copy.deepcopy(item["published_content"])
    login(client)
    before = draft_action(client, item, "checkpoint")
    assert before["revision"] == item["revision"]
    version = next(
        v
        for v in client.get(f"{ADMIN}/{item['id']}/history").json()["data"]
        if v["event"] == "checkpoint"
    )
    edited = save(client, {**formal, "title": "后来的草稿名称"}, item)
    payload = body(edited)
    restored = draft_action(
        client, edited, f"history/{version['id']}/restore-draft", payload=payload
    )
    assert restored["revision"] == edited["revision"] + 1 and restored["state"] == "draft"
    assert restored["content"] == formal and restored["published_content"] == formal
    assert restored["published_revision"] == item["published_revision"]
    replay = draft_action(client, edited, f"history/{version['id']}/restore-draft", payload=payload)
    assert replay == restored
    assert client.get(f"{PUBLIC}/{item['id']}").json()["data"]["content"] == formal


def test_historical_points_must_still_be_in_readers_current_scope(client, db, experiences):
    users, point, other = experiences
    login(client)
    item = save(client, content(point, "tour", stops=[{"point_id": point.id}]))
    old_version = client.get(f"{ADMIN}/{item['id']}/history").json()["data"][0]
    item = save(client, content(point, "tour", stops=[{"point_id": other.id}]), item)
    users["editor"].point_ids = [other.id]
    db.commit()
    assert client.get(f"{ADMIN}/{item['id']}").status_code == 200
    histories = client.get(f"{ADMIN}/{item['id']}/history").json()["data"]
    assert old_version["id"] not in {v["id"] for v in histories}
    draft_action(client, item, f"history/{old_version['id']}/restore-draft", expected=404)


def test_old_operation_result_does_not_disclose_points_removed_from_current_scope(
    client, db, experiences
):
    users, point, other = experiences
    login(client)
    payload = {
        "expected_revision": 0,
        "expected_published_revision": 0,
        "operation_id": str(uuid4()),
        "content": content(
            point, "tour", stops=[{"point_id": point.id, "narrative": "仅原范围员工可读的草稿"}]
        ),
    }
    item = client.post(ADMIN, json=payload).json()["data"]
    save(client, content(point, "tour", stops=[{"point_id": other.id}]), item)
    users["editor"].point_ids = [other.id]
    db.commit()
    assert client.get(f"{ADMIN}/{item['id']}").status_code == 200
    assert client.get(f"{BASE}/operations/{payload['operation_id']}").status_code == 404
    assert client.post(ADMIN, json=payload).status_code == 404


def test_stale_historical_reference_can_be_restored_privately_but_not_republished(
    client, db, experiences
):
    _, point, _ = experiences
    image = publish(client, content(point))
    login(client)
    data = content(
        point,
        "tour",
        stops=[
            {
                "point_id": point.id,
                "segments": [
                    {
                        "id": "source",
                        "resources": [{"type": "image", "id": image["id"], "revision": 1}],
                    }
                ],
            }
        ],
    )
    item = save(client, data)
    version = client.get(f"{ADMIN}/{item['id']}/history").json()["data"][0]
    item = save(client, content(point, "tour", stops=[{"point_id": point.id}]), item)
    retire(client, image)
    login(client)
    restored = draft_action(client, item, f"history/{version['id']}/restore-draft")
    preflight = draft_action(client, restored, "preflight")
    assert not preflight["valid"]
    assert any(i["path"] == "stops.0.segments.0.resources.0" for i in preflight["issues"])
    action(client, restored, "submit", expected=409)


def test_copy_new_identity_and_legacy_conversion_preserve_exact_content_and_timing(
    client, db, experiences
):
    _, point, _ = experiences
    video = publish(client, content(point, media_type="video", url="https://example.com/test.mp4"))
    checkin = publish(client, content(point, "checkin"))
    login(client)
    text = "完整原讲解。" * 800
    data = content(
        point,
        "tour",
        stops=[
            {
                "point_id": point.id,
                "narrative": text,
                "video_id": video["id"],
                "checkin_id": checkin["id"],
                "prompt_timing": "after_intro",
            }
        ],
    )
    item = save(client, data)
    converted = draft_action(client, item, "convert-legacy")
    stop = converted["content"]["stops"][0]
    assert stop["narrative"] == stop["segments"][0]["text"] == text
    assert stop["prompt_timing"] == "after_intro" and stop["legacy_media_compat"]
    assert stop["video_id"] == video["id"] and stop["checkin_id"] == checkin["id"]
    assert {(r["type"], r["revision"]) for r in stop["segments"][0]["resources"]} == {
        ("video", 1),
        ("checkin", 1),
    }
    assert draft_action(client, converted, "convert-legacy")["revision"] == converted["revision"]
    payload = body(converted, title="复制的新路线")
    copied = draft_action(client, converted, "copy", payload=payload)
    assert (
        copied["id"] != converted["id"]
        and copied["published_revision"] == 0
        and copied["published_content"] is None
    )
    assert copied["content"]["stops"][0]["segments"][0]["id"] != stop["segments"][0]["id"]
    assert copied["content"]["stops"][0]["segments"][0]["narration_asset_id"] is None
    assert draft_action(client, converted, "copy", payload=payload) == copied
    assert client.get(f"{PUBLIC}/{copied['id']}").status_code == 404


def test_withdraw_is_cas_and_frozen_save_requires_explicit_withdraw(client, db, experiences):
    _, point, _ = experiences
    login(client)
    pending = action(client, save(client, content(point)), "submit")
    save(client, pending["content"], pending, expected=409)
    draft_action(
        client,
        pending,
        "withdraw",
        expected=409,
        payload=body(pending, expected_published_revision=1),
    )
    editable = draft_action(client, pending, "withdraw")
    assert editable["state"] == "draft" and editable["submitted_at"] is None
    assert db.get(ExperienceSubmissionRecord, pending["id"]) is None


def test_copy_clears_actual_adopted_audio_and_history_retains_invalid_private_binding(
    client, db, narration
):
    item, factory = narration
    asset = generate(client, db, item, factory)
    item = adopt(client, item, asset["asset_id"])
    draft_action(client, item, "checkpoint")
    version = next(
        v
        for v in client.get(f"{ADMIN}/{item['id']}/history").json()["data"]
        if v["event"] == "checkpoint"
    )
    copied = draft_action(client, item, "copy")
    assert copied["content"]["stops"][0]["segments"][0]["narration_asset_id"] is None
    assert copied["content"]["stops"][0]["segments"][0]["id"] != "first-segment"
    changed = copy.deepcopy(item["content"])
    changed["stops"][0]["segments"][0]["text"] = "编辑已修改讲稿，旧声音必须重新制作。"
    item = save(client, changed, item)
    draft_action(client, item, "checkpoint")
    stale_version = next(
        v
        for v in client.get(f"{ADMIN}/{item['id']}/history").json()["data"]
        if v["event"] == "checkpoint" and v["revision"] == item["revision"]
    )
    changed["stops"][0]["segments"][0]["narration_asset_id"] = None
    item = save(client, changed, item)
    restored = draft_action(client, item, f"history/{stale_version['id']}/restore-draft")
    assert restored["content"]["stops"][0]["segments"][0]["narration_asset_id"] == asset["asset_id"]
    assert not draft_action(client, restored, "preflight")["valid"]
    action(client, restored, "submit", expected=409)
    original = draft_action(client, restored, f"history/{version['id']}/restore-draft")
    assert draft_action(client, original, "preflight")["valid"]


def test_content_history_migration_preserves_bytes_and_freezes_real_pending_identity():
    engine = create_engine("sqlite://")
    StaffUserRecord.__table__.create(engine)
    ExperienceRecord.__table__.create(engine)
    key, user = str(uuid4()), str(uuid4())
    payload = {
        "kind": "tour",
        "campus_id": "nku-jinnan",
        "title": "已有待审内容",
        "source_note": "原来源",
        "stops": [],
    }
    with engine.begin() as connection:
        connection.execute(
            ExperienceRecord.__table__.insert().values(
                id=key,
                kind="tour",
                campus_id="nku-jinnan",
                point_id=None,
                revision=8,
                published_revision=2,
                operation="upsert",
                state="in_review",
                status="published",
                draft=payload,
                published={**payload, "title": "原公开内容"},
                contributor_ids=[user],
                submitted_by=user,
                review_note="原记录",
                updated_at=now_utc(),
            )
        )
        migration = import_module("migrations.versions.0015_content_history")
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
        assert connection.execute(select(ExperienceRecord.draft)).scalar_one() == payload
        assert connection.execute(select(ExperienceVersionRecord.content)).scalar_one() == payload
        frozen = connection.execute(select(ExperienceSubmissionRecord.__table__)).mappings().one()
        assert (
            frozen["revision"] == 8
            and frozen["submitted_by"] == user
            and frozen["submitted_at"] is None
        )
        assert frozen["content_sha256"] == migration.fingerprint(payload, "upsert")
        with Operations.context(context):
            migration.downgrade()
        assert connection.execute(select(ExperienceRecord.revision)).scalar_one() == 8
    engine.dispose()
