import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, Request, Response
from fastapi.security import APIKeyCookie
from sqlalchemy import and_, case, delete, select, true, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.api import DB
from app.contracts import StaffSession, StaffUser
from app.core.errors import DomainError
from app.models import (
    AdminAuditRecord,
    LoginLimitRecord,
    PointRecord,
    StaffMfaChallengeRecord,
    StaffSessionRecord,
    StaffUserRecord,
    now_utc,
)
from app.password_policy import validate_password

COOKIE = "twinnku_staff"
CookieToken = Annotated[
    str | None,
    Depends(APIKeyCookie(name="__Secure-" + COOKIE, scheme_name="StaffCookie", auto_error=False)),
]
HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
DUMMY_HASH = HASHER.hash(secrets.token_urlsafe(32))
PERMISSIONS = {
    "admin": {"points.read", "points.edit", "points.review", "users.manage", "audit.read"},
    "reviewer": {"points.read", "points.review", "audit.read"},
    "editor": {"points.read", "points.edit", "audit.read"},
    "viewer": {"points.read"},
}


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def hash_password(password: str) -> str:
    validate_password(password)
    return HASHER.hash(password)


def verify_password(stored: str, supplied: str) -> bool:
    try:
        return HASHER.verify(stored, supplied)
    except (VerificationError, InvalidHashError):
        return False


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def cookie_name(request: Request, base: str = COOKIE) -> str:
    if request.app.state.settings.practice_mode:
        return "twinnku_practice_" + base.removeprefix("twinnku_")
    return "__Secure-" + base if request.app.state.settings.app_env == "production" else base


def clear_cookie(response: Response, request: Request, *, base: str = COOKIE, path="/api/v1/admin"):
    response.delete_cookie(
        cookie_name(request, base),
        path=path,
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )


def require_enabled(request: Request):
    if not request.app.state.settings.admin_enabled:
        raise DomainError("ADMIN_DISABLED", "后台管理服务尚未启用", 404)


def require_origin(request: Request):
    expected = request.app.state.settings.admin_public_origin or str(request.base_url).rstrip("/")
    if request.headers.get("origin") != expected:
        raise DomainError("ORIGIN_DENIED", "请求来源无效，请从管理后台重新操作", 403)


def audit(db, user, action, *, point=None, note="", details=None):
    db.add(
        AdminAuditRecord(
            actor_id=user.id,
            actor_name=user.display_name,
            action=action,
            campus_id=point.campus_id if point else None,
            point_id=point.id if point else None,
            note=note,
            details=details or {},
        )
    )


def throttle_login(db: Session, request: Request, username: str):
    """Atomic DB counters work across workers; forwarded IP headers are not trusted."""
    now = now_utc()
    cutoff = now - timedelta(minutes=15)
    insert = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    keys = [
        ("user:" + username, 8),
        ("peer:" + (request.client.host if request.client else "unknown"), 250),
    ]
    exceeded = False
    for value, limit in keys:
        key = digest(value)
        db.execute(
            insert(LoginLimitRecord)
            .values(key=key, window_started=now, attempts=0)
            .on_conflict_do_nothing(index_elements=["key"])
        )
        count = db.scalar(
            update(LoginLimitRecord)
            .where(LoginLimitRecord.key == key)
            .values(
                attempts=case(
                    (LoginLimitRecord.window_started < cutoff, 1),
                    else_=LoginLimitRecord.attempts + 1,
                ),
                window_started=case(
                    (LoginLimitRecord.window_started < cutoff, now),
                    else_=LoginLimitRecord.window_started,
                ),
            )
            .returning(LoginLimitRecord.attempts)
        )
        exceeded |= count > limit
    db.execute(
        delete(LoginLimitRecord).where(LoginLimitRecord.window_started < now - timedelta(days=1))
    )
    db.commit()
    if exceeded:
        raise DomainError("LOGIN_RATE_LIMITED", "登录尝试过于频繁，请15分钟后再试", 429)


def as_user(user):
    result = StaffUser.model_validate(user)
    result.created_at, result.updated_at = utc(result.created_at), utc(result.updated_at)
    return result


@dataclass
class Principal:
    user: StaffUserRecord
    session: StaffSessionRecord
    mfa_enforced: bool = False
    mfa_enrolled: bool = False

    def require(self, permission):
        if permission not in PERMISSIONS.get(self.user.role, set()):
            raise DomainError("FORBIDDEN", "当前账号没有此操作权限", 403)


def session_view(principal, db=None):
    permissions = set(PERMISSIONS[principal.user.role])
    if db is not None:
        from app.backup_models import BackupGrantRecord
        from app.configuration_models import ConfigurationGrantRecord

        permissions.update(db.scalars(select(BackupGrantRecord.permission).where(
            BackupGrantRecord.user_id == principal.user.id,
        )))
        permissions.update(db.scalars(select(ConfigurationGrantRecord.permission).where(
            ConfigurationGrantRecord.user_id == principal.user.id,
        )))
    return StaffSession(
        user=as_user(principal.user),
        permissions=sorted(permissions),
        csrf_token=principal.session.csrf_token,
        expires_at=utc(principal.session.expires_at),
        mfa_verified=principal.session.mfa_verified_at is not None,
        mfa_enforced=principal.mfa_enforced,
        mfa_enrolled=principal.mfa_enrolled,
        recent_mfa_until=(utc(principal.session.mfa_verified_at) + timedelta(minutes=5))
        if principal.session.mfa_verified_at
        else None,
    )


