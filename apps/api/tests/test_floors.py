import hashlib
import json
from uuid import uuid4

import pytest
from PIL import Image
from pydantic import ValidationError

from app.models import CampusRecord, FloorImportRecord, FloorRecord, MapRecord, PointRecord
from app.modules.floors.import_bundle import FloorBundle, import_bundle, inspect_image


@pytest.fixture
def floor_bundle(tmp_path, db, client):
    p, f, m = (str(uuid4()) for _ in range(3))
    db.add(
        PointRecord(
            id=p,
            campus_id="nku-jinnan",
            name="测试楼",
            aliases=[],
            category="academic",
            summary="",
            revision=1,
            status="published",
            visibility="public",
        )
    )
    db.commit()
    root = tmp_path / "bundle"
    directory = root / f / "1"
    directory.mkdir(parents=True)
    assets = []
    for variant, size in [("labeled", (240, 160)), ("clean", (300, 200))]:
        path = directory / f"{variant}.png"
        Image.new("RGB", size, "white").save(path)
        assets.append({"variant": variant, "filename": path.name, **inspect_image(path)})
    data = {
        "schema_version": 1,
        "source_note": "Test only",
        "floors": [
            {
                "id": f,
                "point_id": p,
                "map_id": m,
                "label": "一层",
                "ordinal": 1,
                "revision": 1,
                "attribution": "Test fixture",
                "images": assets,
            }
        ],
    }
    (root / "manifest.json").write_text(json.dumps(data))
    client.app.state.settings.floor_assets_dir = tmp_path / "assets"
    return root, data


def install(fixture, db, client, publish=True):
    root, data = fixture
    (root / "manifest.json").write_text(json.dumps(data))
    result = import_bundle(
        root,
        client.app.state.settings.floor_assets_dir,
        db,
        reviewer="Test reviewer",
        rights_note="Disposable test fixture",
        publish=publish,
    )
    db.commit()
    return result, data["floors"][0]


def test_legacy_pair_serves_only_labeled_original_bytes(db, client, floor_bundle):
    _, f = install(floor_bundle, db, client)
    listed = client.get(f"/api/v1/points/{f['point_id']}/floors").json()["data"]
    assert len(listed) == 1
    floor = client.get(f"/api/v1/floors/{f['id']}").json()["data"]
    assert floor == listed[0] and floor["ordinal"] == 1
    assert {a["variant"] for a in floor["images"]} == {"labeled"}
    for image in floor["images"]:
        response = client.get(image["url"])
        original = (floor_bundle[0] / f["id"] / "1" / (image["variant"] + ".png")).read_bytes()
        assert response.content == original
        assert hashlib.sha256(response.content).hexdigest() == image["sha256"]
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-type"] == "image/png"
        assert "filename" not in image
    info = client.get(f"/api/v1/maps/{f['map_id']}").json()["data"]
    assert info["tiles"] is None and info["width_px"] == 240
    assert client.get(f"/api/v1/maps/{f['map_id']}/tiles/1/0/0/0.png").status_code == 404
    assert client.get("/api/v1/system/status").json()["data"]["capabilities"]["floors"]
    for suffix in ["2/labeled", "1/clean", "1/original"]:
        assert client.get(f"/api/v1/floors/{f['id']}/images/{suffix}").status_code in (404, 422)


@pytest.mark.parametrize("hidden", ["floor", "point", "map", "campus", "disabled", "draft"])
def test_private_or_disabled_floor_has_no_image_or_map_metadata_leak(
    db, client, floor_bundle, hidden
):
    _, f = install(floor_bundle, db, client, publish=hidden != "draft")
    if hidden == "floor":
        db.get(FloorRecord, f["id"]).visibility = "restricted"
    if hidden == "point":
        db.get(PointRecord, f["point_id"]).status = "retired"
    if hidden == "map":
        db.get(MapRecord, f["map_id"]).status = "draft"
    if hidden == "campus":
        db.get(CampusRecord, "nku-jinnan").is_active = False
    if hidden == "disabled":
        client.app.state.settings.floors_enabled = False
    db.commit()
    for url in [
        f"/api/v1/floors/{f['id']}",
        f"/api/v1/floors/{f['id']}/images/1/clean",
        f"/api/v1/maps/{f['map_id']}",
        f"/api/v1/maps/{f['map_id']}/features",
    ]:
        assert client.get(url).status_code == 404, url
    result = client.get(f"/api/v1/points/{f['point_id']}/floors")
    assert result.status_code == 404 or result.json()["data"] == []
    assert not client.get("/api/v1/system/status").json()["data"]["capabilities"]["floors"]


