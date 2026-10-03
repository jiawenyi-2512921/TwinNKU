"""CAS drafts, immutable checkpoints, independent review and effective controls."""

import hashlib
import json
from datetime import timedelta
from functools import wraps
from inspect import signature
from uuid import UUID, uuid4

from fastapi import APIRouter, Query, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.api import DB, envelope, require_campus
from app.configuration_models import (
    ConfigurationGrantRecord,
    ConfigurationOperationRecord,
    ConfigurationRecord,
    ConfigurationVersionRecord,
    EmergencyStopRecord,
)
from app.contracts import Envelope
from app.core.errors import DomainError
from app.models import (
    CampusRecord,
    ExperienceRecord,
    FloorRecord,
    MapRecord,
    PanoramaRecord,
    PointRecord,
    StaffUserRecord,
    now_utc,
)
from app.modules.admin.security import Actor, audit, require_point, require_recent_mfa, utc
from app.modules.configuration_schemas import (
    CONTENT,
    AdminConfiguration,
    ConfigurationAction,
    ConfigurationCreate,
    ConfigurationGrant,
    ConfigurationGrantUpdate,
    ConfigurationIssue,
    ConfigurationKind,
    ConfigurationOperation,
    ConfigurationPermission,
    ConfigurationPermissionFlags,
    ConfigurationPreflight,
    ConfigurationPreview,
    ConfigurationReference,
    ConfigurationSave,
    ConfigurationVersion,
    ControlledService,
    PresentationContent,
    RuntimeContent,
    ServiceControlAction,
    Showcase,
    ShowcaseResource,
    ShowcaseRouteCard,
    VisitDefaultsContent,
)

router = APIRouter(tags=["configuration"])
META = {"x-implementation-status": "implemented", "x-module": "M58", "x-auth": "staff"}
SERVICES = {"chat", "voice", "narration_generation", "narration_playback", "navigation"}


def write_guard(function):
    parameters = signature(function)

    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (IntegrityError, StaleDataError):
            db = parameters.bind(*args, **kwargs).arguments["db"]
            db.rollback()
            raise DomainError(
                "REVISION_CONFLICT", "记录已被其他请求改变，请重新加载", 409
            ) from None

    return guarded


