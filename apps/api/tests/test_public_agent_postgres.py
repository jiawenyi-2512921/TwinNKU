"""Real PostgreSQL contention and migration checks, never an implicit database.

Each test owns a random schema inside TEST_POSTGRES_URL. Child processes open
independent engines; no application tables or rows outside that schema are used.
"""

import importlib.util
import multiprocessing
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

from app.core.errors import DomainError
from app.integrations import public_agent_security as security

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"),
    reason="requires explicit disposable PostgreSQL test database",
)


def _engine(url, schema):
    return sa.create_engine(
        url,
        connect_args={"connect_timeout": 10, "options": "-c statement_timeout=15000"},
        execution_options={"schema_translate_map": {None: schema}},
        pool_size=1,
        max_overflow=0,
    )


@pytest.fixture
def pg_sandbox():
    url = os.environ["TEST_POSTGRES_URL"]
    schema = "test_public_agent_" + uuid4().hex
    owner = sa.create_engine(url)
    assert owner.dialect.name == "postgresql", "TEST_POSTGRES_URL must identify PostgreSQL"
    with owner.begin() as connection:
        connection.execute(CreateSchema(schema))
    try:
        engine = _engine(url, schema)
        metadata = sa.MetaData()
        for table in (security.PublicAgentCounter.__table__, security.PublicAgentLease.__table__):
            table.to_metadata(metadata)
        metadata.create_all(engine)
        engine.dispose()
        yield url, schema
    finally:
        # Only this test's generated schema is removed, even after child failure.
        assert schema.startswith("test_public_agent_") and len(schema) == 50
        with owner.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        owner.dispose()


def _request(limit):
    settings = SimpleNamespace(agent_model_concurrency=limit, agent_voice_concurrency=limit)
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=settings)))


def _contender(url, schema, mode, identity, kind, limit, fixed_time, ready, start, results):
    """Top-level target works with spawn on Linux and Windows, not forked pools."""
    engine = None
    try:
        engine = _engine(url, schema)
        with Session(engine) as db:
            backend = db.scalar(sa.text("SELECT pg_backend_pid()"))
            ready.put({"pid": os.getpid(), "backend": backend})
            if not start.wait(90):
                raise TimeoutError("test start barrier expired")
            try:
                if mode == "budget":
                    with patch.object(security.time, "time", return_value=fixed_time):
                        security.reserve(db, [(identity, limit, 1, 86400)])
                    result = {"status": 200}
                else:
                    lease = security.acquire_lease(db, _request(limit), identity, kind)
                    result = {"status": 200, "lease": lease}
            except DomainError as error:
                result = {"status": error.status, "code": error.code}
            results.put({**result, "pid": os.getpid(), "backend": backend})
    except Exception as error:
        # Do not serialize exception strings which might include a connection URL.
        results.put({"error_type": type(error).__name__, "pid": os.getpid()})
        ready.put({"error_type": type(error).__name__, "pid": os.getpid()})
    finally:
        if engine is not None:
            engine.dispose()


def _race(pg_sandbox, *, mode, identities, kind="", limit=5, fixed_time=None):
    url, schema = pg_sandbox
    context = multiprocessing.get_context("spawn")
    ready, results, start = context.Queue(), context.Queue(), context.Event()
    processes = [
        context.Process(
            target=_contender,
            args=(url, schema, mode, identity, kind, limit, fixed_time, ready, start, results),
        )
        for identity in identities
    ]
    try:
        for process in processes:
            process.start()
        deadline = time.monotonic() + 90
        arrivals = [ready.get(timeout=max(1, deadline - time.monotonic())) for _ in processes]
        assert all("error_type" not in item for item in arrivals), arrivals
        assert len({item["pid"] for item in arrivals}) == len(processes)
        assert len({item["backend"] for item in arrivals}) == len(processes)
        start.set()
        deadline = time.monotonic() + 90
        outcomes = [results.get(timeout=max(1, deadline - time.monotonic())) for _ in processes]
        assert all("error_type" not in item for item in outcomes), outcomes
        for process in processes:
            process.join(timeout=15)
            assert process.exitcode == 0, "PostgreSQL contender did not exit cleanly"
        return outcomes
    finally:
        start.set()
        for process in processes:
            if process.pid is not None and process.is_alive():
                process.terminate()
                process.join(timeout=5)
        for queue in (ready, results):
            queue.close()
            queue.join_thread()


def test_postgres_budget_is_atomic_across_ten_processes_and_survives_engine_restart(pg_sandbox):
    identity, fixed_time = "test-budget-" + uuid4().hex, time.time()
    outcomes = _race(pg_sandbox, mode="budget", identities=[identity] * 10, fixed_time=fixed_time)
    assert sum(item["status"] == 200 for item in outcomes) == 5
    denied = [item for item in outcomes if item["status"] != 200]
    assert len(denied) == 5
    assert all(item["status"] == 429 and item["code"] == "PUBLIC_BUDGET_REACHED" for item in denied)

    url, schema = pg_sandbox
    engine = _engine(url, schema)
    with Session(engine) as db:
        key = security.digest(f"{identity}:86400:{int(fixed_time) // 86400}")
        assert db.get(security.PublicAgentCounter, key).amount == 5
    engine.dispose()
    restarted = _engine(url, schema)
    try:
        with Session(restarted) as db, patch.object(security.time, "time", return_value=fixed_time):
            with pytest.raises(DomainError) as denied:
                security.reserve(db, [(identity, 5, 1, 86400)])
            assert (denied.value.code, denied.value.status) == ("PUBLIC_BUDGET_REACHED", 429)
            assert db.get(security.PublicAgentCounter, key).amount == 5
    finally:
        restarted.dispose()


