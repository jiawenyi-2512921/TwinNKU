"""Restore re-enrollment needs current authority; old factors never become login."""

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from test_admin import BASE
from test_backup_scripts import restore

from app.configuration_models import ConfigurationGrantRecord, EmergencyStopRecord
from app.models import AdminAuditRecord, StaffSessionRecord, StaffUserRecord, now_utc
from app.modules.admin.restore_recovery import ACTOR_NAME, enroll_restored_member
from app.modules.admin.security import verify_password

BATCH = "a" * 64
PASSWORD = "Temporary-Restore-Enrollment-546!"


def restored_member(db):
    actor = StaffUserRecord(username=ACTOR_NAME, display_name="恢复维护", password_hash="!disabled",
                            role="viewer", campus_ids=[], point_ids=[], is_active=False)
    target = StaffUserRecord(username="restored-editor", display_name="恢复成员", password_hash="!restore:" + BATCH,
                            role="viewer", campus_ids=[], point_ids=[], is_active=False, revision=7,
                            mfa_enabled=True, must_change_password=True)
    db.add_all([actor, target])
    db.flush()
    db.add(AdminAuditRecord(actor_id=actor.id, actor_name=actor.display_name,
                            action="system.restore_quarantine", details={"batch_sha256": BATCH}))
    db.add(EmergencyStopRecord(service="chat", revision=9, stopped=True, reason="Restored", actor_id=actor.id))
    db.commit()
    return actor, target


def reenroll(db, **changes):
    values = dict(username="restored-editor", expected_revision=7, role="editor", campus_ids=["nku-jinnan"],
                  point_ids=[], password=PASSWORD, reason="Current personnel record independently checked")
    values.update(changes)
    enroll_restored_member(db, **values)


def test_restored_member_needs_new_password_and_personal_mfa_even_in_staged_mode(client, db):
    actor, target = restored_member(db)
    client.app.state.settings.admin_enabled = True
    client.app.state.settings.admin_mfa_enforced = False
    client.headers["origin"] = "http://testserver"
    assert client.post(BASE + "/auth/login", json={"username": target.username, "password": PASSWORD}).status_code == 401
    reenroll(db)
    db.commit()
    response = client.post(BASE + "/auth/login", json={"username": target.username, "password": PASSWORD})
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "enrollment_required"
    assert response.json()["data"]["must_change_password"] is True
    assert client.get(BASE + "/session").status_code == 401
    assert db.scalar(select(func.count()).select_from(StaffSessionRecord)) == 0
    db.refresh(target)
    assert target.role == "editor" and target.campus_ids == ["nku-jinnan"]
    assert verify_password(target.password_hash, PASSWORD)
    assert db.get(EmergencyStopRecord, "chat").revision == 9
    assert db.get(EmergencyStopRecord, "chat").stopped is True
    assert not db.scalars(select(ConfigurationGrantRecord)).all()
    assert not actor.is_active
    audit = db.scalar(select(AdminAuditRecord).where(AdminAuditRecord.action == "user.restore_reenrollment"))
    assert audit.actor_id == actor.id and audit.details["business_session_created"] is False


@pytest.mark.parametrize("change", ["stale-revision", "already-active", "not-quarantined", "wrong-batch", "active-actor", "invalid-scope"])
def test_reenrollment_cannot_use_stale_backup_authority_or_current_active_account(db, change):
    actor, target = restored_member(db)
    if change == "stale-revision":
        target.revision += 1
    elif change == "already-active":
        target.is_active = True
    elif change == "not-quarantined":
        target.password_hash = "!disabled"
    elif change == "wrong-batch":
        target.password_hash = "!restore:" + "b" * 64
    elif change == "active-actor":
        actor.is_active = True
    db.commit()
    from app.core.errors import DomainError

    with pytest.raises((ValueError, DomainError)):
        reenroll(db, **({"campus_ids": ["nku-balitai"]} if change == "invalid-scope" else {}))
    assert not db.scalars(select(AdminAuditRecord).where(AdminAuditRecord.action == "user.restore_reenrollment")).all()
    assert db.get(EmergencyStopRecord, "chat").stopped is True


def test_expired_restore_enrollment_cannot_use_password_only_session(client, db):
    _, target = restored_member(db)
    reenroll(db)
    target.mfa_recovery_until = now_utc() - timedelta(seconds=1)
    db.commit()
    client.app.state.settings.admin_enabled = True
    client.headers["origin"] = "http://testserver"
    response = client.post(BASE + "/auth/login", json={"username": target.username, "password": PASSWORD})
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "recovery_required"
    assert client.get(BASE + "/session").status_code == 401


def test_quarantine_refuses_incomplete_schema_and_untrusted_batch_identifiers():
    with pytest.raises(ValueError):
        restore.recovery_security_sql(restore.RESTORE_AUTH_TABLES - {"staff_recovery_codes"}, BATCH)
    with pytest.raises(ValueError):
        restore.recovery_security_sql(restore.RESTORE_AUTH_TABLES, "' ; DELETE FROM points;")
