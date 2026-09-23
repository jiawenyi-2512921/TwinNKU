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
    UniqueConstraint,
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


class MapRecord(Base):
    __tablename__ = "maps"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_maps_revision"),
        CheckConstraint("width_px > 0 AND height_px > 0", name="ck_maps_dimensions"),
        CheckConstraint("status IN ('draft','published','retired')", name="ck_maps_status"),
        CheckConstraint(
            "visibility IN ('public','internal','restricted')", name="ck_maps_visibility"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    campus_id: Mapped[str] = mapped_column(ForeignKey("campuses.id", ondelete="RESTRICT"))
    title: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(16), default="campus")
    revision: Mapped[int] = mapped_column(Integer)
    width_px: Mapped[int] = mapped_column(Integer)
    height_px: Mapped[int] = mapped_column(Integer)
    image_asset_id: Mapped[str] = mapped_column(String(36))
    source_sha256: Mapped[str] = mapped_column(String(64))
    tile_size: Mapped[int] = mapped_column(Integer)
    max_native_zoom: Mapped[int] = mapped_column(Integer)
    attribution: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="draft")
    visibility: Mapped[str] = mapped_column(String(24), default="internal")


class PointGeometryRecord(Base):
    __tablename__ = "point_geometries"
    map_id: Mapped[str] = mapped_column(ForeignKey("maps.id", ondelete="CASCADE"), primary_key=True)
    point_id: Mapped[str] = mapped_column(
        ForeignKey("points.id", ondelete="CASCADE"), primary_key=True
    )
    map_revision: Mapped[int] = mapped_column(Integer)
    anchor: Mapped[dict] = mapped_column(JSON)
    polygon: Mapped[list] = mapped_column(JSON)
    entrance_ids: Mapped[list] = mapped_column(JSON, default=list)


class MapImportRecord(Base):
    __tablename__ = "map_imports"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    map_id: Mapped[str] = mapped_column(ForeignKey("maps.id", ondelete="RESTRICT"))
    revision: Mapped[int] = mapped_column(Integer)
    manifest_sha256: Mapped[str] = mapped_column(String(64))
    reviewer: Mapped[str] = mapped_column(String(120))
    rights_note: Mapped[str] = mapped_column(Text)
    published: Mapped[bool] = mapped_column(Boolean)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class FloorRecord(Base):
    __tablename__ = "floors"
    __table_args__ = (
        UniqueConstraint("point_id", "ordinal", name="uq_floors_point_ordinal"),
        UniqueConstraint("map_id", name="uq_floors_map"),
        CheckConstraint("revision >= 1", name="ck_floors_revision"),
        CheckConstraint("status IN ('draft','published','retired')", name="ck_floors_status"),
        CheckConstraint(
            "visibility IN ('public','internal','restricted')", name="ck_floors_visibility"
        ),
        Index("ix_floors_point", "point_id", "status", "visibility"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"))
    map_id: Mapped[str] = mapped_column(ForeignKey("maps.id", ondelete="RESTRICT"))
    label: Mapped[str] = mapped_column(String(64))
    ordinal: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    attribution: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="draft")
    visibility: Mapped[str] = mapped_column(String(24), default="internal")
    manifest_sha256: Mapped[str] = mapped_column(String(64))
    images: Mapped[list] = mapped_column(JSON)


class FloorImportRecord(Base):
    __tablename__ = "floor_imports"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    floor_id: Mapped[str] = mapped_column(ForeignKey("floors.id", ondelete="RESTRICT"))
    revision: Mapped[int] = mapped_column(Integer)
    manifest_sha256: Mapped[str] = mapped_column(String(64))
    reviewer: Mapped[str] = mapped_column(String(120))
    rights_note: Mapped[str] = mapped_column(Text)
    published: Mapped[bool] = mapped_column(Boolean)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
