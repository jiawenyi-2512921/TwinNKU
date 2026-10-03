"""Independent PostgreSQL connections contend for one actual durable queue."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from app.models import Base, CampusRecord, ExperienceRecord, PointRecord, StaffUserRecord, now_utc
from app.modules.narration.worker import claim_job
from app.narration_models import NarrationJob

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_POSTGRES_URL"), reason="requires disposable PostgreSQL")


def test_recovery_pauses_unknown_queued_and_running_without_resetting_attempts():
    from sqlalchemy import text
    from test_backup_scripts import restore

    engine = create_engine(os.environ["TEST_POSTGRES_URL"])
    try:
        with engine.begin() as db:
            # PostgreSQL temp relation is private to this connection and shadows
            # the schema table. Execute the exact recovery script statement.
            db.execute(text("CREATE TEMP TABLE narration_jobs (state text, lease_until timestamptz, "
                            "lease_version integer, last_error text, attempts integer) ON COMMIT DROP"))
            for state in ("queued", "running", "unknown", "ready", "failed", "cancelled", "paused"):
                db.execute(text("INSERT INTO narration_jobs VALUES (:state, now(), 7, 'before', 3)"),
                           {"state": state})
            db.execute(text(restore.RESTORE_PAID_JOBS_SQL))
            rows = db.execute(text("SELECT * FROM narration_jobs")).mappings().all()
            paused = [row for row in rows if row["last_error"] == "RESTORED_REQUIRES_REVIEW"]
            assert len(paused) == 3
            assert all(row["state"] == "paused" and row["lease_version"] == 8
                       and row["lease_until"] is None for row in paused)
            assert all(row["attempts"] == 3 for row in rows)
            assert {row["state"] for row in rows if row["last_error"] == "before"} == {
                "ready", "failed", "cancelled", "paused"}
    finally:
        engine.dispose()


def test_narration_global_concurrency_and_restart_do_not_replay_unknown_work():
    url = os.environ["TEST_POSTGRES_URL"]
    owner = create_engine(url)
    assert owner.dialect.name == "postgresql"
    schema = "test_narration_" + uuid4().hex
    with owner.begin() as connection:
        connection.execute(CreateSchema(schema))
    engine = create_engine(url, execution_options={"schema_translate_map": {None: schema}},
                           connect_args={"options": "-c statement_timeout=15000"}, pool_size=4)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        Base.metadata.create_all(engine)
        with factory() as db:
            db.add(CampusRecord(id="nku-jinnan", name="Test fixture"))
            db.flush()
            user = StaffUserRecord(username="worker-test", display_name="Test", role="editor",
                                   password_hash="not-a-login", campus_ids=["nku-jinnan"], point_ids=[])
            point = PointRecord(id=str(uuid4()), campus_id="nku-jinnan", name="Fixture", aliases=[],
                                category="academic", summary="", status="published", visibility="public", revision=1)
            db.add_all([user, point])
            db.flush()
            tour = ExperienceRecord(id=str(uuid4()), campus_id="nku-jinnan", kind="tour", point_id=None,
                                    draft={}, revision=1, published_revision=0)
            db.add(tour)
            db.flush()
            for index in range(2):
                db.add(NarrationJob(tour_id=tour.id, point_id=point.id, segment_id=f"segment-{index}",
                                    source_revision=1, created_by=user.id, operation_id=str(uuid4()),
                                    request_sha256="a" * 64, text="Fixture", text_sha256="b" * 64,
                                    profile={}, fingerprint=str(index) * 64, chunks=["Fixture"], completed_chunks=[]))
            db.commit()
        with ThreadPoolExecutor(max_workers=4) as threads:
            claims = list(threads.map(lambda _: claim_job(factory), range(4)))
        active = [claim for claim in claims if claim]
        assert len(active) == 1
        with factory() as db:
            first = db.get(NarrationJob, active[0][0])
            first.lease_until = now_utc() - timedelta(seconds=1)
            db.commit()
        second = claim_job(factory)
        assert second and second[0] != active[0][0]
        with factory() as db:
            assert db.get(NarrationJob, active[0][0]).state == "unknown"
            assert len(db.scalars(select(NarrationJob).where(NarrationJob.state == "running")).all()) == 1
    finally:
        engine.dispose()
        with owner.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        owner.dispose()


def test_gc_cannot_retire_a_job_retried_by_another_database_connection(tmp_path):
    from test_narration import wav_bytes

    from app.core.config import Settings
    from app.modules.narration.maintenance import apply_gc, maintenance_plan
    from app.modules.narration.service import write_chunk
    from app.modules.uploads import storage_guard

    url = os.environ["TEST_POSTGRES_URL"]
    owner = create_engine(url)
    schema = "test_narration_gc_" + uuid4().hex
    with owner.begin() as connection:
        connection.execute(CreateSchema(schema))
    engine = create_engine(url, execution_options={"schema_translate_map": {None: schema}})
    factory = sessionmaker(engine, expire_on_commit=False)
    settings = Settings(app_env="test", floor_assets_dir=tmp_path / "narration-fixture")
    try:
        Base.metadata.create_all(engine)
        with factory() as db:
            db.add(CampusRecord(id="nku-jinnan", name="GC fixture"))
            db.flush()
            user = StaffUserRecord(username="gc-test", display_name="Fixture", role="editor",
                                   password_hash="not-a-login", campus_ids=["nku-jinnan"], point_ids=[])
            point = PointRecord(id=str(uuid4()), campus_id="nku-jinnan", name="Fixture", aliases=[],
                                category="academic", summary="", status="published", visibility="public", revision=1)
            db.add_all([user, point])
            db.flush()
            tour = ExperienceRecord(id=str(uuid4()), campus_id="nku-jinnan", kind="tour", point_id=None,
                                    draft={}, revision=1, published_revision=0)
            db.add(tour)
            db.flush()
            key = str(uuid4())
            aged = now_utc() - timedelta(days=40)
            with storage_guard(settings):
                chunk = write_chunk(settings, key, wav_bytes())
                db.add(NarrationJob(id=key, tour_id=tour.id, point_id=point.id, segment_id="segment",
                                    source_revision=1, created_by=user.id, operation_id=str(uuid4()),
                                    request_sha256="a" * 64, text="Fixture", text_sha256="b" * 64,
                                    profile={}, fingerprint="c" * 64, chunks=["Fixture"],
                                    completed_chunks=[chunk], state="failed", updated_at=aged))
                db.commit()
            path = settings.floor_assets_dir / ".narration" / key / (chunk["sha256"] + ".wav")
            os.utime(path, (aged.timestamp(), aged.timestamp()))
        with storage_guard(settings, exclusive=True), factory() as stale_db:
            stale_job = stale_db.get(NarrationJob, key)
            plan = maintenance_plan(stale_db, settings)
            assert plan["retire_jobs"] and stale_job.state == "failed"
            with factory() as other:
                retried = other.scalar(select(NarrationJob).where(NarrationJob.id == key).with_for_update())
                retried.state = "queued"
                retried.lease_version += 1
                retried.updated_at = now_utc()
                other.commit()
            with pytest.raises(ValueError, match="plan changed"):
                apply_gc(stale_db, settings, expected_sha=plan["sha256"], reason="Stale reviewed fixture")
        with factory() as db:
            assert db.get(NarrationJob, key).state == "queued"
            assert db.get(NarrationJob, key).completed_chunks
        assert path.read_bytes() == wav_bytes()
    finally:
        engine.dispose()
        with owner.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        owner.dispose()
