from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api import DB, envelope
from app.contracts import (
    ActionResult,
    AdminMapPoint,
    AdminPoint,
    AuditEvent,
    Campus,
    CampusId,
    ContentStatus,
    Envelope,
    ErrorEnvelope,
    MapInfo,
    Pagination,
    PointDraftInput,
    PointDraftUpdate,
    PointRetireRequest,
    ReviewRequest,
    StaffLogin,
    StaffPasswordChange,
    StaffSession,
    StaffUser,
    StaffUserCreate,
    StaffUserUpdate,
)
from app.core.errors import DomainError
from app.models import (
    AdminAuditRecord,
    CampusRecord,
    PointChangeRecord,
    PointRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin import service
from app.modules.admin.security import (
    COOKIE,
    DUMMY_HASH,
    HASHER,
    Actor,
    Auth,
    as_user,
    audit,
    hash_password,
    new_session,
    require_enabled,
    require_origin,
    require_point,
    revoke_sessions,
    session_view,
    throttle_login,
    verify_password,
)
from app.modules.maps.router import as_map, public_maps

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    responses={code: {"model": ErrorEnvelope} for code in [401, 403, 404, 409, 422, 429, 503]},
)
STAFF = {"x-implementation-status": "implemented", "x-module": "M01", "x-auth": "staff"}
ORIGIN = {"name": "Origin", "in": "header", "required": True, "schema": {"type": "string"}}
CSRF = {"name": "X-CSRF-Token", "in": "header", "required": True, "schema": {"type": "string"}}
WRITE = {**STAFF, "parameters": [ORIGIN, CSRF]}


@router.post(
    "/auth/login",
    response_model=Envelope[StaffSession],
    operation_id="staffLogin",
    openapi_extra={**STAFF, "x-auth": "public", "parameters": [ORIGIN]},
)
def login(payload: StaffLogin, request: Request, response: Response, db: DB):
    require_enabled(request)
    require_origin(request)
    throttle_login(db, request, payload.username)
    user = db.scalar(
        select(StaffUserRecord)
        .where(StaffUserRecord.username == payload.username)
        .with_for_update()
    )
    valid = verify_password(
        user.password_hash if user else DUMMY_HASH, payload.password.get_secret_value()
    )
    if not valid or user is None or not user.is_active:
        raise DomainError("LOGIN_FAILED", "账号或密码不正确，或账号已停用", 401)
    if HASHER.check_needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password.get_secret_value())
        user.revision += 1
    principal = new_session(db, user, request, response)
    audit(db, user, "session.login")
    db.commit()
    return envelope(request, session_view(principal))


@router.get(
    "/session",
    response_model=Envelope[StaffSession],
    operation_id="getStaffSession",
    openapi_extra=STAFF,
)
def me(request: Request, auth: Auth):
    return envelope(request, session_view(auth))


@router.post(
    "/auth/logout",
    response_model=Envelope[ActionResult],
    operation_id="staffLogout",
    openapi_extra=WRITE,
)
def logout(request: Request, response: Response, auth: Auth, db: DB):
    db.delete(auth.session)
    audit(db, auth.user, "session.logout")
    db.commit()
    response.delete_cookie(
        COOKIE,
        path="/api/v1/admin",
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )
    return envelope(request, ActionResult())


@router.post(
    "/auth/password",
    response_model=Envelope[ActionResult],
    operation_id="changeStaffPassword",
    openapi_extra=WRITE,
)
def password(
    payload: StaffPasswordChange, request: Request, response: Response, auth: Auth, db: DB
):
    if not verify_password(auth.user.password_hash, payload.current_password.get_secret_value()):
        raise DomainError("PASSWORD_INCORRECT", "当前密码不正确", 403)
    if payload.new_password.get_secret_value() == payload.current_password.get_secret_value():
        raise DomainError("PASSWORD_UNCHANGED", "新密码不能与当前密码相同", 422)
    auth.user.password_hash = hash_password(payload.new_password.get_secret_value())
    auth.user.must_change_password = False
    auth.user.revision += 1
    auth.user.updated_at = now_utc()
    revoke_sessions(db, auth.user.id)
    audit(db, auth.user, "user.password_changed")
    db.commit()
    response.delete_cookie(
        COOKIE,
        path="/api/v1/admin",
        httponly=True,
        secure=request.app.state.settings.app_env == "production",
        samesite="strict",
    )
    return envelope(request, ActionResult())


