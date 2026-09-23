import hashlib
import json
import struct
import zlib
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import CampusRecord, MapImportRecord, MapRecord, PointRecord
from app.modules.maps.import_bundle import MapBundle, import_bundle


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


PNG = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", 512, 512, 8, 0, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress((b"\x00" + b"\xff" * 512) * 512))
    + chunk(b"IEND", b"")
)


@pytest.fixture
def bundle(tmp_path):
    source = tmp_path / "bundle"
    tile = source / "tiles/0/0/0.png"
    tile.parent.mkdir(parents=True)
    tile.write_bytes(PNG)
    m, p, image = str(uuid4()), str(uuid4()), str(uuid4())
    data = {
        "schema_version": 1,
        "map": {
            "id": m,
            "campus_id": "nku-jinnan",
            "title": "Test map",
            "kind": "campus",
            "width_px": 100,
            "height_px": 100,
            "revision": 1,
            "image_asset_id": image,
            "source_sha256": "a" * 64,
            "tiles": {
                "url_template": "unused",
                "tile_size": 512,
                "min_zoom": 0,
                "max_native_zoom": 0,
            },
        },
        "source_note": "Test-only reviewed material",
        "points": [
            {
                "point": {
                    "id": p,
                    "campus_id": "nku-jinnan",
                    "name": "Test library",
                    "aliases": ["Library"],
                    "category": "academic",
                    "summary": "",
                    "revision": 1,
                    "updated_at": "2026-09-23T00:00:00Z",
                },
                "geometry": {
                    "point_id": p,
                    "map_id": m,
                    "map_revision": 1,
                    "anchor": {"x": 25, "y": 25},
                    "polygon": [{"x": 10, "y": 10}, {"x": 80, "y": 10}, {"x": 50, "y": 80}],
                    "entrance_ids": [],
                },
            }
        ],
        "tile_hashes": {"0/0/0.png": hashlib.sha256(PNG).hexdigest()},
    }
    (source / "manifest.json").write_text(json.dumps(data))
    return source, data


def install(bundle, db, client, *, publish=True):
    source, data = bundle
    assets = source.parent / "installed"
    client.app.state.settings.map_assets_dir = assets
    result = import_bundle(
        source, assets, db, reviewer="Test reviewer", rights_note="Test-only", publish=publish
    )
    db.commit()
    return result, data


def test_read_map_features_and_original_tile(client, db, bundle):
    _, data = install(bundle, db, client)
    m = data["map"]["id"]
    assert client.get("/api/v1/system/status").json()["data"]["capabilities"]["map"]
    info = client.get(f"/api/v1/maps/{m}").json()["data"]
    assert info["coordinate_system"] == "image-pixel-top-left"
    assert info["tiles"]["url_template"].endswith("/1/{z}/{x}/{y}.png")
    assert len(client.get(f"/api/v1/maps/{m}/features").json()["data"]["points"]) == 1
    tile = client.get(f"/api/v1/maps/{m}/tiles/1/0/0/0.png")
    assert tile.content == PNG and tile.headers["content-type"] == "image/png"
    assert tile.headers["cache-control"] == "no-store"
    for suffix in ["2/0/0/0.png", "1/9/0/0.png", "1/0/-1/0.png", "1/0/1/0.png"]:
        assert client.get(f"/api/v1/maps/{m}/tiles/{suffix}").status_code == 404


def test_draft_or_disabled_map_cannot_be_read_even_by_direct_tile_url(client, db, bundle):
    _, data = install(bundle, db, client, publish=False)
    m = data["map"]["id"]
    for suffix in ["", "/features", "/tiles/1/0/0/0.png"]:
        assert client.get(f"/api/v1/maps/{m}{suffix}").status_code == 404
    assert client.get("/api/v1/campuses/nku-jinnan/maps").json()["data"] == []
    install(bundle, db, client)
    client.app.state.settings.map_enabled = False
    assert client.get(f"/api/v1/maps/{m}/tiles/1/0/0/0.png").status_code == 404
    assert not client.get("/api/v1/system/status").json()["data"]["capabilities"]["map"]


def test_private_point_and_inactive_campus_never_leak_geometry(client, db, bundle):
    _, data = install(bundle, db, client)
    m = data["map"]["id"]
    db.get(PointRecord, data["points"][0]["point"]["id"]).visibility = "restricted"
    db.commit()
    assert client.get(f"/api/v1/maps/{m}/features").json()["data"]["points"] == []
    db.get(CampusRecord, "nku-jinnan").is_active = False
    db.commit()
    assert client.get(f"/api/v1/maps/{m}/tiles/1/0/0/0.png").status_code == 404


def test_import_checks_bytes_immutability_and_keeps_audit(client, db, bundle):
    source, data = bundle
    install(bundle, db, client)
    install(bundle, db, client)
    assert db.query(MapRecord).count() == 1 and db.query(MapImportRecord).count() == 2
    data["map"]["title"] = "Changed without revision"
    (source / "manifest.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="immutable"):
        install(bundle, db, client)
    (source / "tiles/0/0/0.png").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        install(bundle, db, client)


def test_invalid_map_geometry_and_unsafe_paths_are_rejected(bundle):
    _, data = bundle
    data["points"][0]["geometry"]["anchor"]["x"] = 101
    with pytest.raises(ValidationError):
        MapBundle.model_validate(data)
    data["points"][0]["geometry"]["anchor"]["x"] = 25
    data["points"][0]["geometry"]["map_revision"] = 2
    with pytest.raises(ValidationError):
        MapBundle.model_validate(data)
    data["points"][0]["geometry"]["map_revision"] = 1
    data["tile_hashes"]["../../private.png"] = "b" * 64
    with pytest.raises(ValidationError):
        MapBundle.model_validate(data)


def test_import_cannot_overwrite_newer_or_changed_point_content(client, db, bundle):
    _, data = install(bundle, db, client)
    point = db.get(PointRecord, data["points"][0]["point"]["id"])
    point.revision = 2
    db.commit()
    with pytest.raises(ValueError, match="newer point revision"):
        install(bundle, db, client)
    point.revision = 1
    point.summary = "New reviewed content"
    db.commit()
    with pytest.raises(ValueError, match="point revisions are immutable"):
        install(bundle, db, client)
    assert db.get(PointRecord, point.id).summary == "New reviewed content"


def test_real_catalog_has_no_retracted_points_or_guessed_entrances():
    catalog = json.loads(
        (Path(__file__).resolve().parents[3] / "data/maps/jinnan-v1/catalog.json").read_text()
    )
    assert {p["point"]["name"] for p in catalog["points"]} == {
        "图书馆",
        "南门",
        "公共教学楼",
        "大通学生活动中心",
        "马蹄湖",
    }
    assert all(not p["geometry"]["entrance_ids"] for p in catalog["points"])
    assert (
        catalog["map"]["source_sha256"]
        == "aa5f84fc993dca7371e1d1bf6a5e190925ec2ce5f0d2d4dc968093346028218f"
    )
