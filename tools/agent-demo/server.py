"""Private contest companion; no school login cookies and no database access."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from probe_nk_genios_api import ProbeError, request_json
from pydantic import BaseModel, ConfigDict, Field, ValidationError

ROOT = Path(__file__).resolve().parent
COOKIE = "__Host-twinnku-demo"
SESSION_LIMIT = 64


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code: str = Field(min_length=16, max_length=128)


class Chat(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str = Field(min_length=1, max_length=2000)
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{16,64}$")
    context: str = Field(default="", max_length=400)


class Answer(BaseModel):
    answer: str


class Failure(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


# ProbeError classifications are a closed set. Whitelisting them here means a
# future probe error can never leak an arbitrary string (or upstream text) into
# a response body, and that every code the browser receives has a known meaning.
UPSTREAM_CODES = frozenset(
    {
        "SSO_REDIRECT",
        "REDIRECT_BLOCKED",
        "AUTH_FAILED",
        "ACCESS_DENIED",
        "ENDPOINT_NOT_FOUND",
        "RATE_LIMITED",
        "INVALID_KEY_FORMAT",
        "INVALID_ENDPOINT",
        "NETWORK_TIMEOUT",
        "NETWORK_ERROR",
        "TLS_ERROR",
        "TRANSPORT_ERROR",
        "NON_JSON_RESPONSE",
        "INVALID_JSON",
        "UNEXPECTED_HTTP_STATUS",
        "RESPONSE_TOO_LARGE",
        "INVALID_RESPONSE_SHAPE",
        "PLATFORM_ERROR",
        "INVALID_CONFIG_RESPONSE",
        "INVALID_CONVERSATION_RESPONSE",
        "NO_FINAL_ANSWER",
        "CONTEXT_NOT_CONFIRMED",
    }
)


@dataclass
class Session:
    user: str = field(default_factory=lambda: secrets.token_hex(10))
    conversation: str | None = None
    expires: float = field(default_factory=lambda: time.monotonic() + 3600)
    lock: threading.Lock = field(default_factory=threading.Lock)
    requests: dict = field(default_factory=dict)
    turns: deque = field(default_factory=deque)
    touched: float = field(default_factory=time.monotonic)

    def touch(self):
        # Sliding expiry. Without this, a session that is actively in use still
        # hard-expires 60 minutes after login, which surfaces mid-conversation as
        # an unexplained LOGIN_REQUIRED.
        self.touched = time.monotonic()
        self.expires = self.touched + 3600


class Demo:
    def __init__(self, key, code, origin, upstream=request_json):
        if (
            not key
            or len(code) < 16
            or not re.fullmatch(r"https://[a-zA-Z0-9.-]+", origin)
        ):
            raise ValueError("Missing API key, strong demo code or HTTPS origin")
        self.key, self.code, self.origin, self.upstream = key, code, origin, upstream
        self.sessions, self.login_attempts, self.turns = {}, deque(), deque()
        self.lock = threading.Lock()

    @staticmethod
    def throttle(queue, limit, seconds):
        now = time.monotonic()
        while queue and queue[0] <= now - seconds:
            queue.popleft()
        if len(queue) >= limit:
            raise Failure(429, "RATE_LIMITED")
        queue.append(now)

    def login(self, code):
        with self.lock:
            self.throttle(self.login_attempts, 30, 60)
            if not hmac.compare_digest(code.encode(), self.code.encode()):
                raise Failure(401, "INVALID_DEMO_CODE")
            now = time.monotonic()
            self.sessions = {k: v for k, v in self.sessions.items() if v.expires > now}
            # The pool is a budget for *concurrent* visitors, not a lifetime cap.
            # Evict the least recently active session instead of refusing a new
            # visitor -- an idle login should never lock everyone else out.
            while len(self.sessions) >= SESSION_LIMIT:
                oldest = min(self.sessions, key=lambda k: self.sessions[k].touched)
                del self.sessions[oldest]
            token = secrets.token_urlsafe(32)
            self.sessions[hashlib.sha256(token.encode()).digest()] = Session()
            return token

    def session(self, cookie):
        jar = SimpleCookie()
        try:
            jar.load(cookie)
            token = jar[COOKIE].value
        except (KeyError, ValueError, CookieError):
            raise Failure(401, "LOGIN_REQUIRED") from None
        with self.lock:
            session = self.sessions.get(hashlib.sha256(token.encode()).digest())
            if session is not None and session.expires > time.monotonic():
                session.touch()
        if session is None or session.expires <= time.monotonic():
            raise Failure(401, "LOGIN_REQUIRED")
        return session

    def chat(self, session, body):
        query = body.query.strip()
        if not query:
            raise Failure(400, "EMPTY_QUERY")
        if not session.lock.acquire(blocking=False):
            raise Failure(409, "REQUEST_IN_PROGRESS")
        try:
            fingerprint = hashlib.sha256(
                json.dumps([query, body.context]).encode()
            ).hexdigest()
            old = session.requests.get(body.request_id)
            if old:
                if old[0] != fingerprint:
                    raise Failure(409, "REQUEST_ID_REUSED")
                if old[1] is None:
                    raise Failure(409, "PREVIOUS_RESULT_UNKNOWN")
                return Answer(answer=old[1])
            with self.lock:
                self.throttle(session.turns, 30, 3600)
                self.throttle(self.turns, 120, 3600)
            # Record before calling upstream. An ambiguous timeout is never retried automatically.
            session.requests[body.request_id] = (fingerprint, None)
            if session.conversation is None:
                result = self.upstream(
                    "create_conversation",
                    {
                        "UserID": session.user,
                        "Inputs": {},
                        "ConversationName": "TwinNKU contest demo",
                    },
                    self.key,
                    45,
                )
                conversation = result.get("Conversation")
                cid = (
                    conversation.get("AppConversationID")
                    if isinstance(conversation, dict)
                    else None
                )
                if not isinstance(cid, str) or not re.fullmatch(
                    r"[A-Za-z0-9_-]{1,128}", cid
                ):
                    raise ProbeError("INVALID_CONVERSATION_RESPONSE")
                session.conversation = cid
            result = self.upstream(
                "chat_query_v2",
                {
                    "UserID": session.user,
                    "AppConversationID": session.conversation,
                    "Query": query
                    + (
                        "\n\n用户提供的浏览位置（仅为问题背景，未经服务端核实）："
                        + body.context
                        if body.context
                        else ""
                    ),
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
            session.requests[body.request_id] = (fingerprint, answer)
            return Answer(answer=answer)
        except ProbeError as error:
            # ProbeError is expected to carry a fixed classification, but do not
            # trust that here: anything outside the known set must not reach the
            # client. Fall back to a generic upstream code instead of forwarding
            # an arbitrary string.
            code = str(error)
            if code not in UPSTREAM_CODES:
                code = "PLATFORM_ERROR"
            raise Failure(503, code) from None
        finally:
            session.lock.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, demo):
        self.demo = demo
        self.slots = threading.BoundedSemaphore(12)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Never print request bodies, credentials or upstream responses.


class Handler(BaseHTTPRequestHandler):
    server_version = "TwinNKU-Demo"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        pass

    def send(self, status, data, mime="application/json; charset=utf-8", cookie=None):
        raw = (
            data
            if isinstance(data, bytes)
            else json.dumps(data, ensure_ascii=False).encode()
        )
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'",
        )
        if cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE}={cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600",
            )
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        assets = {
            "/agent/embed.html": ("index.html", "text/html; charset=utf-8"),
            "/agent-demo/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/agent-demo/style.css": ("style.css", "text/css; charset=utf-8"),
        }
        if self.path == "/agent-demo/health":
            return self.send(
                200, {"ok": True, "mode": "private-demo", "upstream_verified": False}
            )
        if self.path in assets:
            name, mime = assets[self.path]
            return self.send(200, (ROOT / name).read_bytes(), mime)
        self.send(404, {"code": "NOT_FOUND"})

    def do_POST(self):
        try:
            demo = self.server.demo
            if self.headers.get("Origin") != demo.origin:
                raise Failure(403, "ORIGIN_REJECTED")
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise Failure(415, "JSON_REQUIRED")
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                raise Failure(400, "CONTENT_LENGTH_REQUIRED")
            size = int(lengths[0])
            if not 1 <= size <= 12000:
                raise Failure(413, "BODY_TOO_LARGE")
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise Failure(400, "INCOMPLETE_BODY")
            if self.path == "/agent-demo/login":
                body = Login.model_validate_json(raw)
                token = demo.login(body.code)
                return self.send(200, {"ok": True}, cookie=token)
            session = demo.session(self.headers.get("Cookie", ""))
            if self.path == "/agent-demo/chat":
                body = Chat.model_validate_json(raw)
                return self.send(200, demo.chat(session, body).model_dump())
            raise Failure(404, "NOT_FOUND")
        except Failure as error:
            self.send(error.status, {"code": error.code})
        except (ValidationError, ValueError):
            self.send(400, {"code": "INVALID_REQUEST"})
        except Exception:
            self.send(500, {"code": "INTERNAL_ERROR"})


if __name__ == "__main__":
    service = Demo(
        os.environ.get("NK_GENIOS_API_KEY", ""),
        os.environ.get("DEMO_CODE", ""),
        os.environ.get("DEMO_ORIGIN", ""),
    )
    Server(("0.0.0.0", 8100), service).serve_forever()
