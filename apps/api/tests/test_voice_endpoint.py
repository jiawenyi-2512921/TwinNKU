"""Paid voice authorization, persisted budgets and byte-bounded cache tests."""

import asyncio
import base64

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from test_voice_rotation import WAV

from app.integrations.public_agent_security import PublicAgentSession, issue
from app.modules.voice import rotation as rotation_module
from app.modules.voice import router as voice_module
from app.modules.voice.rotation import SynthesisResult


@pytest.fixture(autouse=True)
def clean_cache():
    voice_module._AUDIO_CACHE.clear()
    voice_module._INFLIGHT.clear()
    yield
    voice_module._AUDIO_CACHE.clear()
    voice_module._INFLIGHT.clear()


def cloud(client, monkeypatch, handler=None):
    cfg = client.app.state.settings
    cfg.agent_public_enabled = True
    cfg.voice_enabled = True
    cfg.voice_api_key = SecretStr("synthetic-only-key")
    cfg.voice_base_url = "https://example.invalid"
    calls = []

    def respond(request):
        calls.append(request)
        if handler:
            return handler(request)
        return httpx.Response(
            200, json={"output": {"audio": {"data": base64.b64encode(WAV).decode()}}}
        )

    original = httpx.AsyncClient

    def mock(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(respond)
        return original(*args, **kwargs)

    monkeypatch.setattr(rotation_module.httpx, "AsyncClient", mock)
    client.headers["origin"] = "http://testserver"
    response = client.post("/api/v1/agent/guest")
    assert response.status_code == 200, response.text
    client.headers["x-csrf-token"] = response.json()["data"]["csrf_token"]
    return cfg, calls


def answer(db, text="欢迎来到南开大学"):
    session = db.scalar(select(PublicAgentSession))
    permit = issue(
        db, session.token_hash, "speech", {"source": {"kind": "agent_answer"}, "chunks": [text]}
    )
    return {"permit": permit, "chunk_index": 0}


def test_public_voice_requires_session_origin_csrf_and_permit(client, db, monkeypatch):
    _, calls = cloud(client, monkeypatch)
    payload = answer(db)
    assert client.post("/api/v1/voice/speech", json={"text": "arbitrary"}).status_code == 422
    assert (
        client.post(
            "/api/v1/voice/speech", json=payload, headers={"origin": "https://other.invalid"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/voice/speech", json=payload, headers={"x-csrf-token": "bad"}
        ).status_code
        == 403
    )
    client.cookies.clear()
    assert client.post("/api/v1/voice/speech", json=payload).status_code == 401
    assert not calls


def test_voice_response_is_private_and_valid_audio(client, db, monkeypatch):
    _, calls = cloud(client, monkeypatch)
    response = client.post("/api/v1/voice/speech", json=answer(db))
    assert response.status_code == 200, response.text
    assert response.content == WAV
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1


def test_cache_hit_uses_http_budget_but_no_paid_attempt(client, db, monkeypatch):
    cfg, calls = cloud(client, monkeypatch)
    cfg.voice_visitor_requests_per_hour = 1
    cfg.agent_http_requests_per_hour = 3  # guest + miss + hit
    payload = answer(db)
    first = client.post("/api/v1/voice/speech", json=payload)
    repeat = client.post("/api/v1/voice/speech", json=payload)
    limited = client.post("/api/v1/voice/speech", json=payload)
    assert first.status_code == repeat.status_code == 200
    assert repeat.headers["x-voice-cache"] == "hit"
    assert limited.status_code == 429
    assert len(calls) == 1


def test_paid_limit_survives_process_cache_restart(client, db, monkeypatch):
    cfg, calls = cloud(client, monkeypatch)
    cfg.voice_total_requests_per_hour = 1
    assert client.post("/api/v1/voice/speech", json=answer(db, "first")).status_code == 200
    voice_module._AUDIO_CACHE.clear()
    assert client.post("/api/v1/voice/speech", json=answer(db, "second")).status_code == 429
    assert len(calls) == 1


def test_retry_is_reserved_as_an_actual_paid_attempt(client, db, monkeypatch):
    cfg, calls = cloud(
        client, monkeypatch, lambda req: httpx.Response(503, json={"code": "ServiceUnavailable"})
    )
    cfg.voice_total_requests_per_hour = 1
    response = client.post("/api/v1/voice/speech", json=answer(db))
    assert response.status_code == 429
    assert len(calls) == 1  # the same-tier retry never bypasses the budget


def test_speech_permit_cannot_cross_session(client, db, monkeypatch):
    _, calls = cloud(client, monkeypatch)
    payload = answer(db)
    client.cookies.clear()
    response = client.post("/api/v1/agent/guest")
    client.headers["x-csrf-token"] = response.json()["data"]["csrf_token"]
    assert client.post("/api/v1/voice/speech", json=payload).status_code == 403
    assert not calls


def test_logout_revokes_voice_capabilities(client, db, monkeypatch):
    _, calls = cloud(client, monkeypatch)
    payload = answer(db)
    assert client.post("/api/v1/agent/logout").status_code == 200
    assert client.post("/api/v1/voice/speech", json=payload).status_code == 401
    assert not calls


def test_arbitrary_draft_source_is_not_a_public_prepare(client, db, monkeypatch):
    from uuid import uuid4

    _, calls = cloud(client, monkeypatch)
    response = client.post(
        "/api/v1/voice/prepare",
        json={
            "source": {
                "kind": "draft_segment",
                "tour_id": str(uuid4()),
                "draft_revision": 1,
                "stop_index": 0,
            }
        },
    )
    assert response.status_code == 422
    assert not calls


def test_cache_is_bounded_by_bytes():
    voice_module._write_cache("one", b"a" * 6, 10)
    voice_module._write_cache("two", b"b" * 6, 10)
    assert list(voice_module._AUDIO_CACHE) == ["two"]
    voice_module._write_cache("huge", b"c" * 11, 10)
    assert sum(len(entry[1]) for entry in voice_module._AUDIO_CACHE.values()) <= 10


def test_status_discloses_no_key(client, monkeypatch):
    cloud(client, monkeypatch)
    response = client.get("/api/v1/voice/status")
    assert response.json()["enabled"] is True
    assert "synthetic-only-key" not in response.text


def test_disabling_public_service_revokes_existing_guest_paid_access(client, db, monkeypatch):
    cfg, calls = cloud(client, monkeypatch)
    payload = answer(db)
    cfg.agent_public_enabled = False
    assert client.post("/api/v1/voice/speech", json=payload).status_code == 503
    assert client.get("/api/v1/agent/session").status_code == 503
    assert not calls


@pytest.mark.anyio
async def test_duplicate_clip_shares_attempt_and_cancelled_waiter_is_cleaned(
    client, db, monkeypatch
):
    from starlette.requests import Request

    from app.core.errors import DomainError

    cloud(client, monkeypatch)
    session = db.scalar(select(PublicAgentSession))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("testserver", 80),
            "path": "/api/v1/voice/speech",
            "headers": [],
            "client": ("127.0.0.1", 1000),
            "app": client.app,
        }
    )
    started, finish = asyncio.Event(), asyncio.Event()
    attempts = []

    class MockSynthesizer:
        def __init__(self, reserve):
            self.reserve = reserve

        async def synthesize(self, text):
            self.reserve()
            attempts.append(text)
            started.set()
            await finish.wait()
            return SynthesisResult(WAV, "audio/wav", "mock-model", "mock-tier", False, len(text))

    monkeypatch.setattr(
        voice_module, "_synthesizer_for", lambda config, reserve: MockSynthesizer(reserve)
    )
    payload = voice_module.SpeechRequest(**answer(db))
    first = asyncio.create_task(voice_module._speech(payload, request, db, session.token_hash))
    await started.wait()
    second = asyncio.create_task(voice_module._speech(payload, request, db, session.token_hash))
    await asyncio.sleep(0)
    other = voice_module.SpeechRequest(**answer(db, "another distinct clip"))
    with pytest.raises(DomainError) as failure:
        await voice_module._speech(other, request, db, session.token_hash)
    assert failure.value.code == "REQUEST_IN_PROGRESS"
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    finish.set()
    assert (await first).body == WAV
    await asyncio.sleep(0)
    assert not voice_module._INFLIGHT
    assert len(attempts) == 1
    assert (await voice_module._speech(payload, request, db, session.token_hash)).body == WAV
    assert len(attempts) == 1


