"""Explicit, audited server-side import. No HTTP upload/publish endpoint is exposed."""

import argparse
import hashlib
import json
import math
import re
import shutil
import struct
import tempfile
from pathlib import Path

from pydantic import Field, model_validator

from app.contracts import DTO, MapInfo, Point, PointGeometry
from app.core.config import get_settings
from app.database import SessionLocal
from app.models import CampusRecord, MapImportRecord, MapRecord, PointGeometryRecord, PointRecord


class BundlePoint(DTO):
    point: Point
    geometry: PointGeometry


class MapBundle(DTO):
    schema_version: int = Field(ge=1, le=1)
    map: MapInfo
    source_note: str = Field(min_length=1)
    points: list[BundlePoint] = Field(min_length=1, max_length=500)
    tile_hashes: dict[str, str]

    @model_validator(mode="after")
    def consistent_geometry(self):
        m = self.map
        if m.kind != "campus" or not m.tiles or not m.source_sha256:
            raise ValueError("a campus map, tile metadata and source checksum are required")
        if not re.fullmatch(r"[0-9a-f]{64}", m.source_sha256):
            raise ValueError("invalid source checksum")
        if m.tiles.min_zoom != 0:
            raise ValueError("this importer requires a pyramid starting at zoom 0")
        ids = set()
        for item in self.points:
            p, g = item.point, item.geometry
            if p.id in ids or p.id != g.point_id or p.campus_id != m.campus_id:
                raise ValueError("duplicate or inconsistent point identity")
            ids.add(p.id)
            if g.map_id != m.id or g.map_revision != m.revision or g.entrance_ids:
                raise ValueError("map revision mismatch or unverified navigation entrances")
            if any(v.x > m.width_px or v.y > m.height_px for v in [g.anchor, *g.polygon]):
                raise ValueError("geometry is outside the source image")
            area = sum(
                a.x * b.y - b.x * a.y
                for a, b in zip(g.polygon, g.polygon[1:] + g.polygon[:1], strict=True)
            )
            if abs(area) < 1:
                raise ValueError("degenerate click polygon")
        expected = set()
        for z in range(m.tiles.max_native_zoom + 1):
            edge = m.tiles.tile_size * 2 ** (m.tiles.max_native_zoom - z)
            for x in range(math.ceil(m.width_px / edge)):
                for y in range(math.ceil(m.height_px / edge)):
                    expected.add(f"{z}/{x}/{y}.png")
        if set(self.tile_hashes) != expected:
            raise ValueError("tile pyramid is incomplete or has unexpected paths")
        if any(not re.fullmatch(r"[0-9a-f]{64}", h) for h in self.tile_hashes.values()):
            raise ValueError("invalid tile checksum")
        return self


def import_bundle(
    directory: Path, assets_dir: Path, db, *, reviewer: str, rights_note: str, publish: bool
):
    if not reviewer.strip() or len(reviewer) > 120 or not rights_note.strip():
        raise ValueError("a named reviewer and rights note are required")
    source = directory.resolve()
    raw = (source / "manifest.json").read_bytes()
    bundle = MapBundle.model_validate_json(raw)
    m = bundle.map
    if db.get(CampusRecord, m.campus_id) is None:
        raise ValueError("campus must be seeded before importing")
    for relative, expected_hash in bundle.tile_hashes.items():
        tile = (source / "tiles" / relative).resolve()
        if not tile.is_relative_to(source) or not tile.is_file():
            raise ValueError("missing tile or symlink outside bundle")
        tile_bytes = tile.read_bytes()
        if hashlib.sha256(tile_bytes).hexdigest() != expected_hash:
            raise ValueError(f"tile checksum mismatch: {relative}")
        if (
            tile_bytes[:8] != b"\x89PNG\r\n\x1a\n"
            or len(tile_bytes) < 24
            or struct.unpack(">II", tile_bytes[16:24]) != (m.tiles.tile_size, m.tiles.tile_size)
        ):
            raise ValueError("tiles must be square PNGs, with transparent padding at image edges")

    digest = hashlib.sha256(raw).hexdigest()
    existing = db.get(MapRecord, str(m.id))
    if existing and m.revision < existing.revision:
        raise ValueError("cannot import an older map revision")
    if existing and existing.revision == m.revision:
        review = db.query(MapImportRecord).filter_by(map_id=str(m.id), revision=m.revision).first()
        if review is None or review.manifest_sha256 != digest:
            raise ValueError("map revisions are immutable; increment revision for changes")
    for item in bundle.points:
        old_point = db.get(PointRecord, str(item.point.id))
        if old_point and old_point.campus_id != m.campus_id:
            raise ValueError("point belongs to a different campus")
        if old_point and old_point.revision > item.point.revision:
            raise ValueError("cannot overwrite a newer point revision")
        if old_point and old_point.revision == item.point.revision:
            values = item.point.model_dump(mode="json")
            if any(
                getattr(old_point, key) != values[key]
                for key in ("name", "aliases", "category", "summary")
            ):
                raise ValueError("point revisions are immutable; increment revision for changes")

    destination = assets_dir.resolve() / str(m.id) / str(m.revision)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if (
            not (destination / "manifest.json").is_file()
            or (destination / "manifest.json").read_bytes() != raw
        ):
            raise ValueError("existing asset directory has different immutable content")
        for relative, expected_hash in bundle.tile_hashes.items():
            tile = (destination / "tiles" / relative).resolve()
            if (
                not tile.is_relative_to(destination)
                or not tile.is_file()
                or hashlib.sha256(tile.read_bytes()).hexdigest() != expected_hash
            ):
                raise ValueError("installed map assets are damaged; restore the resource bundle")
    else:
        staging = Path(tempfile.mkdtemp(prefix=".import-", dir=destination.parent))
        try:
            (staging / "manifest.json").write_bytes(raw)
            for relative in bundle.tile_hashes:
                target = staging / "tiles" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / "tiles" / relative, target)
            staging.rename(destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    status = "published" if publish else "draft"
    visibility = "public" if publish else "internal"
    values = m.model_dump(exclude={"tiles", "coordinate_system"}, mode="json")
    values.update(
        tile_size=m.tiles.tile_size,
        max_native_zoom=m.tiles.max_native_zoom,
        status=status,
        visibility=visibility,
    )
    db.merge(MapRecord(**values))
    db.flush()
    for item in bundle.points:
        values = item.point.model_dump()
        values["id"] = str(item.point.id)
        values["category"] = item.point.category.value
        values.update(status=status, visibility=visibility)
        db.merge(PointRecord(**values))
        db.flush()
        geometry = item.geometry.model_dump(mode="json")
        db.merge(PointGeometryRecord(**geometry))
    db.add(
        MapImportRecord(
            map_id=str(m.id),
            revision=m.revision,
            manifest_sha256=digest,
            reviewer=reviewer.strip(),
            rights_note=rights_note.strip(),
            published=publish,
        )
    )
    db.flush()
    return {
        "map_id": str(m.id),
        "revision": m.revision,
        "points": len(bundle.points),
        "status": status,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--rights-note", required=True)
    parser.add_argument(
        "--publish",
        action="store_true",
        help="Explicitly approve the map and its listed point metadata for public API access",
    )
    args = parser.parse_args()
    with SessionLocal.begin() as db:
        result = import_bundle(
            args.directory,
            get_settings().map_assets_dir,
            db,
            reviewer=args.reviewer,
            rights_note=args.rights_note,
            publish=args.publish,
        )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
