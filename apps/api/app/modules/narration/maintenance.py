"""Audited, reference-aware narration expiry and actual disk accounting.

Dry-run is the default. Applying a reviewed digest requires the exclusive storage
lock used by drafts, workers and backups. Metadata is retired before unlinking;
a crash leaves charged, inaccessible orphan bytes, never a missing referenced file.
"""

import argparse
import json
import re
import stat
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select

from app.content_history_models import ExperienceOperationRecord, ExperienceVersionRecord
from app.core.errors import DomainError
from app.models import ExperienceRecord, now_utc
from app.modules.admin.security import audit, utc
from app.modules.narration.service import canonical, sha
from app.narration_models import NarrationAsset, NarrationJob

RETIRED = "NARRATION_RETIRED"
CHUNK_NAME = re.compile(r"[a-f0-9]{64}\.wav")
TEMP_NAME = re.compile(r"\.[a-f0-9-]{36}\.tmp")


def inventory(settings):
    """Account for every byte, including files left by a failed DB commit.

    Refuse symlinks, devices, unknown names and nesting, rather than following or
    deleting them. Runtime needs only this metadata scan, never audio contents.
    """
    root = settings.floor_assets_dir.resolve() / ".narration"
    if root.is_symlink():
        raise DomainError("NARRATION_STORAGE_INVALID", "讲解存储需维护检查", 503)
    if not root.exists():
        return {}
    if not root.is_dir():
        raise DomainError("NARRATION_STORAGE_INVALID", "讲解存储需维护检查", 503)
    files = {}
    for directory in root.iterdir():
        try:
            valid_id = str(UUID(directory.name)) == directory.name
        except ValueError:
            valid_id = False
        if not valid_id or not stat.S_ISDIR(directory.lstat().st_mode):
            raise DomainError("NARRATION_STORAGE_INVALID", "讲解存储需维护检查", 503)
        for path in directory.iterdir():
            meta = path.lstat()
            if (not stat.S_ISREG(meta.st_mode)
                    or not (CHUNK_NAME.fullmatch(path.name) or TEMP_NAME.fullmatch(path.name))):
                raise DomainError("NARRATION_STORAGE_INVALID", "讲解存储需维护检查", 503)
            files[directory.name + "/" + path.name] = {
                "size_bytes": meta.st_size, "mtime_ns": meta.st_mtime_ns,
            }
    return files


def ensure_capacity(settings, additional_bytes, *, replacing=None):
    files = inventory(settings)
    used = sum(item["size_bytes"] for item in files.values())
    replaced = files.get(replacing, {}).get("size_bytes", 0) if replacing else 0
    if used - replaced + additional_bytes > settings.narration_max_storage_bytes:
        raise DomainError("NARRATION_STORAGE_FULL", "讲解存储已达容量上限，请联系管理员整理未引用音频", 409)
    return used


def storage_status(settings):
    """Global runtime operators see totals and actionable state, never file paths."""
    result = {"maximum_bytes": settings.narration_max_storage_bytes,
              "unadopted_retention_days": settings.narration_unadopted_days}
    try:
        used = sum(item["size_bytes"] for item in inventory(settings).values())
    except (DomainError, OSError):
        return {**result, "used_bytes": None, "state": "unavailable"}
    maximum = settings.narration_max_storage_bytes
    state = "full" if used >= maximum else "warning" if used * 5 >= maximum * 4 else "ok"
    return {**result, "used_bytes": used, "state": state}


