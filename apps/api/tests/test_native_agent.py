import json
from uuid import uuid4

import pytest
from pydantic import SecretStr
from test_admin import login
from test_navigation import setup_roads

from app.integrations.chat_runtime import ChatRuntime
from app.integrations.nk_api import ProbeError
from app.models import PanoramaRecord
from app.modules.assistant import find_mentions

CODE = "test-only-agent-access-code"


def test_alias_ambiguity_and_longer_names_do_not_guess_a_destination(client, db):
    _, _, points, _ = setup_roads(client, db)
    points[0].aliases = ["馆"]
    points[1].aliases = ["图书馆南区"]
    points[2].aliases = ["图书馆南区"]
    directory = {p.id: p for p in points}
    matches, ambiguous = find_mentions(directory, "我要去图书馆南区")
    assert ambiguous and {p.id for p in matches} == {points[1].id, points[2].id}


def test_plain_model_reply_still_resolves_explicit_map_command(client, db):
    _, m, points, _ = setup_roads(client, db)
    enable(client, lambda: "请在地图上查看图书馆", [])
    result = client.post("/api/v1/agent/chat", json=turn(m, points[0]))
    assert result.status_code == 200
    assert result.json()["data"]["actions"][0]["type"] == "focus_point"


def enable(client, reply, calls):
    settings = client.app.state.settings
    settings.nk_genios_api_enabled = True
    settings.nk_genios_api_key = SecretStr("test-only-key")
    settings.agent_access_code = SecretStr(CODE)

    def upstream(endpoint, body, key, timeout):
        calls.append((endpoint, body))
        if endpoint == "create_conversation":
            return {"Conversation": {"AppConversationID": "c-" + body["UserID"]}}
        return {"event": "message", "answer": reply()}

    client.app.state.agent_runtime = ChatRuntime("test-only-key", CODE, upstream)
    client.headers["origin"] = "http://testserver"
    response = client.post("/api/v1/agent/login", json={"code": CODE})
    assert response.status_code == 200
    client.headers["x-csrf-token"] = response.json()["data"]["csrf_token"]


def turn(m, p, query="帮我定位图书馆"):
    return {
        "request_id": str(uuid4()),
        "query": query,
        "context": {
            "campus_id": "nku-jinnan",
            "map_id": m.id,
            "map_revision": m.revision,
            "point_id": p.id,
            "revision": 1,
        },
    }


