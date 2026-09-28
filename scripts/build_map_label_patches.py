"""Extract original pixels for two explicitly requested map lettering corrections.

Does not modify source images, map bundles, published tiles, point geometry or data.
Requires the user's original planning JPEG; output is a small optional rendering layer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

SOURCE_SHA256 = "756f20fe37317fc33c118b1700c587a59736ec48f2f3ce64da415d629c52eb43"
MAP_SHA256 = "aa5f84fc993dca7371e1d1bf6a5e190925ec2ce5f0d2d4dc968093346028218f"
# Exclusive right/bottom. Compared against public revision-3 tiles, 2026-09-29.
# All changed pixels in these areas are the added (not original) lettering.
PATCHES = {
    "southwest-gate": [1748, 5027, 2001, 5144],
    "media-college": [2194, 3122, 2636, 3233],
}
DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[1] / "apps/web/public/assets/map-labels"
)


def build(source: Path, output: Path):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Source fingerprint differs; do not extract from another map")
    with Image.open(source) as image:
        if image.size != (8279, 5604) or image.mode != "RGB":
            raise ValueError(
                "Unexpected original planning image dimensions or color mode"
            )
        output.mkdir(parents=True, exist_ok=True)
        patches = []
        for key, box in PATCHES.items():
            path = output / f"{key}.png"
            # Source pixel extraction only: no resize, inpainting, recolor or tile overwrite.
            image.crop(box).save(path, format="PNG", optimize=True)
            patches.append(
                {
                    "id": key,
                    "box": box,
                    "file": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
    manifest = {
        "map_id": "eee88cf5-87a0-592e-b1cc-a70674941bbf",
        "map_revision": 3,
        "map_sha256": MAP_SHA256,
        "source_sha256": SOURCE_SHA256,
        "width_px": 8279,
        "height_px": 5604,
        "source_note": "Exact pixels extracted from the user-supplied original planning JPEG. No base tile changes.",
        "patches": patches,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output), ensure_ascii=False))
