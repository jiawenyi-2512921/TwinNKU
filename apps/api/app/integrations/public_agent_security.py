"""Persistent anonymous isolation, atomic budgets and short-lived capabilities.

Every paid attempt reserves its budget before contacting a supplier. Database
errors never fall back to process-local counters. No raw client IP is stored.
"""

import hashlib
import ipaddress
import secrets
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    delete,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Mapped, mapped_column

from app.core.errors import DomainError
from app.models import Base, now_utc

COOKIE = "twinnku_agent"


def cookie_name(request):
    return "__Secure-" + COOKIE if request.app.state.settings.app_env == "production" else COOKIE


class PublicAgentSession(Base):
    __tablename__ = "public_agent_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), unique=True)
    csrf: Mapped[str] = mapped_column(String(64))
    is_public: Mapped[bool] = mapped_column(Boolean, default=True)
    conversation_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_point: Mapped[list | None] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PublicAgentRequest(Base):
    __tablename__ = "public_agent_requests"
    session_id: Mapped[str] = mapped_column(
        ForeignKey("public_agent_sessions.token_hash", ondelete="CASCADE"), primary_key=True
    )
    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PublicAgentCounter(Base):
    __tablename__ = "public_agent_counters"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    amount: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PublicAgentLease(Base):
    __tablename__ = "public_agent_leases"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PublicAgentCapability(Base):
    __tablename__ = "public_agent_capabilities"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    payload: Mapped[dict] = mapped_column(JSON)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def utc(value):
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def setting(settings, name, fallback):
    return getattr(settings, name, fallback)


def client_ip(request):
    """Only an explicitly trusted direct proxy may provide X-Real-IP."""
    peer = request.client.host if request.client else "unknown"
    trusted = setting(request.app.state.settings, "agent_trusted_proxy_ips", [])
    if peer in trusted:
        supplied = request.headers.get("x-real-ip", "")
        try:
            return str(ipaddress.ip_address(supplied))
        except ValueError:
            raise DomainError("INVALID_PROXY_IDENTITY", "代理身份校验失败", 403) from None
    try:
        return str(ipaddress.ip_address(peer))
    except ValueError:
        return peer[:128]


def require_origin(request):
    settings = request.app.state.settings
    expected = (
        settings.public_site_origin
        if settings.app_env == "production"
        else str(request.base_url).rstrip("/")
    )
    if request.headers.get("origin") != expected:
        raise DomainError("ORIGIN_DENIED", "请从本站页面发起请求", 403)


def _insert(db):
    return pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


def _add_counter(db, identity, limit, amount, seconds):
    bucket = int(time.time()) // seconds
    key = digest(f"{identity}:{seconds}:{bucket}")
    db.execute(
        _insert(db)(PublicAgentCounter)
        .values(key=key, amount=0, expires_at=datetime.fromtimestamp((bucket + 2) * seconds, UTC))
        .on_conflict_do_nothing(index_elements=["key"])
    )
    allowed = db.scalar(
        update(PublicAgentCounter)
        .where(PublicAgentCounter.key == key, PublicAgentCounter.amount <= limit - amount)
        .values(amount=PublicAgentCounter.amount + amount)
        .returning(PublicAgentCounter.amount)
    )
    if allowed is None:
        raise DomainError(
            "PUBLIC_BUDGET_REACHED", "服务额度暂时已满，请稍后再试；图文导览仍可使用", 429
        )


def reserve(db, entries):
    try:
        # Sort lock order consistently across all instances to avoid deadlocks.
        for identity, limit, amount, seconds in sorted(entries):
            _add_counter(db, identity, int(limit), int(amount), int(seconds))
        db.execute(
            delete(PublicAgentCounter)
            .where(PublicAgentCounter.expires_at < now_utc())
            .execution_options(synchronize_session=False)
        )
        db.commit()
    except DomainError:
        db.rollback()
        raise
    except SQLAlchemyError:
        db.rollback()
        raise DomainError(
            "PUBLIC_BUDGET_UNAVAILABLE", "费用保护服务暂不可用，请使用图文导览", 503
        ) from None


