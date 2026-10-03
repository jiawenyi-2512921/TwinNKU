"""WebAuthn with UV; pending credentials never authorize staff business endpoints."""

import json
import secrets
from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request, Response
from pydantic import Field, SecretStr
from sqlalchemy import delete, func, select
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.api import DB, envelope
from app.contracts import DTO, ActionResult, Envelope, StaffPasswordChange, StaffSession
from app.core.errors import DomainError
from app.models import (
    StaffCredentialRecord,
    StaffMfaChallengeRecord,
    StaffRecoveryCodeRecord,
    StaffSessionRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.security import (
    Actor,
    Auth,
    audit,
    clear_cookie,
    cookie_name,
    digest,
    hash_password,
    new_session,
    require_enabled,
    require_origin,
    require_recent_mfa,
    revoke_sessions,
    session_view,
    throttle_login,
    utc,
    verify_password,
)

RP_ID = "2512921.cn"
ORIGIN = "https://2512921.cn"
PENDING_COOKIE = "twinnku_staff_pending"
router = APIRouter(prefix="/auth/mfa", tags=["admin"])
META = {"x-implementation-status": "implemented", "x-module": "M01", "x-auth": "staff"}


def webauthn_scope(request: Request):
    settings = request.app.state.settings
    if settings.practice_mode:
        # Practice is the sole localhost exception. Recheck the full isolation
        # guard rather than deriving relying-party scope from request headers.
        try:
            settings.practice_is_isolated()
        except ValueError:
            raise DomainError("PRACTICE_ISOLATION_INVALID", "练习环境隔离配置无效", 503) from None
        return "localhost", settings.admin_public_origin
    return RP_ID, ORIGIN


class StaffMfaPending(DTO):
    status: Literal["mfa_required", "enrollment_required", "recovery_required"]
    csrf_token: str
    expires_at: datetime
    must_change_password: bool


class StaffMfaOptions(DTO):
    public_key: dict


class StaffMfaProof(DTO):
    credential: dict


class StaffMfaPassword(DTO):
    password: SecretStr = Field(min_length=1, max_length=128)


class StaffMfaRegistration(DTO):
    name: str = Field(min_length=1, max_length=80)


class StaffMfaRecovery(DTO):
    code: SecretStr = Field(min_length=20, max_length=128)


class StaffMfaRecoveryCodes(DTO):
    codes: list[str]
    session: StaffSession


class StaffMfaCredential(DTO):
    id: str
    name: str
    verified: bool
    created_at: str
    last_used_at: str | None


class StaffMfaStatus(DTO):
    enforced: bool
    enrolled: bool
    verified: bool
    credentials: list[StaffMfaCredential]
    recovery_codes_remaining: int
    enforcement_ready: bool


def credentials(db, user_id):
    return list(
        db.scalars(
            select(StaffCredentialRecord)
            .where(StaffCredentialRecord.user_id == user_id)
            .order_by(StaffCredentialRecord.created_at, StaffCredentialRecord.credential_id)
        )
    )


def member_readiness(db, user):
    verified = db.scalar(
        select(func.count())
        .select_from(StaffCredentialRecord)
        .where(StaffCredentialRecord.user_id == user.id, StaffCredentialRecord.verified.is_(True))
    )
    recovery = db.scalar(
        select(func.count())
        .select_from(StaffRecoveryCodeRecord)
        .where(StaffRecoveryCodeRecord.user_id == user.id)
    )
    return {
        "username": user.username,
        "verified_authenticators": verified,
        "recovery_codes_remaining": recovery,
        "temporary_password": user.must_change_password,
        "ready": bool(
            user.is_active
            and user.mfa_enabled
            and not user.must_change_password
            and verified >= 2
            and recovery >= 1
        ),
    }


def pending_view(row, user):
    state = "enrollment_required" if row.purpose == "enroll" else "mfa_required"
    if row.purpose == "recover":
        state = "recovery_required"
    return StaffMfaPending(
        status=state,
        csrf_token=row.csrf_token,
        expires_at=utc(row.expires_at),
        must_change_password=user.must_change_password,
    )


def set_pending(db, user, request, response, *, purpose):
    raw = secrets.token_urlsafe(32)
    previous = request.cookies.get(cookie_name(request, PENDING_COOKIE))
    if previous:
        db.execute(
            delete(StaffMfaChallengeRecord).where(
                StaffMfaChallengeRecord.token_hash == digest(previous)
            )
        )
    db.execute(
        delete(StaffMfaChallengeRecord).where(StaffMfaChallengeRecord.expires_at < now_utc())
    )
    row = StaffMfaChallengeRecord(
        token_hash=digest(raw),
        user_id=user.id,
        user_revision=user.revision,
        purpose=purpose,
        csrf_token=secrets.token_urlsafe(32),
        expires_at=now_utc() + timedelta(minutes=5),
    )
    db.add(row)
    db.flush()
    response.set_cookie(
        cookie_name(request, PENDING_COOKIE),
        raw,
        max_age=300,
        path="/api/v1/admin/auth/mfa",
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )
    return row


def password_pending(db, user, request, response):
    existing = any(c.verified for c in credentials(db, user.id))
    recovery = user.mfa_recovery_until and utc(user.mfa_recovery_until) > now_utc()
    purpose = "enroll" if recovery or not user.mfa_enabled else "login"
    if user.mfa_enabled and not existing and not recovery:
        purpose = "recover"
    # A password-only browser session must not survive the new login attempt.
    previous = request.cookies.get(cookie_name(request))
    if previous:
        db.execute(
            delete(StaffSessionRecord).where(StaffSessionRecord.token_hash == digest(previous))
        )
    clear_cookie(response, request)
    row = set_pending(db, user, request, response, purpose=purpose)
    audit(db, user, "session.password_verified")
    db.commit()
    return pending_view(row, user)


def require_pending(request, db, purposes=None):
    require_enabled(request)
    require_origin(request)
    raw = request.cookies.get(cookie_name(request, PENDING_COOKIE), "")
    owner = (
        db.scalar(
            select(StaffMfaChallengeRecord.user_id).where(
                StaffMfaChallengeRecord.token_hash == digest(raw)
            )
        )
        if 0 < len(raw) <= 128
        else None
    )
    if not owner:
        raise DomainError("MFA_CHALLENGE_EXPIRED", "验证已过期，请重新登录", 401)
    # Consistent user-before-challenge locks prevent deadlocks during revoke-all.
    user = db.scalar(
        select(StaffUserRecord)
        .where(StaffUserRecord.id == owner)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    row = db.scalar(
        select(StaffMfaChallengeRecord)
        .where(StaffMfaChallengeRecord.token_hash == digest(raw))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not row or utc(row.expires_at) <= now_utc() or row.attempts >= 5:
        raise DomainError("MFA_CHALLENGE_EXPIRED", "验证已过期，请重新登录", 401)
    if not user or not user.is_active or user.revision != row.user_revision:
        raise DomainError("MFA_CHALLENGE_EXPIRED", "账号状态已改变，请重新登录", 401)
    if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), row.csrf_token):
        raise DomainError("CSRF_INVALID", "会话校验失败，请重新登录", 403)
    if purposes and row.purpose not in purposes:
        raise DomainError("FORBIDDEN", "当前验证不能执行此操作", 403)
    return row, user


def challenge_failure(db, row):
    row.attempts += 1
    row.challenge = None
    db.commit()  # Persist failure count even when the request returns an error.
    raise DomainError("MFA_INVALID", "验证未通过，请重新获取验证请求", 403)


def auth_options(request: Request, db, row, user):
    rp_id, _ = webauthn_scope(request)
    row.challenge = bytes_to_base64url(secrets.token_bytes(32))
    allowed = credentials(db, user.id)
    if row.bound_credential_id:
        allowed = [
            credential
            for credential in allowed
            if credential.credential_id == row.bound_credential_id
        ]
    if not allowed:
        raise DomainError(
            "MFA_RECOVERY_REQUIRED", "没有可用认证器，请使用恢复码或联系运维恢复", 409
        )
    options = generate_authentication_options(
        rp_id=rp_id,
        challenge=base64url_to_bytes(row.challenge),
        user_verification=UserVerificationRequirement.REQUIRED,
        timeout=120000,
        allow_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(c.credential_id)) for c in allowed
        ],
    )
    db.commit()
    return StaffMfaOptions(public_key=json.loads(options_to_json(options)))


