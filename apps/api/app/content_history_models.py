"""Immutable experience checkpoints and frozen submissions, separate from DTOs."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, now_utc


class ExperienceVersionRecord(Base):
    __tablename__ = "experience_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    experience_id: Mapped[str] = mapped_column(
        ForeignKey("experiences.id", ondelete="RESTRICT"), index=True
    )
    event: Mapped[str] = mapped_column(String(24))
    revision: Mapped[int] = mapped_column(Integer)
    published_revision: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(16))
    content: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    published_content: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    content_sha256: Mapped[str] = mapped_column(String(64))
    contributor_ids: Mapped[list] = mapped_column(JSON)
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )


class ExperienceOperationRecord(Base):
    __tablename__ = "experience_operations"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    target_id: Mapped[str] = mapped_column(
        ForeignKey("experiences.id", ondelete="RESTRICT"), index=True
    )
    action: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ExperienceSubmissionRecord(Base):
    __tablename__ = "experience_submissions"
    experience_id: Mapped[str] = mapped_column(
        ForeignKey("experiences.id", ondelete="RESTRICT"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer)
    content_sha256: Mapped[str] = mapped_column(String(64))
    contributor_ids: Mapped[list] = mapped_column(JSON)
    submitted_by: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
