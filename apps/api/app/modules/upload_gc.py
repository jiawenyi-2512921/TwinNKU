"""Reference-aware upload maintenance. Run with the API container's Python 3.12.

Default is dry-run. Apply needs the exact dry-run SHA and a maintenance reason.
All files referenced by any retained version or publication/edit audit are kept.
We never delete base maps, floor revisions, symlinks, or unknown asset directories.
"""

import argparse
import hashlib
import json
import secrets
import shutil
from datetime import timedelta

from sqlalchemy import select, update

from app.core.config import get_settings
from app.database import SessionLocal
from app.models import (
    AdminAuditRecord,
    ExperienceRecord,
    ExperienceUploadRecord,
    FloorRecord,
    FloorUploadRecord,
    PointRecord,
    StaffUserRecord,
    UploadBudgetRecord,
    UploadReservationRecord,
    now_utc,
)
from app.modules.admin.security import audit, hash_password, utc
from app.modules.uploads import ensure_budget, release_reservation, retain_orphan, storage_guard


def upload_refs(value):
    refs = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"upload_id", "caption_upload_id"} and isinstance(item, str):
                refs.add(item)
            else:
                refs.update(upload_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.update(upload_refs(item))
    return refs


def protected_uploads(db):
    from app.content_control_models import ContentVersionRecord
    from app.content_history_models import ExperienceVersionRecord
    from app.models import ResourceChangeRecord

    refs = set()
    for payload in db.scalars(select(ResourceChangeRecord.payload)):
        refs.update(upload_refs(payload))
    for row in db.scalars(select(ExperienceRecord)):
        refs.update(upload_refs(row.draft))
        refs.update(upload_refs(row.published))
    # Retained immutable checkpoints are recovery roots even when the current
    # editable/public record has moved to another file. Never infer reachability
    # from only the latest draft or the older audit format.
    historical_hashes = set()
    for kind, payload in db.execute(select(ContentVersionRecord.entity_type, ContentVersionRecord.content)):
        refs.update(upload_refs(payload))
        if kind == "floor":
            for side in (payload.get("draft"), payload.get("published")):
                if isinstance(side, dict):
                    historical_hashes.update(image.get("sha256") for image in side.get("images", [])
                                             if isinstance(image, dict))
    for content, published in db.execute(select(ExperienceVersionRecord.content,
                                                ExperienceVersionRecord.published_content)):
        refs.update(upload_refs(content))
        refs.update(upload_refs(published))
    # Upload creation itself is not a reference. Retained edit/publication audit
    # snapshots protect old versions even after the mutable draft is replaced.
    for action, details in db.execute(select(AdminAuditRecord.action, AdminAuditRecord.details)):
        if action not in {"resource.image_uploaded", "experience.uploaded", "upload.gc"}:
            refs.update(upload_refs(details))
    published_hashes = {
        image.get("sha256") for floor in db.scalars(select(FloorRecord)) for image in floor.images
    }
    for upload in db.scalars(select(FloorUploadRecord)):
        if upload.image.get("sha256") in published_hashes | historical_hashes:
            refs.add(upload.id)
    return refs


def owned_folder(settings, kind, key):
    root = settings.floor_assets_dir.resolve()
    parent = root / (".uploads" if kind == "floor" else ".experience-media")
    folder = parent / key
    if (kind not in {"floor", "media"} or parent.is_symlink() or folder.is_symlink()
            or folder.resolve().parent != parent.resolve()
            or not folder.resolve().is_relative_to(root)):
        raise ValueError("Upload folder escapes owned storage")
    if folder.exists() and any(path.is_symlink() for path in folder.rglob("*")):
        raise ValueError("Symlink in owned upload; manual investigation required")
    return folder


def maintenance_plan(db, settings, *, now=None):
    now = now or now_utc()
    cutoff = now - timedelta(days=max(7, settings.upload_orphan_days))
    protected = protected_uploads(db)
    points = {p.id: p for p in db.scalars(select(PointRecord))}
    candidates, known = [], set()
    for model, kind in ((FloorUploadRecord, "floor"), (ExperienceUploadRecord, "media")):
        for row in db.scalars(select(model)):
            known.add((kind, row.id))
            if row.id in protected or utc(row.created_at) >= cutoff:
                continue
            folder = owned_folder(settings, kind, row.id)
            size = row.image["size_bytes"] if kind == "floor" else row.size_bytes
            candidates.append(
                {
                    "kind": kind,
                    "id": row.id,
                    "user_id": row.uploaded_by,
                    "campus_id": points[row.point_id].campus_id,
                    "size_bytes": size,
                    "folder_exists": folder.exists(),
                }
            )
    expired = []
    for row in db.scalars(
        select(UploadReservationRecord).where(UploadReservationRecord.state == "reserved")
    ):
        if utc(row.expires_at) < now:
            expired.append(row.id)
    # Failed/crashed receipt folders with no DB upload are removable only after
    # seven days. Unknown folders have no reliable owner/budget; leave them alone.
    abandoned = []
    for row in db.scalars(
        select(UploadReservationRecord).where(UploadReservationRecord.kind.in_(["floor", "media"]))
    ):
        if (
            (row.kind, row.upload_id) in known
            or row.upload_id in protected
            or utc(row.created_at) >= cutoff
        ):
            continue
        if row.state in {"failed", "orphaned"} or (
            row.state == "reserved" and utc(row.expires_at) < now
        ):
            folder = owned_folder(settings, row.kind, row.upload_id)
            if folder.exists() or row.state == "orphaned":
                abandoned.append({"kind": row.kind, "id": row.upload_id})
    plan = {
        "uploads": sorted(candidates, key=lambda x: (x["kind"], x["id"])),
        "expired_reservations": sorted(expired),
        "abandoned": sorted(abandoned, key=lambda x: (x["kind"], x["id"])),
        "quarantined": sorted(
            row.id
            for row in db.scalars(
                select(UploadReservationRecord).where(
                    UploadReservationRecord.state == "quarantined"
                )
            )
        ),
    }
    plan["sha256"] = hashlib.sha256(
        json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return plan


def maintenance_actor(db):
    row = db.scalar(
        select(StaffUserRecord).where(StaffUserRecord.username == "maintenance.upload-gc")
    )
    if not row:
        row = StaffUserRecord(
            username="maintenance.upload-gc",
            display_name="资料回收维护（不可登录）",
            role="viewer",
            campus_ids=[],
            point_ids=[],
            is_active=False,
            must_change_password=True,
            password_hash=hash_password(secrets.token_urlsafe(48)),
        )
        db.add(row)
        db.flush()
    if row.is_active or row.role != "viewer" or row.campus_ids or row.point_ids:
        raise ValueError("Maintenance identity must remain disabled and without scope")
    return row


def apply_gc(db, settings, *, expected_sha, reason):
    """Caller must hold exclusive storage_guard. Rename before commit, restore on error.

    Quarantine bytes stay charged until physical deletion is complete. A crash
    can only leave an overcharge, resumed by the next reviewed maintenance plan.
    """
    if not reason.strip():
        raise ValueError("A maintenance reason is required")
    plan = maintenance_plan(db, settings)
    if plan["sha256"] != expected_sha:
        raise ValueError("Maintenance plan changed; run dry-run again")
    ensure_budget(db, "global")
    db.execute(
        update(UploadBudgetRecord)
        .where(UploadBudgetRecord.scope == "global")
        .values(active_uploads=UploadBudgetRecord.active_uploads)
    )
    moved = []
    quarantine = settings.floor_assets_dir.resolve() / ".gc-quarantine"
    quarantine.mkdir(exist_ok=True)
    if quarantine.is_symlink():
        raise ValueError("Invalid maintenance quarantine")
    try:
        for key in plan["expired_reservations"]:
            row = db.get(UploadReservationRecord, key)
            release_reservation(db, row)
            folder = owned_folder(settings, row.kind, row.upload_id)
            actual = (
                sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
                if folder.exists()
                else 0
            )
            retain_orphan(db, row, actual)
        for item in plan["uploads"] + plan["abandoned"]:
            folder = owned_folder(settings, item["kind"], item["id"])
            target = quarantine / (item["kind"] + "-" + item["id"])
            if target.exists():
                raise ValueError("Quarantine already exists; investigate previous maintenance")
            if folder.exists():
                folder.rename(target)
                moved.append((folder, target))
            reservation = db.scalar(
                select(UploadReservationRecord).where(
                    UploadReservationRecord.kind == item["kind"],
                    UploadReservationRecord.upload_id == item["id"],
                )
            )
            if "size_bytes" in item:
                model = FloorUploadRecord if item["kind"] == "floor" else ExperienceUploadRecord
                db.delete(db.get(model, item["id"]))
                if not reservation or reservation.state != "complete":
                    raise ValueError("Budget reservation differs; investigate before GC")
                reservation.state = "quarantined"
            elif reservation and reservation.state == "orphaned":
                reservation.state = "quarantined"
            elif reservation:
                db.delete(reservation)
        audit(
            db,
            maintenance_actor(db),
            "upload.gc",
            note=reason.strip(),
            details={
                "plan_sha256": expected_sha,
                "removed": [
                    {"kind": i["kind"], "id": i["id"]} for i in plan["uploads"] + plan["abandoned"]
                ],
                "expired_reservations": plan["expired_reservations"],
            },
        )
        db.commit()
    except BaseException:
        db.rollback()
        for source, target in reversed(moved):
            target.rename(source)
        raise
    # The first commit removed only unreferenced rows; charges still protect all
    # quarantine bytes. A failure here is safely resumable, without restoring rows.
    for _, target in moved:
        if target.exists():
            shutil.rmtree(target)
    for row in list(
        db.scalars(
            select(UploadReservationRecord).where(UploadReservationRecord.state == "quarantined")
        )
    ):
        if row.upload_id in protected_uploads(db):
            raise ValueError("Quarantined file unexpectedly referenced; stop maintenance")
        target = quarantine / (row.kind + "-" + row.upload_id)
        if target.is_symlink() or (
            target.exists() and any(p.is_symlink() for p in target.rglob("*"))
        ):
            raise ValueError("Invalid quarantine path")
        if target.exists():
            shutil.rmtree(target)
        for scope in ("actor:" + row.user_id, "campus:" + row.campus_id):
            ensure_budget(db, scope)
            changed = db.execute(
                update(UploadBudgetRecord)
                .where(
                    UploadBudgetRecord.scope == scope,
                    UploadBudgetRecord.used_bytes >= row.size_bytes,
                )
                .values(used_bytes=UploadBudgetRecord.used_bytes - row.size_bytes)
            ).rowcount
            if not changed:
                db.rollback()
                raise ValueError("Budget accounting differs; reconcile before GC")
        db.delete(row)
    db.commit()
    return plan


def reconcile_plan(db, settings):
    """Recount actual known campus floor history plus uploads; never remove bytes."""
    root = settings.floor_assets_dir.resolve()
    points = {p.id: p.campus_id for p in db.scalars(select(PointRecord))}
    usage, known = {}, {".uploads", ".experience-media", ".maintenance.lock"}
    for model, kind in ((FloorUploadRecord, "floor"), (ExperienceUploadRecord, "media")):
        for row in db.scalars(select(model)):
            folder = owned_folder(settings, kind, row.id)
            size = (
                sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
                if folder.exists()
                else 0
            )
            # Missing originals remain charged until the audited GC removes the DB row.
            size = max(size, row.image["size_bytes"] if kind == "floor" else row.size_bytes)
            for scope in ("actor:" + row.uploaded_by, "campus:" + points[row.point_id]):
                usage[scope] = usage.get(scope, 0) + size
    for floor in db.scalars(select(FloorRecord)):
        known.add(floor.id)
        folder = root / floor.id
        if folder.is_symlink() or (
            folder.exists() and any(p.is_symlink() for p in folder.rglob("*"))
        ):
            raise ValueError("Symlink in floor history")
        size = (
            sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
            if folder.exists()
            else 0
        )
        scope = "campus:" + points[floor.point_id]
        usage[scope] = usage.get(scope, 0) + size
    for row in db.scalars(
        select(UploadReservationRecord).where(
            UploadReservationRecord.kind == "floor-copy",
            UploadReservationRecord.state == "complete",
        )
    ):
        scope = "actor:" + row.user_id
        usage[scope] = usage.get(scope, 0) + row.size_bytes
    for row in db.scalars(
        select(UploadReservationRecord).where(
            UploadReservationRecord.state.in_(["orphaned", "quarantined"])
        )
    ):
        for scope in ("actor:" + row.user_id, "campus:" + row.campus_id):
            usage[scope] = usage.get(scope, 0) + row.size_bytes
    unknown = [p.name for p in root.iterdir() if p.name not in known] if root.exists() else []
    for kind, parent in (("floor", ".uploads"), ("media", ".experience-media")):
        tracked = set(
            db.scalars(
                select(UploadReservationRecord.upload_id).where(
                    UploadReservationRecord.kind == kind
                )
            )
        )
        folder = root / parent
        if folder.is_symlink():
            raise ValueError("Symlink in uploaded storage")
        if folder.exists():
            unknown.extend(parent + "/" + p.name for p in folder.iterdir() if p.name not in tracked)
    unknown.sort()
    result = {"used_bytes": usage, "unaccounted_entries": unknown}
    result["sha256"] = hashlib.sha256(
        json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["gc", "reconcile"])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-sha")
    parser.add_argument("--reason")
    args = parser.parse_args()
    settings = get_settings()
    with storage_guard(settings, exclusive=True), SessionLocal() as db:
        if args.operation == "gc":
            result = maintenance_plan(db, settings)
            if args.apply:
                result = apply_gc(
                    db, settings, expected_sha=args.expected_sha, reason=args.reason or ""
                )
        else:
            result = reconcile_plan(db, settings)
            if args.apply:
                if args.expected_sha != result["sha256"] or not (args.reason or "").strip():
                    raise SystemExit("Exact dry-run SHA and maintenance reason are required")
                for scope in set(db.scalars(select(UploadBudgetRecord.scope))) | set(
                    result["used_bytes"]
                ):
                    if scope == "global":
                        continue
                    ensure_budget(db, scope)
                    db.execute(
                        update(UploadBudgetRecord)
                        .where(UploadBudgetRecord.scope == scope)
                        .values(used_bytes=result["used_bytes"].get(scope, 0))
                    )
                audit(
                    db,
                    maintenance_actor(db),
                    "upload.reconcile",
                    note=args.reason,
                    details={
                        "plan_sha256": result["sha256"],
                        "unaccounted_entries": result["unaccounted_entries"],
                    },
                )
                db.commit()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
