"""One bounded durable narration worker; no public listener or visitor identity.

Expired work becomes unknown and needs an explicit staff retry. A lease/fence
prevents late provider responses from publishing after cancellation or recovery.
"""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import select, text, update

from app.core.config import get_settings
from app.core.errors import DomainError
from app.database import SessionLocal
from app.integrations.public_agent_security import reserve, utc
from app.models import StaffUserRecord, now_utc
from app.modules.admin.security import Principal
from app.modules.experiences import require_record, stored_content, validate_candidate
from app.modules.narration.router import require_generation
from app.modules.narration.service import (
    canonical,
    profile_for,
    segment_source,
    sha,
    source_fingerprint,
    write_chunk,
)
from app.modules.uploads import storage_guard
from app.modules.voice.config import voice_config
from app.modules.voice.rotation import VoiceSynthesizer, VoiceTier
from app.narration_models import NarrationAsset, NarrationJob

logger = logging.getLogger("twinnku.narration")
LEASE_SECONDS = 90


def claim_job(factory):
    with factory() as db:
        if db.get_bind().dialect.name == "postgresql":
            # Serialize the concurrency-one decision across all worker replicas.
            db.execute(text("SELECT pg_advisory_xact_lock(782603141)"))
        db.execute(update(NarrationJob).where(
            NarrationJob.state == "running", NarrationJob.lease_until < now_utc(),
        ).values(state="unknown", last_error="LEASE_EXPIRED", lease_until=None,
                 lease_version=NarrationJob.lease_version + 1, updated_at=now_utc()))
        running = db.scalar(select(NarrationJob.id).where(NarrationJob.state == "running").limit(1))
        if running:
            db.commit()
            return None
        job = db.scalar(select(NarrationJob).where(NarrationJob.state == "queued")
                        .order_by(NarrationJob.created_at, NarrationJob.id)
                        .with_for_update(skip_locked=True).limit(1))
        if not job:
            db.commit()
            return None
        job.state = "running"
        job.lease_version += 1
        job.lease_until = now_utc() + timedelta(seconds=LEASE_SECONDS)
        job.updated_at = now_utc()
        result = job.id, job.lease_version
        db.commit()
        return result


def fenced_job(db, job_id, fence):
    job = db.scalar(select(NarrationJob).where(NarrationJob.id == job_id)
                    .with_for_update().execution_options(populate_existing=True))
    if (not job or job.state != "running" or job.lease_version != fence
            or not job.lease_until or utc(job.lease_until) <= now_utc()):
        raise DomainError("NARRATION_LEASE_LOST", "任务已取消或执行权已过期", 409)
    return job


def current_source(db, job, settings):
    from app.modules.configurations import effective_runtime
    approved_profile = profile_for(settings, effective_runtime(db, settings).profile_id)
    if canonical(job.profile) != canonical(approved_profile):
        raise DomainError("NARRATION_PROFILE_CHANGED", "声音配置已变化，请按当前配置创建新任务", 409)
    user = db.get(StaffUserRecord, job.created_by)
    if not user or not user.is_active or user.must_change_password:
        raise DomainError("NARRATION_ACTOR_UNAVAILABLE", "创建任务的员工账号暂不可用", 403)
    actor = Principal(user=user, session=None)
    actor.require("points.edit")
    record = require_record(db, actor, job.tour_id)
    if record.state not in {"draft", "rejected"} or not record.draft or record.operation != "upsert":
        raise DomainError("NARRATION_SOURCE_CHANGED", "来源草稿已进入审核或被撤回", 409)
    content = stored_content(record, record.draft)
    _, stop, segment = segment_source(content, job.segment_id)
    if job.fingerprint != source_fingerprint(record.id, stop.point_id, segment.id, segment.text, job.profile):
        raise DomainError("NARRATION_SOURCE_CHANGED", "来源段落已发生变化", 409)
    validate_candidate(db, actor, content, settings)


def reserve_attempt(factory, settings, job_id, fence, characters):
    from app.modules.configurations import effective_runtime
    from app.modules.narration.maintenance import ensure_capacity
    with storage_guard(settings), factory() as db:
        # Refuse another billable attempt when even a bounded provider response
        # cannot fit. Count physical orphan bytes, not just committed manifests.
        ensure_capacity(settings, settings.voice_max_audio_bytes)
        job = fenced_job(db, job_id, fence)
        require_generation(db, settings)
        current_source(db, job, settings)
        policy = effective_runtime(db, settings)
        owner = job.created_by
        # Same global counter identities as real-time speech, stable staff identity.
        reserve(db, [
            ("supplier:voice:global", policy.voice_total_requests_per_hour, 1, 3600),
            ("supplier:voice:global", policy.voice_requests_per_day, 1, 86400),
            ("supplier:global", policy.supplier_requests_per_day, 1, 86400),
            ("supplier:voice:characters", policy.supplier_characters_per_day, characters, 86400),
            ("supplier:voice:staff:" + owner, policy.narration_staff_requests_per_hour, 1, 3600),
            ("supplier:voice:staff:" + owner, policy.narration_staff_requests_per_day, 1, 86400),
        ])
        job = fenced_job(db, job_id, fence)
        job.attempts += 1
        job.updated_at = now_utc()
        db.commit()


