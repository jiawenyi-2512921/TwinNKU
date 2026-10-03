"""Bounded saved-content checks; scope is applied before keyset pagination."""

import base64
import hashlib
import json
import re
from datetime import datetime
from functools import partial
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import Field
from sqlalchemy import JSON, and_, case, cast, exists, func, literal, or_, select, union_all

from app.api import DB, envelope
from app.configuration_models import ConfigurationGrantRecord, ConfigurationRecord
from app.contracts import DTO, Envelope, ResourceDraftData
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
)
from app.modules.admin.security import PERMISSIONS, Actor, point_scope, require_point, utc
from app.modules.configuration_schemas import CONTENT, ConfigurationIssue
from app.modules.configurations import granted, preflight_for, record_for, references
from app.modules.content_control import content_preflight
from app.modules.content_control_service import owned
from app.modules.experiences import (
    ExperienceTourContent,
    experience_preflight,
    public_point,
    require_campus_scope,
    require_record,
    stored_content,
)

EntityType = Literal[
    "point", "floor", "vr", "media", "checkin", "tour", "navigation", "configuration"
]
IssueAction = Literal["open", "edit", "review", "withdraw", "regenerate_audio", "replace_reference"]
KINDS = ("point", "floor", "vr", "media", "checkin", "tour", "navigation", "configuration")
ACTIVE = ("draft", "in_review", "rejected")
MAX_ISSUES = 300
MAX_REFERENCE_CHECKS = 2000
META = {"x-implementation-status": "implemented", "x-module": "M58", "x-auth": "staff"}
router = APIRouter(prefix="/workbench", tags=["admin"])


class WorkbenchIssue(DTO):
    entity_type: EntityType
    entity_id: UUID
    title: str
    campus_id: str | None
    point_id: UUID | None
    state: str
    revision: int
    published_revision: int
    code: str
    severity: Literal["info", "warning", "error"]
    message: str
    path: str
    stop_index: int | None = Field(default=None, ge=0)
    segment_id: str | None = None
    resource_type: (
        Literal["point", "map", "image", "video", "floor", "vr", "checkin", "tour", "narration"]
        | None
    ) = None
    resource_id: UUID | None = None
    expected_revision: int | None = None
    current_revision: int | None = None
    actions: list[IssueAction]


class WorkbenchIssueBatch(DTO):
    coverage: Literal["saved_entity_page"] = "saved_entity_page"
    checked_entity_count: int
    issue_count: int
    items: list[WorkbenchIssue]
    has_more: bool
    next_cursor: str | None
    omitted_issue_count: int = 0


def _experience_scope(db, user):
    """Match the detail guard for every stop in BOTH saved snapshots in SQL.

    PostgreSQL JSON and SQLite JSON1 use their native array iterators. No
    authorization-by-substring, scope-late count or all-record Python scan.
    """
    if user.role == "admin":
        return literal(True)
    clauses = [ExperienceRecord.campus_id.in_(user.campus_ids)]
    clauses.append(
        or_(
            ExperienceRecord.point_id.is_(None),
            exists(
                select(PointRecord.id).where(
                    PointRecord.id == ExperienceRecord.point_id, point_scope(user)
                )
            ),
        )
    )
    for index, snapshot in enumerate((ExperienceRecord.draft, ExperienceRecord.published)):
        if db.bind.dialect.name == "postgresql":
            stops = snapshot["stops"]
            array = case(
                (func.json_typeof(stops) == "array", stops), else_=cast(literal("[]"), JSON)
            )
            elements = (
                func.json_array_elements(array)
                .table_valued("value")
                .render_derived(name=f"issue_stops_{index}")
            )
        else:
            elements = (
                func.json_each(snapshot, "$.stops")
                .table_valued("value")
                .alias(f"issue_stops_{index}")
            )
        key = (
            cast(elements.c.value, JSON)["point_id"].as_string()
            if db.bind.dialect.name == "postgresql"
            else func.json_extract(elements.c.value, "$.point_id")
        )
        denied = exists(
            select(literal(1))
            .select_from(elements)
            .outerjoin(PointRecord, PointRecord.id == key)
            .where(or_(PointRecord.id.is_(None), ~point_scope(user)))
        )
        clauses.append(~denied)
    return and_(*clauses)


