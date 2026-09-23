"""Versioned map catalog, geometries and explicit CLI review records."""

import sqlalchemy as sa
from alembic import op

revision = "0002_map_catalog"
down_revision = "0001_foundation"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "maps",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "campus_id",
            sa.String(64),
            sa.ForeignKey("campuses.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("width_px", sa.Integer(), nullable=False),
        sa.Column("height_px", sa.Integer(), nullable=False),
        sa.Column("image_asset_id", sa.String(36), nullable=False),
        sa.Column("source_sha256", sa.String(64), nullable=False),
        sa.Column("tile_size", sa.Integer(), nullable=False),
        sa.Column("max_native_zoom", sa.Integer(), nullable=False),
        sa.Column("attribution", sa.Text(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("visibility", sa.String(24), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_maps_revision"),
        sa.CheckConstraint("width_px > 0 AND height_px > 0", name="ck_maps_dimensions"),
        sa.CheckConstraint("status IN ('draft','published','retired')", name="ck_maps_status"),
        sa.CheckConstraint(
            "visibility IN ('public','internal','restricted')", name="ck_maps_visibility"
        ),
    )
    op.create_table(
        "point_geometries",
        sa.Column(
            "map_id", sa.String(36), sa.ForeignKey("maps.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "point_id",
            sa.String(36),
            sa.ForeignKey("points.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("map_revision", sa.Integer(), nullable=False),
        sa.Column("anchor", sa.JSON(), nullable=False),
        sa.Column("polygon", sa.JSON(), nullable=False),
        sa.Column("entrance_ids", sa.JSON(), nullable=False),
    )
    op.create_table(
        "map_imports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "map_id", sa.String(36), sa.ForeignKey("maps.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.Column("reviewer", sa.String(120), nullable=False),
        sa.Column("rights_note", sa.Text(), nullable=False),
        sa.Column("published", sa.Boolean(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("map_imports")
    op.drop_table("point_geometries")
    op.drop_table("maps")
