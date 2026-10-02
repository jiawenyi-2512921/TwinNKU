"""Scoped public narration and private staff preview; never an arbitrary TTS proxy."""

from __future__ import annotations

import asyncio
import threading
import time
from collections import OrderedDict
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request, Response
from pydantic import Field

from app.api import DB, envelope
from app.contracts import DTO, Envelope
from app.core.errors import DomainError
from app.integrations.public_agent_security import (
    acquire_lease,
    capability,
    digest,
    http_budget,
    issue,
    paid_attempt,
    release_lease,
    speech_chunks,
    visitor,
)
from app.modules.admin.security import Actor
from app.modules.voice.config import voice_config
from app.modules.voice.rotation import VoiceSynthesisError, VoiceSynthesizer, cache_key

router = APIRouter(tags=["voice"])
META = {"x-implementation-status": "implemented", "x-module": "M26"}
_AUDIO_CACHE: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
_CACHE_LOCK = threading.Lock()
_INFLIGHT: dict[str, asyncio.Task] = {}
_MAX_CACHED_CLIPS = 512


class TourSpeechSource(DTO):
    kind: Literal["tour_segment"]
    tour_id: UUID
    tour_revision: int = Field(ge=1)
    stop_index: int = Field(ge=0, le=49)
    segment_id: str | None = Field(default=None, max_length=64)


class DraftSpeechSource(DTO):
    kind: Literal["draft_segment"]
    tour_id: UUID
    draft_revision: int = Field(ge=1)
    stop_index: int = Field(ge=0, le=49)
    segment_id: str | None = Field(default=None, max_length=64)


class VoicePrepare(DTO):
    source: TourSpeechSource


class DraftVoicePrepare(DTO):
    source: DraftSpeechSource


class SpeechRequest(DTO):
    permit: str = Field(min_length=16, max_length=128)
    chunk_index: int = Field(ge=0, le=1024)


class VoiceManifest(DTO):
    permit: str | None = None
    chunks: list[str] = Field(default_factory=list)


def _segment_text(content, stop_index, segment_id):
    if content.kind != "tour" or stop_index >= len(content.stops):
        raise DomainError("VOICE_SOURCE_UNAVAILABLE", "导览段落不可用", 404)
    stop = content.stops[stop_index]
    segments = getattr(stop, "segments", None)
    if segments:
        segment = (
            next((part for part in segments if part.id == segment_id), None)
            if segment_id
            else segments[0]
        )
        if segment is None:
            raise DomainError("VOICE_SOURCE_UNAVAILABLE", "导览段落已更新", 409)
        return segment.text
    if segment_id not in (None, "legacy", f"legacy-stop-{stop_index + 1}"):
        raise DomainError("VOICE_SOURCE_UNAVAILABLE", "导览段落不可用", 404)
    return stop.narrative


def _public_text(db, source):
    from app.modules.experiences import get_published_experience

    item = get_published_experience(db, str(source.tour_id))
    if item.revision != source.tour_revision:
        raise DomainError("VOICE_SOURCE_STALE", "导览路线已更新，请重新载入", 409)
    return _segment_text(item.content, source.stop_index, source.segment_id)


def _draft_text(db, actor, source, settings):
    from app.modules.experiences import require_record, stored_content, validate_candidate

    actor.require("points.read")
    record = require_record(db, actor, str(source.tour_id))
    if record.revision != source.draft_revision or not record.draft:
        raise DomainError("VOICE_SOURCE_STALE", "草稿已更新，请重新载入预览", 409)
    content = stored_content(record, record.draft)
    validate_candidate(db, actor, content, settings)
    return _segment_text(content, source.stop_index, source.segment_id)


def _manifest(db, request, owner, source, text):
    chunks = speech_chunks(text, voice_config(request.app.state.settings).max_characters)
    permit = (
        issue(db, owner, "speech", {"source": source.model_dump(mode="json"), "chunks": chunks})
        if chunks
        else None
    )
    return envelope(request, VoiceManifest(permit=permit, chunks=chunks))


@router.get("/api/v1/voice/status", operation_id="getVoiceStatus", openapi_extra=META)
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
    "/api/v1/voice/prepare",
    response_model=Envelope[VoiceManifest],
    operation_id="preparePublicVoice",
    openapi_extra=META,
)
def prepare(payload: VoicePrepare, request: Request, db: DB):
    session = visitor(db, request, write=True)
    http_budget(db, request, session.token_hash)
    return _manifest(
        db, request, session.token_hash, payload.source, _public_text(db, payload.source)
    )


@router.post(
    "/api/v1/admin/voice/prepare",
    response_model=Envelope[VoiceManifest],
    operation_id="prepareDraftVoice",
    openapi_extra={**META, "x-auth": "staff"},
)
def prepare_draft(payload: DraftVoicePrepare, request: Request, actor: Actor, db: DB):
    owner = digest("staff:" + actor.session.token_hash)
    http_budget(db, request, owner)
    return _manifest(
        db,
        request,
        owner,
        payload.source,
        _draft_text(db, actor, payload.source, request.app.state.settings),
    )


def _read_cache(key, ttl):
    with _CACHE_LOCK:
        entry = _AUDIO_CACHE.get(key)
        if entry is None:
            return None
        stored, audio = entry
        if ttl and time.time() - stored > ttl:
            _AUDIO_CACHE.pop(key, None)
            return None
        _AUDIO_CACHE.move_to_end(key)
        return audio


