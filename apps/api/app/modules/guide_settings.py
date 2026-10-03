"""Audited runtime controls. Credentials stay in server environment variables."""

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import Field

from app.api import DB, envelope
from app.contracts import DTO, Envelope
from app.core.errors import DomainError
from app.models import GuideSettingsRecord
from app.modules.admin.security import Actor


class GuidePolicy(DTO):
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
    visitor_turns_per_hour: int = Field(default=30, ge=1, le=120)
    total_turns_per_hour: int = Field(default=120, ge=1, le=1000)


class GuidePolicyUpdate(DTO):
    expected_revision: int = Field(ge=0)
    policy: GuidePolicy
    note: str = Field(min_length=1, max_length=500)


class GuidePolicyView(DTO):
    revision: int
    policy: GuidePolicy
    api_configured: bool
    provider: str
    concurrency_limit: int = 4
    session_limit: int = 64
    note: str


router = APIRouter(tags=["admin"])
META = {"x-implementation-status": "implemented", "x-module": "M04", "x-auth": "staff"}


def policy_for(db, settings=None):
    from app.modules.configurations import effective_runtime, runtime_policy

    return effective_runtime(db, settings) if settings else runtime_policy(db)


def view(db, request):
    row = db.get(GuideSettingsRecord, 1)
    configured = request.app.state.settings.api_agent_configured
    return GuidePolicyView(
        revision=row.revision if row else 0,
        policy=GuidePolicy.model_validate(policy_for(db, request.app.state.settings), from_attributes=True),
        api_configured=configured,
        provider="nk-genios-api" if configured else "未配置后端应用 API",
        note=row.note if row else "尚未修改；此状态仅反映配置，不代表学校平台连通性。",
    )


@router.get(
    "/api/v1/admin/guide-settings",
    response_model=Envelope[GuidePolicyView],
    operation_id="getGuidePolicy",
    openapi_extra=META,
)
def get_policy(request: Request, actor: Actor, db: DB):
    if actor.user.role != "admin":
        raise DomainError("FORBIDDEN", "系统运行设置仅对管理员开放", 403)
    return envelope(request, view(db, request))


@router.put(
    "/api/v1/admin/guide-settings",
    response_model=Envelope[GuidePolicyView],
    operation_id="updateGuidePolicy",
    openapi_extra=META,
)
def update_policy(payload: GuidePolicyUpdate, request: Request, actor: Actor, db: DB):
    if actor.user.role != "admin":
        raise DomainError("FORBIDDEN", "只有管理员能修改系统运行设置", 403)
    raise DomainError("POLICY_REVIEW_REQUIRED", "运行设置需在配置工作区保存草稿并经独立审核后生效", 409)
