"""Self-service session inventory; public IDs never authorize a request."""

from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Request
from sqlalchemy import delete, select

from app.api import DB, envelope
from app.contracts import DTO, Envelope
from app.core.errors import DomainError
from app.models import StaffMfaChallengeRecord, StaffSessionRecord, StaffUserRecord, now_utc
from app.modules.admin.security import Auth, audit, utc

router = APIRouter(prefix="/auth/sessions", tags=["admin"])
META = {"x-implementation-status": "implemented", "x-module": "M01", "x-auth": "staff"}
WRITE = {
    **META,
    "parameters": [
        {"name": "Origin", "in": "header", "required": True, "schema": {"type": "string"}},
        {"name": "X-CSRF-Token", "in": "header", "required": True, "schema": {"type": "string"}},
    ],
}


class StaffSessionInfo(DTO):
    id: UUID
    is_current: bool
    created_at: datetime
    last_activity_at: datetime
    expires_at: datetime
    idle_expires_at: datetime
    mfa_verified: bool


class StaffSessionInventory(DTO):
    server_time: datetime
    sessions: list[StaffSessionInfo]


class StaffSessionRevocation(DTO):
    revoked_count: int


def active_sessions(auth, settings, now):
    query = select(StaffSessionRecord).where(
        StaffSessionRecord.user_id == auth.user.id,
        StaffSessionRecord.expires_at > now,
        StaffSessionRecord.last_activity_at
        > now - timedelta(minutes=settings.admin_session_idle_minutes),
    )
    if auth.mfa_enforced or auth.user.mfa_enabled:
        query = query.where(StaffSessionRecord.mfa_verified_at.is_not(None))
    return query


def require_session_step_up(auth, now):
    # Session revocation always needs a recent UV assertion, including during
    # staged MFA enrollment. A password-only session cannot bypass this action.
    verified = auth.session.mfa_verified_at
    if verified is None or utc(verified) + timedelta(minutes=5) <= now:
        raise DomainError("MFA_STEP_UP_REQUIRED", "请再次验证通行密钥，再重试当前操作", 403)


def lock_account(db, auth):
    # authenticate() has changed last_activity_at in memory. Take the account
    # lock before flushing that session row, matching password login's order.
    with db.no_autoflush:
        db.scalar(
            select(StaffUserRecord).where(StaffUserRecord.id == auth.user.id).with_for_update()
        )


def revoke_pending(db, user_id):
    # A pre-existing step-up cookie from a revoked browser cannot create a new
    # staff session. Completed step-up for this browser has already been consumed.
    db.execute(delete(StaffMfaChallengeRecord).where(StaffMfaChallengeRecord.user_id == user_id))


@router.get(
    "",
    response_model=Envelope[StaffSessionInventory],
    operation_id="listOwnStaffSessions",
    openapi_extra=META,
)
def list_sessions(request: Request, auth: Auth, db: DB):
    now = now_utc()
    idle = timedelta(minutes=request.app.state.settings.admin_session_idle_minutes)
    rows = db.scalars(
        active_sessions(auth, request.app.state.settings, now).order_by(
            StaffSessionRecord.created_at.desc(),
            StaffSessionRecord.public_id,
        )
    )
    return envelope(
        request,
        StaffSessionInventory(
            server_time=now,
            sessions=[
                StaffSessionInfo(
                    id=row.public_id,
                    is_current=row.token_hash == auth.session.token_hash,
                    created_at=utc(row.created_at),
                    last_activity_at=utc(row.last_activity_at),
                    expires_at=utc(row.expires_at),
                    idle_expires_at=utc(row.last_activity_at) + idle,
                    mfa_verified=row.mfa_verified_at is not None,
                )
                for row in rows
            ],
        ),
    )


@router.delete(
    "/{session_id}",
    response_model=Envelope[StaffSessionRevocation],
    operation_id="revokeOwnStaffSession",
    openapi_extra=WRITE,
)
def revoke_session(session_id: UUID, request: Request, auth: Auth, db: DB):
    now = now_utc()
    require_session_step_up(auth, now)
    if str(session_id) == auth.session.public_id:
        raise DomainError("CURRENT_SESSION", "本次会话保持有效；如需退出，请使用退出登录", 409)
    lock_account(db, auth)
    row = db.scalar(
        active_sessions(auth, request.app.state.settings, now)
        .where(
            StaffSessionRecord.public_id == str(session_id),
        )
        .with_for_update()
    )
    if row is None:
        # Foreign and unknown IDs have exactly the same response.
        raise DomainError("NOT_FOUND", "该会话不存在或已失效", 404)
    db.delete(row)
    revoke_pending(db, auth.user.id)
    audit(db, auth.user, "session.revoked", details={"session_id": str(session_id)})
    db.commit()
    return envelope(request, StaffSessionRevocation(revoked_count=1))


@router.post(
    "/revoke-others",
    response_model=Envelope[StaffSessionRevocation],
    operation_id="revokeOtherOwnStaffSessions",
    openapi_extra=WRITE,
)
def revoke_others(request: Request, auth: Auth, db: DB):
    now = now_utc()
    require_session_step_up(auth, now)
    # Password login takes the same user lock. A simultaneous new login is
    # serialized with this revocation instead of slipping into its snapshot.
    lock_account(db, auth)
    current = auth.session.token_hash
    visible_count = len(
        list(
            db.scalars(
                active_sessions(auth, request.app.state.settings, now).where(
                    StaffSessionRecord.token_hash != current,
                )
            )
        )
    )
    db.execute(
        delete(StaffSessionRecord).where(
            StaffSessionRecord.user_id == auth.user.id,
            StaffSessionRecord.token_hash != current,
        )
    )
    revoke_pending(db, auth.user.id)
    audit(db, auth.user, "session.others_revoked", details={"revoked_count": visible_count})
    db.commit()
    return envelope(request, StaffSessionRevocation(revoked_count=visible_count))
