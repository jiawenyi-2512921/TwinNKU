"""Reviewed VR presentation and independent point-bound manual evidence.

Revision ID: 0019_vr_checks
Revises: 0018_floor_descriptions
"""

import sqlalchemy as sa
from alembic import op

revision = "0019_vr_checks"
down_revision = "0018_floor_descriptions"
branch_labels = None
depends_on = None


def upgrade():
    for column in (
        sa.Column("observation_prompt", sa.Text(), nullable=False, server_default=""),
        sa.Column("cover_image_id", sa.String(36), nullable=True),
        sa.Column("cover_image_revision", sa.Integer(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("verification_generation", sa.Integer(), nullable=False, server_default="1"),
    ):
        op.add_column("panoramas", column)
    op.create_table(
        "panorama_verifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("operation_id", sa.String(36), nullable=False, unique=True),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.Column("resource_id", sa.String(36), nullable=False),
        sa.Column("point_id", sa.String(36), sa.ForeignKey("points.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("url_sha256", sa.String(64), nullable=False),
        sa.Column("dimension", sa.String(16), nullable=False),
        sa.Column("platform", sa.String(16), nullable=True),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(40), nullable=False),
        sa.Column("environment", sa.String(200), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("recorded_by", sa.String(36), sa.ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("generation >= 1", name="ck_vr_check_generation"),
        sa.CheckConstraint("dimension IN ('technical','scene','device')", name="ck_vr_check_dimension"),
        sa.CheckConstraint("result IN ('passed','failed','uncertain')", name="ck_vr_check_result"),
        sa.CheckConstraint("(dimension = 'device' AND platform IS NOT NULL AND platform IN ('desktop','android','ios','wechat')) OR (dimension != 'device' AND platform IS NULL)", name="ck_vr_check_platform"),
    )
    op.create_index("ix_vr_check_source", "panorama_verifications", ["resource_id", "generation", "url_sha256", "recorded_at"])


def downgrade():
    op.drop_table("panorama_verifications")
    for column in ("verification_generation", "sort_order", "cover_image_revision", "cover_image_id", "observation_prompt"):
        op.drop_column("panoramas", column)
