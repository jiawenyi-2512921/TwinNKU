"""Reviewed media, check-in recommendations and campus tour sequences."""

import sqlalchemy as sa
from alembic import op

revision = "0007_experiences"
down_revision = "0006_navigation"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "experience_uploads",
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
        sa.Column("media_type", sa.String(16), nullable=False),
        sa.Column("mime_type", sa.String(48), nullable=False),
        sa.Column("filename", sa.String(80), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_experience_uploads_point_id", "experience_uploads", ["point_id"])
    op.create_table(
        "experiences",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "point_id",
            sa.String(36),
            sa.ForeignKey("points.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("published_revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("draft", sa.JSON(), nullable=True),
        sa.Column("published", sa.JSON(), nullable=True),
        sa.Column("contributor_ids", sa.JSON(), nullable=False),
        sa.Column(
            "submitted_by",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('media','checkin','tour')", name="ck_experiences_kind"),
        sa.CheckConstraint(
            "status IN ('draft','published','retired')", name="ck_experiences_status"
        ),
        sa.CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_experiences_state",
        ),
        sa.CheckConstraint("operation IN ('upsert','retire')", name="ck_experiences_operation"),
        sa.CheckConstraint(
            "revision >= 1 AND published_revision >= 0", name="ck_experiences_revision"
        ),
    )
    op.create_index("ix_experiences_point_id", "experiences", ["point_id"])
    op.create_index("ix_experiences_state", "experiences", ["state"])


def downgrade():
    op.drop_table("experiences")
    op.drop_table("experience_uploads")
