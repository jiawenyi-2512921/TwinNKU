"""Prevent source-name, floor-link and withdrawn-point regressions in the map catalog."""

import json
from pathlib import Path

from app.contracts import MapInfo, Point, PointGeometry

ROOT = Path(__file__).resolve().parents[3]


def read(relative):
    return json.loads((ROOT / relative).read_text())


def test_expanded_catalog_preserves_published_points_and_floor_bindings():
    old = read("data/maps/jinnan-v2/catalog.json")
    new = read("data/maps/jinnan-v3/catalog.json")
    by_id = {p["point"]["id"]: p for p in new["points"]}
    assert len(by_id) == len(new["points"]) == 83
    for previous in old["points"]:
        assert by_id[previous["point"]["id"]]["point"] == previous["point"]
    for building in read("data/floors/jinnan-v1/intake.json")["buildings"]:
        assert building["point_id"] in by_id
    assert new["map"]["source_sha256"] == old["map"]["source_sha256"]
    assert new["map"]["revision"] == 3


def test_names_coverage_and_click_areas_remain_explicit():
    catalog = read("data/maps/jinnan-v3/catalog.json")
    coverage = read("data/maps/jinnan-v3/coverage.json")
    info = MapInfo.model_validate(catalog["map"])
    assert coverage["reference_label_count"] == 84
    assert coverage["named_point_count"] == 83
    assert coverage["unnamed_area_count"] == 0
    assert {row["point_id"] for row in coverage["areas"]} == {
        row["point"]["id"] for row in catalog["points"]
    }
    names = {r["point"]["name"] for r in catalog["points"]}
    assert not names.intersection({"未命名建筑", "张伯苓雕像", "严范孙雕像", "学生文化谷"})
    assert {"综合实验楼C区", "综合实验楼D区", "前沿交叉学科中心", "周恩来雕像"} <= names
    for row in catalog["points"]:
        point = Point.model_validate(row["point"])
        geometry = PointGeometry.model_validate(row["geometry"])
        assert geometry.point_id == point.id
        assert geometry.map_id == info.id and geometry.map_revision == info.revision
        assert not geometry.entrance_ids
        for vertex in [geometry.anchor, *geometry.polygon]:
            assert 0 <= vertex.x <= info.width_px and 0 <= vertex.y <= info.height_px


def test_statue_is_between_business_buildings_on_the_central_axis():
    rows = {r["point"]["name"]: r for r in read("data/maps/jinnan-v3/catalog.json")["points"]}
    west, statue, east = [
        rows[n]["geometry"]["anchor"] for n in ["综合业务西楼", "周恩来雕像", "综合业务东楼"]
    ]
    assert west["x"] < statue["x"] < east["x"]
    assert abs(statue["x"] - (west["x"] + east["x"]) / 2) < 1
    assert abs(statue["y"] - (west["y"] + east["y"]) / 2) < 40
    assert rows["周恩来雕像"]["point"]["category"] == "patriotic"