def test_images_are_guarded_even_when_parent_module_changes(db, client, floor_bundle):
    _, f = install(floor_bundle, db, client)
    client.app.state.settings.map_enabled = False
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/labeled").status_code == 200
    asset = client.app.state.settings.floor_assets_dir / f["id"] / "1/labeled.png"
    asset.unlink()
    asset.symlink_to(floor_bundle[0] / f["id"] / "1/labeled.png")
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/labeled").status_code == 404


def test_import_is_audited_immutable_and_rejects_extra_photos(db, client, floor_bundle):
    root, data = floor_bundle
    install(floor_bundle, db, client)
    install(floor_bundle, db, client)
    assert db.query(FloorRecord).count() == 1 and db.query(FloorImportRecord).count() == 2
    (root / "original.jpg").write_bytes(b"must never be copied")
    with pytest.raises(ValueError, match="unexpected files"):
        install(floor_bundle, db, client)
    (root / "original.jpg").unlink()
    data["floors"][0]["label"] = "unaudited edit"
    with pytest.raises(ValueError, match="immutable"):
        install(floor_bundle, db, client)


def test_import_rejects_bad_pairs_corruption_and_identity_collisions(db, client, floor_bundle):
    root, data = floor_bundle
    f = data["floors"][0]
    f["images"][1]["variant"] = "original"
    with pytest.raises(ValidationError):
        FloorBundle.model_validate(data)
    f["images"][1]["variant"] = "clean"
    f["images"][1]["filename"] = "../../original.jpg"
    with pytest.raises(ValidationError):
        FloorBundle.model_validate(data)
    f["images"][1]["filename"] = "clean.png"
    path = root / f["id"] / "1/clean.png"
    path.write_bytes(path.read_bytes()[:-20])
    with pytest.raises((ValueError, OSError, SyntaxError)):
        install(floor_bundle, db, client)
    assert db.query(FloorRecord).count() == 0


def test_same_ordinal_cannot_rebind_a_second_floor(db, client, floor_bundle):
    root, data = floor_bundle
    install(floor_bundle, db, client)
    f = data["floors"][0]
    f["id"] = str(uuid4())
    f["map_id"] = str(uuid4())
    with pytest.raises(ValueError, match="ordinal"):
        install(floor_bundle, db, client)


def test_import_rejects_a_single_image_disguised_as_two_variants(db, client, floor_bundle):
    root, data = floor_bundle
    f = data["floors"][0]
    original = root / f["id"] / "1/labeled.png"
    duplicate = root / f["id"] / "1/clean.png"
    duplicate.write_bytes(original.read_bytes())
    f["images"][1] = {"variant": "clean", "filename": "clean.png", **inspect_image(duplicate)}
    with pytest.raises(ValidationError, match="identical image bytes"):
        install(floor_bundle, db, client)
    assert db.query(FloorRecord).count() == 0
    assert not client.app.state.settings.floor_assets_dir.exists()


def test_labeled_only_bundle_imports_without_a_clean_image(db, client, floor_bundle):
    root, data = floor_bundle
    f = data["floors"][0]
    f["images"] = [image for image in f["images"] if image["variant"] == "labeled"]
    (root / f["id"] / "1/clean.png").unlink()
    result, _ = install(floor_bundle, db, client)
    assert result["images"] == 1
    assert len(client.get(f"/api/v1/floors/{f['id']}").json()["data"]["images"]) == 1
    assert (
        client.get(f"/api/v1/floors/{f['id']}/images/1/labeled").content
        == (root / f["id"] / "1/labeled.png").read_bytes()
    )
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/clean").status_code == 404


def test_clean_only_floor_is_rejected(floor_bundle):
    _, data = floor_bundle
    data["floors"][0]["images"] = [data["floors"][0]["images"][1]]
    with pytest.raises(ValidationError, match="labeled image is required"):
        FloorBundle.model_validate(data)


