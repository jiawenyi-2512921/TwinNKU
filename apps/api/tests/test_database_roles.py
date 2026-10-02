"""Online credentials can do application DML, never alter schema/migration state."""

import os
from uuid import uuid4

import pytest
from psycopg import sql
from sqlalchemy import create_engine

from app.database_roles import provision_runtime_role, validate_separate_passwords

TEST_SECRET = "ephemeral-test-runtime-only-" + "x" * 30


def test_owner_runtime_password_separation_never_returns_secret():
    for owner, runtime in (("", TEST_SECRET), (TEST_SECRET, ""), (TEST_SECRET, TEST_SECRET)):
        with pytest.raises(ValueError) as error:
            validate_separate_passwords(owner, runtime)
        assert TEST_SECRET not in str(error.value)
    validate_separate_passwords(TEST_SECRET, TEST_SECRET + "distinct")


class Cursor:
    def __init__(self, *, owned=0, memberships=0):
        self.owned, self.memberships, self.queries = owned, memberships, []
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def execute(self, query, _params=None):
        query = query.as_string() if isinstance(query, sql.Composable) else query
        self.queries.append(query)
        if "SELECT current_user" in query:
            self.result = ("test_owner", "test_db")
        elif "SELECT 1 FROM pg_roles" in query:
            self.result = (1,)
        elif "FROM pg_shdepend" in query:
            self.result = (self.owned,)
        elif "FROM pg_auth_members" in query:
            self.result = (self.memberships,)
        elif "to_regclass" in query:
            self.result = ("public.alembic_version",)
        elif "SELECT rolsuper" in query:
            self.result = (False,) * 5
        elif "has_schema_privilege" in query:
            self.result = (False, False)

    def fetchone(self):
        return self.result


def connection(cursor):
    class Connection:
        def cursor(self):
            return cursor

    return Connection()


def test_preexisting_object_owner_is_refused_before_any_role_alteration():
    cursor = Cursor(owned=1)
    with pytest.raises(ValueError, match="owns database objects"):
        provision_runtime_role(connection(cursor), "test_runtime", TEST_SECRET)
    assert not any("ALTER ROLE" in query for query in cursor.queries)


def test_membership_is_refused_and_public_create_is_revoked():
    with pytest.raises(ValueError, match="memberships"):
        provision_runtime_role(connection(Cursor(memberships=1)), "test_runtime", TEST_SECRET)
    cursor = Cursor()
    provision_runtime_role(connection(cursor), "test_runtime", TEST_SECRET)
    assert "REVOKE CREATE ON SCHEMA public FROM PUBLIC" in cursor.queries
    assert any(
        "REVOKE CREATE ON DATABASE" in query and "FROM PUBLIC" in query for query in cursor.queries
    )
    assert any(
        "REVOKE INSERT, UPDATE, DELETE ON TABLE public.alembic_version" in query
        for query in cursor.queries
    )


@pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_URL"), reason="requires explicit disposable PostgreSQL"
)
def test_postgres_runtime_dml_allowed_ddl_and_version_mutation_denied():
    engine = create_engine(os.environ["TEST_POSTGRES_URL"])
    runtime, table = "test_runtime_" + uuid4().hex[:12], "test_role_" + uuid4().hex[:12]
    connection = engine.raw_connection()
    driver = connection.driver_connection
    try:
        with driver.cursor() as cursor:
            cursor.execute(
                "CREATE TABLE IF NOT EXISTS public.alembic_version (version_num VARCHAR(32) PRIMARY KEY)"
            )
            cursor.execute(
                sql.SQL("CREATE TABLE {} (id integer PRIMARY KEY)").format(sql.Identifier(table))
            )
            # Simulate an older database's PUBLIC grant: NOINHERIT does not fix it.
            cursor.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")
        provision_runtime_role(driver, runtime, TEST_SECRET)
        driver.commit()
        with driver.cursor() as cursor:
            cursor.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(runtime)))
            cursor.execute(sql.SQL("INSERT INTO {} VALUES (1)").format(sql.Identifier(table)))
            cursor.execute(sql.SQL("UPDATE {} SET id=2 WHERE id=1").format(sql.Identifier(table)))
            cursor.execute(sql.SQL("SELECT id FROM {}").format(sql.Identifier(table)))
            assert cursor.fetchone() == (2,)
            for query in (
                "CREATE TABLE public.denied_role_test (id integer)",
                "CREATE SCHEMA denied_role_schema",
                sql.SQL("ALTER TABLE {} ADD COLUMN forbidden text").format(sql.Identifier(table)),
                "UPDATE public.alembic_version SET version_num=version_num",
            ):
                cursor.execute("SAVEPOINT permission_check")
                with pytest.raises(Exception) as error:
                    cursor.execute(query)
                assert getattr(error.value, "sqlstate", None) == "42501"
                cursor.execute("ROLLBACK TO SAVEPOINT permission_check")
            cursor.execute(sql.SQL("DELETE FROM {} WHERE id=2").format(sql.Identifier(table)))
            cursor.execute("RESET ROLE")
        driver.commit()
    finally:
        driver.rollback()
        with driver.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(table)))
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (runtime,))
            if cursor.fetchone():
                cursor.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(runtime)))
                cursor.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(runtime)))
        driver.commit()
        connection.close()
        engine.dispose()
