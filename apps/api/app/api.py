from datetime import UTC
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID

from alembic.script import ScriptDirectory
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.contracts import (
    Campus,
    CampusId,
    Capabilities,
    Envelope,
    ErrorEnvelope,
    Health,
    Meta,
    Pagination,
    Point,
    PointCategory,
    SystemStatus,
)
from app.core.errors import DomainError, request_id
from app.database import get_db
from app.models import (
    CampusRecord,
    FloorRecord,
    MapRecord,
    PanoramaRecord,
    PointRecord,
    StaffUserRecord,
)
from app.modules.floors.service import public_floors

router = APIRouter()
DB = Annotated[Session, Depends(get_db)]
IMPLEMENTED = {"x-implementation-status": "implemented", "x-module": "M00"}
ERRORS = {
    422: {"model": ErrorEnvelope},
    404: {"model": ErrorEnvelope},
    503: {"model": ErrorEnvelope},
}


def envelope(request: Request, data, pagination=None):
    return {"data": data, "meta": Meta(request_id=request_id(request), pagination=pagination)}


def require_campus(db: Session, campus_id: str):
    campus = db.get(CampusRecord, campus_id)
    if campus is None or not campus.is_active:
        raise DomainError("NOT_FOUND", "校园不存在", 404)
    return campus


def as_point(record: PointRecord):
    result = Point.model_validate(record)
    if result.updated_at.tzinfo is None:  # SQLite local development does not preserve zones.
        result.updated_at = result.updated_at.replace(tzinfo=UTC)
    return result


@lru_cache
def expected_migration_heads() -> set[str]:
    return set(ScriptDirectory(str(Path(__file__).resolve().parents[1] / "migrations")).get_heads())


@router.get(
    "/health/live",
    response_model=Health,
    tags=["health"],
    operation_id="healthLive",
    openapi_extra=IMPLEMENTED,
)
def live():
    return Health(status="ok")


@router.get(
    "/health/ready",
    response_model=Health,
    tags=["health"],
    operation_id="healthReady",
    responses={503: {"model": ErrorEnvelope}},
    openapi_extra=IMPLEMENTED,
)
def ready(db: DB):
    try:
        db.execute(text("SELECT 1"))
        revisions = set(db.execute(text("SELECT version_num FROM alembic_version")).scalars())
        if revisions != expected_migration_heads():
            raise DomainError("DATABASE_NOT_READY", "数据库迁移尚未就绪", 503)
        db.execute(select(CampusRecord.id).limit(1))
    except SQLAlchemyError as exc:
        raise DomainError("DATABASE_NOT_READY", "数据库尚未就绪", 503) from exc
    return Health(status="ok")


@router.get(
    "/api/v1/system/status",
    response_model=Envelope[SystemStatus],
    tags=["system"],
    operation_id="getSystemStatus",
    openapi_extra=IMPLEMENTED,
)
def system_status(request: Request, db: DB):
    has_map = (
        request.app.state.settings.map_enabled
        and db.scalar(
            select(MapRecord.id)
            .join(CampusRecord)
            .where(
                MapRecord.status == "published",
                MapRecord.kind == "campus",
                MapRecord.visibility == "public",
                CampusRecord.is_active.is_(True),
            )
            .limit(1)
        )
        is not None
    )
    return envelope(
        request,
        SystemStatus(
            version=request.app.state.settings.app_version,
            capabilities=Capabilities(
                map=has_map,
                admin=bool(
                    request.app.state.settings.admin_enabled
                    and db.scalar(
                        select(StaffUserRecord.id)
                        .where(StaffUserRecord.role == "admin", StaffUserRecord.is_active.is_(True))
                        .limit(1)
                    )
                ),
                floors=bool(
                    request.app.state.settings.floors_enabled
                    and db.scalar(public_floors().with_only_columns(FloorRecord.id).limit(1))
                ),
                vr=bool(
                    request.app.state.settings.vr_enabled
                    and db.scalar(
                        select(PanoramaRecord.id)
                        .join(PointRecord)
                        .join(CampusRecord)
                        .where(
                            PanoramaRecord.status == "published",
                            PointRecord.status == "published",
                            PointRecord.visibility == "public",
                            CampusRecord.is_active.is_(True),
                        )
                        .limit(1)
                    )
                ),
            ),
        ),
    )


@router.get(
    "/api/v1/campuses",
    response_model=Envelope[list[Campus]],
    tags=["campuses"],
    operation_id="listCampuses",
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def list_campuses(request: Request, db: DB):
    campuses = db.scalars(
        select(CampusRecord).where(CampusRecord.is_active.is_(True)).order_by(CampusRecord.id)
    ).all()
    return envelope(request, campuses)


@router.get(
    "/api/v1/campuses/{campus_id}",
    response_model=Envelope[Campus],
    tags=["campuses"],
    operation_id="getCampus",
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def get_campus(campus_id: CampusId, request: Request, db: DB):
    return envelope(request, require_campus(db, campus_id))


@router.get(
    "/api/v1/campuses/{campus_id}/points",
    response_model=Envelope[list[Point]],
    tags=["points"],
    operation_id="listPoints",
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def list_points(
    campus_id: CampusId,
    request: Request,
    db: DB,
    q: Annotated[str | None, Query(max_length=120)] = None,
    category: PointCategory | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
):
    require_campus(db, campus_id)
    conditions = [
        PointRecord.campus_id == campus_id,
        PointRecord.status == "published",
        PointRecord.visibility == "public",
    ]
    if category:
        conditions.append(PointRecord.category == category.value)
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(
            or_(
                PointRecord.name.ilike(f"%{escaped}%", escape="\\"),
                PointRecord.summary.ilike(f"%{escaped}%", escape="\\"),
            )
        )
    total = db.scalar(select(func.count()).select_from(PointRecord).where(*conditions)) or 0
    records = db.scalars(
        select(PointRecord)
        .where(*conditions)
        .order_by(PointRecord.name, PointRecord.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return envelope(
        request,
        [as_point(p) for p in records],
        Pagination(page=page, page_size=page_size, total=total),
    )


@router.get(
    "/api/v1/points/{point_id}",
    response_model=Envelope[Point],
    tags=["points"],
    operation_id="getPoint",
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def get_point(point_id: UUID, request: Request, db: DB):
    record = db.scalar(
        select(PointRecord)
        .join(CampusRecord)
        .where(
            PointRecord.id == str(point_id),
            PointRecord.status == "published",
            PointRecord.visibility == "public",
            CampusRecord.is_active.is_(True),
        )
    )
    if record is None:
        raise DomainError("NOT_FOUND", "点位不存在或尚未公开", 404)
    return envelope(request, as_point(record))
