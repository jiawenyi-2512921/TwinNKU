"""Per-item review queue using the original, independent publication services.

There is deliberately no bulk transaction or inferred approval. Every request
requires real recent MFA, including during staged enrollment, and keeps the
original operation namespace so unknown outcomes use the normal receipt GET.
"""

from datetime import timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import Field

from app.api import DB
from app.contracts import DTO, Envelope, ErrorEnvelope, ReviewRequest
from app.core.errors import DomainError
from app.models import now_utc
from app.modules.admin.router import WRITE, point_write
from app.modules.admin.security import Actor, utc
from app.modules.uploads import storage_guard

router = APIRouter(responses={code: {"model": ErrorEnvelope} for code in (401, 403, 404, 409, 422)})


class ReviewQueuePublish(DTO):
    kind: Literal["point", "floor", "panorama", "media", "checkin", "tour", "navigation", "configuration"]
    id: UUID
    expected_revision: int = Field(ge=1)
    expected_published_revision: int = Field(ge=0)
    operation_id: UUID
    note: str = Field(min_length=1, max_length=500)
    video_accessibility_confirmed: bool = False


def require_queue_mfa(actor):
    # The enrollment flag may relax ordinary account rollout, never this queue.
    verified, now = actor.session.mfa_verified_at, now_utc()
    if verified is None or utc(verified) > now or utc(verified) + timedelta(minutes=5) <= now:
        raise DomainError("MFA_STEP_UP_REQUIRED", "逐项审核队列需要最近5分钟的通行密钥验证，请先验证再继续", 403)


def publish_queue_item(payload, request, actor, db):
    require_queue_mfa(actor)
    values = payload.model_dump(exclude={"kind", "id", "video_accessibility_confirmed"})
    if payload.kind == "point":
        return point_write("publish", payload.id, ReviewRequest(**values), request, actor, db)
    if payload.kind in {"floor", "panorama"}:
        from app.modules.admin.resources import _review_resource, load_resource

        _, current, change = load_resource(db, actor, payload.id)
        actual = change.kind if change else "floor" if hasattr(current, "images") else "panorama"
        if actual != payload.kind:
            raise DomainError("NOT_FOUND", "资料类型已变化，请重新读取待审项", 404)
        with storage_guard(request.app.state.settings):
            return _review_resource(payload.id, "publish", ReviewRequest(**values), request, actor, db)
    if payload.kind in {"media", "checkin", "tour"}:
        from app.modules.experiences import ExperienceReviewRequest, _review, require_record

        record = require_record(db, actor, payload.id)
        if record.kind != payload.kind:
            raise DomainError("NOT_FOUND", "体验类型已变化，请重新读取待审项", 404)
        with storage_guard(request.app.state.settings):
            return _review(payload.id, "publish", ExperienceReviewRequest(
                **values, video_accessibility_confirmed=payload.video_accessibility_confirmed,
            ), request, actor, db)
    if payload.kind == "navigation":
        from app.modules.navigation import RoadReview, review_navigation

        return review_navigation(payload.id, RoadReview(**values, action="publish"), request, actor, db)
    # Configuration-specific grants and frozen submitted hash are checked by
    # apply_action. General points.review permission never substitutes for them.
    from app.modules.configuration_schemas import ConfigurationAction
    from app.modules.configurations import apply_action

    return apply_action(payload.id, ConfigurationAction(**values), request, actor, db, "publish")


@router.post("/review-queue/publish", response_model=Envelope[dict],
             operation_id="publishReviewQueueItem", openapi_extra=WRITE)
def publish_item(payload: ReviewQueuePublish, request: Request, actor: Actor, db: DB):
    return publish_queue_item(payload, request, actor, db)
