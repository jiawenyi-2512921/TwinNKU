"""Upload, map, check and atomically save private drafts. No publish side effects."""

import asyncio
import copy
import csv
import hashlib
import io
import os
from datetime import timedelta
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Request, Response
from pydantic import Field
from sqlalchemy import func, select, text

from app.api import DB, envelope
from app.contracts import (
    DTO,
    CampusId,
    Envelope,
    Pagination,
    PointDraftInput,
    PointDraftUpdate,
    ResourceDraftSave,
)
from app.core.errors import DomainError
from app.import_models import ImportJob
from app.models import StaffUserRecord, now_utc
from app.modules.admin import resources
from app.modules.admin import service as points
from app.modules.admin.security import Actor, audit, require_point, utc
from app.modules.experiences import ExperienceSave, _save_experience, require_record
from app.modules.imports.export import build_export
from app.modules.imports.parser import MAX_BYTES, inspect_table
from app.modules.imports.references import binding_values, catalog, ref_item
from app.modules.imports.service import (
    COLUMNS,
    commands_and_report,
    preview_digest,
    safe_csv_cell,
    suggested_mapping,
    template_csv,
    validate_mapping,
)
from app.modules.imports.tempfiles import import_temporary
from app.modules.uploads import storage_guard

router = APIRouter(tags=["imports"])
META = {"x-implementation-status": "implemented", "x-module": "M27", "x-auth": "staff"}
WRITE = {**META, "x-csrf-required": True}
Kind = Literal["point", "vr", "tour", "media"]
ReferenceKind = Literal["point", "map", "floor", "vr", "image", "video", "checkin", "tour"]


class ImportReference(DTO):
    id: UUID
    title: str
    kind: ReferenceKind
    campus_id: CampusId
    point_id: UUID | None
    point_name: str
    revision: int
    draft_revision: int
    referenceable: bool
    thumbnail_url: str | None
    audio_description_eligible: bool = False
    preview_url: str | None = None


class ImportReferenceBinding(DTO):
    rows: list[int] = Field(min_length=1, max_length=500)
    field: Literal["point_id", "map_id", "main_id", "image_id", "video_id", "floor_id", "vr_id", "checkin_id", "cover_image_id", "audio_description_video_id"]
    kind: ReferenceKind
    id: UUID | None
    revision: int = Field(ge=0)


class ImportReferenceSelection(DTO):
    expected_preview_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bindings: list[ImportReferenceBinding] = Field(min_length=1, max_length=500)


class ImportExportWarning(DTO):
    id: UUID
    code: str
    message: str
    fields: list[str]


class ImportExportManifest(DTO):
    kind: Kind
    campus_id: CampusId
    record_count: int
    row_count: int
    sha256: str
    filename: str
    warnings: list[ImportExportWarning]


class ImportIssue(DTO):
    rows: list[int]
    title: str
    action: Literal["create", "update", "skip", "error"]
    code: str
    message: str
    fields: list[str]


class ImportResult(DTO):
    rows: list[int]
    kind: Literal["point", "vr", "experience"]
    id: UUID


class ImportView(DTO):
    id: UUID
    kind: Kind
    filename: str
    state: Literal["uploading", "checked", "committed", "failed"]
    source_sha256: str
    columns: list[str]
    mapping: dict[str, str]
    fields: dict[str, str]
    row_count: int
    preview: list[ImportIssue]
    preview_sha256: str
    result: list[ImportResult]
    commit_operation_id: UUID | None = None
    error_code: str
    reference_bindings: list[ImportReferenceBinding] = Field(default_factory=list)


class ImportMapping(DTO):
    expected_preview_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    mapping: dict[str, str] = Field(max_length=64)


class ImportCommit(DTO):
    expected_preview_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    operation_id: UUID


def view(job):
    return ImportView(id=job.id, kind=job.kind, filename=job.filename, state=job.state,
        source_sha256=job.source_sha256, columns=job.columns, mapping=job.mapping,
        fields=COLUMNS[job.kind], row_count=sum(len(item["rows"]) for item in job.preview),
        preview=job.preview, preview_sha256=job.preview_sha256, result=job.result,
        commit_operation_id=job.commit_operation,
        error_code=job.error_code,
        reference_bindings=[{"rows": [row["row"]], **binding} for row in job.rows for binding in row.get("_references", {}).values()])


def owned(db, actor, job_id, *, lock=False):
    actor.require("points.edit")
    query = select(ImportJob).where(ImportJob.id == str(job_id), ImportJob.user_id == actor.user.id)
    if lock:
        query = query.with_for_update()
    job = db.scalar(query.execution_options(populate_existing=True))
    if not job or utc(job.expires_at) <= now_utc():
        raise DomainError("NOT_FOUND", "导入检查不存在或已过期，请重新上传", 404)
    for item in job.result:
        if item["kind"] == "point":
            require_point(db, actor.user, item["id"])
        elif item["kind"] == "vr":
            resources.load_resource(db, actor, item["id"])
        else:
            require_record(db, actor, item["id"])
    for row in job.rows:
        for binding in row.get("_references", {}).values():
            ref_item(db, actor, binding["kind"], binding["id"], None)
    return job


