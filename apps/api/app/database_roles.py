"""Owner-only, idempotent provisioning of the restricted online database role.

Run in the migration container after Alembic. No credentials are printed and no
database, schema, table, or existing data is recreated.
"""

import os
import re
import secrets

from psycopg import sql

from app.database import engine


def provision_runtime_role(connection, username: str, password: str):
    if not re.fullmatch(r"[a-z][a-z0-9_]{2,62}", username):
        raise ValueError("DB_APP_USER must be a simple dedicated role name")
    if len(password) < 24 or "change-me" in password.lower():
        raise ValueError("DB_APP_PASSWORD must be a distinct random secret of 24+ characters")
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user, current_database()")
        owner, database = cursor.fetchone()
        if owner == username:
            raise ValueError("Migration and runtime database users must differ")
        cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (username,))
        exists = cursor.fetchone() is not None
        if exists:
            cursor.execute(
                "SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid "
                "WHERE d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname=%s",
                (username,),
            )
            if cursor.fetchone()[0]:
                raise ValueError("Runtime role owns database objects; use a fresh dedicated role")
        # Refuse previously privileged memberships rather than silently revoking
        # an unrelated administrator's role or granting an escalation path.
        cursor.execute(
            "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member "
            "WHERE r.rolname=%s",
            (username,),
        )
        if cursor.fetchone()[0]:
            raise ValueError("Runtime role has memberships; review them before provisioning")
        cursor.execute(
            sql.SQL(
                "{} ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD {}"
            ).format(
                sql.SQL("ALTER" if exists else "CREATE"),
                sql.Identifier(username),
                sql.Literal(password),
            )
        )
        role = sql.Identifier(username)
        cursor.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), role)
        )
        cursor.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(role))
        # Grants to PUBLIC are inherited by every role even with NOINHERIT.
        cursor.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        cursor.execute(
            sql.SQL("REVOKE CREATE ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database))
        )
        cursor.execute(
            sql.SQL("REVOKE CREATE ON DATABASE {} FROM {}").format(sql.Identifier(database), role)
        )
        cursor.execute(sql.SQL("REVOKE CREATE ON SCHEMA public FROM {}").format(role))
        cursor.execute(
            sql.SQL(
                "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}"
            ).format(role)
        )
        cursor.execute(
            sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}").format(role)
        )
        cursor.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
            ).format(sql.Identifier(owner), role)
        )
        cursor.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                "GRANT USAGE, SELECT ON SEQUENCES TO {}"
            ).format(sql.Identifier(owner), role)
        )
        cursor.execute("SELECT to_regclass('public.alembic_version')")
        if cursor.fetchone()[0]:
            cursor.execute(
                sql.SQL(
                    "REVOKE INSERT, UPDATE, DELETE ON TABLE public.alembic_version FROM {}"
                ).format(role)
            )
        cursor.execute(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication FROM pg_roles WHERE rolname=%s",
            (username,),
        )
        if any(cursor.fetchone()):
            raise ValueError("Runtime role still has elevated privileges")
        cursor.execute(
            "SELECT has_schema_privilege(%s,'public','CREATE'), has_database_privilege(%s,%s,'CREATE')",
            (username, username, database),
        )
        if any(cursor.fetchone()):
            raise ValueError("Runtime role retains permanent DDL privileges")


def validate_separate_passwords(owner_password, runtime_password):
    if (
        not owner_password
        or not runtime_password
        or secrets.compare_digest(owner_password, runtime_password)
    ):
        raise ValueError("Owner and runtime secrets must be configured and different")


def main():
    if engine.dialect.name != "postgresql":
        raise SystemExit("Runtime role provisioning requires PostgreSQL")
    connection = engine.raw_connection()
    try:
        validate_separate_passwords(
            os.environ.get("DB_PASSWORD", ""), os.environ.get("DB_APP_PASSWORD", "")
        )
        provision_runtime_role(
            connection.driver_connection,
            os.environ.get("DB_APP_USER", "twinnku_app"),
            os.environ.get("DB_APP_PASSWORD", ""),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise SystemExit("Runtime role provisioning failed; credentials were not logged") from None
    finally:
        connection.close()
    print("Restricted runtime database role verified")


if __name__ == "__main__":
    main()
