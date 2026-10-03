import sys

from sqlalchemy import select

from app.database import SessionLocal
from app.models import CampusRecord


def main():
    with SessionLocal.begin() as db:
        if "--first-install" in sys.argv and db.scalar(select(CampusRecord.id).limit(1)):
            raise SystemExit("First-install seed refused: existing campus data preserved")
        if db.get(CampusRecord, "nku-jinnan") is None:
            db.add(
                CampusRecord(
                    id="nku-jinnan",
                    name="南开大学津南校区",
                    description="校园文化与主题导览",
                    is_active=True,
                )
            )
    print("Campus metadata ready. No points or private media were imported.")


if __name__ == "__main__":
    main()
