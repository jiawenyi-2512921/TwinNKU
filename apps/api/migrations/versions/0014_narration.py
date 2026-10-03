"""Durable narration jobs and immutable assets, without rewriting route JSON."""

import sqlalchemy as sa
from alembic import op

revision = "0014_narration"
down_revision = "0013_configurations"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "narration_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("tour_id", sa.String(36), sa.ForeignKey("experiences.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("point_id", sa.String(36), sa.ForeignKey("points.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("segment_id", sa.String(64), nullable=False),
        sa.Column("source_revision", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("operation_id", sa.String(36), nullable=False),
        sa.Column("request_sha256", sa.String(64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("text_sha256", sa.String(64), nullable=False),
        sa.Column("profile", sa.JSON(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("chunks", sa.JSON(), nullable=False),
        sa.Column("completed_chunks", sa.JSON(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("lease_version", sa.Integer(), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("created_by", "operation_id", "segment_id", name="uq_narration_operation_segment"),
        sa.CheckConstraint("state IN ('queued','running','ready','failed','unknown','cancelled','paused')", name="ck_narration_job_state"),
        sa.CheckConstraint("attempts >= 0 AND lease_version >= 0", name="ck_narration_job_counters"),
    )
    for column in ("tour_id", "fingerprint", "state"):
        op.create_index("ix_narration_jobs_" + column, "narration_jobs", [column])
    op.create_table(
        "narration_assets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("job_id", sa.String(36), sa.ForeignKey("narration_jobs.id", ondelete="RESTRICT"), nullable=False, unique=True),
        sa.Column("tour_id", sa.String(36), sa.ForeignKey("experiences.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("point_id", sa.String(36), sa.ForeignKey("points.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("segment_id", sa.String(64), nullable=False),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("text_sha256", sa.String(64), nullable=False),
        sa.Column("spoken_sha256", sa.String(64), nullable=False),
        sa.Column("profile", sa.JSON(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.Column("chunks", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_narration_assets_tour_id", "narration_assets", ["tour_id"])


def downgrade():
    op.drop_table("narration_assets")
    op.drop_table("narration_jobs")
