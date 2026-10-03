"""Native PostgreSQL JSON scope and keyset pagination through real staff HTTP."""

import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema
from test_admin import seed_staff
from test_resources import make_resource_point
from test_workbench_issues import (
    test_configuration_requires_explicit_grants_and_hides_foreign_resource_version as configuration_workflow,
)
from test_workbench_issues import (
    test_keyset_pages_can_reach_old_saved_content_and_cursor_binds_scope as keyset_workflow,
)
from test_workbench_issues import (
    test_null_retirement_draft_is_a_real_pending_action_then_disappears as retirement_workflow,
)
from test_workbench_issues import (
    test_scope_is_before_paging_for_both_tour_snapshots_and_no_private_counts as scope_workflow,
)

from app.core.config import Settings
from app.database import get_db
from app.main import create_app
from app.models import Base, CampusRecord

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"), reason="requires explicit disposable PostgreSQL"
)


@pytest.mark.parametrize("workflow", ["scope", "keyset", "configuration", "retirement"])
def test_workbench_issues_postgres(workflow, tmp_path):
    url = os.environ["TEST_POSTGRES_URL"]
    owner = create_engine(url)
    assert owner.dialect.name == "postgresql"
    schema = "test_issues_" + uuid4().hex
    with owner.begin() as connection:
        connection.execute(CreateSchema(schema))
    engine = create_engine(
        url,
        execution_options={"schema_translate_map": {None: schema}},
        connect_args={"options": "-c statement_timeout=15000"},
    )
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            db.add(CampusRecord(id="nku-jinnan", name="Test fixture"))
            db.commit()
            app = create_app(Settings(app_env="test", floor_assets_dir=tmp_path / "media"))
            app.dependency_overrides[get_db] = lambda: db
            with TestClient(app) as client:
                if workflow == "configuration":
                    configuration_workflow(client, db)
                else:
                    users, _ = seed_staff(client, db)
                    fixtures = (users, make_resource_point(db), make_resource_point(db))
                    {
                        "scope": scope_workflow,
                        "keyset": keyset_workflow,
                        "retirement": retirement_workflow,
                    }[workflow](client, db, fixtures)
    finally:
        engine.dispose()
        with owner.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        owner.dispose()
