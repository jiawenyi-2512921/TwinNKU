"""Real HTTP catalog/action checks; fixtures are not campus content."""

import json
from uuid import uuid4

import pytest
from test_native_agent import enable, turn
from test_navigation import setup_roads

from app.models import FloorRecord, MapRecord, PanoramaRecord
from app.modules.assistant import floor_ordinal


def add_floor(db, point, ordinal, section="main", status="published"):
    m = MapRecord(
        id=str(uuid4()),
        campus_id=point.campus_id,
        title="测试楼层图",
        kind="floor",
        revision=1,
        width_px=100,
        height_px=100,
        image_asset_id=str(uuid4()),
        source_sha256="a" * 64,
        tile_size=256,
        max_native_zoom=1,
        attribution="测试夹具",
        status="published",
        visibility="public",
    )
    db.add(m)
    db.flush()
    floor = FloorRecord(
        id=str(uuid4()),
        point_id=point.id,
        map_id=m.id,
        label=f"{ordinal}层",
        ordinal=ordinal,
        revision=1,
        attribution="测试",
        status=status,
        visibility="public",
        manifest_sha256="a" * 64,
        images=[
            {
                "variant": "labeled",
                "section": section,
                "section_label": section.upper() + "区",
                "width_px": 100,
                "height_px": 100,
                "sha256": "b" * 64,
                "media_type": "image/png",
                "size_bytes": 100,
                "filename": "test.png",
            }
        ],
    )
    db.add(floor)
    db.commit()
    return floor


def without_point(payload):
    payload["context"]["point_id"] = None
    return payload


def data(client, payload):
    response = client.post("/api/v1/agent/chat", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_generic_questions_ground_model_in_current_public_resource_catalog(client, db):
    _, m, points, _ = setup_roads(client, db)
    floor = add_floor(db, points[0], 2, "a")
    private_floor = add_floor(db, points[0], 3, status="draft")
    vr = PanoramaRecord(
        id=str(uuid4()),
        point_id=points[1].id,
        title="测试公开全景",
        url="https://nankai.edu.cn/vr",
        revision=1,
    )
    withdrawn = PanoramaRecord(
        id=str(uuid4()),
        point_id=points[0].id,
        title="测试已撤全景",
        url="https://nankai.edu.cn/old",
        revision=1,
        status="retired",
    )
    db.add_all([vr, withdrawn])
    db.commit()
    calls = []
    enable(client, lambda: "可以从公开目录里选择。", calls)
    reply = data(client, without_point(turn(m, points[0], "有哪些楼层示意图")))
    assert reply["actions"][0]["resource_id"] == floor.id
    prompt = calls[-1][1]["Query"]
    assert floor.id in prompt and vr.id in prompt and '"ordinal": 2' in prompt
    assert '"section": "a"' in prompt
    assert private_floor.id not in prompt and withdrawn.id not in prompt
    vr_reply = data(client, without_point(turn(m, points[0], "我想看VR")))
    assert vr_reply["actions"][0]["resource_id"] == vr.id
    assert vr_reply["actions"][0]["point_id"] == points[1].id


@pytest.mark.parametrize("model_action", ["focus_point", "show_floor", "show_route"])
def test_explicit_floor_overrides_valid_but_wrong_model_action(client, db, model_action):
    _, m, points, _ = setup_roads(client, db)
    wrong = add_floor(db, points[0], 1)
    correct = add_floor(db, points[0], 2, "a")
    enable(
        client,
        lambda: json.dumps(
            {
                "answer": "请查看资料",
                "actions": [
                    {"type": model_action, "point_id": points[0].id, "resource_id": wrong.id}
                ],
            }
        ),
        [],
    )
    reply = data(client, turn(m, points[0], "打开图书馆二楼A区示意图"))
    assert [(a["type"], a["resource_id"], a["section"]) for a in reply["actions"]] == [
        ("show_floor", correct.id, "a")
    ]
    missing = data(client, turn(m, points[0], "打开图书馆七楼示意图"))
    assert missing["actions"] == [] and missing["notices"]


def test_resource_followup_remembers_named_point_but_manual_selection_wins(client, db):
    _, m, points, _ = setup_roads(client, db)
    first = add_floor(db, points[0], 2)
    other = add_floor(db, points[1], 2)
    enable(client, lambda: json.dumps({"answer": "请查看已发布资料", "actions": []}), [])
    data(client, without_point(turn(m, points[0], "介绍图书馆")))
    reply = data(client, without_point(turn(m, points[0], "那它的二楼呢")))
    assert [a["resource_id"] for a in reply["actions"]] == [first.id]
    reply = data(client, turn(m, points[1], "查看二楼"))
    assert [a["resource_id"] for a in reply["actions"]] == [other.id]
    points[0].status = "retired"
    db.commit()
    reply = data(client, without_point(turn(m, points[1], "那它的二楼呢")))
    assert all(a["point_id"] != points[0].id for a in reply["actions"])


def test_resource_retraction_during_model_wait_and_before_click_is_checked(client, db):
    _, m, points, _ = setup_roads(client, db)
    floor = add_floor(db, points[0], 2)
    enable(client, lambda: "请查看楼层", [])
    payload = turn(m, points[0], "打开二楼")
    action = data(client, payload)["actions"][0]
    floor.status = "retired"
    db.commit()
    response = client.post(
        "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
    )
    assert response.status_code == 404
    floor.status = "published"
    db.commit()

    def retire():
        floor.status = "retired"
        db.commit()
        return "请查看楼层"

    enable(client, retire, [])
    result = data(client, turn(m, points[0], "打开二楼"))
    assert result["actions"] == [] and result["notices"]


def test_disabled_resource_modules_do_not_enter_ai_context(client, db):
    _, m, points, _ = setup_roads(client, db)
    floor = add_floor(db, points[0], 2)
    vr = PanoramaRecord(
        id=str(uuid4()),
        point_id=points[0].id,
        title="测试全景",
        url="https://nankai.edu.cn/vr",
        revision=1,
    )
    db.add(vr)
    db.commit()
    calls = []
    enable(client, lambda: "资料入口以网站为准", calls)
    client.app.state.settings.floors_enabled = False
    client.app.state.settings.vr_enabled = False
    result = data(client, without_point(turn(m, points[0], "学校有哪些楼层")))
    assert not result["actions"]
    prompt = calls[-1][1]["Query"]
    assert floor.id not in prompt and vr.id not in prompt


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("十一层", 11),
        ("二十三楼", 23),
        ("地下二层", -2),
        ("B1", -1),
        ("２Ｆ", 2),
        ("两层", 2),
        ("楼层", None),
    ],
)
def test_floor_ordinals(query, expected):
    assert floor_ordinal(query) == expected