async def heartbeat(factory, job_id, fence, stop):
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=15)
        except TimeoutError:
            with factory() as db:
                result = db.execute(update(NarrationJob).where(
                    NarrationJob.id == job_id, NarrationJob.state == "running",
                    NarrationJob.lease_version == fence, NarrationJob.lease_until > now_utc(),
                ).values(lease_until=now_utc() + timedelta(seconds=LEASE_SECONDS)))
                db.commit()
                if result.rowcount != 1:
                    return


def fail_job(factory, job_id, fence, state, code):
    with factory() as db:
        db.execute(update(NarrationJob).where(
            NarrationJob.id == job_id, NarrationJob.state == "running", NarrationJob.lease_version == fence,
        ).values(state=state, last_error=code, lease_until=None, updated_at=now_utc()))
        db.commit()


async def run_job(factory, settings, job_id, fence, synthesizer_factory=VoiceSynthesizer):
    stop_heartbeat = asyncio.Event()
    heartbeat_task = asyncio.create_task(heartbeat(factory, job_id, fence, stop_heartbeat))
    try:
        with factory() as db:
            job = fenced_job(db, job_id, fence)
            require_generation(db, settings)
            current_source(db, job, settings)
            chunks, completed, profile = list(job.chunks), list(job.completed_chunks), dict(job.profile)
            db.commit()
        cfg = voice_config(settings)

        def before_attempt():
            reserve_attempt(factory, settings, job_id, fence, len(chunks[index]))

        synth = synthesizer_factory(api_key=cfg.api_key, base_url=cfg.base_url,
                                    tiers=[VoiceTier(**tier) for tier in profile["tiers"]],
                                    timeout=cfg.timeout, audio_hosts=cfg.allowed_audio_hosts,
                                    max_audio_bytes=cfg.max_audio_bytes, before_attempt=before_attempt)
        for index in range(len(completed), len(chunks)):
            result = await synth.synthesize(chunks[index])
            # The HTTP request may finish after cancellation. No late file adoption.
            with storage_guard(settings):
                with factory() as db:
                    job = fenced_job(db, job_id, fence)
                    require_generation(db, settings)
                    current_source(db, job, settings)
                    from app.modules.narration.maintenance import ensure_capacity
                    ensure_capacity(settings, len(result.audio), replacing=job_id + "/" + sha(result.audio) + ".wav")
                    meta = write_chunk(settings, job_id, result.audio)
                    actual_voice = next(tier["voice"] for tier in profile["tiers"] if tier["name"] == result.tier)
                    completed.append({**meta, "chunk_id": str(index), "text": chunks[index],
                                      "model": result.model, "tier": result.tier, "voice": actual_voice})
                    job.completed_chunks = list(completed)
                    job.updated_at = now_utc()
                    db.commit()
        with storage_guard(settings):
            with factory() as db:
                job = fenced_job(db, job_id, fence)
                require_generation(db, settings)
                current_source(db, job, settings)
                manifest_sha = sha(canonical({"fingerprint": job.fingerprint, "chunks": completed}))
                db.add(NarrationAsset(id=job.id, job_id=job.id, tour_id=job.tour_id, point_id=job.point_id,
                                      segment_id=job.segment_id, created_by=job.created_by,
                                      text_sha256=job.text_sha256, spoken_sha256=sha("".join(chunks)),
                                      profile=job.profile, fingerprint=job.fingerprint,
                                      manifest_sha256=manifest_sha, chunks=completed))
                job.state, job.lease_until, job.last_error = "ready", None, ""
                job.updated_at = now_utc()
                db.commit()
    except DomainError as exc:
        state = "paused" if exc.code in {"NARRATION_DISABLED", "PUBLIC_BUDGET_REACHED", "NARRATION_STORAGE_FULL"} else "failed"
        fail_job(factory, job_id, fence, state, exc.code)
    except Exception:
        # A provider, DB or file error after send cannot prove that no charge occurred.
        fail_job(factory, job_id, fence, "unknown", "GENERATION_OUTCOME_UNKNOWN")
        logger.warning("narration_failed stage=generation outcome=unknown")
    finally:
        stop_heartbeat.set()
        await heartbeat_task


async def work():
    settings = get_settings()
    if settings.app_env == "production":
        from app.database import engine
        if engine.dialect.name != "postgresql":
            raise RuntimeError("Narration worker requires PostgreSQL")
    while True:
        try:
            with SessionLocal() as db:
                require_generation(db, settings)
            claim = claim_job(SessionLocal)
            if claim:
                await run_job(SessionLocal, settings, *claim)
                continue
        except Exception:
            logger.warning("narration_worker_idle reason=unavailable")
        await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(work())
