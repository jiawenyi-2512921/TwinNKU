"""Voice synthesis endpoint.

Cloud TTS is strictly additive: when it is unconfigured or all tiers fail,
the client keeps its existing browser speech fallback, so the guide never
loses the ability to speak.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Request, Response
from pydantic import Field

from app.contracts import DTO
from app.core.errors import DomainError
from app.modules.voice.config import voice_config
from app.modules.voice.rotation import (
    VoiceSynthesisError,
    VoiceSynthesizer,
    cache_key,
)

router = APIRouter(tags=["voice"])

META = {"x-implementation-status": "implemented", "x-module": "M26"}

# In-process caches. Sized for a single API container; a multi-container
# deployment would move these to shared storage.
_AUDIO_CACHE: dict[str, tuple[float, bytes]] = {}
_RATE_WINDOWS: dict[str, deque[float]] = defaultdict(deque)
# Process-wide window, guarding against callers that rotate addresses to
# evade the per-visitor limit.
_GLOBAL_WINDOW: deque[float] = deque()
_MAX_CACHED_CLIPS = 512


class SpeechRequest(DTO):
    text: str = Field(min_length=1, max_length=2000)


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _enforce_rate(visitor: str, limit: int, total_limit: int) -> None:
    now = time.monotonic()

    while _GLOBAL_WINDOW and now - _GLOBAL_WINDOW[0] > 3600:
        _GLOBAL_WINDOW.popleft()
    if len(_GLOBAL_WINDOW) >= total_limit:
        # The service ceiling protects the account, not the individual.
        raise DomainError(
            "VOICE_CAPACITY_REACHED", "语音服务当前繁忙，请稍后再试或使用文字交流", 429
        )
    window = _RATE_WINDOWS[visitor]
    while window and now - window[0] > 3600:
        window.popleft()
    if len(window) >= limit:
        raise DomainError("VOICE_RATE_LIMITED", "语音播报过于频繁，请稍后再试", 429)
    window.append(now)
    _GLOBAL_WINDOW.append(now)

    # Bound memory: drop windows for visitors who have gone quiet.
    if len(_RATE_WINDOWS) > 4096:
        for stale in [k for k, v in _RATE_WINDOWS.items() if not v or now - v[-1] > 3600]:
            _RATE_WINDOWS.pop(stale, None)


def _read_cache(key: str, ttl: int) -> bytes | None:
    entry = _AUDIO_CACHE.get(key)
    if entry is None:
        return None
    stored_at, audio = entry
    if ttl and time.time() - stored_at > ttl:
        _AUDIO_CACHE.pop(key, None)
        return None
    return audio


def _write_cache(key: str, audio: bytes) -> None:
    if len(_AUDIO_CACHE) >= _MAX_CACHED_CLIPS:
        # Cheap eviction: drop the oldest insertion.
        _AUDIO_CACHE.pop(next(iter(_AUDIO_CACHE)), None)
    _AUDIO_CACHE[key] = (time.time(), audio)


def _synthesizer_for(config) -> VoiceSynthesizer:
    return VoiceSynthesizer(
        api_key=config.api_key,
        base_url=config.base_url,
        tiers=config.tiers,
        timeout=config.timeout,
    )


@router.get(
    "/api/v1/voice/status",
    tags=["voice"],
    operation_id="getVoiceStatus",
    openapi_extra=META,
)
def voice_status(request: Request):
    config = voice_config(request.app.state.settings)
    return {
        "enabled": config.enabled,
        "provider": "bailian" if config.enabled else "browser",
        "tiers": [tier.name for tier in config.tiers] if config.enabled else [],
        "models": [tier.model for tier in config.tiers] if config.enabled else [],
        "max_characters": config.max_characters,
        "cached_clips": len(_AUDIO_CACHE),
    }


@router.post(
    "/api/v1/voice/speech",
    operation_id="createVoiceSpeech",
    openapi_extra=META,
    responses={
        200: {"content": {"audio/wav": {}}},
        429: {"description": "Rate limited"},
        503: {"description": "Voice temporarily unavailable"},
    },
)
async def create_speech(payload: SpeechRequest, request: Request):
    config = voice_config(request.app.state.settings)
    if not config.enabled:
        # Not an error: the client should use its browser fallback.
        raise DomainError("VOICE_UNAVAILABLE", "云端语音未启用，请使用浏览器朗读", 503)

    text = payload.text.strip()
    if len(text) > config.max_characters:
        raise DomainError(
            "VOICE_TEXT_TOO_LONG",
            f"语音文本不能超过 {config.max_characters} 字",
            422,
        )

    primary = config.tiers[0]
    key = cache_key(text, primary)
    cached = _read_cache(key, config.cache_ttl_seconds)
    if cached is not None:
        # Repeat copy is the common case; a cache hit costs nothing.
        return Response(
            content=cached,
            media_type="audio/wav",
            headers={"x-voice-cache": "hit", "x-voice-tier": primary.name},
        )

    _enforce_rate(
        _client_key(request),
        config.visitor_requests_per_hour,
        config.total_requests_per_hour,
    )

    try:
        result = await _synthesizer_for(config).synthesize(text)
    except VoiceSynthesisError as exc:
        raise DomainError(
            "VOICE_SYNTHESIS_FAILED",
            "语音服务暂时不可用，请使用浏览器朗读",
            503,
        ) from exc

    _write_cache(key, result.audio)

    headers = {
        "x-voice-cache": "miss",
        "x-voice-tier": result.tier,
        "x-voice-model": result.model,
        "cache-control": "no-store",
    }
    if result.degraded:
        headers["x-voice-degraded"] = "1"
    return Response(content=result.audio, media_type=result.media_type, headers=headers)
