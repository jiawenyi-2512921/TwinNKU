"""admin console and point annotations"""

import sqlalchemy as sa
from alembic import op

revision = "0004_admin_console"
down_revision = "0003_floor_plans"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "admin_login_limits",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("window_started", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "staff_users",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("role", sa.String(length=24), nullable=False),
        sa.Column("campus_ids", sa.JSON(), nullable=False),
        sa.Column("point_ids", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('admin','reviewer','editor','viewer')", name="ck_staff_role"),
        sa.CheckConstraint("revision >= 1", name="ck_staff_revision"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
    )
    op.create_table(
        "staff_sessions",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("csrf_token", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["staff_users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("token_hash"),
    )
    op.create_index(
        op.f("ix_staff_sessions_expires_at"), "staff_sessions", ["expires_at"], unique=False
    )
    op.create_index(op.f("ix_staff_sessions_user_id"), "staff_sessions", ["user_id"], unique=False)
    op.create_table(
        "admin_audit",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("actor_id", sa.String(length=36), nullable=False),
        sa.Column("actor_name", sa.String(length=80), nullable=False),
        sa.Column("action", sa.String(length=48), nullable=False),
        sa.Column("campus_id", sa.String(length=64), nullable=True),
        sa.Column("point_id", sa.String(length=36), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["staff_users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["campus_id"], ["campuses.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["point_id"], ["points.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_admin_audit_created_at"), "admin_audit", ["created_at"], unique=False)
    op.create_index(
        "ix_admin_audit_point_time", "admin_audit", ["point_id", "created_at"], unique=False
    )
    op.create_table(
        "point_changes",
        sa.Column("point_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("base_revision", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=24), nullable=False),
        sa.Column("operation", sa.String(length=16), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("contributor_ids", sa.JSON(), nullable=False),
        sa.Column("editor_id", sa.String(length=36), nullable=False),
        sa.Column("submitted_by", sa.String(length=36), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("operation IN ('upsert','retire')", name="ck_point_change_operation"),
        sa.CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_point_change_state",
        ),
        sa.CheckConstraint("revision >= 1 AND base_revision >= 1", name="ck_point_change_revision"),
        sa.ForeignKeyConstraint(["editor_id"], ["staff_users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["point_id"], ["points.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["submitted_by"], ["staff_users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("point_id"),
    )
    op.create_index(op.f("ix_point_changes_state"), "point_changes", ["state"], unique=False)
    op.add_column(
        "point_geometries",
        sa.Column("label_on_map", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.execute(
        sa.text(
            "UPDATE point_geometries SET label_on_map = true WHERE point_id = '82e888ca-59f8-5c55-b8ab-4b80175c6ceb'"
        )
    )


def downgrade():
    op.drop_column("point_geometries", "label_on_map")
    op.drop_index(op.f("ix_point_changes_state"), table_name="point_changes")
    op.drop_table("point_changes")
    op.drop_index("ix_admin_audit_point_time", table_name="admin_audit")
    op.drop_index(op.f("ix_admin_audit_created_at"), table_name="admin_audit")
    op.drop_table("admin_audit")
    op.drop_index(op.f("ix_staff_sessions_user_id"), table_name="staff_sessions")
    op.drop_index(op.f("ix_staff_sessions_expires_at"), table_name="staff_sessions")
    op.drop_table("staff_sessions")
    op.drop_table("staff_users")
    op.drop_table("admin_login_limits")
