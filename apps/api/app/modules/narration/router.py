"""Staff-owned synthesis jobs and independently authorized public audio reads."""

from typing import Literal
from urllib.parse import urlencode
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from pydantic import Field
from sqlalchemy import func, select

from app.api import DB, envelope
from app.contracts import DTO, Envelope
from app.core.errors import DomainError
from app.integrations.public_agent_security import http_budget
from app.models import now_utc
from app.modules.admin.security import Actor, audit, require_recent_mfa
from app.modules.experiences import (
    get_published_experience,
    require_record,
    stored_content,
    validate_candidate,
)
from app.modules.narration.service import (
    canonical,
    chunk_path,
    chunk_texts,
    profile_for,
    segment_source,
    sha,
    source_fingerprint,
)
from app.narration_models import NarrationAsset, NarrationJob

router = APIRouter(tags=["narration"])
PUBLIC = {"x-implementation-status": "implemented", "x-module": "M26", "x-auth": "public"}
STAFF = {**PUBLIC, "x-auth": "staff"}
WRITE = {**STAFF, "x-csrf-required": True}


class NarrationCreate(DTO):
    tour_id: UUID
    expected_revision: int = Field(ge=1)
    segment_ids: list[str] = Field(min_length=1, max_length=50)
    profile_id: Literal["standard"] = "standard"
    operation_id: UUID


class NarrationJobView(DTO):
    id: UUID
    tour_id: UUID
    segment_id: str
    source_revision: int
    state: Literal["queued", "running", "ready", "failed", "unknown", "cancelled", "paused"]
    total_chunks: int
    completed_chunks: int
    characters: int
    attempts: int
    last_error: str
    asset_id: UUID | None = None


class NarrationChunk(DTO):
    chunk_id: str
    text: str
    duration_seconds: float
    byte_size: int
    sha256: str
    url: str


class NarrationManifest(DTO):
    asset_id: UUID
    manifest_id: str
    text_sha256: str
    chunks: list[NarrationChunk]


class NarrationProfile(DTO):
    id: Literal["standard"]
    title: str
    available: bool
    staff_requests_per_hour: int
    staff_requests_per_day: int
    max_characters_per_chunk: int


def generation_allowed(db, settings):
    from app.modules.configurations import effective_runtime
    runtime = effective_runtime(db, settings)
    return bool(settings.narration_generation_enabled and settings.voice_api_key
                and runtime.narration_generation_enabled)


def require_generation(db, settings):
    if not generation_allowed(db, settings):
        raise DomainError("NARRATION_DISABLED", "正式讲解生成尚未启用或已暂停；已发布音频仍可播放", 409)


def job_view(job):
    return NarrationJobView(
        id=job.id, tour_id=job.tour_id, segment_id=job.segment_id, source_revision=job.source_revision,
        state=job.state, total_chunks=len(job.chunks), completed_chunks=len(job.completed_chunks),
        characters=len(job.text), attempts=job.attempts, last_error=job.last_error,
        asset_id=job.id if job.state == "ready" else None,
    )


def job_for(db, actor, job_id, *, lock=False):
    query = select(NarrationJob).where(NarrationJob.id == str(job_id))
    if lock:
        query = query.with_for_update()
    job = db.scalar(query.execution_options(populate_existing=True))
    if not job:
        raise DomainError("NOT_FOUND", "讲解任务不存在", 404)
    require_record(db, actor, job.tour_id)
    return job


@router.get("/api/v1/admin/narration-profiles", response_model=Envelope[list[NarrationProfile]],
            operation_id="listNarrationProfiles", openapi_extra=STAFF)
