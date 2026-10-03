"""Independent staff backup permissions and fixed-host task queue."""

import sqlalchemy as sa
from alembic import op

revision = "0020_backup_jobs"
down_revision = "0019_vr_checks"
branch_labels = None
depends_on = None


def upgrade():
    def staff():
        return sa.ForeignKey("staff_users.id", ondelete="RESTRICT")

    def time(name, nullable=False):
        return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)

    op.create_table(
        "backup_grants",
        sa.Column("user_id", sa.String(36), staff(), primary_key=True),
        sa.Column("permission", sa.String(32), primary_key=True),
        sa.Column("granted_by", sa.String(36), staff(), nullable=False),
        sa.Column("note", sa.String(500), nullable=False),
        time("updated_at"),
        sa.CheckConstraint(
            "permission IN ('backup.read','backup.request')", name="ck_backup_permission"
        ),
    )
    op.create_table(
        "backup_control",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_backup_control_singleton"),
    )
    op.create_table(
        "backup_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), staff(), nullable=False),
        sa.Column("operation_id", sa.String(36), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("request_session_id", sa.String(36), nullable=False),
        time("mfa_verified_at"),
        time("authorized_until"),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("phase", sa.String(16), nullable=False),
        time("created_at"),
        time("started_at", True),
        time("finished_at", True),
        time("lease_until", True),
        sa.Column("execution_id", sa.String(36), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False),
        sa.Column("cancel_operation_id", sa.String(36), nullable=True),
        sa.Column("failure_code", sa.String(48), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.UniqueConstraint("user_id", "operation_id", name="uq_backup_operation"),
        sa.CheckConstraint(
            "state IN ('queued','running','succeeded','failed','unknown','cancelled','expired')",
            name="ck_backup_state",
        ),
        sa.CheckConstraint(
            "phase IN ('queued','preflight','dump','encrypt','retention','integrity','complete')",
            name="ck_backup_phase",
        ),
    )
    for column in ("user_id", "state", "created_at"):
        op.create_index("ix_backup_jobs_" + column, "backup_jobs", [column])
    op.create_table(
        "backup_status",
        sa.Column("id", sa.Integer(), primary_key=True),
        time("observed_at"),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_backup_status_singleton"),
    )
    op.execute("INSERT INTO backup_control (id, generation) VALUES (1, 0)")


def downgrade():
    for table in ("backup_status", "backup_jobs", "backup_control", "backup_grants"):
        op.drop_table(table)
