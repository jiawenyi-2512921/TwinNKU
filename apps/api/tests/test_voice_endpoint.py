"""Endpoint tests for cloud voice synthesis.

Covers the behaviours that keep the guide usable: graceful fallback when
voice is unconfigured, audio caching for repeated copy, and rate limiting.
"""

from __future__ import annotations

import base64

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.modules.voice import rotation as voice_rotation_module
from app.modules.voice import router as voice_router_module

KEY = "sk-ws-synthetic-test-key"


@pytest.fixture(autouse=True)
def _clear_voice_state():
    voice_router_module._AUDIO_CACHE.clear()
    voice_router_module._RATE_WINDOWS.clear()
    voice_router_module._GLOBAL_WINDOW.clear()
    yield
    voice_router_module._AUDIO_CACHE.clear()
    voice_router_module._RATE_WINDOWS.clear()
    voice_router_module._GLOBAL_WINDOW.clear()


def _settings(**overrides) -> Settings:
    base = {
        "app_env": "test",
        "voice_enabled": True,
        "voice_api_key": KEY,
        "voice_base_url": "https://example.invalid",
    }
    base.update(overrides)
    return Settings(**base)


def _client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))


def _install_transport(monkeypatch, handler) -> None:
    """Route the synthesizer's httpx clients through a mock transport.

    Patched on the rotation module: that is where the real network call lives.
    """
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(voice_rotation_module.httpx, "AsyncClient", fake_client)


def _ok_handler(calls: list[str]):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        payload = base64.b64encode(b"RIFF-audio-payload").decode()
        return httpx.Response(200, json={"output": {"audio": {"data": payload}}})

    return handler


def test_status_reports_browser_when_unconfigured():
    body = _client(Settings(app_env="test")).get("/api/v1/voice/status").json()

    assert body["enabled"] is False
    assert body["provider"] == "browser"
    assert body["tiers"] == []


def test_status_reports_configured_tiers():
    body = _client(_settings()).get("/api/v1/voice/status").json()

    assert body["enabled"] is True
    assert body["provider"] == "bailian"
    assert body["tiers"] == ["primary", "backup"]
    assert body["models"][0] == "qwen3-tts-flash"