def saved_query(db, actor):
    user, parts = actor.user, []
    for model, kind, key in (
        (PointChangeRecord, literal("point"), PointChangeRecord.point_id),
        (
            ResourceChangeRecord,
            case((ResourceChangeRecord.kind == "floor", "floor"), else_="vr"),
            ResourceChangeRecord.resource_id,
        ),
    ):
        parts.append(
            select(
                key.label("id"),
                kind.label("kind"),
                PointRecord.campus_id.label("campus_id"),
                model.updated_at.label("updated_at"),
            )
            .join(PointRecord, PointRecord.id == model.point_id)
            .where(point_scope(user), model.state.in_(ACTIVE))
        )
    parts.append(
        select(
            ExperienceRecord.id,
            ExperienceRecord.kind,
            ExperienceRecord.campus_id,
            ExperienceRecord.updated_at,
        ).where(
            ExperienceRecord.state.in_((*ACTIVE, "published")),
            or_(
                and_(ExperienceRecord.operation == "retire", ExperienceRecord.state.in_(ACTIVE)),
                and_(
                    ExperienceRecord.operation == "upsert",
                    (
                        func.json_typeof(ExperienceRecord.draft)
                        if db.bind.dialect.name == "postgresql"
                        else func.json_type(ExperienceRecord.draft)
                    )
                    == "object",
                ),
            ),
            _experience_scope(db, user),
        )
    )
    nav = (
        select(
            NavigationRecord.map_id,
            literal("navigation"),
            MapRecord.campus_id,
            NavigationRecord.updated_at,
        )
        .join(MapRecord)
        .join(CampusRecord)
    )
    nav = nav.where(
        MapRecord.kind == "campus",
        MapRecord.status == "published",
        MapRecord.visibility == "public",
        CampusRecord.is_active.is_(True),
        NavigationRecord.state.in_(ACTIVE),
    )
    if user.role != "admin":
        nav = nav.where(MapRecord.campus_id.in_(user.campus_ids), literal(not bool(user.point_ids)))
    parts.append(nav)
    grant = exists(
        select(ConfigurationGrantRecord.user_id).where(
            ConfigurationGrantRecord.user_id == user.id,
            ConfigurationGrantRecord.scope.in_(["global", ConfigurationRecord.scope]),
            or_(
                and_(
                    ConfigurationRecord.kind == "runtime",
                    ConfigurationGrantRecord.permission.in_(["runtime.edit", "runtime.review"]),
                ),
                and_(
                    ConfigurationRecord.kind != "runtime",
                    ConfigurationGrantRecord.permission.in_(
                        ["configurations.edit", "configurations.review"]
                    ),
                ),
            ),
        )
    )
    parts.append(
        select(
            ConfigurationRecord.id,
            literal("configuration"),
            case((ConfigurationRecord.scope == "global", None), else_=ConfigurationRecord.scope),
            ConfigurationRecord.updated_at,
        ).where(grant)
    )
    return union_all(*parts).subquery()


def signature(actor, kind, key, campus):
    value = [
        actor.user.id,
        sorted(actor.user.campus_ids),
        sorted(actor.user.point_ids),
        kind,
        key,
        campus,
    ]
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def parse_cursor(value, expected):
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        time, kind, key, bound = json.loads(raw)
        time = datetime.fromisoformat(time)
        if time.tzinfo is None or kind not in KINDS or str(UUID(key)) != key or bound != expected:
            raise ValueError("invalid cursor")
        return time, kind, key
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        raise DomainError(
            "INVALID_CURSOR", "检查范围或游标已改变，请从第一页重新读取", 422
        ) from None


