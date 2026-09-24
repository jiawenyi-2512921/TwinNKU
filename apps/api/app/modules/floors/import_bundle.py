"""Import reviewed labeled plans; legacy pairs remain readable by the importer."""

import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from PIL import Image
from pydantic import Field, model_validator

from app.contracts import DTO, FLOOR_SECTION_PATTERN, Revision
from app.core.config import get_settings
from app.database import SessionLocal
from app.models import CampusRecord, FloorImportRecord, FloorRecord, MapRecord, PointRecord

MAX_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 40_000_000


class BundleImage(DTO):
    variant: Literal["labeled", "clean"]
    section: str = Field(default="main", pattern=FLOOR_SECTION_PATTERN)
    section_label: str | None = Field(default=None, min_length=1, max_length=64)
    filename: str = Field(pattern=r"^(labeled(-[a-z0-9][a-z0-9_-]{0,31})?|clean)\.(png|jpg)$")
    width_px: int = Field(gt=0, le=20000)
    height_px: int = Field(gt=0, le=20000)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    media_type: Literal["image/png", "image/jpeg"]
    size_bytes: int = Field(gt=0, le=MAX_BYTES)

    @model_validator(mode="after")
    def consistent_file(self):
        extension = "png" if self.media_type == "image/png" else "jpg"
        suffix = "" if self.section == "main" else f"-{self.section}"
        if self.filename != f"{self.variant}{suffix}.{extension}":
            raise ValueError("filename must match the image variant and section")
        if self.section != "main" and (
            self.variant != "labeled" or not (self.section_label or "").strip()
        ):
            raise ValueError("a section requires a labeled image and a section label")
        if self.width_px * self.height_px > MAX_PIXELS:
            raise ValueError("image pixel limit exceeded")
        return self


class BundleFloor(DTO):
    id: UUID
    point_id: UUID
    map_id: UUID
    label: str = Field(min_length=1, max_length=64)
    ordinal: int = Field(ge=-20, le=200)
    revision: Revision
    attribution: str = Field(min_length=1, max_length=2000)
    images: list[BundleImage] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def labeled_required(self):
        identities = [(i.variant, i.section) for i in self.images]
        if not any(i.variant == "labeled" for i in self.images):
            raise ValueError("a labeled image is required")
        if len(set(identities)) != len(identities):
            raise ValueError("image variant and section must be unique")
        clean = next((i for i in self.images if i.variant == "clean"), None)
        if clean:
            main = next(
                (i for i in self.images if i.variant == "labeled" and i.section == "main"), None
            )
            if main is None or clean.sha256 == main.sha256:
                raise ValueError("identical image bytes or missing labeled main image")
        return self


class FloorBundle(DTO):
    schema_version: Literal[1]
    source_note: str = Field(min_length=1, max_length=4000)
    floors: list[BundleFloor] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def unique_identities(self):
        for keys in [
            (f.id for f in self.floors),
            (f.map_id for f in self.floors),
            ((f.point_id, f.ordinal) for f in self.floors),
        ]:
            if len(set(keys)) != len(self.floors):
                raise ValueError("duplicate floor, map or building/floor identity")
        return self


