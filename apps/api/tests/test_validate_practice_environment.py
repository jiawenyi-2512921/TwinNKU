"""Acceptance-tool guards and the real HTTP staffing/configuration protocol."""

import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from test_practice_environment import training_settings

from app.database import get_db
from app.main import create_app
from app.modules.admin import bootstrap

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "practice_acceptance", ROOT / "scripts/validate_practice_environment.py"
)
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)
IMAGES = {kind: "sha256:" + character * 64 for kind, character in (("API", "a"), ("WEB", "b"), ("DB", "c"))}


@pytest.mark.parametrize("kind", ["container", "network", "volume"])
@pytest.mark.parametrize("labelled", [True, False])
def test_preflight_rejects_existing_training_objects_including_unlabelled_collision(kind, labelled):
    def command(args):
        if args[1] == kind and args[-1].startswith("label=" if labelled else "name="):
            return "owned-or-foreign-collision\n"
        return ""

    with pytest.raises(tool.ValidationFailure):
        tool.require_no_practice_objects(command)


def production_rows():
    return [{"Id": "fixed-" + role, "Name": "/" + name,
             "project": "twinnku", "service": role, "state": "running", "health": "healthy"}
            for role, name in tool.PRODUCTION_NAMES.items()]


@pytest.mark.parametrize("change", ["name", "project", "health", "missing", "duplicate"])
def test_production_snapshot_cannot_accept_other_or_unhealthy_containers(change):
    rows = production_rows()
    def command(_):
        return "\n".join(json.dumps(row) for row in rows)

    assert len(tool.production_snapshot(command)) == 3
    if change == "name":
        rows[0]["Name"] = "/not-production"
    elif change == "project":
        rows[0]["project"] = "twinnku-practice"
    elif change == "health":
        rows[0]["health"] = "unhealthy"
    elif change == "missing":
        rows.pop()
    else:
        rows[1] = rows[0]
    with pytest.raises(tool.ValidationFailure):
        tool.production_snapshot(command)


def test_failed_command_does_not_report_stdout_or_stderr_secrets(monkeypatch):
    secret = "Do-not-print-test-credential-or-private-response"
    monkeypatch.setattr(tool.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=1, stdout=secret, stderr=secret,
    ))
    with pytest.raises(tool.ValidationFailure) as raised:
        tool.Commands()(["docker", "compose", "up"])
    assert secret not in str(raised.value)


def test_timeout_diagnostics_record_only_bounded_metadata(monkeypatch):
    secret = "never-report-secret-input-or-output"
    def timed_out(*args, **kwargs):
        raise tool.subprocess.TimeoutExpired(args[0], 210, output=secret, stderr=secret)
    monkeypatch.setattr(tool.subprocess, "run", timed_out)
    commands = tool.Commands()
    with pytest.raises(tool.ValidationFailure) as raised:
        commands(["docker", "compose", "--env-file", secret, "up"], input_text=secret, timeout=210)
    assert secret not in str(raised.value)
    assert secret not in json.dumps(commands.last_failure)
    assert commands.last_failure["operation"] == "compose_up"
    assert commands.last_failure["reason"] == "timeout"
    assert commands.last_failure["limit_seconds"] == 210


def test_startup_diagnostics_read_only_exact_owned_training_state():
    names = [f"/{tool.practice.PROJECT}-{service}-1" for service in sorted(tool.practice.SERVICES)]
    rows = [{"name": name, "project": tool.practice.PROJECT, "purpose": "practice", "state": "created",
             "exit_code": 0, "oom_killed": False, "pid": 0, "health": None} for name in names]
    def command(args):
        assert args[:3] == ["docker", "container", "inspect"]
        assert ".Config.Env" not in args[4] and ".Config.Cmd" not in args[4]
        assert args[5:] == [name[1:] for name in names]
        return "\n".join(json.dumps(row) for row in rows)
    assert tool.startup_diagnostics(command) == rows
    rows[0]["project"] = "twinnku"
    with pytest.raises(tool.ValidationFailure):
        tool.startup_diagnostics(command)