@router.get("/api/v1/admin/import-references", response_model=Envelope[list[ImportReference]], operation_id="listImportReferences", openapi_extra=META)
def references(request: Request, actor: Actor, db: DB, kind: ReferenceKind,
               campus_id: CampusId | None = None, point_id: UUID | None = None,
               q: str = Query("", max_length=120), referenceable: bool = True,
               purpose: Literal["general", "audio_description"] = "general",
               page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
    if purpose == "audio_description" and (kind != "video" or point_id is None or not referenceable):
        raise DomainError("IMPORT_REFERENCE_FIELD", "口述描述候选须明确同一地点并只读正式视频", 422)
    result = catalog(db, actor, request.app.state.settings, kind, campus_id, point_id, q, referenceable,
                     purpose=purpose)
    return envelope(request, result[(page - 1) * page_size:page * page_size], Pagination(page=page, page_size=page_size, total=len(result)))


@router.get("/api/v1/admin/import-exports/{kind}/preview", response_model=Envelope[ImportExportManifest], operation_id="checkImportExport", openapi_extra=META)
def export_preview(kind: Kind, request: Request, actor: Actor, db: DB, campus_id: CampusId,
                   ids: list[UUID] = Query(default=[], max_length=100)):
    _, manifest = build_export(db, actor, kind, campus_id, ids)
    return envelope(request, manifest)


@router.get("/api/v1/admin/import-exports/{kind}", operation_id="downloadImportExport", openapi_extra=META)
def export_csv(kind: Kind, actor: Actor, db: DB, campus_id: CampusId,
               ids: list[UUID] = Query(default=[], max_length=100),
               expected_sha256: str | None = Query(default=None, pattern=r"^[a-f0-9]{64}$")):
    body, manifest = build_export(db, actor, kind, campus_id, ids)
    if expected_sha256 and expected_sha256 != manifest["sha256"]:
        raise DomainError("REVISION_CONFLICT", "导出资料已经变化，请重新查看导出范围与提醒", 409)
    return Response(body, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{manifest["filename"]}"', "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff", "X-Export-SHA256": manifest["sha256"],
            "X-Export-Records": str(manifest["record_count"]), "X-Export-Rows": str(manifest["row_count"]),
            "X-Export-Warnings": str(len(manifest["warnings"]))})


@router.get("/api/v1/admin/import-templates/{kind}", operation_id="downloadImportTemplate", openapi_extra=META)
def download_template(kind: Kind, actor: Actor):
    actor.require("points.edit")
    return Response(template_csv(kind), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="twinnku-{kind}-template.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/api/v1/admin/import-jobs", response_model=Envelope[list[ImportView]], operation_id="findImportOperation", openapi_extra=META)
