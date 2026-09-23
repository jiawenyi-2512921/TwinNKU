from sqlalchemy import select

from app.contracts import Floor, FloorImage
from app.models import CampusRecord, FloorRecord, MapRecord, PointRecord


def public_floors():
    return (
        select(FloorRecord)
        .join(PointRecord, FloorRecord.point_id == PointRecord.id)
        .join(CampusRecord, PointRecord.campus_id == CampusRecord.id)
        .join(MapRecord, FloorRecord.map_id == MapRecord.id)
        .where(
            CampusRecord.is_active.is_(True),
            PointRecord.status == "published",
            PointRecord.visibility == "public",
            FloorRecord.status == "published",
            FloorRecord.visibility == "public",
            MapRecord.status == "published",
            MapRecord.visibility == "public",
            MapRecord.kind == "floor",
            MapRecord.campus_id == PointRecord.campus_id,
            MapRecord.revision == FloorRecord.revision,
        )
    )


def as_floor(record):
    return Floor(
        id=record.id,
        point_id=record.point_id,
        map_id=record.map_id,
        label=record.label,
        ordinal=record.ordinal,
        revision=record.revision,
        attribution=record.attribution,
        images=[
            FloorImage(
                **{k: v for k, v in image.items() if k != "filename"},
                url=f"/api/v1/floors/{record.id}/images/{record.revision}/{image['variant']}",
            )
            for image in record.images
        ],
    )
