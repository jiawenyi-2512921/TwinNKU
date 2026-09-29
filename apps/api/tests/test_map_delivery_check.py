"""Real loopback HTTP tests for the bounded anonymous delivery checker."""

import ast
import base64
import gzip
import importlib.util
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_map_delivery.py"
spec = importlib.util.spec_from_file_location("map_delivery_check", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
MAP_ID = "12345678-1234-1234-1234-123456789abc"
TILE = f"/api/v1/maps/{MAP_ID}/tiles/3/0/0/0.png"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tZkAAAAASUVORK5CYII="
)


@pytest.fixture
def site():
    state = {"requests": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            state["requests"].append((self.path, dict(self.headers)))
            if state.get("slow"):
                time.sleep(0.35)
            if self.path == "/":
                if state.get("redirect"):
                    self.send_response(302)
                    self.send_header("Location", "https://invalid.example/?secret=NEVER_LOG_ME")
                    self.end_headers()
                    return
                if state.get("no_script"):
                    return self.send(b"<html>No app deployed</html>", "text/html")
                src = state.get("script", "/assets/index-ABCdef12.js")
                return self.send(
                    (f'<html><script type="module" src="{src}"></script></html>').encode(),
                    "text/html",
                )
            if self.path == "/assets/index-ABCdef12.js":
                body = b"const proof = 'actual served javascript';\n" * 80
                if state.get("oversized"):
                    body *= 500
                headers = {
                    "Cache-Control": state.get(
                        "script_cache", "public, max-age=31536000, immutable"
                    )
                }
                if not state.get("old_assets"):
                    headers["Content-Encoding"] = "gzip"
                    body = gzip.compress(body)
                else:
                    headers["Cache-Control"] = "no-store"
                return self.send(body, "text/javascript", headers=headers)
            if self.path == "/api/v1/campuses":
                if state.get("api_error"):
                    return self.send(b"secret server stack", "text/plain", 503)
                return self.send_json([] if state.get("empty") else [{"id": "nku-jinnan"}])
            if self.path == "/api/v1/campuses/nku-jinnan/maps?kind=campus":
                if state.get("maps_empty"):
                    return self.send_json([])
                template = state.get("tile", f"/api/v1/maps/{MAP_ID}/tiles/3/{{z}}/{{x}}/{{y}}.png")
                return self.send_json(
                    [
                        {
                            "id": MAP_ID,
                            "campus_id": "nku-jinnan",
                            "kind": "campus",
                            "revision": 3,
                            "tiles": {"url_template": template, "min_zoom": 0},
                        }
                    ]
                )
            if self.path == TILE:
                headers = {"ETag": '"current-v3"', "Cache-Control": "private, no-cache"}
                conditional = self.headers.get("If-None-Match") == '"current-v3"'
                return self.send(
                    b"" if conditional and not state.get("ignore_etag") else PNG,
                    "image/png",
                    304 if conditional and not state.get("ignore_etag") else 200,
                    headers,
                )
            self.send(b"not found", "text/plain", 404)

        def send_json(self, data):
            self.send(
                json.dumps({"data": data, "meta": {"request_id": "test"}}).encode(),
                "application/json",
            )

        def send(self, body, mime, status=200, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Set-Cookie", "private_session=DO_NOT_SEND_OR_REPORT")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}"
    yield state
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def run(site, **kwargs):
    return checker.DeliveryCheck(site["url"], timeout=3, max_seconds=20).run(**kwargs)


def steps(report):
    return {item["step"]: item for item in report["steps"]}


def test_current_revision_tile_304_gzip_hash_cache_and_anonymous_gets(site):
    report = run(site, strict=True)
    assert report["result"] == "pass"
    assert report["requests_sent"] == 6
    result = steps(report)
    assert result["entry_script"]["gzip"] is True
    assert result["entry_script"]["wire_bytes"] < result["entry_script"]["decoded_bytes"]
    assert result["tile"]["map_revision"] == 3
    assert result["tile_revalidation"]["status"] == 304
    assert result["tile_revalidation"]["wire_bytes"] == 0
    assert [path for path, _ in site["requests"]].count(TILE) == 2
    for _, headers in site["requests"]:
        assert "Cookie" not in headers and "Authorization" not in headers
    serialized = json.dumps(report)
    assert "DO_NOT_SEND_OR_REPORT" not in serialized
    assert "?kind" not in serialized
    assert "不是浏览器" in report["scope"]


@pytest.mark.parametrize("field", ["empty", "maps_empty"])
def test_unpublished_content_is_explicit_skip_but_script_still_checked(site, field):
    site[field] = True
    report = run(site, strict=True)
    assert report["result"] == "partial"
    assert steps(report)["entry_script"]["state"] == "pass"
    assert steps(report)["tile"]["state"] == "skip"
    assert report["requests_sent"] <= 4


def test_api_failure_keeps_independent_frontend_results_and_does_not_leak_body(site):
    site["api_error"] = True
    report = run(site)
    assert report["result"] == "fail"
    assert steps(report)["entry_script"]["state"] == "pass"
    assert steps(report)["campuses"]["status"] == 503
    assert steps(report)["tile"]["state"] == "skip"
    assert "secret server stack" not in json.dumps(report)


@pytest.mark.parametrize(
    "field,value,step",
    [
        (
            "script",
            "https://outside.invalid/assets/index-ABCdef12.js?token=NEVER_LOG_ME",
            "entry_script",
        ),
        ("script", "/assets/index-ABCdef12.js?token=NEVER_LOG_ME", "entry_script"),
        (
            "tile",
            f"https://outside.invalid/api/v1/maps/{MAP_ID}/tiles/3/{{z}}/{{x}}/{{y}}.png",
            "tile",
        ),
    ],
)
def test_cross_origin_or_credential_query_resource_is_rejected_before_request(
    site, field, value, step
):
    site[field] = value
    report = run(site)
    assert steps(report)[step]["state"] == "fail"
    assert "NEVER_LOG_ME" not in json.dumps(report)
    assert not any("token=" in path for path, _ in site["requests"])
    assert report["requests_sent"] < 6


def test_redirect_is_not_followed_and_destination_is_not_logged(site):
    site["redirect"] = True
    report = run(site)
    assert steps(report)["homepage"]["status"] == 302
    assert steps(report)["homepage"]["state"] == "fail"
    assert "NEVER_LOG_ME" not in json.dumps(report)
    assert "invalid.example" not in json.dumps(report)


def test_conditional_get_returning_200_is_a_failure(site):
    site["ignore_etag"] = True
    report = run(site)
    assert steps(report)["tile_revalidation"]["status"] == 200
    assert steps(report)["tile_revalidation"]["state"] == "fail"


def test_strict_cli_checks_real_served_gzip_and_cache_and_saves_json(site, tmp_path):
    site["empty"] = True
    site["old_assets"] = True
    report_file = tmp_path / "delivery.json"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--base-url",
            site["url"],
            "--strict",
            "--json-out",
            str(report_file),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 1
    report = json.loads(report_file.read_text())
    assert steps(report)["entry_script"]["state"] == "fail"
    assert steps(report)["tile"]["state"] == "skip"
    assert json.loads(result.stdout) == report


def test_legacy_cache_reports_warning_without_strict(site):
    site["old_assets"] = True
    report = run(site)
    assert steps(report)["entry_script"]["state"] == "warn"
    assert report["result"] == "warn"


def test_compressed_body_expansion_is_bounded(site):
    site["oversized"] = True
    report = checker.DeliveryCheck(site["url"], timeout=3, max_seconds=20, max_bytes=1024).run()
    assert steps(report)["entry_script"]["state"] == "fail"
    assert "上限" in steps(report)["entry_script"]["detail"]


def test_hard_time_budget_stops_slow_requests_and_request_count_is_bounded(site):
    site["slow"] = True
    before = time.monotonic()
    report = checker.DeliveryCheck(site["url"], timeout=0.1, max_seconds=0.15).run()
    assert report["result"] == "fail"
    assert report["requests_sent"] <= 2
    assert time.monotonic() - before < 1.5
    check = checker.DeliveryCheck(site["url"])
    check.count = checker.MAX_REQUESTS
    assert check.get("unused", "/") is None
    assert check.count == checker.MAX_REQUESTS


@pytest.mark.parametrize(
    "base",
    [
        "https://name:password@example.org",
        "https://example.org/?token=secret",
        "file:///tmp/index.html",
        "https://example.org/subpath",
    ],
)
def test_base_url_rejects_credentials_queries_or_non_root_sites(base):
    with pytest.raises(checker.CheckError):
        checker.DeliveryCheck(base)


def test_python38_syntax_compatibility_only():
    ast.parse(SCRIPT.read_text(), feature_version=(3, 8))


def test_conflicting_no_store_cannot_pass_immutable_asset_check(site):
    site["script_cache"] = "public, max-age=31536000, immutable, no-store"
    report = run(site, strict=True)
    assert steps(report)["entry_script"]["state"] == "fail"
    assert steps(report)["entry_script"]["immutable_cache"] is False
    assert steps(report)["entry_script"]["network_elapsed_ms"] >= 0
