"""School application API transport. No redirects, cookies or credential logging."""

import json
import socket
import ssl
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
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
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
    if base is not None and (not isinstance(base, dict) or base.get("StatusCode", 0) != 0):
        raise ProbeError("PLATFORM_ERROR")
    return result
