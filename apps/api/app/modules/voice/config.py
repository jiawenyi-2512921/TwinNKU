"""Cloud voice configuration.

Credentials live only in server environment variables and are never echoed
in logs, API responses or error messages.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.modules.voice.rotation import VoiceTier

# Cherry was chosen after listening to a live sample and is now fixed.
DEFAULT_VOICE = "Cherry"

# L1 is the everyday model; L2 takes over when L1's trial quota runs out.
# Both use Cherry so the visitor never hears the voice change.
STANDARD_TIERS: tuple[VoiceTier, ...] = (
    VoiceTier(name="primary", model="qwen3-tts-flash", voice=DEFAULT_VOICE),
    VoiceTier(name="backup", model="qwen3-tts-instruct-flash", voice=DEFAULT_VOICE),
)

# Reserved for demos and reviews. Swapped in via VOICE_TIER=demo.
DEMO_TIERS: tuple[VoiceTier, ...] = (
    VoiceTier(name="demo", model="qwen3-tts-instruct-flash", voice=DEFAULT_VOICE),
    VoiceTier(name="primary", model="qwen3-tts-flash", voice=DEFAULT_VOICE),
)


@dataclass(frozen=True)
class VoiceConfig:
    enabled: bool
    api_key: str
    base_url: str
    tiers: tuple[VoiceTier, ...]
    timeout: float
    max_characters: int
    cache_ttl_seconds: int
    visitor_requests_per_hour: int
    total_requests_per_hour: int
    allowed_audio_hosts: tuple[str, ...] = ()
    max_audio_bytes: int = 8 * 1024 * 1024
    max_cache_bytes: int = 64 * 1024 * 1024


def resolve_tiers(tier_mode: str) -> tuple[VoiceTier, ...]:
    return DEMO_TIERS if tier_mode == "demo" else STANDARD_TIERS


def voice_config(settings) -> VoiceConfig:
    """Build the runtime voice config from application settings.

    Returns a config with `enabled=False` when nothing is provisioned, so the
    caller can fall back to browser speech without raising.
    """
    key = settings.voice_api_key.get_secret_value() if settings.voice_api_key else ""
    return VoiceConfig(
        enabled=bool(settings.voice_enabled and key),
        api_key=key,
        base_url=settings.voice_base_url,
        tiers=resolve_tiers(settings.voice_tier),
        timeout=settings.voice_timeout_seconds,
        max_characters=settings.voice_max_characters,
        cache_ttl_seconds=settings.voice_cache_ttl_seconds,
        visitor_requests_per_hour=settings.voice_visitor_requests_per_hour,
        total_requests_per_hour=settings.voice_total_requests_per_hour,
        allowed_audio_hosts=tuple(getattr(settings, "voice_allowed_audio_hosts", [])),
        max_audio_bytes=getattr(settings, "voice_max_audio_bytes", 8 * 1024 * 1024),
        max_cache_bytes=getattr(settings, "voice_cache_max_bytes", 64 * 1024 * 1024),
    )


TierMode = Literal["standard", "demo"]
