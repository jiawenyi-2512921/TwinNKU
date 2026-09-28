"""Synthetic graphs exercise routing; these fixtures are not campus road data."""

from copy import deepcopy
from uuid import uuid4

import pytest
from test_admin import login, seed_staff

from app.models import NavigationRecord, PointGeometryRecord, PointRecord


def setup_roads(client, db):
    staff, m = seed_staff(client, db)
    points = []
    for name in ["图书馆", "周恩来雕像", "南门"]:
        p = PointRecord(
            id=str(uuid4()),
            campus_id="nku-jinnan",
            name=name,
            aliases=[],
            category="public_area",
            status="published",
            visibility="public",
            summary="测试审核资料",
        )
        db.add(p)
        points.append(p)
    for p in points:
        db.add(
            PointGeometryRecord(
                map_id=m.id,
                point_id=p.id,
                map_revision=m.revision,
                anchor={"x": 100, "y": 100},
                polygon=[{"x": 95, "y": 95}, {"x": 105, "y": 95}, {"x": 100, "y": 105}],
            )
        )
    db.commit()
    graph = {
        "map_revision": 1,
        "note": "测试夹具：入口和道路已核对，不是校园实测数据",
        "nodes": [
            {
                "id": "a",
                "position": {"x": 100, "y": 100},
                "kind": "entrance",
                "point_id": points[0].id,
            },
            {"id": "b", "position": {"x": 300, "y": 300}, "kind": "junction"},
            {
                "id": "c",
                "position": {"x": 500, "y": 100},
                "kind": "entrance",
                "point_id": points[1].id,
            },
            {
                "id": "d",
                "position": {"x": 300, "y": 500},
                "kind": "entrance",
                "point_id": points[2].id,
            },
        ],
        "edges": [
            {
                "id": "ab",
                "start": "a",
                "end": "b",
                "verified": True,
                "evidence": "测试已核实",
                "step_free": True,
            },
            {
                "id": "bc",
                "start": "b",
                "end": "c",
                "verified": True,
                "evidence": "测试已核实",
                "step_free": True,
            },
            {"id": "ad", "start": "a", "end": "d", "verified": True, "evidence": "测试已核实"},
            {"id": "dc", "start": "d", "end": "c", "verified": True, "evidence": "测试已核实"},
        ],
    }
    return staff, m, points, graph


def publish(client, map_id, graph):
    login(client, "editor")
    result = client.put(
        f"/api/v1/admin/navigation/{map_id}", json={"expected_revision": 0, "graph": graph}
    )
    assert result.status_code == 200, result.text
    result = client.post(
        f"/api/v1/admin/navigation/{map_id}/review",
        json={"expected_revision": 1, "action": "submit", "note": "送审测试路网"},
    )
    assert result.status_code == 200, result.text
    login(client, "reviewer")
    result = client.post(
        f"/api/v1/admin/navigation/{map_id}/review",
        json={"expected_revision": 2, "action": "publish", "note": "独立核对"},
    )
    assert result.status_code == 200, result.text


def route_body(m, points):
    return {
        "map_id": m.id,
        "map_revision": m.revision,
        "start_point_id": points[0].id,
        "end_point_id": points[1].id,
    }


def test_draft_review_scope_and_public_route(client, db):
    staff, m, points, graph = setup_roads(client, db)
    assert not client.get(f"/api/v1/navigation/maps/{m.id}").json()["data"]["ready"]
    login(client, "editor")
    url = f"/api/v1/admin/navigation/{m.id}"
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 200
    assert client.post("/api/v1/navigation/route", json=route_body(m, points)).status_code == 409
    assert client.post(url + "/preview", json=route_body(m, points)).status_code == 200
    assert client.put(url, json={"expected_revision": 0, "graph": graph}).status_code == 409
    assert (
        client.post(
            url + "/review", json={"expected_revision": 1, "action": "submit", "note": "核对完成"}
        ).status_code
        == 200
    )
    staff["editor"].role = "reviewer"
    db.commit()
    assert (
        client.post(
            url + "/review", json={"expected_revision": 2, "action": "publish", "note": "尝试自审"}
        ).status_code
        == 403
    )
    login(client, "reviewer")
    assert (
        client.post(
            url + "/review", json={"expected_revision": 2, "action": "publish", "note": "独立审核"}
        ).status_code
        == 200
    )
    result = client.post("/api/v1/navigation/route", json=route_body(m, points))
    assert result.status_code == 200, result.text
    path = result.json()["data"]
    assert len(path["segments"][0]["path"]) == 3
    assert path["segments"][0]["path"][1] == {"x": 300, "y": 300}
    assert path["distance_m"] is None and path["graph_revision"] == 1
    assert client.get("/api/v1/system/status").json()["data"]["capabilities"]["routing"]
    staff["reviewer"].point_ids = [points[0].id]
    db.commit()
    assert client.get(url).status_code == 403