def cursor_for(row, bound):
    raw = json.dumps(
        [utc(row["updated_at"]).isoformat(), row["kind"], row["id"], bound], separators=(",", ":")
    ).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _resource(db, actor, kind, key):
    """A resource's revision is metadata, but still needs current staff scope."""
    model = (
        FloorRecord
        if kind == "floor"
        else PanoramaRecord
        if kind == "vr"
        else MapRecord
        if kind == "map"
        else PointRecord
        if kind == "point"
        else ExperienceRecord
    )
    row = db.get(model, str(key))
    if not row:
        return None
    if kind == "map":
        require_campus_scope(db, actor, row.campus_id)
    elif kind == "point":
        require_point(db, actor.user, row.id)
    elif model is ExperienceRecord:
        require_record(db, actor, row.id)
    else:
        require_point(db, actor.user, row.point_id)
    return row.published_revision if model is ExperienceRecord else row.revision


def _located_reference(content, path):
    """Return a structured location; never a client-supplied URL."""
    ref, stop_index, segment_id = None, None, None
    if isinstance(content, ExperienceTourContent):
        if path == "cover_image_id" and content.cover_image_id:
            return {
                "resource_type": "image",
                "resource_id": content.cover_image_id,
                "expected_revision": content.cover_image_revision,
            }
        match = re.fullmatch(
            r"stops\.(\d+)(?:\.segments\.(\d+))?(?:\.(main_view|resources|narration_asset_id|video_id|checkin_id)(?:\.(\d+))?)?",
            path,
        )
        if match and int(match[1]) < len(content.stops):
            stop_index = int(match[1])
            stop = content.stops[stop_index]
            if path == f"stops.{stop_index}":
                return {
                    "stop_index": stop_index,
                    "resource_type": "point",
                    "resource_id": stop.point_id,
                }
            if match[2] is not None and int(match[2]) < len(stop.segments or []):
                segment = stop.segments[int(match[2])]
                segment_id = segment.id
                if match[3] == "main_view":
                    ref = segment.main_view
                elif (
                    match[3] == "resources"
                    and match[4] is not None
                    and int(match[4]) < len(segment.resources)
                ):
                    ref = segment.resources[int(match[4])]
                elif match[3] == "narration_asset_id" and segment.narration_asset_id:
                    return {
                        "stop_index": stop_index,
                        "segment_id": segment_id,
                        "resource_type": "narration",
                        "resource_id": segment.narration_asset_id,
                    }
            elif match[3] in {"video_id", "checkin_id"}:
                key = getattr(stop, match[3])
                if key:
                    return {
                        "stop_index": stop_index,
                        "resource_type": "video" if match[3] == "video_id" else "checkin",
                        "resource_id": key,
                    }
    elif content.kind == "checkin" and path == "image_id" and content.image_id:
        return {"resource_type": "image", "resource_id": content.image_id}
    result = {"stop_index": stop_index, "segment_id": segment_id}
    if ref and ref.type != "map":
        result.update(
            resource_type="vr" if ref.type == "vr_entry" else ref.type,
            resource_id=ref.id,
            expected_revision=ref.revision,
        )
    return result


