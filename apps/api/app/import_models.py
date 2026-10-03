"""Owner-private table checks; public content remains in the normal domain tables."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, now_utc


class ImportJob(Base):
    __tablename__ = "import_jobs"
    __table_args__ = (
        UniqueConstraint("user_id", "operation_id", name="uq_import_operation"),
        CheckConstraint("kind IN ('point','vr','tour','media')", name="ck_import_kind"),
        CheckConstraint("state IN ('uploading','checked','committed','failed')", name="ck_import_state"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"), index=True)
    operation_id: Mapped[str] = mapped_column(String(36))
    kind: Mapped[str] = mapped_column(String(12))
    state: Mapped[str] = mapped_column(String(16), default="uploading")
    filename: Mapped[str] = mapped_column(String(200))
    source_sha256: Mapped[str] = mapped_column(String(64), default="")
    byte_size: Mapped[int] = mapped_column(Integer, default=0)
    columns: Mapped[list] = mapped_column(JSON, default=list)
    rows: Mapped[list] = mapped_column(JSON, default=list)
    mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    preview: Mapped[list] = mapped_column(JSON, default=list)
    preview_sha256: Mapped[str] = mapped_column(String(64), default="")
    commit_operation: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result: Mapped[list] = mapped_column(JSON, default=list)
    error_code: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
