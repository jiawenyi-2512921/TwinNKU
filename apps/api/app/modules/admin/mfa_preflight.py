"""Read-only rollout gate. Main and backup authenticators must each sign with UV.

Run inside the API image before switching ADMIN_MFA_ENFORCED=true. This checks
all active administrators, never registers a device, creates a session or enables
MFA. Having a code hash proves issuance, not that its holder saved it offline.
"""

import json

from sqlalchemy import select

from app.database import SessionLocal
from app.models import StaffUserRecord
from app.modules.admin.mfa import member_readiness


def enforcement_readiness(db):
    members = [
        member_readiness(db, user)
        for user in db.scalars(
            select(StaffUserRecord)
            .where(StaffUserRecord.role == "admin", StaffUserRecord.is_active.is_(True))
            .order_by(StaffUserRecord.username)
        )
    ]
    return {
        "ready": bool(members) and all(member["ready"] for member in members),
        "administrators": members,
    }


def main():
    with SessionLocal() as db:
        result = enforcement_readiness(db)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ready"] else 1)


if __name__ == "__main__":
    main()
