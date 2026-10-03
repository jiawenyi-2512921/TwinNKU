"""Reviewed site configuration and durable emergency overrides.

These records deliberately share the existing metadata, not staff role defaults.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, now_utc


class ConfigurationRecord(Base):
    __tablename__ = "configurations"
    __table_args__ = (
        UniqueConstraint("kind", "scope", name="uq_configurations_kind_scope"),
        CheckConstraint(
            "kind IN ('presentation','visit_defaults','runtime')", name="ck_configuration_kind"
        ),
        CheckConstraint(
            "state IN ('draft','in_review','rejected','published')", name="ck_configuration_state"
        ),
        CheckConstraint(
            "revision >= 1 AND published_revision >= 0", name="ck_configuration_revision"
        ),
        CheckConstraint(
            "kind <> 'runtime' OR scope = 'global'", name="ck_configuration_runtime_scope"
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(24))
    scope: Mapped[str] = mapped_column(String(80), index=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    published_revision: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    draft: Mapped[dict] = mapped_column(JSON)
    published: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    contributor_ids: Mapped[list] = mapped_column(JSON, default=list)
    submitted_by: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resume_services: Mapped[list] = mapped_column(JSON, default=list)
    resume_stop_revisions: Mapped[dict] = mapped_column(JSON, default=dict)
    review_note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class ConfigurationVersionRecord(Base):
    __tablename__ = "configuration_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    configuration_id: Mapped[str] = mapped_column(
        ForeignKey("configurations.id", ondelete="RESTRICT"), index=True
    )
    event: Mapped[str] = mapped_column(String(24))
    revision: Mapped[int] = mapped_column(Integer)
    published_revision: Mapped[int] = mapped_column(Integer)
    content: Mapped[dict] = mapped_column(JSON)
    content_sha256: Mapped[str] = mapped_column(String(64))
    contributor_ids: Mapped[list] = mapped_column(JSON)
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )


class ConfigurationOperationRecord(Base):
    __tablename__ = "configuration_operations"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    target_id: Mapped[str] = mapped_column(
        ForeignKey("configurations.id", ondelete="RESTRICT"), index=True
    )
    action: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ConfigurationGrantRecord(Base):
    __tablename__ = "configuration_grants"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), primary_key=True
    )
    permission: Mapped[str] = mapped_column(String(32), primary_key=True)
    scope: Mapped[str] = mapped_column(String(80), primary_key=True)
    granted_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    note: Mapped[str] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class EmergencyStopRecord(Base):
    __tablename__ = "configuration_emergency_stops"
    service: Mapped[str] = mapped_column(String(32), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    stopped: Mapped[bool] = mapped_column(Boolean, default=True)
    reason: Mapped[str] = mapped_column(String(500))
    actor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}
