"""Anonymous isolation, durable quotas and route/receipt authorization."""

import json
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from test_native_agent import CODE, enable, turn
from test_navigation import setup_roads

from app.core.errors import DomainError
from app.integrations.chat_runtime import ChatRuntime
from app.integrations.public_agent_security import (
    PublicAgentCapability,
    acquire_lease,
    client_ip,
    digest,
    release_lease,
    reserve,
)
from app.models import ExperienceRecord, now_utc


def test_budget_is_atomic_and_shared_by_database_sessions(db):
    with Session(db.get_bind()) as other:
        reserve(db, [("test", 1, 1, 86400)])
        with pytest.raises(DomainError, match="额度"):
            reserve(other, [("test", 1, 1, 86400)])


def test_budget_database_failure_is_closed():
    engine = create_engine("sqlite://")
    with Session(engine) as db:
        with pytest.raises(DomainError) as error:
            reserve(db, [("test", 1, 1, 86400)])
        assert error.value.code == "PUBLIC_BUDGET_UNAVAILABLE"
    engine.dispose()


def test_only_explicit_proxy_can_supply_real_ip():
    cfg = SimpleNamespace(agent_trusted_proxy_ips=["10.0.0.2"])
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(settings=cfg)),
        client=SimpleNamespace(host="203.0.113.4"),
        headers={"x-real-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1"},
    )
    assert client_ip(request) == "203.0.113.4"
    request.client.host = "10.0.0.2"
    assert client_ip(request) == "8.8.8.8"
    request.headers["x-real-ip"] = "8.8.8.8, 1.1.1.1"
    with pytest.raises(DomainError):
        client_ip(request)


def test_model_concurrency_is_shared_across_runtime_instances(client, db):
    request = SimpleNamespace(app=client.app, client=SimpleNamespace(host="testclient"), headers={})
    client.app.state.settings.agent_model_concurrency = 1
    lease = acquire_lease(db, request, "visitor-one", "model")
    with Session(db.get_bind()) as other:
        with pytest.raises(DomainError) as error:
            acquire_lease(other, request, "visitor-two", "model")
        assert error.value.code == "SERVICE_BUSY"
    release_lease(db, lease)
    next_lease = acquire_lease(db, request, "visitor-two", "model")
    release_lease(db, next_lease)


