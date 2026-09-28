"""Probe the documented NK-GeniOS application API without browser cookies.

Python 3.8+ standard library. Default: one read-only configuration request.
--chat creates one test conversation and sends two non-sensitive prompts.
Secrets are read from NK_GENIOS_API_KEY or a hidden interactive prompt only.
No redirects, retries, response dumps, credential files, or production switches.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import secrets
import socket
import ssl
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

BASE_URL = "https://coze.nankai.edu.cn/api/proxy/api/v1"
LIMIT = 2 * 1024 * 1024
ENDPOINTS = {"get_app_config_preview", "create_conversation", "chat_query_v2"}


class ProbeError(Exception):
    """Messages must be fixed classifications, never upstream text or secrets."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(endpoint, body, key, timeout):
    if endpoint not in ENDPOINTS:
        raise ProbeError("INVALID_ENDPOINT")
    if not key or not key.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in key):
        raise ProbeError("INVALID_KEY_FORMAT")
    request = urllib.request.Request(
        BASE_URL + "/" + endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Apikey": key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        # No CookieJar: response cookies are neither retained nor reused.
        with urllib.request.build_opener(NoRedirect).open(
            request, timeout=timeout
        ) as response:
            if response.status != 200:
                raise ProbeError("UNEXPECTED_HTTP_STATUS")
            mime = response.headers.get_content_type()
            if mime != "application/json" and not mime.endswith("+json"):
                raise ProbeError("NON_JSON_RESPONSE")
            raw = response.read(LIMIT + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        location = error.headers.get("Location", "")
        error.close()
        if 300 <= status < 400:
            try:
                is_sso = urlsplit(location).hostname == "iam.nankai.edu.cn"
            except ValueError:
                is_sso = False
            raise ProbeError("SSO_REDIRECT" if is_sso else "REDIRECT_BLOCKED") from None
        categories = {
            401: "AUTH_FAILED",
            403: "ACCESS_DENIED",
            404: "ENDPOINT_NOT_FOUND",
            429: "RATE_LIMITED",
        }
        raise ProbeError(categories.get(status, "HTTP_ERROR")) from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise ProbeError("NETWORK_TIMEOUT") from None
        if isinstance(error.reason, ssl.SSLError):
            raise ProbeError("TLS_ERROR") from None
        raise ProbeError("NETWORK_ERROR") from None
    except (TimeoutError, socket.timeout):  # noqa: UP041 -- socket.timeout differs on Python 3.8
        raise ProbeError("NETWORK_TIMEOUT") from None
    except (OSError, ValueError):
        raise ProbeError("TRANSPORT_ERROR") from None
    if len(raw) > LIMIT:
        raise ProbeError("RESPONSE_TOO_LARGE")
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ProbeError("INVALID_JSON") from None
    if not isinstance(result, dict):
        raise ProbeError("INVALID_RESPONSE_SHAPE")
    base = result.get("BaseResp")
    if base is not None and (
        not isinstance(base, dict) or base.get("StatusCode", 0) != 0
    ):
        raise ProbeError("PLATFORM_ERROR")
    return result


def run_probe(key, *, chat=False, timeout=30, request_fn=request_json):
    user_id = secrets.token_hex(10)  # Platform limit: 1–20 characters.
    checks = []

    def record(name, status, code):
        checks.append({"check": name, "status": status, "code": code})

    stage = "application_config"
    try:
        config = request_fn("get_app_config_preview", {"UserID": user_id}, key, timeout)
        if not isinstance(config.get("Name"), str) or not config["Name"].strip():
            raise ProbeError("INVALID_CONFIG_RESPONSE")
        record(stage, "pass", "APPLICATION_API_REACHED")
        if chat:
            stage = "create_conversation"
            created = request_fn(
                "create_conversation",
                {
                    "UserID": user_id,
                    "Inputs": {},
                    "ConversationName": "TwinNKU API connectivity test",
                },
                key,
                timeout,
            )
            conversation = created.get("Conversation")
            conversation_id = (
                conversation.get("AppConversationID")
                if isinstance(conversation, dict)
                else None
            )
            if not isinstance(conversation_id, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", conversation_id
            ):
                raise ProbeError("INVALID_CONVERSATION_RESPONSE")
            record(stage, "pass", "TEST_CONVERSATION_CREATED")
            marker = "NKTEST" + secrets.token_hex(4).upper()
            prompts = [
                (
                    "first_answer",
                    f"这是连通性测试。请记住本次测试代号 {marker}，只回复已记录。",
                ),
                ("same_session_followup", "本次连通性测试代号是什么？请只回复代号。"),
            ]
            for stage, prompt in prompts:
                result = request_fn(
                    "chat_query_v2",
                    {
                        "UserID": user_id,
                        "AppConversationID": conversation_id,
                        "Query": prompt,
                        "ResponseMode": "blocking",
                    },
                    key,
                    timeout,
                )
                answer = result.get("answer")
                if (
                    result.get("event") not in {"message", "message_end"}
                    or not isinstance(answer, str)
                    or not answer.strip()
                ):
                    raise ProbeError("NO_FINAL_ANSWER")
                if stage == "same_session_followup" and marker not in answer:
                    raise ProbeError("CONTEXT_NOT_CONFIRMED")
                record(
                    stage,
                    "pass",
                    "ANSWER_RECEIVED"
                    if stage == "first_answer"
                    else "CONTEXT_CONFIRMED",
                )
        else:
            record("real_api_chat", "skip", "USE_CHAT_FLAG_TO_CREATE_TEST_CONVERSATION")
    except ProbeError as error:
        record(stage, "fail", str(error))
    record("public_website_chat", "skip", "NOT_TESTED_BY_THIS_SCRIPT")
    record("cross_user_isolation", "skip", "SEPARATE_ACCEPTANCE_REQUIRED")
    return {"ok": not any(c["status"] == "fail" for c in checks), "checks": checks}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--chat",
        action="store_true",
        help="Create one conversation and send two test prompts; consumes platform quota.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30,
        help="Per-request timeout in seconds (1–60).",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 60:
        parser.error("timeout must be between 1 and 60 seconds")
    key = os.environ.get("NK_GENIOS_API_KEY", "")
    if not key and sys.stdin.isatty():
        try:
            key = getpass.getpass("NK-GeniOS application API key (hidden): ")
        except (EOFError, KeyboardInterrupt):
            print("FAIL credentials: INPUT_CANCELLED")
            return 2
    if not key:
        print("FAIL credentials: MISSING_APPLICATION_API_KEY")
        print(
            "Use a secure server environment variable or an interactive terminal; do not pass the key as a command argument."
        )
        return 2
    report = run_probe(key, chat=args.chat, timeout=args.timeout)
    for check in report["checks"]:
        print(f"{check['status'].upper():4} {check['check']}: {check['code']}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
