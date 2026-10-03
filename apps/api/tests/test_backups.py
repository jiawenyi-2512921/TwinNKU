"""Real HTTP admission boundaries; no host executor or paid provider is invoked."""

from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from test_admin import BASE, login, seed_staff

from app.backup_models import BackupGrantRecord, BackupJobRecord, BackupStatusRecord
from app.models import StaffSessionRecord, now_utc
from app.modules.admin.security import COOKIE, digest


@pytest.fixture
def staff(client, db):
    users, _ = seed_staff(client, db)
    client.app.state.settings.backup_requests_enabled = True
    db.add(
        BackupStatusRecord(
            id=1,
            observed_at=now_utc(),
            summary={"summary": {"status": "unknown"}, "requests_enabled": True},
        )
    )
    db.commit()
    return users


def verified(client, db, users, role="admin", permissions=("backup.read", "backup.request")):
    login(client, role)
    users[role].mfa_enabled = True
    session = db.get(StaffSessionRecord, digest(client.cookies[COOKIE]))
    session.mfa_verified_at = now_utc()
    for permission in permissions:
        if not db.get(BackupGrantRecord, (users[role].id, permission)):
            db.add(
                BackupGrantRecord(
                    user_id=users[role].id,
                    permission=permission,
                    granted_by=users["admin"].id,
                    note="独立专项授权",
                )
            )
    db.commit()
    return session


def request(client, *, operation=None, expected=200, **values):
    response = client.post(
        BASE + "/backup-jobs",
        json={"operation_id": str(operation or uuid4()), "reason": "发布前完整备份", **values},
    )
    assert response.status_code == expected, response.text
    return response.json()


def test_admin_has_no_automatic_backup_grant(client, db, staff):
    login(client, "admin")
    assert client.get(BASE + "/backup-status").status_code == 403
    assert request(client, expected=403)["error"]["code"] == "FORBIDDEN"
    assert client.get(BASE + "/backup-capabilities").status_code == 403


def test_request_only_can_read_capabilities_but_no_shared_result(client, db, staff):
    verified(client, db, staff, "editor", permissions=("backup.request",))
    response = client.get(BASE + "/backup-capabilities")
    assert response.status_code == 200
    assert set(response.json()["data"]) == {
        "requests_enabled",
        "executor_available",
        "staff_requests_per_day",
        "global_requests_per_day",
        "min_interval_seconds",
    }
    assert client.get(BASE + "/backup-status").status_code == 403


def test_online_executor_with_host_requests_disabled_cannot_admit(client, db, staff):
    verified(client, db, staff)
    db.get(BackupStatusRecord, 1).summary = {
        "summary": {"status": "unknown"},
        "requests_enabled": False,
    }
    db.commit()
    result = client.get(BASE + "/backup-capabilities").json()["data"]
    assert result["executor_available"] is True
    assert result["requests_enabled"] is False
    assert request(client, expected=503)["error"]["code"] == "BACKUP_EXECUTOR_UNAVAILABLE"
    assert db.scalar(select(func.count()).select_from(BackupJobRecord)) == 0


def test_future_mfa_time_cannot_authorize_request_cancel_or_grants(client, db, staff):
    session = verified(client, db, staff)
    item = request(client)["data"]
    session.mfa_verified_at = now_utc() + timedelta(hours=1)
    db.commit()
    assert request(client, expected=403)["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    assert (
        client.post(
            BASE + "/backup-jobs/" + item["id"] + "/cancel", json={"operation_id": str(uuid4())}
        ).status_code
        == 403
    )
    assert (
        client.put(
            BASE + "/backup-grants/" + staff["editor"].id,
            json={"permissions": ["backup.read"], "note": "未来时间不可授权"},
        ).status_code
        == 403
    )


