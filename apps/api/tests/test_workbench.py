"""Regression: resource submissions must be discoverable without visiting each point."""

from uuid import uuid4

from test_admin import BASE, create, login, seed_staff
from test_admin import action as point_action
from test_resources import action, floor_content, make_resource_point, save, upload

from app.models import CampusRecord, PointRecord, ResourceChangeRecord


def exercise_workbench(client, db, tmp_path):
    users, map_info = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "floors"
    first, second = make_resource_point(db), make_resource_point(db)
    first.name, second.name = "甲图书馆", "乙教学楼"
    db.commit()
    login(client)
    vr = action(
        client,
        save(
            client,
            first,
            {
                "kind": "panorama",
                "title": "西厅100%全景",
                "url": "https://example.org/vr#hall",
                "description": "来自经过核对的场景",
            },
        ),
        "submit",
    )
    floor = action(client, save(client, second, floor_content(upload(client, second))), "submit")
    point = point_action(client, create(client, map_info), "submit")
    r = client.get(BASE + "/changes")
    assert r.status_code == 200, r.text
    rows = r.json()["data"]
    assert {item["kind"] for item in rows} == {"point", "floor", "panorama"}
    assert len(rows) == 3 and all(item["is_mine"] and not item["can_review"] for item in rows)
    assert {item["point_id"] for item in rows} == {first.id, second.id, point["point"]["id"]}
    stats = client.get(BASE + "/workbench").json()["data"]
    assert stats["pending_count"] == 3 and stats["my_pending_count"] == 3
    assert stats["pending_by_kind"] == {"point": 1, "floor": 1, "panorama": 1}
    assert stats["draft_count"] == stats["rejected_count"] == 0
    assert (
        client.get(BASE + "/changes", params={"q": "100%"}).json()["meta"]["pagination"]["total"]
        == 1
    )
    assert client.get(BASE + "/changes", params={"q": "_"}).json()["data"] == []
    assert (
        client.get(BASE + "/changes", params={"kind": "floor", "q": "乙"}).json()["data"][0]["id"]
        == floor["id"]
    )
    pages = [
        client.get(BASE + "/changes", params={"page": p, "page_size": 1}).json()
        for p in range(1, 5)
    ]
    assert all(p["meta"]["pagination"]["total"] == 3 for p in pages)
    assert len({p["data"][0]["id"] for p in pages[:3]}) == 3 and not pages[3]["data"]
    assert (
        client.get(BASE + "/resources", params={"q": "西厅", "kind": "panorama"}).json()["data"][0][
            "id"
        ]
        == vr["id"]
    )
    assert (
        client.get(BASE + "/resources", params={"q": "乙教学楼", "kind": "floor"}).json()["data"][
            0
        ]["id"]
        == floor["id"]
    )
    assert not client.get(BASE + "/resources", params={"q": "西厅", "kind": "floor"}).json()["data"]
    login(client, "reviewer")
    assert all(r["can_review"] for r in client.get(BASE + "/changes").json()["data"])
    assert client.get(BASE + "/changes", params={"mine": True}).json()["data"] == []
    published = action(client, vr, "publish")
    action(client, floor, "reject")
    stats = client.get(BASE + "/workbench").json()["data"]
    assert stats["pending_count"] == 1 and stats["rejected_count"] == 1
    done = client.get(BASE + "/changes", params={"state": "published", "kind": "panorama"}).json()[
        "data"
    ]
    assert done[0]["title"] == "西厅100%全景"
    assert client.get(f"/api/v1/points/{first.id}/panoramas").json()["data"][0]["id"] == vr["id"]
    login(client)
    # A retirement request has no payload; its queue title must come from the published record.
    retired = client.post(
        f"{BASE}/resources/{vr['id']}/retire",
        json={
            "expected_revision": published["draft"]["revision"],
            "expected_published_revision": published["published_revision"],
            "note": "待核查场景",
        },
    )
    assert retired.status_code == 200
    listed = client.get(BASE + "/changes", params={"kind": "panorama"}).json()["data"][0]
    assert listed["title"] == "西厅100%全景" and listed["operation"] == "retire"
    return users, first, second, vr


def test_unified_workbench_workflow(client, db, tmp_path):
    exercise_workbench(client, db, tmp_path)


def test_workbench_scope_and_contributors(client, db, tmp_path):
    users, first, second, vr = exercise_workbench(client, db, tmp_path)
    client.cookies.clear()
    users["reviewer"].point_ids = [second.id]
    db.commit()
    login(client, "reviewer")
    assert client.get(BASE + "/changes").json()["data"] == []
    stats = client.get(BASE + "/workbench").json()["data"]
    assert (
        stats["point_count"] == 1 and stats["pending_count"] == 0 and stats["rejected_count"] == 1
    )
    assert client.get(BASE + "/changes", params={"q": "甲"}).json()["data"] == []
    assert client.get(BASE + "/resources", params={"q": "西厅"}).json()["data"] == []
    assert client.get(f"{BASE}/resources/{vr['id']}").status_code == 404
    db.add(CampusRecord(id="another-campus", name="另一个校区"))
    db.add(
        PointRecord(
            id=str(uuid4()),
            campus_id="another-campus",
            name="其他校区点位",
            category="academic",
            aliases=[],
            summary="",
            status="published",
            revision=1,
        )
    )
    users["reviewer"].point_ids = []
    change = db.get(ResourceChangeRecord, vr["id"])
    change.contributor_ids = [*change.contributor_ids, users["reviewer"].id]
    db.commit()
    login(client, "reviewer")
    mine = client.get(BASE + "/changes", params={"mine": True}).json()["data"]
    assert len(mine) == 1 and not mine[0]["can_review"]
    assert client.get(BASE + "/workbench").json()["data"]["point_count"] == 3
    action(
        client, retired := client.get(f"{BASE}/resources/{vr['id']}").json()["data"], "publish", 403
    )
    assert retired["draft"]["state"] == "in_review"
    login(client, "viewer")
    assert all(not r["can_review"] for r in client.get(BASE + "/changes").json()["data"])


def test_workbench_requires_session_and_valid_filters(client, db):
    seed_staff(client, db)
    assert client.get(BASE + "/workbench").status_code == 401
    assert client.get(BASE + "/changes").status_code == 401
    login(client)
    for params in [{"page": 0}, {"page_size": 101}, {"kind": "unknown"}, {"q": "x" * 121}]:
        assert client.get(BASE + "/changes", params=params).status_code == 422
    assert client.get(BASE + "/workbench").json()["data"]["pending_count"] == 0
    assert client.get(BASE + "/changes").json()["data"] == []


def test_audit_filters_find_resource_history_by_point_name(client, db, tmp_path):
    users, first, second, _ = exercise_workbench(client, db, tmp_path)
    rows = client.get(BASE + "/audit", params={"category": "resource", "q": first.name})
    assert rows.status_code == 200, rows.text
    assert rows.json()["data"]
    assert all(
        r["point_id"] == first.id
        and r["point_name"] == first.name
        and r["action"].startswith("resource.")
        for r in rows.json()["data"]
    )
    users["reviewer"].point_ids = [second.id]
    db.commit()
    login(client, "reviewer")
    hidden = client.get(BASE + "/audit", params={"category": "resource", "q": first.name})
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["data"] == []
    assert client.get(BASE + "/audit", params={"q": "%"}).json()["data"] == []
