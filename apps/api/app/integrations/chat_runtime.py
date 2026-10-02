"""School chat transport with durable visitor isolation and paid-attempt quotas.

Process-local helpers remain for isolated demos; public routes use generate_db.
"""

import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from uuid import UUID

from app.core.errors import DomainError
from app.integrations.nk_api import ProbeError, request_json

COOKIE = "twinnku_agent"
logger = logging.getLogger("twinnku.agent")
UPSTREAM_FAILURE_REASONS = frozenset(
    {
        "INVALID_ENDPOINT",
        "INVALID_KEY_FORMAT",
        "UNEXPECTED_HTTP_STATUS",
        "NON_JSON_RESPONSE",
        "SSO_REDIRECT",
        "REDIRECT_BLOCKED",
        "AUTH_FAILED",
        "ACCESS_DENIED",
        "ENDPOINT_NOT_FOUND",
        "RATE_LIMITED",
        "HTTP_ERROR",
        "NETWORK_TIMEOUT",
        "TLS_ERROR",
        "NETWORK_ERROR",
        "TRANSPORT_ERROR",
        "RESPONSE_TOO_LARGE",
        "INVALID_JSON",
        "INVALID_RESPONSE_SHAPE",
        "PLATFORM_ERROR",
        "INVALID_CONVERSATION_RESPONSE",
        "NO_FINAL_ANSWER",
    }
)


def log_upstream(stage, reason, started, trace_id):
    # Never log upstream exception text, credentials or conversation content.
    safe_reason = reason if reason in UPSTREAM_FAILURE_REASONS else "UNKNOWN"
    if reason == "SUCCESS":
        safe_reason = reason
    logger.log(
        logging.INFO if reason == "SUCCESS" else logging.WARNING,
        "agent_upstream request_id=%s stage=%s reason=%s duration_ms=%.1f",
        str(trace_id) if isinstance(trace_id, UUID) else "-",
        stage,
        safe_reason,
        (time.monotonic() - started) * 1000,
    )


@dataclass
class ChatVisitor:
    user: str = field(default_factory=lambda: secrets.token_hex(10))
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    conversation: str | None = None
    last_guide_point: tuple[str, int, str] | None = None
    touched: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)
    requests: dict = field(default_factory=dict)
    turns: deque = field(default_factory=deque)