def test_postgres_owner_lease_serializes_independent_processes_and_engine_restart(pg_sandbox):
    kind, owner = "pg" + uuid4().hex[:12], "test-owner-" + uuid4().hex
    outcomes = _race(pg_sandbox, mode="lease", identities=[owner] * 10, kind=kind, limit=10)
    assert sum(item["status"] == 200 for item in outcomes) == 1
    denied = [item for item in outcomes if item["status"] != 200]
    assert len(denied) == 9
    assert all(item["status"] == 409 and item["code"] == "REQUEST_IN_PROGRESS" for item in denied)
    engine = _engine(*pg_sandbox)
    try:
        with Session(engine) as db:
            with pytest.raises(DomainError) as denied:
                security.acquire_lease(db, _request(10), owner, kind)
            assert (denied.value.code, denied.value.status) == ("REQUEST_IN_PROGRESS", 409)
            security.release_lease(
                db, next(item["lease"] for item in outcomes if item["status"] == 200)
            )
            assert security.acquire_lease(db, _request(10), owner, kind)
    finally:
        engine.dispose()


def test_postgres_global_lease_limit_serializes_processes_and_releases_capacity(pg_sandbox):
    kind = "pg" + uuid4().hex[:12]
    owners = ["test-owner-" + uuid4().hex for _ in range(10)]
    outcomes = _race(pg_sandbox, mode="lease", identities=owners, kind=kind, limit=3)
    assert sum(item["status"] == 200 for item in outcomes) == 3
    denied = [item for item in outcomes if item["status"] != 200]
    assert len(denied) == 7
    assert all(item["status"] == 503 and item["code"] == "SERVICE_BUSY" for item in denied)
    engine = _engine(*pg_sandbox)
    try:
        with Session(engine) as db:
            new_owner = "test-owner-" + uuid4().hex
            with pytest.raises(DomainError) as denied:
                security.acquire_lease(db, _request(3), new_owner, kind)
            assert (denied.value.code, denied.value.status) == ("SERVICE_BUSY", 503)
            assert len(db.scalars(sa.select(security.PublicAgentLease)).all()) == 3
            security.release_lease(
                db, next(item["lease"] for item in outcomes if item["status"] == 200)
            )
            assert security.acquire_lease(db, _request(3), new_owner, kind)
            assert len(db.scalars(sa.select(security.PublicAgentLease)).all()) == 3
    finally:
        engine.dispose()


def test_postgres_0012_upgrade_downgrade_preserves_session_auth_material(pg_sandbox):
    """Exercise real PG DDL without reading any pre-existing staff sessions."""
    url, schema = pg_sandbox
    engine = _engine(url, schema)
    path = Path(__file__).parents[1] / "migrations/versions/0012_staff_session_ids.py"
    spec = importlib.util.spec_from_file_location("session_id_pg_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    table = sa.Table(
        "staff_sessions",
        sa.MetaData(),
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("mfa_verified_at", sa.DateTime(timezone=True)),
    )
    try:
        with engine.connect() as connection, connection.begin() as outer:
            quoted = connection.dialect.identifier_preparer.quote(schema)
            connection.execute(sa.text(f"SET LOCAL search_path TO {quoted}"))
            table.create(connection)
            now = datetime.now(UTC)
            connection.execute(
                table.insert(),
                [
                    dict(
                        token_hash=str(index) * 64,
                        user_id="synthetic-test-owner",
                        csrf_token="synthetic-csrf-" + str(index),
                        created_at=now,
                        expires_at=now + timedelta(hours=2),
                        last_activity_at=now,
                        mfa_verified_at=now if index else None,
                    )
                    for index in range(3)
                ],
            )
            before = connection.execute(sa.select(table).order_by(table.c.token_hash)).all()
            migration.op = Operations(MigrationContext.configure(connection))
            migration.upgrade()
            upgraded = sa.Table(
                "staff_sessions", sa.MetaData(), schema=schema, autoload_with=connection
            )
            ids = list(connection.execute(sa.select(upgraded.c.public_id)).scalars())
            assert len(set(ids)) == 3 and all(UUID(value).version == 4 for value in ids)
            assert not upgraded.c.public_id.nullable
            assert any(
                index["unique"] and index["column_names"] == ["public_id"]
                for index in sa.inspect(connection).get_indexes("staff_sessions", schema=schema)
            )
            assert connection.execute(sa.select(table).order_by(table.c.token_hash)).all() == before
            migration.downgrade()
            assert "public_id" not in {
                column["name"]
                for column in sa.inspect(connection).get_columns("staff_sessions", schema=schema)
            }
            assert connection.execute(sa.select(table).order_by(table.c.token_hash)).all() == before
            outer.rollback()
    finally:
        engine.dispose()
