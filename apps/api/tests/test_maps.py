import hashlib
import json
import struct
import zlib
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import CampusRecord, FloorRecord, MapImportRecord, MapRecord, PointRecord
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
    assert tile.headers["cache-control"] == "private, no-cache"
    for suffix in ["2/0/0/0.png", "1/9/0/0.png", "1/0/-1/0.png", "1/0/1/0.png"]:
        assert client.get(f"/api/v1/maps/{m}/tiles/{suffix}").status_code == 404


@pytest.mark.parametrize("validator", ["exact", "weak", "list", "wildcard", "repeated"])
def test_tiles_revalidate_without_resending_original_bytes(client, db, bundle, validator):
    _, data = install(bundle, db, client)
    url = f"/api/v1/maps/{data['map']['id']}/tiles/1/0/0/0.png"
    original = client.get(url)
    etag = original.headers["etag"]
    headers = {
        "exact": [("If-None-Match", etag)],
        "weak": [("If-None-Match", f"W/{etag}")],
        "list": [("If-None-Match", f'"unrelated", W/{etag}, "other"')],
        "wildcard": [("If-None-Match", "*")],
        "repeated": [("If-None-Match", '"unrelated"'), ("If-None-Match", etag)],
    }[validator]
    cached = client.get(url, headers=headers)
    assert cached.status_code == 304 and cached.content == b""
    assert cached.headers["cache-control"] == "private, no-cache"
    assert cached.headers["etag"] == etag
    assert cached.headers["last-modified"] == original.headers["last-modified"]
    assert cached.headers["x-content-type-options"] == "nosniff"
    assert cached.headers["x-request-id"] != original.headers["x-request-id"]
    changed = client.get(url, headers={"If-None-Match": '"unrelated"'})
    assert changed.status_code == 200 and changed.content == PNG


@pytest.mark.parametrize(
    "change", ["withdraw", "restricted", "inactive", "disabled", "revision", "missing", "escape"]
)
def test_cached_tiles_recheck_authorization_revision_and_file(client, db, bundle, change):
    _, data = install(bundle, db, client)
    m = data["map"]["id"]
    url = f"/api/v1/maps/{m}/tiles/1/0/0/0.png"
    etag = client.get(url).headers["etag"]
    tile = client.app.state.settings.map_assets_dir / m / "1/tiles/0/0/0.png"
    if change == "withdraw":
        db.get(MapRecord, m).status = "retired"
    elif change == "restricted":
        db.get(MapRecord, m).visibility = "restricted"
    elif change == "inactive":
        db.get(CampusRecord, "nku-jinnan").is_active = False
    elif change == "disabled":
        client.app.state.settings.map_enabled = False
    elif change == "revision":
        db.get(MapRecord, m).revision = 2
    elif change in {"missing", "escape"}:
        tile.unlink()
        if change == "escape":
            tile.symlink_to(bundle[0] / "tiles/0/0/0.png")
    db.commit()
    for validator in (etag, "*"):
        result = client.get(url, headers={"If-None-Match": validator})
        assert result.status_code == 404
        assert result.headers["cache-control"] == "no-store"
        assert "etag" not in result.headers


def test_tile_validator_cannot_bypass_tile_boundaries(client, db, bundle):
    _, data = install(bundle, db, client)
    for suffix in ["2/0/0/0.png", "1/9/0/0.png", "1/0/-1/0.png", "1/0/1/0.png"]:
        result = client.get(
            f"/api/v1/maps/{data['map']['id']}/tiles/{suffix}", headers={"If-None-Match": "*"}
        )
        assert result.status_code == 404 and result.headers["cache-control"] == "no-store"


def test_map_kind_filter_preserves_legacy_listing_and_public_visibility(client, db, bundle):
    _, data = install(bundle, db, client)
    campus_map = db.get(MapRecord, data["map"]["id"])
    floor_map_id, floor_id = str(uuid4()), str(uuid4())
    db.add(MapRecord(
        id=floor_map_id,
        campus_id=campus_map.campus_id,
        title="Test floor",
        kind="floor",
        revision=1,
        width_px=100,
        height_px=100,
        image_asset_id=str(uuid4()),
        source_sha256="b" * 64,
        tile_size=512,
        max_native_zoom=0,
        attribution="Test only",
        status="published",
        visibility="public",
    ))
    db.flush()
    db.add(FloorRecord(
        id=floor_id,
        point_id=data["points"][0]["point"]["id"],
        map_id=floor_map_id,
        label="一层",
        ordinal=1,
        revision=1,
        attribution="Test only",
        status="published",
        visibility="public",
        manifest_sha256="b" * 64,
        images=[],
    ))
    db.commit()
    base = "/api/v1/campuses/nku-jinnan/maps"
    assert {m["id"] for m in client.get(base).json()["data"]} == {campus_map.id, floor_map_id}
    for kind, expected in [("campus", campus_map.id), ("floor", floor_map_id)]:
        result = client.get(base, params={"kind": kind}, headers={"If-None-Match": "*"})
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert [m["id"] for m in result.json()["data"]] == [expected]
    invalid = client.get(base, params={"kind": "unknown"})
    assert invalid.status_code == 422 and invalid.headers["cache-control"] == "no-store"
    db.get(FloorRecord, floor_id).visibility = "restricted"
    db.commit()
    assert client.get(base, params={"kind": "floor"}).json()["data"] == []
    assert [m["id"] for m in client.get(base).json()["data"]] == [campus_map.id]
    client.app.state.settings.map_enabled = False
    assert client.get(base, params={"kind": "campus"}).json()["data"] == []


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
