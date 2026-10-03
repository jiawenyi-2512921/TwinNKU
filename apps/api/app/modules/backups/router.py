from uuid import UUID

from fastapi import APIRouter, Query, Request
from sqlalchemy import delete, select

from app.api import DB, envelope
from app.backup_models import BackupGrantRecord, BackupJobRecord
from app.contracts import Envelope
from app.core.errors import DomainError
from app.models import StaffUserRecord
from app.modules.admin.security import Actor, audit
from app.modules.backups import service
from app.modules.backups.schemas import (
    BackupCancel,
    BackupCapabilities,
    BackupGrants,
    BackupGrantUpdate,
    BackupJob,
    BackupJobPage,
    BackupRequest,
    BackupStatus,
)

router = APIRouter(tags=["backup controls"])
META = {"x-implementation-status": "implemented", "x-module": "M58", "x-auth": "staff"}
PREFIX = "/api/v1/admin"


@router.get(
    PREFIX + "/backup-capabilities",
    response_model=Envelope[BackupCapabilities],
    operation_id="getBackupCapabilities",
    openapi_extra=META,
)
def capabilities(request: Request, actor: Actor, db: DB):
    from app.backup_models import BackupStatusRecord

    if not (
        service.granted(db, actor, "backup.read") or service.granted(db, actor, "backup.request")
    ):
        raise DomainError("FORBIDDEN", "账号没有备份权限", 403)
    settings = request.app.state.settings
    row = db.get(BackupStatusRecord, 1)
    staff, total, interval = service.limits(settings)
    return envelope(
        request,
        BackupCapabilities(
            requests_enabled=settings.backup_requests_enabled
            and not settings.practice_mode
            and service.executor_accepting(row),
            executor_available=service.executor_available(row),
            staff_requests_per_day=staff,
            global_requests_per_day=total,
            min_interval_seconds=interval,
        ),
    )


@router.get(
    PREFIX + "/backup-status",
    response_model=Envelope[BackupStatus],
    operation_id="getBackupStatus",
    openapi_extra=META,
)
def status(request: Request, actor: Actor, db: DB):
    return envelope(request, service.status_view(db, actor, request.app.state.settings))


@router.post(
    PREFIX + "/backup-jobs",
    response_model=Envelope[BackupJob],
    operation_id="requestBackup",
    openapi_extra=META,
)
def create(payload: BackupRequest, request: Request, actor: Actor, db: DB):
    row = service.admit(db, actor, request.app.state.settings, payload)
    db.commit()
    return envelope(request, service.job_view(row))


@router.get(
    PREFIX + "/backup-jobs",
    response_model=Envelope[BackupJobPage],
    operation_id="listBackupJobs",
    openapi_extra=META,
)
def jobs(
    request: Request,
    actor: Actor,
    db: DB,
    page: int = Query(1, ge=1, le=1000),
    page_size: int = Query(20, ge=1, le=50),
):
    query = select(BackupJobRecord)
    if not service.granted(db, actor, "backup.read"):
        service.require_grant(db, actor, "backup.request")
        query = query.where(BackupJobRecord.user_id == actor.user.id)
    rows = list(
        db.scalars(
            query.order_by(BackupJobRecord.created_at.desc(), BackupJobRecord.id)
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
    )
    return envelope(
        request,
        BackupJobPage(
            items=[service.job_view(row) for row in rows[:page_size]],
            page=page,
            page_size=page_size,
            has_more=len(rows) > page_size,
        ),
    )


@router.get(
    PREFIX + "/backup-jobs/operations/{operation_id}",
    response_model=Envelope[BackupJob],
    operation_id="getBackupOperation",
    openapi_extra=META,
)
def operation(operation_id: UUID, request: Request, actor: Actor, db: DB):
    service.require_grant(db, actor, "backup.request")
    row = db.scalar(
        select(BackupJobRecord).where(
            BackupJobRecord.user_id == actor.user.id,
            BackupJobRecord.operation_id == str(operation_id),
        )
    )
    if row is None:
        raise DomainError("NOT_FOUND", "操作结果尚未找到，请保留原操作编号再次查询", 404)
    return envelope(request, service.job_view(row))


@router.get(
    PREFIX + "/backup-jobs/{job_id}",
    response_model=Envelope[BackupJob],
    operation_id="getBackupJob",
    openapi_extra=META,
)
def job(job_id: UUID, request: Request, actor: Actor, db: DB):
    return envelope(request, service.job_view(service.readable_job(db, actor, job_id)))


@router.post(
    PREFIX + "/backup-jobs/{job_id}/cancel",
    response_model=Envelope[BackupJob],
    operation_id="cancelBackupJob",
    openapi_extra=META,
)
def cancel(job_id: UUID, payload: BackupCancel, request: Request, actor: Actor, db: DB):
    service.require_grant(db, actor, "backup.request")
    service.require_backup_mfa(actor)
    row = service.readable_job(db, actor, job_id)
    if row.user_id != actor.user.id:
        raise DomainError("NOT_FOUND", "只能取消本人申请的任务", 404)
    if row.cancel_operation_id and row.cancel_operation_id != str(payload.operation_id):
        raise DomainError("OPERATION_CONFLICT", "取消请求已记录，请查询原结果", 409)
    if not row.cancel_requested and row.state not in service.ACTIVE:
        raise DomainError("BACKUP_ALREADY_FINISHED", "任务已结束", 409)
    if not row.cancel_requested:
        row.cancel_requested = True
        row.cancel_operation_id = str(payload.operation_id)
        audit(db, actor.user, "backup.cancel", details={"job_id": row.id})
    db.commit()
    return envelope(request, service.job_view(row))


@router.get(
    PREFIX + "/backup-grants/{user_id}",
    response_model=Envelope[BackupGrants],
    operation_id="getBackupGrants",
    openapi_extra=META,
)
def grants(user_id: UUID, request: Request, actor: Actor, db: DB):
    if str(user_id) != actor.user.id:
        actor.require("users.manage")
    user = db.get(StaffUserRecord, str(user_id))
    if not user:
        raise DomainError("NOT_FOUND", "成员不存在", 404)
    return envelope(
        request,
        BackupGrants(
            user_id=user.id,
            permissions=list(
                db.scalars(
                    select(BackupGrantRecord.permission)
                    .where(BackupGrantRecord.user_id == user.id)
                    .order_by(BackupGrantRecord.permission)
                )
            ),
        ),
    )


@router.put(
    PREFIX + "/backup-grants/{user_id}",
    response_model=Envelope[BackupGrants],
    operation_id="setBackupGrants",
    openapi_extra=META,
)
def set_grants(user_id: UUID, payload: BackupGrantUpdate, request: Request, actor: Actor, db: DB):
    actor.require("users.manage")
    service.require_backup_mfa(actor)
    user = db.get(StaffUserRecord, str(user_id))
    if not user or not user.is_active:
        raise DomainError("NOT_FOUND", "有效成员不存在", 404)
    db.execute(delete(BackupGrantRecord).where(BackupGrantRecord.user_id == user.id))
    for permission in payload.permissions:
        db.add(
            BackupGrantRecord(
                user_id=user.id, permission=permission, granted_by=actor.user.id, note=payload.note
            )
        )
    audit(
        db,
        actor.user,
        "backup.grants",
        note=payload.note,
        details={"user_id": user.id, "permissions": payload.permissions},
    )
    db.commit()
    return envelope(request, BackupGrants(user_id=user.id, permissions=sorted(payload.permissions)))
