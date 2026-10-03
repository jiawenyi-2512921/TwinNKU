"""Typed reviewed configurations, explicit grants and persistent stops.

Revision ID: 0013_configurations
Revises: 0012_staff_session_ids
"""

import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID, uuid5

import sqlalchemy as sa
from alembic import op

revision = "0013_configurations"
down_revision = "0012_staff_session_ids"
branch_labels = None
depends_on = None


def staff_fk(name, nullable=False):
    return sa.Column(
        name, sa.String(36), sa.ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=nullable
    )


def upgrade():
    op.create_table(
        "configurations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("scope", sa.String(80), nullable=False),
        sa.Column("schema_version", sa.Integer, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("published_revision", sa.Integer, nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("draft", sa.JSON, nullable=False),
        sa.Column("published", sa.JSON, nullable=True),
        sa.Column("contributor_ids", sa.JSON, nullable=False),
        staff_fk("submitted_by", nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_sha256", sa.String(64), nullable=True),
        sa.Column("resume_services", sa.JSON, nullable=False),
        sa.Column("resume_stop_revisions", sa.JSON, nullable=False),
        sa.Column("review_note", sa.Text, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("kind", "scope", name="uq_configurations_kind_scope"),
        sa.CheckConstraint(
            "kind IN ('presentation','visit_defaults','runtime')", name="ck_configuration_kind"
        ),
        sa.CheckConstraint(
            "state IN ('draft','in_review','rejected','published')", name="ck_configuration_state"
        ),
        sa.CheckConstraint(
            "revision >= 1 AND published_revision >= 0", name="ck_configuration_revision"
        ),
        sa.CheckConstraint(
            "kind <> 'runtime' OR scope = 'global'", name="ck_configuration_runtime_scope"
        ),
    )
    op.create_index("ix_configurations_scope", "configurations", ["scope"])
    op.create_index("ix_configurations_state", "configurations", ["state"])
    op.create_table(
        "configuration_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "configuration_id",
            sa.String(36),
            sa.ForeignKey("configurations.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("event", sa.String(24), nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("published_revision", sa.Integer, nullable=False),
        sa.Column("content", sa.JSON, nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("contributor_ids", sa.JSON, nullable=False),
        staff_fk("actor_id", nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_configuration_versions_configuration_id", "configuration_versions", ["configuration_id"]
    )
    op.create_index(
        "ix_configuration_versions_created_at", "configuration_versions", ["created_at"]
    )
    op.create_table(
        "configuration_operations",
        staff_fk("user_id"),
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column(
            "target_id",
            sa.String(36),
            sa.ForeignKey("configurations.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "id"),
    )
    op.create_index(
        "ix_configuration_operations_target_id", "configuration_operations", ["target_id"]
    )
    op.create_table(
        "configuration_grants",
        staff_fk("user_id"),
        sa.Column("permission", sa.String(32), nullable=False),
        sa.Column("scope", sa.String(80), nullable=False),
        staff_fk("granted_by"),
        sa.Column("note", sa.String(500), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "permission", "scope"),
    )
    op.create_table(
        "configuration_emergency_stops",
        sa.Column("service", sa.String(32), primary_key=True),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("stopped", sa.Boolean, nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        staff_fk("actor_id"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Preserve the previously effective policy. This is historical migration,
    # not a fabricated approval or grant to existing content editors/reviewers.
    connection = op.get_bind()
    legacy = sa.table(
        "guide_settings",
        sa.column("id", sa.Integer),
        sa.column("payload", sa.JSON),
        sa.column("revision", sa.Integer),
    )
    prior = connection.execute(
        sa.select(legacy.c.payload).where(legacy.c.id == 1)
    ).scalar_one_or_none()
    payload = {"kind": "runtime", **(prior or {})}
    configuration_id = str(uuid5(UUID("176bca2c-678d-4e3c-98fd-aa66f32124ad"), "runtime-global"))
    table = sa.table(
        "configurations",
        *[
            sa.column(name, kind)
            for name, kind in (
                ("id", sa.String),
                ("kind", sa.String),
                ("scope", sa.String),
                ("schema_version", sa.Integer),
                ("revision", sa.Integer),
                ("published_revision", sa.Integer),
                ("state", sa.String),
                ("draft", sa.JSON),
                ("published", sa.JSON),
                ("contributor_ids", sa.JSON),
                ("resume_services", sa.JSON),
                ("resume_stop_revisions", sa.JSON),
                ("review_note", sa.Text),
                ("updated_at", sa.DateTime(timezone=True)),
            )
        ],
    )
    connection.execute(
        table.insert().values(
            id=configuration_id,
            kind="runtime",
            scope="global",
            schema_version=1,
            revision=1,
            published_revision=1,
            state="published",
            draft=payload,
            published=payload,
            contributor_ids=[],
            resume_services=[],
            resume_stop_revisions={},
            review_note="迁移保留原有效运行设置；未新增收费能力或伪造独立审核。",
            updated_at=datetime.now(UTC),
        )
    )
    versions = sa.Table("configuration_versions", sa.MetaData(), autoload_with=connection)
    connection.execute(
        versions.insert().values(
            id=str(uuid5(UUID(configuration_id), "migration")),
            configuration_id=configuration_id,
            event="migration",
            revision=1,
            published_revision=1,
            content=payload,
            content_sha256=hashlib.sha256(
                json.dumps(
                    payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                ).encode()
            ).hexdigest(),
            contributor_ids=[],
            actor_id=None,
            created_at=datetime.now(UTC),
        )
    )


def downgrade():
    for name in (
        "configuration_emergency_stops",
        "configuration_grants",
        "configuration_operations",
        "configuration_versions",
        "configurations",
    ):
        op.drop_table(name)
