"""Draft authoring, source binding and geometry; not evidence of real passability."""

import json
from pathlib import Path

from test_admin import login, seed_staff
from test_navigation import publish, route_body, setup_roads

from app.models import MapRecord, NavigationRecord, PointGeometryRecord, PointRecord
from app.modules.navigation import RoadGraph, road_path
from app.modules.road_assist import SEED


def test_curve_route_uses_geometry_and_reverse_preserves_shape(client, db):
    _, m, points, graph = setup_roads(client, db)
    graph["edges"] = [graph["edges"][0], graph["edges"][1]]
    graph["edges"][0]["curve_control"] = {"x": 100, "y": 300}
    publish(client, m.id, graph)
    body = route_body(m, points)
    forward = client.post("/api/v1/navigation/route", json=body).json()["data"]["segments"][0][
        "path"
    ]
    assert len(forward) == 34
    assert forward[16] == {"x": 150, "y": 250}
    body["start_point_id"], body["end_point_id"] = body["end_point_id"], body["start_point_id"]
    reverse = client.post("/api/v1/navigation/route", json=body).json()["data"]["segments"][0][
        "path"
    ]
    assert reverse == list(reversed(forward))


def test_curve_cannot_coexist_with_polyline_or_leave_map(client, db):
    _, m, _, graph = setup_roads(client, db)
    login(client)
    url = f"/api/v1/admin/navigation/{m.id}"
    graph["edges"][0]["curve_control"] = {"x": 100, "y": 200}
    graph["edges"][0]["via"] = [{"x": 150, "y": 200}]
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 422
    graph["edges"][0]["via"] = []
    graph["edges"][0]["curve_control"]["x"] = 2000
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 422