def find_operation(operation_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.edit")
    job = db.scalar(select(ImportJob).where(ImportJob.user_id == actor.user.id, ImportJob.operation_id == str(operation_id), ImportJob.expires_at > now_utc()))
    return envelope(request, [view(owned(db, actor, job.id))] if job else [])


@router.post("/api/v1/admin/import-jobs", response_model=Envelope[ImportView], operation_id="createImportJob", openapi_extra=WRITE, status_code=201)
async def upload(request: Request, actor: Actor, db: DB, kind: Kind, file_type: Literal["csv", "xlsx"],
                 operation_id: UUID, source_sha256: str = Query(pattern=r"^[a-f0-9]{64}$"),
                 filename: str = Query(min_length=1, max_length=200)):
    actor.require("points.edit")
    if any(c in filename for c in ("/", "\\", "\x00", "\r", "\n")) or not filename.lower().endswith("." + file_type):
        raise DomainError("IMPORT_FILENAME", "文件名和所选表格格式不一致", 422)
    # Global durable parser admission, across replicas. No production secrets are
    # passed to the parser subprocess and no business drafts exist at this point.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(782603142)"))
    db.scalar(select(StaffUserRecord).where(StaffUserRecord.id == actor.user.id).with_for_update())
    existing = db.scalar(select(ImportJob).where(ImportJob.user_id == actor.user.id, ImportJob.operation_id == str(operation_id)))
    if existing:
        if existing.source_sha256 != source_sha256 or existing.kind != kind or existing.filename != filename:
            raise DomainError("OPERATION_ID_REUSED", "同一操作编号不能用于不同表格", 409)
        if utc(existing.expires_at) <= now_utc():
            raise DomainError("IMPORT_OPERATION_EXPIRED", "原操作检查已过期，请使用新操作编号重新上传", 409)
        return envelope(request, view(owned(db, actor, existing.id)))
    live = ImportJob.expires_at > now_utc()
    # An expired lease is not proof that its process stopped. Only independent
    # GC, after taking the private folder lock, releases crashed parser slots.
    active = db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.state == "uploading")) or 0
    count = db.scalar(select(func.count()).select_from(ImportJob).where(ImportJob.user_id == actor.user.id, live)) or 0
    total = db.scalar(select(func.count()).select_from(ImportJob).where(live)) or 0
    owned_bytes = db.scalar(select(func.coalesce(func.sum(ImportJob.byte_size), 0)).where(ImportJob.user_id == actor.user.id, live))
    total_bytes = db.scalar(select(func.coalesce(func.sum(ImportJob.byte_size), 0)).where(live))
    if (active >= 2 or count >= 10 or total >= 100 or owned_bytes + MAX_BYTES > 64 * 1024 * 1024
            or total_bytes + MAX_BYTES > 256 * 1024 * 1024):
        raise DomainError("IMPORT_CAPACITY", "导入解析繁忙或24小时检查容量已满，请稍后再试", 429)
    job = ImportJob(id=str(uuid4()), user_id=actor.user.id, operation_id=str(operation_id),
        kind=kind, filename=filename, source_sha256=source_sha256,
        byte_size=MAX_BYTES,
        expires_at=now_utc() + timedelta(minutes=2))
    db.add(job)
    audit(db, actor.user, "import.started", details={"job_id": job.id, "operation_id": str(operation_id), "kind": kind, "source_sha256": source_sha256})
    db.commit()
    key = job.id
    try:
        with import_temporary(request.app.state.settings, job) as temporary:
            path = temporary / ("data." + file_type)
            digest, size = hashlib.sha256(), 0
            async with asyncio.timeout(30):
                with path.open("xb") as stream:
                    if os.name == "posix":
                        os.chmod(path, 0o600)
                    async for chunk in request.stream():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise DomainError("IMPORT_SIZE", "每批表格不能超过10MB", 413)
                        digest.update(chunk)
                        stream.write(chunk)
            if digest.hexdigest() != source_sha256:
                raise DomainError("IMPORT_FINGERPRINT", "文件内容与上传校验不一致，请重新选择文件", 422)
            parsed = await inspect_table(path, file_type, request.app.state.settings)
        job = owned(db, actor, key, lock=True)
        job.byte_size, job.columns, job.rows = size, parsed["columns"], parsed["rows"]
        job.mapping = suggested_mapping(kind, job.columns)
        if job.mapping:
            commands, report = commands_and_report(db, actor, job, request.app.state.settings)
        else:
            commands, report = [], [{"rows": [row["row"] for row in job.rows], "title": "选择资料列", "action": "error", "code": "IMPORT_MAPPING", "message": "请将表格列对应到模板字段后重新检查", "fields": []}]
        job.preview, job.preview_sha256 = report, preview_digest(job, commands, report)
        job.state, job.expires_at = "checked", now_utc() + timedelta(hours=24)
        audit(db, actor.user, "import.checked", details={"job_id": key, "kind": kind, "rows": len(job.rows)})
        db.commit()
        return envelope(request, view(job))
    except BaseException as exc:
        db.rollback()
        failed = db.get(ImportJob, key)
        if failed:
            failed.state, failed.rows = "failed", []
            failed.byte_size = 0
            failed.error_code = exc.code if isinstance(exc, DomainError) else "IMPORT_FAILED"
            db.commit()
        if isinstance(exc, TimeoutError):
            raise DomainError("IMPORT_TIMEOUT", "上传超时，请检查网络后重新上传", 408) from exc
        raise


@router.get("/api/v1/admin/import-jobs/{job_id}", response_model=Envelope[ImportView], operation_id="readImportJob", openapi_extra=META)
def read(job_id: UUID, request: Request, actor: Actor, db: DB):
    return envelope(request, view(owned(db, actor, job_id)))


@router.post("/api/v1/admin/import-jobs/{job_id}/mapping", response_model=Envelope[ImportView], operation_id="mapImportColumns", openapi_extra=WRITE)
def mapping(job_id: UUID, payload: ImportMapping, request: Request, actor: Actor, db: DB):
    job = owned(db, actor, job_id, lock=True)
    if job.state != "checked" or job.preview_sha256 != payload.expected_preview_sha256:
        raise DomainError("REVISION_CONFLICT", "检查结果已变化，请重新载入", 409)
    validate_mapping(job, payload.mapping)
    job.mapping = payload.mapping
    commands, report = commands_and_report(db, actor, job, request.app.state.settings)
    job.preview, job.preview_sha256 = report, preview_digest(job, commands, report)
    db.commit()
    return envelope(request, view(job))