def asset_refs(value):
    refs = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "narration_asset_id" and isinstance(item, str):
                refs.add(item)
            else:
                refs.update(asset_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.update(asset_refs(item))
    return refs


def protected_assets(db):
    refs = set()
    for draft, published in db.execute(select(ExperienceRecord.draft, ExperienceRecord.published)):
        refs.update(asset_refs(draft))
        refs.update(asset_refs(published))
    for draft, published in db.execute(select(ExperienceVersionRecord.content,
                                              ExperienceVersionRecord.published_content)):
        refs.update(asset_refs(draft))
        refs.update(asset_refs(published))
    # A retained idempotency receipt may still return its saved draft. Keep that
    # exact adoption usable for as long as the receipt itself is retained.
    for result in db.scalars(select(ExperienceOperationRecord.result)):
        refs.update(asset_refs(result))
    return refs


def maintenance_plan(db, settings, *, now=None):
    now = now or now_utc()
    retention = now - timedelta(days=settings.narration_unadopted_days)
    orphan_cutoff_ns = int((now - timedelta(days=settings.upload_orphan_days)).timestamp() * 1e9)
    files = inventory(settings)
    protected = protected_assets(db)
    jobs = {row.id: row for row in db.scalars(select(NarrationJob))}
    assets = {row.id: row for row in db.scalars(select(NarrationAsset))}
    retired = []
    for job in jobs.values():
        if (job.id in protected or job.last_error == RETIRED
                or job.state not in {"ready", "failed", "cancelled"}
                or utc(job.updated_at) >= retention):
            continue
        asset = assets.get(job.id)
        if asset and utc(asset.created_at) >= retention:
            continue
        if any(meta["mtime_ns"] >= orphan_cutoff_ns for key, meta in files.items()
               if key.startswith(job.id + "/")):
            continue
        retired.append({"id": job.id, "state": job.state, "fence": job.lease_version,
                        "fingerprint": job.fingerprint, "updated_at": utc(job.updated_at).isoformat()})
    retired_ids = {job["id"] for job in retired}
    removable = []
    for key, meta in files.items():
        asset_id, name = key.split("/")
        job, asset = jobs.get(asset_id), assets.get(asset_id)
        if job and job.state in {"queued", "running", "unknown", "paused"}:
            continue  # Never discard work that can still be running/reconciled.
        referenced_names = {
            chunk["sha256"] + ".wav"
            for chunk in [*(asset.chunks if asset else []), *(job.completed_chunks if job else [])]
        }
        if asset_id not in retired_ids and (asset_id in protected or name in referenced_names):
            continue
        if meta["mtime_ns"] < orphan_cutoff_ns:
            removable.append({"key": key, **meta})
    plan = {"retire_jobs": sorted(retired, key=lambda item: item["id"]),
            "remove_files": sorted(removable, key=lambda item: item["key"]),
            "protected_assets": sorted(protected),
            "used_bytes": sum(meta["size_bytes"] for meta in files.values()),
            "maximum_bytes": settings.narration_max_storage_bytes,
            "retention_days": settings.narration_unadopted_days}
    plan["sha256"] = sha(canonical(plan))
    return plan


def apply_gc(db, settings, *, expected_sha, reason):
    """Caller holds exclusive storage_guard through commit and physical deletion."""
    from app.modules.upload_gc import maintenance_actor

    if not reason.strip():
        raise ValueError("A maintenance reason is required")
    plan = maintenance_plan(db, settings)
    if plan["sha256"] != expected_sha:
        raise ValueError("Narration maintenance plan changed; inspect a new dry-run")
    # Retry/cancel serialize on the same job row, including requests that began
    # before this exclusive filesystem lock. Refresh after locking so a newly
    # queued task can never be retired from a stale ORM identity-map snapshot.
    ids = [item["id"] for item in plan["retire_jobs"]]
    if ids:
        list(db.scalars(select(NarrationJob).where(NarrationJob.id.in_(ids))
                        .order_by(NarrationJob.id).with_for_update().execution_options(populate_existing=True)))
        plan = maintenance_plan(db, settings)
        if plan["sha256"] != expected_sha:
            raise ValueError("Narration maintenance plan changed; inspect a new dry-run")
    try:
        for item in plan["retire_jobs"]:
            asset = db.get(NarrationAsset, item["id"])
            if asset:
                db.delete(asset)
            job = db.get(NarrationJob, item["id"])
            job.completed_chunks = []
            job.state, job.last_error, job.lease_until = "failed", RETIRED, None
            job.lease_version += 1
            job.updated_at = now_utc()
        audit(db, maintenance_actor(db), "narration.gc_authorized", note=reason.strip(),
              details={"plan_sha256": expected_sha,
                       "retired_jobs": [item["id"] for item in plan["retire_jobs"]],
                       "file_count": len(plan["remove_files"])})
        db.commit()
    except BaseException:
        db.rollback()
        raise  # No filesystem mutation has occurred.
    root = settings.floor_assets_dir.resolve() / ".narration"
    current = inventory(settings)  # Recheck symlinks before any physical removal.
    for item in plan["remove_files"]:
        if current.get(item["key"]) != {"size_bytes": item["size_bytes"], "mtime_ns": item["mtime_ns"]}:
            raise ValueError("Narration file changed; stop and inspect maintenance")
        path = root / item["key"]
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Narration path escapes storage")
        path.unlink()
    audit(db, maintenance_actor(db), "narration.gc_completed", note=reason.strip(),
          details={"plan_sha256": expected_sha, "file_count": len(plan["remove_files"]),
                   "removed_bytes": sum(item["size_bytes"] for item in plan["remove_files"])})
    db.commit()
    return plan


def main():
    from app.core.config import get_settings
    from app.database import SessionLocal
    from app.modules.uploads import storage_guard

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha")
    parser.add_argument("--reason")
    args = parser.parse_args()
    settings = get_settings()
    with storage_guard(settings, exclusive=True), SessionLocal() as db:
        result = maintenance_plan(db, settings)
        if args.apply:
            result = apply_gc(db, settings, expected_sha=args.expected_sha, reason=args.reason or "")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
