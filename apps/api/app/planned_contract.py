"""Design-only router. Never imported by app.main or mounted in production."""

import inspect
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, File, Query, UploadFile
from fastapi.responses import StreamingResponse

from app import contracts as c

router = APIRouter()


def planned(
    method,
    path,
    operation_id,
    module,
    response,
    body=None,
    auth="public",
    status=200,
    description="",
    upload=False,
):
    async def unavailable(**_kwargs):
        raise RuntimeError("Design-only handler must never be served")

    parameters = []
    for part in path.split("/"):
        if part.startswith("{"):
            name = part.strip("{}")
            annotation = c.CampusId if name == "campus_id" else UUID
            parameters.append(
                inspect.Parameter(
                    name, inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=annotation
                )
            )
    if body:
        parameters.append(
            inspect.Parameter(
                "payload",
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=Annotated[body, Body()],
            )
        )
    if upload:
        parameters.append(
            inspect.Parameter(
                "file",
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=Annotated[UploadFile, File()],
            )
        )
    if method == "GET" and path in {
        "/admin/points",
        "/admin/sources",
        "/admin/media",
        "/admin/inquiries",
    }:
        parameters.extend(
            [
                inspect.Parameter(
                    "page",
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    annotation=int,
                    default=Query(1, ge=1),
                ),
                inspect.Parameter(
                    "page_size",
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    annotation=int,
                    default=Query(20, ge=1, le=100),
                ),
            ]
        )
    unavailable.__signature__ = inspect.Signature(parameters)
    unavailable.__name__ = operation_id
    errors = {
        code: {"model": c.ErrorEnvelope}
        for code in [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 503, 504]
    }
    kwargs = {}
    if response is None:
        kwargs["response_class"] = StreamingResponse
        errors[200] = {
            "description": "SSE stream; JSON data in each event follows ChatEvent",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    router.add_api_route(
        "/api/v1" + path,
        unavailable,
        methods=[method],
        operation_id=operation_id,
        response_model=c.Envelope[response] if response is not None else None,
        status_code=status,
        tags=[module],
        responses=errors,
        description="PLANNED, NOT IMPLEMENTED. " + description,
        openapi_extra={"x-implementation-status": "planned", "x-module": module, "x-auth": auth},
        **kwargs,
    )


planned("GET", "/points/{point_id}/media", "listPointMedia", "M02", list[c.MediaInfo])
planned(
    "GET",
    "/media/{media_id}/access",
    "getMediaAccess",
    "M02",
    c.MediaAccess,
    auth="resource_policy",
)
planned("GET", "/points/{point_id}/narrations", "listNarrations", "M02", list[c.Narration])
planned(
    "POST",
    "/routes",
    "calculateRoute",
    "M03",
    c.RouteResult,
    c.RouteRequest,
    auth="guest_session",
    status=201,
)
planned("GET", "/routes/{route_id}", "getRoute", "M03", c.RouteResult, auth="owner")
planned(
    "POST",
    "/auth/guest-session",
    "createGuestSession",
    "M02",
    c.GuestSession,
    status=201,
    description="Sets opaque HttpOnly Secure SameSite=Lax cookie. Returns separate CSRF token.",
)
planned("GET", "/auth/me", "getIdentity", "M02", c.Identity, auth="guest_session")
planned("DELETE", "/auth/session", "endSession", "M02", c.Identity, auth="guest_session")
planned(
    "POST",
    "/chat/sessions",
    "createChatSession",
    "M04",
    c.ChatSession,
    c.ChatSessionRequest,
    auth="guest_session",
    status=201,
)
planned(
    "POST",
    "/chat/sessions/{session_id}/turns",
    "createChatTurn",
    "M04",
    c.ChatTurnAccepted,
    c.ChatTurnRequest,
    auth="owner",
    status=202,
)
planned("GET", "/chat/turns/{turn_id}", "getChatTurn", "M04", c.ChatTurnAccepted, auth="owner")
planned(
    "GET",
    "/chat/turns/{turn_id}/events",
    "streamChatEvents",
    "M04",
    None,
    auth="owner",
    description="Event id is seq; resume with Last-Event-ID. See docs/05-agent-protocol.md.",
)
planned(
    "DELETE", "/chat/turns/{turn_id}", "cancelChatTurn", "M04", c.ChatTurnAccepted, auth="owner"
)
planned(
    "POST",
    "/chat/turns/{turn_id}/actions/{action_id}/ack",
    "acknowledgeAction",
    "M04",
    c.ActionAck,
    c.ActionAck,
    auth="owner",
)
planned("GET", "/floors/{floor_id}/rooms", "listRooms", "M05", list[c.Room], auth="resource_policy")
planned("GET", "/campuses/{campus_id}/tours", "listTourTemplates", "M06", list[c.TourTemplate])
planned(
    "POST",
    "/tour-plans",
    "createTourPlan",
    "M06",
    c.TourPlan,
    c.TourPlanRequest,
    auth="guest_session",
    status=201,
)
planned("GET", "/tour-plans/{plan_id}", "getTourPlan", "M06", c.TourPlan, auth="owner")
planned(
    "PATCH",
    "/tour-plans/{plan_id}",
    "adjustTourPlan",
    "M06",
    c.TourPlan,
    c.TourAdjustment,
    auth="owner",
)
planned("GET", "/official-channels", "listOfficialChannels", "M07", list[c.OfficialChannel])
planned(
    "POST",
    "/inquiries",
    "createInquiry",
    "M07",
    c.Inquiry,
    c.InquiryRequest,
    auth="guest_session",
    status=201,
)
planned(
    "POST",
    "/admin/sources",
    "createSourceDraft",
    "M01",
    c.SourceDraft,
    c.SourceDraftInput,
    auth="contributor",
    status=201,
)
planned(
    "POST",
    "/admin/sources/{source_id}/publish",
    "publishSource",
    "M01",
    c.SourceDraft,
    c.ReviewRequest,
    auth="reviewer",
)
planned(
    "POST",
    "/admin/sources/{source_id}/retire",
    "retireSource",
    "M01",
    c.SourceDraft,
    c.ReviewRequest,
    auth="reviewer",
)
planned(
    "POST",
    "/admin/uploads",
    "uploadFile",
    "M02",
    c.UploadedFile,
    auth="contributor",
    status=201,
    upload=True,
)
planned(
    "POST",
    "/admin/media",
    "registerMedia",
    "M02",
    c.MediaInfo,
    c.MediaRegistration,
    auth="contributor",
    status=201,
)
planned(
    "POST",
    "/admin/media/{media_id}/publish",
    "publishMedia",
    "M02",
    c.MediaInfo,
    c.ReviewRequest,
    auth="reviewer",
)
planned(
    "POST",
    "/admin/media/{media_id}/retire",
    "retireMedia",
    "M02",
    c.MediaInfo,
    c.ReviewRequest,
    auth="reviewer",
)
planned(
    "GET",
    "/admin/inquiries/stats",
    "getInquiryStats",
    "M07",
    c.InquiryStats,
    auth="analyst",
    description="Fixed trailing 7 UTC days in v1; raw personal conversations are not returned.",
)

planned("GET", "/admin/sources", "listAdminSources", "M01", list[c.AdminSource], auth="contributor")
planned(
    "GET", "/admin/sources/{source_id}", "getAdminSource", "M01", c.AdminSource, auth="contributor"
)
planned(
    "PUT",
    "/admin/sources/{source_id}",
    "updateSourceDraft",
    "M01",
    c.AdminSource,
    c.SourceDraftUpdate,
    auth="contributor",
)
planned("GET", "/admin/media", "listAdminMedia", "M02", list[c.AdminMedia], auth="contributor")
planned("GET", "/admin/media/{media_id}", "getAdminMedia", "M02", c.AdminMedia, auth="contributor")
planned(
    "GET", "/admin/inquiries", "listAdminInquiries", "M07", list[c.AdminInquiry], auth="analyst"
)
planned(
    "PATCH",
    "/admin/inquiries/{inquiry_id}",
    "resolveInquiry",
    "M07",
    c.AdminInquiry,
    c.InquiryResolution,
    auth="analyst",
)
