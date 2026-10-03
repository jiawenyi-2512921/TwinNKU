"""Actual P-256 WebAuthn signatures through login/enrollment/recovery HTTP boundaries."""

import hashlib
import json
from datetime import timedelta

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import func, select
from test_admin import BASE, TEST_PASSWORD, login, seed_staff
from webauthn.helpers import bytes_to_base64url as b64

from app.models import (
    AdminAuditRecord,
    StaffCredentialRecord,
    StaffMfaChallengeRecord,
    StaffRecoveryCodeRecord,
    StaffSessionRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.mfa import ORIGIN, PENDING_COOKIE, RP_ID
from app.modules.admin.mfa_recover import recover_account
from app.modules.admin.security import COOKIE, digest

MFA = BASE + "/auth/mfa"


@pytest.fixture
def staff(client, db):
    users, _ = seed_staff(client, db)
    client.app.state.settings.admin_public_origin = ORIGIN
    client.headers["origin"] = ORIGIN
    return users


class Authenticator:
    def __init__(self, marker=1):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = bytes([marker]) * 32
        n = self.key.public_key().public_numbers()
        self.cose = cbor2.dumps(
            {1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")}
        )

    def registration(self, challenge, *, uv=True, origin=ORIGIN, rp_id=RP_ID):
        client = json.dumps(
            {
                "type": "webauthn.create",
                "challenge": challenge,
                "origin": origin,
                "crossOrigin": False,
            }
        ).encode()
        data = hashlib.sha256(rp_id.encode()).digest() + bytes([0x41 | (4 if uv else 0)]) + bytes(4)
        data += bytes(16) + len(self.id).to_bytes(2, "big") + self.id + self.cose
        return {
            "id": b64(self.id),
            "rawId": b64(self.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client),
                "attestationObject": b64(
                    cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": data})
                ),
            },
        }

    def assertion(self, challenge, *, counter=0, uv=True, origin=ORIGIN, cross=False, rp_id=RP_ID):
        client = json.dumps(
            {"type": "webauthn.get", "challenge": challenge, "origin": origin, "crossOrigin": cross}
        ).encode()
        data = (
            hashlib.sha256(rp_id.encode()).digest()
            + bytes([1 | (4 if uv else 0)])
            + counter.to_bytes(4, "big")
        )
        signature = self.key.sign(data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {
            "id": b64(self.id),
            "rawId": b64(self.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client),
                "authenticatorData": b64(data),
                "signature": b64(signature),
                "userHandle": None,
            },
        }


def post(client, path, payload=None, expected=200):
    response = client.post(MFA + path, json=payload)
    assert response.status_code == expected, response.text
    return response.json().get("data")


def pending_login(client, name="admin"):
    data = login(client, name)
    assert "status" in data
    return data


def register(client, device):
    options = post(client, "/registration/options", {"name": "测试认证器"})["public_key"]
    assert options["rp"]["id"] == RP_ID
    assert options["authenticatorSelection"]["userVerification"] == "required"
    post(client, "/registration/verify", {"credential": device.registration(options["challenge"])})


def verify(client, device):
    options = post(client, "/authentication/options")["public_key"]
    assert options["userVerification"] == "required"
    session = post(
        client, "/authentication/verify", {"credential": device.assertion(options["challenge"])}
    )
    client.headers["x-csrf-token"] = session["csrf_token"]
    assert session["mfa_verified"]
    return session


def enroll(client, device, name="admin"):
    data = login(client, name)
    if "status" not in data:
        data = post(client, "/enrollment", {"password": TEST_PASSWORD})
        client.headers["x-csrf-token"] = data["csrf_token"]
    register(client, device)
    return verify(client, device)


def test_enforced_pending_is_not_session_and_actual_signature_enables_mfa(client, db, staff):
    client.app.state.settings.admin_mfa_enforced = True
    data = pending_login(client)
    assert data["status"] == "enrollment_required"
    assert client.get(BASE + "/points").status_code == 401
    assert db.scalar(select(func.count()).select_from(StaffSessionRecord)) == 0
    raw = client.cookies.get(PENDING_COOKIE)
    assert db.get(StaffMfaChallengeRecord, raw) is None
    assert db.get(StaffMfaChallengeRecord, digest(raw))
    device = Authenticator()
    register(client, device)
    assert not staff["admin"].mfa_enabled
    verify(client, device)
    assert staff["admin"].mfa_enabled
    assert client.get(BASE + "/points").status_code == 200
    assert db.get(StaffMfaChallengeRecord, digest(raw)) is None
    post(client, "/authentication/verify", {"credential": {}}, expected=401)


@pytest.mark.parametrize("failure", ["uv", "origin", "cross", "challenge", "signature"])
def test_rejects_unverified_forged_and_wrong_origin_assertions(client, db, staff, failure):
    device = Authenticator()
    enroll(client, device)
    pending_login(client)
    options = post(client, "/authentication/options")["public_key"]
    proof = device.assertion(
        options["challenge"] if failure != "challenge" else b64(bytes(32)),
        uv=failure != "uv",
        origin="https://evil.example" if failure == "origin" else ORIGIN,
        cross=failure == "cross",
    )
    if failure == "signature":
        proof["response"]["signature"] = b64(bytes(70))
    post(client, "/authentication/verify", {"credential": proof}, expected=403)
    assert client.get(BASE + "/points").status_code == 401
    pending = db.get(StaffMfaChallengeRecord, digest(client.cookies.get(PENDING_COOKIE)))
    assert pending.attempts == 1 and pending.challenge is None
    # Cleared challenge cannot be replayed, including with a subsequently valid proof.
    post(
        client,
        "/authentication/verify",
        {"credential": device.assertion(options["challenge"])},
        expected=403,
    )


def test_registration_uv_pending_csrf_expiry_and_role_revision(client, db, staff):
    client.app.state.settings.admin_mfa_enforced = True
    pending_login(client, "viewer")
    options = post(client, "/registration/options", {"name": "备用"})["public_key"]
    post(
        client,
        "/registration/verify",
        {"credential": Authenticator().registration(options["challenge"], uv=False)},
        expected=403,
    )
    csrf = client.headers.pop("x-csrf-token")
    post(client, "/registration/options", {"name": "备用"}, expected=403)
    client.headers["x-csrf-token"] = csrf
    row = db.get(StaffMfaChallengeRecord, digest(client.cookies.get(PENDING_COOKIE)))
    row.expires_at = now_utc() - timedelta(seconds=1)
    db.commit()
    post(client, "/registration/options", {"name": "备用"}, expected=401)
    pending_login(client, "viewer")
    staff["viewer"].revision += 1
    db.commit()
    post(client, "/registration/options", {"name": "备用"}, expected=401)


def test_recovery_codes_hash_once_and_only_reenroll_then_revoke(client, db, staff):
    device = Authenticator()
    enroll(client, device)
    old_token = client.cookies.get(COOKIE)
    data = post(client, "/recovery-codes")
    codes = data["codes"]
    client.headers["x-csrf-token"] = data["session"]["csrf_token"]
    assert len(codes) == 10 and len(set(codes)) == 10
    assert not db.get(StaffRecoveryCodeRecord, codes[0])
    assert db.get(StaffRecoveryCodeRecord, digest(codes[0]))
    assert not db.get(StaffSessionRecord, digest(old_token))
    assert client.get(BASE + "/session").status_code == 200
    pending_login(client)
    response = post(client, "/recovery", {"code": codes[0]})
    client.headers["x-csrf-token"] = response["csrf_token"]
    assert response["status"] == "enrollment_required"
    assert db.get(StaffRecoveryCodeRecord, digest(codes[0])) is None
    assert client.get(BASE + "/users").status_code == 401
    assert credentials_count(db) == 0
    replacement = Authenticator(2)
    register(client, replacement)
    verify(client, replacement)
    pending_login(client)
    post(client, "/recovery", {"code": codes[0]}, expected=403)
    assert all(
        codes[0] not in json.dumps(row.details) for row in db.scalars(select(AdminAuditRecord))
    )


def credentials_count(db):
    return db.scalar(select(func.count()).select_from(StaffCredentialRecord))


def test_stepup_and_idle_polling_and_last_factor_protection(client, db, staff):
    device = Authenticator()
    enroll(client, device)
    token = client.cookies.get(COOKIE)
    session = db.get(StaffSessionRecord, digest(token))
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    assert (
        client.post(
            BASE + "/users",
            json={
                "username": "new-person",
                "password": TEST_PASSWORD,
                "display_name": "成员",
                "role": "viewer",
                "campus_ids": ["nku-jinnan"],
            },
        ).status_code
        == 403
    )
    pending = post(client, "/step-up")
    client.headers["x-csrf-token"] = pending["csrf_token"]
    verify(client, device)
    assert client.cookies.get(COOKIE) != token
    assert client.delete(MFA + "/credentials/" + b64(device.id)).status_code == 409
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    before = session.last_activity_at
    assert client.get(BASE + "/session").status_code == 200
    assert session.last_activity_at == before
    session.last_activity_at = now_utc() - timedelta(minutes=31)
    db.commit()
    assert client.get(BASE + "/session").status_code == 401


def test_staged_unenrolled_login_is_compatible_but_enrolled_never_downgrades(client, db, staff):
    assert not login(client)["mfa_verified"]
    device = Authenticator()
    enroll(client, device)
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    session.mfa_verified_at = None
    db.commit()
    assert client.get(BASE + "/session").status_code == 401
    pending_login(client)
    assert client.get(BASE + "/users").status_code == 401
    verify(client, device)


def test_console_recovery_has_disabled_identity_and_no_forged_session(client, db, staff):
    device = Authenticator()
    enroll(client, device)
    old_password, old_role = staff["admin"].password_hash, staff["admin"].role
    recover_account(db, username="admin", reason="独立维护核验后，设备丢失")
    db.commit()
    assert staff["admin"].password_hash == old_password and staff["admin"].role == old_role
    assert db.scalar(select(func.count()).select_from(StaffSessionRecord)) == 0
    actor = db.scalar(
        select(StaffUserRecord).where(StaffUserRecord.username == "maintenance.mfa-recovery")
    )
    assert not actor.is_active and not actor.campus_ids and actor.role == "viewer"
    row = db.scalar(
        select(AdminAuditRecord).where(AdminAuditRecord.action == "user.mfa_console_recovery")
    )
    assert row.actor_id == actor.id and row.details["target_id"] == staff["admin"].id
    data = pending_login(client)
    assert data["status"] == "enrollment_required"
    assert client.get(BASE + "/points").status_code == 401
    staff["admin"].mfa_recovery_until = now_utc() - timedelta(seconds=1)
    db.commit()
    data = pending_login(client)
    assert data["status"] == "recovery_required"
    post(client, "/registration/options", {"name": "过期恢复"}, expected=403)


def test_existing_factor_with_forced_password_change_verifies_before_business_change(
    client, db, staff
):
    device = Authenticator()
    enroll(client, device)
    staff["admin"].must_change_password = True
    db.commit()
    data = pending_login(client)
    assert data["status"] == "mfa_required" and data["must_change_password"]
    session = verify(client, device)
    assert (
        session["user"]["must_change_password"] and client.get(BASE + "/points").status_code == 403
    )
    response = client.post(
        BASE + "/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD + "-changed"},
    )
    assert response.status_code == 200
    assert client.get(BASE + "/session").status_code == 401


def test_console_hidden_temporary_password_recovers_only_enrollment(client, db, staff):
    device = Authenticator()
    enroll(client, device)
    temporary = TEST_PASSWORD + "-temporary"
    recover_account(db, username="admin", reason="唯一管理员设备与密码恢复", new_password=temporary)
    db.commit()
    result = login(client, "admin", temporary)
    assert result["status"] == "enrollment_required" and result["must_change_password"]
    assert client.get(BASE + "/points").status_code == 401
    post(client, "/registration/options", {"name": "临时口令不能直接绑定"}, expected=403)
    result = post(
        client,
        "/pending/password",
        {"current_password": temporary, "new_password": TEST_PASSWORD + "-permanent"},
    )
    client.headers["x-csrf-token"] = result["csrf_token"]
    assert not result["must_change_password"]
    replacement = Authenticator(3)
    register(client, replacement)
    verify(client, replacement)
    assert staff["admin"].role == "admin"


def test_backup_must_sign_itself_and_readonly_rollout_gate_checks_all_admins(client, db, staff):
    from app.modules.admin.mfa_preflight import enforcement_readiness

    main, backup = Authenticator(), Authenticator(4)
    enroll(client, main)
    assert not enforcement_readiness(db)["ready"]
    pending = post(client, "/enrollment", {"password": TEST_PASSWORD})
    client.headers["x-csrf-token"] = pending["csrf_token"]
    register(client, backup)
    options = post(client, "/authentication/options")["public_key"]
    assert [c["id"] for c in options["allowCredentials"]] == [b64(backup.id)]
    post(
        client,
        "/authentication/verify",
        {"credential": main.assertion(options["challenge"])},
        expected=403,
    )
    verify(client, backup)
    assert not enforcement_readiness(db)["ready"]  # Recovery issuance is still missing.
    data = post(client, "/recovery-codes")
    client.headers["x-csrf-token"] = data["session"]["csrf_token"]
    assert client.get(MFA).json()["data"]["enforcement_ready"]
    assert enforcement_readiness(db)["ready"]
    staff["editor"].role = "admin"
    db.commit()
    assert not enforcement_readiness(db)["ready"]


@pytest.mark.parametrize(
    "path",
    [
        "/points/00000000-0000-0000-0000-000000000001/publish",
        "/resources/00000000-0000-0000-0000-000000000001/review/publish",
        "/experiences/00000000-0000-0000-0000-000000000001/review/publish",
        "/navigation/00000000-0000-0000-0000-000000000001/review",
        "/guide-settings",
    ],
)
def test_stale_mfa_blocks_publication_and_runtime_policy_before_business_mutation(
    client, db, staff, path
):
    enroll(client, Authenticator())
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    response = client.request(
        "PUT" if path == "/guide-settings" else "POST",
        BASE + path,
        json={"expected_revision": 1, "note": "审核核验", "action": "publish"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