def inspect_entity(db, actor, item, settings, budget):
    kind, key = item["kind"], item["id"]
    content, config, checks = None, None, []
    if kind == "configuration":
        config = row = record_for(db, actor, key)
        content = CONTENT.validate_python(row.draft)
        title = {
            "presentation": "网站展示配置",
            "visit_defaults": "参观默认设置",
            "runtime": "运行策略",
        }[row.kind]
        campus, point = None if row.scope == "global" else row.scope, None
        revision, published_revision = row.revision, row.published_revision
        edit, review = (
            granted(db, actor, row.kind, row.scope, "edit"),
            granted(db, actor, row.kind, row.scope, "review"),
        )
        estimate = len(list(references(content)))
        validate = partial(preflight_for, db, actor, row, settings)
    elif kind in {"media", "checkin", "tour"}:
        row = require_record(db, actor, key)
        content = stored_content(row, row.draft or row.published)
        title, campus, point = content.title, row.campus_id, row.point_id
        revision, published_revision = row.revision, row.published_revision
        edit, review = (
            "points.edit" in PERMISSIONS[actor.user.role],
            "points.review" in PERMISSIONS[actor.user.role],
        )
        estimate = (
            1
            + len(content.stops)
            + sum(
                2 + len(segment.resources)
                for stop in content.stops
                for segment in stop.segments or []
            )
            + sum(bool(stop.video_id) + bool(stop.checkin_id) for stop in content.stops)
            if isinstance(content, ExperienceTourContent)
            else 1
        )
        validate = partial(experience_preflight, db, actor, row, settings)
    else:
        current, row = owned(db, actor, kind, key)
        if not row:
            raise DomainError("NOT_FOUND", "尚无已保存稿", 404)
        if kind == "point":
            title, campus, point, published_revision = (
                (row.payload or {}).get("name") or current.name,
                current.campus_id,
                current.id,
                current.revision,
            )
        elif kind in {"floor", "vr"}:
            p, resource = current
            resource_content = (
                ResourceDraftData.model_validate(row.payload).content if row.payload else None
            )
            title = (
                getattr(resource_content, "label", None)
                or getattr(resource_content, "title", None)
                or (
                    resource.label
                    if kind == "floor" and resource
                    else resource.title
                    if resource
                    else "资料"
                )
            )
            campus, point, published_revision = (
                p.campus_id,
                p.id,
                resource.revision if resource else 0,
            )
        else:
            title, campus, point, published_revision = (
                current.title + " · 道路路网",
                current.campus_id,
                None,
                row.published_revision,
            )
        revision = row.revision
        edit, review = (
            "points.edit" in PERMISSIONS[actor.user.role],
            "points.review" in PERMISSIONS[actor.user.role],
        )
        estimate = 1
        validate = partial(content_preflight, db, actor, kind, key, settings, current, row)
    own = actor.user.id in row.contributor_ids or actor.user.id in {
        getattr(row, "submitted_by", None),
        getattr(row, "editor_id", None),
    }
    actions = ["open"]
    if edit and row.state != "in_review":
        actions.append("edit")
    if row.state == "in_review" and review and not own:
        actions.append("review")
    if row.state == "in_review" and edit and (own or actor.user.role == "admin"):
        actions.append("withdraw")
    base = dict(
        entity_type=kind,
        entity_id=key,
        title=title,
        campus_id=campus,
        point_id=point,
        state=row.state,
        revision=revision,
        published_revision=published_revision,
        actions=actions,
    )
    if row.state in ACTIVE:
        code, severity, message = {
            "draft": ("DRAFT_SAVED", "info", "已保存草稿，可继续检查并提交审核"),
            "rejected": ("REVIEW_REJECTED", "warning", "此稿已退回，请进入记录查看原因"),
            "in_review": (
                "REVIEW_PENDING",
                "info",
                "此稿等待独立审核" if not own else "此稿等待未参与编辑的成员独立审核",
            ),
        }[row.state]
        checks.append(
            WorkbenchIssue(**base, code=code, severity=severity, message=message, path="state")
        )
    if estimate > budget:
        checks.append(
            WorkbenchIssue(
                **base,
                code="DETAIL_CHECK_REQUIRED",
                severity="warning",
                message="本批检查预算有限，请进入记录运行完整检查",
                path="content",
            )
        )
        return checks, budget
    result = validate()
    if isinstance(content, ExperienceTourContent) and any(
        issue.code == "POINT_NOT_PUBLIC" and issue.path == "stops" for issue in result.issues
    ):
        # The shared complete preflight groups repeated point IDs. The inbox
        # expands only this generic issue into each actual stop location.
        result.issues = [
            i for i in result.issues if not (i.code == "POINT_NOT_PUBLIC" and i.path == "stops")
        ]
        for stop_index, stop in enumerate(content.stops):
            point = public_point(db, stop.point_id)
            if not point or point.campus_id != row.campus_id:
                result.issues.append(
                    ConfigurationIssue(
                        code="POINT_NOT_PUBLIC",
                        severity="error",
                        path=f"stops.{stop_index}",
                        message="此站地点须公开且属于原校区",
                    )
                )
    for issue in result.issues:
        location = (
            _located_reference(content, issue.path) if content and kind != "configuration" else {}
        )
        if config:
            ref = dict(references(content)).get(issue.path)
            if ref:
                location.update(
                    resource_type=ref.type, resource_id=ref.id, expected_revision=ref.revision
                )
        elif kind == "point" and issue.path == "geometry" and row.payload:
            geometry = row.payload.get("geometry", {})
            if geometry.get("map_id"):
                location.update(
                    resource_type="map",
                    resource_id=geometry["map_id"],
                    expected_revision=geometry.get("map_revision"),
                )
        elif kind == "navigation" and issue.path == "graph":
            location.update(
                resource_type="map",
                resource_id=current.id,
                expected_revision=(row.draft or {}).get("map_revision"),
            )
        resource_id, resource_type = location.get("resource_id"), location.get("resource_type")
        if resource_id and resource_type != "narration":
            try:
                location["current_revision"] = _resource(db, actor, resource_type, resource_id)
            except DomainError:
                # Do not expose another scope's object ID or version from an
                # old reference, even if the containing draft remains readable.
                location.pop("resource_id", None)
                location.pop("resource_type", None)
                location["current_revision"] = None
        issue_actions = list(actions)
        if "edit" in actions and issue.code in {"NARRATION_REQUIRED", "NARRATION_SOURCE_CHANGED"}:
            issue_actions.append("regenerate_audio")
        elif "edit" in actions and resource_id:
            issue_actions.append("replace_reference")
        location.setdefault("expected_revision", issue.expected_revision)
        location.setdefault("current_revision", issue.actual_revision)
        checks.append(
            WorkbenchIssue(
                **{**base, "actions": issue_actions},
                code=issue.code,
                severity=issue.severity,
                message=issue.message,
                path=issue.path,
                **location,
            )
        )
    return checks, budget - estimate


