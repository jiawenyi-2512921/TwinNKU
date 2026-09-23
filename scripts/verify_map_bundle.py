"""Read-only asset QA. Requires Pillow; never modifies source images or tiles."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.bundle / "manifest.json").read_text())
    meta = manifest["map"]
    assert hashlib.sha256(args.image.read_bytes()).hexdigest() == meta["source_sha256"]
    with Image.open(args.image) as original:
        assert original.size == (meta["width_px"], meta["height_px"])
        original = original.convert("RGB")
        native_count = 0
        for relative, checksum in manifest["tile_hashes"].items():
            path = args.bundle / "tiles" / relative
            assert hashlib.sha256(path.read_bytes()).hexdigest() == checksum, relative
            with Image.open(path) as tile:
                size = meta["tiles"]["tile_size"]
                assert tile.size == (size, size), f"unpadded edge tile: {relative}"
                z, x, y = map(int, relative.removesuffix(".png").split("/"))
                if z != meta["tiles"]["max_native_zoom"]:
                    continue
                w, h = min(size, original.width - x * size), min(size, original.height - y * size)
                source = original.crop((x * size, y * size, x * size + w, y * size + h))
                assert source.tobytes() == tile.crop((0, 0, w, h)).convert("RGB").tobytes(), (
                    relative
                )
                if w < size or h < size:
                    alpha = tile.convert("RGBA").getchannel("A")
                    if w < size:
                        assert alpha.crop((w, 0, size, size)).getextrema() == (0, 0)
                    if h < size:
                        assert alpha.crop((0, h, size, size)).getextrema() == (0, 0)
                native_count += 1
    print(
        json.dumps(
            {
                "tiles": len(manifest["tile_hashes"]),
                "native_tiles_verified": native_count,
                "native_pixels_identical": True,
                "edges_padded": True,
                "dimensions": [meta["width_px"], meta["height_px"]],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
