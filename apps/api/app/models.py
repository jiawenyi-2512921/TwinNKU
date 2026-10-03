from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now_utc() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class NavigationRecord(Base):
    __tablename__ = "navigation_graphs"
    map_id: Mapped[str] = mapped_column(
        ForeignKey("maps.id", ondelete="RESTRICT"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    published_revision: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(24), default="draft")
    draft: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    published: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    contributor_ids: Mapped[list] = mapped_column(JSON, default=list)
    review_note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class GuideSettingsRecord(Base):
    __tablename__ = "guide_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    note: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


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
    label_on_map: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


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
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
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


class StaffUserRecord(Base):
    __tablename__ = "staff_users"
    __table_args__ = (
        CheckConstraint("role IN ('admin','reviewer','editor','viewer')", name="ck_staff_role"),
        CheckConstraint("revision >= 1", name="ck_staff_revision"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(24))
    campus_ids: Mapped[list] = mapped_column(JSON, default=list)
    point_ids: Mapped[list] = mapped_column(JSON, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_recovery_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class StaffSessionRecord(Base):
    __tablename__ = "staff_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    public_id: Mapped[str] = mapped_column(
        String(36), default=lambda: str(uuid4()), nullable=False, unique=True, index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="CASCADE"), index=True
    )
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    mfa_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StaffCredentialRecord(Base):
    __tablename__ = "staff_credentials"
    credential_id: Mapped[str] = mapped_column(String(1400), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="CASCADE"), index=True
    )
    public_key: Mapped[str] = mapped_column(Text)
    sign_count: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(80))
    transports: Mapped[list] = mapped_column(JSON, default=list)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    backup_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    backed_up: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StaffMfaChallengeRecord(Base):
    __tablename__ = "staff_mfa_challenges"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="CASCADE"), index=True
    )
    user_revision: Mapped[int] = mapped_column(Integer)
    purpose: Mapped[str] = mapped_column(String(16))
    challenge: Mapped[str | None] = mapped_column(String(64))
    csrf_token: Mapped[str] = mapped_column(String(64))
    credential_name: Mapped[str] = mapped_column(String(80), default="")
    bound_credential_id: Mapped[str | None] = mapped_column(String(1400))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class StaffRecoveryCodeRecord(Base):
    __tablename__ = "staff_recovery_codes"
    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class LoginLimitRecord(Base):
    __tablename__ = "admin_login_limits"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    window_started: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer)


