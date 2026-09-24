"""Verify an entire published floor release against its original manifest.

Uses only Python's standard library. Fails on missing buildings, floors, sections,
stale revisions, metadata drift or changed image bytes. Does not write server data.
"""

import argparse
import hashlib
import json
import urllib.request
from collections import defaultdict
from pathlib import Path


def verify(manifest, read):
    def data(path):
        body, media_type = read(path)
        if media_type != "application/json":
            raise ValueError(f"Expected JSON: {path}")
        payload = json.loads(body)
        if not payload.get("meta", {}).get("request_id") or "data" not in payload:
            raise ValueError(f"Invalid API envelope: {path}")
        return payload["data"]

    if manifest.get("schema_version") != 1 or not manifest.get("floors"):
        raise ValueError("A complete, non-empty floor manifest is required")
    grouped = defaultdict(list)
    for floor in manifest["floors"]:
        grouped[floor["point_id"]].append(floor)
    checked_floors = checked_images = 0
    if not data("/api/v1/system/status")["capabilities"]["floors"]:
        raise ValueError("Floor display is disabled or no floor is published")
    for point_id, expected in grouped.items():
        current = {f["id"]: f for f in data(f"/api/v1/points/{point_id}/floors")}
        for floor in expected:
            actual = current.get(floor["id"])
            if actual is None:
                raise ValueError(f"Missing floor: {point_id} / {floor['label']}")
            for key in ("id", "point_id", "map_id", "label", "ordinal", "revision", "attribution"):
                if actual.get(key) != floor[key]:
                    raise ValueError(f"Floor metadata differs: {floor['id']} / {key}")
            images = {(a["variant"], a.get("section", "main")): a for a in actual["images"]}
            expected_keys = {(a["variant"], a.get("section", "main")) for a in floor["images"]}
            if len(images) != len(actual["images"]) or set(images) != expected_keys:
                raise ValueError(f"Missing, extra or duplicate sections: {floor['id']}")
            for asset in floor["images"]:
                if asset["variant"] != "labeled":
                    raise ValueError("This verifier accepts labeled-only releases")
                served = images[("labeled", asset.get("section", "main"))]
                for key in ("media_type", "width_px", "height_px", "size_bytes", "sha256", "section_label"):
                    if served.get(key) != asset.get(key):
                        raise ValueError(f"Image metadata differs: {floor['id']} / {key}")
                path = served["url"]
                if not path.startswith(f"/api/v1/floors/{floor['id']}/images/"):
                    raise ValueError("Unexpected image URL")
                original, media_type = read(path)
                if (
                    media_type != asset["media_type"]
                    or len(original) != asset["size_bytes"]
                    or hashlib.sha256(original).hexdigest() != asset["sha256"]
                ):
                    raise ValueError(f"Original image differs: {path}")
                checked_images += 1
            checked_floors += 1
    return {"buildings": len(grouped), "floors": checked_floors, "images": checked_images}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="Same-origin HTTPS site, or localhost HTTP")
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    def read(path):
        request = urllib.request.Request(base + path, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read(), response.headers.get_content_type()

    result = verify(json.loads(args.manifest.read_text(encoding="utf-8")), read)
    print("PASS", json.dumps(result, ensure_ascii=False), "— all labeled originals match SHA256")


if __name__ == "__main__":
    main()