def _write_cache(key, audio, max_bytes=64 * 1024 * 1024):
    if len(audio) > max_bytes:
        return
    with _CACHE_LOCK:
        _AUDIO_CACHE.pop(key, None)
        while _AUDIO_CACHE and (
            len(_AUDIO_CACHE) >= _MAX_CACHED_CLIPS
            or sum(len(item[1]) for item in _AUDIO_CACHE.values()) + len(audio) > max_bytes
        ):
            _AUDIO_CACHE.popitem(last=False)
        _AUDIO_CACHE[key] = (time.time(), audio)


def _synthesizer_for(config, before_attempt=None):
    return VoiceSynthesizer(
        api_key=config.api_key,
        base_url=config.base_url,
        tiers=config.tiers,
        timeout=config.timeout,
        audio_hosts=config.allowed_audio_hosts,
        max_audio_bytes=config.max_audio_bytes,
        before_attempt=before_attempt,
    )


async def _speech(payload, request, db, owner, actor=None):
    config = voice_config(request.app.state.settings)
    if not config.enabled:
        raise DomainError("VOICE_UNAVAILABLE", "云端语音未启用，请使用浏览器朗读", 503)
    http_budget(db, request, owner)
    grant = capability(db, payload.permit, owner, "speech")
    source = grant.payload["source"]
    if source["kind"] == "tour_segment":
        text = _public_text(db, TourSpeechSource.model_validate(source))
        expected = speech_chunks(text, config.max_characters)
        if expected != grant.payload["chunks"]:
            raise DomainError("VOICE_SOURCE_STALE", "播报资料已更新", 409)
        namespace = "public"
    elif source["kind"] == "draft_segment" and actor:
        text = _draft_text(
            db, actor, DraftSpeechSource.model_validate(source), request.app.state.settings
        )
        if speech_chunks(text, config.max_characters) != grant.payload["chunks"]:
            raise DomainError("VOICE_SOURCE_STALE", "预览草稿已更新", 409)
        namespace = owner
    elif source["kind"] == "agent_answer" and not actor:
        namespace = owner
    else:
        raise DomainError("VOICE_SOURCE_DENIED", "该播报许可不属于当前入口", 403)
    chunks = grant.payload["chunks"]
    if payload.chunk_index >= len(chunks):
        raise DomainError("VOICE_CHUNK_INVALID", "播报片段无效", 422)
    text = chunks[payload.chunk_index]
    if not text or len(text) > config.max_characters:
        raise DomainError("VOICE_SOURCE_STALE", "播报配置已更新，请重新准备声音", 409)
    key = namespace + ":" + cache_key(text, config.tiers[0])
    audio = _read_cache(key, config.cache_ttl_seconds)
    if audio is not None:
        return Response(
            content=audio,
            media_type="audio/wav",
            headers={"x-voice-cache": "hit", "cache-control": "no-store"},
        )

    async def generate():
        lease = acquire_lease(db, request, owner, "voice")
        try:

            def reserve_attempt():
                paid_attempt(
                    db,
                    request,
                    owner,
                    "voice",
                    config.visitor_requests_per_hour,
                    config.total_requests_per_hour,
                    len(text),
                )

            try:
                # The whole failover/download sequence must finish before its
                # five-minute cross-worker lease can expire.
                async with asyncio.timeout(240):
                    result = await _synthesizer_for(config, reserve_attempt).synthesize(text)
            except TimeoutError:
                raise VoiceSynthesisError("语音生成总等待时间已到", attempts=0) from None
            _write_cache(key, result.audio, config.max_cache_bytes)
            return result
        finally:
            release_lease(db, lease)

    loop = asyncio.get_running_loop()

    def completed(done):
        # A disconnected caller may leave no waiter. Always release the dedup
        # slot and consume a failed task so it cannot become an unhandled log.
        with _CACHE_LOCK:
            if _INFLIGHT.get(key) is done:
                _INFLIGHT.pop(key, None)
        if not done.cancelled():
            done.exception()

    with _CACHE_LOCK:
        task = _INFLIGHT.get(key)
        if task and task.get_loop() is not loop:
            raise DomainError("REQUEST_IN_PROGRESS", "相同播报片段正在生成，请稍后再试", 409)
        if task is None:
            task = loop.create_task(generate())
            _INFLIGHT[key] = task
            task.add_done_callback(completed)
    try:
        result = await asyncio.shield(task)
    except VoiceSynthesisError:
        raise DomainError(
            "VOICE_SYNTHESIS_FAILED", "语音服务暂时不可用，请使用浏览器朗读", 503
        ) from None
    finally:
        with _CACHE_LOCK:
            if task.done() and _INFLIGHT.get(key) is task:
                _INFLIGHT.pop(key, None)
    headers = {
        "x-voice-cache": "miss",
        "x-voice-tier": result.tier,
        "x-voice-model": result.model,
        "cache-control": "no-store",
    }
    if result.degraded:
        headers["x-voice-degraded"] = "1"
    return Response(content=result.audio, media_type=result.media_type, headers=headers)


@router.post(
    "/api/v1/voice/speech",
    operation_id="createVoiceSpeech",
    openapi_extra=META,
    responses={200: {"content": {"audio/wav": {}}}},
)
async def create_speech(payload: SpeechRequest, request: Request, db: DB):
    session = visitor(db, request, write=True)
    return await _speech(payload, request, db, session.token_hash)


@router.post(
    "/api/v1/admin/voice/speech",
    operation_id="createDraftVoiceSpeech",
    openapi_extra={**META, "x-auth": "staff"},
    responses={200: {"content": {"audio/wav": {}}}},
)
async def create_draft_speech(payload: SpeechRequest, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return await _speech(payload, request, db, digest("staff:" + actor.session.token_hash), actor)