class ChatRuntime:
    def __init__(self, key, code, upstream=request_json):
        self.key, self.code, self.upstream = key, code, upstream
        self.sessions, self.logins, self.turns = {}, deque(), deque()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(4)

    def throttle(self, queue, limit, seconds):
        now = time.monotonic()
        while queue and queue[0] <= now - seconds:
            queue.popleft()
        if len(queue) >= limit:
            raise DomainError("RATE_LIMITED", "请求较多，请稍后再试", 429)
        queue.append(now)

    def login(self, code, old_token=None):
        with self.lock:
            self.throttle(self.logins, 30, 60)
            if not hmac.compare_digest(code.encode(), self.code.encode()):
                raise DomainError("LOGIN_FAILED", "访问口令不正确", 401)
            now = time.monotonic()
            self.sessions = {
                k: v for k, v in self.sessions.items() if now - v.touched < 3600 or v.lock.locked()
            }
            if old_token:
                self.sessions.pop(hashlib.sha256(old_token.encode()).digest(), None)
            if len(self.sessions) >= 64:
                idle = [(v.touched, k) for k, v in self.sessions.items() if not v.lock.locked()]
                if not idle:
                    raise DomainError("SERVICE_BUSY", "当前会话较多，请稍后再试", 503)
                self.sessions.pop(min(idle)[1])
            token, session = secrets.token_urlsafe(32), ChatVisitor()
            self.sessions[hashlib.sha256(token.encode()).digest()] = session
            return token, session

    def session(self, token):
        if not token or len(token) > 128:
            raise DomainError("LOGIN_REQUIRED", "请重新输入访问口令，新建对话", 401)
        with self.lock:
            session = self.sessions.get(hashlib.sha256(token.encode()).digest())
            if not session or time.monotonic() - session.touched >= 3600:
                raise DomainError("LOGIN_REQUIRED", "会话已过期或服务已重启，请新建对话", 401)
            session.touched = time.monotonic()
            return session

    def generate(
        self,
        session,
        request_id,
        fingerprint_body,
        prompt,
        *,
        visitor_limit=30,
        total_limit=120,
        trace_id: UUID | None = None,
        before_attempt=None,
        on_conversation=None,
    ):
        if not session.lock.acquire(blocking=False):
            raise DomainError("REQUEST_IN_PROGRESS", "上一条问题仍在处理中", 409)
        slot = False
        try:
            fingerprint = hashlib.sha256(
                json.dumps(fingerprint_body, sort_keys=True).encode()
            ).hexdigest()
            old = session.requests.get(str(request_id))
            if old:
                if old[0] != fingerprint:
                    raise DomainError("REQUEST_ID_REUSED", "请求标识已被不同问题使用", 409)
                if old[1] is None:
                    raise DomainError(
                        "RESULT_UNKNOWN", "上一请求结果不确定，请勿重复提交；可新建对话", 409
                    )
                return old[1]
            if len(session.requests) >= 100:
                raise DomainError("SESSION_FULL", "本次对话较长，请新建对话", 409)
            slot = self.slots.acquire(blocking=False)
            if not slot:
                raise DomainError("SERVICE_BUSY", "小开正在处理其他问题，请稍后再试", 503)
            with self.lock:
                self.throttle(session.turns, visitor_limit, 3600)
                self.throttle(self.turns, total_limit, 3600)
            session.requests[str(request_id)] = (fingerprint, None)
            stage = "create_conversation"
            started = time.monotonic()
            if not session.conversation:
                if before_attempt:
                    before_attempt()
                result = self.upstream(
                    "create_conversation",
                    {
                        "UserID": session.user,
                        "Inputs": {},
                        "ConversationName": "TwinNKU guide",
                    },
                    self.key,
                    30,
                )
                conversation = result.get("Conversation")
                cid = (
                    conversation.get("AppConversationID")
                    if isinstance(conversation, dict)
                    else None
                )
                if not isinstance(cid, str) or not 1 <= len(cid) <= 128:
                    raise ProbeError("INVALID_CONVERSATION_RESPONSE")
                session.conversation = cid
                if on_conversation:
                    on_conversation(cid)
                log_upstream(stage, "SUCCESS", started, trace_id)
            stage = "chat_query_v2"
            started = time.monotonic()
            if before_attempt:
                before_attempt()
            result = self.upstream(
                "chat_query_v2",
                {
                    "UserID": session.user,
                    "AppConversationID": session.conversation,
                    "Query": prompt,
                    "ResponseMode": "blocking",
                },
                self.key,
                60,
            )
            answer = result.get("answer")
            if (
                result.get("event") not in {"message", "message_end"}
                or not isinstance(answer, str)
                or not answer.strip()
                or len(answer) > 32000
            ):
                raise ProbeError("NO_FINAL_ANSWER")
            session.requests[str(request_id)] = (fingerprint, answer)
            log_upstream(stage, "SUCCESS", started, trace_id)
            return answer
        except ProbeError as e:
            code = str(e)
            log_upstream(
                stage, code if code in UPSTREAM_FAILURE_REASONS else "UNKNOWN", started, trace_id
            )
            if code == "NETWORK_TIMEOUT":
                if stage == "create_conversation":
                    raise DomainError(
                        "AGENT_CONVERSATION_TIMEOUT",
                        "学校对话服务创建会话超时，结果未确认，请勿立即重复发送",
                        503,
                    ) from None
                raise DomainError(
                    "AGENT_REPLY_TIMEOUT",
                    "学校对话服务等待回答超时，结果未确认，请勿立即重复发送",
                    503,
                ) from None
            if code in {"NETWORK_ERROR", "TLS_ERROR", "TRANSPORT_ERROR"}:
                raise DomainError(
                    "AGENT_UPSTREAM_CONNECTION_FAILED",
                    "本站暂时无法连通学校对话服务，请联系维护者检查上游连接；地图、楼层和导航仍可使用",
                    503,
                ) from None
            message = {
                "SSO_REDIRECT": "学校应用接口被登录认证拦截，请联系维护者核对应用授权",
                "AUTH_FAILED": "学校应用密钥验证失败，请联系维护者",
                "ACCESS_DENIED": "学校应用调用权限不足，请联系维护者",
                "RATE_LIMITED": "学校平台请求额度已达上限，请稍后再试",
                "NO_FINAL_ANSWER": "学校平台本次未返回有效回答，请换个问题或稍后重试",
            }.get(code, "学校对话服务暂不可用，地图、楼层和导航仍可使用")
            raise DomainError("AGENT_UPSTREAM_UNAVAILABLE", message, 503) from None
        finally:
            if slot:
                self.slots.release()
            session.lock.release()

    def generate_db(
        self,
        session,
        request_id,
        fingerprint_body,
        prompt,
        db,
        request,
        *,
        visitor_limit=30,
        total_limit=120,
        trace_id=None,
    ):
        """Persistent request idempotency and cross-worker isolation for visitors."""
        from sqlalchemy import func, select

        from app.integrations.public_agent_security import (
            PublicAgentRequest,
            PublicAgentSession,
            acquire_lease,
            paid_attempt,
            release_lease,
        )

        fingerprint = hashlib.sha256(
            json.dumps(fingerprint_body, sort_keys=True).encode()
        ).hexdigest()
        old = db.get(PublicAgentRequest, (session.token_hash, str(request_id)))
        if old:
            if old.fingerprint != fingerprint:
                raise DomainError("REQUEST_ID_REUSED", "请求标识已被不同问题使用", 409)
            if old.answer is None:
                raise DomainError(
                    "RESULT_UNKNOWN", "上一请求结果不确定，请勿重复提交；可新建对话", 409
                )
            return old.answer
        lease = acquire_lease(db, request, session.token_hash, "model")
        try:
            # Recheck after the cross-process session lease, before any supplier call.
            old = db.get(
                PublicAgentRequest, (session.token_hash, str(request_id)), populate_existing=True
            )
            if old:
                if old.fingerprint != fingerprint:
                    raise DomainError("REQUEST_ID_REUSED", "请求标识已被不同问题使用", 409)
                if old.answer is None:
                    raise DomainError("RESULT_UNKNOWN", "上一请求结果不确定，请勿重复提交", 409)
                return old.answer
            count = db.scalar(
                select(func.count())
                .select_from(PublicAgentRequest)
                .where(PublicAgentRequest.session_id == session.token_hash)
            )
            if count >= 100:
                raise DomainError("SESSION_FULL", "本次对话较长，请新建对话", 409)
            row = PublicAgentRequest(
                session_id=session.token_hash,
                request_id=str(request_id),
                fingerprint=fingerprint,
                answer=None,
                expires_at=session.expires_at,
            )
            db.add(row)
            db.commit()
            stored = db.get(PublicAgentSession, session.token_hash, populate_existing=True)
            local = ChatVisitor(
                user=stored.user_id, csrf=stored.csrf, conversation=stored.conversation_id
            )

            def reserve_attempt():
                paid_attempt(db, request, session.token_hash, "model", visitor_limit, total_limit)

            def save_conversation(cid):
                stored.conversation_id = cid
                db.commit()

            answer = self.generate(
                local,
                request_id,
                fingerprint_body,
                prompt,
                visitor_limit=visitor_limit,
                total_limit=total_limit,
                trace_id=trace_id,
                before_attempt=reserve_attempt,
                on_conversation=save_conversation,
            )
            row.answer = answer
            db.commit()
            return answer
        finally:
            release_lease(db, lease)
