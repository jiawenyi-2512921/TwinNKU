"""One scoped, paginated inbox for point, floor and panorama changes.

This is a read model over existing drafts. It neither migrates their state nor
offers a second publication path: actions retain the original review checks.
"""

from typing import Literal

from fastapi import APIRouter, Query, Request
from sqlalchemy import String, cast, func, literal, or_, select, union_all
from sqlalchemy.orm import aliased

from app.api import DB, envelope
from app.contracts import AdminChangeItem, AdminWorkbench, Envelope, ErrorEnvelope, Pagination
from app.models import (
    FloorRecord,
    PanoramaRecord,
    PointChangeRecord,
    PointRecord,
    ResourceChangeRecord,
    StaffUserRecord,
)
from app.modules.admin.router import STAFF
from app.modules.admin.security import PERMISSIONS, Actor, point_scope, utc

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    responses={code: {"model": ErrorEnvelope} for code in [401, 403, 422, 503]},
)


def change_query(user):
    """Apply scope before union, ordering, counts or pagination."""
    selections = []
    for model in (PointChangeRecord, ResourceChangeRecord):
        is_point = model is PointChangeRecord
        editor, submitter = aliased(StaffUserRecord), aliased(StaffUserRecord)
        title = (
            func.coalesce(model.payload["name"].as_string(), PointRecord.name)
            if is_point
            else func.coalesce(
                model.payload["content"]["title"].as_string(),
                model.payload["content"]["label"].as_string(),
                PanoramaRecord.title,
                FloorRecord.label,
                "资料",
            )
        )
        query = (
            select(
                (model.point_id if is_point else model.resource_id).label("id"),
                (literal("point") if is_point else model.kind).label("kind"),
                model.point_id,
                PointRecord.campus_id,
                PointRecord.name.label("point_name"),
                title.label("title"),
                model.state,
                model.operation,
                model.revision,
                model.editor_id,
                model.submitted_by,
                model.contributor_ids,
                editor.display_name.label("editor_name"),
                submitter.display_name.label("submitted_by_name"),
                model.submitted_at,
                model.updated_at,
                model.review_note,
            )
            .select_from(model)
            .join(PointRecord, PointRecord.id == model.point_id)
            .join(editor, editor.id == model.editor_id)
            .outerjoin(submitter, submitter.id == model.submitted_by)
            .where(point_scope(user))
        )
        if not is_point:
            query = query.outerjoin(
                PanoramaRecord, PanoramaRecord.id == model.resource_id
            ).outerjoin(FloorRecord, FloorRecord.id == model.resource_id)
        selections.append(query)
    return union_all(*selections).subquery()


def mine_clause(changes, user_id):
    # IDs are canonical UUIDs. Match the complete quoted JSON string, including
    # upload contributors, on both PostgreSQL JSON and the SQLite test fixture.
    return or_(
        changes.c.editor_id == user_id,
        changes.c.submitted_by == user_id,
        cast(changes.c.contributor_ids, String).contains(f'"{user_id}"', autoescape=True),
    )


@router.get(
    "/changes",
    response_model=Envelope[list[AdminChangeItem]],
    operation_id="listAdminChanges",
    openapi_extra=STAFF,
)
def changes(
    request: Request,
    actor: Actor,
    db: DB,
    state: Literal["draft", "in_review", "rejected", "published", "discarded"] | None = "in_review",
    kind: Literal["point", "floor", "panorama"] | None = None,
    q: str = Query("", max_length=120),
    mine: bool = False,
    order: Literal["oldest", "newest"] = "oldest",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    actor.require("points.read")
    rows = change_query(actor.user)
    query = select(rows)
    if state:
        query = query.where(rows.c.state == state)
    if kind:
        query = query.where(rows.c.kind == kind)
    if mine:
        query = query.where(mine_clause(rows, actor.user.id))
    if q.strip():
        term = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(
            or_(
                rows.c.title.ilike(f"%{term}%", escape="\\"),
                rows.c.point_name.ilike(f"%{term}%", escape="\\"),
            )
        )
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    time = func.coalesce(rows.c.submitted_at, rows.c.updated_at)
    query = (
        query.order_by(
            time.asc() if order == "oldest" else rows.c.updated_at.desc(), rows.c.kind, rows.c.id
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = []
    for row in db.execute(query).mappings():
        own = actor.user.id in row["contributor_ids"] or actor.user.id in {
            row["editor_id"],
            row["submitted_by"],
        }
        values = {
            k: v
            for k, v in row.items()
            if k not in {"editor_id", "submitted_by", "contributor_ids"}
        }
        values["updated_at"] = utc(values["updated_at"])
        if values["submitted_at"]:
            values["submitted_at"] = utc(values["submitted_at"])
        result.append(
            AdminChangeItem(
                **values,
                is_mine=own,
                can_review=(
                    row["state"] == "in_review"
                    and not own
                    and "points.review" in PERMISSIONS[actor.user.role]
                ),
            )
        )
    return envelope(request, result, Pagination(page=page, page_size=page_size, total=total))


@router.get(
    "/workbench",
    response_model=Envelope[AdminWorkbench],
    operation_id="getAdminWorkbench",
    openapi_extra=STAFF,
)
def workbench(request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    rows = change_query(actor.user)
    counts = db.execute(
        select(rows.c.kind, rows.c.state, func.count()).group_by(rows.c.kind, rows.c.state)
    ).all()
    states = {
        s: sum(n for _, state, n in counts if state == s)
        for s in ("in_review", "draft", "rejected")
    }
    return envelope(
        request,
        AdminWorkbench(
            point_count=db.scalar(
                select(func.count()).select_from(PointRecord).where(point_scope(actor.user))
            ),
            pending_count=states["in_review"],
            draft_count=states["draft"],
            rejected_count=states["rejected"],
            my_pending_count=db.scalar(
                select(func.count())
                .select_from(rows)
                .where(rows.c.state == "in_review", mine_clause(rows, actor.user.id))
            ),
            pending_by_kind={
                k: sum(n for kind, s, n in counts if kind == k and s == "in_review")
                for k in ("point", "floor", "panorama")
            },
        ),
    )