@router.post("/api/v1/admin/import-jobs/{job_id}/references", response_model=Envelope[ImportView], operation_id="selectImportReferences", openapi_extra=WRITE)
def select_references(job_id: UUID, payload: ImportReferenceSelection, request: Request, actor: Actor, db: DB):
    job = owned(db, actor, job_id, lock=True)
    if job.state != "checked" or job.preview_sha256 != payload.expected_preview_sha256:
        raise DomainError("REVISION_CONFLICT", "检查结果已经变化，请重新载入后选择", 409)
    rows = copy.deepcopy(job.rows)
    indexed = {row["row"]: row for row in rows}
    targets = set()
    for choice in payload.bindings:
        binding = choice.model_dump(mode="json", exclude={"rows"})
        if len(set(choice.rows)) != len(choice.rows):
            raise DomainError("IMPORT_REFERENCE_ROWS", "关联选择行号不能重复", 422)
        if choice.id is not None:
            binding_values(db, actor, job.kind, binding, request.app.state.settings)
        for number in choice.rows:
            if number not in indexed or (number, choice.field) in targets:
                raise DomainError("IMPORT_REFERENCE_ROWS", "请选择本批已有且不重复的资料行", 422)
            targets.add((number, choice.field))
            references = indexed[number].setdefault("_references", {})
            if choice.id is None:
                references.pop(choice.field, None)  # Restore the original file cell.
            else:
                references[choice.field] = binding
    job.rows = rows
    commands, report = commands_and_report(db, actor, job, request.app.state.settings)
    job.preview, job.preview_sha256 = report, preview_digest(job, commands, report)
    audit(db, actor.user, "import.references", details={"job_id": job.id, "choices": len(targets)})
    db.commit()
    return envelope(request, view(job))


@router.post("/api/v1/admin/import-jobs/{job_id}/commit", response_model=Envelope[ImportView], operation_id="commitImportDrafts", openapi_extra=WRITE)
def commit(job_id: UUID, payload: ImportCommit, request: Request, actor: Actor, db: DB):
    # Lock all referenced assets from maintenance until the entire transaction is
    # committed. Domain saves defer commit and keep their own scope/audit checks.
    with storage_guard(request.app.state.settings):
        job = owned(db, actor, job_id, lock=True)
        if job.state == "committed":
            if job.commit_operation != str(payload.operation_id) or job.preview_sha256 != payload.expected_preview_sha256:
                raise DomainError("OPERATION_ID_REUSED", "此批次已经处理，请查看原操作结果", 409)
            return envelope(request, view(job))
        if job.state != "checked" or job.preview_sha256 != payload.expected_preview_sha256:
            raise DomainError("REVISION_CONFLICT", "请使用最新的导入检查结果", 409)
        commands, report = commands_and_report(db, actor, job, request.app.state.settings)
        if any(item["action"] == "error" for item in report) or preview_digest(job, commands, report) != job.preview_sha256:
            raise DomainError("IMPORT_RECHECK_REQUIRED", "资料、权限或版本已变化，请重新检查；本批没有写入业务资料", 409)
        result = []
        try:
            for command in commands:
                key, data = command["id"], command["payload"]
                if command["skip"]:
                    target = key
                elif command["kind"] == "point":
                    entity = points.save_draft(db, actor, (PointDraftUpdate if key else PointDraftInput).model_validate(data), key)
                    target = entity.id
                elif command["kind"] == "vr":
                    response = resources._save_resource(command["point_id"], key, ResourceDraftSave.model_validate(data), request, actor, db, commit=False)
                    target = str(response["data"]["id"])
                else:
                    # The outer guard remains held through the final commit.
                    response = _save_experience(key, ExperienceSave.model_validate(data), request, actor, db, commit=False)
                    target = str(response["data"]["id"])
                result.append({"rows": command["rows"], "kind": command["kind"], "id": target})
            job.state, job.result, job.commit_operation = "committed", result, str(payload.operation_id)
            job.rows = []  # Business drafts/history now own the content; discard private input.
            audit(db, actor.user, "import.committed", details={"job_id": job.id, "kind": job.kind, "records": len(result)})
            db.commit()
        except BaseException:
            db.rollback()
            raise
        return envelope(request, view(job))


@router.get("/api/v1/admin/import-jobs/{job_id}/report.csv", operation_id="exportImportReport", openapi_extra=META)
def report_csv(job_id: UUID, actor: Actor, db: DB):
    job = owned(db, actor, job_id)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["行号", "资料名称", "操作", "问题代码", "说明", "字段"])
    for item in job.preview:
        writer.writerow([safe_csv_cell(value) for value in (",".join(map(str, item["rows"])), item["title"], item["action"], item["code"], item["message"], ",".join(item["fields"]))])
    return Response(output.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="import-report.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