def test_staged_mfa_exception_cannot_request_or_grant_backup(client, db, staff):
    session = verified(client, db, staff)
    staff["admin"].mfa_enabled = False
    db.commit()
    assert request(client, expected=403)["error"]["code"] == "MFA_ENROLLMENT_REQUIRED"
    response = client.put(
        BASE + "/backup-grants/" + staff["editor"].id,
        json={"permissions": ["backup.request"], "note": "维护人员授权"},
    )
    assert response.status_code == 403
    staff["admin"].mfa_enabled = True
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    assert request(client, expected=403)["error"]["code"] == "MFA_STEP_UP_REQUIRED"


def test_operation_result_idempotent_even_when_executor_unavailable(client, db, staff):
    verified(client, db, staff)
    operation = uuid4()
    first = request(client, operation=operation)["data"]
    client.app.state.settings.backup_requests_enabled = False
    db.get(BackupStatusRecord, 1).observed_at = now_utc() - timedelta(days=1)
    db.commit()
    assert request(client, operation=operation)["data"]["id"] == first["id"]
    assert (
        client.get(BASE + "/backup-jobs/operations/" + str(operation)).json()["data"]["id"]
        == first["id"]
    )
    assert (
        request(client, operation=operation, reason="不同的备份申请", expected=409)["error"]["code"]
        == "OPERATION_CONFLICT"
    )
    assert db.scalar(select(func.count()).select_from(BackupJobRecord)) == 1


@pytest.mark.parametrize("field", ["destination", "key_file", "command", "snapshot_id"])
def test_request_cannot_select_host_paths_or_commands(client, db, staff, field):
    verified(client, db, staff)
    request(client, expected=422, **{field: "/private/ignored"})
    assert db.scalar(select(func.count()).select_from(BackupJobRecord)) == 0


def test_readonly_poll_does_not_extend_session_and_does_not_execute(client, db, staff):
    session = verified(client, db, staff)
    item = request(client)["data"]
    old = now_utc() - timedelta(minutes=4)
    session.last_activity_at = old
    db.commit()
    status = client.get(BASE + "/backup-status").json()["data"]
    assert status["summary"]["restore_status"] == "unknown"
    assert status["active_job"]["id"] == item["id"]
    assert client.get(BASE + "/backup-jobs/" + item["id"]).status_code == 200
    assert client.get(BASE + "/backup-jobs").json()["data"]["items"][0]["state"] == "queued"
    db.refresh(session)
    assert session.last_activity_at.replace(tzinfo=None) == old.replace(tzinfo=None)


def test_request_origin_csrf_and_default_switch_enforced(client, db, staff):
    verified(client, db, staff)
    client.headers["origin"] = "https://wrong.invalid"
    assert request(client, expected=403)["error"]["code"] == "ORIGIN_DENIED"
    client.headers["origin"] = "http://testserver"
    csrf = client.headers.pop("x-csrf-token")
    assert request(client, expected=403)["error"]["code"] == "CSRF_INVALID"
    client.headers["x-csrf-token"] = csrf
    client.app.state.settings.backup_requests_enabled = False
    assert request(client, expected=503)["error"]["code"] == "BACKUP_REQUESTS_DISABLED"
    client.app.state.settings.backup_requests_enabled = True
    db.get(BackupStatusRecord, 1).observed_at = now_utc() - timedelta(minutes=4)
    db.commit()
    assert request(client, expected=503)["error"]["code"] == "BACKUP_EXECUTOR_UNAVAILABLE"


@pytest.mark.parametrize("state", ["queued", "running", "unknown"])
def test_singleton_admission_blocks_active_and_unknown(client, db, staff, state):
    verified(client, db, staff)
    item = request(client)["data"]
    db.get(BackupJobRecord, item["id"]).state = state
    db.commit()
    assert request(client, expected=409)["error"]["code"] == "BACKUP_BUSY"