def add_experience(db, point, kind, **fields):
    from app.models import ExperienceRecord

    content = {
        "kind": kind,
        "point_id": point.id,
        "title": "测试" + kind,
        "description": "测试已审核资料",
        "source_note": "测试夹具",
        **fields,
    }
    row = ExperienceRecord(
        id=str(uuid4()),
        point_id=point.id,
        kind=kind,
        status="published",
        state="published",
        revision=1,
        published_revision=1,
        published=content,
    )
    db.add(row)
    db.commit()
    return row


@pytest.mark.parametrize(
    ("kind", "action_kind", "query"),
    [
        ("media", "play_video", "图书馆有什么视频"),
        ("checkin", "show_checkin", "图书馆打卡可以看样图吗"),
        ("tour", "show_tour", "有哪些参观路线推荐"),
    ],
)
def test_experience_actions_override_wrong_route_and_revalidate_revision(
    client, db, kind, action_kind, query
):
    _, m, points, _ = setup_roads(client, db)
    extra = (
        {"media_type": "video", "url": "https://nankai.edu.cn/video.mp4"}
        if kind == "media"
        else (
            {
                "stops": [
                    {"point_id": points[0].id, "narrative": "测试讲解", "prompt_timing": "manual"}
                ]
            }
            if kind == "tour"
            else {}
        )
    )
    item = add_experience(db, points[0], kind, **extra)
    calls = []
    enable(
        client,
        lambda: json.dumps(
            {
                "answer": "以下是已发布内容",
                "actions": [{"type": "show_route", "point_id": points[1].id}],
            }
        ),
        calls,
    )
    payload = without_point(turn(m, points[0], query))
    result = data(client, payload)
    assert result["answer"] == "以下是已发布内容"
    action = result["actions"][0]
    assert action["type"] == action_kind and action["resource_id"] == item.id
    assert action["point_id"] == points[0].id and action["resource_revision"] == 1
    assert "experience=" + item.id in action["url"]
    assert item.id in calls[-1][1]["Query"]
    if kind == "media":
        assert "是否观看" in action["label"]
        assert any("不会自动" in notice for notice in result["notices"])
    response = client.post(
        "/api/v1/agent/actions/resolve",
        json={
            "action": {**action, "url": "https://invalid.example/forged"},
            "context": payload["context"],
        },
    )
    assert response.status_code == 200 and response.json()["data"]["url"] == action["url"]
    item.published_revision = 2
    item.revision = 2
    db.commit()
    response = client.post(
        "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "STALE_ACTION"


def test_sample_image_withdrawal_removes_checkin_from_prompt_and_action(client, db):
    _, m, points, _ = setup_roads(client, db)
    image = add_experience(
        db, points[0], "media", media_type="image", url="https://nankai.edu.cn/sample.jpg"
    )
    checkin = add_experience(db, points[0], "checkin", image_id=image.id)
    calls = []
    enable(client, lambda: "可以选择已发布的打卡点", calls)
    payload = turn(m, points[0], "图书馆有什么打卡点")
    action = data(client, payload)["actions"][0]
    assert action["resource_id"] == checkin.id
    image.status = "retired"
    db.commit()
    assert (
        client.post(
            "/api/v1/agent/actions/resolve", json={"action": action, "context": payload["context"]}
        ).status_code
        == 404
    )
    result = data(client, turn(m, points[0], "图书馆的打卡样图呢"))
    assert not result["actions"] and checkin.id not in calls[-1][1]["Query"]


def test_named_video_uses_its_published_anchor_and_generic_tour_is_not_limited_to_view(client, db):
    _, m, points, _ = setup_roads(client, db)
    video = add_experience(
        db,
        points[1],
        "media",
        title="校史访谈",
        media_type="video",
        url="https://nankai.edu.cn/video.mp4",
    )
    tour = add_experience(
        db,
        points[1],
        "tour",
        title="测试主题",
        stops=[{"point_id": points[1].id, "prompt_timing": "manual"}],
    )
    enable(client, lambda: "请查看公开资料", [])
    result = data(client, turn(m, points[0], "看校史访谈视频"))
    assert [a["resource_id"] for a in result["actions"]] == [video.id]
    result = data(client, turn(m, points[0], "推荐一下参观路线"))
    assert [a["resource_id"] for a in result["actions"]] == [tour.id]