def test_cleanup_revalidates_ownership_before_any_down_or_volume_delete(tmp_path, monkeypatch):
    commands = []
    acceptance = tool.Acceptance(tmp_path, IMAGES, 8098, lambda args, **kwargs: commands.append(args))
    acceptance.root = tmp_path
    monkeypatch.setattr(tool.practice, "verify", lambda _: (_ for _ in ()).throw(ValueError("foreign object")))
    with pytest.raises(ValueError):
        acceptance.reset()
    assert commands == []


@pytest.mark.parametrize("changed", ["tag", "remote-context"])
def test_nonimmutable_or_other_docker_context_is_rejected_before_docker_call(tmp_path, monkeypatch, changed):
    monkeypatch.setattr(tool.os, "name", "posix")
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    images = dict(IMAGES)
    if changed == "tag":
        images["API"] = "twinnku:latest"
    else:
        monkeypatch.setenv("DOCKER_HOST", "tcp://other-host:2375")
    commands = []
    with pytest.raises(tool.ValidationFailure):
        tool.Acceptance(tmp_path, images, 8098, lambda args, **kwargs: commands.append(args)).run()
    assert commands == []


def test_http_client_rejects_redirect_before_sending_credentials_elsewhere():
    with pytest.raises(tool.ValidationFailure):
        tool.NoRedirect().redirect_request(None, None, 307, "temporary", {}, "https://other.example/")


def test_start_attests_real_fresh_api_before_any_staff_bootstrap(db, monkeypatch, tmp_path):
    application = create_app(training_settings())
    application.dependency_overrides[get_db] = lambda: db
    # The shared database fixture provides the current schema marker and no staff.
    with TestClient(application, base_url="http://localhost:8098") as client:
        class ActualBrowser:
            def __init__(self, _port):
                pass

            def request(self, method, path, body=None, *, expected=200):
                response = client.request(method, path, json=body, headers={"Origin": "http://localhost:8098"})
                assert response.status_code == expected
                return response.json(), response.headers

            def data(self, method, path):
                return self.request(method, path)[0]["data"]

        acceptance = tool.Acceptance(tmp_path, IMAGES, 8098)
        monkeypatch.setattr(tool, "Browser", ActualBrowser)
        monkeypatch.setattr(acceptance, "verify", lambda: None)
        monkeypatch.setattr(acceptance, "compose", lambda *args, **kwargs: "")
        acceptance.start()
        assert acceptance.checks["fresh_admin_entry_disabled"] is True
        assert acceptance.startup_step is None


def test_staff_creation_password_changes_and_independent_review_use_actual_api(db, monkeypatch, tmp_path):
    application = create_app(training_settings())
    application.dependency_overrides[get_db] = lambda: db
    clients = []

    class ActualBrowser:
        def __init__(self, port):
            self.origin = f"http://localhost:{port}"
            self.client = TestClient(application, base_url=self.origin)
            self.csrf = None
            clients.append(self.client)

        def request(self, method, path, body=None, *, expected=200, csrf=True, origin=True, cookie=None):
            headers = {}
            if method not in {"GET", "HEAD"}:
                if origin:
                    headers["Origin"] = self.origin if origin is True else origin
                if csrf and self.csrf:
                    headers["X-CSRF-Token"] = self.csrf
            if cookie:
                headers["Cookie"] = cookie
            response = self.client.request(method, path, json=body, headers=headers)
            assert response.status_code == expected, response.json().get("error", {}).get("code")
            return response.json(), response.headers

        def data(self, method, path, body=None, **kwargs):
            return self.request(method, path, body, **kwargs)[0]["data"]

        def login(self, username, password):
            session, headers = self.request("POST", "/api/v1/admin/auth/login", {
                "username": username, "password": password,
            })
            self.csrf = session["data"]["csrf_token"]
            assert self.client.cookies.get(tool.COOKIE)
            assert "HttpOnly" in headers["Set-Cookie"]
            assert "SameSite=strict" in headers["Set-Cookie"]
            assert self.client.cookies.get("twinnku_staff") is None
            return session["data"]

        def token(self):
            return self.client.cookies.get(tool.COOKIE)

    @contextmanager
    def session():
        yield db

    acceptance = tool.Acceptance(tmp_path, IMAGES, 8098)
    captured = []

    def actual_bootstrap(*args, input_text=None, **kwargs):
        captured.append((args, input_text))
        assert args[:6] == ("exec", "-T", "api", "python", "-c", tool.BOOTSTRAP)
        passwords = iter(input_text.splitlines())
        monkeypatch.setattr(bootstrap, "SessionLocal", session)
        monkeypatch.setattr(bootstrap.getpass, "getpass", lambda _: next(passwords))
        monkeypatch.setattr("sys.argv", ["bootstrap", "--username", "practice-owner", "--name", "Practice validation owner"])
        bootstrap.main()

    monkeypatch.setattr(tool, "Browser", ActualBrowser)
    monkeypatch.setattr(acceptance, "compose", actual_bootstrap)
    try:
        owner, accounts = acceptance.accounts()
        token = acceptance.workflow(owner, accounts)
        assert token
        assert acceptance.checks["independent_configuration_publish"] is True
        assert acceptance.checks["self_review_rejected"] is True
        assert acceptance.checks["no_implicit_configuration_grant"] is True
        assert acceptance.checks["paid_services_disabled"] is True
        assert acceptance.checks["bootstrapped_admin_entry_enabled"] is True
        assert len(captured) == 1
        password = captured[0][1].splitlines()[0]
        assert all(password not in str(argument) for argument in captured[0][0])
    finally:
        for client in clients:
            client.close()


