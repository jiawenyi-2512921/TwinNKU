"""Tests for tiered voice failover.

The behaviour under test is the boundary that matters in production:
quota failures must degrade to the next model, while genuine bugs must
surface immediately instead of burning through every tier.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from app.modules.voice.rotation import (
    VoiceSynthesisError,
    VoiceSynthesizer,
    VoiceTier,
)

TIERS = (
    VoiceTier(name="primary", model="qwen3-tts-flash", voice="Cherry"),
    VoiceTier(name="backup", model="qwen3-tts-instruct-flash", voice="Cherry"),
)

TIMEOUT = 5.0


def _audio_body(data: bytes = b"RIFFfake-wav-bytes") -> dict:
    return {
        "output": {"audio": {"data": base64.b64encode(data).decode(), "expires_at": 1}},
        "usage": {"characters": 12},
    }


def _error_body(code: str) -> dict:
    return {"code": code, "message": "synthetic failure", "request_id": "req-test"}


def _synthesizer(handler) -> VoiceSynthesizer:
    return VoiceSynthesizer(
        api_key="sk-ws-test",
        base_url="https://example.invalid",
        tiers=TIERS,
        timeout=TIMEOUT,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.anyio
async def test_primary_tier_success_does_not_degrade():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.append(payload["model"])
        return httpx.Response(200, json=_audio_body())

    result = await _synthesizer(handler).synthesize("欢迎来到南开大学")

    assert result.model == "qwen3-tts-flash"
    assert result.tier == "primary"
    assert result.degraded is False
    assert result.characters == 8
    assert result.media_type == "audio/wav"
    assert seen == ["qwen3-tts-flash"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "code",
    [
        "Arrearage",
        "Throttling",
        "Throttling.RateQuota",
        "Throttling.AllocationQuota",
        "AllocatedQuotaExceeded",
        "ModelNotOpen",
    ],
)
async def test_quota_errors_degrade_to_next_tier(code: str):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        seen.append(model)
        if model == "qwen3-tts-flash":
            return httpx.Response(400, json=_error_body(code))
        return httpx.Response(200, json=_audio_body())

    result = await _synthesizer(handler).synthesize("图书馆怎么走")

    assert result.model == "qwen3-tts-instruct-flash"
    assert result.tier == "backup"
    assert result.degraded is True
    assert seen == ["qwen3-tts-flash", "qwen3-tts-instruct-flash"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "code",
    ["InvalidParameter", "InvalidApiKey", "DataInspectionFailed", "UnsupportedModel"],
)
async def test_non_quota_errors_never_rotate(code: str):
    """A parameter bug must not silently burn every tier and then fail anyway."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return httpx.Response(400, json=_error_body(code))

    with pytest.raises(VoiceSynthesisError) as excinfo:
        await _synthesizer(handler).synthesize("马蹄湖在哪")

    assert seen == ["qwen3-tts-flash"], "must stop at the first tier"
    assert excinfo.value.attempts == 1
    assert excinfo.value.last_code == code


@pytest.mark.anyio
async def test_all_tiers_exhausted_reports_attempt_count():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=_error_body("Arrearage"))

    with pytest.raises(VoiceSynthesisError) as excinfo:
        await _synthesizer(handler).synthesize("西南门")

    assert excinfo.value.attempts == len(TIERS)
    assert excinfo.value.last_code == "Arrearage"


@pytest.mark.anyio
async def test_server_error_retries_same_tier_once_then_degrades():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        calls.append(model)
        if model == "qwen3-tts-flash":
            return httpx.Response(503, json={"code": "ServiceUnavailable"})
        return httpx.Response(200, json=_audio_body())

    result = await _synthesizer(handler).synthesize("津南校区")

    # Two attempts on the primary (initial + retry), then one on the backup.
    assert calls == ["qwen3-tts-flash", "qwen3-tts-flash", "qwen3-tts-instruct-flash"]
    assert result.tier == "backup"


@pytest.mark.anyio
async def test_audio_is_downloaded_when_gateway_returns_a_url():
    """The gateway's normal shape: empty `data`, real audio behind a signed URL.

    This is the production path, not an edge case — an inline-only parser
    passes every mock test and then fails on the first real call.
    """
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            requested.append(str(request.url))
            return httpx.Response(200, content=b"RIFF-downloaded-from-oss")
        return httpx.Response(
            200,
            json={
                "output": {
                    "audio": {
                        "data": "",
                        "url": "https://oss.example.invalid/speech.wav?sig=abc",
                        "id": "audio_test",
                    }
                },
                "usage": {"characters": 8},
            },
        )

    result = await _synthesizer(handler).synthesize("欢迎来到南开大学")

    assert result.audio == b"RIFF-downloaded-from-oss"
    assert requested == ["https://oss.example.invalid/speech.wav?sig=abc"]


@pytest.mark.anyio
async def test_failed_audio_download_is_a_hard_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(403, content=b"expired")
        return httpx.Response(
            200, json={"output": {"audio": {"data": "", "url": "https://oss.invalid/x.wav"}}}
        )

    with pytest.raises(VoiceSynthesisError) as excinfo:
        await _synthesizer(handler).synthesize("马蹄湖")

    assert excinfo.value.attempts == 1, "a failed download must not rotate"


@pytest.mark.anyio
async def test_blank_text_is_rejected_before_any_network_call():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("network must not be touched")

    with pytest.raises(ValueError):
        await _synthesizer(handler).synthesize("   ")


@pytest.mark.anyio
async def test_unparseable_success_body_is_a_hard_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output": {"unexpected": True}})

    with pytest.raises(VoiceSynthesisError) as excinfo:
        await _synthesizer(handler).synthesize("图书馆")

    assert excinfo.value.attempts == 1, "malformed body must not rotate"


def test_cache_key_differs_by_model_and_voice():
    from app.modules.voice.rotation import cache_key

    text = "欢迎来到南开大学"
    a = cache_key(text, TIERS[0])
    b = cache_key(text, TIERS[1])
    c = cache_key("欢迎来到南开大学津南校区", TIERS[0])

    assert a != b, "model change must invalidate cached audio"
    assert a != c
    assert a == cache_key(text, TIERS[0]), "must be deterministic"


def test_synthesizer_requires_at_least_one_tier():
    with pytest.raises(ValueError):
        VoiceSynthesizer(api_key="sk-ws-test", base_url="https://example.invalid", tiers=())


@pytest.mark.anyio
@pytest.mark.parametrize("base", ["https://example.invalid", "https://example.invalid/api/v1/"])
async def test_origin_and_sdk_base_use_the_same_tts_endpoint(base):
    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(200, json=_audio_body())

    synthesizer = VoiceSynthesizer(
        api_key="synthetic-test-key",
        base_url=base,
        tiers=TIERS,
        transport=httpx.MockTransport(handler),
    )
    await synthesizer.synthesize("测试语音")
    assert requested == [
        "https://example.invalid/api/v1/services/aigc/multimodal-generation/generation"
    ]


@pytest.mark.anyio
async def test_transport_failure_is_sanitized_and_does_not_retry_billable_synthesis():
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("synthetic private upstream detail", request=request)

    with pytest.raises(VoiceSynthesisError) as error:
        await _synthesizer(handler).synthesize("测试语音")
    assert len(calls) == 1
    assert error.value.last_code == "TransportError"
    assert "private upstream" not in str(error.value)