def test_interval_and_rolling_staff_budget_include_failed_attempts(client, db, staff):
    verified(client, db, staff)
    item = request(client)["data"]
    row = db.get(BackupJobRecord, item["id"])
    row.state = "failed"
    db.commit()
    assert request(client, expected=429)["error"]["code"] == "BACKUP_RATE_LIMITED"
    row.created_at = now_utc() - timedelta(hours=2)
    db.commit()
    item2 = request(client)["data"]
    row2 = db.get(BackupJobRecord, item2["id"])
    row2.created_at = now_utc() - timedelta(hours=1, minutes=1)
    row2.state = "cancelled"
    db.commit()
    assert request(client, expected=429)["error"]["code"] == "BACKUP_RATE_LIMITED"


def test_global_hard_limit_cannot_be_relaxed_by_settings_mutation(client, db, staff):
    verified(client, db, staff)
    item = request(client)["data"]
    row = db.get(BackupJobRecord, item["id"])
    row.state = "failed"
    row.created_at = now_utc() - timedelta(hours=3)
    for index in range(5):
        db.add(
            BackupJobRecord(
                user_id=staff["editor"].id,
                operation_id=str(uuid4()),
                fingerprint="a" * 64,
                reason="独立全局预算样本",
                request_session_id=str(uuid4()),
                mfa_verified_at=now_utc(),
                authorized_until=now_utc(),
                created_at=now_utc() - timedelta(hours=index + 4),
                state="failed",
            )
        )
    db.commit()
    # Simulate malicious/misconfigured in-memory settings; admission clamps too.
    client.app.state.settings.__dict__["backup_global_requests_per_day"] = 100
    assert request(client, expected=429)["error"]["code"] == "BACKUP_RATE_LIMITED"


def test_own_task_scope_and_revoked_permissions_rechecked(client, db, staff):
    verified(client, db, staff)
    item = request(client)["data"]
    staff["admin"].mfa_enabled = False
    db.commit()
    verified(client, db, staff, "editor", permissions=("backup.request",))
    assert client.get(BASE + "/backup-jobs/" + item["id"]).status_code == 404
    assert client.get(BASE + "/backup-jobs/operations/" + item["operation_id"]).status_code == 404
    assert client.get(BASE + "/backup-jobs").json()["data"]["items"] == []
    assert client.get(BASE + "/backup-status").status_code == 403
    db.delete(db.get(BackupGrantRecord, (staff["editor"].id, "backup.request")))
    db.commit()
    assert client.get(BASE + "/backup-jobs").status_code == 403


def test_cancel_is_owned_recent_mfa_idempotent_and_never_marks_execution_success(client, db, staff):
    session = verified(client, db, staff)
    item = request(client)["data"]
    operation = str(uuid4())
    response = client.post(
        BASE + "/backup-jobs/" + item["id"] + "/cancel", json={"operation_id": operation}
    )
    assert response.status_code == 200
    assert response.json()["data"]["cancel_requested"] is True
    assert response.json()["data"]["state"] == "queued"
    assert (
        client.post(
            BASE + "/backup-jobs/" + item["id"] + "/cancel", json={"operation_id": operation}
        ).status_code
        == 200
    )
    assert (
        client.post(
            BASE + "/backup-jobs/" + item["id"] + "/cancel", json={"operation_id": str(uuid4())}
        ).status_code
        == 409
    )
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    assert (
        client.post(
            BASE + "/backup-jobs/" + item["id"] + "/cancel", json={"operation_id": operation}
        ).status_code
        == 403
    )


def test_grants_require_admin_recent_mfa_and_session_displays_separate_permissions(
    client, db, staff
):
    verified(client, db, staff)
    target = staff["editor"].id
    response = client.put(
        BASE + "/backup-grants/" + target,
        json={"permissions": ["backup.read"], "note": "只读维护状态权限"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["permissions"] == ["backup.read"]
    staff["admin"].mfa_enabled = False
    db.commit()
    login(client, "editor")
    assert client.get(BASE + "/session").json()["data"]["permissions"].count("backup.read") == 1
    assert client.get(BASE + "/backup-status").status_code == 200
    assert (
        client.put(
            BASE + "/backup-grants/" + target,
            json={"permissions": ["backup.request"], "note": "越权新增申请权限"},
        ).status_code
        == 403
    )