def same_origin_credential(payload, user):
    # The SDK validator verifies origin/signature; reject embedded ceremonies as well.
    response = payload.get("response", {})
    client = json.loads(base64url_to_bytes(response["clientDataJSON"]))
    if client.get("crossOrigin", False) or client.get("topOrigin"):
        raise ValueError("cross-origin ceremony")
    handle = response.get("userHandle")
    if handle is not None and base64url_to_bytes(handle) != UUID(user.id).bytes:
        raise ValueError("unexpected user handle")


@router.post(
    "/authentication/options", response_model=Envelope[StaffMfaOptions], openapi_extra=META
)
def authentication_options(request: Request, db: DB):
    row, user = require_pending(request, db, {"login", "stepup"})
    return envelope(request, auth_options(request, db, row, user))


@router.post("/authentication/verify", response_model=Envelope[StaffSession], openapi_extra=META)
def authentication_verify(payload: StaffMfaProof, request: Request, response: Response, db: DB):
    row, user = require_pending(request, db, {"login", "stepup"})
    rp_id, origin = webauthn_scope(request)
    key = payload.credential.get("id")
    credential = (
        db.get(StaffCredentialRecord, key) if isinstance(key, str) and len(key) <= 1400 else None
    )
    if (
        not row.challenge
        or not credential
        or credential.user_id != user.id
        or (row.bound_credential_id and credential.credential_id != row.bound_credential_id)
    ):
        challenge_failure(db, row)
    try:
        same_origin_credential(payload.credential, user)
        result = verify_authentication_response(
            credential=payload.credential,
            expected_challenge=base64url_to_bytes(row.challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=base64url_to_bytes(credential.public_key),
            credential_current_sign_count=credential.sign_count,
            require_user_verification=True,
        )
    except Exception:
        challenge_failure(db, row)
    activate = not credential.verified
    credential.sign_count = result.new_sign_count
    credential.verified, credential.last_used_at = True, now_utc()
    credential.backed_up = result.credential_backed_up
    if activate:
        user.mfa_enabled, user.mfa_recovery_until = True, None
        user.revision += 1
        revoke_sessions(db, user.id)
        audit(db, user, "user.mfa_activated")
    else:
        db.delete(row)
    principal = new_session(db, user, request, response, mfa_verified=True)
    audit(db, user, "session.mfa_verified")
    db.commit()
    clear_cookie(response, request, base=PENDING_COOKIE, path="/api/v1/admin/auth/mfa")
    return envelope(request, session_view(principal, db))


@router.post("/enrollment", response_model=Envelope[StaffMfaPending], openapi_extra=META)
def begin_enrollment(
    payload: StaffMfaPassword, request: Request, response: Response, actor: Auth, db: DB
):
    if actor.user.must_change_password:
        raise DomainError("PASSWORD_CHANGE_REQUIRED", "请先修改临时密码", 403)
    require_recent_mfa(actor)
    throttle_login(db, request, "factor:" + actor.user.username)
    if not verify_password(actor.user.password_hash, payload.password.get_secret_value()):
        raise DomainError("PASSWORD_INCORRECT", "当前密码不正确", 403)
    row = set_pending(db, actor.user, request, response, purpose="enroll")
    db.commit()
    return envelope(request, pending_view(row, actor.user))


@router.post("/registration/options", response_model=Envelope[StaffMfaOptions], openapi_extra=META)
def registration_options(payload: StaffMfaRegistration, request: Request, db: DB):
    row, user = require_pending(request, db, {"enroll"})
    rp_id, _ = webauthn_scope(request)
    if user.must_change_password:
        raise DomainError("PASSWORD_CHANGE_REQUIRED", "请先修改临时密码", 403)
    if not payload.name.strip():
        raise DomainError("NAME_REQUIRED", "请为认证器填写名称", 422)
    # Abandoned first-registration attempts must not lock out enrollment.
    db.execute(
        delete(StaffCredentialRecord).where(
            StaffCredentialRecord.user_id == user.id,
            StaffCredentialRecord.verified.is_(False),
            StaffCredentialRecord.created_at < now_utc() - timedelta(minutes=5),
        )
    )
    if len(credentials(db, user.id)) >= 8:
        raise DomainError("MFA_CREDENTIAL_LIMIT", "最多登记8个认证器", 409)
    row.challenge, row.credential_name = (
        bytes_to_base64url(secrets.token_bytes(32)),
        payload.name.strip(),
    )
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name="TwinNKU 内容管理",
        user_id=UUID(user.id).bytes,
        user_name=user.username,
        user_display_name=user.display_name,
        challenge=base64url_to_bytes(row.challenge),
        timeout=120000,
        authenticator_selection=AuthenticatorSelectionCriteria(
            user_verification=UserVerificationRequirement.REQUIRED,
            resident_key=ResidentKeyRequirement.PREFERRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(c.credential_id))
            for c in credentials(db, user.id)
        ],
    )
    db.commit()
    return envelope(request, StaffMfaOptions(public_key=json.loads(options_to_json(options))))