def inspect_image(path: Path):
    """Read and validate; never resize, normalize or save the decoded image."""
    size = path.stat().st_size
    if not 0 < size <= MAX_BYTES:
        raise ValueError("image byte limit exceeded")
    with Image.open(path) as image:
        if image.format not in {"PNG", "JPEG"} or getattr(image, "n_frames", 1) != 1:
            raise ValueError("only static PNG/JPEG images are supported")
        width, height = image.size
        if width * height > MAX_PIXELS or max(width, height) > 20000:
            raise ValueError("image pixel limit exceeded")
        mime = Image.MIME[image.format]
        image.verify()
    with Image.open(path) as image:
        # Some annotation tools write 0 (unspecified); preserve these original bytes.
        if image.getexif().get(274, 1) not in (0, 1):
            raise ValueError("orientation metadata requires explicit source review")
        image.load()  # Reject truncated image data, even if the header is valid.
    return {
        "width_px": width,
        "height_px": height,
        "media_type": mime,
        "size_bytes": size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def contained(path: Path, root: Path):
    resolved = path.resolve()
    if not resolved.is_relative_to(root) or path.is_symlink():
        raise ValueError("asset path escapes bundle or contains a symlink")
    return resolved


def import_bundle(
    directory: Path, assets_dir: Path, db, *, reviewer: str, rights_note: str, publish: bool
):
    if not reviewer.strip() or len(reviewer) > 120 or not rights_note.strip():
        raise ValueError("a named reviewer and rights note are required")
    source, root = directory.resolve(), assets_dir.resolve()
    bundle = FloorBundle.model_validate_json((source / "manifest.json").read_bytes())
    expected_files = {"manifest.json"}
    prepared = []
    # Validate the complete batch before installing any assets or changing database rows.
    for floor in bundle.floors:
        point = db.get(PointRecord, str(floor.point_id))
        if point is None:
            raise ValueError(f"building must be imported first: {floor.point_id}")
        if len(f"{point.name} · {floor.label}") > 120:
            raise ValueError("combined building/floor title exceeds 120 characters")
        campus = db.get(CampusRecord, point.campus_id)
        if publish and (
            point.status != "published" or point.visibility != "public" or not campus.is_active
        ):
            raise ValueError("publish requires a public building in an active campus")
        # New optional fields must not alter immutable legacy revision digests.
        digest = hashlib.sha256(floor.model_dump_json(exclude_defaults=True).encode()).hexdigest()
        old = db.get(FloorRecord, str(floor.id))
        if old and (
            old.point_id != str(floor.point_id)
            or old.map_id != str(floor.map_id)
            or old.ordinal != floor.ordinal
        ):
            raise ValueError("floor identity and building binding are immutable")
        if old and floor.revision < old.revision:
            raise ValueError("cannot overwrite a newer floor revision")
        if old and old.revision == floor.revision and old.manifest_sha256 != digest:
            raise ValueError("floor revisions are immutable; increment revision")
        collision = (
            db.query(FloorRecord)
            .filter_by(point_id=str(floor.point_id), ordinal=floor.ordinal)
            .first()
        )
        if collision and collision.id != str(floor.id):
            raise ValueError("building/floor ordinal is already bound")
        map_record = db.get(MapRecord, str(floor.map_id))
        if map_record and (
            not old
            or map_record.kind != "floor"
            or map_record.campus_id != point.campus_id
            or map_record.revision != old.revision
        ):
            raise ValueError("map identity is already used or inconsistent")
        for asset in floor.images:
            relative = f"{floor.id}/{floor.revision}/{asset.filename}"
            expected_files.add(relative)
            image = contained(source / relative, source)
            actual = inspect_image(image)
            if any(actual[k] != getattr(asset, k) for k in actual):
                raise ValueError(f"image checksum or metadata mismatch: {relative}")
        prepared.append((floor, point, digest))
    actual_files = {p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()}
    if actual_files != expected_files or any(p.is_symlink() for p in source.rglob("*")):
        raise ValueError("unexpected files: source photos and unlisted assets are not permitted")

    root.mkdir(parents=True, exist_ok=True)
    for floor, point, digest in prepared:
        destination = contained(root / str(floor.id) / str(floor.revision), root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            for asset in floor.images:
                path = contained(destination / asset.filename, root)
                if not path.is_file() or inspect_image(path)["sha256"] != asset.sha256:
                    raise ValueError(
                        "installed assets differ; restore the immutable resource bundle"
                    )
        else:
            staging = Path(tempfile.mkdtemp(prefix=".import-", dir=destination.parent))
            try:
                for asset in floor.images:
                    shutil.copyfile(
                        source / str(floor.id) / str(floor.revision) / asset.filename,
                        staging / asset.filename,
                    )
                staging.rename(destination)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        status, visibility = ("published", "public") if publish else ("draft", "internal")
        labeled = next(a for a in floor.images if a.variant == "labeled")
        db.merge(
            MapRecord(
                id=str(floor.map_id),
                campus_id=point.campus_id,
                title=f"{point.name} · {floor.label}",
                kind="floor",
                revision=floor.revision,
                width_px=labeled.width_px,
                height_px=labeled.height_px,
                image_asset_id=str(
                    uuid5(NAMESPACE_URL, f"twinnku:floor:{floor.id}:{floor.revision}:labeled")
                ),
                source_sha256=labeled.sha256,
                tile_size=512,
                max_native_zoom=0,
                attribution=floor.attribution,
                status=status,
                visibility=visibility,
            )
        )
        db.flush()
        values = floor.model_dump(mode="json", exclude_defaults=True)
        db.merge(
            FloorRecord(**values, status=status, visibility=visibility, manifest_sha256=digest)
        )
        db.flush()
        db.add(
            FloorImportRecord(
                floor_id=str(floor.id),
                revision=floor.revision,
                manifest_sha256=digest,
                reviewer=reviewer.strip(),
                rights_note=rights_note.strip(),
                published=publish,
            )
        )
    db.flush()
    return {
        "floors": len(bundle.floors),
        "images": sum(len(f.images) for f in bundle.floors),
        "status": "published" if publish else "draft",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--rights-note", required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    with SessionLocal.begin() as db:
        result = import_bundle(
            args.directory,
            get_settings().floor_assets_dir,
            db,
            reviewer=args.reviewer,
            rights_note=args.rights_note,
            publish=args.publish,
        )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
