"""Durable narration through real endpoints, bounded worker and real WAV files.

The synthetic waveform below is a test fixture, never a production voice sample.
"""

import asyncio
import copy
import io
import wave
from datetime import timedelta
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker
from test_admin import login
from test_experiences import action, content, save
from test_experiences import experiences as experiences

from app.core.errors import DomainError
from app.integrations.public_agent_security import PublicAgentCounter
from app.models import now_utc
from app.modules.narration import router as narration_router
from app.modules.narration.service import audio_metadata, chunk_path
from app.modules.narration.worker import claim_job, run_job
from app.modules.voice.rotation import SynthesisResult
from app.narration_models import NarrationJob


def wav_bytes():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 1600)
    return buffer.getvalue()


class TestSynthesizer:
    __test__ = False

    def __init__(self, before_attempt, **kwargs):
        self.before_attempt = before_attempt

    async def synthesize(self, text):
        self.before_attempt()
        return SynthesisResult(wav_bytes(), "audio/wav", "qwen3-tts-flash", "primary", False, len(text))


@pytest.fixture
def narration(client, db, experiences, monkeypatch):
    _, point, _ = experiences
    settings = client.app.state.settings
    settings.narration_generation_enabled = True
    settings.voice_api_key = SecretStr("test-only-not-a-real-key")
    settings.voice_enabled = False  # Publishing narration must not enable real-time synthesis.
    monkeypatch.setattr(narration_router, "generation_allowed", lambda db, settings: settings.narration_generation_enabled)
    from app.modules import configurations
    from app.modules.configuration_schemas import RuntimeContent
    monkeypatch.setattr(configurations, "effective_runtime", lambda db, settings: RuntimeContent(
        voice_total_requests_per_hour=200, voice_requests_per_day=1200, supplier_requests_per_day=1920,
        supplier_characters_per_day=360000, narration_staff_requests_per_hour=45,
        narration_staff_requests_per_day=270, narration_playback_enabled=True,
    ))
    login(client)
    tour_content = content(point, "tour", narration_mode="recorded", stops=[{
        "point_id": point.id, "segments": [{"id": "first-segment", "text": "测试夹具讲解。"}],
    }])
    item = save(client, tour_content)
    factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)
    return item, factory


def queue(client, item, operation_id=None):
    return client.post("/api/v1/admin/narration-jobs", json={
        "tour_id": item["id"], "expected_revision": item["revision"],
        "segment_ids": ["first-segment"], "profile_id": "standard",
        "operation_id": operation_id or str(uuid4()),
    })


def generate(client, db, item, factory):
    response = queue(client, item)
    assert response.status_code == 201, response.text
    job = response.json()["data"][0]
    claim = claim_job(factory)
    assert claim and claim[0] == job["id"]
    asyncio.run(run_job(factory, client.app.state.settings, *claim, synthesizer_factory=TestSynthesizer))
    db.expire_all()
    actual = client.get("/api/v1/admin/narration-jobs/" + job["id"]).json()["data"]
    assert actual["state"] == "ready", actual
    return actual


def adopt(client, item, asset_id):
    candidate = copy.deepcopy(item["content"])
    candidate["stops"][0]["segments"][0]["narration_asset_id"] = asset_id
    return save(client, candidate, item)


