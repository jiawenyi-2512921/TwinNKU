"""Strict form contracts: no executable code, secrets or arbitrary components."""

from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import Field, FiniteFloat, TypeAdapter, field_validator, model_validator

from app.contracts import DTO, XY, PointCategory

ConfigurationKind = Literal["presentation", "visit_defaults", "runtime"]
ConfigurationPermission = Literal[
    "configurations.edit", "configurations.review", "runtime.edit", "runtime.review"
]
ControlledService = Literal[
    "chat", "voice", "narration_generation", "narration_playback", "navigation"
]


class ConfigurationReference(DTO):
    type: Literal["image", "tour", "floor", "vr", "video", "checkin", "point"]
    id: UUID
    revision: int = Field(ge=1)


class PageTarget(DTO):
    type: Literal["home", "map", "vr", "routes"]


class TourTarget(DTO):
    type: Literal["tour"]
    id: UUID
    revision: int = Field(ge=1)


class ImageFocus(DTO):
    x: float = Field(default=0.5, ge=0, le=1)
    y: float = Field(default=0.5, ge=0, le=1)


class Appearance(DTO):
    palette: Literal["nku-purple", "light-purple"] = "nku-purple"
    density: Literal["comfortable", "compact"] = "comfortable"
    radius: Literal["soft", "square"] = "soft"


class PresentationModule(DTO):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    type: Literal[
        "hero",
        "visit_modes",
        "continue_visit",
        "featured_routes",
        "all_routes",
        "introduction",
        "resource_entries",
        "announcement",
    ]
    enabled: bool = True
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=4000)
    button_label: str = Field(default="开始发现", min_length=1, max_length=40)
    layout: Literal["default", "wide", "split"] = "default"
    image: ConfigurationReference | None = None
    routes: list[ConfigurationReference] = Field(default_factory=list, max_length=50)
    target: Annotated[PageTarget | TourTarget, Field(discriminator="type")] | None = None
    image_focus: ImageFocus = Field(default_factory=ImageFocus)
    alt: str = Field(default="", max_length=500)
    source_url: str | None = Field(default=None, max_length=2048)
    start_at: datetime | None = None
    end_at: datetime | None = None

    @field_validator("source_url")
    @classmethod
    def https_source(cls, value):
        if value:
            parts = urlsplit(value)
            if (
                parts.scheme != "https"
                or not parts.hostname
                or parts.username
                or parts.password
                or "\\" in value
                or any(ord(c) < 32 for c in value)
            ):
                raise ValueError("来源必须是无凭据的 HTTPS 网址")
        return value

    @model_validator(mode="after")
    def correct_types(self):
        if self.image and self.image.type != "image":
            raise ValueError("主视觉只能引用图片")
        if any(r.type != "tour" for r in self.routes):
            raise ValueError("路线列表只能引用导览路线")
        if (self.start_at and self.start_at.tzinfo is None) or (
            self.end_at and self.end_at.tzinfo is None
        ):
            raise ValueError("公告时间必须包含时区")
        if self.start_at and self.end_at and self.start_at >= self.end_at:
            raise ValueError("公告结束时间必须晚于开始时间")
        return self


def default_modules():
    return [
        PresentationModule(id=name, type=name)
        for name in ("hero", "visit_modes", "continue_visit", "all_routes", "resource_entries")
    ]


class PresentationContent(DTO):
    kind: Literal["presentation"] = "presentation"
    site_name: str = Field(default="南开校园文化导览", max_length=120)
    description: str = Field(default="", max_length=1000)
    footer: str = Field(default="", max_length=1000)
    contact_help: str = Field(default="", max_length=1000)
    appearance: Appearance = Field(default_factory=Appearance)
    modules: list[PresentationModule] = Field(default_factory=default_modules, max_length=30)

    @model_validator(mode="after")
    def unique_modules(self):
        if len({m.id for m in self.modules}) != len(self.modules):
            raise ValueError("模块 ID 不可重复")
        singleton = [m.type for m in self.modules if m.type not in {"announcement", "introduction"}]
        if len(set(singleton)) != len(singleton):
            raise ValueError("此模块类型不能重复")
        return self


