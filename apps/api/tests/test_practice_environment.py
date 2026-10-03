import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings
from app.database import get_db
from app.main import create_app
from app.models import StaffUserRecord
from app.modules.admin.security import hash_password

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("practice_tool", ROOT / "scripts/practice_environment.py")
practice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(practice)


def training_settings(**changes):
    data = dict(
        _env_file=None, practice_mode=True, app_env="test", admin_enabled=True,
        database_url="postgresql+psycopg://practice_runtime:8f530263902956007c08b2b40db554ce@db:5432/twinnku_practice",
        admin_public_origin="http://localhost:8098", public_site_origin="http://localhost:8098",
    )
    data.update(changes)
    return Settings(**data)


@pytest.mark.parametrize("change", [
    {"nk_genios_api_enabled": True, "nk_genios_api_key": "training-must-not-have-secrets", "agent_public_enabled": True},
    {"voice_enabled": True, "voice_api_key": "training-must-not-have-secrets", "voice_base_url": "https://example.com"},
    {"narration_generation_enabled": True},
    {"agent_public_enabled": True},
    {"nk_genios_api_key": "unused-but-still-private"},
    {"voice_api_key": "unused-but-still-private"},
    {"agent_access_code": "unused-but-still-private"},
    {"nk_genios_web_app_key": "unused-but-still-private"},
])
def test_practice_rejects_suppliers_even_when_unused(change):
    with pytest.raises(ValidationError) as raised:
        training_settings(**change)
    assert "training-must-not-have-secrets" not in str(raised.value)
    assert "unused-but-still-private" not in str(raised.value)


@pytest.mark.parametrize("change", [
    {"database_url": "sqlite:///practice.db"},
    {"database_url": "postgresql+psycopg://practice_runtime:8f530263902956007c08b2b40db554ce@db:5432/twinnku"},
    {"database_url": "postgresql+psycopg://practice_runtime:8f530263902956007c08b2b40db554ce@production:5432/twinnku_practice"},
    {"database_url": "postgresql+psycopg://practice_runtime:8f530263902956007c08b2b40db554ce@db:5432/twinnku_practice?host=production"},
    {"database_url": "postgresql+psycopg://practice_runtime:8f530263902956007c08b2b40db554ce@db:6543/twinnku_practice"},
    {"database_url": "postgresql+psycopg://postgres:8f530263902956007c08b2b40db554ce@db:5432/twinnku_practice"},
    {"admin_public_origin": "https://2512921.cn"},
    {"public_site_origin": "https://2512921.cn"},
    {"admin_public_origin": "http://example.com:8098", "public_site_origin": "http://example.com:8098"},
    {"app_env": "production"},
    {"admin_mfa_enforced": True},
    {"backup_requests_enabled": True},
])
def test_practice_requires_its_own_local_context(change):
    with pytest.raises(ValidationError):
        training_settings(**change)


def test_practice_status_is_runtime_fact_and_does_not_initialize_supplier(db, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Practice must not construct a supplier runtime")

    monkeypatch.setattr("app.main.ChatRuntime", forbidden)
    app = create_app(training_settings())
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url="http://localhost:8098") as client:
        result = client.get("/api/v1/system/status")
    assert result.status_code == 200
    assert result.json()["data"]["environment"] == "practice"
    assert result.json()["data"]["capabilities"]["chat"] is False
    assert app.state.agent_runtime is None


def test_normal_deployment_never_accepts_http_public_origin_and_defaults_standard(client):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, public_site_origin="http://localhost:8098")
    assert client.get("/api/v1/system/status").json()["data"]["environment"] == "standard"


def test_practice_session_uses_separate_cookie_namespace(db):
    password = "Training-only-Passphrase-572!"
    db.add(StaffUserRecord(username="practice-admin", display_name="练习管理员", role="admin",
                           password_hash=hash_password(password), must_change_password=False,
                           campus_ids=[], point_ids=[]))
    db.commit()
    app = create_app(training_settings())
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url="http://localhost:8098") as client:
        response = client.post("/api/v1/admin/auth/login", headers={"origin": "http://localhost:8098"},
                               json={"username": "practice-admin", "password": password})
        assert response.status_code == 200
        token = client.cookies.get("twinnku_practice_staff")
        assert token and client.cookies.get("twinnku_staff") is None
        assert client.get("/api/v1/admin/session").status_code == 200
        client.cookies.clear()
        # Even the same valid database token cannot be accepted under the normal
        # site's cookie name. This isolates localhost apps which share a host.
        assert client.get("/api/v1/admin/session", headers={
            "cookie": f"twinnku_staff={token}",
        }).status_code == 401