def test_closures_step_free_and_stale_maps(client, db):
    _, m, points, graph = setup_roads(client, db)
    graph["edges"][0]["closed"] = True
    publish(client, m.id, graph)
    path = client.post("/api/v1/navigation/route", json=route_body(m, points)).json()["data"]
    assert path["segments"][0]["path"][1]["y"] == 500
    assert (
        client.post(
            "/api/v1/navigation/route", json={**route_body(m, points), "step_free": True}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/v1/navigation/route", json={**route_body(m, points), "graph_revision": 999}
        ).status_code
        == 409
    )
    m.revision = 2
    db.commit()
    assert not client.get(f"/api/v1/navigation/maps/{m.id}").json()["data"]["ready"]
    assert client.post("/api/v1/navigation/route", json=route_body(m, points)).status_code == 409


def test_one_way_via_and_measured_distance(client, db):
    _, m, points, graph = setup_roads(client, db)
    graph["edges"] = [
        {
            "id": "ac",
            "start": "a",
            "end": "c",
            "bidirectional": False,
            "via": [{"x": 200, "y": 200}],
            "distance_m": 77,
            "verified": True,
            "evidence": "测试测量",
        }
    ]
    publish(client, m.id, graph)
    result = client.post("/api/v1/navigation/route", json=route_body(m, points)).json()["data"]
    assert result["distance_m"] == 77
    assert result["segments"][0]["path"][1] == {"x": 200, "y": 200}
    assert (
        client.post(
            "/api/v1/navigation/route",
            json={
                **route_body(m, points),
                "start_point_id": points[1].id,
                "end_point_id": points[0].id,
            },
        ).status_code
        == 409
    )
    points[1].status = "retired"
    db.commit()
    assert client.post("/api/v1/navigation/route", json=route_body(m, points)).status_code == 404


@pytest.mark.parametrize(
    "change", ["unverified", "no_evidence", "out_of_bounds", "unknown_node", "wrong_entrance"]
)
def test_invalid_graph_cannot_publish(client, db, change):
    _, m, _, graph = setup_roads(client, db)
    candidate = deepcopy(graph)
    if change == "unverified":
        candidate["edges"][0]["verified"] = False
    if change == "no_evidence":
        candidate["edges"][0]["evidence"] = ""
    if change == "out_of_bounds":
        candidate["nodes"][0]["position"]["x"] = 999999
    if change == "unknown_node":
        candidate["edges"][0]["start"] = "missing"
    if change == "wrong_entrance":
        candidate["nodes"][0]["point_id"] = str(uuid4())
    login(client, "editor")
    url = f"/api/v1/admin/navigation/{m.id}"
    result = client.put(url, json={"expected_revision": 0, "graph": candidate})
    if result.status_code == 200:
        assert (
            client.post(
                url + "/review", json={"expected_revision": 1, "action": "submit", "note": "测试"}
            ).status_code
            == 422
        )
    else:
        assert result.status_code == 422
    row = db.get(NavigationRecord, m.id)
    assert not row or not row.published


def test_new_draft_preserves_published_network(client, db):
    _, m, points, graph = setup_roads(client, db)
    publish(client, m.id, graph)
    login(client, "editor")
    graph["edges"] = []
    assert (
        client.put(
            f"/api/v1/admin/navigation/{m.id}", json={"expected_revision": 3, "graph": graph}
        ).status_code
        == 200
    )
    assert client.post("/api/v1/navigation/route", json=route_body(m, points)).status_code == 200
