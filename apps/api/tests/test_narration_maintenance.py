"""Real files and HTTP task replay around audited narration retirement."""

import asyncio
import copy
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_admin import login
from test_experiences import experiences as experiences
from test_narration import TestSynthesizer, generate, queue, wav_bytes
from test_narration import narration as narration

from app.content_history_models import ExperienceOperationRecord, ExperienceVersionRecord
from app.core.errors import DomainError
from app.integrations.public_agent_security import PublicAgentCounter
from app.models import ExperienceRecord, now_utc
from app.modules.narration.maintenance import (
    RETIRED,
    apply_gc,
    ensure_capacity,
    inventory,
    maintenance_plan,
)
from app.modules.narration.service import canonical, sha
from app.modules.narration.worker import claim_job, run_job
from app.modules.uploads import storage_guard
from app.narration_models import NarrationAsset, NarrationJob


def aged_job(client, db, item, factory):
    job = generate(client, db, item, factory)
    aged = now_utc() - timedelta(days=40)
    db.get(NarrationJob, job["id"]).updated_at = aged
    db.get(NarrationAsset, job["id"]).created_at = aged
    db.commit()
    root = client.app.state.settings.floor_assets_dir / ".narration" / job["id"]
    for path in root.iterdir():
        os.utime(path, (aged.timestamp(), aged.timestamp()))
    return job, root


def test_unadopted_expiry_preserves_operation_receipt_and_never_retries_paid_job(client, db, narration):
    item, factory = narration
    settings = client.app.state.settings
    job, folder = aged_job(client, db, item, factory)
    attempts = db.get(NarrationJob, job["id"]).attempts
    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        assert [entry["id"] for entry in plan["retire_jobs"]] == [job["id"]]
        assert plan["used_bytes"] == len(wav_bytes())
        with pytest.raises(ValueError, match="changed"):
            apply_gc(db, settings, expected_sha="wrong", reason="核对回收")
        assert list(folder.iterdir())  # Rejected plan did not touch bytes or metadata.
        assert db.get(NarrationAsset, job["id"])
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="核对30天未采用音频")
    assert not list(folder.iterdir())
    assert db.get(NarrationAsset, job["id"]) is None
    retained = db.get(NarrationJob, job["id"])
    assert retained.attempts == attempts and retained.last_error == RETIRED
    result = client.get("/api/v1/admin/narration-jobs/" + job["id"]).json()["data"]
    assert result["asset_id"] is None and result["state"] == "failed"
    assert client.post(f"/api/v1/admin/narration-jobs/{job['id']}/retry").status_code == 410
    replay = queue(client, item, retained.operation_id)
    assert replay.status_code == 201 and replay.json()["data"][0]["last_error"] == RETIRED
    assert claim_job(factory) is None


@pytest.mark.parametrize("reference", ["draft", "published", "history", "published_history", "receipt"])
def test_current_and_retained_history_protect_original_audio(client, db, narration, reference):
    item, factory = narration
    job, folder = aged_job(client, db, item, factory)
    adopted = copy.deepcopy(item["content"])
    adopted["stops"][0]["segments"][0]["narration_asset_id"] = job["id"]
    record = db.get(ExperienceRecord, item["id"])
    if reference in {"draft", "published"}:
        setattr(record, reference, adopted)
    elif reference == "receipt":
        db.add(ExperienceOperationRecord(user_id=db.get(NarrationJob, job["id"]).created_by,
                                        id=str(uuid4()), target_id=record.id, action="save",
                                        fingerprint="a" * 64, result={"content": adopted}))
    else:
        db.add(ExperienceVersionRecord(experience_id=record.id, event="checkpoint", revision=1,
                                       published_revision=0, operation="upsert",
                                       content=adopted if reference == "history" else None,
                                       published_content=adopted if reference == "published_history" else None,
                                       content_sha256=sha(canonical(adopted)), contributor_ids=[]))
    db.commit()
    plan = maintenance_plan(db, client.app.state.settings)
    assert job["id"] in plan["protected_assets"]
    assert not plan["retire_jobs"] and not plan["remove_files"]
    assert list(folder.iterdir())


def test_new_reference_invalidates_reviewed_dry_run(client, db, narration):
    item, factory = narration
    job, folder = aged_job(client, db, item, factory)
    settings = client.app.state.settings
    plan = maintenance_plan(db, settings)
    draft = copy.deepcopy(item["content"])
    draft["stops"][0]["segments"][0]["narration_asset_id"] = job["id"]
    db.get(ExperienceRecord, item["id"]).draft = draft
    db.commit()
    with storage_guard(settings, exclusive=True), pytest.raises(ValueError, match="changed"):
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="过时回收计划")
    assert db.get(NarrationAsset, job["id"]) and list(folder.iterdir())


def test_interrupted_physical_cleanup_stays_charged_and_can_resume(client, db, narration, monkeypatch):
    item, factory = narration
    job, folder = aged_job(client, db, item, factory)
    settings = client.app.state.settings
    original = Path.unlink

    def fail_unlink(path, *args, **kwargs):
        if path.parent == folder:
            raise OSError("test interruption")
        return original(path, *args, **kwargs)

    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        with monkeypatch.context() as context:
            context.setattr(Path, "unlink", fail_unlink)
            with pytest.raises(OSError, match="test interruption"):
                apply_gc(db, settings, expected_sha=plan["sha256"], reason="回收中断测试")
        assert db.get(NarrationAsset, job["id"]) is None
        assert sum(item["size_bytes"] for item in inventory(settings).values()) == len(wav_bytes())
        resume = maintenance_plan(db, settings)
        assert not resume["retire_jobs"] and resume["remove_files"]
        apply_gc(db, settings, expected_sha=resume["sha256"], reason="恢复已确认回收")
    assert not list(folder.iterdir())


