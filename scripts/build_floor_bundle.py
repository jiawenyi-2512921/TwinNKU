"""Build a labeled-only floor bundle; never scan or copy a photo directory.

Run with the API environment: uv run python ../../scripts/build_floor_bundle.py INTAKE OUT
Fill labeled_file in a private copy of data/floors/jinnan-v1/intake.json first.
"""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/api"))
from app.modules.floors.import_bundle import FloorBundle, inspect_image  # noqa: E402


def build(intake_path: Path, output: Path, *, partial: bool = False):
    intake = json.loads(intake_path.read_text())
    if output.exists():
        raise ValueError("output already exists; use a new directory")
    floors, copies, missing = [], [], []
    excluded = set(intake.get("excluded_source_numbers", [20])) | {20}
    for building in intake["buildings"]:
        if building["source_number"] in excluded:
            continue
        for row in building["floors"]:
            if not row.get("labeled_file"):
                missing.append(f"{building['name']} {row['label']}")
                continue
            images = []
            for variant in ["labeled"]:
                source = Path(row[f"{variant}_file"])
                if not source.is_absolute():
                    source = intake_path.parent / source
                source = source.resolve()
                metadata = inspect_image(source)
                extension = "png" if metadata["media_type"] == "image/png" else "jpg"
                filename = f"{variant}.{extension}"
                relative = f"{row['id']}/{row['revision']}/{filename}"
                images.append({"variant": variant, "filename": filename, **metadata})
                copies.append((source, relative))
            floors.append(
                {k: row[k] for k in ["id", "map_id", "label", "ordinal", "revision"]}
                | {
                    "point_id": building["point_id"],
                    "images": images,
                    "attribution": "用户整理提供的楼层图；按提交原文件展示。",
                }
            )
    if missing and not partial:
        raise ValueError(
            f"{len(missing)} floors lack a labeled image; no output created: " + ", ".join(missing)
        )
    bundle = FloorBundle(schema_version=1, source_note=intake["source_note"], floors=floors)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".floor-build-", dir=output.parent))
    try:
        for source, relative in copies:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (stage / "manifest.json").write_text(bundle.model_dump_json(indent=2) + "\n")
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {"floors": len(floors), "images": len(copies), "skipped_missing_labeled": missing}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("intake", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--partial", action="store_true", help="Explicitly omit floors missing a labeled image and list them"
    )
    args = parser.parse_args()
    print(json.dumps(build(args.intake, args.output, partial=args.partial), ensure_ascii=False))