def test_speech_unavailable_when_not_configured():
    response = _client(Settings(app_env="test")).post(
        "/api/v1/voice/speech", json={"text": "欢迎来到南开大学"}
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "VOICE_UNAVAILABLE"


def test_speech_returns_audio(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))

    response = _client(_settings()).post("/api/v1/voice/speech", json={"text": "图书馆在正前方"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-voice-cache"] == "miss"
    assert response.headers["x-voice-tier"] == "primary"
    assert response.content == b"RIFF-audio-payload"
    assert len(calls) == 1


def test_repeated_text_is_served_from_cache(monkeypatch):
    """Guide copy repeats heavily, so repeats must never be billed twice."""
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings())

    first = client.post("/api/v1/voice/speech", json={"text": "欢迎来到南开大学津南校区"})
    second = client.post("/api/v1/voice/speech", json={"text": "欢迎来到南开大学津南校区"})

    assert first.headers["x-voice-cache"] == "miss"
    assert second.headers["x-voice-cache"] == "hit"
    assert first.content == second.content
    assert len(calls) == 1, "cached copy must not reach the provider"


def test_distinct_text_is_a_separate_call(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings())

    client.post("/api/v1/voice/speech", json={"text": "图书馆"})
    client.post("/api/v1/voice/speech", json={"text": "马蹄湖"})

    assert len(calls) == 2


def test_degraded_tier_is_surfaced_to_the_client(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        import json

        model = json.loads(request.content)["model"]
        if model == "qwen3-tts-flash":
            return httpx.Response(400, json={"code": "Arrearage"})
        payload = base64.b64encode(b"RIFF-backup-audio").decode()
        return httpx.Response(200, json={"output": {"audio": {"data": payload}}})

    _install_transport(monkeypatch, handler)

    response = _client(_settings()).post("/api/v1/voice/speech", json={"text": "西南门怎么走"})

    assert response.status_code == 200
    assert response.headers["x-voice-tier"] == "backup"
    assert response.headers["x-voice-degraded"] == "1"
    assert response.content == b"RIFF-backup-audio"


def test_all_tiers_exhausted_returns_503(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Arrearage"})

    _install_transport(monkeypatch, handler)

    response = _client(_settings()).post("/api/v1/voice/speech", json={"text": "马蹄湖在哪"})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "VOICE_SYNTHESIS_FAILED"


def test_text_longer_than_limit_is_rejected(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))

    response = _client(_settings(voice_max_characters=10)).post(
        "/api/v1/voice/speech", json={"text": "这是一个明显超过十个字的测试文本内容"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VOICE_TEXT_TOO_LONG"
    assert calls == [], "an over-long request must not reach the provider"


def test_rate_limit_blocks_excessive_calls(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings(voice_visitor_requests_per_hour=2))

    texts = ["图书馆", "马蹄湖", "西南门"]
    codes = [client.post("/api/v1/voice/speech", json={"text": t}).status_code for t in texts]

    assert codes == [200, 200, 429]
    assert len(calls) == 2


def test_cache_hits_do_not_consume_rate_limit(monkeypatch):
    """A repeated phrase should stay available even after the visitor's quota is spent."""
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings(voice_visitor_requests_per_hour=1))

    first = client.post("/api/v1/voice/speech", json={"text": "欢迎来到南开大学"})
    repeat = client.post("/api/v1/voice/speech", json={"text": "欢迎来到南开大学"})
    other = client.post("/api/v1/voice/speech", json={"text": "马蹄湖"})

    assert first.status_code == 200
    assert repeat.status_code == 200, "cache hit should bypass the limiter"
    assert repeat.headers["x-voice-cache"] == "hit"
    assert other.status_code == 429


def test_global_limit_stops_a_caller_rotating_addresses(monkeypatch):
    """Per-visitor limits are bypassable by changing address; the global cap is not."""
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings(voice_visitor_requests_per_hour=50, voice_total_requests_per_hour=3))

    texts = ["图书馆", "马蹄湖", "西南门", "主楼", "学生活动中心"]
    codes = [
        client.post(
            "/api/v1/voice/speech",
            json={"text": text},
            headers={"x-forwarded-for": f"10.0.0.{index}"},
        ).status_code
        for index, text in enumerate(texts)
    ]

    assert codes[:3] == [200, 200, 200]
    assert codes[3:] == [429, 429], "global ceiling must apply across addresses"
    assert len(calls) == 3


def test_global_limit_message_differs_from_visitor_limit(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings(voice_visitor_requests_per_hour=50, voice_total_requests_per_hour=1))

    client.post(
        "/api/v1/voice/speech",
        json={"text": "图书馆"},
        headers={"x-forwarded-for": "10.1.1.1"},
    )
    blocked = client.post(
        "/api/v1/voice/speech",
        json={"text": "马蹄湖"},
        headers={"x-forwarded-for": "10.1.1.2"},
    )

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "VOICE_CAPACITY_REACHED"


def test_cache_hits_do_not_consume_the_global_budget(monkeypatch):
    calls: list[str] = []
    _install_transport(monkeypatch, _ok_handler(calls))
    client = _client(_settings(voice_visitor_requests_per_hour=50, voice_total_requests_per_hour=1))

    first = client.post("/api/v1/voice/speech", json={"text": "同一句话"})
    repeat = client.post("/api/v1/voice/speech", json={"text": "同一句话"})

    assert first.status_code == 200
    assert repeat.status_code == 200
    assert repeat.headers["x-voice-cache"] == "hit"
    assert len(calls) == 1


def test_upstream_timeout_returns_recoverable_error_without_raw_details(monkeypatch):
    def handler(request):
        raise httpx.ReadTimeout("synthetic private upstream detail", request=request)

    _install_transport(monkeypatch, handler)
    response = _client(_settings()).post("/api/v1/voice/speech", json={"text": "测试语音"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "VOICE_SYNTHESIS_FAILED"
    assert "private upstream" not in response.text
