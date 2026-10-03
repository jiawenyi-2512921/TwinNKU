"""Real P-256 ceremonies isolate the validated localhost practice RP."""

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_admin import BASE, TEST_PASSWORD, login, seed_staff
from test_practice_environment import training_settings
from test_staff_mfa import ORIGIN, RP_ID, Authenticator, post

from app.database import get_db
from app.main import create_app
from app.models import StaffSessionRecord
from app.modules.admin import mfa

PRACTICE_ORIGIN = "http://localhost:8098"


@pytest.fixture
def practice_client(client, db):
    seed_staff(client, db)
    app = create_app(training_settings())
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, base_url=PRACTICE_ORIGIN) as isolated:
        isolated.headers["origin"] = PRACTICE_ORIGIN
        yield isolated


def begin_registration(client):
    login(client, "admin")
    pending = post(client, "/enrollment", {"password": TEST_PASSWORD})
    client.headers["x-csrf-token"] = pending["csrf_token"]
    return post(client, "/registration/options", {"name": "测试隔离认证器"})["public_key"]


def register_practice(client, device):
    options = begin_registration(client)
    assert options["rp"]["id"] == "localhost"
    assert options["authenticatorSelection"]["userVerification"] == "required"
    post(client, "/registration/verify", {"credential": device.registration(
        options["challenge"], origin=PRACTICE_ORIGIN, rp_id="localhost",
    )})
    return post(client, "/authentication/options")["public_key"]


def test_practice_registration_and_login_verify_exact_configured_scope_with_uv(
    practice_client, monkeypatch,
):
    calls = []
    for name in ["verify_registration_response", "verify_authentication_response"]:
        original = getattr(mfa, name)

        def tracked(*args, _original=original, _name=name, **kwargs):
            calls.append((_name, kwargs["expected_rp_id"], kwargs["expected_origin"],
                          kwargs["require_user_verification"]))
            return _original(*args, **kwargs)

        monkeypatch.setattr(mfa, name, tracked)
    device = Authenticator()
    options = register_practice(practice_client, device)
    assert options["rpId"] == "localhost" and options["userVerification"] == "required"
    session = post(practice_client, "/authentication/verify", {"credential": device.assertion(
        options["challenge"], origin=PRACTICE_ORIGIN, rp_id="localhost",
    )})
    assert session["mfa_verified"]
    assert practice_client.cookies.get("twinnku_practice_staff")
    assert practice_client.cookies.get("twinnku_staff") is None
    assert calls == [
        ("verify_registration_response", "localhost", PRACTICE_ORIGIN, True),
        ("verify_authentication_response", "localhost", PRACTICE_ORIGIN, True),
    ]


@pytest.mark.parametrize("failure", ["production-rp", "production-origin", "other-port", "uv"])
def test_practice_rejects_foreign_rp_origin_port_and_missing_uv(practice_client, db, failure):
    device = Authenticator()
    options = register_practice(practice_client, device)
    # Enrollment alone must not mark its password-only session as MFA verified.
    before = db.scalar(select(func.count()).select_from(StaffSessionRecord))
    proof = device.assertion(
        options["challenge"], rp_id=RP_ID if failure == "production-rp" else "localhost",
        origin=ORIGIN if failure == "production-origin" else (
            "http://localhost:8099" if failure == "other-port" else PRACTICE_ORIGIN
        ), uv=failure != "uv",
    )
    post(practice_client, "/authentication/verify", {"credential": proof}, expected=403)
    assert db.scalar(select(func.count()).select_from(StaffSessionRecord)) == before


def test_practice_registration_rejects_production_scope(practice_client, db):
    options = begin_registration(practice_client)
    post(practice_client, "/registration/verify", {"credential": Authenticator().registration(
        options["challenge"], origin=ORIGIN, rp_id=RP_ID,
    )}, expected=403)
    assert practice_client.get(BASE + "/auth/mfa").json()["data"]["credentials"] == []


def test_nonpractice_local_request_never_changes_the_production_rp(client, db, monkeypatch):
    seed_staff(client, db)
    client.app.state.settings.admin_public_origin = PRACTICE_ORIGIN
    client.headers["origin"] = PRACTICE_ORIGIN
    client.headers["host"] = "localhost:8098"
    device = Authenticator()
    options = begin_registration(client)
    assert options["rp"]["id"] == RP_ID
    seen = []
    original = mfa.verify_registration_response

    def tracked(**kwargs):
        seen.append((kwargs["expected_rp_id"], kwargs["expected_origin"]))
        return original(**kwargs)

    monkeypatch.setattr(mfa, "verify_registration_response", tracked)
    post(client, "/registration/verify", {"credential": device.registration(
        options["challenge"], origin=PRACTICE_ORIGIN, rp_id="localhost",
    )}, expected=403)
    assert seen == [(RP_ID, ORIGIN)]
    options = post(client, "/registration/options", {"name": "正式域名测试认证器"})["public_key"]
    post(client, "/registration/verify", {"credential": device.registration(options["challenge"])})
    options = post(client, "/authentication/options")["public_key"]
    assert options["rpId"] == RP_ID
    original_authentication = mfa.verify_authentication_response

    def tracked_authentication(**kwargs):
        seen.append((kwargs["expected_rp_id"], kwargs["expected_origin"]))
        return original_authentication(**kwargs)

    monkeypatch.setattr(mfa, "verify_authentication_response", tracked_authentication)
    post(client, "/authentication/verify", {"credential": device.assertion(
        options["challenge"], origin=PRACTICE_ORIGIN, rp_id="localhost",
    )}, expected=403)
    assert seen == [(RP_ID, ORIGIN)] * 3


def test_mutating_practice_configuration_cannot_authorize_a_localhost_rp(practice_client):
    app = practice_client.app
    settings = app.state.settings
    settings.public_site_origin = "https://2512921.cn"
    request = Request({"type": "http", "app": app, "headers": []})
    with pytest.raises(mfa.DomainError) as caught:
        mfa.webauthn_scope(request)
    assert caught.value.code == "PRACTICE_ISOLATION_INVALID"
    assert caught.value.status == 503
