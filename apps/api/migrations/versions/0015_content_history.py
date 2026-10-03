"""Immutable content history, idempotent writes and exact submissions.

Revision ID: 0015_content_history
Revises: 0014_narration
"""

import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0015_content_history"
down_revision = "0014_narration"
branch_labels = None
depends_on = None


def fingerprint(content, operation):
    return hashlib.sha256(
        json.dumps(
            {"content": content, "operation": operation},
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def upgrade():
    op.create_table(
        "experience_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "experience_id",
            sa.String(36),
            sa.ForeignKey("experiences.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("event", sa.String(24), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("published_revision", sa.Integer, nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("content", sa.JSON, nullable=True),
        sa.Column("published_content", sa.JSON, nullable=True),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("contributor_ids", sa.JSON, nullable=False),
        sa.Column(
            "actor_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_experience_versions_experience_id", "experience_versions", ["experience_id"]
    )
    op.create_index("ix_experience_versions_created_at", "experience_versions", ["created_at"])
    op.create_table(
        "experience_operations",
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column(
            "target_id",
            sa.String(36),
            sa.ForeignKey("experiences.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index("ix_experience_operations_target_id", "experience_operations", ["target_id"])
    op.create_table(
        "experience_submissions",
        sa.Column(
            "experience_id",
            sa.String(36),
            sa.ForeignKey("experiences.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("contributor_ids", sa.JSON, nullable=False),
        sa.Column(
            "submitted_by",
            sa.String(36),
            sa.ForeignKey("staff_users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Begin reliable history from migration. Preserve real pending bytes without
    # inventing past submit times or claiming a reviewer approved them.
    connection = op.get_bind()
    experience = sa.table(
        "experiences",
        *[
            sa.column(name, kind)
            for name, kind in (
                ("id", sa.String),
                ("revision", sa.Integer),
                ("published_revision", sa.Integer),
                ("operation", sa.String),
                ("draft", sa.JSON),
                ("published", sa.JSON),
                ("contributor_ids", sa.JSON),
                ("submitted_by", sa.String),
                ("state", sa.String),
            )
        ],
    )
    versions = sa.table(
        "experience_versions",
        *[
            sa.column(name, kind)
            for name, kind in (
                ("id", sa.String),
                ("experience_id", sa.String),
                ("event", sa.String),
                ("revision", sa.Integer),
                ("published_revision", sa.Integer),
                ("operation", sa.String),
                ("content", sa.JSON),
                ("published_content", sa.JSON),
                ("content_sha256", sa.String),
                ("contributor_ids", sa.JSON),
                ("actor_id", sa.String),
                ("created_at", sa.DateTime(timezone=True)),
            )
        ],
    )
    submissions = sa.table(
        "experience_submissions",
        sa.column("experience_id", sa.String),
        sa.column("revision", sa.Integer),
        sa.column("content_sha256", sa.String),
        sa.column("contributor_ids", sa.JSON),
        sa.column("submitted_by", sa.String),
        sa.column("submitted_at", sa.DateTime(timezone=True)),
    )
    for row in connection.execute(sa.select(experience)).mappings():
        digest = fingerprint(row["draft"], row["operation"])
        connection.execute(
            versions.insert().values(
                id=str(uuid4()),
                experience_id=row["id"],
                event="migration",
                revision=row["revision"],
                published_revision=row["published_revision"],
                operation=row["operation"],
                content=row["draft"],
                published_content=row["published"],
                content_sha256=digest,
                contributor_ids=row["contributor_ids"],
                actor_id=None,
                created_at=datetime.now(UTC),
            )
        )
        if row["state"] == "in_review":
            connection.execute(
                submissions.insert().values(
                    experience_id=row["id"],
                    revision=row["revision"],
                    content_sha256=digest,
                    contributor_ids=row["contributor_ids"],
                    submitted_by=row["submitted_by"],
                    submitted_at=None,
                )
            )


def downgrade():
    for name in ("experience_submissions", "experience_operations", "experience_versions"):
        op.drop_table(name)
