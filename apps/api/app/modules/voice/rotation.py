"""Cloud voice synthesis with tiered model failover.

The Bailian gateway never reports remaining quota, so rotation cannot be
implemented as "poll balance, then switch". The only reliable signal is a
failing call, so this module classifies each failure and only degrades to
the next tier when the failure is genuinely a quota or availability problem.
Parameter, credential and moderation errors surface immediately: silently
rotating on those would produce an endless failover loop that always fails.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import ipaddress
import logging
import socket
import wave
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urlsplit

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
        audio_hosts: Iterable[str] = (),
        max_audio_bytes: int = 8 * 1024 * 1024,
        before_attempt=None,
        resolver=None,
    ):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._tiers = tuple(tiers)
        if not self._tiers:
            raise ValueError("at least one voice tier is required")
        self._timeout = timeout
        self._transport = transport
        self._audio_hosts = frozenset(host.lower() for host in audio_hosts)
        self._max_audio_bytes = max_audio_bytes
        self._before_attempt = before_attempt
        self._resolver = resolver or self._resolve_host

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
                    "voice tier %s unavailable (reason=quota_or_availability); degrading", tier.name
                )
                continue
            except _TierHardFailure as exc:
                # Not a quota problem. Surfacing it beats masking it.
                raise VoiceSynthesisError(str(exc), attempts=attempts, last_code=exc.code) from exc

            return SynthesisResult(
                audio=audio,
                media_type="audio/wav",
                model=tier.model,
                tier=tier.name,
                degraded=index > 0,
                characters=len(text),
            )

        raise VoiceSynthesisError("所有语音模型均不可用", attempts=attempts, last_code=last_code)

    async def _call_tier(self, tier: VoiceTier, text: str) -> bytes:
        # Accept both the service origin and DashScope SDK's /api/v1 base.
        api_base = (
            self._base_url if self._base_url.endswith("/api/v1") else f"{self._base_url}/api/v1"
        )
        url = f"{api_base}/services/aigc/multimodal-generation/generation"
        payload = {
            "model": tier.model,
            "input": {"text": text, "voice": tier.voice},
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(
            timeout=self._timeout,
            transport=self._transport,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            try:
                response = await self._request(
                    client,
                    "POST",
                    url,
                    json=payload,
                    headers=headers,
                    limit=(self._max_audio_bytes * 4 // 3) + 65536,
                    paid=True,
                )
                if response.status_code in TRANSIENT_HTTP_STATUS:
                    # Server-side blip: one same-tier retry before giving up on it.
                    response = await self._request(
                        client,
                        "POST",
                        url,
                        json=payload,
                        headers=headers,
                        limit=(self._max_audio_bytes * 4 // 3) + 65536,
                        paid=True,
                    )
            except (httpx.HTTPError, TimeoutError) as exc:
                # Do not log provider URLs, credentials or raw transport errors.
                # No automatic timeout retry: the provider may already have billed it.
                raise _TierHardFailure("无法连接语音服务", code="TransportError") from exc

            if 300 <= response.status_code < 400:
                raise _TierHardFailure("语音服务重定向已拒绝")
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

    async def _request(self, client, method, url, *, limit, paid=False, **kwargs):
        if paid and self._before_attempt:
            self._before_attempt()
        async with asyncio.timeout(self._timeout):
            return await self._read_response(client, method, url, limit=limit, **kwargs)

    async def _read_response(self, client, method, url, *, limit, **kwargs):
        async with client.stream(method, url, **kwargs) as response:
            length = response.headers.get("content-length")
            if length:
                try:
                    if int(length) > limit:
                        raise _TierHardFailure("语音响应超过安全大小限制")
                except ValueError:
                    raise _TierHardFailure("语音响应大小格式异常") from None
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > limit:
                    raise _TierHardFailure("语音响应超过安全大小限制")
            return httpx.Response(
                response.status_code,
                headers=response.headers,
                content=bytes(body),
                request=response.request,
            )

    @staticmethod
    def _resolve_host(host):
        return {result[4][0] for result in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}

    async def _download_target(self, remote):
        try:
            parsed = urlsplit(remote)
            if (
                parsed.scheme != "https"
                or parsed.hostname not in self._audio_hosts
                or parsed.port not in (None, 443)
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
                or any(c.isspace() or ord(c) < 32 for c in remote)
                or "\\" in remote
            ):
                raise ValueError("target")
            async with asyncio.timeout(self._timeout):
                addresses = await asyncio.to_thread(self._resolver, parsed.hostname)
            validated = [ipaddress.ip_address(value) for value in addresses]
            if not validated or any(
                not ip.is_global or ip.is_multicast or ip.is_reserved for ip in validated
            ):
                raise ValueError("address")
            # Pin the vetted IP for the connection; keep the original TLS SNI and
            # HTTP Host. A second DNS lookup cannot rebind to a private address.
            return httpx.URL(remote).copy_with(host=str(validated[0])), parsed.hostname
        except (ValueError, OSError, TimeoutError):
            raise _TierHardFailure("语音下载地址未通过安全校验") from None

    def _checked_audio(self, audio):
        if (
            not audio
            or len(audio) > self._max_audio_bytes
            or len(audio) < 12
            or audio[:4] != b"RIFF"
            or audio[8:12] != b"WAVE"
        ):
            raise _TierHardFailure("语音响应不是有效且受限的WAV音频")
        try:
            with wave.open(io.BytesIO(audio), "rb") as parsed:
                if (
                    not 1 <= parsed.getnchannels() <= 2
                    or not 8000 <= parsed.getframerate() <= 192000
                    or not 1 <= parsed.getsampwidth() <= 4
                    or parsed.getnframes() < 1
                ):
                    raise ValueError("audio format")
                expected = parsed.getnframes() * parsed.getnchannels() * parsed.getsampwidth()
                if (
                    expected > self._max_audio_bytes
                    or len(parsed.readframes(parsed.getnframes())) != expected
                ):
                    raise ValueError("audio length")
        except (wave.Error, EOFError, ValueError):
            raise _TierHardFailure("语音响应不是有效且受限的WAV音频") from None
        return audio

    async def _read_audio(self, client: httpx.AsyncClient, body: object) -> bytes:
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
                if len(inline) > (self._max_audio_bytes * 4 // 3) + 8:
                    raise ValueError("length")
                return self._checked_audio(base64.b64decode(inline, validate=True))
            except ValueError as exc:
                raise _TierHardFailure("语音音频解码失败") from exc

        remote = audio.get("url")
        if isinstance(remote, str) and remote:
            target, host = await self._download_target(remote)
            try:
                download = await self._request(
                    client,
                    "GET",
                    target,
                    limit=self._max_audio_bytes,
                    headers={"Host": host},
                    extensions={"sni_hostname": host},
                )
            except (httpx.HTTPError, TimeoutError) as exc:
                raise _TierHardFailure("语音音频下载失败") from exc
            if download.status_code != 200 or not download.content:
                raise _TierHardFailure("语音音频下载失败")
            return self._checked_audio(download.content)

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
