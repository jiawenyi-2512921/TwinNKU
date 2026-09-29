"""Cloud voice synthesis with tiered model failover.

The Bailian gateway never reports remaining quota, so rotation cannot be
implemented as "poll balance, then switch". The only reliable signal is a
failing call, so this module classifies each failure and only degrades to
the next tier when the failure is genuinely a quota or availability problem.
Parameter, credential and moderation errors surface immediately: silently
rotating on those would produce an endless failover loop that always fails.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterable
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

# Bailian error codes that mean "this model is unavailable to us right now".
# Anything outside this set is a real bug and must not trigger rotation.
ROTATABLE_CODES = frozenset(
    {
        "Arrearage",
        "Throttling",
        "Throttling.RateQuota",
        "Throttling.AllocationQuota",
        "AllocatedQuotaExceeded",
        "ModelNotOpen",
        "ModelNotFound",
        "ServiceUnavailable",
    }
)

# Errors worth one immediate retry on the same tier before degrading.
TRANSIENT_HTTP_STATUS = frozenset({500, 502, 503, 504})


class VoiceSynthesisError(Exception):
    """Raised when every tier has been exhausted."""

    def __init__(self, message: str, *, attempts: int, last_code: str | None = None):
        super().__init__(message)
        self.attempts = attempts
        self.last_code = last_code


@dataclass(frozen=True)
class VoiceTier:
    """One rung of the failover ladder."""

    name: str
    model: str
    voice: str


@dataclass(frozen=True)
class SynthesisResult:
    audio: bytes
    media_type: str
    model: str
    tier: str
    degraded: bool
    characters: int


def _extract_error_code(payload: object) -> str | None:
    """Pull the Bailian error code out of an error body, tolerating shape drift."""
    if not isinstance(payload, dict):
        return None
    for key in ("code", "error_code"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    nested = payload.get("error")
    if isinstance(nested, dict):
        for key in ("code", "type"):
            value = nested.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _is_rotatable(code: str | None) -> bool:
    if not code:
        return False
    # Gateway prefixes vary (e.g. "Throttling.RateQuota"), so match on prefix.
    return any(code == known or code.startswith(f"{known}.") for known in ROTATABLE_CODES)


def cache_key(text: str, tier: VoiceTier) -> str:
    """Content-addressed cache key.

    Guide copy repeats heavily, so identical sentences must never be billed
    twice. Voice and model are part of the key: changing either changes audio.
    """
    digest = hashlib.sha256(f"{tier.model}\x1f{tier.voice}\x1f{text}".encode()).hexdigest()
    return digest[:32]


class VoiceSynthesizer:
    """Synthesises speech, degrading across tiers when quota runs out."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        tiers: Iterable[VoiceTier],
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._tiers = tuple(tiers)
        if not self._tiers:
            raise ValueError("at least one voice tier is required")
        self._timeout = timeout
        self._transport = transport

    @property
    def tiers(self) -> tuple[VoiceTier, ...]:
        return self._tiers

    @property
    def primary_model(self) -> str:
        return self._tiers[0].model

    async def synthesize(self, text: str) -> SynthesisResult:
        """Synthesise `text`, walking down the ladder until one tier succeeds."""
        if not text.strip():
            raise ValueError("text must not be blank")

        attempts = 0
        last_code: str | None = None

        for index, tier in enumerate(self._tiers):
            attempts += 1
            try:
                audio = await self._call_tier(tier, text)
            except _RotateToNext as exc:
                last_code = exc.code
                logger.warning(
                    "voice tier %s unavailable (code=%s); degrading", tier.name, exc.code
                )
                continue
            except _TierHardFailure as exc:
                # Not a quota problem. Surfacing it beats masking it.
                raise VoiceSynthesisError(
                    str(exc), attempts=attempts, last_code=exc.code
                ) from exc

            return SynthesisResult(
                audio=audio,
                media_type="audio/wav",
                model=tier.model,
                tier=tier.name,
                degraded=index > 0,
                characters=len(text),
            )

        raise VoiceSynthesisError(
            "所有语音模型均不可用", attempts=attempts, last_code=last_code
        )

    async def _call_tier(self, tier: VoiceTier, text: str) -> bytes:
        url = f"{self._base_url}/api/v1/services/aigc/multimodal-generation/generation"
        payload = {
            "model": tier.model,
            "input": {"text": text, "voice": tier.voice},
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(
            timeout=self._timeout, transport=self._transport
        ) as client:
            response = await client.post(url, json=payload, headers=headers)

            if response.status_code in TRANSIENT_HTTP_STATUS:
                # Server-side blip: one same-tier retry before giving up on it.
                response = await client.post(url, json=payload, headers=headers)

            if response.status_code >= 400:
                code = None
                try:
                    code = _extract_error_code(response.json())
                except ValueError:
                    pass
                if _is_rotatable(code):
                    raise _RotateToNext(code or f"HTTP {response.status_code}")
                raise _TierHardFailure(
                    f"语音合成请求被拒绝（HTTP {response.status_code}）", code=code
                )

            try:
                body = response.json()
            except ValueError as exc:
                raise _TierHardFailure("语音服务返回了无法解析的响应") from exc

            return await self._read_audio(client, body)

    @staticmethod
    async def _read_audio(client: httpx.AsyncClient, body: object) -> bytes:
        """Extract audio, accepting either inline base64 or a download URL.

        The gateway normally returns `data` as an empty string and puts the
        real audio behind a signed OSS URL, so the URL branch is the common
        path rather than a fallback.
        """
        import base64

        if not isinstance(body, dict):
            raise _TierHardFailure("语音服务返回结构异常")
        output = body.get("output")
        if not isinstance(output, dict):
            raise _TierHardFailure("语音服务返回结构异常")
        audio = output.get("audio")
        if not isinstance(audio, dict):
            raise _TierHardFailure("语音服务未返回音频")

        inline = audio.get("data")
        if isinstance(inline, str) and inline:
            try:
                return base64.b64decode(inline)
            except ValueError as exc:
                raise _TierHardFailure("语音音频解码失败") from exc

        remote = audio.get("url")
        if isinstance(remote, str) and remote:
            try:
                download = await client.get(remote)
            except httpx.HTTPError as exc:
                raise _TierHardFailure("语音音频下载失败") from exc
            if download.status_code >= 400 or not download.content:
                raise _TierHardFailure("语音音频下载失败")
            return download.content

        raise _TierHardFailure("语音服务未返回可用的音频数据")


class _RotateToNext(Exception):
    """Internal: this tier is out of quota; try the next one."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class _TierHardFailure(Exception):
    """Internal: a real error that must not trigger rotation."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code
