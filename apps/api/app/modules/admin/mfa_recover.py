"""Auditable server-console recovery; never creates a browser login/session/token."""

import argparse
import getpass
import secrets
import sys
from datetime import timedelta

from sqlalchemy import delete, select

from app.database import SessionLocal
from app.models import StaffCredentialRecord, StaffRecoveryCodeRecord, StaffUserRecord, now_utc
from app.modules.admin.security import audit, hash_password, revoke_sessions


def recover_account(db, *, username, reason, new_password=None):
    if not reason.strip():
        raise ValueError("A maintenance reason is required")
    target = db.scalar(
        select(StaffUserRecord)
        .where(StaffUserRecord.username == username)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not target or not target.is_active:
        raise ValueError("Target must be an existing active staff member")
    replacement = hash_password(new_password) if new_password is not None else None
    identity_name = "maintenance.mfa-recovery"
    actor = db.scalar(select(StaffUserRecord).where(StaffUserRecord.username == identity_name))
    if not actor:
        actor = StaffUserRecord(
            username=identity_name,
            display_name="服务器MFA恢复（不可登录）",
            role="viewer",
            campus_ids=[],
            point_ids=[],
            is_active=False,
            must_change_password=True,
            password_hash=hash_password(secrets.token_urlsafe(48)),
        )
        db.add(actor)
        db.flush()
    if actor.is_active or actor.role != "viewer" or actor.campus_ids or actor.point_ids:
        raise ValueError("Maintenance audit identity must remain disabled and without scope")
    db.execute(delete(StaffCredentialRecord).where(StaffCredentialRecord.user_id == target.id))
    db.execute(delete(StaffRecoveryCodeRecord).where(StaffRecoveryCodeRecord.user_id == target.id))
    target.mfa_enabled, target.mfa_recovery_until = True, now_utc() + timedelta(minutes=15)
    if new_password is not None:
        target.password_hash = replacement
        target.must_change_password = True
    target.revision += 1
    revoke_sessions(db, target.id)
    audit(
        db,
        actor,
        "user.mfa_console_recovery",
        note=reason.strip(),
        details={
            "target_id": target.id,
            "rebind_minutes": 15,
            "password_reset": new_password is not None,
        },
    )
    # Caller owns the transaction; recovery never alters account role or scope.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--reset-password", action="store_true")
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise SystemExit("Use an authenticated interactive maintenance console")
    if (
        input(f"Type RESET {args.username} to permit 15-minute MFA re-enrollment: ")
        != f"RESET {args.username}"
    ):
        raise SystemExit("Recovery cancelled")
    new_password = None
    if args.reset_password:
        new_password = getpass.getpass("Temporary password (not displayed): ")
        if new_password != getpass.getpass("Confirm temporary password: "):
            raise SystemExit("Password confirmation did not match")
    with SessionLocal.begin() as db:
        recover_account(db, username=args.username, reason=args.reason, new_password=new_password)
    print(
        "Recovery recorded. The member must log in with their own password and re-enroll within 15 minutes."
    )


if __name__ == "__main__":
    main()
