"""Staged WebAuthn enrollment, restricted challenges and offline recovery codes."""

import sqlalchemy as sa
from alembic import op

revision = "0009_staff_mfa"
down_revision = "0008_campus_tours"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "staff_users",
        sa.Column("mfa_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("staff_users", sa.Column("mfa_recovery_until", sa.DateTime(timezone=True)))
    # Sessions predating MFA have no proof of their authentication level.
    op.execute(sa.text("DELETE FROM staff_sessions"))
    op.add_column(
        "staff_sessions", sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False)
    )
    op.add_column("staff_sessions", sa.Column("mfa_verified_at", sa.DateTime(timezone=True)))
    op.create_table(
        "staff_credentials",
        sa.Column("credential_id", sa.String(1400), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("transports", sa.JSON(), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False),
        sa.Column("backup_eligible", sa.Boolean(), nullable=False),
        sa.Column("backed_up", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_staff_credentials_user_id", "staff_credentials", ["user_id"])
    op.create_table(
        "staff_mfa_challenges",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_revision", sa.Integer(), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("challenge", sa.String(64)),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("credential_name", sa.String(80), nullable=False),
        sa.Column("bound_credential_id", sa.String(1400)),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_staff_mfa_challenges_user_id", "staff_mfa_challenges", ["user_id"])
    op.create_index("ix_staff_mfa_challenges_expires_at", "staff_mfa_challenges", ["expires_at"])
    op.create_table(
        "staff_recovery_codes",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_staff_recovery_codes_user_id", "staff_recovery_codes", ["user_id"])


def downgrade():
    # Never downgrade an authenticated MFA session into a password-only session.
    op.execute(sa.text("DELETE FROM staff_sessions"))
    for table in ("staff_recovery_codes", "staff_mfa_challenges", "staff_credentials"):
        op.drop_table(table)
    with op.batch_alter_table("staff_sessions") as batch:
        batch.drop_column("mfa_verified_at")
        batch.drop_column("last_activity_at")
    with op.batch_alter_table("staff_users") as batch:
        batch.drop_column("mfa_recovery_until")
        batch.drop_column("mfa_enabled")