def test_staff_draft_voice_remains_private_revision_scoped_and_revocable(
    client, db, monkeypatch, tmp_path
):
    from test_admin import login, seed_staff
    from test_experiences import content, save
    from test_resources import make_resource_point

    _, calls = cloud(client, monkeypatch)
    seed_staff(client, db)
    point = make_resource_point(db)
    login(client)
    draft = save(
        client,
        content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [{"id": "draft-one", "text": "尚未公开的测试讲解"}],
                }
            ],
        ),
    )
    source = {
        "kind": "draft_segment",
        "tour_id": draft["id"],
        "draft_revision": draft["revision"],
        "stop_index": 0,
        "segment_id": "draft-one",
    }
    prepared = client.post("/api/v1/admin/voice/prepare", json={"source": source})
    assert prepared.status_code == 200, prepared.text
    payload = {"permit": prepared.json()["data"]["permit"], "chunk_index": 0}
    assert client.post("/api/v1/admin/voice/speech", json=payload).status_code == 200
    assert all(not key.startswith("public:") for key in voice_module._AUDIO_CACHE)
    saved = save(
        client,
        content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [{"id": "draft-one", "text": "更新后的测试讲解"}],
                }
            ],
        ),
        draft,
    )
    assert saved["revision"] > draft["revision"]
    assert client.post("/api/v1/admin/voice/speech", json=payload).status_code == 409
    assert len(calls) == 1
    client.cookies.clear()
    assert client.post("/api/v1/admin/voice/speech", json=payload).status_code == 401
