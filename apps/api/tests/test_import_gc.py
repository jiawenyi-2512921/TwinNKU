"""Active locks, owner markers, bounded cleanup and durable crash attribution."""

import json
import os
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_admin import login, seed_staff
from test_import_jobs import upload, vr
from test_resources import make_resource_point

from app.core.errors import DomainError
from app.import_models import ImportJob
from app.models import AdminAuditRecord, now_utc
from app.modules.imports import gc
from app.modules.imports.tempfiles import (
    MARKER,
    active_lock,
    import_temporary,
    owned_folder,
    temporary_root,
)


@pytest.fixture
def maintenance(client, db, tmp_path):
    users, _ = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "private-imports"
    login(client)
    return users, client.app.state.settings


def job(db, user, state="uploading", started=True):
    now = now_utc()
    item = ImportJob(id=str(uuid4()), user_id=user.id, operation_id=str(uuid4()), kind="vr", state=state,
        filename="original.csv", source_sha256="a" * 64, byte_size=42,
        created_at=now - timedelta(hours=3), expires_at=now - timedelta(hours=2))
    db.add(item)
    if started:
        db.add(AdminAuditRecord(actor_id=user.id, actor_name=user.display_name, action="import.started", details={"job_id": item.id, "source_sha256": item.source_sha256}))
    db.commit()
    return item


def crashed_folder(settings, item):
    folder = owned_folder(settings, item.id)
    folder.mkdir(mode=0o700)
    with active_lock(folder, create=True):
        (folder / "owner.json").write_text(json.dumps({"format": MARKER, "job_id": item.id, "created_at": item.created_at.isoformat(), "expires_at": item.expires_at.isoformat()}), encoding="utf-8")
        (folder / "data.csv").write_bytes(b"private-original-body-never-in-receipt")
    return folder


def test_expired_active_upload_is_kept_until_its_process_lock_ends(client, db, maintenance):
    users, settings = maintenance
    item = job(db, users["editor"])
    folder = crashed_folder(settings, item)
    with active_lock(folder):
        candidate = gc.plan(db, settings)
        assert candidate["kept_active"] == 1 and candidate["jobs"] == candidate["folders"] == []
        gc.apply(db, settings, candidate["sha256"], "isolated test")
        assert folder.exists() and db.get(ImportJob, item.id)
    candidate = gc.plan(db, settings)
    assert len(candidate["folders"]) == len(candidate["jobs"]) == 1
    result = gc.apply(db, settings, candidate["sha256"], "expired isolated original")
    assert result["status"] == "passed" and not folder.exists()
    assert db.get(ImportJob, item.id) is None
    receipt = json.loads(open(result["receipt"], encoding="utf-8").read())
    assert receipt["plan"]["jobs"][0]["user_id"] == users["editor"].id
    assert receipt["plan"]["jobs"][0]["source_sha256"] == "a" * 64
    assert "private-original-body-never-in-receipt" not in str(receipt)
    assert db.scalar(select(AdminAuditRecord).where(AdminAuditRecord.action == "import.started")) is not None


def test_unknown_legacy_unmarked_nested_and_recent_paths_are_never_removed(client, db, maintenance):
    users, settings = maintenance
    parent = temporary_root(settings)
    legacy = parent / "table-old-random"
    legacy.mkdir()
    (legacy / "data.csv").write_bytes(b"keep")
    item = job(db, users["editor"])
    folder = crashed_folder(settings, item)
    (folder / "unknown-directory").mkdir()
    recent = job(db, users["editor"])
    recent.expires_at = now_utc() + timedelta(minutes=2)
    db.commit()
    active = crashed_folder(settings, recent)
    candidate = gc.plan(db, settings)
    assert candidate["jobs"] == candidate["folders"] == [] and candidate["kept_unknown"] == 2
    gc.apply(db, settings, candidate["sha256"], "keep unknown paths")
    assert legacy.exists() and folder.exists() and active.exists()
    assert db.get(ImportJob, item.id)


def test_unmarked_old_crash_retains_attribution_but_started_crash_can_expire(client, db, maintenance):
    users, settings = maintenance
    legacy = job(db, users["editor"], started=False)
    known = job(db, users["editor"])
    candidate = gc.plan(db, settings)
    assert [item["id"] for item in candidate["jobs"]] == [known.id]
    result = gc.apply(db, settings, candidate["sha256"], "expire attributed no-file crash")
    assert result["removed_jobs"] == 1
    assert db.get(ImportJob, legacy.id) is not None and db.get(ImportJob, known.id) is None