@router.get(
    "/issues",
    response_model=Envelope[WorkbenchIssueBatch],
    operation_id="listWorkbenchIssues",
    openapi_extra=META,
)
def issues(
    request: Request,
    actor: Actor,
    db: DB,
    entity_type: EntityType | None = None,
    entity_id: UUID | None = None,
    campus_id: str | None = Query(None, max_length=80),
    limit: int = Query(20, ge=1, le=20),
    cursor: str | None = Query(None, max_length=512),
):
    actor.require("points.read")
    if entity_id and not entity_type:
        raise DomainError("ENTITY_TYPE_REQUIRED", "指定对象时必须同时选择对象类型", 422)
    if campus_id:
        require_campus_scope(db, actor, campus_id)
    rows = saved_query(db, actor)
    query = select(rows)
    if entity_type:
        query = query.where(rows.c.kind == entity_type)
    if entity_id:
        query = query.where(rows.c.id == str(entity_id))
    if campus_id:
        query = query.where(
            or_(
                rows.c.campus_id == campus_id,
                and_(rows.c.kind == "configuration", rows.c.campus_id.is_(None)),
            )
        )
    bound = signature(actor, entity_type, str(entity_id) if entity_id else None, campus_id)
    if cursor:
        time, kind, key = parse_cursor(cursor, bound)
        query = query.where(
            or_(
                rows.c.updated_at < time,
                and_(
                    rows.c.updated_at == time,
                    or_(rows.c.kind > kind, and_(rows.c.kind == kind, rows.c.id > key)),
                ),
            )
        )
    records = (
        db.execute(
            query.order_by(rows.c.updated_at.desc(), rows.c.kind, rows.c.id).limit(limit + 1)
        )
        .mappings()
        .all()
    )
    checked, result, budget = 0, [], MAX_REFERENCE_CHECKS
    for item in records[:limit]:
        try:
            found, budget = inspect_entity(db, actor, item, request.app.state.settings, budget)
        except DomainError as exc:
            if exc.code in {"NOT_FOUND", "SCOPE_DENIED", "FORBIDDEN"}:
                continue
            raise
        checked += 1
        result.extend(found)
    more = len(records) > limit
    return envelope(
        request,
        WorkbenchIssueBatch(
            checked_entity_count=checked,
            issue_count=len(result),
            items=result[:MAX_ISSUES],
            omitted_issue_count=max(0, len(result) - MAX_ISSUES),
            has_more=more,
            next_cursor=cursor_for(records[limit - 1], bound) if more else None,
        ),
    )
