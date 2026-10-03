"""Transaction neutral helpers: callers own storage locks and the final commit."""

import copy
import hashlib
import json
from datetime import timedelta
from functools import wraps
from inspect import signature

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.content_control_models import (
    ContentOperationRecord,
    ContentSubmissionRecord,
    ContentVersionRecord,
)
from app.core.errors import DomainError
from app.models import (
    FloorRecord,
    NavigationRecord,
    PanoramaRecord,
    PointChangeRecord,
    ResourceChangeRecord,
    now_utc,
)
from app.modules.admin.security import require_point, utc


def write_guard(function):
    parameters = signature(function)

    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (IntegrityError, StaleDataError):
            parameters.bind(*args, **kwargs).arguments["db"].rollback()
            raise DomainError("REVISION_CONFLICT", "内容被其他请求修改，请重新加载", 409) from None

    return guarded


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def owned(db, actor, kind, key, *, lock=False):
    if kind == "point":
        point = require_point(db, actor.user, key, lock=lock)
        return point, db.get(PointChangeRecord, point.id, populate_existing=lock)
    if kind in {"floor", "vr"}:
        from app.modules.admin.resources import load_resource

        point, current, change = load_resource(db, actor, key, lock=lock)
        actual_kind = (
            change.kind if change else "floor" if isinstance(current, FloorRecord) else "panorama"
        )
        if actual_kind != ("floor" if kind == "floor" else "panorama"):
            raise DomainError("NOT_FOUND", "资料类型不匹配", 404)
        return (point, current), change
    if kind == "navigation":
        from app.modules.navigation import scoped_map

        m = scoped_map(db, actor, key)
        if lock:
            db.refresh(m, with_for_update=True)
        return m, db.get(NavigationRecord, m.id, populate_existing=lock)
    raise DomainError("NOT_FOUND", "内容类型不存在", 404)


def capture(db, kind, key):
    if kind == "point":
        from app.models import PointRecord
        from app.modules.admin.service import snapshot

        point, change = db.get(PointRecord, key), db.get(PointChangeRecord, key)
        current = snapshot(db, point)
        published_revision = point.revision
    elif kind in {"floor", "vr"}:
        from app.modules.admin.resources import published_content

        current_row = db.get(FloorRecord if kind == "floor" else PanoramaRecord, key)
        change = db.get(ResourceChangeRecord, key)
        current = (
            {
                "content": published_content(current_row).model_dump(mode="json"),
                "revision": current_row.revision,
                "status": current_row.status,
                "images": copy.deepcopy(current_row.images) if kind == "floor" else [],
            }
            if current_row
            else None
        )
        published_revision = current_row.revision if current_row else 0
    else:
        change = db.get(NavigationRecord, key)
        return {
            "draft": copy.deepcopy(change.draft),
            "published": copy.deepcopy(change.published),
            "revision": change.revision,
            "published_revision": change.published_revision,
            "operation": "upsert",
            "state": change.state,
            "contributor_ids": list(change.contributor_ids),
            "submitted_by": None,
        }
    return {
        "draft": copy.deepcopy(change.payload) if change else None,
        "published": current,
        "revision": change.revision if change else 0,
        "published_revision": published_revision,
        "operation": change.operation if change else "upsert",
        "state": change.state if change else "published",
        "contributor_ids": list(change.contributor_ids) if change else [],
        "submitted_by": change.submitted_by if change else None,
        "base_revision": change.base_revision if change else published_revision,
    }


def frozen_digest(value):
    return digest(
        {
            name: value.get(name)
            for name in ("draft", "operation", "base_revision", "contributor_ids", "submitted_by")
        }
    )


def record_history(db, kind, key, event, actor=None, *, force=False):
    value = capture(db, kind, key)
    latest = db.scalar(
        select(ContentVersionRecord)
        .where(ContentVersionRecord.entity_type == kind, ContentVersionRecord.entity_id == key)
        .order_by(ContentVersionRecord.created_at.desc(), ContentVersionRecord.id)
        .limit(1)
    )
    if (
        event == "autosave"
        and not force
        and latest
        and utc(latest.created_at) + timedelta(minutes=5) > now_utc()
    ):
        return
    db.add(
        ContentVersionRecord(
            entity_type=kind,
            entity_id=key,
            event=event if latest else "created",
            revision=value["revision"],
            published_revision=value["published_revision"],
            content=value,
            content_sha256=digest(value),
            contributor_ids=value["contributor_ids"],
            actor_id=actor.user.id if actor else None,
        )
    )
    if event in {"autosave", "checkpoint"}:
        older = db.scalars(
            select(ContentVersionRecord)
            .where(
                ContentVersionRecord.entity_type == kind,
                ContentVersionRecord.entity_id == key,
                ContentVersionRecord.event.in_(["autosave", "checkpoint"]),
            )
            .order_by(ContentVersionRecord.created_at.desc(), ContentVersionRecord.id)
        ).all()
        for item in older[50:]:
            db.delete(item)


def freeze(db, kind, key):
    value = capture(db, kind, key)
    row = db.get(ContentSubmissionRecord, (kind, key))
    if row is None:
        row = ContentSubmissionRecord(entity_type=kind, entity_id=key)
        db.add(row)
    row.revision, row.content_sha256, row.created_at = (
        value["revision"],
        frozen_digest(value),
        now_utc(),
    )


def check_frozen(db, kind, key):
    row, value = db.get(ContentSubmissionRecord, (kind, key)), capture(db, kind, key)
    if not row or row.revision != value["revision"] or row.content_sha256 != frozen_digest(value):
        raise DomainError("SUBMISSION_CHANGED", "待审内容或贡献记录已改变，请撤回后重新提审", 409)


def unfreeze(db, kind, key):
    row = db.get(ContentSubmissionRecord, (kind, key))
    if row:
        db.delete(row)


def operation(db, actor, operation_id, kind, action, key, payload):
    fingerprint = digest({"kind": kind, "action": action, "target": key, "payload": payload})
    if not operation_id:
        return fingerprint, None
    from app.configuration_models import ConfigurationOperationRecord
    from app.content_history_models import ExperienceOperationRecord

    for table in (ConfigurationOperationRecord, ExperienceOperationRecord):
        if db.get(table, (actor.user.id, str(operation_id))):
            raise DomainError("OPERATION_CONFLICT", "操作编号已用于其他内容请求", 409)
    item = db.get(ContentOperationRecord, (actor.user.id, str(operation_id)))
    if item:
        if item.fingerprint != fingerprint:
            raise DomainError("OPERATION_CONFLICT", "操作编号对应的请求内容不一致", 409)
        owned(db, actor, item.entity_type, item.entity_id)
        actor.require("points.review" if action in {"publish", "reject"} else "points.edit")
        return fingerprint, item.result
    return fingerprint, None


def finish_operation(db, actor, operation_id, kind, key, action, fingerprint, result):
    if operation_id:
        db.add(
            ContentOperationRecord(
                user_id=actor.user.id,
                id=str(operation_id),
                entity_type=kind,
                entity_id=str(key),
                action=action,
                fingerprint=fingerprint,
                result=copy.deepcopy(result),
            )
        )
    db.flush()
    return result
