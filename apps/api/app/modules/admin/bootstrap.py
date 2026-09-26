"""Create the first administrator locally; no passwords in argv, logs or source."""

import argparse
import getpass

from pydantic import TypeAdapter
from sqlalchemy import func, select

from app.contracts import StaffUsername
from app.database import SessionLocal
from app.models import StaffUserRecord
from app.modules.admin.security import audit, hash_password


def main():
    parser = argparse.ArgumentParser(description="Create the first Twin NKU administrator")
    parser.add_argument("--username", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    username = TypeAdapter(StaffUsername).validate_python(args.username)
    if not args.name.strip() or len(args.name) > 80:
        raise SystemExit("Display name must have 1–80 characters")
    with SessionLocal() as db:
        # A PostgreSQL transaction lock serializes first-admin creation across consoles.
        if db.bind.dialect.name == "postgresql":
            db.execute(select(func.pg_advisory_xact_lock(74260101)))
        if db.scalar(select(func.count()).select_from(StaffUserRecord)):
            raise SystemExit("Staff accounts already exist; use the administrator interface")
        password = getpass.getpass("Administrator password (12+ characters): ")
        if password != getpass.getpass("Repeat password: "):
            raise SystemExit("Passwords do not match")
        user = StaffUserRecord(
            username=username,
            display_name=args.name.strip(),
            role="admin",
            password_hash=hash_password(password),
            campus_ids=[],
            point_ids=[],
            is_active=True,
            must_change_password=False,
        )
        db.add(user)
        db.flush()
        audit(db, user, "user.bootstrap", note="First administrator created through server console")
        db.commit()
    print("Administrator created. Password was not printed or written to a file.")


if __name__ == "__main__":
    main()