def new_session(db, user, request, response: Response, *, mfa_verified=False):
    token = secrets.token_urlsafe(32)
    duration = request.app.state.settings.admin_session_hours * 3600
    session = StaffSessionRecord(
        token_hash=digest(token),
        user_id=user.id,
        csrf_token=secrets.token_urlsafe(32),
        expires_at=now_utc() + timedelta(seconds=duration),
        last_activity_at=now_utc(),
        mfa_verified_at=now_utc() if mfa_verified else None,
    )
    # Rotate the current browser session and prune expired records.
    old = request.cookies.get(cookie_name(request))
    if old:
        db.execute(delete(StaffSessionRecord).where(StaffSessionRecord.token_hash == digest(old)))
    db.execute(delete(StaffSessionRecord).where(StaffSessionRecord.expires_at < now_utc()))
    db.add(session)
    response.set_cookie(
        cookie_name(request),
        token,
        max_age=duration,
        path="/api/v1/admin",
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )
    return Principal(user, session, request.app.state.settings.admin_mfa_enforced, user.mfa_enabled)


def authenticate(request: Request, db: DB, token: CookieToken) -> Principal:
    # Production accepts only the browser-enforced secure cookie name; an old
    # unprefixed cookie cannot override the authenticated session.
    token = request.cookies.get(cookie_name(request))
    require_enabled(request)
    if not token or len(token) > 128:
        raise DomainError("AUTH_REQUIRED", "请先登录管理后台", 401)
    session = db.get(StaffSessionRecord, digest(token))
    if session is None or utc(session.expires_at) <= now_utc():
        raise DomainError("SESSION_EXPIRED", "登录已失效，请重新登录", 401)
    user = db.get(StaffUserRecord, session.user_id)
    if user is None or not user.is_active:
        raise DomainError("AUTH_REQUIRED", "登录已失效，请重新登录", 401)
    enforced = request.app.state.settings.admin_mfa_enforced
    if (enforced or user.mfa_enabled) and session.mfa_verified_at is None:
        raise DomainError("MFA_REQUIRED", "请完成双因素验证后重新登录", 401)
    if (
        utc(session.last_activity_at)
        + timedelta(minutes=request.app.state.settings.admin_session_idle_minutes)
        <= now_utc()
    ):
        raise DomainError("SESSION_EXPIRED", "后台会话因闲置已过期，请重新登录", 401)
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        require_origin(request)
        supplied = request.headers.get("x-csrf-token", "")
        if not secrets.compare_digest(supplied, session.csrf_token):
            raise DomainError("CSRF_INVALID", "会话校验失败，请刷新页面后重试", 403)
        session.last_activity_at = now_utc()
    principal = Principal(user, session, enforced, user.mfa_enabled)
    # Each publication is protected; a front-end batch cannot bypass this check.
    if (request.method == "POST" and request.url.path.endswith("/publish")) or (
        request.method == "PUT" and request.url.path == "/api/v1/admin/guide-settings"
    ):
        require_recent_mfa(principal)
    return principal


def require_recent_mfa(principal):
    if not (principal.mfa_enforced or principal.user.mfa_enabled):
        return  # Deliberate staged enrollment; no implicit production enforcement.
    verified = principal.session.mfa_verified_at
    if verified is None or utc(verified) + timedelta(minutes=5) <= now_utc():
        raise DomainError("MFA_STEP_UP_REQUIRED", "请再次验证通行密钥，再重试当前操作", 403)


Auth = Annotated[Principal, Depends(authenticate)]


def staff_ready(auth: Auth) -> Principal:
    if auth.user.must_change_password:
        raise DomainError("PASSWORD_CHANGE_REQUIRED", "首次登录请先修改临时密码", 403)
    return auth


Actor = Annotated[Principal, Depends(staff_ready)]


def point_scope(user):
    if user.role == "admin":
        return true()
    clauses = [PointRecord.campus_id.in_(user.campus_ids)]
    if user.point_ids:
        clauses.append(PointRecord.id.in_(user.point_ids))
    return and_(*clauses)


def require_point(db, user, point_id, *, lock=False):
    query = select(PointRecord).where(PointRecord.id == str(point_id), point_scope(user))
    if lock:
        query = query.with_for_update()
    point = db.scalar(query.execution_options(populate_existing=True))
    if point is None:
        raise DomainError("NOT_FOUND", "点位不存在或不在授权范围内", 404)
    return point


def revoke_sessions(db, user_id):
    db.execute(delete(StaffSessionRecord).where(StaffSessionRecord.user_id == user_id))
    db.execute(delete(StaffMfaChallengeRecord).where(StaffMfaChallengeRecord.user_id == user_id))