def definition():
    environment = {"PRACTICE_MODE": "true", **dict.fromkeys((
        "NK_GENIOS_API_ENABLED", "NK_GENIOS_WEB_ENABLED", "AGENT_PUBLIC_ENABLED",
        "VOICE_ENABLED", "NARRATION_GENERATION_ENABLED", "BACKUP_REQUESTS_ENABLED",
    ), "false")}
    services = {name: {"networks": {"practice": {}}, "labels": {practice.PURPOSE: "practice"}}
                for name in practice.SERVICES}
    for name in ("api", "migrate"):
        services[name]["environment"] = deepcopy(environment)
    services["db"]["environment"] = {"POSTGRES_PASSWORD": "owner-test-fixture-password",
                                     "POSTGRES_USER": "practice_owner", "POSTGRES_DB": "twinnku_practice"}
    services["migrate"]["environment"]["DB_PASSWORD"] = "owner-test-fixture-password"
    services["migrate"]["environment"]["DB_APP_PASSWORD"] = "runtime-test-fixture-password"
    services["migrate"]["environment"]["DATABASE_URL"] = (
        "postgresql+psycopg://practice_owner:owner-test-fixture-password@db:5432/twinnku_practice"
    )
    services["api"]["environment"]["DATABASE_URL"] = (
        "postgresql+psycopg://practice_runtime:runtime-test-fixture-password@db:5432/twinnku_practice"
    )
    services["web"]["ports"] = [{"host_ip": "127.0.0.1", "target": 8080, "published": "8098"}]
    services["web"]["networks"]["entry"] = {}
    return {"name": practice.PROJECT, "services": services,
            "networks": {"practice": {"internal": True, "name": practice.PROJECT + "_practice"},
                         "entry": {"internal": False, "name": practice.PROJECT + "_entry"}},
            "volumes": {name: {"name": practice.PROJECT + "_" + name,
                               "labels": {practice.PURPOSE: "practice"}} for name in practice.VOLUMES}}


@pytest.mark.parametrize("case", ["production-volume", "bind-mount", "egress", "public-port",
                                  "db-port", "paid", "secrets", "inherited-env", "missing-owner",
                                  "leaked-owner", "url-owner", "wrong-database", "shared-password", "host-backup",
                                  "api-egress", "db-egress", "migration-egress", "shared-entry", "entry-host-driver"])
def test_compose_guard_blocks_cross_environment_and_paid_boundaries(case):
    candidate = definition()
    assert practice.validate_definition(candidate) is candidate
    if case == "host-backup":
        candidate["services"]["api"]["environment"]["BACKUP_REQUESTS_ENABLED"] = "true"
    elif case in {"api-egress", "db-egress", "migration-egress"}:
        name = {"api-egress": "api", "db-egress": "db", "migration-egress": "migrate"}[case]
        candidate["services"][name]["networks"]["entry"] = {}
    elif case == "shared-entry":
        candidate["networks"]["entry"]["name"] = "twinnku_production"
    elif case == "entry-host-driver":
        candidate["networks"]["entry"]["driver"] = "host"
    elif case == "production-volume":
        candidate["volumes"]["practice_assets"]["name"] = "twinnku_floor_assets"
    elif case == "bind-mount":
        candidate["services"]["api"]["volumes"] = [{"type": "bind", "source": "/opt/twinnku"}]
    elif case == "egress":
        candidate["networks"]["practice"]["internal"] = False
    elif case == "public-port":
        candidate["services"]["web"]["ports"][0]["host_ip"] = "0.0.0.0"
    elif case == "db-port":
        candidate["services"]["db"]["ports"] = [{"published": "5432"}]
    elif case == "paid":
        candidate["services"]["api"]["environment"]["NARRATION_GENERATION_ENABLED"] = "true"
    elif case == "secrets":
        candidate["services"]["migrate"]["environment"]["VOICE_API_KEY"] = "unexpected"
    elif case == "inherited-env":
        candidate["services"]["api"]["env_file"] = ["/opt/twinnku/.env"]
    elif case == "missing-owner":
        candidate["services"]["migrate"]["environment"].pop("DB_PASSWORD")
    elif case == "leaked-owner":
        candidate["services"]["api"]["environment"]["DB_PASSWORD"] = "owner-test-fixture-password"
    elif case == "url-owner":
        candidate["services"]["api"]["environment"]["DATABASE_URL"] = (
            candidate["services"]["migrate"]["environment"]["DATABASE_URL"]
        )
    elif case == "wrong-database":
        candidate["services"]["db"]["environment"]["POSTGRES_DB"] = "twinnku"
    elif case == "shared-password":
        candidate["services"]["migrate"]["environment"]["DB_APP_PASSWORD"] = "owner-test-fixture-password"
    with pytest.raises(ValueError):
        practice.validate_definition(candidate)


