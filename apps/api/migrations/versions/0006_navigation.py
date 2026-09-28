"""Reviewed road graph; does not alter existing map geometry or resources."""

import sqlalchemy as sa
from alembic import op

revision = "0006_navigation"
down_revision = "0005_resource_editor"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "guide_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "navigation_graphs",
        sa.Column(
            "map_id", sa.String(36), sa.ForeignKey("maps.id", ondelete="RESTRICT"), primary_key=True
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("published_revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("draft", sa.JSON(), nullable=True),
        sa.Column("published", sa.JSON(), nullable=True),
        sa.Column("contributor_ids", sa.JSON(), nullable=False),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("guide_settings")
    op.drop_table("navigation_graphs")
