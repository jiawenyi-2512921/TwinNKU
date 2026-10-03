"""Admission and authorization only: this module cannot run shell commands."""

import hashlib
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.backup_models import (
    BackupControlRecord,
    BackupGrantRecord,
    BackupJobRecord,
    BackupStatusRecord,
)
from app.core.errors import DomainError
from app.models import now_utc
from app.modules.admin.security import audit, utc
from app.modules.backups.schemas import BackupJob, BackupStatus, BackupSummary

ACTIVE = {"queued", "running", "unknown"}


def granted(db, actor, permission):
    return db.get(BackupGrantRecord, (actor.user.id, permission)) is not None


def require_grant(db, actor, permission):
    if not granted(db, actor, permission):
        raise DomainError("FORBIDDEN", "账号没有此备份权限", 403)


def require_backup_mfa(actor):
    # No staged-enrollment exception is appropriate for host maintenance.
    if not actor.user.mfa_enabled:
        raise DomainError("MFA_ENROLLMENT_REQUIRED", "备份操作前须绑定并验证通行密钥", 403)
    value = actor.session.mfa_verified_at
    now = now_utc()
    if value is None or utc(value) > now or utc(value) + timedelta(minutes=5) <= now:
        raise DomainError("MFA_STEP_UP_REQUIRED", "请再次验证通行密钥，再重新申请", 403)


def limits(settings):
    return (
        min(2, max(1, settings.backup_staff_requests_per_day)),
        min(6, max(1, settings.backup_global_requests_per_day)),
        max(3600, settings.backup_min_interval_seconds),
    )


def executor_accepting(row):
    return bool(
        row and isinstance(row.summary, dict) and row.summary.get("requests_enabled") is True
    )


def executor_available(row):
    if not row:
        return False
    now = now_utc()
    return now - timedelta(minutes=3) < utc(row.observed_at) <= now


def observed_summary(row):
    if not row:
        return BackupSummary()
    return BackupSummary.model_validate(row.summary.get("summary", row.summary))


def job_view(row):
    data = {name: getattr(row, name) for name in BackupJob.model_fields}
    for name in ("created_at", "authorized_until", "started_at", "finished_at"):
        if data[name]:
            data[name] = utc(data[name])
    data["result"] = BackupSummary.model_validate(row.result) if row.result else None
    return BackupJob(**data)


def readable_job(db, actor, key):
    row = db.get(BackupJobRecord, str(key))
    if row is None or not (
        granted(db, actor, "backup.read")
        or (row.user_id == actor.user.id and granted(db, actor, "backup.request"))
    ):
        raise DomainError("NOT_FOUND", "任务不存在或没有查看权限", 404)
    return row


def status_view(db, actor, settings):
    require_grant(db, actor, "backup.read")
    row = db.get(BackupStatusRecord, 1)
    available = executor_available(row)
    active = db.scalar(
        select(BackupJobRecord)
        .where(BackupJobRecord.state.in_(ACTIVE))
        .order_by(BackupJobRecord.created_at)
        .limit(1)
    )
    staff, total, interval = limits(settings)
    return BackupStatus(
        requests_enabled=settings.backup_requests_enabled
        and not settings.practice_mode
        and executor_accepting(row),
        executor_available=available,
        observed_at=utc(row.observed_at) if row else None,
        summary=observed_summary(row),
        active_job=job_view(active) if active else None,
        staff_requests_per_day=staff,
        global_requests_per_day=total,
        min_interval_seconds=interval,
    )


def admit(db, actor, settings, payload):
    require_grant(db, actor, "backup.request")
    require_backup_mfa(actor)
    fingerprint = hashlib.sha256(payload.reason.encode()).hexdigest()
    insert = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    db.execute(
        insert(BackupControlRecord)
        .values(id=1, generation=0)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    # An UPDATE acquires the same transactional gate on PG and SQLite.
    db.execute(
        update(BackupControlRecord)
        .where(BackupControlRecord.id == 1)
        .values(generation=BackupControlRecord.generation + 1)
    )
    old = db.scalar(
        select(BackupJobRecord).where(
            BackupJobRecord.user_id == actor.user.id,
            BackupJobRecord.operation_id == str(payload.operation_id),
        )
    )
    if old:
        if old.fingerprint != fingerprint:
            raise DomainError("OPERATION_CONFLICT", "同一操作编号不能用于不同备份原因", 409)
        return old
    if not settings.backup_requests_enabled or settings.practice_mode:
        raise DomainError("BACKUP_REQUESTS_DISABLED", "后台备份申请尚未启用，请联系维护人员", 503)
    status = db.get(BackupStatusRecord, 1)
    if not executor_available(status) or not executor_accepting(status):
        raise DomainError("BACKUP_EXECUTOR_UNAVAILABLE", "维护执行器不可用，请稍后重新申请", 503)
    now = now_utc()
    # Only the executor may reconcile unknown execution, never HTTP polling.
    if db.scalar(select(BackupJobRecord.id).where(BackupJobRecord.state.in_(ACTIVE)).limit(1)):
        raise DomainError("BACKUP_BUSY", "已有备份任务或待核对结果，暂不能新增", 409)
    staff_limit, global_limit, interval = limits(settings)
    recent = BackupJobRecord.created_at > now - timedelta(days=1)
    total = db.scalar(select(func.count()).select_from(BackupJobRecord).where(recent))
    own = db.scalar(
        select(func.count())
        .select_from(BackupJobRecord)
        .where(recent, BackupJobRecord.user_id == actor.user.id)
    )
    latest = db.scalar(select(func.max(BackupJobRecord.created_at)))
    if (
        total >= global_limit
        or own >= staff_limit
        or (latest and utc(latest) > now - timedelta(seconds=interval))
    ):
        raise DomainError("BACKUP_RATE_LIMITED", "备份频率已达维护上限，请稍后申请", 429)
    verified = utc(actor.session.mfa_verified_at)
    row = BackupJobRecord(
        user_id=actor.user.id,
        operation_id=str(payload.operation_id),
        fingerprint=fingerprint,
        reason=payload.reason,
        request_session_id=actor.session.public_id,
        mfa_verified_at=verified,
        authorized_until=min(verified + timedelta(minutes=5), utc(actor.session.expires_at)),
    )
    db.add(row)
    db.flush()
    audit(
        db,
        actor.user,
        "backup.request",
        details={"job_id": row.id, "operation_id": row.operation_id},
    )
    return row
