"""Public random session IDs for self-service revocation.

Revision ID: 0012_staff_session_ids
Revises: 0011_upload_budgets
"""

from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0012_staff_session_ids"
down_revision = "0011_upload_budgets"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("staff_sessions", sa.Column("public_id", sa.String(36), nullable=True))
    table = sa.table(
        "staff_sessions",
        sa.column("token_hash", sa.String(64)),
        sa.column("public_id", sa.String(36)),
    )
    connection = op.get_bind()
    # Existing authentication cookies, hashes and timestamps stay intact.
    for token_hash in connection.execute(sa.select(table.c.token_hash)).scalars().all():
        connection.execute(
            table.update().where(table.c.token_hash == token_hash).values(public_id=str(uuid4()))
        )
    with op.batch_alter_table("staff_sessions") as batch:
        batch.alter_column("public_id", existing_type=sa.String(36), nullable=False)
        batch.create_index("ix_staff_sessions_public_id", ["public_id"], unique=True)


def downgrade():
    with op.batch_alter_table("staff_sessions") as batch:
        batch.drop_index("ix_staff_sessions_public_id")
        batch.drop_column("public_id")