def test_receipt_cannot_claim_pass_when_cleanup_or_production_identity_check_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(tool.os, "name", "posix")
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    acceptance = tool.Acceptance(tmp_path, IMAGES, 8098, lambda *args, **kwargs: "")
    monkeypatch.setattr(tool, "require_no_practice_objects", lambda _: None)
    monkeypatch.setattr(tool, "production_snapshot", lambda _: {"api": "same"})
    monkeypatch.setattr(tool.practice, "initialize", lambda *args: tmp_path)
    monkeypatch.setattr(acceptance, "start", lambda: SimpleNamespace(request=lambda *args, **kwargs: ({}, {})))
    monkeypatch.setattr(acceptance, "database", lambda **kwargs: {
        "staff_count": 3, "configuration_count": 2, "migration_heads": ["0018"],
    })
    monkeypatch.setattr(acceptance, "accounts", lambda: (None, {}))
    monkeypatch.setattr(acceptance, "workflow", lambda *args: "not-logged-token")

    def refused_cleanup():
        raise ValueError("not our resource")

    monkeypatch.setattr(acceptance, "reset", refused_cleanup)
    result = acceptance.run()
    assert result["status"] == "failed"
    assert result["cleanup_verified"] is False
    assert result["failure_phase"] == "reset"
    raw = (tmp_path / "validation-receipt.json").read_text()
    assert "not-logged-token" not in raw


@pytest.mark.parametrize("change", [None, "no-baseline", "training-account", "business-content", "bad-baseline", "reset-changed-baseline"])
def test_fresh_database_requires_exact_migration_baseline_and_no_training_content(tmp_path, monkeypatch, change):
    acceptance = tool.Acceptance(tmp_path, IMAGES, 8098)
    data = {"runtime_identity": True, "role_minimal": True, "ddl_denied": True,
            "supplier_counters": 0, "narration_attempts": 0, "migration_heads": ["0018"],
            "staff_count": 0, "configuration_count": 1, "business_row_count": 0,
            "baseline_valid": True, "migration_baseline": {"id": "deterministic-id", "sha256": "same-baseline"}}
    monkeypatch.setattr(acceptance, "verify", lambda: None)
    monkeypatch.setattr(acceptance, "compose", lambda *args: json.dumps(data))
    acceptance.database(empty=True)
    if change == "no-baseline":
        data["configuration_count"] = 0
    elif change == "training-account":
        data["staff_count"] = 1
    elif change == "business-content":
        data["business_row_count"] = 1
    elif change == "bad-baseline":
        data["baseline_valid"] = False
    elif change == "reset-changed-baseline":
        data["migration_baseline"] = {"id": "deterministic-id", "sha256": "different-baseline"}
    if change is None:
        assert acceptance.database(empty=True)["configuration_count"] == 1
    else:
        with pytest.raises(tool.ValidationFailure):
            acceptance.database(empty=True)