def test_conversation_and_request_id_survive_runtime_restart(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(client, lambda: "校园公开资料回答", calls)
    payload = turn(m, points[0], "请介绍这里")
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 200
    assert len(calls) == 2
    upstream = client.app.state.agent_runtime.upstream
    client.app.state.agent_runtime = ChatRuntime("test-only-key", CODE, upstream)
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 200
    assert len(calls) == 2
    assert (
        client.post("/api/v1/agent/chat", json=turn(m, points[0], "进一步介绍")).status_code == 200
    )
    assert len(calls) == 3
    assert calls[-1][1]["AppConversationID"] == calls[1][1]["AppConversationID"]


def test_arbitrary_action_or_other_session_action_is_denied(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(client, lambda: "请在地图查看", calls)
    payload = turn(m, points[0])
    reply = client.post("/api/v1/agent/chat", json=payload).json()["data"]
    action = reply["actions"][0]
    modified = {**action, "action_id": str(uuid4())}
    assert (
        client.post(
            "/api/v1/agent/actions/resolve",
            json={"action": modified, "context": payload["context"]},
        ).status_code
        == 403
    )
    client.cookies.clear()
    enable(client, lambda: "other", [])
    assert (
        client.post(
            "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
        ).status_code
        == 403
    )


def test_fake_receipt_is_rejected_before_supplier(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(client, lambda: "answer", calls)
    payload = turn(m, points[0])
    payload["action_receipts"] = [
        {"action_id": str(uuid4()), "context_revision": 1, "result": "opened"}
    ]
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 403
    assert not calls


def test_receipt_cannot_claim_video_playback_for_map_action(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(client, lambda: "answer", calls)
    payload = turn(m, points[0])
    action = client.post("/api/v1/agent/chat", json=payload).json()["data"]["actions"][0]
    next_turn = turn(m, points[0], "刚刚发生了什么")
    next_turn["action_receipts"] = [
        {"action_id": action["action_id"], "context_revision": 1, "result": "playing"}
    ]
    assert client.post("/api/v1/agent/chat", json=next_turn).status_code == 403
    assert len(calls) == 2


def test_expired_action_is_not_refreshed_by_replay(client, db):
    _, m, points, _ = setup_roads(client, db)
    enable(client, lambda: "answer", [])
    payload = turn(m, points[0])
    action = client.post("/api/v1/agent/chat", json=payload).json()["data"]["actions"][0]
    record = db.get(PublicAgentCapability, digest(action["action_id"]))
    record.expires_at = now_utc() - timedelta(seconds=1)
    db.commit()
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 200
    assert (
        client.post(
            "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
        ).status_code
        == 403
    )


def published_tour(db, points, count=30):
    content = {
        "kind": "tour",
        "campus_id": "nku-jinnan",
        "title": "后台路线",
        "description": "",
        "source_note": "公开史料",
        "stops": [],
    }
    for index in range(count):
        content["stops"].append(
            {
                "point_id": points[0].id,
                "segments": [
                    {
                        "id": f"segment-{index}",
                        "text": "完整段落开始" + "正文" * 600 + "完整段落结尾",
                        "source_note": "官方公开资料",
                        "main_view": {"type": "map"},
                        "resources": [],
                    }
                ],
            }
        )
    record = ExperienceRecord(
        id=str(uuid4()),
        campus_id="nku-jinnan",
        point_id=None,
        kind="tour",
        revision=1,
        published_revision=1,
        state="published",
        status="published",
        published=content,
    )
    db.add(record)
    db.commit()
    return record


def test_chosen_segment_after_station_24_has_complete_text_and_outline(client, db):
    _, m, points, _ = setup_roads(client, db)
    route = published_tour(db, points)
    calls = []
    enable(client, lambda: "基于当前段落回答", calls)
    payload = turn(m, points[0], "请介绍导览当前段落")
    payload["context"]["visit"] = {
        "tour_id": route.id,
        "tour_revision": 1,
        "stop_index": 27,
        "segment_id": "segment-27",
    }
    response = client.post("/api/v1/agent/chat", json=payload)
    assert response.status_code == 200, response.text
    prompt = calls[-1][1]["Query"]
    data = json.loads(prompt.split("应用提供的数据：", 1)[1].split("\n用户问题：", 1)[0])
    assert data["visit"]["text"].endswith("完整段落结尾")
    assert len(data["visit"]["text"]) > 500
    assert len(data["visit"]["outline"]) == 30


def test_tour_context_stale_or_wrong_segment_denied_before_supplier(client, db):
    _, m, points, _ = setup_roads(client, db)
    route = published_tour(db, points, 1)
    calls = []
    enable(client, lambda: "answer", calls)
    payload = turn(m, points[0])
    payload["context"]["visit"] = {
        "tour_id": route.id,
        "tour_revision": 2,
        "stop_index": 0,
        "segment_id": "segment-0",
    }
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 409
    payload["context"]["visit"]["tour_revision"] = 1
    payload["context"]["visit"]["segment_id"] = "unknown"
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 409
    assert not calls


def test_public_tour_voice_manifest_uses_only_published_text(client, db):
    _, _, points, _ = setup_roads(client, db)
    route = published_tour(db, points, 1)
    enable(client, lambda: "answer", [])
    response = client.post(
        "/api/v1/voice/prepare",
        json={
            "source": {
                "kind": "tour_segment",
                "tour_id": route.id,
                "tour_revision": 1,
                "stop_index": 0,
                "segment_id": "segment-0",
            }
        },
    )
    assert response.status_code == 200, response.text
    manifest = response.json()["data"]
    assert "".join(manifest["chunks"]).endswith("完整段落结尾")
    assert all(len(chunk) <= 300 for chunk in manifest["chunks"])
    assert len(manifest["chunks"][0]) <= 80
