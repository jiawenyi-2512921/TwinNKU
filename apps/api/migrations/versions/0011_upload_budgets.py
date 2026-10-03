"""Atomic upload disk budgets and concurrent reservation bookkeeping."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0011_upload_budgets"
down_revision = "0010_public_agent_security"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    # Freeze this revision's schema: the live ORM may include columns from later migrations.
    budget_table = op.create_table(
        "upload_budgets",
        sa.Column("scope", sa.String(100), primary_key=True),
        sa.Column("used_bytes", sa.BigInteger(), nullable=False),
        sa.Column("reserved_bytes", sa.BigInteger(), nullable=False),
        sa.Column("active_uploads", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "used_bytes >= 0 AND reserved_bytes >= 0 AND active_uploads >= 0",
            name="ck_upload_budget_nonnegative",
        ),
    )
    reservations = op.create_table(
        "upload_reservations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("upload_id", sa.String(80), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("campus_id", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["staff_users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["campus_id"], ["campuses.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("kind", "upload_id", name="uq_upload_reservation_asset"),
        sa.CheckConstraint(
            "state IN ('reserved','complete','failed','orphaned','quarantined')",
            name="ck_upload_reservation_state",
        ),
        sa.CheckConstraint("size_bytes >= 0", name="ck_upload_reservation_size"),
    )
    for column in ("user_id", "campus_id", "state", "expires_at"):
        op.create_index("ix_upload_reservations_" + column, "upload_reservations", [column])

    points = sa.table("points", sa.column("id", sa.String(36)), sa.column("campus_id", sa.String(64)))
    budgets = {"global": 0}
    for name, kind in (("floor_uploads", "floor"), ("experience_uploads", "media")):
        uploads = sa.table(
            name,
            sa.column("id", sa.String(36)),
            sa.column("point_id", sa.String(36)),
            sa.column("uploaded_by", sa.String(36)),
            sa.column("created_at", sa.DateTime(timezone=True)),
            sa.column("image", sa.JSON()) if kind == "floor" else sa.column("size_bytes", sa.Integer()),
        )
        rows = bind.execute(
            sa.select(uploads, points.c.campus_id).select_from(
                uploads.join(points, uploads.c.point_id == points.c.id)
            )
        ).mappings()
        for record in rows:
            size = record["image"]["size_bytes"] if kind == "floor" else record["size_bytes"]
            campus_id = record["campus_id"]
            for scope in ("actor:" + record["uploaded_by"], "campus:" + campus_id):
                budgets[scope] = budgets.get(scope, 0) + size
            bind.execute(
                reservations.insert().values(
                    id=str(uuid4()),
                    kind=kind,
                    upload_id=record["id"],
                    user_id=record["uploaded_by"],
                    campus_id=campus_id,
                    size_bytes=size,
                    state="complete",
                    created_at=record["created_at"],
                    expires_at=datetime.now(UTC) + timedelta(minutes=20),
                )
            )
    # Published source copies have no reliable historical publisher identity. Campus only.
    floors = sa.table("floors", sa.column("point_id", sa.String(36)), sa.column("images", sa.JSON()))
    for images, campus_id in bind.execute(
        sa.select(floors.c.images, points.c.campus_id).select_from(
            floors.join(points, floors.c.point_id == points.c.id)
        )
    ):
        scope = "campus:" + campus_id
        budgets[scope] = budgets.get(scope, 0) + sum(i.get("size_bytes", 0) for i in images)
    bind.execute(
        budget_table.insert(),
        [dict(scope=scope, used_bytes=size, reserved_bytes=0, active_uploads=0) for scope, size in budgets.items()],
    )


def downgrade():
    op.drop_table("upload_reservations")
    op.drop_table("upload_budgets")
