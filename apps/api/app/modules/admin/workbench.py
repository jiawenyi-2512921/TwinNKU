"""One scoped, paginated inbox for every existing reviewed content type.

This is a read model over existing drafts. It neither migrates their state nor
offers a second publication path: actions retain the original review checks.
"""

from types import SimpleNamespace
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request
from sqlalchemy import String, case, cast, func, literal, or_, select, union_all
from sqlalchemy.orm import aliased

from app.api import DB, envelope
from app.configuration_models import ConfigurationRecord
from app.content_history_models import ExperienceSubmissionRecord
from app.contracts import AdminChangeItem, AdminWorkbench, Envelope, ErrorEnvelope, Pagination
from app.core.errors import DomainError
from app.models import (
    CampusRecord,
    ExperienceRecord,
    FloorRecord,
    MapRecord,
    NavigationRecord,
    PanoramaRecord,
    PointChangeRecord,
    PointRecord,
    ResourceChangeRecord,
    StaffUserRecord,
)
from app.modules.admin.issues import router as issues_router
from app.modules.admin.review_queue import router as review_queue_router
from app.modules.admin.router import STAFF
from app.modules.admin.security import PERMISSIONS, Actor, point_scope, utc
from app.modules.configurations import granted, readable
from app.modules.experiences import require_record
from app.modules.navigation import scoped_map

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    responses={code: {"model": ErrorEnvelope} for code in [401, 403, 422, 503]},
)
router.include_router(issues_router)
router.include_router(review_queue_router)


KINDS = ("point", "floor", "panorama", "media", "checkin", "tour", "navigation", "configuration")


def change_query(db, user):
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
    # Tour authorization covers every stop in both its draft and published
    # snapshots. Reuse the detail guard before counting, filtering or paging.
    actor = SimpleNamespace(user=user)
    allowed_experiences = []
    candidates = select(ExperienceRecord)
    if user.role != "admin":
        candidates = candidates.where(ExperienceRecord.campus_id.in_(user.campus_ids))
    for record in db.scalars(candidates):
        try:
            require_record(db, actor, record.id)
        except DomainError:
            continue
        allowed_experiences.append(record.id)
    submitter = aliased(StaffUserRecord)
    model = ExperienceRecord
    selections.append(
        select(
            model.id,
            model.kind,
            model.point_id,
            model.campus_id,
            func.coalesce(PointRecord.name, CampusRecord.name).label("point_name"),
            func.coalesce(
                model.draft["title"].as_string(), model.published["title"].as_string(), "体验资料"
            ).label("title"),
            model.state,
            model.operation,
            model.revision,
            literal(None, type_=String).label("editor_id"),
            model.submitted_by,
            model.contributor_ids,
            literal("协作成员（详见操作记录）").label("editor_name"),
            submitter.display_name.label("submitted_by_name"),
            ExperienceSubmissionRecord.submitted_at,
            model.updated_at,
            model.review_note,
        )
        .select_from(model)
        .join(CampusRecord, CampusRecord.id == model.campus_id)
        .outerjoin(PointRecord, PointRecord.id == model.point_id)
        .outerjoin(submitter, submitter.id == model.submitted_by)
        .outerjoin(ExperienceSubmissionRecord, ExperienceSubmissionRecord.experience_id == model.id)
        .where(model.id.in_(allowed_experiences))
    )
    # A road graph needs whole-campus scope and an eligible published map;
    # a staff member restricted to individual points must not see it here.
    allowed_maps = []
    for map_id in db.scalars(
        select(NavigationRecord.map_id)
        .join(MapRecord, MapRecord.id == NavigationRecord.map_id)
        .where(MapRecord.kind == "campus")
    ):
        try:
            scoped_map(db, actor, map_id)
        except DomainError:
            continue
        allowed_maps.append(map_id)
    model = NavigationRecord
    selections.append(
        select(
            model.map_id.label("id"),
            literal("navigation").label("kind"),
            literal(None, type_=String).label("point_id"),
            MapRecord.campus_id,
            MapRecord.title.label("point_name"),
            (MapRecord.title + " · 道路路网").label("title"),
            model.state,
            literal("upsert").label("operation"),
            model.revision,
            literal(None, type_=String).label("editor_id"),
            literal(None, type_=String).label("submitted_by"),
            model.contributor_ids,
            literal("协作成员（详见操作记录）").label("editor_name"),
            literal(None, type_=String).label("submitted_by_name"),
            literal(None).label("submitted_at"),
            model.updated_at,
            model.review_note,
        )
        .select_from(model)
        .join(MapRecord, MapRecord.id == model.map_id)
        .where(model.map_id.in_(allowed_maps))
    )
    allowed_configurations = [
        row.id for row in db.scalars(select(ConfigurationRecord)) if readable(db, actor, row)
    ]
    model = ConfigurationRecord
    submitter = aliased(StaffUserRecord)
    selections.append(
        select(
            model.id,
            literal("configuration").label("kind"),
            literal(None, type_=String).label("point_id"),
            case((model.scope == "global", None), else_=model.scope).label("campus_id"),
            func.coalesce(CampusRecord.name, "全站").label("point_name"),
            case(
                (model.kind == "presentation", "网站展示配置"),
                (model.kind == "visit_defaults", "参观默认设置"),
                else_="运行策略",
            ).label("title"),
            model.state,
            literal("upsert").label("operation"),
            model.revision,
            literal(None, type_=String).label("editor_id"),
            model.submitted_by,
            model.contributor_ids,
            literal("协作成员（详见操作记录）").label("editor_name"),
            submitter.display_name.label("submitted_by_name"),
            model.submitted_at,
            model.updated_at,
            model.review_note,
        )
        .select_from(model)
        .outerjoin(CampusRecord, CampusRecord.id == model.scope)
        .outerjoin(submitter, submitter.id == model.submitted_by)
        .where(model.id.in_(allowed_configurations))
    )
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
    kind: Literal[
        "point", "floor", "panorama", "media", "checkin", "tour", "navigation", "configuration"
    ]
    | None = None,
    item_id: UUID | None = None,
    q: str = Query("", max_length=120),
    mine: bool = False,
    order: Literal["oldest", "newest"] = "oldest",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    actor.require("points.read")
    rows = change_query(db, actor.user)
    query = select(rows)
    if state:
        query = query.where(rows.c.state == state)
    if kind:
        query = query.where(rows.c.kind == kind)
    if item_id:
        query = query.where(rows.c.id == str(item_id))
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
        if row["kind"] == "configuration":
            configuration = db.get(ConfigurationRecord, row["id"])
            review_permission = granted(
                db, actor, configuration.kind, configuration.scope, "review"
            )
        else:
            review_permission = "points.review" in PERMISSIONS[actor.user.role]
        result.append(
            AdminChangeItem(
                **values,
                is_mine=own,
                can_review=(row["state"] == "in_review" and not own and review_permission),
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
    rows = change_query(db, actor.user)
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
                k: sum(n for kind, s, n in counts if kind == k and s == "in_review") for k in KINDS
            },
        ),
    )