def test_changed_plan_and_unknown_marker_do_not_delete_files(client, db, maintenance):
    users, settings = maintenance
    item = job(db, users["editor"])
    folder = crashed_folder(settings, item)
    first = gc.plan(db, settings)
    (folder / "owner.json").write_text("{}", encoding="utf-8")
    with pytest.raises(DomainError, match="维护计划已经变化"):
        gc.apply(db, settings, first["sha256"], "stale plan")
    assert folder.exists() and db.get(ImportJob, item.id)
    assert not (settings.floor_assets_dir / ".import-gc-receipts").exists()


def test_upload_temp_cleanup_on_parse_failure_and_real_actor_start_audit(client, db, maintenance):
    users, settings = maintenance
    point = make_resource_point(db)
    bad = upload(client, "vr", [{**vr(point), "title": "=SUM(1)"}])
    assert bad.status_code == 422
    assert list(temporary_root(settings).iterdir()) == []
    started = db.scalar(select(AdminAuditRecord).where(AdminAuditRecord.action == "import.started"))
    assert started.actor_id == users["editor"].id and set(started.details) == {"job_id", "operation_id", "kind", "source_sha256"}
    actual = db.get(ImportJob, started.details["job_id"])
    assert actual.state == "failed" and actual.byte_size == 0


def test_expired_active_slots_are_not_released_by_an_unrelated_upload(client, db, maintenance):
    users, settings = maintenance
    one, two = job(db, users["editor"]), job(db, users["editor"])
    point = make_resource_point(db)
    assert upload(client, "vr", [vr(point)]).status_code == 429
    assert db.get(ImportJob, one.id) and db.get(ImportJob, two.id)
    candidate = gc.plan(db, settings)
    gc.apply(db, settings, candidate["sha256"], "release attributed expired slots")
    assert upload(client, "vr", [vr(point)]).status_code == 201


def test_normal_temporary_exception_releases_lease_and_private_permissions(client, db, maintenance):
    users, settings = maintenance
    item = job(db, users["editor"])
    with pytest.raises(RuntimeError):
        with import_temporary(settings, item) as folder:
            (folder / "data.csv").write_bytes(b"data")
            if os.name == "posix":
                assert folder.stat().st_mode & 0o777 == 0o700
                assert (folder / "owner.json").stat().st_mode & 0o777 == 0o600
            raise RuntimeError("intentional")
    assert not owned_folder(settings, item.id).exists()


def test_symlinks_are_kept_without_touching_outside_target(client, db, maintenance, tmp_path):
    users, settings = maintenance
    item = job(db, users["editor"])
    folder = crashed_folder(settings, item)
    outside = tmp_path / "outside.txt"
    outside.write_text("must survive")
    try:
        (folder / "data.csv").unlink()
        (folder / "data.csv").symlink_to(outside)
    except OSError:
        pytest.skip("local Windows account cannot create symlinks; Linux validates this case")
    candidate = gc.plan(db, settings)
    assert candidate["folders"] == [] and candidate["kept_unknown"] == 1
    gc.apply(db, settings, candidate["sha256"], "keep symlink")
    assert outside.read_text() == "must survive" and folder.exists()


def test_scan_capacity_is_bounded_and_no_apply_on_wrong_reason(client, db, maintenance, monkeypatch):
    _, settings = maintenance
    parent = temporary_root(settings)
    (parent / "foreign-one").mkdir()
    (parent / "foreign-two").mkdir()
    monkeypatch.setattr(gc, "MAX_SCAN", 1)
    with pytest.raises(DomainError, match="数量超限"):
        gc.plan(db, settings)
    with pytest.raises(DomainError, match="维护需填写"):
        gc.apply(db, settings, "", "")
    assert len(list(parent.iterdir())) == 2


def test_expired_operation_reuse_is_explicit_and_committed_export_cannot_erase_retire_intent(client, db, maintenance):
    users, _ = maintenance
    old = job(db, users["editor"], state="checked")
    point = make_resource_point(db)
    body = vr(point)
    # Reusing expired operation never destroys its attribution or creates another
    # job; mismatched original fingerprint is rejected before any parsing.
    response = upload(client, "vr", [body], operation=old.operation_id)
    assert response.status_code == 409 and db.get(ImportJob, old.id)
    from test_resources import save

    draft = save(client, point, {"kind": "panorama", "title": "场景", "description": "", "url": "https://example.com/vr"})
    from app.models import ResourceChangeRecord

    change = db.get(ResourceChangeRecord, draft["id"])
    change.operation = "retire"
    db.commit()
    response = client.get("/api/v1/admin/import-exports/vr", params={"campus_id": point.campus_id, "ids": draft["id"]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "EXPORT_NOT_REPRESENTABLE"
