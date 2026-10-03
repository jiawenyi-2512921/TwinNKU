"""Own-account session controls across the actual authentication boundary."""

from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from test_admin import BASE, login, seed_staff
from test_staff_mfa import Authenticator, enroll, post, verify

from app.models import AdminAuditRecord, StaffMfaChallengeRecord, StaffSessionRecord, now_utc
from app.modules.admin.mfa import ORIGIN
from app.modules.admin.security import COOKIE, digest

PATH = BASE + "/auth/sessions"


@pytest.fixture
def member(client, db):
    users, _ = seed_staff(client, db)
    login(client, "admin")
    row = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    row.mfa_verified_at = now_utc()
    db.commit()
    return users, row


def session(db, user, name, *, expires=None, activity=None, verified=True):
    row = StaffSessionRecord(
        token_hash=digest(name),
        user_id=user.id,
        csrf_token="test-csrf-" + name,
        expires_at=expires or now_utc() + timedelta(hours=2),
        last_activity_at=activity or now_utc(),
        mfa_verified_at=now_utc() if verified else None,
    )
    db.add(row)
    db.commit()
    return row


def test_inventory_has_only_own_active_public_ids_and_server_timestamps(client, db, member):
    users, current = member
    other = session(db, users["admin"], "other-active")
    foreign = session(db, users["editor"], "foreign-active")
    session(db, users["admin"], "expired", expires=now_utc() - timedelta(seconds=1))
    session(db, users["admin"], "idle", activity=now_utc() - timedelta(hours=3))
    response = client.get(PATH)
    assert response.status_code == 200
    data = response.json()["data"]
    assert set(data) == {"server_time", "sessions"}
    rows = {row["id"]: row for row in data["sessions"]}
    assert set(rows) == {current.public_id, other.public_id}
    assert rows[current.public_id]["is_current"] and not rows[other.public_id]["is_current"]
    for row in rows.values():
        assert UUID(row["id"]).version == 4
        assert set(row) == {
            "id",
            "is_current",
            "created_at",
            "last_activity_at",
            "expires_at",
            "idle_expires_at",
            "mfa_verified",
        }
        for field in ["created_at", "last_activity_at", "expires_at", "idle_expires_at"]:
            assert row[field].endswith("Z") or row[field].endswith("+00:00")
    for secret in [
        current.token_hash,
        current.csrf_token,
        foreign.public_id,
        other.token_hash,
        "other-active",
    ]:
        assert secret not in response.text


def test_single_revocation_invalidates_other_browser_cookie_immediately_and_keeps_current(
    client, db, member
):
    _, current = member
    original_cookie = client.cookies.get(COOKIE)
    with TestClient(client.app) as other_client:
        other_client.headers["origin"] = "http://testserver"
        login(other_client, "admin")
        other = db.get(StaffSessionRecord, digest(other_client.cookies.get(COOKIE)))
        result = client.delete(PATH + "/" + other.public_id)
        assert result.status_code == 200, result.text
        assert result.json()["data"] == {"revoked_count": 1}
        assert other_client.get(BASE + "/session").status_code == 401
        assert client.get(BASE + "/session").status_code == 200
        assert client.cookies.get(COOKIE) == original_cookie
        events = list(
            db.scalars(select(AdminAuditRecord).where(AdminAuditRecord.action == "session.revoked"))
        )
        assert len(events) == 1 and events[0].details == {"session_id": other.public_id}
        assert current.token_hash not in str(events[0].details)


def test_unknown_foreign_expired_and_current_targets_never_delete_current_or_other_member(
    client, db, member
):
    users, current = member
    foreign = session(db, users["editor"], "foreign")
    expired = session(db, users["admin"], "expired", expires=now_utc() - timedelta(seconds=1))
    missing = client.delete(PATH + "/" + str(uuid4()))
    assert missing.status_code == 404
    for row in [foreign, expired]:
        response = client.delete(PATH + "/" + row.public_id)
        assert response.status_code == 404
        assert response.json()["error"] == missing.json()["error"]
        assert db.get(StaffSessionRecord, row.token_hash)
    assert client.delete(PATH + "/" + current.public_id).status_code == 409
    assert client.get(BASE + "/session").status_code == 200


@pytest.mark.parametrize("factor_age", [None, 300, 301])
def test_revocation_requires_recent_mfa_even_during_staged_enrollment(
    client, db, member, factor_age
):
    users, current = member
    other = session(db, users["admin"], "target")
    current.mfa_verified_at = (
        None if factor_age is None else now_utc() - timedelta(seconds=factor_age)
    )
    db.commit()
    assert not users["admin"].mfa_enabled and not client.app.state.settings.admin_mfa_enforced
    for response in [
        client.delete(PATH + "/" + other.public_id),
        client.post(PATH + "/revoke-others"),
    ]:
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    assert db.get(StaffSessionRecord, other.token_hash)


