"""Independent conservative import maintenance; dry-run by default.

No business drafts, assets or histories are removed. Apply requires the reviewed
plan SHA; receipts retain expired job attribution before its row is discarded.
Unknown legacy table-* folders and unmarked uploading records are preserved.
"""

import argparse
import json
import os
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select

from app.core.errors import DomainError
from app.import_models import ImportJob
from app.models import AdminAuditRecord, now_utc
from app.modules.admin.security import utc
from app.modules.imports.tempfiles import (
    active_lock,
    flat_files,
    owned_folder,
    read_marker,
    remove_owned,
    temporary_root,
)
from app.modules.narration.service import canonical, sha
from app.modules.uploads import storage_guard

GRACE = timedelta(hours=1)
MAX_SCAN = 1000


def expired_marker(marker, cutoff):
    created, expires = utc(datetime.fromisoformat(marker["created_at"])), utc(datetime.fromisoformat(marker["expires_at"]))
    return created <= expires <= cutoff


def folder_candidate(settings, folder, cutoff):
    key = str(UUID(folder.name.removeprefix("job-")))
    if folder != owned_folder(settings, key) or not folder.is_dir():
        raise ValueError("unknown folder")
    with active_lock(folder):
        marker = read_marker(folder)
        if not expired_marker(marker, cutoff):
            return None
        return {"id": key, "marker_sha256": sha(canonical(marker)),
            "files": sorted([{"name": path.name, "size": path.stat().st_size} for path in flat_files(folder)], key=lambda item: item["name"])}


def plan(db, settings, *, now=None):
    cutoff = (now or now_utc()) - GRACE
    result = {"jobs": [], "folders": [], "kept_active": 0, "kept_unknown": 0}
    parent = temporary_root(settings)
    children = list(parent.iterdir())
    if len(children) > MAX_SCAN:
        raise DomainError("IMPORT_GC_CAPACITY", "临时目录数量超限，需人工维护；没有删除文件", 503)
    candidates = {}
    for folder in children:
        try:
            if not folder.name.startswith("job-") or folder.is_symlink():
                raise ValueError("unknown folder")
            item = folder_candidate(settings, folder, cutoff)
            if item:
                candidates[item["id"]] = item
        except DomainError as exc:
            result["kept_active" if exc.code == "IMPORT_ACTIVE" else "kept_unknown"] += 1
        except (OSError, ValueError, TypeError, KeyError):
            result["kept_unknown"] += 1
    expired = list(db.scalars(select(ImportJob).where(ImportJob.expires_at <= cutoff).order_by(ImportJob.id).limit(MAX_SCAN + 1)))
    if len(expired) > MAX_SCAN:
        raise DomainError("IMPORT_GC_CAPACITY", "过期任务数量超限，需人工分批维护；没有删除记录", 503)
    for job in expired:
        folder = owned_folder(settings, job.id)
        if folder.exists() and job.id not in candidates:
            continue
        if not folder.exists() and job.state == "uploading":
            started = db.scalar(select(AdminAuditRecord.id).where(AdminAuditRecord.action == "import.started", AdminAuditRecord.details["job_id"].as_string() == job.id).limit(1))
            if not started:
                result["kept_unknown"] += 1
                continue
        result["jobs"].append({"id": job.id, "user_id": job.user_id, "operation_id": job.operation_id,
            "kind": job.kind, "state": job.state, "source_sha256": job.source_sha256,
            "created_at": utc(job.created_at).isoformat(), "expires_at": utc(job.expires_at).isoformat(),
            "commit_operation_id": job.commit_operation,
            "result": [{"rows": item["rows"], "kind": item["kind"], "id": item["id"]} for item in job.result]})
    for key, candidate in candidates.items():
        job = db.get(ImportJob, key)
        if job and utc(job.expires_at) > cutoff:
            continue
        result["folders"].append(candidate)
    result["folders"].sort(key=lambda item: item["id"])
    result["sha256"] = sha(canonical({"jobs": result["jobs"], "folders": result["folders"]}))
    return result


def write_receipt(settings, key, value):
    base = settings.floor_assets_dir.resolve()
    parent = base / ".import-gc-receipts"
    if parent.is_symlink() or parent.resolve().parent != base:
        raise DomainError("IMPORT_GC_STORAGE", "维护回执目录不可用", 503)
    parent.mkdir(mode=0o700, exist_ok=True)
    target, temporary = parent / (key + ".json"), parent / (key + ".tmp")
    if target.is_symlink() or temporary.exists():
        raise DomainError("IMPORT_GC_STORAGE", "维护回执不可用", 503)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    return target


def apply(db, settings, expected_sha256, reason, *, now=None):
    if not reason.strip() or len(reason) > 500:
        raise DomainError("IMPORT_GC_REASON", "维护需填写1至500字的原因", 422)
    with storage_guard(settings, exclusive=True):
        current = plan(db, settings, now=now)
        if current["sha256"] != expected_sha256:
            raise DomainError("REVISION_CONFLICT", "维护计划已经变化，请重新检查；没有删除文件", 409)
        key = str(uuid4())
        receipt = {"format": "twinnku-import-gc-v1", "id": key, "created_at": (now or now_utc()).isoformat(),
            "reason": reason, "plan": current, "status": "started", "removed_folders": [], "removed_jobs": []}
        path = write_receipt(settings, key, receipt)
        try:
            for item in current["folders"]:
                folder = owned_folder(settings, item["id"])
                # Recheck the active lease. Windows needs it closed before
                # unlinking; UUID folders are never reused, and the global
                # maintenance lock excludes another collector.
                with active_lock(folder):
                    marker = read_marker(folder)
                    if sha(canonical(marker)) != item["marker_sha256"]:
                        raise DomainError("REVISION_CONFLICT", "临时文件归属已经变化", 409)
                remove_owned(settings, item["id"])
                receipt["removed_folders"].append(item["id"])
            for item in current["jobs"]:
                job = db.scalar(select(ImportJob).where(ImportJob.id == item["id"]).with_for_update())
                if not job or job.state != item["state"] or utc(job.expires_at).isoformat() != item["expires_at"]:
                    raise DomainError("REVISION_CONFLICT", "过期任务状态已改变", 409)
                db.delete(job)
                receipt["removed_jobs"].append(job.id)
            db.commit()
            receipt["status"] = "passed"
        except BaseException:
            db.rollback()
            receipt["status"] = "partial"
            receipt["removed_jobs"] = []
            write_receipt(settings, key, receipt)
            raise
        write_receipt(settings, key, receipt)
        return {"status": receipt["status"], "sha256": sha(path.read_bytes()), "receipt": str(path),
            "removed_folders": len(receipt["removed_folders"]), "removed_jobs": len(receipt["removed_jobs"])}


def main():
    from app.core.config import get_settings
    from app.database import SessionLocal

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--reason", default="")
    args = parser.parse_args()
    settings = get_settings()
    try:
        with SessionLocal() as db:
            if args.apply:
                result = apply(db, settings, args.expected_sha256, args.reason)
            else:
                candidate = plan(db, settings)
                result = {"sha256": candidate["sha256"], "expired_jobs": len(candidate["jobs"]), "owned_folders": len(candidate["folders"]),
                    "kept_active": candidate["kept_active"], "kept_unknown": candidate["kept_unknown"]}
            print(json.dumps(result, sort_keys=True))
            return 0
    except Exception as exc:
        # A database/OS exception is diagnostic data, never a safe log message.
        print(json.dumps({"status": "failed", "code": exc.code if isinstance(exc, DomainError) else "IMPORT_GC_FAILED", "error_class": type(exc).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
