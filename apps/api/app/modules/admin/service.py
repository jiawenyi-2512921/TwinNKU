from uuid import uuid4

from sqlalchemy import func, select

from app.api import as_point, require_campus
from app.contracts import AdminMapPoint, AdminPoint, PointChange, PointDraftInput, PointGeometry
from app.core.errors import DomainError
from app.models import (
    AdminAuditRecord,
    CampusRecord,
    MapRecord,
    PointChangeRecord,
    PointGeometryRecord,
    PointRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.security import audit, point_scope, require_point, utc


def conflict(message="资料已被其他人修改，请重新载入后再操作"):
    raise DomainError("REVISION_CONFLICT", message, 409)


def draft_for(db, point_id):
    return db.get(PointChangeRecord, point_id)


def as_admin_point(db, point):
    draft = draft_for(db, point.id)
    change = PointChange.model_validate(draft) if draft else None
    if change:
        change.updated_at = utc(change.updated_at)
        if change.submitted_at:
            change.submitted_at = utc(change.submitted_at)
    geometry = db.scalars(
        select(PointGeometryRecord).where(PointGeometryRecord.point_id == point.id)
    ).all()
    return AdminPoint(
        point=as_point(point),
        status=point.status,
        visibility=point.visibility,
        geometries=[PointGeometry.model_validate(g) for g in geometry],
        draft=change,
    )


def snapshot(db, point):
    view = as_admin_point(db, point).model_dump(mode="json")
    view.pop("draft")
    return view


def validate_scope(db, payload):
    campuses = db.scalars(
        select(CampusRecord.id).where(
            CampusRecord.id.in_(payload.campus_ids), CampusRecord.is_active.is_(True)
        )
    ).all()
    if set(campuses) != set(payload.campus_ids):
        raise DomainError("INVALID_SCOPE", "授权校区不存在或已停用", 422)
    ids = [str(value) for value in payload.point_ids]
    points = db.scalars(
        select(PointRecord.id).where(
            PointRecord.id.in_(ids), PointRecord.campus_id.in_(payload.campus_ids)
        )
    ).all()
    if set(points) != set(ids):
        raise DomainError("INVALID_SCOPE", "指定建筑必须属于授权校区", 422)


def validate_location(db, campus_id, geometry):
    require_campus(db, campus_id)
    m = db.get(MapRecord, str(geometry.map_id))
    if (
        not m
        or m.campus_id != campus_id
        or m.kind != "campus"
        or m.status != "published"
        or m.visibility != "public"
    ):
        raise DomainError("INVALID_MAP", "请选择本校区已发布的校园底图", 422)
    if m.revision != geometry.map_revision:
        conflict("底图版本已更新，请重新定位后保存")
    points = [geometry.anchor, *geometry.polygon]
    if any(p.x > m.width_px or p.y > m.height_px for p in points):
        raise DomainError("INVALID_GEOMETRY", "点位或点击范围超出图片边界", 422)
    p = geometry.polygon
    if len({(v.x, v.y) for v in p}) != len(p):
        raise DomainError("INVALID_GEOMETRY", "点击范围包含重复顶点", 422)
    area = abs(sum(a.x * b.y - b.x * a.y for a, b in zip(p, p[1:] + p[:1], strict=True))) / 2
    if area < 1:
        raise DomainError("INVALID_GEOMETRY", "点击范围过小或顶点共线", 422)

    def cross(a, b, c):
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

    def on(a, b, c):
        return (
            abs(cross(a, b, c)) < 1e-8
            and min(a.x, b.x) <= c.x <= max(a.x, b.x)
            and min(a.y, b.y) <= c.y <= max(a.y, b.y)
        )

    for i in range(len(p)):
        a, b = p[i], p[(i + 1) % len(p)]
        for j in range(i + 1, len(p)):
            if j == i + 1 or (i == 0 and j == len(p) - 1):
                continue
            c, d = p[j], p[(j + 1) % len(p)]
            intersects = cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0
            if intersects or on(a, b, c) or on(a, b, d) or on(c, d, a) or on(c, d, b):
                raise DomainError("INVALID_GEOMETRY", "点击范围不能交叉或自相接触", 422)
    return m


def list_query(user, campus_id=None, q="", status=None, draft_state=None):
    query = select(PointRecord).outerjoin(PointChangeRecord).where(point_scope(user))
    if campus_id:
        query = query.where(PointRecord.campus_id == campus_id)
    if q:
        q = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.where(PointRecord.name.ilike(f"%{q}%", escape="\\"))
    if status:
        query = query.where(PointRecord.status == status)
    if draft_state:
        query = query.where(PointChangeRecord.state == draft_state)
    return query


def map_points(db, user, map_id):
    m = db.get(MapRecord, str(map_id))
    if (
        not m
        or m.kind != "campus"
        or m.status != "published"
        or m.visibility != "public"
        or (user.role != "admin" and m.campus_id not in user.campus_ids)
    ):
        raise DomainError("NOT_FOUND", "地图不存在或不在授权范围内", 404)
    require_campus(db, m.campus_id)
    points = db.scalars(
        select(PointRecord).where(
            point_scope(user), PointRecord.campus_id == m.campus_id, PointRecord.status != "retired"
        )
    ).all()
    result = []
    for point in points:
        geo = db.get(PointGeometryRecord, (m.id, point.id))
        draft = draft_for(db, point.id)
        pending = draft and draft.state in {"draft", "in_review", "rejected"}
        candidate = draft.payload.get("geometry") if pending and draft.payload else None
        if candidate and (candidate["map_id"] != m.id or candidate["map_revision"] != m.revision):
            candidate = None
        if geo and geo.map_revision != m.revision:
            geo = None
        if not geo and not candidate:
            continue
        result.append(
            AdminMapPoint(
                id=point.id,
                name=draft.payload["name"] if candidate else point.name,
                status=point.status,
                geometry=PointGeometry.model_validate(geo) if geo else None,
                draft_geometry=candidate,
                draft_state=draft.state if pending else None,
            )
        )
    return result


def save_draft(db, actor, payload, point_id=None):
    actor.require("points.edit")
    user = actor.user
    if point_id:
        point = require_point(db, user, point_id, lock=True)
        if point.campus_id != payload.campus_id:
            raise DomainError("CAMPUS_IMMUTABLE", "不能把已有点位转移到其他校区", 422)
        if point.revision != payload.expected_point_revision:
            conflict()
        current = draft_for(db, point.id)
        if (current.revision if current else 0) != payload.expected_revision:
            conflict()
        if current and current.state == "in_review":
            conflict("资料正在审核，请先撤回或等待审核结果")
    else:
        if user.role != "admin" and (payload.campus_id not in user.campus_ids or user.point_ids):
            raise DomainError("FORBIDDEN", "只有获授整个校区编辑范围的账号可以新增点位", 403)
        point = PointRecord(
            id=str(uuid4()),
            campus_id=payload.campus_id,
            name=payload.name,
            aliases=payload.aliases,
            category=payload.category.value,
            summary=payload.summary,
            visibility=payload.visibility.value,
            status="draft",
            revision=1,
        )
        current = None
    validate_location(db, payload.campus_id, payload.geometry)
    if not point_id:
        db.add(point)
        db.flush()
    values = PointDraftInput.model_validate(
        payload.model_dump(exclude={"expected_revision", "expected_point_revision"})
    ).model_dump(mode="json")
    contributors = (
        set(current.contributor_ids)
        if current and current.state in {"draft", "rejected"}
        else set()
    )
    contributors.add(user.id)
    if current is None:
        current = PointChangeRecord(
            point_id=point.id,
            revision=1,
            base_revision=point.revision,
            editor_id=user.id,
            contributor_ids=sorted(contributors),
            payload=values,
        )
        db.add(current)
    else:
        current.revision += 1
        current.base_revision = point.revision
        current.editor_id = user.id
        current.contributor_ids = sorted(contributors)
        current.payload = values
        current.state = "draft"
        current.operation = "upsert"
        current.submitted_by = current.submitted_at = None
        current.review_note = ""
        current.updated_at = now_utc()
    audit(
        db,
        user,
        "point.draft_saved",
        point=point,
        note=payload.source_note,
        details={"draft_revision": current.revision, "payload": values},
    )
    db.flush()
    return point


def change_for_action(db, actor, point_id, expected_revision):
    point = require_point(db, actor.user, point_id, lock=True)
    change = draft_for(db, point.id)
    if not change or change.revision != expected_revision:
        conflict()
    return point, change


def transition(db, actor, point_id, action, payload):
    actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
    point, change = change_for_action(db, actor, point_id, payload.expected_revision)
    note = payload.note.strip()
    if not note:
        raise DomainError("NOTE_REQUIRED", "请填写操作说明", 422)
    if action == "submit":
        if change.state not in {"draft", "rejected"}:
            conflict("当前状态不能提交审核")
        if point.revision != change.base_revision:
            conflict("发布版本已改变，请重新保存草稿")
        if change.payload:
            candidate = PointDraftInput.model_validate(change.payload)
            validate_location(db, point.campus_id, candidate.geometry)
        change.state, change.submitted_by, change.submitted_at = (
            "in_review",
            actor.user.id,
            now_utc(),
        )
    elif action == "discard":
        if change.state not in {"draft", "in_review", "rejected"}:
            conflict("当前没有可撤回的草稿")
        if actor.user.role != "admin" and actor.user.id not in change.contributor_ids:
            raise DomainError("FORBIDDEN", "只能撤回自己参与编辑的草稿", 403)
        change.state = "discarded"
    else:
        if change.state != "in_review":
            conflict("只能审核已提交的草稿")
        if actor.user.id in change.contributor_ids or actor.user.id == change.submitted_by:
            raise DomainError(
                "SELF_REVIEW_DENIED", "不能审核自己参与编辑或提交的内容，请交由另一名审核员", 403
            )
        if action == "reject":
            change.state = "rejected"
        else:
            if point.revision != change.base_revision:
                conflict("正式点位已改变，请退回草稿重新核对")
            before = snapshot(db, point)
            if change.operation == "retire":
                point.status = "retired"
            else:
                data = PointDraftInput.model_validate(change.payload)
                validate_location(db, point.campus_id, data.geometry)
                for key in ("name", "aliases", "category", "summary", "visibility"):
                    setattr(point, key, data.model_dump(mode="json")[key])
                point.status = "published"
                geo = db.get(PointGeometryRecord, (str(data.geometry.map_id), point.id))
                fields = data.geometry.model_dump(mode="json")
                if geo:
                    for key, value in fields.items():
                        setattr(geo, key, value)
                else:
                    db.add(PointGeometryRecord(point_id=point.id, entrance_ids=[], **fields))
            point.revision += 1
            point.updated_at = now_utc()
            change.state = "published"
            db.flush()
            audit(
                db,
                actor.user,
                "point.retired" if change.operation == "retire" else "point.published",
                point=point,
                note=note,
                details={
                    "before": before,
                    "after": snapshot(db, point),
                    "draft_revision": change.revision,
                },
            )
    change.review_note = note
    change.revision += 1
    change.updated_at = now_utc()
    if action != "publish":
        audit(
            db,
            actor.user,
            f"point.{action}",
            point=point,
            note=note,
            details={"draft_revision": change.revision},
        )
    db.flush()
    return point


def request_retire(db, actor, point_id, payload):
    actor.require("points.edit")
    point = require_point(db, actor.user, point_id, lock=True)
    current = draft_for(db, point.id)
    if (
        point.revision != payload.expected_point_revision
        or (current.revision if current else 0) != payload.expected_revision
    ):
        conflict()
    if point.status != "published" or (
        current and current.state in {"draft", "in_review", "rejected"}
    ):
        conflict("请先处理已有草稿；仅已发布点位可以申请下架")
    if not payload.note.strip():
        raise DomainError("NOTE_REQUIRED", "请填写下架原因", 422)
    if current is None:
        current = PointChangeRecord(
            point_id=point.id,
            revision=1,
            base_revision=point.revision,
            editor_id=actor.user.id,
            payload=None,
        )
        db.add(current)
    else:
        current.revision += 1
    current.base_revision = point.revision
    current.state, current.operation, current.payload = "in_review", "retire", None
    current.editor_id, current.contributor_ids = actor.user.id, [actor.user.id]
    current.submitted_by, current.submitted_at = actor.user.id, now_utc()
    current.review_note, current.updated_at = payload.note.strip(), now_utc()
    audit(
        db,
        actor.user,
        "point.retire_requested",
        point=point,
        note=payload.note,
        details={"draft_revision": current.revision},
    )
    db.flush()
    return point


def scoped_audit_query(user, point_id=None):
    query = select(AdminAuditRecord)
    if user.role != "admin":
        query = query.where(
            AdminAuditRecord.point_id.in_(select(PointRecord.id).where(point_scope(user)))
        )
    if point_id:
        query = query.where(AdminAuditRecord.point_id == str(point_id))
    return query


def lock_administrators(db, actor):
    # Serialize privilege changes and re-read the actor after concurrent revocation.
    db.scalars(
        select(StaffUserRecord)
        .where(StaffUserRecord.role == "admin")
        .order_by(StaffUserRecord.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    db.refresh(actor.user)
    if actor.user.role != "admin" or not actor.user.is_active:
        raise DomainError("FORBIDDEN", "管理员权限已变更，请重新登录", 403)


def page_rows(db, query, page, page_size):
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    return db.scalars(query.offset((page - 1) * page_size).limit(page_size)).all(), total