def test_narration_publish_and_public_read_are_independent_of_paid_session(client, db, narration):
    item, factory = narration
    response = client.post(f"/api/v1/admin/experiences/{item['id']}/review/submit",
                           json={"expected_revision": item["revision"], "note": "测试提审"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "NARRATION_REQUIRED"
    job = generate(client, db, item, factory)
    manifest = client.get(f"/api/v1/admin/narration-assets/{job['asset_id']}/manifest")
    assert manifest.status_code == 200
    chunk = manifest.json()["data"]["chunks"][0]
    assert client.get(chunk["url"]).content == wav_bytes()
    item = action(client, adopt(client, item, job["asset_id"]), "submit")
    login(client, "reviewer")
    item = action(client, item, "publish")
    before = sum(db.scalars(select(PublicAgentCounter.amount)))
    client.cookies.clear()
    client.headers.pop("x-csrf-token", None)
    client.app.state.settings.narration_generation_enabled = False
    path = f"/api/v1/experiences/{item['id']}/narration"
    query = {"revision": item["published_revision"], "stop_index": 0, "segment_id": "first-segment"}
    public = client.get(path, params=query)
    assert public.status_code == 200, public.text
    audio_url = public.json()["data"]["chunks"][0]["url"]
    result = client.get(audio_url, headers={"Range": "bytes=0-15"})
    assert result.status_code == 206 and result.content == wav_bytes()[:16]
    assert result.headers["cache-control"] == "no-store"
    assert client.get(audio_url, headers={"Range": "bytes=0-1,3-4"}).status_code == 416
    assert client.get(path, params={**query, "stop_index": 1}).status_code == 404
    assert client.get(path, params={**query, "revision": 99}).status_code == 409
    assert sum(db.scalars(select(PublicAgentCounter.amount))) == before


def test_queue_idempotency_and_no_concurrent_duplicate(client, db, narration):
    item, _ = narration
    operation = str(uuid4())
    first = queue(client, item, operation)
    second = queue(client, item, operation)
    assert first.status_code == second.status_code == 201
    assert first.json()["data"] == second.json()["data"]
    assert queue(client, item).status_code == 409
    assert len(db.scalars(select(NarrationJob)).all()) == 1
    assert not any(job.attempts for job in db.scalars(select(NarrationJob)))


def test_lost_queue_response_is_reconciled_by_private_operation(client, db, narration):
    item, _ = narration
    operation = str(uuid4())
    created = queue(client, item, operation)
    query = {"tour_id": item["id"], "operation_id": operation}
    found = client.get("/api/v1/admin/narration-jobs", params=query)
    assert found.status_code == 200 and found.json()["data"] == created.json()["data"]
    missing = client.get("/api/v1/admin/narration-jobs", params={**query, "operation_id": str(uuid4())})
    assert missing.json()["data"] == []
    login(client, "reviewer")
    assert client.get("/api/v1/admin/narration-jobs", params=query).json()["data"] == []
    assert len(db.scalars(select(NarrationJob)).all()) == 1
    assert db.scalar(select(NarrationJob.attempts)) == 0


def test_profile_change_stops_queued_work_without_supplier_attempt(client, db, narration):
    item, factory = narration
    job = queue(client, item).json()["data"][0]
    claim = claim_job(factory)
    client.app.state.settings.voice_max_characters += 1
    asyncio.run(run_job(factory, client.app.state.settings, *claim, synthesizer_factory=TestSynthesizer))
    db.expire_all()
    stored = db.get(NarrationJob, job["id"])
    assert stored.state == "failed" and stored.last_error == "NARRATION_PROFILE_CHANGED"
    assert stored.attempts == 0


def test_asset_identity_prevents_copy_and_changed_text_adoption(client, db, narration):
    item, factory = narration
    job = generate(client, db, item, factory)
    copied = copy.deepcopy(item["content"])
    copied["stops"][0]["segments"][0]["narration_asset_id"] = job["asset_id"]
    save(client, copied, expected=409)
    copied["stops"][0]["segments"][0]["text"] = "已经改过的文字"
    save(client, copied, item, expected=409)
    assert client.get(f"/api/v1/experiences/{item['id']}/narration", params={
        "revision": 1, "stop_index": 0, "segment_id": "first-segment",
    }).status_code == 404


def test_cancelled_result_cannot_write_asset(client, db, narration):
    item, factory = narration
    job = queue(client, item).json()["data"][0]
    claim = claim_job(factory)

    class CancelDuringProvider(TestSynthesizer):
        async def synthesize(self, text):
            result = await super().synthesize(text)
            response = client.post(f"/api/v1/admin/narration-jobs/{job['id']}/cancel")
            assert response.status_code == 200
            return result

    asyncio.run(run_job(factory, client.app.state.settings, *claim, synthesizer_factory=CancelDuringProvider))
    db.expire_all()
    assert db.get(NarrationJob, job["id"]).state == "cancelled"
    assert client.get(f"/api/v1/admin/narration-assets/{job['id']}/manifest").status_code == 404


def test_expired_lease_requires_explicit_retry(client, db, narration):
    item, factory = narration
    job = queue(client, item).json()["data"][0]
    claim_job(factory)
    db.expire_all()
    stored = db.get(NarrationJob, job["id"])
    stored.lease_until = now_utc() - timedelta(seconds=1)
    db.commit()
    assert claim_job(factory) is None
    db.expire_all()
    assert db.get(NarrationJob, job["id"]).state == "unknown"
    response = client.post(f"/api/v1/admin/narration-jobs/{job['id']}/retry")
    assert response.status_code == 200 and response.json()["data"]["state"] == "queued"


def test_disabled_and_unauthorized_generation_never_calls_supplier(client, db, narration):
    item, _ = narration
    login(client, "viewer")
    assert queue(client, item).status_code == 403
    login(client)
    client.app.state.settings.narration_generation_enabled = False
    assert queue(client, item).status_code == 409
    assert db.scalar(select(NarrationJob.id)) is None


def test_audio_rejects_duration_size_and_storage_escape(client, db, narration):
    with pytest.raises(DomainError):
        audio_metadata(b"not audio", 1000)
    with pytest.raises(DomainError):
        audio_metadata(wav_bytes(), 10)
    with pytest.raises(DomainError):
        chunk_path(client.app.state.settings, "../../etc", {"sha256": "a" * 64, "byte_size": 2})