def test_metadata_commit_failure_never_removes_sound_bytes(client, db, narration, monkeypatch):
    item, factory = narration
    job, folder = aged_job(client, db, item, factory)
    settings = client.app.state.settings
    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        with monkeypatch.context() as context:
            context.setattr(db, "commit", lambda: (_ for _ in ()).throw(RuntimeError("database stopped")))
            with pytest.raises(RuntimeError, match="database stopped"):
                apply_gc(db, settings, expected_sha=plan["sha256"], reason="提交失败保护测试")
    db.expire_all()
    assert db.get(NarrationJob, job["id"]).state == "ready"
    assert db.get(NarrationAsset, job["id"]) and list(folder.iterdir())


def test_unknown_and_paused_work_are_never_discarded(client, db, narration):
    item, factory = narration
    job, _ = aged_job(client, db, item, factory)
    settings = client.app.state.settings
    db.delete(db.get(NarrationAsset, job["id"]))
    for state in ("queued", "running", "unknown", "paused"):
        row = db.get(NarrationJob, job["id"])
        row.state = state
        db.commit()
        plan = maintenance_plan(db, settings)
        assert not plan["retire_jobs"] and not plan["remove_files"]


def test_crash_orphan_bytes_stop_supplier_attempt_before_charge(client, db, narration):
    item, factory = narration
    settings = client.app.state.settings
    folder = settings.floor_assets_dir / ".narration" / str(uuid4())
    folder.mkdir(parents=True)
    (folder / ("a" * 64 + ".wav")).write_bytes(b"orphaned physical bytes")
    settings.narration_max_storage_bytes = settings.voice_max_audio_bytes
    assert queue(client, item).status_code == 201
    before = sum(db.scalars(select(PublicAgentCounter.amount)))
    claim = claim_job(factory)
    asyncio.run(run_job(factory, settings, *claim, synthesizer_factory=TestSynthesizer))
    db.expire_all()
    actual = db.get(NarrationJob, claim[0])
    assert actual.state == "paused" and actual.last_error == "NARRATION_STORAGE_FULL"
    assert actual.attempts == 0
    assert sum(db.scalars(select(PublicAgentCounter.amount))) == before


def test_orphan_age_and_actual_bytes_not_database_totals_control_cleanup(client, db, narration):
    settings = client.app.state.settings
    root = settings.floor_assets_dir / ".narration" / str(uuid4())
    root.mkdir(parents=True)
    old, fresh = root / ("b" * 64 + ".wav"), root / ("c" * 64 + ".wav")
    old.write_bytes(b"old orphan")
    fresh.write_bytes(b"fresh orphan")
    aged = (now_utc() - timedelta(days=8)).timestamp()
    os.utime(old, (aged, aged))
    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        assert plan["used_bytes"] == len(b"old orphanfresh orphan")
        assert len(plan["remove_files"]) == 1
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="回收七天前未登记分片")
    assert not old.exists() and fresh.exists()
    settings.narration_max_storage_bytes = fresh.stat().st_size
    with pytest.raises(DomainError) as error:
        ensure_capacity(settings, 1)
    assert error.value.code == "NARRATION_STORAGE_FULL"


def test_symlink_or_unrecognized_storage_is_never_followed_or_removed(client, db, narration, tmp_path):
    settings = client.app.state.settings
    root = settings.floor_assets_dir / ".narration" / str(uuid4())
    root.mkdir(parents=True)
    unknown = root / "unrecognized-file"
    unknown.write_bytes(b"keep")
    with pytest.raises(DomainError) as error:
        inventory(settings)
    assert error.value.code == "NARRATION_STORAGE_INVALID" and unknown.read_bytes() == b"keep"
    unknown.unlink()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"outside")
    try:
        (root / ("d" * 64 + ".wav")).symlink_to(outside)
    except OSError:
        pytest.skip("Platform does not grant symlink creation")
    with pytest.raises(DomainError):
        maintenance_plan(db, settings)
    assert outside.read_bytes() == b"outside"


def test_runtime_storage_warning_uses_actual_bytes_without_exposing_paths(client, db, narration):
    login(client, "admin")
    settings = client.app.state.settings
    settings.narration_max_storage_bytes = 100
    folder = settings.floor_assets_dir / ".narration" / str(uuid4())
    folder.mkdir(parents=True)
    (folder / ("e" * 64 + ".wav")).write_bytes(b"x" * 80)
    response = client.get("/api/v1/admin/service-controls")
    assert response.status_code == 200
    assert response.json()["data"]["narration_storage"] == {
        "used_bytes": 80, "maximum_bytes": 100, "unadopted_retention_days": 30, "state": "warning"}
    assert str(folder) not in response.text
    (folder / "unexpected").write_bytes(b"investigate")
    response = client.get("/api/v1/admin/service-controls")
    assert response.status_code == 200
    assert response.json()["data"]["narration_storage"]["state"] == "unavailable"
    assert response.json()["data"]["narration_storage"]["used_bytes"] is None
    login(client, "editor")
    assert client.get("/api/v1/admin/service-controls").status_code == 403