def http_budget(db, request, owner):
    cfg = request.app.state.settings
    ip = digest(client_ip(request) + ":" + now_utc().date().isoformat())
    reserve(
        db,
        [
            ("http:global", setting(cfg, "agent_http_requests_per_hour", 2400), 1, 3600),
            ("http:global", setting(cfg, "agent_http_requests_per_day", 14400), 1, 86400),
            ("http:ip:" + ip, setting(cfg, "agent_ip_requests_per_hour", 180), 1, 3600),
            ("http:ip:" + ip, setting(cfg, "agent_ip_requests_per_day", 1080), 1, 86400),
            ("http:visitor:" + owner, 480, 1, 3600),
        ],
    )


def paid_attempt(db, request, owner, kind, visitor_limit, total_limit, characters=0):
    cfg = request.app.state.settings
    ip = digest(client_ip(request) + ":" + now_utc().date().isoformat())
    daily = setting(
        cfg,
        "agent_model_requests_per_day" if kind == "model" else "agent_voice_requests_per_day",
        720 if kind == "model" else 1200,
    )
    entries = [
        (f"supplier:{kind}:global", total_limit, 1, 3600),
        (f"supplier:{kind}:global", daily, 1, 86400),
        (f"supplier:{kind}:visitor:{owner}", visitor_limit, 1, 3600),
        ("supplier:global", setting(cfg, "agent_supplier_requests_per_day", 1920), 1, 86400),
        (
            "supplier:visitor:" + owner,
            setting(cfg, "agent_supplier_session_requests_per_day", 450),
            1,
            86400,
        ),
        ("supplier:ip:" + ip, setting(cfg, "agent_supplier_ip_requests_per_day", 1080), 1, 86400),
        ("supplier:ip:" + ip, setting(cfg, "agent_ip_requests_per_hour", 180), 1, 3600),
    ]
    if characters:
        entries.append(
            (
                "supplier:voice:characters",
                setting(cfg, "agent_supplier_characters_per_day", 360000),
                characters,
                86400,
            )
        )
    reserve(db, entries)


def new_visitor(db, request, old_token=None, *, public=True):
    require_origin(request)
    http_budget(db, request, "guest:" + digest(client_ip(request)))
    try:
        if old_token and len(old_token) <= 128:
            existing = db.get(PublicAgentSession, digest(old_token))
            if existing and utc(existing.expires_at) > now_utc():
                return old_token, existing
        token = secrets.token_urlsafe(32)
        row = PublicAgentSession(
            token_hash=digest(token),
            user_id=secrets.token_hex(16),
            csrf=secrets.token_urlsafe(32),
            is_public=public,
            expires_at=now_utc()
            + timedelta(seconds=setting(request.app.state.settings, "agent_session_seconds", 3600)),
        )
        db.execute(
            delete(PublicAgentSession)
            .where(PublicAgentSession.expires_at < now_utc())
            .execution_options(synchronize_session=False)
        )
        db.execute(
            delete(PublicAgentCapability)
            .where(PublicAgentCapability.expires_at < now_utc())
            .execution_options(synchronize_session=False)
        )
        db.add(row)
        db.commit()
        return token, row
    except SQLAlchemyError:
        db.rollback()
        raise DomainError(
            "PUBLIC_SESSION_UNAVAILABLE", "会话服务暂不可用，请使用图文导览", 503
        ) from None


def visitor(db, request, write=False):
    token = request.cookies.get(cookie_name(request))
    if not token or len(token) > 128:
        raise DomainError("LOGIN_REQUIRED", "请重新开启小开会话", 401)
    try:
        row = db.get(PublicAgentSession, digest(token))
        if not row or utc(row.expires_at) <= now_utc():
            raise DomainError("LOGIN_REQUIRED", "会话已过期，请重新开启小开", 401)
        if row.is_public and not setting(request.app.state.settings, "agent_public_enabled", False):
            raise DomainError(
                "PUBLIC_AGENT_DISABLED", "公众智能服务暂未开放，图文导览仍可使用", 503
            )
        if write:
            require_origin(request)
            if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), row.csrf):
                raise DomainError("CSRF_INVALID", "对话校验已失效，请重新开启小开", 403)
        return row
    except SQLAlchemyError:
        db.rollback()
        raise DomainError(
            "PUBLIC_SESSION_UNAVAILABLE", "会话服务暂不可用，请使用图文导览", 503
        ) from None