def sha(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def submission_sha(row):
    return sha(
        {
            "content": row.draft,
            "resume_services": row.resume_services,
            "resume_stop_revisions": row.resume_stop_revisions,
        }
    )


def content_payload(content):
    # Unset fields retain inheritance; lists replace as a whole, never concatenate.
    return {**content.model_dump(mode="json", exclude_unset=True), "kind": content.kind}


def permission_for(kind, mode):
    return ("runtime." if kind == "runtime" else "configurations.") + mode


def granted(db, actor, kind, scope, mode):
    return (
        db.scalar(
            select(ConfigurationGrantRecord.user_id)
            .where(
                ConfigurationGrantRecord.user_id == actor.user.id,
                ConfigurationGrantRecord.permission == permission_for(kind, mode),
                ConfigurationGrantRecord.scope.in_(["global", scope]),
            )
            .limit(1)
        )
        is not None
    )


def require_permission(db, actor, kind, scope, mode):
    if not granted(db, actor, kind, scope, mode):
        raise DomainError(
            "FORBIDDEN",
            "账号没有此范围的配置" + ("审核" if mode == "review" else "编辑") + "权限",
            403,
        )


def readable(db, actor, row):
    return granted(db, actor, row.kind, row.scope, "edit") or granted(
        db, actor, row.kind, row.scope, "review"
    )


def record_for(db, actor, key, *, lock=False):
    query = select(ConfigurationRecord).where(ConfigurationRecord.id == str(key))
    if lock:
        query = query.with_for_update()
    row = db.scalar(query.execution_options(populate_existing=True))
    if row is None or not readable(db, actor, row):
        raise DomainError("NOT_FOUND", "配置不存在或不在授权范围内", 404)
    return row


def validate_scope(db, kind, scope):
    if kind == "runtime" and scope != "global":
        raise DomainError("INVALID_SCOPE", "运行策略只允许全站范围", 422)
    if scope != "global":
        require_campus(db, scope)


def admin_view(db, actor, row):
    return AdminConfiguration(
        id=row.id,
        kind=row.kind,
        scope=row.scope,
        schema_version=row.schema_version,
        revision=row.revision,
        published_revision=row.published_revision,
        state=row.state,
        draft=CONTENT.validate_python(row.draft),
        published=CONTENT.validate_python(row.published) if row.published else None,
        contributor_ids=row.contributor_ids,
        submitted_by=row.submitted_by,
        submitted_at=utc(row.submitted_at) if row.submitted_at else None,
        resume_services=row.resume_services,
        review_note=row.review_note,
        updated_at=utc(row.updated_at),
        permissions=ConfigurationPermissionFlags(
            edit=granted(db, actor, row.kind, row.scope, "edit"),
            review=granted(db, actor, row.kind, row.scope, "review"),
        ),
        content_sha256=sha(row.draft),
        override_fields=sorted(k for k in row.draft if k != "kind"),
    )


def audit_config(db, actor, row, action, note="", details=None):
    audit(
        db,
        actor.user,
        "configuration." + action,
        note=note,
        details={
            "configuration_id": row.id,
            "kind": row.kind,
            "scope": row.scope,
            "revision": row.revision,
            "published_revision": row.published_revision,
            "content_sha256": sha(row.draft),
            **(details or {}),
        },
    )


def version(db, row, event, actor):
    snapshot = ConfigurationVersionRecord(
        configuration_id=row.id,
        event=event,
        revision=row.revision,
        published_revision=row.published_revision,
        content=row.draft,
        content_sha256=sha(row.draft),
        contributor_ids=row.contributor_ids,
        actor_id=actor.user.id,
    )
    db.add(snapshot)
    # Only disposable autosave checkpoints are bounded. Submission/publication
    # and restore snapshots and the separate audit trail are never pruned here.
    recent = db.scalars(
        select(ConfigurationVersionRecord)
        .where(
            ConfigurationVersionRecord.configuration_id == row.id,
            ConfigurationVersionRecord.event.in_(["autosave", "checkpoint"]),
        )
        .order_by(ConfigurationVersionRecord.created_at.desc(), ConfigurationVersionRecord.id)
    ).all()
    for old in recent[50:]:
        db.delete(old)


def check_cas(row, payload):
    if (
        row.revision != payload.expected_revision
        or row.published_revision != payload.expected_published_revision
    ):
        raise DomainError("REVISION_CONFLICT", "配置已改变，请保留本地修改并重新加载比较", 409)


def writable(row):
    if row.state == "in_review":
        raise DomainError("DRAFT_FROZEN", "待审稿已冻结，请先撤回再编辑", 409)


def find_operation(db, actor, operation_id, action, target_id, payload):
    fingerprint = sha({"action": action, "target": target_id, "payload": payload})
    from app.content_control_models import ContentOperationRecord
    from app.content_history_models import ExperienceOperationRecord

    if db.get(ExperienceOperationRecord, (actor.user.id, str(operation_id))) or db.get(
        ContentOperationRecord, (actor.user.id, str(operation_id))
    ):
        raise DomainError("OPERATION_CONFLICT", "此操作编号已用于内容请求", 409)
    old = db.get(ConfigurationOperationRecord, (actor.user.id, str(operation_id)))
    if old:
        if old.fingerprint != fingerprint:
            raise DomainError("OPERATION_CONFLICT", "此操作编号已用于不同内容", 409)
        row = record_for(db, actor, old.target_id)
        require_permission(
            db, actor, row.kind, row.scope, "review" if action in {"publish", "reject"} else "edit"
        )
        return fingerprint, old.result
    return fingerprint, None


def complete_operation(db, actor, row, operation_id, action, fingerprint, result=None):
    data = result if result is not None else admin_view(db, actor, row).model_dump(mode="json")
    db.add(
        ConfigurationOperationRecord(
            id=str(operation_id),
            user_id=actor.user.id,
            target_id=row.id,
            action=action,
            fingerprint=fingerprint,
            result=data,
        )
    )
    try:
        db.commit()
    except (IntegrityError, StaleDataError):
        db.rollback()
        # A duplicate operation racing another worker is only replayed when its
        # fingerprint matches; otherwise preserve the caller's conflict.
        old = db.get(ConfigurationOperationRecord, (actor.user.id, str(operation_id)))
        if old and old.fingerprint == fingerprint:
            record_for(db, actor, old.target_id)
            return old.result
        raise DomainError(
            "REVISION_CONFLICT", "配置或操作已被其他请求改变，请重新加载", 409
        ) from None
    return data


def resolve_reference(db, ref, scope, actor=None):
    from app.modules.experiences import content_points, public_record, public_view
    from app.modules.floors.service import public_floors

    key = str(ref.id)
    url = None
    points = []
    if ref.type in {"image", "video", "tour", "checkin"}:
        record, content = public_record(db, key)
        expected_kind = "media" if ref.type in {"image", "video"} else ref.type
        if record.kind != expected_kind or (
            expected_kind == "media" and content.media_type != ref.type
        ):
            raise DomainError("REFERENCE_TYPE_MISMATCH", "引用类型不匹配", 409)
        revision, campus, title = record.published_revision, record.campus_id, content.title
        points = sorted(content_points(content))
        url = public_view(record, content).media_url
    elif ref.type == "floor":
        record = db.scalar(public_floors().where(FloorRecord.id == key))
        if record is None:
            raise DomainError("REFERENCE_NOT_PUBLIC", "楼层未公开", 409)
        point = db.get(PointRecord, record.point_id)
        revision, campus, title = record.revision, point.campus_id, record.label
        points = [point.id]
    elif ref.type == "vr":
        record = db.get(PanoramaRecord, key)
        point = db.get(PointRecord, record.point_id) if record else None
        campus_record = db.get(CampusRecord, point.campus_id) if point else None
        if (
            not record
            or record.status != "published"
            or not point
            or point.status != "published"
            or point.visibility != "public"
            or not campus_record
            or not campus_record.is_active
        ):
            raise DomainError("REFERENCE_NOT_PUBLIC", "VR 或所属地点未公开", 409)
        revision, campus, title, url = record.revision, point.campus_id, record.title, record.url
        points = [point.id]
    else:
        record = db.get(PointRecord, key)
        campus_record = db.get(CampusRecord, record.campus_id) if record else None
        if (
            not record
            or record.status != "published"
            or record.visibility != "public"
            or not campus_record
            or not campus_record.is_active
        ):
            raise DomainError("REFERENCE_NOT_PUBLIC", "地点未公开", 409)
        revision, campus, title = record.revision, record.campus_id, record.name
        points = [record.id]
    if scope != "global" and scope != campus:
        raise DomainError("REFERENCE_SCOPE_MISMATCH", "引用资料不属于配置校区", 409)
    if revision != ref.revision:
        raise DomainError("REFERENCE_REVISION_CHANGED", "引用版本已改变，请重新选择", 409)
    if actor:
        for point_id in points:
            require_point(db, actor.user, point_id)
    return ShowcaseResource(
        type=ref.type,
        id=ref.id,
        revision=revision,
        title=title,
        url=url,
        point_id=points[0] if len(points) == 1 else None,
    )


def references(content):
    if content.kind == "presentation":
        for index, module in enumerate(content.modules):
            if module.image:
                yield f"modules.{index}.image", module.image
            for route_index, route in enumerate(module.routes):
                yield f"modules.{index}.routes.{route_index}", route
            if module.target and module.target.type == "tour":
                yield (
                    f"modules.{index}.target",
                    ConfigurationReference(
                        type="tour", id=module.target.id, revision=module.target.revision
                    ),
                )


def check_structure_scope(db, actor, row, content):
    # Drafts can retain stale revisions but never adopt an out-of-scope ID.
    if content.kind == "visit_defaults" and content.map_default_view:
        check_map_default(db, content.map_default_view, row.scope, actor, check_revision=False)
    for _, ref in references(content):
        if ref.type in {"image", "video", "tour", "checkin"}:
            item = db.get(ExperienceRecord, str(ref.id))
            if not item:
                continue  # Incomplete draft: preflight reports a missing ID.
            if row.scope != "global" and item.campus_id != row.scope:
                raise DomainError("REFERENCE_SCOPE_MISMATCH", "引用资料不属于此校区", 403)
            from app.modules.experiences import require_record

            require_record(db, actor, item.id)


def check_map_default(db, view, scope, actor=None, *, check_revision=True):
    record = db.get(MapRecord, str(view.map_id))
    campus = db.get(CampusRecord, record.campus_id) if record else None
    if (
        not record or record.kind != "campus" or record.status != "published"
        or record.visibility != "public" or not campus or not campus.is_active
    ):
        raise DomainError("MAP_DEFAULT_NOT_PUBLIC", "默认视角的校园底图不存在或未公开", 409)
    if scope != "global" and scope != record.campus_id:
        raise DomainError("MAP_DEFAULT_SCOPE", "默认底图不属于配置校区", 403)
    if actor and actor.user.role != "admin" and record.campus_id not in actor.user.campus_ids:
        raise DomainError("MAP_DEFAULT_SCOPE", "默认底图不在你的校区范围内", 403)
    if view.map_revision != record.revision:
        if check_revision:
            raise DomainError("MAP_DEFAULT_REVISION", "默认视角的底图版本已改变，请重新取景", 409)
        return record  # Preserve stale private drafts; submission still fails.
    if view.center.x > record.width_px or view.center.y > record.height_px:
        raise DomainError("MAP_DEFAULT_BOUNDS", "默认视角中心超出当前底图像素边界", 422)
    # Source z=0 remains the native lowest tile level. Negative camera zoom
    # scales that tile instead of requesting negative source z coordinates.
    if view.max_zoom > record.max_native_zoom + 1:
        raise DomainError("MAP_DEFAULT_ZOOM", "允许缩放超出当前底图的相机上限", 422)
    return record


def preflight_for(db, actor, row, settings):
    content = CONTENT.validate_python(row.draft)
    issues, dependencies = [], []
    if content.kind == "visit_defaults" and content.map_default_view:
        try:
            mapped = check_map_default(db, content.map_default_view, row.scope, actor)
            dependencies.append({"type": "map", "id": mapped.id, "revision": mapped.revision,
                                 "width_px": mapped.width_px, "height_px": mapped.height_px,
                                 "max_native_zoom": mapped.max_native_zoom})
        except DomainError as exc:
            mapped = db.get(MapRecord, str(content.map_default_view.map_id))
            # Scope failures never reveal the current revision of an inaccessible map.
            issues.append(ConfigurationIssue(
                code=exc.code, severity="error", path="map_default_view", message=exc.message,
                expected_revision=content.map_default_view.map_revision,
                actual_revision=mapped.revision if mapped and exc.code in {
                    "MAP_DEFAULT_REVISION", "MAP_DEFAULT_BOUNDS", "MAP_DEFAULT_ZOOM"
                } else None,
            ))
    if content.kind == "presentation":
        if not content.site_name.strip():
            issues.append(
                ConfigurationIssue(
                    code="SITE_NAME_REQUIRED",
                    severity="error",
                    path="site_name",
                    message="网站名称不可为空",
                )
            )
        if not any(
            m.enabled and m.type in {"all_routes", "resource_entries", "visit_modes"}
            for m in content.modules
        ):
            issues.append(
                ConfigurationIssue(
                    code="REQUIRED_ENTRY_MISSING",
                    severity="error",
                    path="modules",
                    message="至少保留一个参观或校园资源入口",
                )
            )
        for index, module in enumerate(content.modules):
            if module.image and not module.alt.strip():
                issues.append(
                    ConfigurationIssue(
                        code="IMAGE_ALT_REQUIRED",
                        severity="error",
                        path=f"modules.{index}.alt",
                        message="请填写主视觉图片替代说明",
                    )
                )
    for path, ref in references(content):
        try:
            resolved = resolve_reference(db, ref, row.scope, actor)
            dependencies.append(resolved.model_dump(mode="json"))
        except DomainError as exc:
            issues.append(
                ConfigurationIssue(
                    code=exc.code,
                    severity="error",
                    path=path,
                    message=exc.message,
                    expected_revision=ref.revision,
                )
            )
    if content.kind == "runtime":
        effective = limit_runtime(content, settings)
        for name in RuntimeContent.model_fields:
            raw, limit = getattr(content, name), getattr(effective, name)
            if isinstance(raw, int) and not isinstance(raw, bool) and raw > limit:
                issues.append(
                    ConfigurationIssue(
                        code="DEPLOYMENT_LIMIT_APPLIES",
                        severity="warning",
                        path=name,
                        message=f"生效值受部署硬上限 {limit} 限制",
                    )
                )
        for service in row.resume_services:
            if not deployment_allowed(settings, service):
                issues.append(
                    ConfigurationIssue(
                        code="SERVICE_NOT_READY",
                        severity="error",
                        path="resume_services",
                        message=f"{service} 的部署开关或配置尚未就绪",
                    )
                )
            stop = db.get(EmergencyStopRecord, service)
            if (
                not stop
                or not stop.stopped
                or row.resume_stop_revisions.get(service) != stop.revision
            ):
                issues.append(
                    ConfigurationIssue(
                        code="STOP_REVISION_CHANGED",
                        severity="error",
                        path="resume_services",
                        message="停用原因或版本已改变，请重新申请恢复",
                    )
                )
    return ConfigurationPreflight(
        valid=not any(i.severity == "error" for i in issues),
        revision=row.revision,
        content_sha256=sha(row.draft),
        dependency_sha256=sha(dependencies),
        issues=issues,
    )


def require_valid(db, actor, row, settings):
    result = preflight_for(db, actor, row, settings)
    if not result.valid:
        raise DomainError("CONFIGURATION_CHECK_FAILED", "配置检查未通过，请修复后重新提交", 409)


def merge(base, patch):
    result = dict(base)
    for key, value in patch.items():
        result[key] = (
            merge(result[key], value)
            if isinstance(value, dict) and isinstance(result.get(key), dict)
            else value
        )
    return result


def published_configuration(db, kind, scope):
    row = db.scalar(
        select(ConfigurationRecord).where(
            ConfigurationRecord.kind == kind, ConfigurationRecord.scope == scope
        )
    )
    return row if row and row.published and row.published_revision else None


def runtime_policy(db):
    row = published_configuration(db, "runtime", "global")
    if row:
        result = RuntimeContent.model_validate(row.published)
    else:
        # Compatibility before migration/isolated fixtures: never read an old
        # payload once a published typed runtime record exists.
        from app.models import GuideSettingsRecord

        old = db.get(GuideSettingsRecord, 1)
        result = RuntimeContent.model_validate({"kind": "runtime", **(old.payload if old else {})})
    stopped = set(
        db.scalars(
            select(EmergencyStopRecord.service).where(EmergencyStopRecord.stopped.is_(True))
        ).all()
    )
    for service in stopped:
        field = {
            "chat": "chat_enabled",
            "voice": "voice_enabled",
            "navigation": "navigation_enabled",
            "narration_generation": "narration_generation_enabled",
            "narration_playback": "narration_playback_enabled",
        }.get(service)
        if field:
            setattr(result, field, False)
    return result


def deployment_allowed(settings, service):
    if service == "chat":
        return bool(settings.api_agent_configured)
    if service == "voice":
        from app.modules.voice.config import voice_config

        return voice_config(settings).enabled
    if service == "narration_generation":
        return bool(
            getattr(settings, "narration_generation_enabled", False)
            and getattr(settings, "voice_api_key", None)
        )
    if service == "navigation":
        return bool(settings.map_enabled)
    return bool(getattr(settings, "narration_playback_enabled", True))


def limit_runtime(policy, settings):
    caps = {
        "visitor_turns_per_hour": getattr(settings, "agent_visitor_turns_per_hour", 30),
        "total_turns_per_hour": getattr(settings, "agent_model_requests_per_hour", 120),
        "model_requests_per_day": getattr(settings, "agent_model_requests_per_day", 720),
        "voice_visitor_requests_per_hour": settings.voice_visitor_requests_per_hour,
        "voice_total_requests_per_hour": settings.voice_total_requests_per_hour,
        "voice_requests_per_day": settings.agent_voice_requests_per_day,
        "supplier_requests_per_day": settings.agent_supplier_requests_per_day,
        "supplier_characters_per_day": settings.agent_supplier_characters_per_day,
        "supplier_session_requests_per_day": settings.agent_supplier_session_requests_per_day,
        "ip_requests_per_hour": settings.agent_ip_requests_per_hour,
        "ip_requests_per_day": settings.agent_ip_requests_per_day,
        "http_requests_per_hour": settings.agent_http_requests_per_hour,
        "http_requests_per_day": settings.agent_http_requests_per_day,
        "narration_staff_requests_per_hour": getattr(
            settings, "narration_staff_requests_per_hour", 45
        ),
        "narration_staff_requests_per_day": getattr(
            settings, "narration_staff_requests_per_day", 270
        ),
    }
    data = policy.model_dump()
    for name, hard in caps.items():
        data[name] = min(data[name], hard)
    return RuntimeContent.model_validate(data)


def effective_runtime(db, settings):
    result = limit_runtime(runtime_policy(db), settings)
    for service in SERVICES:
        field = {
            "chat": "chat_enabled",
            "voice": "voice_enabled",
            "navigation": "navigation_enabled",
            "narration_generation": "narration_generation_enabled",
            "narration_playback": "narration_playback_enabled",
        }[service]
        setattr(
            result, field, bool(getattr(result, field) and deployment_allowed(settings, service))
        )
    return result


@router.get(
    "/api/v1/admin/configurations",
    response_model=Envelope[list[AdminConfiguration]],
    operation_id="listConfigurations",
    openapi_extra=META,
)
def list_configurations(
    request: Request,
    actor: Actor,
    db: DB,
    kind: ConfigurationKind | None = None,
    scope: str | None = Query(default=None, max_length=80),
):
    query = select(ConfigurationRecord).order_by(
        ConfigurationRecord.kind, ConfigurationRecord.scope
    )
    if kind:
        query = query.where(ConfigurationRecord.kind == kind)
    if scope:
        query = query.where(ConfigurationRecord.scope == scope)
    return envelope(
        request,
        [admin_view(db, actor, row) for row in db.scalars(query) if readable(db, actor, row)],
    )


@router.get(
    "/api/v1/admin/configurations/{configuration_id}",
    response_model=Envelope[AdminConfiguration],
    operation_id="getConfiguration",
    openapi_extra=META,
)
def get_configuration(configuration_id: UUID, request: Request, actor: Actor, db: DB):
    return envelope(request, admin_view(db, actor, record_for(db, actor, configuration_id)))


@router.post(
    "/api/v1/admin/configurations",
    response_model=Envelope[AdminConfiguration],
    operation_id="createConfiguration",
    openapi_extra=META,
)
@write_guard
def create_configuration(payload: ConfigurationCreate, request: Request, actor: Actor, db: DB):
    if payload.kind != payload.content.kind:
        raise DomainError("CONFIGURATION_KIND_MISMATCH", "配置类型与内容不一致", 422)
    validate_scope(db, payload.kind, payload.scope)
    require_permission(db, actor, payload.kind, payload.scope, "edit")
    fingerprint, old = find_operation(
        db, actor, payload.operation_id, "create", None, payload.model_dump(mode="json")
    )
    if old:
        return envelope(request, old)
    if db.scalar(
        select(ConfigurationRecord.id).where(
            ConfigurationRecord.kind == payload.kind, ConfigurationRecord.scope == payload.scope
        )
    ):
        raise DomainError("CONFIGURATION_EXISTS", "此范围已有配置，请打开现有记录", 409)
    row = ConfigurationRecord(
        id=str(uuid4()),
        kind=payload.kind,
        scope=payload.scope,
        schema_version=1,
        revision=1,
        published_revision=0,
        state="draft",
        draft=content_payload(payload.content),
        contributor_ids=[actor.user.id],
        resume_services=[],
        resume_stop_revisions={},
        review_note=payload.note,
        updated_at=now_utc(),
    )
    check_structure_scope(db, actor, row, payload.content)
    db.add(row)
    db.flush()
    version(db, row, "created", actor)
    audit_config(db, actor, row, "create", payload.note)
    return envelope(
        request, complete_operation(db, actor, row, payload.operation_id, "create", fingerprint)
    )


@router.put(
    "/api/v1/admin/configurations/{configuration_id}",
    response_model=Envelope[AdminConfiguration],
    operation_id="saveConfiguration",
    openapi_extra=META,
)
@write_guard
def save_configuration(
    configuration_id: UUID, payload: ConfigurationSave, request: Request, actor: Actor, db: DB
):
    row = record_for(db, actor, configuration_id, lock=True)
    require_permission(db, actor, row.kind, row.scope, "edit")
    fingerprint, old = find_operation(
        db, actor, payload.operation_id, "save", row.id, payload.model_dump(mode="json")
    )
    if old:
        return envelope(request, old)
    check_cas(row, payload)
    writable(row)
    if payload.content.kind != row.kind:
        raise DomainError("CONFIGURATION_KIND_MISMATCH", "不能改变配置类型", 422)
    check_structure_scope(db, actor, row, payload.content)
    data = content_payload(payload.content)
    if data != row.draft:
        row.draft, row.revision, row.state, row.updated_at = (
            data,
            row.revision + 1,
            "draft",
            now_utc(),
        )
        row.contributor_ids = sorted(set(row.contributor_ids + [actor.user.id]))
        row.review_note = payload.note
        row.submitted_by = row.submitted_at = row.submitted_sha256 = None
        latest = db.scalar(
            select(ConfigurationVersionRecord)
            .where(ConfigurationVersionRecord.configuration_id == row.id)
            .order_by(ConfigurationVersionRecord.created_at.desc())
            .limit(1)
        )
        if not latest or utc(latest.created_at) + timedelta(minutes=5) <= now_utc():
            version(db, row, "autosave", actor)
        audit_config(db, actor, row, "save", payload.note)
    return envelope(
        request, complete_operation(db, actor, row, payload.operation_id, "save", fingerprint)
    )


@write_guard
def apply_action(configuration_id, payload, request, actor, db, action):
    row = record_for(db, actor, configuration_id, lock=True)
    mode = "review" if action in {"publish", "reject"} else "edit"
    require_permission(db, actor, row.kind, row.scope, mode)
    if action == "publish":
        require_recent_mfa(actor)
    fingerprint, old = find_operation(
        db, actor, payload.operation_id, action, row.id, payload.model_dump(mode="json")
    )
    if old:
        return envelope(request, old)
    check_cas(row, payload)
    if action == "preflight":
        report = preflight_for(db, actor, row, request.app.state.settings).model_dump(mode="json")
        return envelope(request, report)
    if action in {"publish", "reject"}:
        if row.state != "in_review":
            raise DomainError("NOT_IN_REVIEW", "配置不在待审状态", 409)
        if actor.user.id in set(
            row.contributor_ids + ([row.submitted_by] if row.submitted_by else [])
        ):
            raise DomainError("SELF_REVIEW_DENIED", "贡献者或提交人不能审核自己的稿件", 403)
        if row.submitted_sha256 != submission_sha(row):
            raise DomainError("SUBMISSION_CHANGED", "待审稿件已改变，请重新提审", 409)
        if action == "reject" and not payload.note.strip():
            raise DomainError("REVIEW_NOTE_REQUIRED", "退回时请说明原因", 422)
    if action == "submit":
        writable(row)
        require_valid(db, actor, row, request.app.state.settings)
        row.contributor_ids = sorted(set(row.contributor_ids + [actor.user.id]))
        row.submitted_by, row.submitted_at, row.submitted_sha256 = (
            actor.user.id,
            now_utc(),
            submission_sha(row),
        )
        row.state = "in_review"
    elif action == "withdraw":
        if row.state != "in_review":
            raise DomainError("NOT_IN_REVIEW", "配置不在待审状态", 409)
        row.state = "draft"
        row.submitted_by = row.submitted_at = row.submitted_sha256 = None
    elif action == "publish":
        require_valid(db, actor, row, request.app.state.settings)
        row.published, row.published_revision, row.state = (
            dict(row.draft),
            row.published_revision + 1,
            "published",
        )
        for service in row.resume_services:
            stopped = db.scalar(
                select(EmergencyStopRecord)
                .where(EmergencyStopRecord.service == service)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if not stopped or stopped.revision != row.resume_stop_revisions.get(service):
                raise DomainError("STOP_REVISION_CHANGED", "停用版本已改变，请重新申请恢复", 409)
            if stopped and stopped.stopped:
                (
                    stopped.stopped,
                    stopped.revision,
                    stopped.actor_id,
                    stopped.reason,
                    stopped.updated_at,
                ) = False, stopped.revision + 1, actor.user.id, payload.note, now_utc()
        row.resume_services = []
        row.resume_stop_revisions = {}
    elif action == "reject":
        row.state = "rejected"
    elif action == "checkpoint":
        writable(row)
    else:
        raise DomainError("INVALID_ACTION", "未知配置操作", 422)
    row.review_note, row.updated_at = payload.note, now_utc()
    if action != "checkpoint":
        row.revision += 1
    version(db, row, action, actor)
    audit_config(db, actor, row, action, payload.note)
    return envelope(
        request, complete_operation(db, actor, row, payload.operation_id, action, fingerprint)
    )


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/preflight",
    response_model=Envelope[ConfigurationPreflight],
    operation_id="preflightConfiguration",
    openapi_extra=META,
)
def preflight(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    row = record_for(db, actor, configuration_id)
    check_cas(row, payload)
    return envelope(request, preflight_for(db, actor, row, request.app.state.settings))


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/submit",
    response_model=Envelope[AdminConfiguration],
    operation_id="submitConfiguration",
    openapi_extra=META,
)
def submit(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    return apply_action(configuration_id, payload, request, actor, db, "submit")


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/withdraw",
    response_model=Envelope[AdminConfiguration],
    operation_id="withdrawConfiguration",
    openapi_extra=META,
)
def withdraw(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    return apply_action(configuration_id, payload, request, actor, db, "withdraw")


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/publish",
    response_model=Envelope[AdminConfiguration],
    operation_id="publishConfiguration",
    openapi_extra=META,
)
def publish(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    return apply_action(configuration_id, payload, request, actor, db, "publish")


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/reject",
    response_model=Envelope[AdminConfiguration],
    operation_id="rejectConfiguration",
    openapi_extra=META,
)
def reject(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    return apply_action(configuration_id, payload, request, actor, db, "reject")


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/checkpoint",
    response_model=Envelope[AdminConfiguration],
    operation_id="checkpointConfiguration",
    openapi_extra=META,
)
def checkpoint(
    configuration_id: UUID, payload: ConfigurationAction, request: Request, actor: Actor, db: DB
):
    return apply_action(configuration_id, payload, request, actor, db, "checkpoint")


@router.get(
    "/api/v1/admin/configurations/{configuration_id}/history",
    response_model=Envelope[list[ConfigurationVersion]],
    operation_id="configurationHistory",
    openapi_extra=META,
)
def history(configuration_id: UUID, request: Request, actor: Actor, db: DB):
    row = record_for(db, actor, configuration_id)
    versions = db.scalars(
        select(ConfigurationVersionRecord)
        .where(ConfigurationVersionRecord.configuration_id == row.id)
        .order_by(ConfigurationVersionRecord.created_at.desc(), ConfigurationVersionRecord.id)
    ).all()
    return envelope(
        request,
        [
            ConfigurationVersion(
                id=v.id,
                configuration_id=v.configuration_id,
                event=v.event,
                revision=v.revision,
                published_revision=v.published_revision,
                content=CONTENT.validate_python(v.content),
                content_sha256=v.content_sha256,
                contributor_ids=v.contributor_ids,
                actor_id=v.actor_id,
                created_at=utc(v.created_at),
                override_fields=sorted(set(v.content) - {"kind"}),
            )
            for v in versions
        ],
    )


@router.post(
    "/api/v1/admin/configurations/{configuration_id}/history/{version_id}/restore-draft",
    response_model=Envelope[AdminConfiguration],
    operation_id="restoreConfigurationDraft",
    openapi_extra=META,
)
@write_guard
def restore_draft(
    configuration_id: UUID,
    version_id: UUID,
    payload: ConfigurationAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    row = record_for(db, actor, configuration_id, lock=True)
    require_permission(db, actor, row.kind, row.scope, "edit")
    fingerprint, old = find_operation(
        db,
        actor,
        payload.operation_id,
        "restore",
        row.id,
        {**payload.model_dump(mode="json"), "version_id": str(version_id)},
    )
    if old:
        return envelope(request, old)
    check_cas(row, payload)
    writable(row)
    item = db.get(ConfigurationVersionRecord, str(version_id))
    if item is None or item.configuration_id != row.id:
        raise DomainError("NOT_FOUND", "历史版本不存在", 404)
    try:
        content = CONTENT.validate_python(item.content)
    except ValidationError:
        raise DomainError("HISTORY_SCHEMA_CHANGED", "历史稿件需要转换后才能恢复", 409) from None
    check_structure_scope(db, actor, row, content)
    row.draft, row.revision, row.state, row.updated_at = (
        dict(item.content),
        row.revision + 1,
        "draft",
        now_utc(),
    )
    row.contributor_ids = sorted(set(row.contributor_ids + item.contributor_ids + [actor.user.id]))
    row.resume_services = []  # Approval to resume is never replayed from history.
    row.resume_stop_revisions = {}
    row.submitted_by = row.submitted_at = row.submitted_sha256 = None
    row.review_note = payload.note
    version(db, row, "restore", actor)
    audit_config(db, actor, row, "restore", payload.note, {"version_id": str(version_id)})
    return envelope(
        request, complete_operation(db, actor, row, payload.operation_id, "restore", fingerprint)
    )


@router.get(
    "/api/v1/admin/operations/{operation_id}",
    response_model=Envelope[ConfigurationOperation],
    operation_id="getStaffOperation",
    openapi_extra=META,
)
def get_operation(operation_id: UUID, request: Request, actor: Actor, db: DB):
    row = db.get(ConfigurationOperationRecord, (actor.user.id, str(operation_id)))
    if not row:
        from app.content_history_models import ExperienceOperationRecord
        from app.modules.experiences import authorize_operation_result

        result = db.get(ExperienceOperationRecord, (actor.user.id, str(operation_id)))
        if not result:
            from app.content_control_models import ContentOperationRecord
            from app.modules.content_control_service import owned

            content_result = db.get(ContentOperationRecord, (actor.user.id, str(operation_id)))
            if content_result is None:
                raise DomainError("NOT_FOUND", "操作记录不存在", 404)
            actor.require("points.read")
            owned(db, actor, content_result.entity_type, content_result.entity_id)
            return envelope(
                request,
                ConfigurationOperation(
                    id=content_result.id,
                    target_id=content_result.entity_id,
                    action=content_result.entity_type + "." + content_result.action,
                    result=content_result.result,
                    created_at=utc(content_result.created_at),
                ),
            )
        actor.require("points.read")
        authorize_operation_result(db, actor, result)
        return envelope(
            request,
            ConfigurationOperation(
                id=result.id,
                target_id=result.target_id,
                action="experience." + result.action,
                result=result.result,
                created_at=utc(result.created_at),
            ),
        )
    record_for(db, actor, row.target_id)
    return envelope(
        request,
        ConfigurationOperation(
            id=row.id,
            target_id=row.target_id,
            action=row.action,
            result=row.result
            if row.action == "pause"
            else AdminConfiguration.model_validate(row.result),
            created_at=utc(row.created_at),
        ),
    )


@router.get(
    "/api/v1/admin/configuration-permissions",
    response_model=Envelope[list[ConfigurationGrant]],
    operation_id="getConfigurationPermissions",
    openapi_extra=META,
)
def grants(request: Request, actor: Actor, db: DB):
    query = select(ConfigurationGrantRecord)
    if actor.user.role != "admin":
        query = query.where(ConfigurationGrantRecord.user_id == actor.user.id)
    return envelope(
        request,
        [
            ConfigurationGrant(
                user_id=r.user_id,
                permission=r.permission,
                scope=r.scope,
                granted_by=r.granted_by,
                note=r.note,
                updated_at=utc(r.updated_at),
            )
            for r in db.scalars(
                query.order_by(
                    ConfigurationGrantRecord.user_id,
                    ConfigurationGrantRecord.permission,
                    ConfigurationGrantRecord.scope,
                )
            )
        ],
    )


@router.put(
    "/api/v1/admin/configuration-permissions/{user_id}/{permission}",
    response_model=Envelope[list[ConfigurationGrant]],
    operation_id="setConfigurationPermission",
    openapi_extra=META,
)
@write_guard
def set_grant(
    user_id: UUID,
    permission: ConfigurationPermission,
    payload: ConfigurationGrantUpdate,
    request: Request,
    actor: Actor,
    db: DB,
):
    actor.require("users.manage")
    require_recent_mfa(actor)
    user = db.get(StaffUserRecord, str(user_id))
    if not user or not user.is_active:
        raise DomainError("NOT_FOUND", "有效员工不存在", 404)
    validate_scope(
        db, "runtime" if permission.startswith("runtime.") else "presentation", payload.scope
    )
    if payload.scope != "global" and user.role != "admin" and payload.scope not in user.campus_ids:
        raise DomainError("INVALID_SCOPE", "配置授权不能越过员工现有校区范围", 422)
    key = (str(user_id), permission, payload.scope)
    row = db.get(ConfigurationGrantRecord, key)
    if payload.enabled:
        if row is None:
            row = ConfigurationGrantRecord(
                user_id=str(user_id), permission=permission, scope=payload.scope
            )
            db.add(row)
        row.granted_by, row.note, row.updated_at = actor.user.id, payload.note, now_utc()
    elif row:
        db.delete(row)
    audit(
        db,
        actor.user,
        "configuration.permission",
        note=payload.note,
        details={
            "user_id": str(user_id),
            "permission": permission,
            "scope": payload.scope,
            "enabled": payload.enabled,
        },
    )
    db.commit()
    return grants(request, actor, db)


@router.get(
    "/api/v1/admin/service-controls",
    response_model=Envelope[dict],
    operation_id="getServiceControls",
    openapi_extra=META,
)
def controls(request: Request, actor: Actor, db: DB):
    from app.modules.narration.maintenance import storage_status
    if not (
        granted(db, actor, "runtime", "global", "edit")
        or granted(db, actor, "runtime", "global", "review")
        or actor.user.role == "admin"
    ):
        raise DomainError("FORBIDDEN", "无权查看运行控制", 403)
    settings = request.app.state.settings
    raw = published_configuration(db, "runtime", "global")
    stops = {
        r.service: {
            "revision": r.revision,
            "stopped": r.stopped,
            "reason": r.reason,
            "updated_at": utc(r.updated_at).isoformat(),
        }
        for r in db.scalars(select(EmergencyStopRecord))
    }
    return envelope(
        request,
        {
            "published_revision": raw.published_revision if raw else 0,
            "approved": CONTENT.validate_python(raw.published).model_dump(mode="json")
            if raw
            else RuntimeContent().model_dump(mode="json"),
            "effective": effective_runtime(db, settings).model_dump(mode="json"),
            "deployment_allowed": {s: deployment_allowed(settings, s) for s in sorted(SERVICES)},
            "stops": stops,
            "permissions": {
                "edit": granted(db, actor, "runtime", "global", "edit"),
                "review": granted(db, actor, "runtime", "global", "review"),
            },
            "provider_connectivity": "not_verified",
            "narration_storage": storage_status(settings),
        },
    )


@router.post(
    "/api/v1/admin/service-controls/{service}/pause",
    response_model=Envelope[dict],
    operation_id="pauseConfiguredService",
    openapi_extra=META,
)
@write_guard
def pause_service(
    service: ControlledService,
    payload: ServiceControlAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    require_permission(db, actor, "runtime", "global", "edit")
    policy = db.scalar(
        select(ConfigurationRecord).where(
            ConfigurationRecord.kind == "runtime", ConfigurationRecord.scope == "global"
        )
    )
    if policy is None:
        raise DomainError("POLICY_REQUIRED", "请先创建运行策略草稿", 409)
    fingerprint, old = find_operation(
        db,
        actor,
        payload.operation_id,
        "pause",
        policy.id,
        {"service": service, **payload.model_dump(mode="json")},
    )
    if old:
        return envelope(request, old)
    # A pause can only reduce capability and intentionally needs no paid/MFA flow.
    row = db.scalar(
        select(EmergencyStopRecord)
        .where(EmergencyStopRecord.service == service)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        row = EmergencyStopRecord(service=service, revision=1)
        db.add(row)
    else:
        row.revision += 1
    row.stopped, row.reason, row.actor_id, row.updated_at = (
        True,
        payload.note,
        actor.user.id,
        now_utc(),
    )
    audit(
        db,
        actor.user,
        "configuration.pause",
        note=payload.note,
        details={
            "service": service,
            "revision": row.revision,
            "operation_id": str(payload.operation_id),
        },
    )
    data = controls(request, actor, db)["data"]
    return envelope(
        request,
        complete_operation(db, actor, policy, payload.operation_id, "pause", fingerprint, data),
    )


@router.post(
    "/api/v1/admin/service-controls/{service}/resume-request",
    response_model=Envelope[AdminConfiguration],
    operation_id="requestConfiguredServiceResume",
    openapi_extra=META,
)
@write_guard
def resume_service(
    service: ControlledService,
    payload: ServiceControlAction,
    request: Request,
    actor: Actor,
    db: DB,
):
    require_permission(db, actor, "runtime", "global", "edit")
    require_recent_mfa(actor)
    row = db.scalar(
        select(ConfigurationRecord)
        .where(ConfigurationRecord.kind == "runtime", ConfigurationRecord.scope == "global")
        .with_for_update()
    )
    if row is None:
        raise DomainError("POLICY_REQUIRED", "请先创建并审核运行策略", 409)
    fingerprint, old = find_operation(
        db,
        actor,
        payload.operation_id,
        "resume_request",
        row.id,
        {"service": service, **payload.model_dump(mode="json")},
    )
    if old:
        return envelope(request, old)
    writable(row)
    stop = db.get(EmergencyStopRecord, service)
    if not stop or not stop.stopped:
        raise DomainError("SERVICE_NOT_PAUSED", "此服务没有紧急停用记录", 409)
    if not deployment_allowed(request.app.state.settings, service):
        raise DomainError("SERVICE_NOT_READY", "部署开关或必要配置尚未就绪", 409)
    row.resume_services = sorted(set(row.resume_services + [service]))
    row.resume_stop_revisions = {**row.resume_stop_revisions, service: stop.revision}
    row.contributor_ids = sorted(set(row.contributor_ids + [actor.user.id]))
    row.revision, row.state, row.updated_at, row.review_note = (
        row.revision + 1,
        "draft",
        now_utc(),
        payload.note,
    )
    row.submitted_by = row.submitted_at = row.submitted_sha256 = None
    version(db, row, "resume_request", actor)
    audit_config(
        db,
        actor,
        row,
        "resume_request",
        payload.note,
        {"service": service, "stop_revision": stop.revision},
    )
    return envelope(
        request,
        complete_operation(db, actor, row, payload.operation_id, "resume_request", fingerprint),
    )


def layered(db, kind, campus_id, override=None):
    baseline = PresentationContent() if kind == "presentation" else VisitDefaultsContent()
    data, revisions = baseline.model_dump(mode="json"), {}
    sources = {key: "builtin" for key in data if key != "kind"}
    for scope in ("global", campus_id):
        row = published_configuration(db, kind, scope)
        revisions[("global" if scope == "global" else "campus") + "_" + kind] = (
            row.published_revision if row else 0
        )
        if override is not None and override.kind == kind and override.scope == scope:
            data = merge(data, override.draft)
            changed = override.draft
        elif row:
            data = merge(data, row.published)
            changed = row.published
        else:
            changed = {}
        for key in changed:
            if key in sources:
                sources[key] = "global" if scope == "global" else "campus"
    return CONTENT.validate_python(data), revisions, sources


def public_showcase(db, campus_id, settings, override=None):
    from app.modules.experiences import get_published_experience, published_experiences

    require_campus(db, campus_id)
    presentation, revisions, _ = layered(db, "presentation", campus_id, override)
    visit_defaults, visit_revisions, visit_sources = layered(db, "visit_defaults", campus_id, override)
    if visit_defaults.map_default_view:
        try:
            if not settings.map_enabled:
                raise DomainError("MAP_DEFAULT_DISABLED", "校园地图当前不可用", 409)
            check_map_default(db, visit_defaults.map_default_view, campus_id)
        except DomainError:
            # Keep the published snapshot unchanged; visitors fit the available map.
            visit_defaults.map_default_view = None
    revisions.update(visit_revisions)
    resolved, modules = {}, []
    for module in presentation.modules:
        if (
            not module.enabled
            or (module.start_at and utc(module.start_at) > now_utc())
            or (module.end_at and utc(module.end_at) <= now_utc())
        ):
            continue
        copy = module.model_copy(deep=True)
        if copy.image:
            try:
                item = resolve_reference(db, copy.image, campus_id)
                resolved[(item.type, str(item.id))] = item
            except DomainError:
                copy.image = None
        valid_routes = []
        for ref in copy.routes:
            try:
                item = resolve_reference(db, ref, campus_id)
                resolved[(item.type, str(item.id))] = item
                valid_routes.append(ref)
            except DomainError:
                continue
        copy.routes = valid_routes
        if copy.target and copy.target.type == "tour":
            try:
                item = resolve_reference(
                    db,
                    ConfigurationReference(
                        type="tour", id=copy.target.id, revision=copy.target.revision
                    ),
                    campus_id,
                )
                resolved[(item.type, str(item.id))] = item
            except DomainError:
                copy.target = None
        modules.append(copy)
    presentation.modules = modules
    cards = []
    for route in published_experiences(db, kind="tour", campus_id=campus_id):
        content = route.content
        cover_url = None
        if content.cover_image_id:
            cover_url = get_published_experience(db, str(content.cover_image_id)).media_url
        resource_types = {"image"} if content.cover_image_id else set()
        for stop in content.stops:
            if stop.segments is None or stop.legacy_media_compat:
                if stop.video_id:
                    resource_types.add("video")
                if stop.checkin_id:
                    resource_types.add("checkin")
            for segment in stop.segments or []:
                refs = [*segment.resources]
                if segment.main_view.type != "map":
                    refs.append(segment.main_view)
                for ref in refs:
                    resource_types.add("vr" if ref.type == "vr_entry" else ref.type)
        cards.append(
            ShowcaseRouteCard(
                id=route.id,
                campus_id=campus_id,
                revision=route.revision,
                title=content.title,
                description=content.description,
                cover_image_id=content.cover_image_id,
                cover_image_revision=content.cover_image_revision,
                media_url=cover_url,
                stop_count=len(content.stops),
                sort_order=getattr(content, "sort_order", 0),
                benefits=getattr(content, "outcomes", []),
                resource_types=sorted(resource_types),
            )
        )
    cards.sort(key=lambda c: (c.sort_order, c.title, str(c.id)))
    policy = effective_runtime(db, settings)
    return Showcase(
        campus_id=campus_id,
        presentation=presentation,
        visit_defaults=visit_defaults,
        configuration_revisions=revisions,
        visit_default_sources=visit_sources,
        routes=cards,
        resolved_resources=list(resolved.values()),
        capabilities={
            "chat": settings.agent_public_enabled and policy.chat_enabled,
            "voice": settings.agent_public_enabled and policy.voice_enabled,
            "narration": policy.narration_playback_enabled,
            "navigation": policy.navigation_enabled,
        },
    )


@router.get(
    "/api/v1/campuses/{campus_id}/showcase",
    response_model=Envelope[Showcase],
    operation_id="getCampusShowcase",
    openapi_extra={**META, "x-auth": "public"},
)
def showcase(campus_id: str, request: Request, db: DB):
    return envelope(request, public_showcase(db, campus_id, request.app.state.settings))


@router.post(
    "/api/v1/admin/configurations/preview",
    response_model=Envelope[Showcase],
    operation_id="previewUnsavedConfiguration",
    openapi_extra=META,
)
def preview_unsaved(payload: ConfigurationPreview, request: Request, actor: Actor, db: DB):
    from types import SimpleNamespace

    if payload.kind != payload.content.kind:
        raise DomainError("CONFIGURATION_KIND_MISMATCH", "配置类型与内容不一致", 422)
    validate_scope(db, payload.kind, payload.scope)
    require_permission(db, actor, payload.kind, payload.scope, "edit")
    require_campus(db, payload.campus_id)
    if payload.scope != "global" and payload.scope != payload.campus_id:
        raise DomainError("SCOPE_DENIED", "校区配置只能预览对应校区", 403)
    if actor.user.role != "admin" and payload.campus_id not in actor.user.campus_ids:
        raise DomainError("NOT_FOUND", "校区不在授权范围内", 404)
    transient = SimpleNamespace(
        kind=payload.kind, scope=payload.scope, draft=content_payload(payload.content)
    )
    check_structure_scope(db, actor, transient, payload.content)
    return envelope(
        request, public_showcase(db, payload.campus_id, request.app.state.settings, transient)
    )


@router.get(
    "/api/v1/admin/configurations/{configuration_id}/preview",
    response_model=Envelope[Showcase],
    operation_id="previewConfiguration",
    openapi_extra=META,
)
def preview_configuration(
    configuration_id: UUID,
    request: Request,
    actor: Actor,
    db: DB,
    campus_id: str = Query(max_length=80),
    expected_revision: int = Query(ge=1),
):
    row = record_for(db, actor, configuration_id)
    if row.revision != expected_revision:
        raise DomainError("REVISION_CONFLICT", "预览稿件已改变，请重新载入", 409)
    if row.kind == "runtime" or (row.scope != "global" and row.scope != campus_id):
        raise DomainError("INVALID_PREVIEW_SCOPE", "此配置不支持所选校区预览", 422)
    return envelope(
        request, public_showcase(db, campus_id, request.app.state.settings, override=row)
    )


@router.get(
    "/api/v1/admin/configurations/{configuration_id}/history/{version_id}/preview",
    response_model=Envelope[Showcase],
    operation_id="previewConfigurationHistory",
    openapi_extra=META,
)
def preview_configuration_history(
    configuration_id: UUID, version_id: UUID, request: Request, actor: Actor, db: DB,
    campus_id: str = Query(max_length=80),
):
    from types import SimpleNamespace

    row = record_for(db, actor, configuration_id)  # Either edit or independent review.
    item = db.get(ConfigurationVersionRecord, str(version_id))
    if not item or item.configuration_id != row.id:
        raise DomainError("NOT_FOUND", "历史配置不存在", 404)
    if row.kind == "runtime" or (row.scope != "global" and row.scope != campus_id):
        raise DomainError("INVALID_PREVIEW_SCOPE", "此配置不支持所选校区预览", 422)
    require_campus(db, campus_id)
    if actor.user.role != "admin" and campus_id not in actor.user.campus_ids:
        raise DomainError("NOT_FOUND", "校区不在当前授权范围内", 404)
    transient = SimpleNamespace(kind=row.kind, scope=row.scope, draft=item.content)
    check_structure_scope(db, actor, transient, CONTENT.validate_python(item.content))
    return envelope(
        request, public_showcase(db, campus_id, request.app.state.settings, override=transient)
    )
