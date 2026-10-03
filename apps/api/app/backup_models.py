"""Durable backup requests; host secrets and executable paths never enter these rows."""

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
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, now_utc


class BackupGrantRecord(Base):
    __tablename__ = "backup_grants"
    __table_args__ = (
        CheckConstraint(
            "permission IN ('backup.read','backup.request')", name="ck_backup_permission"
        ),
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), primary_key=True
    )
    permission: Mapped[str] = mapped_column(String(32), primary_key=True)
    granted_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    note: Mapped[str] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class BackupControlRecord(Base):
    __tablename__ = "backup_control"
    __table_args__ = (CheckConstraint("id = 1", name="ck_backup_control_singleton"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    generation: Mapped[int] = mapped_column(Integer, default=0)


class BackupJobRecord(Base):
    __tablename__ = "backup_jobs"
    __table_args__ = (
        UniqueConstraint("user_id", "operation_id", name="uq_backup_operation"),
        CheckConstraint(
            "state IN ('queued','running','succeeded','failed','unknown','cancelled','expired')",
            name="ck_backup_state",
        ),
        CheckConstraint(
            "phase IN ('queued','preflight','dump','encrypt','retention','integrity','complete')",
            name="ck_backup_phase",
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), index=True
    )
    operation_id: Mapped[str] = mapped_column(String(36))
    fingerprint: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(String(500))
    request_session_id: Mapped[str] = mapped_column(String(36))
    mfa_verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    authorized_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    phase: Mapped[str] = mapped_column(String(16), default="queued")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    execution_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    cancel_operation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class BackupStatusRecord(Base):
    __tablename__ = "backup_status"
    __table_args__ = (CheckConstraint("id = 1", name="ck_backup_status_singleton"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    summary: Mapped[dict] = mapped_column(JSON)
