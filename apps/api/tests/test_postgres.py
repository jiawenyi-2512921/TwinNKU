import os
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"),
    reason="requires explicit disposable PostgreSQL test database",
)
def test_postgres_migration_and_seed():
    root = Path(__file__).resolve().parents[1]
    url = os.environ["TEST_POSTGRES_URL"]
    env = {**os.environ, "APP_ENV": "test", "DATABASE_URL": url}
    for command in [
        ["alembic", "upgrade", "head"],
        ["python", "-m", "app.seed"],
        ["python", "-m", "app.seed"],
        ["alembic", "check"],
    ]:
        subprocess.run(command, cwd=root, env=env, check=True, capture_output=True, text=True)
    engine = create_engine(url)
    try:
        with engine.connect() as db:
            assert (
                db.execute(text("SELECT count(*) FROM campuses WHERE id='nku-jinnan'")).scalar_one()
                == 1
            )
            assert (
                db.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
                == "0005_resource_editor"
            )
    finally:
        engine.dispose()


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"), reason="requires disposable PostgreSQL"
)
@pytest.mark.parametrize("workflow", ["point", "floor"])
def test_postgres_review_retirement_and_restore(workflow, tmp_path):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session
    from test_admin import exercise_review_workflow, seed_staff
    from test_resources import exercise_floor_workflow, make_resource_point

    from app.core.config import Settings
    from app.database import get_db
    from app.main import create_app
    from app.models import CampusRecord

    root = Path(__file__).resolve().parents[1]
    url = os.environ["TEST_POSTGRES_URL"]
    subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd=root,
        env={**os.environ, "APP_ENV": "test", "DATABASE_URL": url},
        check=True,
        capture_output=True,
    )
    engine = create_engine(url)
    try:
        with engine.connect() as connection, connection.begin() as outer:
            with Session(bind=connection, join_transaction_mode="create_savepoint") as db:
                if db.get(CampusRecord, "nku-jinnan") is None:
                    db.add(CampusRecord(id="nku-jinnan", name="Test campus"))
                    db.commit()
                app = create_app(Settings(app_env="test", floor_assets_dir=tmp_path / "floors"))

                def override_db():
                    yield db

                app.dependency_overrides[get_db] = override_db
                with TestClient(app) as client:
                    staff = seed_staff(client, db)
                    if workflow == "point":
                        exercise_review_workflow(client, staff)
                    else:
                        exercise_floor_workflow(client, db, (staff[0], make_resource_point(db)))
            outer.rollback()
    finally:
        engine.dispose()


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"), reason="requires disposable PostgreSQL"
)
def test_postgres_public_alias_search_and_guide():
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session
    from test_guide import test_plugin_search_supports_chinese_aliases_without_exposing_drafts

    from app.core.config import Settings
    from app.database import get_db
    from app.main import create_app

    engine = create_engine(os.environ["TEST_POSTGRES_URL"])
    try:
        with engine.connect() as connection, connection.begin() as outer:
            with Session(bind=connection, join_transaction_mode="create_savepoint") as db:
                app = create_app(Settings(app_env="test"))

                def override_db():
                    yield db

                app.dependency_overrides[get_db] = override_db
                with TestClient(app) as client:
                    test_plugin_search_supports_chinese_aliases_without_exposing_drafts(client, db)
                    items = client.get(
                        "/api/v1/campuses/nku-jinnan/points", params={"q": "西楼100%"}
                    ).json()["data"]
                    assert client.get(f"/api/v1/guide/points/{items[0]['id']}").status_code == 200
            outer.rollback()
    finally:
        engine.dispose()
