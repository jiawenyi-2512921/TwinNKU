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


def test_floor_pair_preserves_bytes_and_uses_each_images_native_size(db, client, floor_bundle):
    _, f = install(floor_bundle, db, client)
    listed = client.get(f"/api/v1/points/{f['point_id']}/floors").json()["data"]
    assert len(listed) == 1
    floor = client.get(f"/api/v1/floors/{f['id']}").json()["data"]
    assert floor == listed[0] and floor["ordinal"] == 1
    assert {a["variant"] for a in floor["images"]} == {"clean", "labeled"}
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
    for suffix in ["2/clean", "1/original"]:
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
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/clean").status_code == 200
    asset = client.app.state.settings.floor_assets_dir / f["id"] / "1/clean.png"
    asset.unlink()
    asset.symlink_to(floor_bundle[0] / f["id"] / "1/clean.png")
    assert client.get(f"/api/v1/floors/{f['id']}/images/1/clean").status_code == 404


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
