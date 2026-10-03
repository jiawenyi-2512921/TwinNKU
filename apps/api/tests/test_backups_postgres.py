"""Independent PostgreSQL connections prove the actual shared admission gate."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from app.backup_models import (
    BackupControlRecord,
    BackupGrantRecord,
    BackupJobRecord,
    BackupStatusRecord,
)
from app.core.errors import DomainError
from app.models import Base, StaffSessionRecord, StaffUserRecord, now_utc
from app.modules.admin.security import Principal
from app.modules.backups.schemas import BackupRequest
from app.modules.backups.service import admit

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"), reason="requires disposable PostgreSQL"
)


@pytest.fixture
def sandbox():
    url = os.environ["TEST_POSTGRES_URL"]
    owner = create_engine(url)
    assert owner.dialect.name == "postgresql"
    schema = "test_backup_" + uuid4().hex
    with owner.begin() as db:
        db.execute(CreateSchema(schema))
    engine = create_engine(
        url,
        execution_options={"schema_translate_map": {None: schema}},
        connect_args={"options": "-c statement_timeout=15000"},
        pool_size=4,
    )
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        Base.metadata.create_all(engine)
        with factory() as db:
            user = StaffUserRecord(
                username="backup-test",
                display_name="Test",
                role="admin",
                password_hash="not-a-login",
                campus_ids=[],
                point_ids=[],
                mfa_enabled=True,
            )
            db.add(user)
            db.flush()
            session = StaffSessionRecord(
                token_hash="a" * 64,
                user_id=user.id,
                csrf_token="not-a-cookie",
                mfa_verified_at=now_utc(),
                expires_at=now_utc() + timedelta(hours=1),
            )
            db.add_all(
                [
                    session,
                    BackupGrantRecord(
                        user_id=user.id,
                        permission="backup.request",
                        granted_by=user.id,
                        note="isolated fixture",
                    ),
                    BackupControlRecord(id=1, generation=0),
                    BackupStatusRecord(
                        id=1,
                        observed_at=now_utc(),
                        summary={"summary": {"status": "unknown"}, "requests_enabled": True},
                    ),
                ]
            )
            db.commit()
            yield factory, user.id
    finally:
        engine.dispose()
        with owner.begin() as db:
            db.execute(DropSchema(schema, cascade=True))
        owner.dispose()


def race(factory, user_id, operations):
    barrier = Barrier(len(operations))
    settings = SimpleNamespace(
        backup_requests_enabled=True,
        practice_mode=False,
        backup_staff_requests_per_day=2,
        backup_global_requests_per_day=6,
        backup_min_interval_seconds=3600,
    )

    def contender(operation):
        with factory() as db:
            backend = db.scalar(text("SELECT pg_backend_pid()"))
            user = db.get(StaffUserRecord, user_id)
            session = db.get(StaffSessionRecord, "a" * 64)
            barrier.wait(timeout=15)
            try:
                row = admit(
                    db,
                    Principal(user, session),
                    settings,
                    BackupRequest(operation_id=operation, reason="isolated backup race"),
                )
                db.commit()
                return {"status": "accepted", "id": row.id, "backend": backend}
            except DomainError as exc:
                db.rollback()
                return {"status": exc.code, "backend": backend}

    with ThreadPoolExecutor(max_workers=len(operations)) as workers:
        return list(workers.map(contender, operations))


def test_concurrent_distinct_requests_admit_only_one(sandbox):
    factory, user_id = sandbox
    results = race(factory, user_id, [uuid4() for _ in range(4)])
    assert len({row["backend"] for row in results}) == 4
    assert sum(row["status"] == "accepted" for row in results) == 1
    assert sum(row["status"] == "BACKUP_BUSY" for row in results) == 3
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(BackupJobRecord)) == 1


def test_concurrent_same_operation_recovers_one_original_job(sandbox):
    factory, user_id = sandbox
    operation = uuid4()
    results = race(factory, user_id, [operation] * 4)
    assert all(row["status"] == "accepted" for row in results)
    assert len({row["backend"] for row in results}) == 4
    assert len({row["id"] for row in results}) == 1
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(BackupJobRecord)) == 1
