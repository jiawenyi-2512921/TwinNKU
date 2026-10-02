"""Atomic upload disk budgets and concurrent reservation bookkeeping."""

from datetime import timedelta

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    ExperienceUploadRecord,
    FloorRecord,
    FloorUploadRecord,
    PointRecord,
    UploadBudgetRecord,
    UploadReservationRecord,
    now_utc,
)

revision = "0011_upload_budgets"
down_revision = "0010_public_agent_security"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    UploadBudgetRecord.__table__.create(bind)
    UploadReservationRecord.__table__.create(bind)
    with Session(bind) as db:
        budgets = {"global": 0}
        for model, kind in ((FloorUploadRecord, "floor"), (ExperienceUploadRecord, "media")):
            for record, campus_id in db.execute(
                select(model, PointRecord.campus_id).join(
                    PointRecord, model.point_id == PointRecord.id
                )
            ):
                size = record.image["size_bytes"] if kind == "floor" else record.size_bytes
                for scope in ("actor:" + record.uploaded_by, "campus:" + campus_id):
                    budgets[scope] = budgets.get(scope, 0) + size
                db.add(
                    UploadReservationRecord(
                        kind=kind,
                        upload_id=record.id,
                        user_id=record.uploaded_by,
                        campus_id=campus_id,
                        size_bytes=size,
                        state="complete",
                        created_at=record.created_at,
                        expires_at=now_utc() + timedelta(minutes=20),
                    )
                )
        # Published source copies have no reliable historical publisher identity. Campus only.
        for floor, campus_id in db.execute(
            select(FloorRecord, PointRecord.campus_id).join(
                PointRecord, FloorRecord.point_id == PointRecord.id
            )
        ):
            scope = "campus:" + campus_id
            budgets[scope] = budgets.get(scope, 0) + sum(
                i.get("size_bytes", 0) for i in floor.images
            )
        for scope, size in budgets.items():
            db.add(
                UploadBudgetRecord(scope=scope, used_bytes=size, reserved_bytes=0, active_uploads=0)
            )
        db.flush()
        db.commit()


def downgrade():
    UploadReservationRecord.__table__.drop(op.get_bind())
    UploadBudgetRecord.__table__.drop(op.get_bind())