def test_validated_actions_idempotency_and_no_secret(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(
        client,
        lambda: json.dumps(
            {
                "answer": "请查看图书馆",
                "actions": [{"type": "focus_point", "point_id": points[0].id}],
            }
        ),
        calls,
    )
    payload = turn(m, points[0])
    first = client.post("/api/v1/agent/chat", json=payload)
    assert first.status_code == 200, first.text
    a = first.json()["data"]["actions"][0]
    assert a["point_id"] == points[0].id and a["context_revision"] == 1
    assert "test-only-key" not in first.text
    assert len(calls) == 2
    assert client.post("/api/v1/agent/chat", json=payload).status_code == 200
    assert len(calls) == 2
    assert (
        client.post("/api/v1/agent/chat", json={**payload, "query": "另一个问题"}).status_code
        == 409
    )
    points[0].status = "retired"
    db.commit()
    assert (
        client.post(
            "/api/v1/agent/actions/resolve",
            json={"action": a, "context": {**payload["context"], "point_id": None}},
        ).status_code
        == 404
    )


def test_route_does_not_treat_view_as_real_location(client, db):
    _, m, points, _ = setup_roads(client, db)
    enable(client, lambda: "请告诉我你从哪里出发", [])
    response = client.post("/api/v1/agent/chat", json=turn(m, points[0], "我要去周恩来雕像"))
    a = response.json()["data"]["actions"][0]
    assert (
        a["type"] == "show_route" and a["point_id"] == points[1].id and a["start_point_id"] is None
    )
    response = client.post(
        "/api/v1/agent/chat", json=turn(m, points[0], "从图书馆到周恩来雕像怎么走")
    )
    a = response.json()["data"]["actions"][0]
    assert a["start_point_id"] == points[0].id


def test_vr_id_validation_and_stale_resource(client, db):
    _, m, points, _ = setup_roads(client, db)
    vr = PanoramaRecord(
        id=str(uuid4()),
        point_id=points[0].id,
        title="已审核全景",
        url="https://nankai.edu.cn/vr",
        revision=1,
    )
    db.add(vr)
    db.commit()
    command = {"type": "open_vr", "point_id": points[0].id, "resource_id": vr.id}
    enable(client, lambda: json.dumps({"answer": "可以打开全景", "actions": [command]}), [])
    payload = turn(m, points[0], "打开图书馆全景")
    reply = client.post("/api/v1/agent/chat", json=payload).json()["data"]
    assert len(reply["actions"]) == 1
    action = reply["actions"][0]
    vr.revision = 2
    db.commit()
    assert (
        client.post(
            "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
        ).status_code
        == 409
    )
    command["resource_id"] = str(uuid4())
    # An informational question leaves model suggestions subject to validation;
    # an explicit positioning command would correctly replace the model's VR.
    reply = client.post(
        "/api/v1/agent/chat", json=turn(m, points[0], "请介绍图书馆")
    ).json()["data"]
    assert not reply["actions"] and reply["notices"]


def test_cross_origin_and_csrf_block_upstream(client, db):
    _, m, points, _ = setup_roads(client, db)
    calls = []
    enable(client, lambda: "test", calls)
    payload = turn(m, points[0])
    assert (
        client.post(
            "/api/v1/agent/chat", json=payload, headers={"origin": "https://other.test"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/agent/chat", json=payload, headers={"x-csrf-token": "wrong"}
        ).status_code
        == 403
    )
    assert not calls


def test_failed_upstream_is_not_replayed_and_users_are_isolated():
    calls = []

    def upstream(endpoint, body, key, timeout):
        calls.append(body)
        if endpoint == "create_conversation":
            return {"Conversation": {"AppConversationID": body["UserID"]}}
        raise ProbeError("NETWORK_TIMEOUT")

    runtime = ChatRuntime("fake", CODE, upstream)
    _, a = runtime.login(CODE)
    _, b = runtime.login(CODE)
    assert a.user != b.user and a.csrf != b.csrf
    with pytest.raises(Exception, match="响应超时"):
        runtime.generate(a, "request", {"query": "q"}, "q")
    with pytest.raises(Exception, match="结果不确定"):
        runtime.generate(a, "request", {"query": "q"}, "q")
    assert len(calls) == 2 and b.conversation is None


def test_admin_runtime_controls_are_enforced(client, db):
    _, m, points, _ = setup_roads(client, db)
    enable(
        client,
        lambda: json.dumps(
            {"answer": "你好", "actions": [{"type": "focus_point", "point_id": points[0].id}]}
        ),
        [],
    )
    agent_csrf = client.headers["x-csrf-token"]
    login(client, "editor")
    assert client.get("/api/v1/admin/guide-settings").status_code == 403
    login(client, "admin")
    state = client.get("/api/v1/admin/guide-settings").json()["data"]
    policy = {**state["policy"], "allowed_actions": []}
    assert (
        client.put(
            "/api/v1/admin/guide-settings",
            json={"expected_revision": 0, "policy": policy, "note": "暂时关闭动作"},
        ).status_code
        == 200
    )
    client.headers["x-csrf-token"] = agent_csrf
    result = client.post("/api/v1/agent/chat", json=turn(m, points[0]))
    assert result.status_code == 200 and not result.json()["data"]["actions"]
    login(client, "admin")
    policy["chat_enabled"] = False
    assert (
        client.put(
            "/api/v1/admin/guide-settings",
            json={"expected_revision": 1, "policy": policy, "note": "暂停服务"},
        ).status_code
        == 200
    )
    assert not client.get("/api/v1/agent/web-config").json()["data"]["enabled"]
    client.headers["x-csrf-token"] = agent_csrf
    assert client.post("/api/v1/agent/chat", json=turn(m, points[0])).status_code == 503
