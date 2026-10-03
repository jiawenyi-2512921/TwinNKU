"""Run exact restore quarantine SQL on isolated old and current PostgreSQL schemas."""

import os
from datetime import timedelta
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from test_backup_scripts import restore
from test_historical_upload_migration import migrate

from app.backup_models import (
    BackupControlRecord,
    BackupGrantRecord,
    BackupJobRecord,
    BackupStatusRecord,
)
from app.configuration_models import ConfigurationGrantRecord, EmergencyStopRecord
from app.integrations.public_agent_security import (
    PublicAgentCapability,
    PublicAgentCounter,
    PublicAgentLease,
    PublicAgentRequest,
    PublicAgentSession,
)
from app.models import (
    AdminAuditRecord,
    CampusRecord,
    ExperienceRecord,
    PointRecord,
    StaffCredentialRecord,
    StaffMfaChallengeRecord,
    StaffRecoveryCodeRecord,
    StaffSessionRecord,
    StaffUserRecord,
    now_utc,
)
from app.narration_models import NarrationJob

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_POSTGRES_URL"), reason="requires isolated PostgreSQL")
BATCH = "d" * 64


@pytest.fixture
def isolated_url():
    owner = sa.create_engine(os.environ["TEST_POSTGRES_URL"])
    schema = "restore_security_" + uuid4().hex
    with owner.begin() as db:
        db.execute(sa.schema.CreateSchema(schema))
    url = make_url(os.environ["TEST_POSTGRES_URL"]).update_query_dict({"options": "-csearch_path=" + schema})
    try:
        yield url.render_as_string(hide_password=False)
    finally:
        with owner.begin() as db:
            db.execute(sa.schema.DropSchema(schema, cascade=True))
        owner.dispose()


