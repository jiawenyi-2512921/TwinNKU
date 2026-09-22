from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now_utc() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class CampusRecord(Base):
    __tablename__ = "campuses"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class PointRecord(Base):
    __tablename__ = "points"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_points_revision"),
        CheckConstraint(
            "status IN ('draft','in_review','published','retired')", name="ck_points_status"
        ),
        CheckConstraint(
            "visibility IN ('public','internal','restricted')", name="ck_points_visibility"
        ),
        CheckConstraint(
            "category IN ('public_area','patriotic','academic','residence','dining','commerce','landscape','history')",
            name="ck_points_category",
        ),
        Index("ix_points_public", "campus_id", "status", "visibility"),
        Index("ix_points_category", "category"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    campus_id: Mapped[str] = mapped_column(ForeignKey("campuses.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(120))
    aliases: Mapped[list[str]] = mapped_column(JSON, default=list)
    category: Mapped[str] = mapped_column(String(32))
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(24), default="draft")
    visibility: Mapped[str] = mapped_column(String(24), default="public")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )
