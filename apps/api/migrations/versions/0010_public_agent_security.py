"""Persistent visitor sessions, atomic paid budgets and scoped capabilities."""

from alembic import op

from app.integrations.public_agent_security import (
    PublicAgentCapability,
    PublicAgentCounter,
    PublicAgentLease,
    PublicAgentRequest,
    PublicAgentSession,
)

revision = "0010_public_agent_security"
down_revision = "0009_staff_mfa"
branch_labels = None
depends_on = None

TABLES = (
    PublicAgentSession,
    PublicAgentCounter,
    PublicAgentLease,
    PublicAgentRequest,
    PublicAgentCapability,
)


def upgrade():
    for model in TABLES:
        model.__table__.create(op.get_bind())


def downgrade():
    for model in reversed(TABLES):
        model.__table__.drop(op.get_bind())