@pytest.mark.parametrize("failure", ["csrf", "origin"])
def test_revocation_requires_csrf_and_same_origin(client, db, member, failure):
    users, _ = member
    other = session(db, users["admin"], "target")
    client.headers["x-csrf-token" if failure == "csrf" else "origin"] = "invalid"
    assert client.delete(PATH + "/" + other.public_id).status_code == 403
    assert client.post(PATH + "/revoke-others").status_code == 403
    assert db.get(StaffSessionRecord, other.token_hash)


def test_revoke_others_retains_current_and_foreign_sessions_and_cancels_old_pending_proofs(
    client, db, member
):
    users, current = member
    first = session(db, users["admin"], "first")
    second = session(db, users["admin"], "second")
    expired = session(db, users["admin"], "expired", expires=now_utc() - timedelta(seconds=1))
    foreign = session(db, users["editor"], "foreign")
    challenges = []
    for user in [users["admin"], users["editor"]]:
        row = StaffMfaChallengeRecord(
            token_hash=digest("pending-" + user.id),
            user_id=user.id,
            user_revision=user.revision,
            purpose="stepup",
            csrf_token="test-pending",
            expires_at=now_utc() + timedelta(minutes=5),
        )
        db.add(row)
        challenges.append(row)
    db.commit()
    deleted_ids = [row.token_hash for row in [first, second, expired]]
    pending_ids = [row.token_hash for row in challenges]
    result = client.post(PATH + "/revoke-others")
    assert result.status_code == 200, result.text
    assert result.json()["data"] == {"revoked_count": 2}
    for token_hash in deleted_ids:
        assert db.get(StaffSessionRecord, token_hash) is None
    assert db.get(StaffSessionRecord, current.token_hash) and db.get(
        StaffSessionRecord, foreign.token_hash
    )
    assert db.get(StaffMfaChallengeRecord, pending_ids[0]) is None
    assert db.get(StaffMfaChallengeRecord, pending_ids[1])
    assert client.get(BASE + "/session").status_code == 200
    assert client.post(PATH + "/revoke-others").json()["data"] == {"revoked_count": 0}


@pytest.mark.parametrize("role", ["admin", "reviewer", "editor", "viewer"])
def test_every_member_can_manage_only_their_own_sessions(client, db, role):
    users, _ = seed_staff(client, db)
    login(client, role)
    current = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    current.mfa_verified_at = now_utc()
    db.commit()
    other = session(db, users[role], "own-other")
    foreign_user = users["viewer" if role != "viewer" else "admin"]
    foreign = session(db, foreign_user, "foreign")
    assert len(client.get(PATH).json()["data"]["sessions"]) == 2
    assert client.delete(PATH + "/" + other.public_id).status_code == 200
    assert client.delete(PATH + "/" + foreign.public_id).status_code == 404


def test_real_webauthn_step_up_unlocks_revocation_without_automatically_replaying_it(client, db):
    users, _ = seed_staff(client, db)
    client.app.state.settings.admin_public_origin = ORIGIN
    client.headers["origin"] = ORIGIN
    device = Authenticator()
    enroll(client, device)
    current = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    current.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    other = session(db, users["admin"], "own-other")
    response = client.delete(PATH + "/" + other.public_id)
    assert (
        response.status_code == 403 and response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    )
    pending = post(client, "/step-up")
    client.headers["x-csrf-token"] = pending["csrf_token"]
    verify(client, device)
    assert db.get(StaffSessionRecord, other.token_hash)
    assert client.delete(PATH + "/" + other.public_id).status_code == 200
    assert client.get(BASE + "/session").status_code == 200


def test_revoked_browser_cannot_use_an_old_pending_webauthn_proof_to_create_another_session(
    client, db
):
    seed_staff(client, db)
    client.app.state.settings.admin_public_origin = ORIGIN
    client.headers["origin"] = ORIGIN
    device = Authenticator()
    enroll(client, device)
    with TestClient(client.app) as other:
        other.headers["origin"] = ORIGIN
        login(other, "admin")
        verify(other, device)
        revoked = db.get(StaffSessionRecord, digest(other.cookies.get(COOKIE)))
        revoked_id, revoked_hash = revoked.public_id, revoked.token_hash
        pending = post(other, "/step-up")
        other.headers["x-csrf-token"] = pending["csrf_token"]
        options = post(other, "/authentication/options")["public_key"]
        assert client.delete(PATH + "/" + revoked_id).status_code == 200
        post(
            other,
            "/authentication/verify",
            {"credential": device.assertion(options["challenge"])},
            expected=401,
        )
        assert other.get(BASE + "/session").status_code == 401
        assert db.get(StaffSessionRecord, revoked_hash) is None
        assert len(client.get(PATH).json()["data"]["sessions"]) == 1