class MapDefaultView(DTO):
    """Native image pixels; camera zoom is independent of source tile levels."""

    map_id: UUID
    map_revision: int = Field(ge=1)
    center: XY
    zoom: FiniteFloat = Field(ge=-8, le=17)
    min_zoom: FiniteFloat = Field(default=-8, ge=-8, le=17)
    max_zoom: FiniteFloat = Field(ge=-8, le=17)

    @model_validator(mode="after")
    def ordered_zoom(self):
        if not self.min_zoom <= self.zoom <= self.max_zoom:
            raise ValueError("默认缩放必须处于允许的相机缩放范围内")
        return self


class VisitDefaultsContent(DTO):
    kind: Literal["visit_defaults"] = "visit_defaults"
    layout: Literal["balanced", "scene_first", "reading_first"] = "balanced"
    assistant_collapsed: bool = True
    welcome_text: str = Field(default="", max_length=500)
    recommended_questions: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=6
    )
    map_categories: list[PointCategory] = Field(default_factory=list, max_length=20)
    map_show_labels: bool = True
    map_default_view: MapDefaultView | None = None
    # Labels retain their single existing switch; base/navigation are mandatory.
    map_layers: list[Literal["point_regions"]] = Field(
        default_factory=lambda: ["point_regions"], max_length=1
    )
    map_focus_effect: Literal["instant", "short"] = "short"

    @field_validator("map_categories")
    @classmethod
    def ordered_categories(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("地图分类不可重复")
        return value


class RuntimeContent(DTO):
    kind: Literal["runtime"] = "runtime"
    chat_enabled: bool = True
    navigation_enabled: bool = True
    auto_actions: bool = True
    allowed_actions: list[
        Literal[
            "focus_point",
            "show_floor",
            "open_vr",
            "show_route",
            "show_checkin",
            "play_video",
            "show_tour",
        ]
    ] = Field(
        default_factory=lambda: [
            "focus_point",
            "show_floor",
            "open_vr",
            "show_route",
            "show_checkin",
            "play_video",
            "show_tour",
        ],
        max_length=7,
    )
    voice_enabled: bool = True
    narration_generation_enabled: bool = False
    narration_playback_enabled: bool = True
    profile_id: Literal["standard"] = "standard"
    narration_staff_requests_per_hour: int = Field(default=45, ge=1, le=1000)
    narration_staff_requests_per_day: int = Field(default=270, ge=1, le=6000)
    visitor_turns_per_hour: int = Field(default=30, ge=1, le=120)
    total_turns_per_hour: int = Field(default=120, ge=1, le=1000)
    model_requests_per_day: int = Field(default=720, ge=1, le=6000)
    voice_visitor_requests_per_hour: int = Field(default=45, ge=1, le=1000)
    voice_total_requests_per_hour: int = Field(default=200, ge=1, le=10000)
    voice_requests_per_day: int = Field(default=1200, ge=1, le=60000)
    supplier_requests_per_day: int = Field(default=1920, ge=1, le=66000)
    supplier_characters_per_day: int = Field(default=360000, ge=1, le=18000000)
    supplier_session_requests_per_day: int = Field(default=450, ge=1, le=66000)
    ip_requests_per_hour: int = Field(default=180, ge=1, le=10000)
    ip_requests_per_day: int = Field(default=1080, ge=1, le=60000)
    http_requests_per_hour: int = Field(default=2400, ge=1, le=100000)
    http_requests_per_day: int = Field(default=14400, ge=1, le=600000)


ConfigurationContent = Annotated[
    PresentationContent | VisitDefaultsContent | RuntimeContent, Field(discriminator="kind")
]
CONTENT = TypeAdapter(ConfigurationContent)


class ConfigurationCreate(DTO):
    kind: ConfigurationKind
    scope: str = Field(default="global", min_length=1, max_length=80)
    content: ConfigurationContent
    note: str = Field(default="", max_length=500)
    operation_id: UUID


class ConfigurationPreview(DTO):
    kind: Literal["presentation", "visit_defaults"]
    scope: str = Field(default="global", min_length=1, max_length=80)
    campus_id: str = Field(min_length=1, max_length=80)
    content: ConfigurationContent


class ConfigurationSave(DTO):
    expected_revision: int = Field(ge=1)
    expected_published_revision: int = Field(ge=0)
    content: ConfigurationContent
    note: str = Field(default="", max_length=500)
    operation_id: UUID


class ConfigurationAction(DTO):
    expected_revision: int = Field(ge=1)
    expected_published_revision: int = Field(ge=0)
    note: str = Field(default="", max_length=500)
    operation_id: UUID


class ConfigurationPermissionFlags(DTO):
    edit: bool
    review: bool


class AdminConfiguration(DTO):
    id: UUID
    kind: ConfigurationKind
    scope: str
    schema_version: int
    revision: int
    published_revision: int
    state: Literal["draft", "in_review", "rejected", "published"]
    draft: ConfigurationContent
    published: ConfigurationContent | None
    contributor_ids: list[UUID]
    submitted_by: UUID | None
    submitted_at: datetime | None
    resume_services: list[ControlledService]
    review_note: str
    updated_at: datetime
    permissions: ConfigurationPermissionFlags
    content_sha256: str
    override_fields: list[str] = Field(default_factory=list)


class ConfigurationIssue(DTO):
    code: str
    severity: Literal["error", "warning"]
    path: str
    message: str
    expected_revision: int | None = None
    actual_revision: int | None = None


class ConfigurationPreflight(DTO):
    valid: bool
    revision: int
    content_sha256: str
    dependency_sha256: str
    issues: list[ConfigurationIssue]


class ConfigurationVersion(DTO):
    id: UUID
    configuration_id: UUID
    event: str
    revision: int
    published_revision: int
    content: ConfigurationContent
    content_sha256: str
    contributor_ids: list[UUID]
    actor_id: UUID | None
    created_at: datetime
    override_fields: list[str] = Field(default_factory=list)


class ConfigurationOperation(DTO):
    id: UUID
    target_id: UUID
    action: str
    result: AdminConfiguration | dict
    created_at: datetime


class ConfigurationGrantUpdate(DTO):
    scope: str = Field(default="global", min_length=1, max_length=80)
    enabled: bool
    note: str = Field(min_length=1, max_length=500)


class ConfigurationGrant(DTO):
    user_id: UUID
    permission: ConfigurationPermission
    scope: str
    granted_by: UUID
    note: str
    updated_at: datetime


class ServiceControlAction(DTO):
    note: str = Field(min_length=1, max_length=500)
    operation_id: UUID


class ShowcaseRouteCard(DTO):
    id: UUID
    campus_id: str
    revision: int
    title: str
    description: str
    cover_image_id: UUID | None = None
    cover_image_revision: int | None = None
    media_url: str | None = None
    stop_count: int
    sort_order: int = 0
    benefits: list[str] = Field(default_factory=list)
    resource_types: list[Literal["image", "video", "floor", "vr", "checkin"]] = Field(
        default_factory=list
    )


class ShowcaseResource(DTO):
    type: str
    id: UUID
    revision: int
    title: str
    url: str | None = None
    point_id: UUID | None = None


class Showcase(DTO):
    campus_id: str
    presentation: PresentationContent
    visit_defaults: VisitDefaultsContent
    configuration_revisions: dict[str, int]
    visit_default_sources: dict[str, Literal["builtin", "global", "campus"]] = Field(default_factory=dict)
    routes: list[ShowcaseRouteCard]
    resolved_resources: list[ShowcaseResource]
    capabilities: dict[str, bool]
