"""Narration identities, scope checks and immutable file publication."""

import hashlib
import io
import json
import os
import re
import wave
from uuid import UUID, uuid4

from app.core.errors import DomainError
from app.integrations.public_agent_security import speech_chunks
from app.modules.voice.config import resolve_tiers
from app.narration_models import NarrationAsset

SPLITTER_VERSION = "speech-chunks-v1"


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def profile_for(settings, profile_id="standard"):
    if profile_id not in {"standard", "demo"}:
        raise DomainError("NARRATION_PROFILE_UNKNOWN", "请选择已登记的声音配置", 422)
    return {
        "id": profile_id,
        "splitter": SPLITTER_VERSION,
        "max_characters": settings.voice_max_characters,
        "tiers": [{"name": tier.name, "model": tier.model, "voice": tier.voice}
                  for tier in resolve_tiers(profile_id)],
    }


def segment_source(content, segment_id):
    if content.kind == "tour":
        for index, stop in enumerate(content.stops):
            for segment in stop.segments or []:
                if segment.id == segment_id:
                    return index, stop, segment
    raise DomainError("NARRATION_SOURCE_CHANGED", "段落已变化，请重新保存并选择段落", 409)


def source_fingerprint(tour_id, point_id, segment_id, text, profile):
    return sha(canonical({"tour_id": str(tour_id), "point_id": str(point_id),
                          "segment_id": segment_id, "text": text, "profile": profile}))


def asset_matches(asset, record, stop, segment):
    return bool(asset and record and asset.tour_id == record.id
                and asset.point_id == str(stop.point_id) and asset.segment_id == segment.id
                and asset.text_sha256 == sha(segment.text)
                and asset.fingerprint == source_fingerprint(record.id, stop.point_id, segment.id,
                                                            segment.text, asset.profile))


def validate_bindings(db, record, content, *, require_ready=False, allow_stale_existing=False):
    """Every adoption is identity-bound; generation counts as contribution."""
    contributors = set()
    if content.kind != "tour":
        return contributors
    for stop in content.stops:
        if require_ready and content.narration_mode == "recorded" and not stop.segments and stop.narrative.strip():
            raise DomainError("NARRATION_REQUIRED", "请先将旧讲稿转换为段落，再制作正式讲解", 409)
        for segment in stop.segments or []:
            if segment.narration_asset_id:
                asset = db.get(NarrationAsset, str(segment.narration_asset_id))
                existing_identity = bool(asset and record and asset.tour_id == record.id
                                         and asset.point_id == str(stop.point_id) and asset.segment_id == segment.id)
                previously_adopted = existing_identity and any(
                    str(old_stop.get("point_id")) == str(stop.point_id)
                    and old_segment.get("id") == segment.id
                    and old_segment.get("narration_asset_id") == asset.id
                    for payload in (record.draft, record.published) if payload
                    for old_stop in payload.get("stops", [])
                    for old_segment in old_stop.get("segments") or []
                )
                stale_draft = allow_stale_existing and not require_ready and previously_adopted
                if not asset_matches(asset, record, stop, segment) and not stale_draft:
                    raise DomainError("NARRATION_SOURCE_CHANGED", "讲解音频与当前段落不匹配，请重新制作或移除旧采用", 409)
                contributors.add(asset.created_by)
            elif require_ready and content.narration_mode == "recorded" and segment.text.strip():
                raise DomainError("NARRATION_REQUIRED", "正式音频导览的有文段落须试听并采用完整音频后提审", 409)
    return contributors


def audio_metadata(audio, max_bytes):
    if not audio or len(audio) > max_bytes or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise DomainError("NARRATION_AUDIO_INVALID", "生成音频格式或大小不符合要求", 422)
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
            expected = wav.getnframes() * wav.getnchannels() * wav.getsampwidth()
            if (not 0 < duration <= 180 or not 1 <= wav.getnchannels() <= 2
                    or not 8000 <= wav.getframerate() <= 192000 or not 1 <= wav.getsampwidth() <= 4
                    or expected > max_bytes or len(wav.readframes(wav.getnframes())) != expected):
                raise ValueError("invalid WAV")
    except (wave.Error, EOFError, ZeroDivisionError, ValueError):
        raise DomainError("NARRATION_AUDIO_INVALID", "生成音频不完整或超出时长限制", 422) from None
    return {"sha256": sha(audio), "byte_size": len(audio), "duration_seconds": duration}


def asset_directory(settings, asset_id):
    try:
        safe_id = str(UUID(str(asset_id)))
    except ValueError:
        raise DomainError("NOT_FOUND", "音频资产不存在", 404) from None
    root = settings.floor_assets_dir.resolve()
    path = root / ".narration" / safe_id
    for part in (root / ".narration", path):
        if part.is_symlink():
            raise DomainError("NARRATION_STORAGE_INVALID", "音频存储不可用", 503)
    if not path.resolve().is_relative_to(root):
        raise DomainError("NARRATION_STORAGE_INVALID", "音频存储不可用", 503)
    return path


def chunk_path(settings, asset_id, chunk):
    if not re.fullmatch(r"[a-f0-9]{64}", chunk.get("sha256", "")):
        raise DomainError("NARRATION_STORAGE_INVALID", "音频清单校验失败", 503)
    path = asset_directory(settings, asset_id) / (chunk["sha256"] + ".wav")
    if path.is_symlink() or not path.is_file() or path.stat().st_size != chunk["byte_size"]:
        raise DomainError("NOT_FOUND", "音频文件暂不可用，请阅读文字讲解", 404)
    return path


def write_chunk(settings, asset_id, audio):
    """Caller holds storage_guard through file publication and DB commit."""
    metadata = audio_metadata(audio, settings.voice_max_audio_bytes)
    directory = asset_directory(settings, asset_id)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (metadata["sha256"] + ".wav")
    if target.is_symlink():
        raise DomainError("NARRATION_STORAGE_INVALID", "音频存储不可用", 503)
    temporary = directory / ("." + str(uuid4()) + ".tmp")
    try:
        with temporary.open("xb") as file:
            file.write(audio)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
        if os.name != "nt":
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)
    return metadata


def chunk_texts(text, profile):
    return speech_chunks(text, max_characters=profile["max_characters"])