def test_candidates_preview_but_do_not_publish_until_confirmed(client, db):
    _, m, points, graph = setup_roads(client, db)
    login(client)
    graph["nodes"][0]["candidate"] = True
    url = f"/api/v1/admin/navigation/{m.id}"
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 200
    assert client.post(url + "/preview", json=route_body(m, points)).status_code == 200
    r = client.post(
        url + "/review", json={"expected_revision": 1, "action": "submit", "note": "test"}
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "ROAD_NOT_VERIFIED"
    assert client.get(f"/api/v1/navigation/maps/{m.id}").json()["data"]["ready"] is False
    graph["nodes"][0]["candidate"] = False
    assert client.put(url, json={"expected_revision": 1, "graph": graph}).status_code == 200
    assert (
        client.post(
            url + "/review", json={"expected_revision": 2, "action": "submit", "note": "confirmed"}
        ).status_code
        == 200
    )


def test_quality_reports_crossings_gaps_and_components_without_saving(client, db):
    staff, m, _, _ = setup_roads(client, db)
    login(client)
    graph = {
        "map_revision": 1,
        "nodes": [
            {"id": i, "position": {"x": x, "y": y}}
            for i, x, y in [
                ("a", 100, 200),
                ("b", 500, 200),
                ("c", 300, 100),
                ("d", 300, 300),
                ("loose", 110, 205),
            ]
        ],
        "edges": [{"id": "ab", "start": "a", "end": "b"}, {"id": "cd", "start": "c", "end": "d"}],
    }
    url = f"/api/v1/admin/navigation/{m.id}/quality"
    result = client.post(url, json=graph)
    assert result.status_code == 200, result.text
    data = result.json()["data"]
    codes = {i["code"] for i in data["issues"]}
    assert {"CROSSING", "NEAR_GAP", "ISOLATED", "DISCONNECTED", "UNVERIFIED"} <= codes
    assert data["component_count"] == 3 and not data["truncated"]
    assert db.get(NavigationRecord, m.id) is None
    staff["editor"].point_ids = ["limited"]
    db.commit()
    assert client.post(url, json=graph).status_code == 403
    del client.headers["x-csrf-token"]
    assert client.post(url, json=graph).status_code == 403


def test_starter_requires_exact_map_fingerprint_and_is_read_only(client, db):
    users, m = seed_staff(client, db)
    login(client)
    r = client.get(f"/api/v1/admin/navigation/{m.id}/starter")
    assert r.status_code == 200 and r.json()["data"]["available"] is False
    raw = json.loads(SEED.read_text())
    target = raw["map"]
    matching = MapRecord(
        **target,
        campus_id="nku-jinnan",
        title="Jinnan",
        image_asset_id=m.image_asset_id,
        tile_size=512,
        max_native_zoom=5,
        attribution="Fixture",
        status="published",
        visibility="public",
    )
    db.add(matching)
    db.commit()
    # Only one currently public destination is created; missing associations are removed.
    entry = next(n for n in raw["graph"]["nodes"] if n["point_id"])
    point = PointRecord(
        id=entry["point_id"],
        campus_id="nku-jinnan",
        name="Fixture entrance",
        aliases=[],
        category="public_area",
        status="published",
        visibility="public",
        summary="",
    )
    db.add(point)
    db.flush()
    db.add(
        PointGeometryRecord(
            point_id=point.id,
            map_id=matching.id,
            map_revision=3,
            anchor=entry["position"],
            polygon=[],
        )
    )
    db.commit()
    url = f"/api/v1/admin/navigation/{matching.id}/starter"
    result = client.get(url).json()["data"]
    graph = RoadGraph.model_validate(result["graph"])
    assert result["available"] and len(graph.edges) > 200 and len(graph.nodes) > 150
    assert all(not e.verified and e.distance_m is None and e.step_free is None for e in graph.edges)
    assert all(n.candidate for n in graph.nodes if n.point_id)
    assert all(str(n.point_id) == point.id for n in graph.nodes if n.point_id)
    assert result["omitted_point_ids"]
    isolated_ids = {n.id for n in graph.nodes if "地点未公开" in n.label}
    assert all(e.closed for e in graph.edges if e.start in isolated_ids or e.end in isolated_ids)
    assert db.get(NavigationRecord, matching.id) is None
    matching.source_sha256 = "b" * 64
    db.commit()
    assert client.get(url).json()["data"]["available"] is False
    users["editor"].point_ids = [point.id]
    db.commit()
    assert client.get(url).status_code == 403


def test_prepared_graph_reproducible_connected_and_contains_bends():
    import importlib.util

    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "road_builder", root / "scripts/build_road_starter.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = json.loads(SEED.read_text())
    assert module.build() == raw
    graph = RoadGraph.model_validate(raw["graph"])
    import networkx as nx

    g = nx.Graph()
    g.add_edges_from((e.start, e.end) for e in graph.edges)
    assert nx.is_connected(g)
    assert sum(bool(e.via) for e in graph.edges) > 20
    assert len({n.point_id for n in graph.nodes if n.point_id}) >= 45
    assert all(not e.verified for e in graph.edges)
    nodes = {n.id: n for n in graph.nodes}
    for edge in graph.edges:
        assert len(road_path(edge, nodes)) >= 2
        assert all(0 <= p.x <= 8279 and 0 <= p.y <= 5604 for p in road_path(edge, nodes))


def test_dense_diagnostic_is_explicitly_partial(client, db):
    _, m, _, _ = setup_roads(client, db)
    login(client)
    graph = {"map_revision": 1, "nodes": [], "edges": []}
    for i in range(250):
        graph["nodes"].extend(
            [
                {"id": f"a{i}", "position": {"x": 100, "y": 100}},
                {"id": f"b{i}", "position": {"x": 500, "y": 500}},
            ]
        )
        graph["edges"].append(
            {"id": f"e{i}", "start": f"a{i}", "end": f"b{i}", "curve_control": {"x": 500, "y": 100}}
        )
    r = client.post(f"/api/v1/admin/navigation/{m.id}/quality", json=graph)
    assert r.status_code == 200
    assert r.json()["data"]["truncated"] is True