@router.get(
    "/campuses",
    response_model=Envelope[list[Campus]],
    operation_id="listStaffCampuses",
    openapi_extra=STAFF,
)
def campuses(request: Request, actor: Actor, db: DB):
    query = select(CampusRecord).where(CampusRecord.is_active.is_(True))
    if actor.user.role != "admin":
        query = query.where(CampusRecord.id.in_(actor.user.campus_ids))
    return envelope(
        request, [Campus.model_validate(c) for c in db.scalars(query.order_by(CampusRecord.name))]
    )


@router.get(
    "/maps",
    response_model=Envelope[list[MapInfo]],
    operation_id="listStaffMaps",
    openapi_extra=STAFF,
)
def maps(request: Request, actor: Actor, db: DB):
    from app.models import MapRecord

    query = public_maps(request).where(MapRecord.kind == "campus")
    if actor.user.role != "admin":
        query = query.where(MapRecord.campus_id.in_(actor.user.campus_ids))
    return envelope(request, [as_map(m) for m in db.scalars(query.order_by(MapRecord.title))])


@router.get(
    "/maps/{map_id}/points",
    response_model=Envelope[list[AdminMapPoint]],
    operation_id="listStaffMapPoints",
    openapi_extra=STAFF,
)
def map_points(map_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(request, service.map_points(db, actor.user, map_id))


@router.get(
    "/points",
    response_model=Envelope[list[AdminPoint]],
    operation_id="listAdminPoints",
    openapi_extra=STAFF,
)
def points(
    request: Request,
    actor: Actor,
    db: DB,
    campus_id: CampusId | None = None,
    q: str = Query("", max_length=100),
    status: ContentStatus | None = None,
    draft_state: Literal["draft", "in_review", "rejected", "published", "discarded"] | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    actor.require("points.read")
    query = service.list_query(actor.user, campus_id, q.strip(), status, draft_state)
    query = query.order_by(
        func.coalesce(PointChangeRecord.updated_at, PointRecord.updated_at).desc(), PointRecord.id
    )
    rows, total = service.page_rows(db, query, page, page_size)
    return envelope(
        request,
        [service.as_admin_point(db, p) for p in rows],
        Pagination(page=page, page_size=page_size, total=total),
    )


@router.get(
    "/points/{point_id}",
    response_model=Envelope[AdminPoint],
    operation_id="getAdminPoint",
    openapi_extra=STAFF,
)
def point(point_id: UUID, request: Request, actor: Actor, db: DB):
    actor.require("points.read")
    return envelope(request, service.as_admin_point(db, require_point(db, actor.user, point_id)))


@router.post(
    "/points",
    response_model=Envelope[AdminPoint],
    operation_id="createPointDraft",
    status_code=201,
    openapi_extra=WRITE,
)
def create_point(payload: PointDraftInput, request: Request, actor: Actor, db: DB):
    point = service.save_draft(db, actor, payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.put(
    "/points/{point_id}",
    response_model=Envelope[AdminPoint],
    operation_id="updatePointDraft",
    openapi_extra=WRITE,
)
def update_point(point_id: UUID, payload: PointDraftUpdate, request: Request, actor: Actor, db: DB):
    point = service.save_draft(db, actor, payload, point_id)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.post(
    "/points/{point_id}/submit",
    response_model=Envelope[AdminPoint],
    operation_id="submitPointReview",
    openapi_extra=WRITE,
)
def submit_point(point_id: UUID, payload: ReviewRequest, request: Request, actor: Actor, db: DB):
    point = service.transition(db, actor, point_id, "submit", payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.post(
    "/points/{point_id}/publish",
    response_model=Envelope[AdminPoint],
    operation_id="publishPoint",
    openapi_extra=WRITE,
)
def publish_point(point_id: UUID, payload: ReviewRequest, request: Request, actor: Actor, db: DB):
    point = service.transition(db, actor, point_id, "publish", payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.post(
    "/points/{point_id}/reject",
    response_model=Envelope[AdminPoint],
    operation_id="rejectPointReview",
    openapi_extra=WRITE,
)
def reject_point(point_id: UUID, payload: ReviewRequest, request: Request, actor: Actor, db: DB):
    point = service.transition(db, actor, point_id, "reject", payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.post(
    "/points/{point_id}/discard",
    response_model=Envelope[AdminPoint],
    operation_id="discardPointDraft",
    openapi_extra=WRITE,
)
def discard_point(point_id: UUID, payload: ReviewRequest, request: Request, actor: Actor, db: DB):
    point = service.transition(db, actor, point_id, "discard", payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.post(
    "/points/{point_id}/retire",
    response_model=Envelope[AdminPoint],
    operation_id="retirePoint",
    openapi_extra=WRITE,
)
def retire_point(
    point_id: UUID, payload: PointRetireRequest, request: Request, actor: Actor, db: DB
):
    point = service.request_retire(db, actor, point_id, payload)
    db.commit()
    return envelope(request, service.as_admin_point(db, point))


@router.get(
    "/audit",
    response_model=Envelope[list[AuditEvent]],
    operation_id="listAdminAudit",
    openapi_extra=STAFF,
)
def events(
    request: Request,
    actor: Actor,
    db: DB,
    point_id: UUID | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    actor.require("audit.read")
    if point_id:
        require_point(db, actor.user, point_id)
    rows, total = service.page_rows(
        db,
        service.scoped_audit_query(actor.user, point_id).order_by(
            AdminAuditRecord.created_at.desc(), AdminAuditRecord.id
        ),
        page,
        page_size,
    )
    return envelope(
        request,
        [AuditEvent.model_validate(r) for r in rows],
        Pagination(page=page, page_size=page_size, total=total),
    )


@router.get(
    "/users",
    response_model=Envelope[list[StaffUser]],
    operation_id="listStaffUsers",
    openapi_extra=STAFF,
)
def users(
    request: Request,
    actor: Actor,
    db: DB,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    actor.require("users.manage")
    rows, total = service.page_rows(
        db, select(StaffUserRecord).order_by(StaffUserRecord.username), page, page_size
    )
    return envelope(
        request, [as_user(u) for u in rows], Pagination(page=page, page_size=page_size, total=total)
    )


@router.post(
    "/users",
    response_model=Envelope[StaffUser],
    operation_id="createStaffUser",
    status_code=201,
    openapi_extra=WRITE,
)
def create_user(payload: StaffUserCreate, request: Request, actor: Actor, db: DB):
    actor.require("users.manage")
    service.lock_administrators(db, actor)
    service.validate_scope(db, payload)
    if db.scalar(select(StaffUserRecord.id).where(StaffUserRecord.username == payload.username)):
        raise DomainError("USERNAME_TAKEN", "账号名称已存在", 409)
    values = payload.model_dump(mode="json", exclude={"password"})
    user = StaffUserRecord(
        **values,
        password_hash=hash_password(payload.password.get_secret_value()),
        must_change_password=True,
    )
    db.add(user)
    try:
        db.flush()
        audit(
            db,
            actor.user,
            "user.created",
            details={
                "target_id": user.id,
                "username": user.username,
                "role": user.role,
                "campus_ids": user.campus_ids,
                "point_ids": user.point_ids,
            },
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise DomainError("USERNAME_TAKEN", "账号名称已存在", 409) from exc
    return envelope(request, as_user(user))


@router.put(
    "/users/{user_id}",
    response_model=Envelope[StaffUser],
    operation_id="updateStaffUser",
    openapi_extra=WRITE,
)
def update_user(user_id: UUID, payload: StaffUserUpdate, request: Request, actor: Actor, db: DB):
    actor.require("users.manage")
    service.lock_administrators(db, actor)
    user = db.scalar(
        select(StaffUserRecord)
        .where(StaffUserRecord.id == str(user_id))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise DomainError("NOT_FOUND", "账号不存在", 404)
    if user.revision != payload.expected_revision:
        service.conflict()
    if user.id == actor.user.id and (
        payload.role != "admin" or not payload.is_active or payload.new_password
    ):
        raise DomainError(
            "SELF_PRIVILEGE_CHANGE",
            "不能停用或降低自己的管理员权限；修改本人密码请使用修改密码入口",
            403,
        )
    service.validate_scope(db, payload)
    before = as_user(user).model_dump(mode="json")
    for key, value in payload.model_dump(
        mode="json", exclude={"expected_revision", "new_password"}
    ).items():
        setattr(user, key, value)
    if payload.new_password:
        user.password_hash = hash_password(payload.new_password.get_secret_value())
        user.must_change_password = True
    user.revision += 1
    user.updated_at = now_utc()
    revoke_sessions(db, user.id)
    audit(
        db,
        actor.user,
        "user.updated",
        details={
            "target_id": user.id,
            "before": before,
            "after": as_user(user).model_dump(mode="json"),
            "password_reset": bool(payload.new_password),
        },
    )
    db.commit()
    return envelope(request, as_user(user))
