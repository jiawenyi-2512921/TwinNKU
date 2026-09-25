"""Exercise the operator check over HTTP with real API routes and explicit HTML fixtures.

These fixtures do not constitute a real Nginx or school-SDK validation.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from pydantic import SecretStr
from test_api import add_point

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from check_nk_genios import CheckError, fetch, main, run_checks, site_origin  # noqa: E402

MAIN_POLICY = "default-src 'self'; script-src 'self'; frame-ancestors 'self'"
EMBED_POLICY = (
    "default-src 'self'; script-src 'self' https://coze.nankai.edu.cn; "
    "connect-src 'self' https://coze.nankai.edu.cn; "
    "frame-src https://coze.nankai.edu.cn; frame-ancestors 'self'"
)
MAIN_HTML = b'<html><div id="root"></div></html>'
EMBED_HTML = (
    b'<html><p id="agent-frame-status"></p>'
    b'<script type="module" src="/assets/embed-fixture.js"></script></html>'
)


@pytest.fixture
def deployment(client, db):
    point = add_point(db)
    settings = client.app.state.settings
    settings.nk_genios_web_app_key = SecretStr("embed-identifier-must-not-appear")
    settings.nk_genios_api_key = SecretStr("backend-secret-must-not-appear")
    settings.nk_genios_web_enabled = True
    overrides = {}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            requests.append(self.path)
            headers = []
            if self.path in overrides:
                status, headers, body = overrides[self.path]
            elif self.path.startswith("/api/"):
                response = client.get(self.path)
                status, headers, body = (
                    response.status_code,
                    list(response.headers.items()),
                    response.content,
                )
            elif self.path == "/":
                status, body = 200, MAIN_HTML
                headers = [("Content-Type", "text/html"), ("Content-Security-Policy", MAIN_POLICY)]
            elif self.path == "/agent/embed.html":
                status, body = 200, EMBED_HTML
                headers = [
                    ("Content-Type", "text/html"),
                    ("Cache-Control", "no-store"),
                    ("Content-Security-Policy", EMBED_POLICY),
                ]
            elif self.path == "/assets/embed-fixture.js":
                status, body = 200, b"// Explicit asset fixture; no SDK is executed.\n"
                headers = [("Content-Type", "application/javascript")]
            else:
                status, body = 404, b""
            self.send_response(status)
            for key, value in headers:
                if key.lower() != "content-length":
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", overrides, requests, point
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def failures(report):
    return {item["check"] for item in report["checks"] if item["status"] == "fail"}


def test_check_reads_six_real_public_routes_without_exposing_identifiers(
    deployment, tmp_path, capsys
):
    base, _, requests, _ = deployment
    report_path = tmp_path / "report.json"
    assert main(["--base-url", base, "--expect-enabled", "--json-out", str(report_path)]) == 0
    saved = json.loads(report_path.read_text())
    assert saved["ok"]
    statuses = {item["check"]: item["status"] for item in saved["checks"]}
    assert all(
        statuses[name] == "pass"
        for name in [
            "listCampuses",
            "listPoints",
            "getPoint",
            "listFloors",
            "listPointPanoramas",
            "getGuidePoint",
        ]
    )
    assert statuses["school_sdk_http"] == statuses["real_platform_chat"] == "skip"
    output = report_path.read_text() + capsys.readouterr().out
    assert "embed-identifier" not in output and "backend-secret" not in output
    assert not any("admin" in path for path in requests)


def test_additional_proxy_csp_cannot_be_hidden_by_the_first_header(deployment):
    base, overrides, _, _ = deployment
    overrides["/agent/embed.html"] = (
        200,
        [
            ("Content-Type", "text/html"),
            ("Cache-Control", "no-store"),
            ("Content-Security-Policy", EMBED_POLICY),
            ("Content-Security-Policy", MAIN_POLICY),
        ],
        EMBED_HTML,
    )
    assert "embed_page_and_module" in failures(run_checks(base))


@pytest.mark.parametrize(
    "path", ["/agent/embed.html", "/assets/embed-fixture.js", "/api/v1/agent/web-config"]
)
def test_html_fallback_is_not_accepted_as_an_embed_asset_or_api(deployment, path):
    base, overrides, _, _ = deployment
    overrides[path] = (200, [("Content-Type", "text/html")], MAIN_HTML)
    assert not run_checks(base)["ok"]


def test_tool_links_cannot_target_another_site(deployment, client):
    base, overrides, _, point_id = deployment
    path = f"/api/v1/guide/points/{point_id}"
    body = client.get(path).json()
    body["data"]["links"][0]["url"] = f"https://unexpected.example/?point={point_id}"
    overrides[path] = (200, [("Content-Type", "application/json")], json.dumps(body).encode())
    assert "guide_link_targets" in failures(run_checks(base))


def test_redirect_is_not_followed_or_leaked_into_output(deployment):
    base, overrides, requests, _ = deployment
    overrides["/api/v1/agent/web-config"] = (
        302,
        [("Location", base + "/must-not-request?token=private-value")],
        b"private-response",
    )
    report = run_checks(base)
    assert "public_config" in failures(report)
    assert "private-" not in json.dumps(report)
    assert not any("must-not-request" in path for path in requests)


def test_disabled_config_requires_explicit_expectation(deployment, client):
    base, _, _, _ = deployment
    client.app.state.settings.nk_genios_web_enabled = False
    assert run_checks(base)["ok"]
    assert "embed_enabled" in failures(run_checks(base, expect_enabled=True))


def test_no_public_points_remains_an_explicit_unchecked_case(deployment, client, db):
    from app.models import PointRecord

    base, _, _, point_id = deployment
    point = db.get(PointRecord, point_id)
    point.status = "retired"
    db.commit()
    report = run_checks(base)
    assert any(
        item["check"] == "point_tools" and item["status"] == "skip" for item in report["checks"]
    )


def test_size_limit_and_malformed_list_produce_safe_diagnostics(deployment):
    base, overrides, _, _ = deployment
    overrides["/oversized"] = (200, [], b"x" * (2 * 1024 * 1024 + 1))
    with pytest.raises(CheckError, match="2 MiB"):
        fetch(base + "/oversized", 2)
    overrides["/api/v1/campuses"] = (
        200,
        [("Content-Type", "application/json")],
        b'{"data":["unexpected"]}',
    )
    assert "campus_selection" in failures(run_checks(base))


@pytest.mark.parametrize(
    "value",
    [
        "https://name:secret@2512921.cn",
        "http://2512921.cn",
        "https://2512921.cn/path",
        "https://2512921.cn/?token=secret",
        "https://2512921.cn:bad",
    ],
)
def test_invalid_target_never_echoes_supplied_credentials(value):
    with pytest.raises(ValueError) as error:
        site_origin(value)
    assert "secret" not in str(error.value)