class PointChangeRecord(Base):
    __tablename__ = "point_changes"
    __table_args__ = (
        CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_point_change_state",
        ),
        CheckConstraint("operation IN ('upsert','retire')", name="ck_point_change_operation"),
        CheckConstraint("revision >= 1 AND base_revision >= 1", name="ck_point_change_revision"),
    )
    point_id: Mapped[str] = mapped_column(
        ForeignKey("points.id", ondelete="RESTRICT"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=1)
    base_revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    operation: Mapped[str] = mapped_column(String(16), default="upsert")
    payload: Mapped[dict | None] = mapped_column(JSON)
    contributor_ids: Mapped[list] = mapped_column(JSON, default=list)
    editor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    submitted_by: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT")
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class AdminAuditRecord(Base):
    __tablename__ = "admin_audit"
    __table_args__ = (Index("ix_admin_audit_point_time", "point_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    actor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    actor_name: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(48))
    campus_id: Mapped[str | None] = mapped_column(ForeignKey("campuses.id", ondelete="RESTRICT"))
    point_id: Mapped[str | None] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"))
    note: Mapped[str] = mapped_column(Text, default="")
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )


class FloorUploadRecord(Base):
    __tablename__ = "floor_uploads"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"), index=True)
    uploaded_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    image: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class UploadBudgetRecord(Base):
    __tablename__ = "upload_budgets"
    __table_args__ = (
        CheckConstraint(
            "used_bytes >= 0 AND reserved_bytes >= 0 AND active_uploads >= 0",
            name="ck_upload_budget_nonnegative",
        ),
    )
    scope: Mapped[str] = mapped_column(String(100), primary_key=True)
    used_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    reserved_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    active_uploads: Mapped[int] = mapped_column(Integer, default=0)


class UploadReservationRecord(Base):
    __tablename__ = "upload_reservations"
    __table_args__ = (
        UniqueConstraint("kind", "upload_id", name="uq_upload_reservation_asset"),
        CheckConstraint(
            "state IN ('reserved','complete','failed','orphaned','quarantined')",
            name="ck_upload_reservation_state",
        ),
        CheckConstraint("size_bytes >= 0", name="ck_upload_reservation_size"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(24))
    upload_id: Mapped[str] = mapped_column(String(80))
    user_id: Mapped[str] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), index=True
    )
    campus_id: Mapped[str] = mapped_column(
        ForeignKey("campuses.id", ondelete="RESTRICT"), index=True
    )
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    state: Mapped[str] = mapped_column(String(16), default="reserved", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PanoramaRecord(Base):
    __tablename__ = "panoramas"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_panorama_revision"),
        CheckConstraint("status IN ('published','retired')", name="ck_panorama_status"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"), index=True)
    title: Mapped[str] = mapped_column(String(120))
    url: Mapped[str] = mapped_column(String(2048))
    description: Mapped[str] = mapped_column(Text, default="")
    observation_prompt: Mapped[str] = mapped_column(Text, default="", server_default="")
    cover_image_id: Mapped[str | None] = mapped_column(String(36))
    cover_image_revision: Mapped[int | None] = mapped_column(Integer)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    verification_generation: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="published")


class PanoramaVerificationRecord(Base):
    __tablename__ = "panorama_verifications"
    __table_args__ = (
        CheckConstraint("generation >= 1", name="ck_vr_check_generation"),
        CheckConstraint("dimension IN ('technical','scene','device')", name="ck_vr_check_dimension"),
        CheckConstraint("result IN ('passed','failed','uncertain')", name="ck_vr_check_result"),
        CheckConstraint("(dimension = 'device' AND platform IS NOT NULL AND platform IN ('desktop','android','ios','wechat')) OR (dimension != 'device' AND platform IS NULL)", name="ck_vr_check_platform"),
        Index("ix_vr_check_source", "resource_id", "generation", "url_sha256", "recorded_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    operation_id: Mapped[str] = mapped_column(String(36), unique=True)
    payload_sha256: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[str] = mapped_column(String(36))
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"))
    generation: Mapped[int] = mapped_column(Integer)
    url_sha256: Mapped[str] = mapped_column(String(64))
    dimension: Mapped[str] = mapped_column(String(16))
    platform: Mapped[str | None] = mapped_column(String(16))
    result: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(String(40))
    environment: Mapped[str] = mapped_column(String(200), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    recorded_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ResourceChangeRecord(Base):
    __tablename__ = "resource_changes"
    __table_args__ = (
        CheckConstraint("kind IN ('floor','panorama')", name="ck_resource_kind"),
        CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_resource_state",
        ),
        CheckConstraint("operation IN ('upsert','retire')", name="ck_resource_operation"),
        CheckConstraint("revision >= 1 AND base_revision >= 0", name="ck_resource_revision"),
    )
    resource_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    base_revision: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    operation: Mapped[str] = mapped_column(String(16), default="upsert")
    payload: Mapped[dict | None] = mapped_column(JSON)
    contributor_ids: Mapped[list] = mapped_column(JSON, default=list)
    editor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    submitted_by: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT")
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class ExperienceUploadRecord(Base):
    __tablename__ = "experience_uploads"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str] = mapped_column(ForeignKey("points.id", ondelete="RESTRICT"), index=True)
    uploaded_by: Mapped[str] = mapped_column(ForeignKey("staff_users.id", ondelete="RESTRICT"))
    media_type: Mapped[str] = mapped_column(String(16))
    mime_type: Mapped[str] = mapped_column(String(48))
    filename: Mapped[str] = mapped_column(String(80))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ExperienceRecord(Base):
    __tablename__ = "experiences"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'tour' AND point_id IS NULL) OR (kind <> 'tour' AND point_id IS NOT NULL)",
            name="ck_experiences_point_binding",
        ),
        CheckConstraint("kind IN ('media','checkin','tour')", name="ck_experiences_kind"),
        CheckConstraint("status IN ('draft','published','retired')", name="ck_experiences_status"),
        CheckConstraint(
            "state IN ('draft','in_review','rejected','published','discarded')",
            name="ck_experiences_state",
        ),
        CheckConstraint("operation IN ('upsert','retire')", name="ck_experiences_operation"),
        CheckConstraint(
            "revision >= 1 AND published_revision >= 0", name="ck_experiences_revision"
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    point_id: Mapped[str | None] = mapped_column(
        ForeignKey("points.id", ondelete="RESTRICT"), index=True, nullable=True
    )
    campus_id: Mapped[str] = mapped_column(
        ForeignKey("campuses.id", ondelete="RESTRICT", name="fk_experiences_campus_id_campuses"),
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(16))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    published_revision: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    status: Mapped[str] = mapped_column(String(24), default="draft")
    operation: Mapped[str] = mapped_column(String(16), default="upsert")
    draft: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    published: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    contributor_ids: Mapped[list] = mapped_column(JSON, default=list)
    submitted_by: Mapped[str | None] = mapped_column(
        ForeignKey("staff_users.id", ondelete="RESTRICT"), nullable=True
    )
    review_note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}
