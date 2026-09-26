"""Read-only deployment checks; never execute SDK code or print credentials.

Python 3.8+ standard library. Exit 1 means at least one failed check.
This cannot verify browser login, model answers, variable consumption or citations.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlsplit
from uuid import UUID

SDK_ORIGIN = "https://coze.nankai.edu.cn"
SDK_URL = SDK_ORIGIN + "/resources/product/llm/public/sdk/embedFull.js"
BODY_LIMIT = 2 * 1024 * 1024


class CheckError(Exception):
    """Only fixed, credential-free diagnostic messages are used here."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def site_origin(value):
    parts = urlsplit(value)
    host = parts.hostname or ""
    loopback = host == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(host).is_loopback
    except ValueError:
        pass
    if (
        parts.scheme not in ("http", "https")
        or not host
        or parts.username is not None
        or parts.password is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or (parts.scheme == "http" and not loopback)
    ):
        raise ValueError("Use an HTTPS site origin, or HTTP on localhost/loopback only.")
    # Validate the port without exposing the original input in errors.
    try:
        _ = parts.port
    except ValueError:
        raise ValueError("Invalid port.") from None
    return f"{parts.scheme}://{parts.netloc}"


def fetch(url, timeout, sample=False):
    request = urllib.request.Request(url, headers={"User-Agent": "TwinNKU-deployment-check/1"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
            body = response.read(8192 if sample else BODY_LIMIT + 1)
            if not sample and len(body) > BODY_LIMIT:
                raise CheckError("Response exceeded the 2 MiB check limit.")
            return response.headers, body
    except urllib.error.HTTPError as error:
        raise CheckError(f"HTTP {error.code}; redirects are not followed.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise CheckError(
            "Connection or TLS failed; check reachability from this machine."
        ) from None


def json_data(headers, body):
    try:
        if "application/json" not in headers.get("Content-Type", "").lower():
            raise ValueError
        document = json.loads(body)
        if not isinstance(document, dict) or "data" not in document:
            raise ValueError
        return document["data"]
    except (ValueError, TypeError, UnicodeError):
        raise CheckError(
            "Expected a JSON API envelope; this may be an old API or an HTML fallback."
        ) from None


class Page(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.ids = set()
        self.modules = []
        self.sdk_in_main = False
        self.feed(body.decode("utf-8", errors="replace"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "script":
            src = attrs.get("src", "")
            if attrs.get("type") == "module" and src:
                self.modules.append(src)
            if src.startswith(SDK_ORIGIN):
                self.sdk_in_main = True


def policies(headers):
    # Separate headers are enforced together; a comma also separates policies.
    result = []
    for header in headers.get_all("Content-Security-Policy", []):
        for value in header.split(","):
            directives = {}
            for part in value.split(";"):
                tokens = part.strip().split()
                if tokens:
                    directives.setdefault(tokens[0].lower(), tokens[1:])
            if directives:
                result.append(directives)
    return result


def sources(policy, *names):
    for name in names:
        if name in policy:
            return policy[name]
    return policy.get("default-src", [])


def check_csp(headers, embedded):
    items = policies(headers)
    if not items:
        raise CheckError("Missing enforced Content-Security-Policy header.")
    for policy in items:
        script = sources(policy, "script-src-elem", "script-src")
        if "*" in script or "'unsafe-eval'" in script or "'unsafe-inline'" in script:
            raise CheckError("Script policy is broader than the delivered configuration.")
        if embedded:
            for allowed, needed in [
                (script, {SDK_ORIGIN, SDK_URL}),
                (sources(policy, "connect-src"), {SDK_ORIGIN}),
                (sources(policy, "frame-src", "child-src"), {SDK_ORIGIN}),
            ]:
                if not needed.intersection(allowed):
                    raise CheckError(
                        "An embed CSP policy blocks the school host; check the outer proxy too."
                    )
            if "'self'" not in policy.get("frame-ancestors", []):
                raise CheckError("Embed frame-ancestors must allow the site's own frame.")
        elif SDK_ORIGIN in script or SDK_URL in script:
            raise CheckError("The main page must retain its original script policy.")
    if embedded and headers.get("X-Frame-Options", "").upper() == "DENY":
        raise CheckError("X-Frame-Options DENY blocks the embedded document.")


def guide_links(data, point_id, public_origin):
    if (
        not isinstance(data, dict)
        or data.get("point", {}).get("id") != point_id
        or data.get("interaction") != "user_click_link"
        or not isinstance(data.get("links"), list)
        or not data["links"]
    ):
        raise CheckError("Guide payload is missing the expected point, interaction or links.")
    floors = {str(floor["id"]): floor for floor in data.get("floors", [])}
    panoramas = {str(item["id"]) for item in data.get("panoramas", [])}
    for link in data["links"]:
        url = urlsplit(link.get("url", ""))
        query = parse_qs(url.query)
        if (
            url.username is not None
            or url.password is not None
            or f"{url.scheme}://{url.netloc}" != public_origin
            or url.path != "/"
            or url.fragment
            or query.get("point") != [point_id]
            or link.get("point_id") != point_id
        ):
            raise CheckError("A guide link has an unexpected origin or point target.")
        resource = link.get("resource_id")
        if link.get("kind") == "show_floor":
            floor = floors.get(resource)
            if (
                not floor
                or query.get("floor") != [resource]
                or query.get("floor_section") != [link.get("section")]
                or not any(
                    image.get("section") == link.get("section")
                    and image.get("variant") == "labeled"
                    for image in floor.get("images", [])
                )
            ):
                raise CheckError("A floor link does not match the returned labeled resource.")
        elif link.get("kind") == "open_vr":
            if resource not in panoramas or query.get("panorama") != [resource]:
                raise CheckError("A panorama link does not match the returned public resource.")
        elif link.get("kind") != "focus_point":
            raise CheckError("Unknown guide-link kind.")


def run_checks(base, *, campus_id=None, expect_enabled=False, check_sdk=False, timeout=8):
    checks = []

    def record(name, status, detail):
        checks.append({"check": name, "status": status, "detail": detail})

    def attempt(name, operation):
        try:
            value = operation()
            record(name, "pass", "Check passed.")
            return value
        except CheckError as error:
            record(name, "fail", str(error))
        except (ValueError, TypeError, KeyError, AttributeError):
            record(name, "fail", "Unexpected public response shape; no response body was recorded.")
        return None

    def api(path):
        return json_data(*fetch(base + path, timeout))

    def config_check():
        headers, body = fetch(base + "/api/v1/agent/web-config", timeout)
        data = json_data(headers, body)
        if not isinstance(data, dict) or type(data.get("enabled")) is not bool:
            raise CheckError(
                "Missing web embed configuration; deploy the new API as well as the web app."
            )
        if "no-store" not in headers.get("Cache-Control", "").lower():
            raise CheckError("The public embed configuration must use Cache-Control: no-store.")
        if data.get("base_url") != SDK_ORIGIN or data.get("sdk_url") != SDK_URL:
            raise CheckError("Unexpected SDK origin or script URL.")
        key = data.get("app_key")
        if data["enabled"]:
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
                raise CheckError("Enabled configuration has no valid WebSDK identifier.")
        elif key is not None:
            raise CheckError("Disabled configuration must not return the WebSDK identifier.")
        public_origin = site_origin(data.get("public_site_origin", ""))
        if not public_origin.startswith("https://"):
            raise CheckError("Public guide links must use the HTTPS website origin.")
        return {"enabled": data["enabled"], "public_origin": public_origin}

    config = attempt("public_config", config_check)
    if config and not config["enabled"]:
        record(
            "embed_enabled",
            "fail" if expect_enabled else "warn",
            "Web embed is disabled by deployment configuration.",
        )
    elif config:
        record(
            "embed_enabled",
            "pass",
            "Configured; this does not prove platform login or chat availability.",
        )

    def page_check(path, embedded):
        headers, body = fetch(base + path, timeout)
        if "text/html" not in headers.get("Content-Type", "").lower():
            raise CheckError("Expected a built HTML page.")
        page = Page(body)
        if ("agent-frame-status" if embedded else "root") not in page.ids:
            raise CheckError(
                "Unexpected HTML; the embed path may be falling back to the main page."
            )
        if not embedded and page.sdk_in_main:
            raise CheckError("A duplicate SDK script was inserted directly into the main page.")
        check_csp(headers, embedded)
        if embedded:
            if "no-store" not in headers.get("Cache-Control", "").lower():
                raise CheckError("The embed document must use Cache-Control: no-store.")
            if not page.modules:
                raise CheckError("Missing built embed module.")
            for source in page.modules:
                url = urljoin(base + path, source)
                parsed = urlsplit(url)
                if f"{parsed.scheme}://{parsed.netloc}" != base or not parsed.path.startswith(
                    "/assets/"
                ):
                    raise CheckError("Embed module must be a built asset from this site.")
                module_headers, module = fetch(url, timeout)
                if (
                    "javascript" not in module_headers.get("Content-Type", "").lower()
                    or not module.strip()
                ):
                    raise CheckError(
                        "Embed JavaScript is missing or was replaced by an HTML fallback."
                    )

    attempt("main_page_csp", lambda: page_check("/", False))
    attempt("embed_page_and_module", lambda: page_check("/agent/embed.html", True))
    campuses = attempt("listCampuses", lambda: api("/api/v1/campuses"))
    campus = None
    if isinstance(campuses, list) and all(
        isinstance(item, dict) and item.get("id") for item in campuses
    ):
        campus = next(
            (item for item in campuses if not campus_id or item.get("id") == campus_id), None
        )
        if campus is None:
            record(
                "campus_selection",
                "fail" if campus_id else "warn",
                "No matching public campus; point tool checks were not run.",
            )
    else:
        record("campus_selection", "fail", "Expected a public campus list.")
    point_id = None
    if campus:
        points = attempt(
            "listPoints",
            lambda: api(
                "/api/v1/campuses/" + quote(str(campus["id"]), safe="") + "/points?page_size=1"
            ),
        )
        if isinstance(points, list) and points:
            try:
                point_id = str(UUID(points[0]["id"]))
            except (ValueError, TypeError, KeyError, AttributeError):
                record("point_selection", "fail", "Point list did not return a valid point ID.")
        elif points == []:
            record(
                "point_selection",
                "warn",
                "No published points; detail and guide checks were not run.",
            )
        elif points is not None:
            record("point_selection", "fail", "Expected a public point list.")
    if point_id:
        point = attempt("getPoint", lambda: api(f"/api/v1/points/{point_id}"))
        if not isinstance(point, dict) or point.get("id") != point_id:
            record("point_identity", "fail", "Point details did not match the requested point.")
        for name, suffix in [("listFloors", "floors"), ("listPointPanoramas", "panoramas")]:
            value = attempt(name, lambda suffix=suffix: api(f"/api/v1/points/{point_id}/{suffix}"))
            if not isinstance(value, list):
                record(name + "_shape", "fail", "Expected a list; an empty list is valid.")
        guide = attempt("getGuidePoint", lambda: api(f"/api/v1/guide/points/{point_id}"))
        if guide is not None and config:
            attempt(
                "guide_link_targets", lambda: guide_links(guide, point_id, config["public_origin"])
            )
    else:
        record(
            "point_tools",
            "skip",
            "No public point selected; four point-specific tools were not checked.",
        )

    if check_sdk:

        def sdk_check():
            headers, body = fetch(SDK_URL, timeout, sample=True)
            if "javascript" not in headers.get("Content-Type", "").lower() or not body.strip():
                raise CheckError("School URL did not return a JavaScript response.")

        attempt("school_sdk_http", sdk_check)
    else:
        record(
            "school_sdk_http",
            "skip",
            "Use --check-sdk to test access from this machine; the script is never executed.",
        )
    record(
        "real_platform_chat",
        "skip",
        "Manually verify login, model replies, citations, variables and mobile layout in the website.",
    )
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),  # noqa: UP017 -- Python 3.8 CLI
        "site": base,
        "ok": not any(item["status"] == "fail" for item in checks),
        "checks": checks,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://2512921.cn")
    parser.add_argument("--campus-id")
    parser.add_argument("--expect-enabled", action="store_true")
    parser.add_argument("--check-sdk", action="store_true")
    parser.add_argument("--timeout", type=float, default=8)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args(argv)
    try:
        base = site_origin(args.base_url)
    except ValueError as error:
        parser.error(str(error))
    if not 0 < args.timeout <= 60:
        parser.error("--timeout must be greater than 0 and at most 60 seconds.")
    if args.json_out and args.json_out.exists():
        parser.error("Report path already exists; choose a new filename.")
    report = run_checks(
        base,
        campus_id=args.campus_id,
        expect_enabled=args.expect_enabled,
        check_sdk=args.check_sdk,
        timeout=args.timeout,
    )
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        with args.json_out.open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
    for check in report["checks"]:
        print(f"{check['status'].upper():4} {check['check']}: {check['detail']}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
