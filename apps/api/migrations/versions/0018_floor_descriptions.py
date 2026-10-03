"""Reviewed floor and section text equivalents; retain every original image.

Revision ID: 0018_floor_descriptions
Revises: 0017_content_controls
"""

import sqlalchemy as sa
from alembic import op

revision = "0018_floor_descriptions"
down_revision = "0017_content_controls"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("floors", sa.Column("description", sa.Text(), nullable=False, server_default=""))


def downgrade():
    op.drop_column("floors", "description")