def profiles(request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    settings = request.app.state.settings
    from app.modules.configurations import effective_runtime
    policy = effective_runtime(db, settings)
    return envelope(request, [NarrationProfile(
        id=key, title=title, available=generation_allowed(db, settings),
        staff_requests_per_hour=policy.narration_staff_requests_per_hour,
        staff_requests_per_day=policy.narration_staff_requests_per_day,
        max_characters_per_chunk=settings.voice_max_characters,
    ) for key, title in (("standard", "标准讲解 · Cherry"),)])


@router.post("/api/v1/admin/narration-jobs", response_model=Envelope[list[NarrationJobView]],
             operation_id="createNarrationJobs", openapi_extra=WRITE, status_code=201)
def create_jobs(payload: NarrationCreate, request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    require_recent_mfa(actor)
    settings = request.app.state.settings
    require_generation(db, settings)
    from app.modules.configurations import effective_runtime
    if payload.profile_id != effective_runtime(db, settings).profile_id:
        raise DomainError("NARRATION_PROFILE_UNAPPROVED", "此声音配置尚未批准用于正式讲解", 409)
    http_budget(db, request, "staff:" + actor.user.id)
    request_sha = sha(canonical(payload.model_dump(mode="json")))
    record = require_record(db, actor, payload.tour_id, lock=True)
    existing = db.scalars(select(NarrationJob).where(
        NarrationJob.created_by == actor.user.id,
        NarrationJob.operation_id == str(payload.operation_id),
    ).order_by(NarrationJob.segment_id)).all()
    if existing:
        if any(job.request_sha256 != request_sha for job in existing):
            raise DomainError("OPERATION_ID_REUSED", "同一操作编号不能用于不同的生成请求", 409)
        return envelope(request, [job_view(job) for job in existing])
    if record.revision != payload.expected_revision or record.state not in {"draft", "rejected"} or not record.draft:
        raise DomainError("REVISION_CONFLICT", "请先保存当前草稿，或撤回审核后再生成讲解", 409)
    if len(set(payload.segment_ids)) != len(payload.segment_ids):
        raise DomainError("DUPLICATE_SEGMENT", "生成列表中的段落不能重复", 422)
    content = stored_content(record, record.draft)
    validate_candidate(db, actor, content, settings)
    pending = db.scalar(select(func.count()).select_from(NarrationJob).where(
        NarrationJob.state.in_(["queued", "running"]), NarrationJob.created_by == actor.user.id)) or 0
    if pending + len(payload.segment_ids) > 100:
        raise DomainError("NARRATION_QUEUE_FULL", "待生成段落已达上限，请等待已有任务完成", 429)
    profile = profile_for(settings, payload.profile_id)
    jobs = []
    for segment_id in payload.segment_ids:
        _, stop, segment = segment_source(content, segment_id)
        if not segment.text.strip():
            raise DomainError("NARRATION_EMPTY", "空白段落无需生成讲解", 422)
        fingerprint = source_fingerprint(record.id, stop.point_id, segment.id, segment.text, profile)
        # Different operation IDs must not create duplicate concurrent supplier work.
        duplicate = db.scalar(select(NarrationJob.id).where(
            NarrationJob.fingerprint == fingerprint, NarrationJob.state.in_(["queued", "running"])))
        if duplicate:
            raise DomainError("NARRATION_ALREADY_QUEUED", "相同段落已有生成任务，请查看任务进度", 409)
        job = NarrationJob(id=str(uuid4()), tour_id=record.id, point_id=str(stop.point_id),
                           segment_id=segment.id, source_revision=record.revision, created_by=actor.user.id,
                           operation_id=str(payload.operation_id), request_sha256=request_sha,
                           text=segment.text, text_sha256=sha(segment.text), profile=profile,
                           fingerprint=fingerprint, chunks=chunk_texts(segment.text, profile),
                           completed_chunks=[], state="queued", attempts=0, lease_version=0, last_error="")
        db.add(job)
        jobs.append(job)
    audit(db, actor.user, "narration.queued", details={"tour_id": record.id, "jobs": len(jobs)})
    db.commit()
    return envelope(request, [job_view(job) for job in jobs])


@router.get("/api/v1/admin/narration-jobs", response_model=Envelope[list[NarrationJobView]],
            operation_id="listNarrationJobs", openapi_extra=STAFF)
def list_jobs(tour_id: UUID, request: Request, actor: Actor, db: DB,
              operation_id: UUID | None = None):
    actor.require("points.read")
    require_record(db, actor, tour_id)
    query = select(NarrationJob).where(NarrationJob.tour_id == str(tour_id))
    if operation_id is not None:
        # Reconcile a lost POST response without replaying paid work or exposing
        # another employee's operation, even if they share this route's scope.
        query = query.where(NarrationJob.operation_id == str(operation_id),
                            NarrationJob.created_by == actor.user.id)
    rows = db.scalars(query.order_by(NarrationJob.created_at.desc(), NarrationJob.id)
                      .limit(100)).all()
    return envelope(request, [job_view(row) for row in rows])


@router.get("/api/v1/admin/narration-jobs/{job_id}", response_model=Envelope[NarrationJobView],
            operation_id="getNarrationJob", openapi_extra=STAFF)
def get_job(job_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(request, job_view(job_for(db, actor, job_id)))


@router.post("/api/v1/admin/narration-jobs/{job_id}/{action}", response_model=Envelope[NarrationJobView],
             operation_id="controlNarrationJob", openapi_extra=WRITE)
def control_job(job_id: UUID, action: Literal["cancel", "retry"], request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    if action == "retry":
        require_recent_mfa(actor)
        require_generation(db, request.app.state.settings)
    job = job_for(db, actor, job_id, lock=True)
    if job.created_by != actor.user.id and actor.user.role != "admin":
        raise DomainError("FORBIDDEN", "只能管理自己创建的讲解任务", 403)
    if action == "cancel":
        if job.state in {"queued", "running", "paused"}:
            job.state = "cancelled"
            job.lease_version += 1
    else:
        if job.last_error == "NARRATION_RETIRED":
            raise DomainError("NARRATION_RETIRED", "未采用的过期音频已回收，请按当前讲稿创建新任务", 410)
        if job.state not in {"failed", "unknown", "cancelled", "paused"}:
            raise DomainError("NARRATION_STATE_CONFLICT", "当前任务不能重试", 409)
        record = require_record(db, actor, job.tour_id)
        if record.state not in {"draft", "rejected"} or not record.draft:
            raise DomainError("REVISION_CONFLICT", "请先恢复可编辑草稿", 409)
        _, stop, segment = segment_source(stored_content(record, record.draft), job.segment_id)
        if job.fingerprint != source_fingerprint(record.id, stop.point_id, segment.id, segment.text, job.profile):
            raise DomainError("NARRATION_SOURCE_CHANGED", "原段落已变化，请创建新任务", 409)
        job.state, job.last_error = "queued", ""
        job.lease_version += 1
    job.lease_until, job.updated_at = None, now_utc()
    audit(db, actor.user, "narration." + action, details={"job_id": job.id, "state": job.state})
    db.commit()
    return envelope(request, job_view(job))


def manifest(asset, prefix, query=""):
    return NarrationManifest(asset_id=asset.id, manifest_id=asset.manifest_sha256,
                             text_sha256=asset.text_sha256, chunks=[NarrationChunk(
        **{name: chunk[name] for name in ("chunk_id", "text", "duration_seconds", "byte_size", "sha256")},
        url=f"{prefix}/chunks/{chunk['chunk_id']}" + ("?" + query if query else ""),
    ) for chunk in asset.chunks])


def private_asset(db, actor, asset_id):
    asset = db.get(NarrationAsset, str(asset_id))
    if not asset:
        raise DomainError("NOT_FOUND", "讲解音频不存在", 404)
    require_record(db, actor, asset.tour_id)
    return asset


def serve_chunk(asset, chunk_id, request):
    chunk = next((entry for entry in asset.chunks if entry["chunk_id"] == chunk_id), None)
    if not chunk:
        raise DomainError("NOT_FOUND", "讲解分片不存在", 404)
    # A single HTTP range is bounded by the maximum generated clip size.
    if "," in request.headers.get("range", ""):
        raise DomainError("INVALID_RANGE", "每次只支持一个音频范围", 416)
    return FileResponse(chunk_path(request.app.state.settings, asset.id, chunk), media_type="audio/wav",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/api/v1/admin/narration-assets/{asset_id}/manifest", response_model=Envelope[NarrationManifest],
            operation_id="previewNarrationManifest", openapi_extra=STAFF)
def private_manifest(asset_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(request, manifest(private_asset(db, actor, asset_id),
                                     f"/api/v1/admin/narration-assets/{asset_id}"))


@router.get("/api/v1/admin/narration-assets/{asset_id}/chunks/{chunk_id}",
            operation_id="previewNarrationChunk", openapi_extra=STAFF)
def private_chunk(asset_id: UUID, chunk_id: str, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return serve_chunk(private_asset(db, actor, asset_id), chunk_id, request)


def published_asset(db, tour_id, revision, stop_index, segment_id):
    item = get_published_experience(db, str(tour_id))
    if item.revision != revision or item.content.kind != "tour":
        raise DomainError("NARRATION_SOURCE_CHANGED", "路线已更新，请重新打开讲解", 409)
    index, _, segment = segment_source(item.content, segment_id)
    if index != stop_index or not segment.narration_asset_id:
        raise DomainError("NOT_FOUND", "该段落暂无正式音频", 404)
    return db.get(NarrationAsset, str(segment.narration_asset_id))


@router.get("/api/v1/experiences/{tour_id}/narration", response_model=Envelope[NarrationManifest],
            operation_id="getPublishedNarration", openapi_extra=PUBLIC)
def public_manifest(tour_id: UUID, request: Request, db: DB, revision: int = Query(ge=1),
                    stop_index: int = Query(ge=0, le=49), segment_id: str = Query(max_length=64)):
    from app.modules.configurations import effective_runtime
    if not effective_runtime(db, request.app.state.settings).narration_playback_enabled:
        raise DomainError("NARRATION_PLAYBACK_PAUSED", "正式讲解暂时暂停，请阅读文字", 409)
    asset = published_asset(db, tour_id, revision, stop_index, segment_id)
    query = urlencode({"revision": revision, "stop_index": stop_index, "segment_id": segment_id})
    return envelope(request, manifest(asset, f"/api/v1/experiences/{tour_id}/narration/{asset.id}", query))


@router.get("/api/v1/experiences/{tour_id}/narration/{asset_id}/chunks/{chunk_id}",
            operation_id="getPublishedNarrationChunk", openapi_extra=PUBLIC)
def public_chunk(tour_id: UUID, asset_id: UUID, chunk_id: str, request: Request, db: DB,
                 revision: int = Query(ge=1), stop_index: int = Query(ge=0, le=49),
                 segment_id: str = Query(max_length=64)):
    from app.modules.configurations import effective_runtime
    if not effective_runtime(db, request.app.state.settings).narration_playback_enabled:
        raise DomainError("NARRATION_PLAYBACK_PAUSED", "正式讲解暂时暂停，请阅读文字", 409)
    asset = published_asset(db, tour_id, revision, stop_index, segment_id)
    if asset.id != str(asset_id):
        raise DomainError("NOT_FOUND", "该音频未用于当前段落", 404)
    return serve_chunk(asset, chunk_id, request)
