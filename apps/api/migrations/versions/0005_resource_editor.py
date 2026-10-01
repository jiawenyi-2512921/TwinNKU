"""Reviewed floor image uploads and panorama links."""

import sqlalchemy as sa
from alembic import op

revision = "0005_resource_editor"
down_revision = "0004_admin_console"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "floor_uploads",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "point_id",
            sa.String(36),
            sa.ForeignKey("points.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "uploaded_by",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("image", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_floor_uploads_point_id", "floor_uploads", ["point_id"])
    op.create_table(
        "panoramas",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "point_id",
            sa.String(36),
            sa.ForeignKey("points.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_panorama_revision"),
        sa.CheckConstraint("status IN ('published','retired')", name="ck_panorama_status"),
    )
    op.create_index("ix_panoramas_point_id", "panoramas", ["point_id"])
    op.create_table(
        "resource_changes",
        sa.Column("resource_id", sa.String(36), primary_key=True),
        sa.Column(
            "point_id",
            sa.String(36),
            sa.ForeignKey("points.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("contributor_ids", sa.JSON(), nullable=False),
        sa.Column(
            "editor_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "submitted_by",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('floor','panorama')", name="ck_resource_kind"),
        sa.CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_resource_state",
        ),
        sa.CheckConstraint("operation IN ('upsert','retire')", name="ck_resource_operation"),
        sa.CheckConstraint("revision >= 1 AND base_revision >= 0", name="ck_resource_revision"),
    )
    op.create_index("ix_resource_changes_point_id", "resource_changes", ["point_id"])
    op.create_index("ix_resource_changes_state", "resource_changes", ["state"])


def downgrade():
    op.drop_table("resource_changes")
    op.drop_table("panoramas")
    op.drop_table("floor_uploads")
