"""Create a new click-catalog revision using byte-identical existing map tiles."""

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/api"))
from app.modules.maps.import_bundle import MapBundle  # noqa: E402


def build(previous: Path, catalog: Path, output: Path):
    old = MapBundle.model_validate_json((previous / "manifest.json").read_bytes())
    data = json.loads(catalog.read_text())
    data["tile_hashes"] = old.tile_hashes
    new = MapBundle.model_validate(data)
    if output.exists():
        raise ValueError("use a new output directory")
    if new.map.revision <= old.map.revision:
        raise ValueError("catalog revision must increase")
    for key in ["id", "campus_id", "source_sha256", "width_px", "height_px"]:
        if getattr(new.map, key) != getattr(old.map, key):
            raise ValueError("source geometry or checksum changed; original image must be rebuilt")
    for key in ["tile_size", "min_zoom", "max_native_zoom"]:
        if getattr(new.map.tiles, key) != getattr(old.map.tiles, key):
            raise ValueError("tile pyramid parameters changed")
    root = previous.resolve()
    for relative, digest in old.tile_hashes.items():
        file = (root / "tiles" / relative).resolve()
        if not file.is_relative_to(root) or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise ValueError("original tile bundle does not match its checksum")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".map-build-", dir=output.parent))
    try:
        for relative in old.tile_hashes:
            target = stage / "tiles" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / "tiles" / relative, target)
        (stage / "manifest.json").write_text(new.model_dump_json(indent=2) + "\n")
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {
        "map_revision": new.map.revision,
        "points": len(new.points),
        "unchanged_tiles": len(new.tile_hashes),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.previous, args.catalog, args.output)))
