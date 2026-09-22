"""Foundation catalog. No reviewed campus content is seeded here."""

import sqlalchemy as sa
from alembic import op

revision = "0001_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "campuses",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "points",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "campus_id",
            sa.String(64),
            sa.ForeignKey("campuses.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("aliases", sa.JSON(), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("visibility", sa.String(24), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_points_revision"),
        sa.CheckConstraint(
            "status IN ('draft','in_review','published','retired')", name="ck_points_status"
        ),
        sa.CheckConstraint(
            "visibility IN ('public','internal','restricted')", name="ck_points_visibility"
        ),
        sa.CheckConstraint(
            "category IN ('public_area','patriotic','academic','residence','dining','commerce','landscape','history')",
            name="ck_points_category",
        ),
    )
    op.create_index("ix_points_public", "points", ["campus_id", "status", "visibility"])
    op.create_index("ix_points_category", "points", ["category"])


def downgrade():
    op.drop_table("points")
    op.drop_table("campuses")
