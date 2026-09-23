"""Generate lossless PNG tiles using ImageMagick. Requires Python 3.12 and convert.

The input PNG is read-only. Highest zoom is cropped at native resolution.
Usage: python scripts/build_map_bundle.py ORIGINAL.png OUTPUT_DIRECTORY
"""

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "data/maps/jinnan-v1/catalog.json").read_text())
    m = manifest["map"]
    digest = hashlib.sha256(args.image.read_bytes()).hexdigest()
    if digest != m["source_sha256"]:
        raise SystemExit("Source image checksum differs from the reviewed map version.")
    metadata = subprocess.check_output(
        ["identify", "-format", "%w %h", str(args.image)], text=True
    ).strip()
    if metadata != f"{m['width_px']} {m['height_px']}":
        raise SystemExit("Source dimensions do not match catalog.")
    if args.output.exists():
        raise SystemExit("Output already exists; choose a new directory.")
    args.output.mkdir(parents=True)
    hashes = {}
    tile_size = m["tiles"]["tile_size"]
    max_zoom = m["tiles"]["max_native_zoom"]
    with tempfile.TemporaryDirectory() as temporary:
        for zoom in range(max_zoom + 1):
            stage = Path(temporary) / str(zoom)
            stage.mkdir()
            width = math.ceil(m["width_px"] / 2 ** (max_zoom - zoom))
            command = ["convert", str(args.image)]
            if zoom < max_zoom:
                command += ["-resize", f"{100 / 2 ** (max_zoom - zoom)}%"]
            # Partial edge tiles need transparent padding to avoid browser stretching.
            command += [
                "-crop",
                f"{tile_size}x{tile_size}",
                "+repage",
                "-background",
                "none",
                "-gravity",
                "northwest",
                "-extent",
                f"{tile_size}x{tile_size}",
                "-depth",
                "8",
                str(stage / "%d.png"),
            ]
            subprocess.run(command, check=True)
            columns = math.ceil(width / tile_size)
            for tile in sorted(stage.glob("*.png"), key=lambda p: int(p.stem)):
                number = int(tile.stem)
                relative = f"{zoom}/{number % columns}/{number // columns}.png"
                destination = args.output / "tiles" / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(tile, destination)
                hashes[relative] = hashlib.sha256(destination.read_bytes()).hexdigest()
            print(f"zoom {zoom}/{max_zoom}: ready", flush=True)
    manifest["tile_hashes"] = hashes
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        f"Map bundle ready: {args.output}; {len(hashes)} tiles. Source pixels were not rewritten."
    )


if __name__ == "__main__":
    main()
