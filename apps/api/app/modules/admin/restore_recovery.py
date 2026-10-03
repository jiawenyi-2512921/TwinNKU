"""Console-only re-enrollment after a verified database-restore quarantine.

The operator verifies the member and CURRENT role/scope outside the old backup.
This never restores old credentials, sessions, grants, or a business session.
"""

import argparse
import getpass
import re
import sys
from datetime import timedelta

from sqlalchemy import delete, select

from app.backup_models import BackupGrantRecord
from app.configuration_models import ConfigurationGrantRecord
from app.contracts import StaffUserInput
from app.database import SessionLocal
from app.models import (
    AdminAuditRecord,
    StaffCredentialRecord,
    StaffRecoveryCodeRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.security import audit, hash_password, revoke_sessions
from app.modules.admin.service import validate_scope

ACTOR_NAME = "maintenance.database-restore"


def enroll_restored_member(db, *, username, expected_revision, role, campus_ids, point_ids,
                           password, reason):
    if not 5 <= len(reason.strip()) <= 500 or any(ord(char) < 32 for char in reason):
        raise ValueError("Record the current identity and permission verification basis")
    target = db.scalar(select(StaffUserRecord).where(StaffUserRecord.username == username)
                       .with_for_update().execution_options(populate_existing=True))
    if (target is None or target.is_active or username.startswith("maintenance.")
            or target.revision != expected_revision
            or not re.fullmatch(r"!restore:[0-9a-f]{64}", target.password_hash)):
        raise ValueError("Member is not at the reviewed restore-quarantine revision")
    actor = db.scalar(select(StaffUserRecord).where(StaffUserRecord.username == ACTOR_NAME).with_for_update())
    if actor is None or actor.is_active or actor.role != "viewer" or actor.campus_ids or actor.point_ids:
        raise ValueError("The disabled restore audit identity is unavailable")
    latest = db.scalar(select(AdminAuditRecord).where(
        AdminAuditRecord.actor_id == actor.id,
        AdminAuditRecord.action == "system.restore_quarantine",
    ).order_by(AdminAuditRecord.created_at.desc(), AdminAuditRecord.id.desc()).limit(1))
    if latest is None or latest.details.get("batch_sha256") != target.password_hash.removeprefix("!restore:"):
        raise ValueError("Member does not match the latest verified recovery batch")
    permissions = StaffUserInput(display_name=target.display_name, role=role,
                                 campus_ids=campus_ids, point_ids=point_ids)
    validate_scope(db, permissions)
    replacement = hash_password(password)
    # Recheck every local factor/grant, including changes made during maintenance.
    for model in (StaffCredentialRecord, StaffRecoveryCodeRecord,
                  ConfigurationGrantRecord, BackupGrantRecord):
        db.execute(delete(model).where(model.user_id == target.id))
    revoke_sessions(db, target.id)
    target.password_hash = replacement
    target.role = permissions.role
    target.campus_ids = permissions.campus_ids
    target.point_ids = [str(key) for key in permissions.point_ids]
    target.is_active = True
    target.must_change_password = True
    target.mfa_enabled = True
    target.mfa_recovery_until = now_utc() + timedelta(minutes=15)
    target.revision += 1
    target.updated_at = now_utc()
    audit(db, actor, "user.restore_reenrollment", note=reason.strip(), details={
        "target_id": target.id, "batch_sha256": latest.details["batch_sha256"],
        "role": target.role, "campus_ids": target.campus_ids, "point_ids": target.point_ids,
        "from_revision": expected_revision, "to_revision": target.revision,
        "rebind_minutes": 15, "business_session_created": False,
    })
    # Caller commits. No policy, stop, budget, content or contributor is changed.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--expected-revision", type=int, required=True)
    parser.add_argument("--role", choices=("admin", "reviewer", "editor", "viewer"), required=True)
    parser.add_argument("--campus-id", action="append", default=[])
    parser.add_argument("--point-id", action="append", default=[])
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise SystemExit("Use an authenticated interactive maintenance console")
    print("Verify this member's current identity, role and scope using records outside the old backup.")
    if input(f"Type REENROLL {args.username} AS {args.role}: ") != f"REENROLL {args.username} AS {args.role}":
        raise SystemExit("Re-enrollment cancelled")
    password = getpass.getpass("New temporary password (not displayed): ")
    if password != getpass.getpass("Confirm new temporary password: "):
        raise SystemExit("Password confirmation did not match")
    with SessionLocal.begin() as db:
        enroll_restored_member(db, username=args.username, expected_revision=args.expected_revision,
                               role=args.role, campus_ids=args.campus_id, point_ids=args.point_id,
                               password=password, reason=args.reason)
    print("Recorded. Member must change the temporary password and verify their own authenticator within 15 minutes.")


if __name__ == "__main__":
    main()
