import math
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api import DB, ERRORS, envelope, require_campus
from app.contracts import CampusId, Envelope, MapFeatures, MapInfo, MapTiles, PointGeometry
from app.core.errors import DomainError
from app.models import CampusRecord, MapRecord, PointGeometryRecord, PointRecord

router = APIRouter()
IMPLEMENTED = {"x-implementation-status": "implemented", "x-module": "M01", "x-auth": "public"}


def public_maps():
    return (
        select(MapRecord)
        .join(CampusRecord)
        .where(
            CampusRecord.is_active.is_(True),
            MapRecord.status == "published",
            MapRecord.visibility == "public",
        )
    )


def require_map(map_id, request, db):
    record = db.scalar(public_maps().where(MapRecord.id == str(map_id)))
    if not request.app.state.settings.map_enabled or record is None:
        raise DomainError("NOT_FOUND", "地图不存在或尚未公开", 404)
    return record


def as_map(record):
    return MapInfo(
        id=record.id,
        campus_id=record.campus_id,
        title=record.title,
        kind=record.kind,
        width_px=record.width_px,
        height_px=record.height_px,
        revision=record.revision,
        image_asset_id=record.image_asset_id,
        source_sha256=record.source_sha256,
        attribution=record.attribution,
        tiles=MapTiles(
            url_template=f"/api/v1/maps/{record.id}/tiles/{record.revision}/{{z}}/{{x}}/{{y}}.png",
            tile_size=record.tile_size,
            min_zoom=0,
            max_native_zoom=record.max_native_zoom,
        ),
    )


@router.get(
    "/api/v1/campuses/{campus_id}/maps",
    response_model=Envelope[list[MapInfo]],
    operation_id="listMaps",
    tags=["maps"],
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def list_maps(campus_id: CampusId, request: Request, db: DB):
    require_campus(db, campus_id)
    records = db.scalars(
        public_maps().where(MapRecord.campus_id == campus_id).order_by(MapRecord.title)
    ).all()
    return envelope(
        request, [as_map(r) for r in records] if request.app.state.settings.map_enabled else []
    )


@router.get(
    "/api/v1/maps/{map_id}",
    response_model=Envelope[MapInfo],
    operation_id="getMap",
    tags=["maps"],
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def get_map(map_id: UUID, request: Request, db: DB):
    return envelope(request, as_map(require_map(map_id, request, db)))


@router.get(
    "/api/v1/maps/{map_id}/features",
    response_model=Envelope[MapFeatures],
    operation_id="getMapFeatures",
    tags=["maps"],
    responses=ERRORS,
    openapi_extra=IMPLEMENTED,
)
def get_features(map_id: UUID, request: Request, db: DB):
    record = require_map(map_id, request, db)
    points = db.scalars(
        select(PointGeometryRecord)
        .join(PointRecord)
        .where(
            PointGeometryRecord.map_id == record.id,
            PointGeometryRecord.map_revision == record.revision,
            PointRecord.campus_id == record.campus_id,
            PointRecord.status == "published",
            PointRecord.visibility == "public",
        )
    ).all()
    return envelope(
        request,
        MapFeatures(
            map_id=record.id,
            map_revision=record.revision,
            points=[PointGeometry.model_validate(p) for p in points],
        ),
    )


@router.get(
    "/api/v1/maps/{map_id}/tiles/{revision}/{z}/{x}/{y}.png",
    response_class=FileResponse,
    operation_id="getMapTile",
    tags=["maps"],
    responses={
        **ERRORS,
        200: {
            "description": "An authorized PNG tile from the current map revision",
            "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
        },
    },
    openapi_extra=IMPLEMENTED,
)
def get_tile(map_id: UUID, revision: int, z: int, x: int, y: int, request: Request, db: DB):
    record = require_map(map_id, request, db)
    if revision != record.revision or not 0 <= z <= record.max_native_zoom:
        raise DomainError("NOT_FOUND", "地图版本或图块不存在", 404)
    size = record.tile_size * 2 ** (record.max_native_zoom - z)
    if not (
        0 <= x < math.ceil(record.width_px / size) and 0 <= y < math.ceil(record.height_px / size)
    ):
        raise DomainError("NOT_FOUND", "图块不存在", 404)
    root = request.app.state.settings.map_assets_dir.resolve()
    path = (root / record.id / str(revision) / "tiles" / str(z) / str(x) / f"{y}.png").resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise DomainError("MAP_ASSET_UNAVAILABLE", "地图图块暂时不可用", 404)
    # Always re-authorize on the server, including after unpublishing a map.
    return FileResponse(path, media_type="image/png")