@pytest.mark.parametrize("source_number", [1, 20])
def test_builder_ignores_clean_and_photo_paths(tmp_path, floor_bundle, source_number):
    import importlib.util
    from pathlib import Path

    script = Path(__file__).resolve().parents[3] / "scripts/build_floor_bundle.py"
    spec = importlib.util.spec_from_file_location("floor_builder", script)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source, fixture = floor_bundle
    floor = fixture["floors"][0]
    row = {key: floor[key] for key in ("id", "map_id", "label", "ordinal", "revision")}
    row.update(
        labeled_file=str(source / floor["id"] / "1/labeled.png"),
        clean_file="must-not-be-read.png",
        photo_file="must-not-be-read.jpg",
    )
    intake = tmp_path / "intake.json"
    intake.write_text(
        json.dumps(
            {
                "source_note": "Labeled-only delivery test",
                "buildings": [
                    {
                        "source_number": source_number,
                        "name": "测试楼",
                        "point_id": floor["point_id"],
                        "floors": [row],
                    }
                ],
            }
        )
    )
    output = tmp_path / "labeled-output"
    result = builder.build(intake, output)
    assert result["images"] == 1
    assert sorted(p.name for p in output.rglob("*") if p.is_file()) == [
        "labeled.png",
        "manifest.json",
    ]


def test_sections_are_one_floor_and_serve_their_own_original_bytes(db, client, floor_bundle):
    root, data = floor_bundle
    f = data["floors"][0]
    directory = root / f["id"] / "1"
    (directory / "clean.png").unlink()
    (directory / "labeled.png").rename(directory / "labeled-a.png")
    Image.new("RGB", (310, 170), "blue").save(directory / "labeled-b.png")
    f["images"] = [
        {
            "variant": "labeled",
            "section": section,
            "section_label": section.upper() + "区",
            "filename": f"labeled-{section}.png",
            **inspect_image(directory / f"labeled-{section}.png"),
        }
        for section in ["a", "b"]
    ]
    install(floor_bundle, db, client)
    floors = client.get(f"/api/v1/points/{f['point_id']}/floors").json()["data"]
    assert len(floors) == 1 and len(floors[0]["images"]) == 2
    for image in floors[0]["images"]:
        assert (
            client.get(image["url"]).content
            == (directory / f"labeled-{image['section']}.png").read_bytes()
        )
    url = f"/api/v1/floors/{f['id']}/images/1/labeled"
    assert client.get(url).status_code == 404
    assert client.get(url + "?section=c").status_code == 404
    assert client.get(url + "?section=../a").status_code == 422
    db.get(PointRecord, f["point_id"]).status = "retired"
    db.commit()
    for section in ["a", "b"]:
        assert client.get(url + f"?section={section}").status_code == 404


def test_section_identity_requires_unique_names_and_matching_files(floor_bundle):
    _, data = floor_bundle
    f = data["floors"][0]
    image = f["images"][0]
    image.update(section="a", section_label="A区")
    with pytest.raises(ValidationError, match="filename"):
        FloorBundle.model_validate(data)
    image["filename"] = "labeled-a.png"
    f["images"] = [image, dict(image)]
    with pytest.raises(ValidationError, match="unique"):
        FloorBundle.model_validate(data)
    f["images"] = [image]
    image["section_label"] = " "
    with pytest.raises(ValidationError, match="section label"):
        FloorBundle.model_validate(data)


def test_legacy_revision_digest_is_unchanged_by_optional_section_fields(db, client, floor_bundle):
    _, data = floor_bundle
    normalized = FloorBundle.model_validate(data).floors[0].model_dump(mode="json")
    for asset in normalized["images"]:
        del asset["section"]
        del asset["section_label"]
    old_digest = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    _, f = install(floor_bundle, db, client)
    assert db.get(FloorRecord, f["id"]).manifest_sha256 == old_digest
    assert "section" not in db.get(FloorRecord, f["id"]).images[0]
    install(floor_bundle, db, client)


@pytest.mark.parametrize("orientation", [0, 1])
def test_unspecified_or_upright_jpeg_is_served_byte_identically(
    db, client, floor_bundle, orientation
):
    root, data = floor_bundle
    f = data["floors"][0]
    directory = root / f["id"] / "1"
    for old in directory.iterdir():
        old.unlink()
    path = directory / "labeled.jpg"
    exif = Image.Exif()
    exif[274] = orientation
    Image.new("RGB", (411, 207), "green").save(path, exif=exif)
    original = path.read_bytes()
    f["images"] = [{"variant": "labeled", "filename": path.name, **inspect_image(path)}]
    install(floor_bundle, db, client)
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/labeled").content == original


@pytest.mark.parametrize("orientation", [2, 6, 8, 99])
def test_rotated_or_unknown_orientation_requires_source_review(tmp_path, orientation):
    path = tmp_path / "source.jpg"
    exif = Image.Exif()
    exif[274] = orientation
    Image.new("RGB", (40, 20), "blue").save(path, exif=exif)
    with pytest.raises(ValueError, match="orientation"):
        inspect_image(path)
