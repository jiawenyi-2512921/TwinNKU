"""Whole HTTP workflows for point/resource/navigation receipt and recovery controls."""

import copy
from importlib import import_module
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select
from test_admin import BASE, login
from test_admin import action as point_action
from test_admin import content as point_content
from test_admin import create as create_point
from test_admin import staff as staff
from test_experiences import content as experience_content
from test_experiences import experiences as experiences
from test_experiences import publish as publish_experience
from test_navigation import publish as publish_navigation
from test_navigation import route_body, setup_roads
from test_resources import action as resource_action
from test_resources import floor_content, image_bytes, upload
from test_resources import resources as resources
from test_resources import save as save_resource

from app.content_control_models import (
    ContentOperationRecord,
    ContentSubmissionRecord,
    ContentVersionRecord,
)
from app.models import Base, NavigationRecord, PointChangeRecord, ResourceChangeRecord


def versions(client, kind, key):
    response = client.get(BASE + f"/content-history?entity_type={kind}&entity_id={key}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def action(client, kind, key, revision, published_revision, verb, expected=200, **values):
    response = client.post(
        BASE + f"/content/{kind}/{key}/{verb}",
        json={
            "expected_revision": revision,
            "expected_published_revision": published_revision,
            "operation_id": str(uuid4()),
            "note": "明确核对并恢复历史内容",
            **values,
        },
    )
    assert response.status_code == expected, response.text
    return response.json().get("data")


def test_point_noop_receipt_withdraw_and_recovery_preserve_public_data(client, db, staff):
    _, m = staff
    login(client)
    payload = point_content(m, operation_id=str(uuid4()))
    first = client.post(BASE + "/points", json=payload)
    replay = client.post(BASE + "/points", json=payload)
    assert (
        first.status_code == replay.status_code == 201
        and first.json()["data"] == replay.json()["data"]
    )
    item = first.json()["data"]
    key, revision = item["point"]["id"], item["draft"]["revision"]
    noop = client.put(
        BASE + f"/points/{key}",
        json={
            **point_content(m),
            "expected_revision": revision,
            "expected_point_revision": item["point"]["revision"],
            "operation_id": str(uuid4()),
        },
    )
    assert noop.status_code == 200 and noop.json()["data"]["draft"]["revision"] == revision
    historical = versions(client, "point", key)[0]
    pending = point_action(client, item, "submit")
    editable = action(client, "point", key, pending["draft"]["revision"], 1, "withdraw")
    edited = client.put(
        BASE + f"/points/{key}",
        json={
            **point_content(m),
            "name": "后来编辑的名称",
            "expected_revision": editable["draft"]["revision"],
            "expected_point_revision": 1,
        },
    ).json()["data"]
    recovered = action(
        client,
        "point",
        key,
        edited["draft"]["revision"],
        1,
        f"history/{historical['id']}/restore-draft",
    )
    assert (
        recovered["draft"]["payload"]["name"] == payload["name"]
        and recovered["draft"]["state"] == "draft"
    )
    assert recovered["draft"]["revision"] == edited["draft"]["revision"] + 1
    assert recovered["point"]["revision"] == 1
    assert action(client, "point", key, recovered["draft"]["revision"], 1, "preflight")["valid"]
    op = client.get(BASE + "/operations/" + payload["operation_id"])
    assert op.status_code == 200 and op.json()["data"]["action"] == "point.save"
    login(client, "reviewer")
    assert client.get(BASE + "/operations/" + payload["operation_id"]).status_code == 404


def test_point_frozen_revision_does_not_authorize_mutated_same_revision_payload(client, db, staff):
    login(client)
    pending = point_action(client, create_point(client, staff[1]), "submit")
    change = db.get(PointChangeRecord, pending["point"]["id"])
    change.payload = {**change.payload, "summary": "未经重新提审的修改"}
    db.commit()
    login(client, "reviewer")
    point_action(client, pending, "publish", expected=409)
    assert db.get(ContentSubmissionRecord, ("point", change.point_id))


def test_floor_history_restores_original_revision_bytes_without_changing_formal_images(
    client, db, resources
):
    _, point = resources
    login(client)
    first = resource_action(
        client, save_resource(client, point, floor_content(upload(client, point))), "submit"
    )
    login(client, "reviewer")
    first = resource_action(client, first, "publish")
    login(client)
    current = copy.deepcopy(first["current"])
    current["label"] = "早期文字与原绿图"
    second = resource_action(
        client, save_resource(client, point, current, first, expected=200), "submit"
    )
    login(client, "reviewer")
    second = resource_action(client, second, "publish")
    login(client)
    original = next(
        v
        for v in versions(client, "floor", first["id"])
        if v["event"] == "publish" and v["published_revision"] == 2
    )
    third = resource_action(
        client,
        save_resource(
            client,
            point,
            floor_content(upload(client, point, image_bytes("blue"))),
            second,
            expected=200,
        ),
        "submit",
    )
    login(client, "reviewer")
    third = resource_action(client, third, "publish")
    public_before = client.get(f"/api/v1/floors/{first['id']}").json()["data"]
    assert client.get(public_before["images"][0]["url"]).content == image_bytes("blue")
    login(client)
    recovered = action(
        client,
        "floor",
        first["id"],
        third["draft"]["revision"],
        3,
        f"history/{original['id']}/restore-draft",
    )
    assert recovered["draft"]["payload"]["content"]["images"][0]["source_revision"] == 2
    assert client.get(recovered["images"][0]["url"]).content == image_bytes()
    assert client.get(public_before["images"][0]["url"]).content == image_bytes("blue")
    pending = resource_action(client, recovered, "submit")
    login(client, "reviewer")
    fourth = resource_action(client, pending, "publish")
    assert fourth["published_revision"] == 4
    now = client.get(f"/api/v1/floors/{first['id']}").json()["data"]
    assert client.get(now["images"][0]["url"]).content == image_bytes()


def test_resource_noop_is_idempotent_and_frozen_contributions_are_checked(client, db, resources):
    _, point = resources
    login(client)
    payload = {
        "content": {
            "kind": "panorama",
            "title": "真实外链测试夹具",
            "url": "https://example.com/vr",
        },
        "source_note": "实际授权来源测试",
        "expected_revision": 0,
        "expected_published_revision": 0,
        "operation_id": str(uuid4()),
    }
    path = BASE + f"/points/{point.id}/resources"
    first, again = client.post(path, json=payload), client.post(path, json=payload)
    assert (
        first.status_code == again.status_code == 201
        and first.json()["data"] == again.json()["data"]
    )
    item = first.json()["data"]
    noop = client.put(
        BASE + f"/resources/{item['id']}",
        json={**payload, "expected_revision": 1, "operation_id": str(uuid4())},
    )
    assert noop.status_code == 200 and noop.json()["data"]["draft"]["revision"] == 1
    pending = resource_action(client, item, "submit")
    change = db.get(ResourceChangeRecord, item["id"])
    change.payload = {**change.payload, "source_note": "未提审的来源修改"}
    db.commit()
    login(client, "reviewer")
    resource_action(client, pending, "publish", expected=409)


def test_reused_floor_byte_provenance_prevents_original_uploader_from_reviewing_metadata(
    client, db, resources
):
    users, point = resources
    login(client)
    original = resource_action(
        client, save_resource(client, point, floor_content(upload(client, point))), "submit"
    )
    login(client, "reviewer")
    original = resource_action(client, original, "publish")
    login(client, "admin")
    metadata = copy.deepcopy(original["current"])
    metadata["label"] = "另一个编辑仅修改名称"
    changed = save_resource(client, point, metadata, original, expected=200)
    assert users["editor"].id in changed["draft"]["contributor_ids"]
    pending = resource_action(client, changed, "submit")
    users["editor"].role = "reviewer"
    db.commit()
    login(client, "editor")
    resource_action(client, pending, "publish", expected=403)
    login(client, "reviewer")
    assert resource_action(client, pending, "publish")["published_revision"] == 2


def test_navigation_public_endpoints_enforce_deployment_hard_disable(client, db):
    _, m, points, graph = setup_roads(client, db)
    publish_navigation(client, m.id, graph)
    assert client.get(f"/api/v1/navigation/maps/{m.id}").json()["data"]["ready"]
    client.app.state.settings.map_enabled = False
    assert not client.get(f"/api/v1/navigation/maps/{m.id}").json()["data"]["ready"]
    response = client.post("/api/v1/navigation/route", json=route_body(m, points))
    assert response.status_code == 503 and response.json()["error"]["code"] == "NAVIGATION_DISABLED"


def test_navigation_receipts_history_restore_and_whole_campus_scope(client, db):
    users, m, _, graph = setup_roads(client, db)
    login(client)
    path = BASE + f"/navigation/{m.id}"
    payload = {
        "expected_revision": 0,
        "expected_published_revision": 0,
        "operation_id": str(uuid4()),
        "graph": graph,
    }
    first = client.put(path, json=payload)
    assert (
        first.status_code == 200
        and client.put(path, json=payload).json()["data"] == first.json()["data"]
    )
    noop = client.put(path, json={**payload, "expected_revision": 1, "operation_id": str(uuid4())})
    assert noop.status_code == 200 and noop.json()["data"]["revision"] == 1
    original = versions(client, "navigation", m.id)[0]
    pending = client.post(
        path + "/review",
        json={
            "expected_revision": 1,
            "expected_published_revision": 0,
            "action": "submit",
            "note": "核对真实路网",
        },
    ).json()["data"]
    row = db.get(NavigationRecord, m.id)
    row.draft = {**row.draft, "note": "未重新提审的篡改"}
    db.commit()
    login(client, "reviewer")
    assert (
        client.post(
            path + "/review",
            json={"expected_revision": pending["revision"], "action": "publish", "note": "审核"},
        ).status_code
        == 409
    )
    login(client)
    editable = action(client, "navigation", m.id, pending["revision"], 0, "withdraw")
    recovered = action(
        client,
        "navigation",
        m.id,
        editable["revision"],
        0,
        f"history/{original['id']}/restore-draft",
    )
    assert recovered["draft"] == first.json()["data"]["draft"] and recovered["published"] is None
    users["editor"].point_ids = [next(n["point_id"] for n in graph["nodes"] if n.get("point_id"))]
    db.commit()
    assert (
        client.get(BASE + f"/content-history?entity_type=navigation&entity_id={m.id}").status_code
        == 403
    )


def test_dependencies_filter_out_of_scope_routes_before_returning_any_count(
    client, db, experiences
):
    users, point, other = experiences
    image = publish_experience(client, experience_content(point))
    visible = publish_experience(
        client,
        experience_content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [
                        {
                            "id": "visible",
                            "resources": [{"type": "image", "id": image["id"], "revision": 1}],
                        }
                    ],
                }
            ],
        ),
    )
    hidden = publish_experience(
        client,
        experience_content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [
                        {
                            "id": "shared",
                            "resources": [{"type": "image", "id": image["id"], "revision": 1}],
                        }
                    ],
                },
                {"point_id": other.id},
            ],
        ),
    )
    users["editor"].point_ids = [point.id]
    db.commit()
    login(client)
    response = client.get(BASE + f"/resources/image/{image['id']}/dependencies")
    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()["data"]} == {visible["id"]}
    assert hidden["id"] not in response.text


