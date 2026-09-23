from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from app.api import DB, ERRORS, envelope, get_point
from app.contracts import Envelope, Floor
from app.core.errors import DomainError
from app.models import FloorRecord
from app.modules.floors.service import as_floor, public_floors

router = APIRouter()
IMPLEMENTED = {
    "x-implementation-status": "implemented",
    "x-module": "M05",
    "x-auth": "resource_policy",
}


def require_floor(floor_id, request, db):
    record = db.scalar(public_floors().where(FloorRecord.id == str(floor_id)))
    if not request.app.state.settings.floors_enabled or record is None:
        raise DomainError("NOT_FOUND", "楼层不存在或尚未公开", 404)
    return record


@router.get(
    "/api/v1/points/{point_id}/floors",
    response_model=Envelope[list[Floor]],
    operation_id="listFloors",
    tags=["floors"],
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def list_floors(point_id: UUID, request: Request, db: DB):
    get_point(point_id, request, db)  # A private building cannot reveal its floor inventory.
    records = db.scalars(
        public_floors()
        .where(FloorRecord.point_id == str(point_id))
        .order_by(FloorRecord.ordinal, FloorRecord.id)
    ).all()
    return envelope(
        request, [as_floor(r) for r in records] if request.app.state.settings.floors_enabled else []
    )


@router.get(
    "/api/v1/floors/{floor_id}",
    response_model=Envelope[Floor],
    operation_id="getFloor",
    tags=["floors"],
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def get_floor(floor_id: UUID, request: Request, db: DB):
    return envelope(request, as_floor(require_floor(floor_id, request, db)))


@router.get(
    "/api/v1/floors/{floor_id}/images/{revision}/{variant}",
    response_class=FileResponse,
    operation_id="getFloorImage",
    tags=["floors"],
    openapi_extra=IMPLEMENTED,
    responses={
        **ERRORS,
        200: {
            "description": "Unmodified reviewed floor image bytes",
            "content": {
                t: {"schema": {"type": "string", "format": "binary"}}
                for t in ["image/png", "image/jpeg"]
            },
        },
    },
)
def get_image(
    floor_id: UUID, revision: int, variant: Literal["labeled", "clean"], request: Request, db: DB
):
    record = require_floor(floor_id, request, db)
    if revision != record.revision:
        raise DomainError("NOT_FOUND", "楼层图版本不存在", 404)
    asset = next((a for a in record.images if a["variant"] == variant), None)
    root = request.app.state.settings.floor_assets_dir.resolve()
    directory = root / record.id / str(revision)
    path = (directory / asset["filename"]).resolve() if asset else root
    if not path.is_relative_to(root) or not path.is_file():
        raise DomainError("FLOOR_ASSET_UNAVAILABLE", "楼层图暂时不可用", 404)
    if path.stat().st_size != asset["size_bytes"]:
        raise DomainError("FLOOR_ASSET_UNAVAILABLE", "楼层图暂时不可用", 404)
    return FileResponse(path, media_type=asset["media_type"])
