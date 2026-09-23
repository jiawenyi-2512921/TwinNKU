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
                == "0002_map_catalog"
            )
    finally:
        engine.dispose()
