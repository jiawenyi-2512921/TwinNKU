"""Exercise actual historical schemas, including the pre-description floor table."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url


@pytest.fixture(params=["sqlite", "postgres"])
def migration_database(request, tmp_path):
    if request.param == "sqlite":
        yield "sqlite:///" + str(tmp_path / "historical.db")
        return
    raw = os.environ.get("TEST_POSTGRES_URL")
    if not raw:
        pytest.skip("requires explicit disposable PostgreSQL test database")
    owner = sa.create_engine(raw)
    schema = "migration_" + uuid4().hex
    with owner.begin() as db:
        db.execute(sa.schema.CreateSchema(schema))
    url = make_url(raw).update_query_dict({"options": "-csearch_path=" + schema})
    try:
        yield url.render_as_string(hide_password=False)
    finally:
        with owner.begin() as db:
            db.execute(sa.schema.DropSchema(schema, cascade=True))
        owner.dispose()


def migrate(url, *arguments):
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "APP_ENV": "test", "DATABASE_URL": url, "PYTHONUTF8": "1"},
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout[-5000:] + result.stderr[-5000:]


def seed_historical_uploads(engine):
    meta = sa.MetaData()
    meta.reflect(engine)
    assert "description" not in meta.tables["floors"].c
    now = datetime(2026, 9, 1, tzinfo=UTC)
    point_a, point_b, user_a, user_b, map_id, floor_id, floor_upload, media_upload = (
        str(uuid4()) for _ in range(8)
    )
    images = [{"variant": "labeled", "size_bytes": 300}, {"variant": "clean", "size_bytes": 200}]
    with engine.begin() as db:
        for campus in ("campus-a", "campus-b"):
            db.execute(meta.tables["campuses"].insert().values(
                id=campus, name=campus, description="kept", is_active=True,
                created_at=now, updated_at=now,
            ))
        for point, campus in ((point_a, "campus-a"), (point_b, "campus-b")):
            db.execute(meta.tables["points"].insert().values(
                id=point, campus_id=campus, name="Old point", aliases=["kept alias"],
                category="academic", summary="kept", status="published", visibility="public",
                revision=7, created_at=now, updated_at=now,
            ))
        for user in (user_a, user_b):
            db.execute(meta.tables["staff_users"].insert().values(
                id=user, username=user, display_name="Historical uploader", password_hash="fixture",
                role="editor", campus_ids=["campus-a", "campus-b"], point_ids=[], is_active=False,
                must_change_password=True, mfa_enabled=False, revision=2,
                created_at=now, updated_at=now,
            ))
        db.execute(meta.tables["maps"].insert().values(
            id=map_id, campus_id="campus-a", title="Old floor", kind="floor", revision=3,
            width_px=40, height_px=20, image_asset_id=str(uuid4()), source_sha256="a" * 64,
            tile_size=256, max_native_zoom=0, attribution="kept", status="published",
            visibility="public",
        ))
        db.execute(meta.tables["floors"].insert().values(
            id=floor_id, point_id=point_a, map_id=map_id, label="Old floor", ordinal=1,
            revision=3, attribution="kept", status="published", visibility="public",
            manifest_sha256="b" * 64, images=images,
        ))
        db.execute(meta.tables["floor_uploads"].insert().values(
            id=floor_upload, point_id=point_a, uploaded_by=user_a,
            image={"size_bytes": 110, "sha256": "c" * 64}, created_at=now,
        ))
        db.execute(meta.tables["experience_uploads"].insert().values(
            id=media_upload, point_id=point_b, uploaded_by=user_b, media_type="image",
            mime_type="image/png", filename="fixture.png", size_bytes=220,
            sha256="d" * 64, created_at=now,
        ))
    return dict(
        floor_id=floor_id, images=images, floor_upload=floor_upload, media_upload=media_upload,
        user_a=user_a, user_b=user_b,
    )


def assert_migrated_uploads(engine, fixture):
    meta = sa.MetaData()
    meta.reflect(engine)
    with engine.connect() as db:
        budgets = {row.scope: (row.used_bytes, row.reserved_bytes, row.active_uploads)
                   for row in db.execute(sa.select(meta.tables["upload_budgets"]))}
        assert budgets == {
            "global": (0, 0, 0),
            "actor:" + fixture["user_a"]: (110, 0, 0),
            "actor:" + fixture["user_b"]: (220, 0, 0),
            "campus:campus-a": (610, 0, 0),
            "campus:campus-b": (220, 0, 0),
        }
        reservations = list(db.execute(sa.select(meta.tables["upload_reservations"])))
        assert {(row.kind, row.upload_id, row.user_id, row.campus_id, row.size_bytes, row.state)
                for row in reservations} == {
            ("floor", fixture["floor_upload"], fixture["user_a"], "campus-a", 110, "complete"),
            ("media", fixture["media_upload"], fixture["user_b"], "campus-b", 220, "complete"),
        }
        assert all(row.created_at.date().isoformat() == "2026-09-01" for row in reservations)
        floor = db.execute(sa.select(meta.tables["floors"])).mappings().one()
        assert floor["id"] == fixture["floor_id"]
        assert floor["images"] == fixture["images"]
        assert floor["revision"] == 3 and floor["manifest_sha256"] == "b" * 64
        assert all(row.revision == 7 for row in db.execute(sa.select(meta.tables["points"])))


@pytest.mark.parametrize("baseline", ["0010_public_agent_security", "0012_staff_session_ids"])
def test_historical_uploads_survive_full_upgrade(migration_database, baseline):
    migrate(migration_database, "upgrade", "0010_public_agent_security")
    engine = sa.create_engine(migration_database)
    try:
        fixture = seed_historical_uploads(engine)
        if baseline == "0012_staff_session_ids":
            migrate(migration_database, "upgrade", baseline)
            assert_migrated_uploads(engine, fixture)
        else:
            # A reversible upgrade must preserve source rows and avoid duplicate reservations.
            migrate(migration_database, "upgrade", "0011_upload_budgets")
            assert_migrated_uploads(engine, fixture)
            migrate(migration_database, "downgrade", "0010_public_agent_security")
        migrate(migration_database, "upgrade", "head")
        migrate(migration_database, "upgrade", "head")
        migrate(migration_database, "check")
        assert_migrated_uploads(engine, fixture)
        with engine.connect() as db:
            assert db.execute(sa.text("SELECT description FROM floors")).scalar_one() == ""
    finally:
        engine.dispose()