@pytest.mark.parametrize("baseline", ["production-baseline", "head"])
def test_actual_restore_sql_revokes_old_authority_preserves_content_and_consumption(isolated_url, baseline):
    # Resolve the historical migration by revision rather than assuming its file name.
    from alembic.script import ScriptDirectory

    historical = next(revision.revision for revision in ScriptDirectory("migrations").walk_revisions()
                      if revision.revision.startswith("0012_"))
    migrate(isolated_url, "upgrade", historical if baseline != "head" else "head")
    engine = sa.create_engine(isolated_url)
    now, expires = now_utc(), now_utc() + timedelta(hours=1)
    try:
        tables = set(sa.inspect(engine).get_table_names())
        with Session(engine) as db:
            db.add(CampusRecord(id="nku-jinnan", name="Restore fixture", description="Preserved"))
            user = StaffUserRecord(username="old-admin", display_name="Old authority", password_hash="old-private-hash",
                                   role="admin", campus_ids=[], point_ids=[], mfa_enabled=True,
                                   mfa_recovery_until=expires)
            db.add(user)
            db.flush()
            user_id = user.id
            db.add(StaffSessionRecord(token_hash="a" * 64, user_id=user.id, csrf_token="b" * 64,
                                       expires_at=expires, mfa_verified_at=now))
            db.add(StaffCredentialRecord(credential_id="old-credential", user_id=user.id, public_key="old-public-key",
                                         name="Old device", verified=True))
            db.add(StaffMfaChallengeRecord(token_hash="c" * 64, user_id=user.id, user_revision=1, purpose="login",
                                           csrf_token="d" * 64, expires_at=expires))
            db.add(StaffRecoveryCodeRecord(code_hash="e" * 64, user_id=user.id))
            db.add(PublicAgentSession(token_hash="f" * 64, user_id="old-visitor", csrf="a" * 64, expires_at=expires))
            db.flush()
            db.add(PublicAgentRequest(session_id="f" * 64, request_id="old-request", fingerprint="b" * 64,
                                       answer="Private old answer", expires_at=expires))
            db.add(PublicAgentCapability(key="c" * 64, owner="f" * 64, kind="speech", payload={}, expires_at=expires))
            db.add(PublicAgentLease(id="d" * 64, owner="f" * 64, kind="chat", expires_at=expires))
            db.add(PublicAgentCounter(key="e" * 64, amount=37, expires_at=expires))
            if baseline == "head":
                db.add(ConfigurationGrantRecord(user_id=user.id, permission="runtime.review", scope="global",
                                                  granted_by=user.id, note="Old grant"))
                db.add(EmergencyStopRecord(service="chat", revision=9, stopped=False, reason="Old state", actor_id=user.id))
                db.add(BackupGrantRecord(user_id=user.id, permission="backup.request", granted_by=user.id, note="Old grant"))
                db.add(BackupStatusRecord(id=1, observed_at=now, summary={"status": "success"}))
                db.add(BackupControlRecord(id=1, generation=11))
                point = PointRecord(id=str(uuid4()), campus_id="nku-jinnan", name="Kept point", aliases=[],
                                    category="academic", summary="Unchanged", status="published", visibility="public")
                db.add(point)
                db.flush()
                tour = ExperienceRecord(id=str(uuid4()), kind="tour", point_id=None, campus_id="nku-jinnan",
                                         draft={"kept": "exact"}, published={"kept": "snapshot"},
                                         revision=7, published_revision=3, state="published")
                db.add(tour)
                db.flush()
                tour_id = tour.id
                for index, state in enumerate(("queued", "running", "unknown", "ready")):
                    db.add(NarrationJob(tour_id=tour.id, point_id=point.id, segment_id=str(index), source_revision=7,
                                         created_by=user.id, operation_id=str(uuid4()), request_sha256="a" * 64,
                                         text="Preserved", text_sha256="b" * 64, profile={}, fingerprint=str(index) * 64,
                                         chunks=["Preserved"], completed_chunks=[], state=state, attempts=index + 2,
                                         lease_version=5, lease_until=expires))
                for state in ("queued", "running", "unknown", "succeeded"):
                    db.add(BackupJobRecord(user_id=user.id, operation_id=str(uuid4()), fingerprint="a" * 64,
                                            reason="Restore fixture", request_session_id=str(uuid4()),
                                            mfa_verified_at=now, authorized_until=expires, state=state,
                                            lease_until=expires, execution_id=str(uuid4())))
            db.commit()
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as db:
            summary_query = restore.recovery_security_summary_sql(tables)
            before = db.exec_driver_sql(summary_query).scalar_one()
            db.exec_driver_sql(restore.recovery_security_sql(tables, BATCH))
            after = db.exec_driver_sql(summary_query).scalar_one()
            assert after["quota_fingerprint"] == before["quota_fingerprint"]
            assert all(value is True for key, value in after.items() if key != "quota_fingerprint")
        with Session(engine) as db:
            user = db.get(StaffUserRecord, user_id)
            assert not user.is_active and user.role == "viewer" and user.password_hash == "!restore:" + BATCH
            assert user.revision == 2 and user.mfa_enabled and user.mfa_recovery_until is None
            assert db.get(CampusRecord, "nku-jinnan").description == "Preserved"
            assert db.get(PublicAgentCounter, "e" * 64).amount == 37
            audit = db.scalar(sa.select(AdminAuditRecord).where(AdminAuditRecord.action == "system.restore_quarantine"))
            assert audit.details["batch_sha256"] == BATCH
            assert db.get(StaffUserRecord, audit.actor_id).username == restore.RESTORE_ACTOR
            if baseline == "head":
                assert db.get(ExperienceRecord, tour_id).published == {"kept": "snapshot"}
                jobs = db.scalars(sa.select(NarrationJob).order_by(NarrationJob.segment_id)).all()
                assert [job.attempts for job in jobs] == [2, 3, 4, 5]
                assert [job.state for job in jobs] == ["paused", "paused", "paused", "ready"]
                assert all(job.lease_until is None and job.lease_version == 6 for job in jobs[:3])
                assert db.get(EmergencyStopRecord, "chat").revision == 10
                backup = db.scalars(sa.select(BackupJobRecord)).all()
                assert sorted(job.state for job in backup) == ["expired", "expired", "expired", "succeeded"]
                assert all(job.lease_until is None and job.execution_id is None for job in backup if job.state == "expired")
                assert db.get(BackupControlRecord, 1).generation == 12
    finally:
        engine.dispose()
