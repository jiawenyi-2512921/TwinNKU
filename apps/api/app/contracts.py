"""Canonical public DTOs. Includes planned modules; schemas are not implementations."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator

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
    tours: bool = False
    admin: bool = False


class SystemStatus(DTO):
    service: Literal["twinnku-api"] = "twinnku-api"
    version: str
    api_version: Literal["v1"] = "v1"
    capabilities: Capabilities


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


class Floor(DTO):
    id: UUID
    point_id: UUID
    label: str
    ordinal: int
    map_id: UUID
    revision: Revision


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


class PointDraftInput(DTO):
    campus_id: CampusId
    name: str = Field(min_length=1, max_length=120)
    aliases: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=20
    )
    category: PointCategory
    summary: str = Field(max_length=2000)
    visibility: Visibility
    source_ids: list[UUID] = Field(min_length=1, max_length=20)


class PointDraftUpdate(PointDraftInput):
    expected_revision: Revision


class ReviewRequest(DTO):
    expected_revision: Revision
    note: str = Field(min_length=1, max_length=1000)


class AdminPoint(DTO):
    point: Point
    status: ContentStatus
    visibility: Visibility
    source_ids: list[UUID]


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
