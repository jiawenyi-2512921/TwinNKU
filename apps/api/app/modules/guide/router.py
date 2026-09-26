from datetime import UTC, datetime
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Request

from app.api import DB, ERRORS, envelope, get_point
from app.contracts import AgentWebConfig, Envelope, GuideLink, GuidePoint
from app.modules.admin.resources import public_panoramas
from app.modules.floors.router import list_floors

router = APIRouter()
IMPLEMENTED = {"x-implementation-status": "implemented", "x-module": "M04", "x-auth": "public"}


@router.get(
    "/api/v1/agent/web-config",
    response_model=Envelope[AgentWebConfig],
    operation_id="getAgentWebConfig",
    tags=["agent"],
    openapi_extra=IMPLEMENTED,
)
def web_config(request: Request):
    settings = request.app.state.settings
    return envelope(
        request,
        AgentWebConfig(
            enabled=settings.web_agent_configured,
            app_key=settings.nk_genios_web_app_key.get_secret_value()
            if settings.web_agent_configured
            else None,
            hide_sidebar=settings.nk_genios_web_hide_sidebar,
            context_enabled=settings.nk_genios_web_context_enabled,
            public_site_origin=settings.public_site_origin,
        ),
    )


@router.get(
    "/api/v1/guide/points/{point_id}",
    response_model=Envelope[GuidePoint],
    operation_id="getGuidePoint",
    tags=["guide"],
    responses=ERRORS,
    summary="查询已公开点位及楼层、VR和可点击的导览链接",
    description=(
        "先通过 listPoints 获取真实 point_id。仅返回公开、已发布内容；"
        "links 是供用户点击的页面链接，不是已经执行的动作。"
        "楼层列表不表示已经识别图片内房间；不据此推断室内路线。"
        "资料来源如有记载保留在 point.summary 中；不要编造来源。"
    ),
    openapi_extra=IMPLEMENTED,
)
def guide_point(point_id: UUID, request: Request, db: DB):
    point = get_point(point_id, request, db)["data"]
    floors = list_floors(point_id, request, db)["data"]
    panoramas = public_panoramas(point_id, request, db)["data"]
    # Never derive outgoing links from an untrusted Host/X-Forwarded-Host header.
    origin = request.app.state.settings.public_site_origin

    def visit(**params):
        return f"{origin}/?{urlencode({'point': str(point_id), **params})}"

    links = [
        GuideLink(
            kind="focus_point",
            label=f"在地图查看{point.name}",
            url=visit(),
            point_id=point_id,
            revision=point.revision,
        )
    ]
    for floor in floors:
        for asset in floor.images:
            if asset.variant != "labeled":
                continue
            links.append(
                GuideLink(
                    kind="show_floor",
                    label=f"{floor.label}"
                    + (f" · {asset.section_label}" if asset.section_label else ""),
                    url=visit(floor=str(floor.id), floor_section=asset.section),
                    point_id=point_id,
                    resource_id=floor.id,
                    revision=floor.revision,
                    section=asset.section,
                )
            )
    for panorama in panoramas:
        links.append(
            GuideLink(
                kind="open_vr",
                label=panorama.title,
                url=visit(panorama=str(panorama.id)),
                point_id=point_id,
                resource_id=panorama.id,
                revision=panorama.revision,
            )
        )
    return envelope(
        request,
        GuidePoint(
            point=point,
            floors=floors,
            panoramas=panoramas,
            links=links,
            retrieved_at=datetime.now(UTC),
        ),
    )
