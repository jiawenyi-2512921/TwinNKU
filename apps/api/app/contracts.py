"""Canonical public DTOs. Includes planned modules; schemas are not implementations."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    SecretStr,
    field_validator,
    model_validator,
)

CampusId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")]
Revision = Annotated[int, Field(ge=1)]


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class Pagination(DTO):
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)


class Meta(DTO):
    request_id: UUID
    pagination: Pagination | None = None


class Envelope[T](DTO):
    data: T
    meta: Meta


class FieldError(DTO):
    field: str
    message: str


class ErrorInfo(DTO):
    code: str
    message: str
    details: list[FieldError] = Field(default_factory=list)


class ErrorEnvelope(DTO):
    error: ErrorInfo
    meta: Meta


class Health(DTO):
    status: Literal["ok", "not_ready"]
    service: Literal["twinnku-api"] = "twinnku-api"


class Capabilities(DTO):
    map: bool = False
    routing: bool = False
    vr: bool = False
    floors: bool = False
    chat: bool = False
    chat_embed: bool = False
    tours: bool = False
    admin: bool = False


class SystemStatus(DTO):
    service: Literal["twinnku-api"] = "twinnku-api"
    version: str
    api_version: Literal["v1"] = "v1"
    capabilities: Capabilities


class AgentWebConfig(DTO):
    enabled: bool
    provider: Literal["nk-genios-websdk"] = "nk-genios-websdk"
    display_name: Literal["小开"] = "小开"
    # Deliberately public, unlike nk_genios_api_key, which is never serialized.
    app_key: str | None = None
    base_url: Literal["https://coze.nankai.edu.cn"] = "https://coze.nankai.edu.cn"
    sdk_url: Literal["https://coze.nankai.edu.cn/resources/product/llm/public/sdk/embedLite.js"] = (
        "https://coze.nankai.edu.cn/resources/product/llm/public/sdk/embedLite.js"
    )
    hide_sidebar: bool = True
    context_enabled: bool = False
    public_site_origin: str


class Campus(DTO):
    id: CampusId
    name: str = Field(min_length=1, max_length=120)
    description: str


class PointCategory(StrEnum):
    PUBLIC_AREA = "public_area"
    PATRIOTIC = "patriotic"
    ACADEMIC = "academic"
    RESIDENCE = "residence"
    DINING = "dining"
    COMMERCE = "commerce"
    LANDSCAPE = "landscape"
    HISTORY = "history"


class Visibility(StrEnum):
    PUBLIC = "public"
    INTERNAL = "internal"
    RESTRICTED = "restricted"


class ContentStatus(StrEnum):
    DRAFT = "draft"
    IN_REVIEW = "in_review"
    PUBLISHED = "published"
    RETIRED = "retired"


class Point(DTO):
    id: UUID
    campus_id: CampusId
    name: str = Field(min_length=1, max_length=120)
    aliases: list[str]
    category: PointCategory
    summary: str = Field(max_length=2000)
    revision: Revision
    updated_at: datetime


class XY(DTO):
    x: FiniteFloat = Field(ge=0)
    y: FiniteFloat = Field(ge=0)


class MapTiles(DTO):
    url_template: str
    tile_size: int = Field(ge=128, le=1024)
    min_zoom: int = Field(ge=0)
    max_native_zoom: int = Field(ge=0, le=16)


class MapInfo(DTO):
    id: UUID
    campus_id: CampusId
    title: str
    kind: Literal["campus", "floor"]
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    revision: Revision
    image_asset_id: UUID
    coordinate_system: Literal["image-pixel-top-left"] = "image-pixel-top-left"
    tiles: MapTiles | None = None
    source_sha256: str | None = None
    attribution: str = ""


class PointGeometry(DTO):
    point_id: UUID
    map_id: UUID
    map_revision: Revision
    anchor: XY
    polygon: list[XY] = Field(min_length=3)
    entrance_ids: list[UUID]
    label_on_map: bool = False


class MapFeatures(DTO):
    map_id: UUID
    map_revision: Revision
    points: list[PointGeometry]


class SourceRef(DTO):
    id: UUID
    revision: Revision
    title: str
    issuer: str
    url: str | None = None
    effective_until: datetime | None = None


class MediaInfo(DTO):
    id: UUID
    point_id: UUID | None
    kind: Literal["image", "panorama", "floorplan", "audio", "document"]
    title: str
    visibility: Visibility
    revision: Revision
    attribution: str
    captured_at: datetime | None = None


class MediaAccess(DTO):
    media_id: UUID
    url: str
    expires_at: datetime | None
    mode: Literal["same_origin", "external"]
    presentation: Literal["image", "audio", "document", "external_link", "iframe"]


FLOOR_SECTION_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"


class FloorImage(DTO):
    variant: Literal["labeled", "clean"]
    section: str = Field(default="main", pattern=FLOOR_SECTION_PATTERN)
    section_label: str | None = Field(default=None, min_length=1, max_length=64)
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    media_type: Literal["image/png", "image/jpeg"]
    size_bytes: int = Field(gt=0)
    url: str


class Floor(DTO):
    id: UUID
    point_id: UUID
    label: str
    ordinal: int
    map_id: UUID
    revision: Revision
    images: list[FloorImage] = Field(default_factory=list)
    attribution: str = ""


class Room(DTO):
    id: UUID
    floor_id: UUID
    number: str = Field(min_length=1, max_length=32)
    name: str | None = None
    kind: Literal["room", "toilet", "shower", "stairs", "elevator", "public_space"]
    polygon: list[XY] = Field(min_length=3)
    entrance_node_ids: list[UUID]


class Narration(DTO):
    id: UUID
    point_id: UUID
    title: str
    text: str
    audience: Literal["general", "school_group", "alumni"]
    sources: list[SourceRef] = Field(min_length=1)
    audio_asset_id: UUID | None
    revision: Revision


class RouteEndpoint(DTO):
    kind: Literal["point", "entrance", "room"]
    id: UUID


class RouteRequest(DTO):
    campus_id: CampusId
    start: RouteEndpoint
    end: RouteEndpoint
    via: list[RouteEndpoint] = Field(default_factory=list, max_length=10)
    accessibility: Literal["standard", "step_free"] = "standard"
    departure_at: datetime | None = None
    graph_revision: int | None = Field(default=None, ge=1)


class FloorTransition(DTO):
    kind: Literal["stairs", "elevator"]
    from_floor_id: UUID
    to_floor_id: UUID
    description: str


class RouteSegment(DTO):
    map_id: UUID
    map_revision: Revision
    floor_id: UUID | None
    path: list[XY] = Field(min_length=2)
    distance_m: float | None = Field(ge=0)
    transition_after: FloorTransition | None = None


class RouteResult(DTO):
    id: UUID
    campus_id: CampusId
    graph_revision: Revision
    segments: list[RouteSegment] = Field(min_length=1)
    distance_m: float | None = Field(ge=0)
    walking_duration_seconds: int | None = Field(ge=0)
    warnings: list[str]
    expires_at: datetime


class TourTemplate(DTO):
    id: UUID
    campus_id: CampusId
    title: str
    theme: str
    point_ids: list[UUID]
    revision: Revision


class TourPlanRequest(DTO):
    campus_id: CampusId
    mode: Literal["virtual", "walking"]
    theme: str = Field(min_length=1, max_length=100)
    audience: Literal["general", "school_group", "alumni"] = "general"
    duration_minutes: int = Field(ge=5, le=240)
    preferred_point_ids: list[UUID] = Field(default_factory=list, max_length=20)
    start: RouteEndpoint | None = None

    @model_validator(mode="after")
    def walking_needs_start(self):
        if self.mode == "walking" and self.start is None:
            raise ValueError("walking mode requires start")
        return self


class TourStop(DTO):
    point_id: UUID
    narration_id: UUID | None
    estimated_seconds: int | None = Field(ge=0)
    learning_prompt: str | None = None


class TourPlan(DTO):
    id: UUID
    mode: Literal["virtual", "walking"]
    title: str
    stops: list[TourStop] = Field(min_length=1)
    route_id: UUID | None
    estimated_seconds: int | None = Field(ge=0)
    revision: Revision
    sources: list[SourceRef]
    warnings: list[str]


class TourAdjustment(DTO):
    expected_revision: Revision
    operation: Literal["shorten", "skip", "change_theme"]
    duration_minutes: int | None = Field(default=None, ge=5, le=240)
    point_id: UUID | None = None
    theme: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def operation_has_argument(self):
        required = {
            "shorten": self.duration_minutes,
            "skip": self.point_id,
            "change_theme": self.theme,
        }
        if required[self.operation] is None:
            raise ValueError(f"{self.operation} requires its argument")
        return self


class ViewContext(DTO):
    campus_id: CampusId
    revision: int = Field(ge=0)
    current_point_id: UUID | None = None
    current_map_id: UUID | None = None
    current_floor_id: UUID | None = None
    tour_plan_id: UUID | None = None
    mode: Literal["virtual", "walking"] = "virtual"


class GuestSession(DTO):
    expires_at: datetime
    csrf_token: str


class Identity(DTO):
    authenticated: bool
    roles: list[Literal["guest", "visitor", "contributor", "reviewer", "analyst", "admin"]]


class ChatSessionRequest(DTO):
    context: ViewContext


class ChatSession(DTO):
    id: UUID
    expires_at: datetime


class ChatTurnRequest(DTO):
    client_message_id: UUID
    message: str = Field(min_length=1, max_length=2000)
    context: ViewContext


class ChatTurnAccepted(DTO):
    turn_id: UUID
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    events_url: str


class AgentAction(DTO):
    action_id: UUID
    type: Literal[
        "focus_point", "show_route", "open_vr", "show_floor", "play_narration", "show_tour"
    ]
    resource_id: UUID
    resource_revision: Revision
    context_revision: int = Field(ge=0)
    requires_user_gesture: bool


class ActionAck(DTO):
    status: Literal["applied", "skipped", "failed"]
    reason: Literal[
        "ok", "stale_context", "user_declined", "resource_unavailable", "playback_blocked"
    ]


class ChatEvent(DTO):
    turn_id: UUID
    seq: int = Field(ge=1)
    type: Literal[
        "turn.started",
        "answer.delta",
        "source.added",
        "action.ready",
        "turn.completed",
        "turn.failed",
        "turn.cancelled",
    ]
    text: str | None = None
    source: SourceRef | None = None
    action: AgentAction | None = None
    error: ErrorInfo | None = None


class InquiryRequest(DTO):
    question: str = Field(min_length=1, max_length=2000)
    category: Literal["visit_policy", "campus_info", "content_correction", "other"]
    point_id: UUID | None = None


class Inquiry(DTO):
    id: UUID
    status: Literal["unresolved", "resolved", "referred"]
    created_at: datetime


class OfficialChannel(DTO):
    id: UUID
    name: str
    url: str
    description: str
    source: SourceRef


class PointLocationInput(DTO):
    map_id: UUID
    map_revision: Revision
    anchor: XY
    polygon: list[XY] = Field(min_length=3, max_length=200)
    label_on_map: bool = True


class PointDraftInput(DTO):
    campus_id: CampusId
    name: str = Field(min_length=1, max_length=120)
    aliases: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=20
    )
    category: PointCategory
    summary: str = Field(max_length=2000)
    visibility: Visibility
    source_note: str = Field(min_length=1, max_length=2000)
    geometry: PointLocationInput

    @field_validator("name", "source_note")
    @classmethod
    def meaningful_text(cls, value):
        if not value.strip():
            raise ValueError("text cannot be blank")
        return value.strip()


class PointDraftUpdate(PointDraftInput):
    expected_revision: int = Field(ge=0)
    expected_point_revision: Revision


class ReviewRequest(DTO):
    expected_revision: Revision
    note: str = Field(min_length=1, max_length=1000)


class PointChange(DTO):
    revision: Revision
    base_revision: Revision
    state: Literal["draft", "in_review", "rejected", "published", "discarded"]
    operation: Literal["upsert", "retire"]
    payload: PointDraftInput | None
    contributor_ids: list[UUID]
    editor_id: UUID
    submitted_by: UUID | None
    submitted_at: datetime | None
    review_note: str
    updated_at: datetime


class AdminPoint(DTO):
    point: Point
    status: ContentStatus
    visibility: Visibility
    geometries: list[PointGeometry]
    draft: PointChange | None


class PointRetireRequest(DTO):
    expected_revision: int = Field(ge=0)
    expected_point_revision: Revision
    note: str = Field(min_length=1, max_length=1000)


class AdminMapPoint(DTO):
    id: UUID
    name: str
    status: ContentStatus
    geometry: PointGeometry | None
    draft_geometry: PointLocationInput | None
    draft_state: str | None


StaffRole = Literal["admin", "reviewer", "editor", "viewer"]
StaffUsername = Annotated[str, Field(pattern=r"^[a-z][a-z0-9._-]{2,63}$")]


class StaffUser(DTO):
    id: UUID
    username: StaffUsername
    display_name: str
    role: StaffRole
    campus_ids: list[CampusId]
    point_ids: list[UUID]
    is_active: bool
    must_change_password: bool
    revision: Revision
    created_at: datetime
    updated_at: datetime


class StaffUserInput(DTO):
    display_name: str = Field(min_length=1, max_length=80)
    role: StaffRole
    campus_ids: list[CampusId] = Field(default_factory=list, max_length=100)
    point_ids: list[UUID] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def role_scope(self):
        if not self.display_name.strip():
            raise ValueError("display name required")
        self.display_name = self.display_name.strip()
        if self.role == "admin" and (self.campus_ids or self.point_ids):
            raise ValueError("administrators have global scope")
        if self.role != "admin" and not self.campus_ids:
            raise ValueError("non-administrators need a campus scope")
        if len(set(self.campus_ids)) != len(self.campus_ids) or len(set(self.point_ids)) != len(
            self.point_ids
        ):
            raise ValueError("duplicate scope")
        return self


class StaffUserCreate(StaffUserInput):
    username: StaffUsername
    password: SecretStr = Field(min_length=12, max_length=128)


class StaffUserUpdate(StaffUserInput):
    expected_revision: Revision
    is_active: bool
    new_password: SecretStr | None = Field(default=None, min_length=12, max_length=128)


class StaffLogin(DTO):
    username: StaffUsername
    password: SecretStr = Field(min_length=1, max_length=128)


class StaffPasswordChange(DTO):
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=12, max_length=128)


class StaffSession(DTO):
    user: StaffUser
    permissions: list[str]
    csrf_token: str
    expires_at: datetime


class ActionResult(DTO):
    ok: bool = True


class FloorSectionInput(DTO):
    section: str = Field(default="main", pattern=FLOOR_SECTION_PATTERN)
    section_label: str | None = Field(default=None, min_length=1, max_length=64)
    upload_id: UUID | None = None

    @model_validator(mode="after")
    def named_section(self):
        if self.section != "main" and not (self.section_label or "").strip():
            raise ValueError("a section label is required")
        return self


class FloorContent(DTO):
    kind: Literal["floor"] = "floor"
    label: str = Field(min_length=1, max_length=64)
    ordinal: int = Field(ge=-20, le=200)
    attribution: str = Field(min_length=1, max_length=2000)
    images: list[FloorSectionInput] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def valid_content(self):
        if not self.label.strip() or not self.attribution.strip():
            raise ValueError("floor label and attribution are required")
        if len({i.section for i in self.images}) != len(self.images):
            raise ValueError("duplicate floor section")
        return self


class PanoramaContent(DTO):
    kind: Literal["panorama"] = "panorama"
    title: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2048)
    description: str = Field(default="", max_length=2000)

    @field_validator("url")
    @classmethod
    def safe_external_url(cls, value):
        import ipaddress
        from urllib.parse import urlsplit

        from pydantic import HttpUrl

        if any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
            raise ValueError("URL contains invalid characters")
        parsed = urlsplit(value)
        url = HttpUrl(value)
        host = (url.host or "").lower().strip("[]").rstrip(".")
        if url.scheme != "https" or parsed.username or parsed.password or url.port != 443:
            raise ValueError("use a public HTTPS URL without credentials or a custom port")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if "." not in host or host.endswith((".localhost", ".local", ".internal")):
                raise ValueError("a public hostname is required") from None
        else:
            if not address.is_global:
                raise ValueError("private addresses are not supported")
        return str(url)

    @field_validator("title")
    @classmethod
    def named_panorama(cls, value):
        if not value.strip():
            raise ValueError("title is required")
        return value.strip()


ResourceContent = Annotated[FloorContent | PanoramaContent, Field(discriminator="kind")]


class ResourceDraftData(DTO):
    content: ResourceContent
    source_note: str = Field(min_length=1, max_length=2000)

    @field_validator("source_note")
    @classmethod
    def source_required(cls, value):
        if not value.strip():
            raise ValueError("source note is required")
        return value.strip()


class ResourceDraftSave(ResourceDraftData):
    expected_revision: int = Field(ge=0)
    expected_published_revision: int = Field(ge=0)


class ResourceRetireRequest(DTO):
    expected_revision: int = Field(ge=0)
    expected_published_revision: Revision
    note: str = Field(min_length=1, max_length=1000)


class ResourceChange(DTO):
    revision: Revision
    base_revision: int = Field(ge=0)
    state: Literal["draft", "in_review", "rejected", "published", "discarded"]
    operation: Literal["upsert", "retire"]
    payload: ResourceDraftData | None
    contributor_ids: list[UUID]
    submitted_by: UUID | None
    review_note: str
    updated_at: datetime


class AdminResource(DTO):
    id: UUID
    point_id: UUID
    point_name: str
    kind: Literal["floor", "panorama"]
    published_revision: int = Field(ge=0)
    status: Literal["draft", "published", "retired"]
    current: ResourceContent | None
    draft: ResourceChange | None
    images: list[FloorImage] = Field(default_factory=list)


class FloorUpload(DTO):
    id: UUID
    image: FloorImage


class Panorama(PanoramaContent):
    id: UUID
    point_id: UUID
    revision: Revision


class GuideLink(DTO):
    kind: Literal["focus_point", "show_floor", "open_vr"]
    label: str
    url: str
    point_id: UUID
    resource_id: UUID | None = None
    revision: Revision
    section: str | None = None


class GuidePoint(DTO):
    point: Point
    floors: list[Floor]
    panoramas: list[Panorama]
    links: list[GuideLink]
    retrieved_at: datetime
    interaction: Literal["user_click_link"] = "user_click_link"


class AuditEvent(DTO):
    id: UUID
    actor_id: UUID
    actor_name: str
    action: str
    campus_id: CampusId | None
    point_id: UUID | None
    note: str
    details: dict
    created_at: datetime


class InquiryStats(DTO):
    period_start: datetime
    period_end: datetime
    total: int = Field(ge=0)
    unresolved: int = Field(ge=0)
    referred: int = Field(ge=0)
    frequent_questions: list[str]


class SourceDraftInput(DTO):
    title: str = Field(min_length=1, max_length=200)
    issuer: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=100000)
    visibility: Visibility
    source_url: str | None = None
    effective_until: datetime | None = None


class SourceDraft(DTO):
    id: UUID
    revision: Revision
    status: ContentStatus


class MediaRegistration(DTO):
    point_id: UUID | None = None
    kind: Literal["image", "panorama", "floorplan", "audio", "document"]
    title: str = Field(min_length=1, max_length=200)
    external_url: str | None = None
    uploaded_file_id: UUID | None = None
    visibility: Visibility
    rights_note: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def one_location(self):
        if (self.external_url is None) == (self.uploaded_file_id is None):
            raise ValueError("provide exactly one of external_url and uploaded_file_id")
        return self


class UploadedFile(DTO):
    id: UUID
    sha256: str
    bytes: int = Field(ge=0)
    mime_type: str


class AdminMedia(DTO):
    media: MediaInfo
    status: ContentStatus


class SourceDraftUpdate(SourceDraftInput):
    expected_revision: Revision


class AdminSource(SourceDraftInput):
    id: UUID
    revision: Revision
    status: ContentStatus


class AdminInquiry(Inquiry):
    question_redacted: str
    category: Literal["visit_policy", "campus_info", "content_correction", "other"]
    revision: Revision
    resolution_note: str | None = None
    official_channel_id: UUID | None = None


class InquiryResolution(DTO):
    expected_revision: Revision
    status: Literal["resolved", "referred"]
    note: str = Field(min_length=1, max_length=2000)
    official_channel_id: UUID | None = None

    @model_validator(mode="after")
    def referral_needs_channel(self):
        if self.status == "referred" and self.official_channel_id is None:
            raise ValueError("referred status requires an official channel")
        return self