def test_content_controls_migration_preserves_pending_content_and_original_floor_history(
    client, db, resources
):
    _, point = resources
    login(client)
    item = resource_action(
        client,
        save_resource(
            client,
            point,
            {
                "kind": "panorama",
                "title": "保留的真实URL",
                "url": "https://example.com/exact?scene=a",
            },
        ),
        "submit",
    )
    db.commit()
    engine = db.get_bind()
    targets = [
        ContentSubmissionRecord.__table__,
        ContentOperationRecord.__table__,
        ContentVersionRecord.__table__,
    ]
    Base.metadata.drop_all(engine, tables=targets)
    with engine.begin() as connection:
        migration = import_module("migrations.versions.0017_content_controls")
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
        snapshot = connection.execute(
            select(ContentVersionRecord.content).where(ContentVersionRecord.entity_type == "vr")
        ).scalar_one()
        assert snapshot["draft"] == db.get(ResourceChangeRecord, item["id"]).payload
        assert snapshot["submitted_by"] == item["draft"]["submitted_by"]
        assert (
            connection.execute(select(ContentSubmissionRecord.entity_id)).scalar_one() == item["id"]
        )
        with Operations.context(context):
            migration.downgrade()
        assert (
            connection.execute(select(ResourceChangeRecord.payload)).scalar_one()
            == snapshot["draft"]
        )
    Base.metadata.create_all(engine, tables=targets)