def test_collision_without_project_label_is_still_detected(tmp_path, monkeypatch):
    root = tmp_path / "practice"
    root.mkdir()
    for name, body in (("practice.env", ""), ("identity.json", json.dumps({
        "format": 1, "purpose": "practice", "project": practice.PROJECT,
        "images": {}, "port": 8098,
    }))):
        (root / name).write_text(body)
        (root / name).chmod(0o600)
    config = definition()
    for service in config["services"].values():
        service["image"] = "fixture"
    marker = json.loads((root / "identity.json").read_text())
    marker["images"] = dict.fromkeys(practice.IMAGE_USERS, "fixture")
    (root / "identity.json").write_text(json.dumps(marker))
    monkeypatch.setattr(practice, "image_identity", lambda value, _kind: value)

    def command(arguments):
        if "--format" in arguments:
            return json.dumps(config)
        if arguments[1:3] == ["volume", "ls"] and "name=" in arguments[-1]:
            return "twinnku-practice_practice_assets\n"
        if arguments[1:3] == ["volume", "inspect"]:
            return json.dumps([{"Labels": {}}])
        return ""

    monkeypatch.setattr(practice, "command", command)
    # POSIX permissions are exercised on Linux; Windows' chmod has no group mode.
    if __import__("os").name == "nt":
        pytest.skip("POSIX ownership and file modes require Linux")
    with pytest.raises(ValueError, match="ownership label"):
        practice.verify(root)


def test_matching_labels_do_not_authorize_host_backed_volume_or_external_network():
    labels = {practice.PURPOSE: "practice", "com.docker.compose.project": practice.PROJECT}
    volume = {"Name": practice.PROJECT + "_practice_assets", "Driver": "local",
              "Options": {}, "Labels": labels}
    practice.validate_existing("volume", volume, {})
    volume["Options"] = {"type": "none", "o": "bind", "device": "/opt/production-media"}
    with pytest.raises(ValueError, match="host backing"):
        practice.validate_existing("volume", volume, {})
    network = {"Name": practice.PROJECT + "_practice", "Driver": "bridge",
               "Internal": True, "Labels": labels}
    practice.validate_existing("network", network, {})
    network["Internal"] = False
    with pytest.raises(ValueError, match="external access"):
        practice.validate_existing("network", network, {})


@pytest.mark.parametrize("case", ["bind", "host-bind-definition", "writable-map",
                                  "external-network", "wrong-image", "host-port"])
def test_existing_labelled_container_cannot_hide_actual_cross_environment_access(case):
    marker = {"images": {"API": "approved-api"}, "port": 8098}
    actual = {"Image": "approved-api", "Config": {"Labels": {"com.docker.compose.service": "api"}},
              "HostConfig": {"NetworkMode": practice.PROJECT + "_practice", "Binds": [
                  practice.PROJECT + "_practice_maps:/data/maps:ro",
                  practice.PROJECT + "_practice_assets:/data/floors:rw",
              ]},
              "Mounts": [{"Type": "volume", "Destination": "/data/maps", "RW": False,
                          "Name": practice.PROJECT + "_practice_maps"},
                         {"Type": "volume", "Destination": "/data/floors", "RW": True,
                          "Name": practice.PROJECT + "_practice_assets"}]}
    practice.validate_existing("container", actual, marker)
    if case == "bind":
        actual["Mounts"][1] = {"Type": "bind", "Source": "/opt/production-media", "Destination": "/data/floors"}
    elif case == "host-bind-definition":
        actual["HostConfig"]["Binds"][1] = "/opt/production-media:/data/floors:rw"
    elif case == "writable-map":
        actual["HostConfig"]["Binds"][0] = practice.PROJECT + "_practice_maps:/data/maps:rw"
    elif case == "external-network":
        actual["NetworkSettings"] = {"Networks": {"production": {}}}
    elif case == "wrong-image":
        actual["Image"] = "other-api"
    elif case == "host-port":
        actual["HostConfig"]["PortBindings"] = {"8000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8000"}]}
    with pytest.raises(ValueError):
        practice.validate_existing("container", actual, marker)


@pytest.mark.parametrize("actual_binding", [None, [], [{"HostIp": "0.0.0.0", "HostPort": "8098"}],
                                          [{"HostIp": "127.0.0.1", "HostPort": "8098"}]])
def test_running_entry_requires_real_loopback_publication_not_only_requested_config(actual_binding):
    wanted = [{"HostIp": "127.0.0.1", "HostPort": "8098"}]
    metadata = {
        "Image": "web-image", "Config": {"Labels": {"com.docker.compose.service": "web"}},
        "State": {"Running": True}, "Mounts": [],
        "HostConfig": {"NetworkMode": practice.PROJECT + "_entry", "PortBindings": {"8080/tcp": wanted}},
        "NetworkSettings": {"Networks": {practice.PROJECT + "_practice": {}, practice.PROJECT + "_entry": {}},
                            "Ports": {"8080/tcp": actual_binding}},
    }
    marker = {"images": {"WEB": "web-image"}, "port": 8098}
    if actual_binding == wanted:
        practice.validate_existing("container", metadata, marker)
    else:
        with pytest.raises(ValueError, match="actually published"):
            practice.validate_existing("container", metadata, marker)