def set_cookie(response, request, token, expires):
    remaining = max(1, int((utc(expires) - now_utc()).total_seconds()))
    response.set_cookie(
        cookie_name(request),
        token,
        max_age=remaining,
        path="/api/v1",
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )


def acquire_lease(db, request, owner, kind):
    cfg = request.app.state.settings
    limit = setting(
        cfg, "agent_model_concurrency" if kind == "model" else "agent_voice_concurrency", 4
    )
    try:
        gate = "lease-gate-" + kind
        db.execute(
            _insert(db)(PublicAgentCounter)
            .values(key=gate, amount=0, expires_at=now_utc() + timedelta(days=36500))
            .on_conflict_do_nothing(index_elements=["key"])
        )
        db.execute(
            update(PublicAgentCounter)
            .where(PublicAgentCounter.key == gate)
            .values(amount=PublicAgentCounter.amount)
        )
        db.execute(
            delete(PublicAgentLease)
            .where(PublicAgentLease.expires_at < now_utc())
            .execution_options(synchronize_session=False)
        )
        active = db.scalars(select(PublicAgentLease).where(PublicAgentLease.kind == kind)).all()
        if any(item.owner == owner for item in active):
            raise DomainError("REQUEST_IN_PROGRESS", "上一条请求仍在处理中", 409)
        if len(active) >= limit:
            raise DomainError("SERVICE_BUSY", "服务当前繁忙，请稍后再试", 503)
        key = str(uuid4())
        db.add(
            PublicAgentLease(
                id=key, owner=owner, kind=kind, expires_at=now_utc() + timedelta(minutes=5)
            )
        )
        db.commit()
        return key
    except DomainError:
        db.rollback()
        raise
    except SQLAlchemyError:
        db.rollback()
        raise DomainError("PUBLIC_BUDGET_UNAVAILABLE", "费用保护服务暂不可用", 503) from None


def release_lease(db, key):
    try:
        db.execute(delete(PublicAgentLease).where(PublicAgentLease.id == key))
        db.commit()
    except SQLAlchemyError:
        db.rollback()  # The lease expires; never silently permit a paid call.


def issue(db, owner, kind, payload, token=None, seconds=600):
    token = token or secrets.token_urlsafe(32)
    key = digest(token)
    expires = now_utc() + timedelta(seconds=seconds)
    stmt = (
        _insert(db)(PublicAgentCapability)
        .values(key=key, owner=owner, kind=kind, payload=payload, expires_at=expires)
        .on_conflict_do_nothing(index_elements=["key"])
    )
    db.execute(stmt)
    db.commit()
    return token


def capability(db, token, owner, kind):
    if len(token) > 128:
        raise DomainError("CAPABILITY_INVALID", "操作许可无效或已过期", 403)
    row = db.get(PublicAgentCapability, digest(token))
    if not row or row.owner != owner or row.kind != kind or utc(row.expires_at) <= now_utc():
        raise DomainError("CAPABILITY_INVALID", "操作许可无效或已过期", 403)
    return row


def speech_chunks(text, max_characters=300):
    """Server-owned deterministic chunks, returned in the manifest."""
    import re

    text = text.strip()
    first_cap = min(80, max_characters)
    if len(text) <= first_cap:
        return [text] if text else []
    ending = re.search(r"[。！？!?；;\n]", text)
    cut = ending.end() if ending and ending.end() <= first_cap else first_cap
    if not ending or cut != ending.end():
        comma = max(text.rfind(punctuation, 0, cut) for punctuation in ("，", ",", " "))
        if comma > cut / 3:
            cut = comma + 1
    # Preserve the existing short opening clip so speech can start before the
    # rest of a long paragraph is synthesized. Later clips use the full bound.
    result, current = [text[:cut]], ""
    pieces = re.findall(r"[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+", text[cut:])
    for piece in pieces:
        while len(piece) > max_characters:
            if current:
                result.append(current)
                current = ""
            result.append(piece[:max_characters])
            piece = piece[max_characters:]
        if len(current) + len(piece) > max_characters:
            result.append(current)
            current = ""
        current += piece
    if current:
        result.append(current)
    return result
