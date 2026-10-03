"""Owner-private bounded table import jobs; no business content rewrite.

Revision ID: 0016_import_jobs
Revises: 0015_content_history
"""

import sqlalchemy as sa
from alembic import op

revision = "0016_import_jobs"
down_revision = "0015_content_history"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "import_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("operation_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("filename", sa.String(200), nullable=False),
        sa.Column("source_sha256", sa.String(64), nullable=False),
        sa.Column("byte_size", sa.Integer, nullable=False),
        *[sa.Column(name, sa.JSON, nullable=False) for name in ("columns", "rows", "mapping", "preview", "result")],
        sa.Column("preview_sha256", sa.String(64), nullable=False),
        sa.Column("commit_operation", sa.String(36), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "operation_id", name="uq_import_operation"),
        sa.CheckConstraint("kind IN ('point','vr','tour','media')", name="ck_import_kind"),
        sa.CheckConstraint("state IN ('uploading','checked','committed','failed')", name="ck_import_state"),
    )
    op.create_index("ix_import_jobs_user_id", "import_jobs", ["user_id"])
    op.create_index("ix_import_jobs_expires_at", "import_jobs", ["expires_at"])


def downgrade():
    op.drop_table("import_jobs")
