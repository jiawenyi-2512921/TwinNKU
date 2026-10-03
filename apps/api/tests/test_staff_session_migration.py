"""0012 backfills only random public IDs; existing auth material stays intact."""

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_session_id_migration_preserves_existing_sessions_and_downgrades_without_loss():
    path = Path(__file__).parents[1] / "migrations/versions/0012_staff_session_ids.py"
    spec = importlib.util.spec_from_file_location("migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    table = sa.Table(
        "staff_sessions",
        metadata,
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("mfa_verified_at", sa.DateTime(timezone=True)),
    )
    metadata.create_all(engine)
    now = datetime.now(UTC)
    with engine.begin() as connection:
        connection.execute(
            table.insert(),
            [
                dict(
                    token_hash=str(index) * 64,
                    user_id="owner",
                    csrf_token="csrf-" + str(index),
                    created_at=now,
                    expires_at=now + timedelta(hours=2),
                    last_activity_at=now,
                    mfa_verified_at=now if index else None,
                )
                for index in range(3)
            ],
        )
        before = connection.execute(sa.select(table).order_by(table.c.token_hash)).all()
        module.op = Operations(MigrationContext.configure(connection))
        module.upgrade()
        upgraded = sa.Table("staff_sessions", sa.MetaData(), autoload_with=connection)
        ids = list(connection.execute(sa.select(upgraded.c.public_id)).scalars())
        assert len(set(ids)) == 3 and all(UUID(value).version == 4 for value in ids)
        assert not upgraded.c.public_id.nullable
        assert any(
            index["unique"] and index["column_names"] == ["public_id"]
            for index in sa.inspect(connection).get_indexes("staff_sessions")
        )
        assert connection.execute(sa.select(table).order_by(table.c.token_hash)).all() == before
        module.downgrade()
        assert "public_id" not in {
            column["name"] for column in sa.inspect(connection).get_columns("staff_sessions")
        }
        assert connection.execute(sa.select(table).order_by(table.c.token_hash)).all() == before
    engine.dispose()
