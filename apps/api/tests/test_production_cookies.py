"""HTTPS test boundaries exercise production cookie names without paid services."""

from test_admin import BASE, TEST_PASSWORD, login, seed_staff
from test_native_agent import enable
from test_staff_mfa import MFA, ORIGIN, Authenticator, register, verify


def assert_cookie(response, name, path):
    headers = response.headers.get_list("set-cookie")
    value = next(header for header in headers if header.startswith(name + "="))
    assert "Secure" in value and "HttpOnly" in value and "SameSite=strict" in value
    assert "Path=" + path in value and "Domain=" not in value


def https(client, origin="https://testserver"):
    client.base_url = "https://testserver"
    client.app.state.settings.app_env = "production"
    client.app.state.settings.admin_public_origin = origin
    client.app.state.settings.public_site_origin = origin
    client.headers["origin"] = origin


def test_production_staff_cookie_is_secure_prefixed_and_legacy_name_is_denied(client, db):
    seed_staff(client, db)
    https(client)
    response = client.post(
        BASE + "/auth/login", json={"username": "editor", "password": TEST_PASSWORD}
    )
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_staff", "/api/v1/admin")
    csrf = response.json()["data"]["csrf_token"]
    assert client.get(BASE + "/session").status_code == 200
    token = client.cookies.get("__Secure-twinnku_staff")
    assert (
        client.get(BASE + "/session", headers={"cookie": "twinnku_staff=" + token}).status_code
        == 401
    )
    response = client.post(BASE + "/auth/logout", headers={"x-csrf-token": csrf})
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_staff", "/api/v1/admin")
    assert client.get(BASE + "/session").status_code == 401


def test_production_pending_cookie_is_prefixed_and_cannot_authorize_business(client, db):
    seed_staff(client, db)
    https(client, ORIGIN)
    client.app.state.settings.admin_mfa_enforced = True
    response = client.post(
        BASE + "/auth/login", json={"username": "admin", "password": TEST_PASSWORD}
    )
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_staff_pending", "/api/v1/admin/auth/mfa")
    client.headers["x-csrf-token"] = response.json()["data"]["csrf_token"]
    assert client.get(BASE + "/points").status_code == 401
    token = client.cookies.get("__Secure-twinnku_staff_pending")
    assert (
        client.post(
            MFA + "/authentication/options", headers={"cookie": "twinnku_staff_pending=" + token}
        ).status_code
        == 401
    )
    device = Authenticator()
    register(client, device)
    verify(client, device)
    assert client.cookies.get("__Secure-twinnku_staff")
    assert not client.cookies.get("__Secure-twinnku_staff_pending")
    assert client.get(BASE + "/points").status_code == 200


def test_production_public_cookie_prefix_refresh_logout_and_legacy_rejection(client):
    enable(client, lambda: "unused", [])
    client.cookies.clear()
    https(client)
    client.app.state.settings.agent_public_enabled = True
    response = client.post("/api/v1/agent/guest")
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_agent", "/api/v1")
    csrf = response.json()["data"]["csrf_token"]
    token = client.cookies.get("__Secure-twinnku_agent")
    response = client.get("/api/v1/agent/session")
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_agent", "/api/v1")
    assert (
        client.get(
            "/api/v1/agent/session", headers={"cookie": "twinnku_agent=" + token}
        ).status_code
        == 401
    )
    response = client.post("/api/v1/agent/logout", headers={"x-csrf-token": csrf})
    assert response.status_code == 200
    assert_cookie(response, "__Secure-twinnku_agent", "/api/v1")
    assert client.get("/api/v1/agent/session").status_code == 401


def test_production_does_not_accept_an_unprefixed_staff_session_from_staged_test_environment(
    client, db
):
    seed_staff(client, db)
    login(client, "editor")
    assert client.cookies.get("twinnku_staff")
    https(client)
    assert client.get(BASE + "/session").status_code == 401