@router.post("/registration/verify", response_model=Envelope[StaffMfaPending], openapi_extra=META)
def registration_verify(payload: StaffMfaProof, request: Request, db: DB):
    row, user = require_pending(request, db, {"enroll"})
    rp_id, origin = webauthn_scope(request)
    if not row.challenge or not row.credential_name or user.must_change_password:
        challenge_failure(db, row)
    if len(credentials(db, user.id)) >= 8:
        raise DomainError("MFA_CREDENTIAL_LIMIT", "最多登记8个认证器", 409)
    try:
        same_origin_credential(payload.credential, user)
        result = verify_registration_response(
            credential=payload.credential,
            expected_challenge=base64url_to_bytes(row.challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
        key = bytes_to_base64url(result.credential_id)
        if len(key) > 1400 or db.get(StaffCredentialRecord, key):
            raise ValueError("duplicate or oversized credential")
    except Exception:
        challenge_failure(db, row)
    db.add(
        StaffCredentialRecord(
            credential_id=key,
            user_id=user.id,
            public_key=bytes_to_base64url(result.credential_public_key),
            sign_count=result.sign_count,
            name=row.credential_name,
            transports=[],
            verified=False,
            backup_eligible=result.credential_device_type.value == "multi_device",
            backed_up=result.credential_backed_up,
        )
    )
    # Registration alone does not enable MFA: first prove this key can sign a login.
    row.purpose, row.challenge = "login", None
    row.bound_credential_id = key
    audit(db, user, "user.mfa_registered", details={"name": row.credential_name})
    db.commit()
    return envelope(request, pending_view(row, user))


@router.post("/pending/password", response_model=Envelope[StaffMfaPending], openapi_extra=META)
def pending_password(payload: StaffPasswordChange, request: Request, response: Response, db: DB):
    row, user = require_pending(request, db, {"enroll"})
    if not user.must_change_password or not verify_password(
        user.password_hash, payload.current_password.get_secret_value()
    ):
        challenge_failure(db, row)
    if payload.current_password.get_secret_value() == payload.new_password.get_secret_value():
        raise DomainError("PASSWORD_UNCHANGED", "新密码不能与当前密码相同", 422)
    user.password_hash = hash_password(payload.new_password.get_secret_value())
    user.must_change_password, user.revision = False, user.revision + 1
    revoke_sessions(db, user.id)
    row = set_pending(db, user, request, response, purpose="enroll")
    audit(db, user, "user.password_changed")
    db.commit()
    return envelope(request, pending_view(row, user))


@router.post("/step-up", response_model=Envelope[StaffMfaPending], openapi_extra=META)
def step_up(request: Request, response: Response, actor: Auth, db: DB):
    row = set_pending(db, actor.user, request, response, purpose="stepup")
    db.commit()
    return envelope(request, pending_view(row, actor.user))


@router.get("", response_model=Envelope[StaffMfaStatus], openapi_extra=META)
def status(request: Request, actor: Auth, db: DB):
    return envelope(
        request,
        StaffMfaStatus(
            enforced=actor.mfa_enforced,
            enrolled=actor.user.mfa_enabled,
            verified=actor.session.mfa_verified_at is not None,
            credentials=[
                StaffMfaCredential(
                    id=c.credential_id,
                    name=c.name,
                    verified=c.verified,
                    created_at=utc(c.created_at).isoformat(),
                    last_used_at=utc(c.last_used_at).isoformat() if c.last_used_at else None,
                )
                for c in credentials(db, actor.user.id)
            ],
            recovery_codes_remaining=db.scalar(
                select(func.count())
                .select_from(StaffRecoveryCodeRecord)
                .where(StaffRecoveryCodeRecord.user_id == actor.user.id)
            ),
            enforcement_ready=member_readiness(db, actor.user)["ready"],
        ),
    )


@router.post("/activity", response_model=Envelope[ActionResult], openapi_extra=META)
def activity(request: Request, actor: Auth, db: DB):
    # Only explicit UI interaction sends this request; GET polling never extends idle time.
    actor.session.last_activity_at = now_utc()
    db.commit()
    return envelope(request, ActionResult())


@router.delete(
    "/credentials/{credential_id}", response_model=Envelope[StaffSession], openapi_extra=META
)
def remove_credential(
    credential_id: str, request: Request, response: Response, actor: Actor, db: DB
):
    require_recent_mfa(actor)
    user = db.scalar(
        select(StaffUserRecord).where(StaffUserRecord.id == actor.user.id).with_for_update()
    )
    rows = credentials(db, user.id)
    target = next((c for c in rows if c.credential_id == credential_id), None)
    if not target:
        raise DomainError("NOT_FOUND", "认证器不存在", 404)
    if target.verified and len([c for c in rows if c.verified]) <= 1:
        raise DomainError(
            "LAST_AUTHENTICATOR", "请先登记并验证备用认证器，不能删除最后一个认证器", 409
        )
    db.delete(target)
    user.revision += 1
    verified_at = actor.session.mfa_verified_at
    revoke_sessions(db, user.id)
    principal = new_session(db, user, request, response, mfa_verified=True)
    principal.session.mfa_verified_at = verified_at
    audit(db, user, "user.mfa_removed", details={"name": target.name})
    db.commit()
    return envelope(request, session_view(principal, db))


@router.post("/recovery-codes", response_model=Envelope[StaffMfaRecoveryCodes], openapi_extra=META)
def recovery_codes(request: Request, response: Response, actor: Actor, db: DB):
    if not actor.user.mfa_enabled:
        raise DomainError("MFA_REQUIRED", "请先登记并验证通行密钥", 403)
    require_recent_mfa(actor)
    user = db.scalar(
        select(StaffUserRecord).where(StaffUserRecord.id == actor.user.id).with_for_update()
    )
    db.execute(delete(StaffRecoveryCodeRecord).where(StaffRecoveryCodeRecord.user_id == user.id))
    codes = [secrets.token_urlsafe(32) for _ in range(10)]
    db.add_all([StaffRecoveryCodeRecord(code_hash=digest(c), user_id=user.id) for c in codes])
    user.revision += 1
    verified_at = actor.session.mfa_verified_at
    revoke_sessions(db, user.id)
    principal = new_session(db, user, request, response, mfa_verified=True)
    principal.session.mfa_verified_at = verified_at
    audit(db, user, "user.mfa_recovery_codes_regenerated")
    db.commit()
    return envelope(request, StaffMfaRecoveryCodes(codes=codes, session=session_view(principal, db)))


@router.post("/recovery", response_model=Envelope[StaffMfaPending], openapi_extra=META)
def recover(payload: StaffMfaRecovery, request: Request, response: Response, db: DB):
    row, user = require_pending(request, db, {"login", "recover"})
    code = db.scalar(
        select(StaffRecoveryCodeRecord)
        .where(
            StaffRecoveryCodeRecord.user_id == user.id,
            StaffRecoveryCodeRecord.code_hash == digest(payload.code.get_secret_value().strip()),
        )
        .with_for_update()
    )
    if not code:
        challenge_failure(db, row)
    db.delete(code)
    # Recovery never returns a business session. All old factors become unavailable.
    db.execute(delete(StaffCredentialRecord).where(StaffCredentialRecord.user_id == user.id))
    user.mfa_enabled, user.mfa_recovery_until = True, now_utc() + timedelta(minutes=15)
    user.revision += 1
    revoke_sessions(db, user.id)
    row = set_pending(db, user, request, response, purpose="enroll")
    audit(db, user, "user.mfa_recovery_used")
    db.commit()
    return envelope(request, pending_view(row, user))
