from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
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


class NarrationJob(Base):
    __tablename__ = "narration_jobs"
    __table_args__ = (
        UniqueConstraint("created_by", "operation_id", "segment_id", name="uq_narration_operation_segment"),
        CheckConstraint("state IN ('queued','running','ready','failed','unknown','cancelled','paused')", name="ck_narration_job_state"),
        CheckConstraint("attempts >= 0 AND lease_version >= 0", name="ck_narration_job_counters"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    tour_id: Mapped[str] = mapped_column(ForeignKey("experiences.id", ondelete="RESTRICT"), index=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"))
    segment_id: Mapped[str] = mapped_column(String(64))
    source_revision: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    operation_id: Mapped[str] = mapped_column(String(36))
    request_sha256: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    text_sha256: Mapped[str] = mapped_column(String(64))
    profile: Mapped[dict] = mapped_column(JSON)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    chunks: Mapped[list] = mapped_column(JSON, default=list)
    completed_chunks: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_version: Mapped[int] = mapped_column(Integer, default=0)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class NarrationAsset(Base):
    __tablename__ = "narration_assets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("narration_jobs.id", ondelete="RESTRICT"), unique=True)
    tour_id: Mapped[str] = mapped_column(ForeignKey("experiences.id", ondelete="RESTRICT"), index=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"))
    segment_id: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    text_sha256: Mapped[str] = mapped_column(String(64))
    spoken_sha256: Mapped[str] = mapped_column(String(64))
    profile: Mapped[dict] = mapped_column(JSON)
    fingerprint: Mapped[str] = mapped_column(String(64))
    manifest_sha256: Mapped[str] = mapped_column(String(64))
    chunks: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
