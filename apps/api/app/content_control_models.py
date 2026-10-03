"""Scope checked immutable point/resource/navigation history and write receipts."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, now_utc


class ContentVersionRecord(Base):
    __tablename__ = "content_versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    entity_type: Mapped[str] = mapped_column(String(24), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
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


class ContentOperationRecord(Base):
    __tablename__ = "content_operations"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), primary_key=True
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(24))
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContentSubmissionRecord(Base):
    __tablename__ = "content_submissions"
    entity_type: Mapped[str] = mapped_column(String(24), primary_key=True)
    entity_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    content_sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
