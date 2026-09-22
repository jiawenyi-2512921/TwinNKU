from app.database import SessionLocal
from app.models import CampusRecord


def main():
    with SessionLocal.begin() as db:
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
