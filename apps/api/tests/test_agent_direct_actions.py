"""Explicit browser commands; upstream replies and campus resources are test fixtures."""

import json
from uuid import uuid4

import pytest
from test_agent_resources import add_experience, add_floor, data
from test_native_agent import enable, turn
from test_navigation import setup_roads

from app.models import GuideSettingsRecord, PanoramaRecord
from app.modules.assistant import explicit_resources


@pytest.fixture
def resources(client, db):
    _, m, points, _ = setup_roads(client, db)
    floor = add_floor(db, points[0], 2, "a")
    vr = PanoramaRecord(
        id=str(uuid4()), point_id=points[1].id, title="测试官方入口",
        url="https://stjgpt.nankai.edu.cn/index-jn.php#scene_test", revision=1,
    )
    db.add(vr)
    db.commit()
    video = add_experience(
        db, points[0], "media", title="校园访谈", media_type="video",
        url="https://nankai.edu.cn/test-video.mp4",
    )
    checkin = add_experience(db, points[0], "checkin", title="测试打卡点")
    tour = add_experience(
        db, points[1], "tour", title="红色校园之旅",
        stops=[{"point_id": points[1].id, "prompt_timing": "manual"}],
    )
    return m, points, {"show_floor": floor, "open_vr": vr, "play_video": video,
                       "show_checkin": checkin, "show_tour": tour}


@pytest.mark.parametrize(
    "query,expected,point_index",
    [
        ("打开图书馆", "focus_point", 0),
        ("帮我定位图书馆", "focus_point", 0),
        ("打开图书馆二楼A区示意图", "show_floor", 0),
        ("打开校园全景地图", "open_vr", 1),
        ("让我看看VR地图", "open_vr", 1),
        ("带我去周恩来雕像", "show_route", 1),
        ("从图书馆到周恩来雕像导航", "show_route", 1),
        ("显示图书馆打卡样图", "show_checkin", 0),
        ("播放校园访谈", "play_video", 0),
        ("开始红色校园之旅", "show_tour", 1),
    ],
)
def test_clear_command_uses_one_verified_action_instead_of_wrong_model_target(
    client, db, resources, query, expected, point_index
):
    m, points, items = resources
    answer = "学校模型回答夹具"
    enable(client, lambda: json.dumps({
        "answer": answer,
        "actions": [{"type": "focus_point", "point_id": points[2].id}],
    }), [])
    reply = data(client, turn(m, points[2], query))
    assert reply["answer"] == answer
    assert len(reply["actions"]) == 1
    action = reply["actions"][0]
    assert reply["automatic_action_id"] == action["action_id"]
    assert action["type"] == expected and action["point_id"] == points[point_index].id
    if expected in items:
        assert action["resource_id"] == items[expected].id
    if expected == "play_video":
        assert any("实际播放以浏览器结果为准" in notice for notice in reply["notices"])
        assert not any("点击确认" in notice for notice in reply["notices"])


def test_plain_school_answer_does_not_prevent_explicit_place_opening(client, db, resources):
    m, points, _ = resources
    enable(client, lambda: "学校模型的纯文字回答", [])
    reply = data(client, turn(m, points[2], "打开图书馆"))
    assert reply["answer"] == "学校模型的纯文字回答"
    assert reply["actions"][0]["point_id"] == points[0].id
    assert reply["automatic_action_id"] == reply["actions"][0]["action_id"]


@pytest.mark.parametrize("query", [
    "不要打开图书馆二楼", "我不想打开图书馆", "不要看视频", "别播放校园访谈",
    "停止导航", "不用打开全景", "不要打开图书馆二楼，谢谢",
])
def test_negative_commands_cannot_be_restored_by_model_actions(client, db, resources, query):
    m, points, items = resources
    enable(client, lambda: json.dumps({
        "answer": "学校模型回答夹具",
        "actions": [{"type": "show_floor", "point_id": points[0].id,
                     "resource_id": items["show_floor"].id, "section": "a"}],
    }), [])
    reply = data(client, turn(m, points[0], query))
    assert reply["actions"] == [] and reply["automatic_action_id"] is None


@pytest.mark.parametrize("query", [
    "怎么打开图书馆二楼", "如何播放校园访谈", "打开图书馆是什么意思",
    "请解释“打开图书馆二楼”", '有人说"打开图书馆二楼"',
    "图书馆有什么视频", "这里有视频吗", "介绍图书馆", "你好",
    "打开图书馆不存在的视频", "打开不存在的参观路线", "打开不存在的地点",
])
def test_information_quoted_or_unknown_target_never_authorizes_automatic_execution(
    client, db, resources, query
):
    m, points, _ = resources
    enable(client, lambda: json.dumps({
        "answer": "学校模型回答夹具",
        "actions": [{"type": "focus_point", "point_id": points[0].id}],
        "automatic_action_id": str(uuid4()),
    }), [])
    reply = data(client, turn(m, points[0], query))
    assert reply["automatic_action_id"] is None
    assert not any("已按你的指令" in notice for notice in reply["notices"])


def test_multiple_or_missing_floor_choices_do_not_auto_execute(client, db, resources):
    m, points, _ = resources
    add_floor(db, points[0], 3)
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], "打开图书馆楼层图"))
    assert len(reply["actions"]) == 2 and reply["automatic_action_id"] is None
    reply = data(client, turn(m, points[0], "打开图书馆九楼"))
    assert reply["actions"] == [] and reply["automatic_action_id"] is None


def test_shared_point_alias_cannot_become_one_automatic_target(client, db, resources):
    m, points, _ = resources
    points[0].aliases = points[1].aliases = ["测试地点"]
    db.commit()
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[2], "打开测试地点"))
    assert len(reply["actions"]) == 2 and reply["automatic_action_id"] is None


def test_multiple_official_portals_require_selection(client, db, resources):
    m, points, _ = resources
    db.add(PanoramaRecord(
        id=str(uuid4()), point_id=points[2].id, title="另一个官方入口",
        url="https://stjgpt.nankai.edu.cn/index-jn.php#scene_another", revision=1,
    ))
    db.commit()
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], "打开校园全景地图"))
    assert len(reply["actions"]) == 2 and reply["automatic_action_id"] is None


@pytest.mark.parametrize("title", ["西侧全景", "校园漫游"])
def test_vr_title_overrides_current_building_instead_of_opening_its_different_vr(
    client, db, resources, title
):
    m, points, items = resources
    items["open_vr"].title = title
    db.add(PanoramaRecord(
        id=str(uuid4()), point_id=points[0].id, title="当前楼的其他全景",
        url="https://nankai.edu.cn/other-vr", revision=1,
    ))
    db.commit()
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], "打开" + title))
    assert [(action["resource_id"], action["point_id"]) for action in reply["actions"]] == [
        (items["open_vr"].id, points[1].id)
    ]
    assert reply["automatic_action_id"] == reply["actions"][0]["action_id"]


def test_repeated_vr_titles_cannot_auto_open_first_match(client, db, resources):
    m, points, items = resources
    items["open_vr"].title = "西侧全景"
    db.add(PanoramaRecord(
        id=str(uuid4()), point_id=points[2].id, title="西侧全景",
        url="https://nankai.edu.cn/another-vr", revision=1,
    ))
    db.commit()
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], "打开西侧全景"))
    assert len(reply["actions"]) == 2 and reply["automatic_action_id"] is None


def test_shared_video_and_vr_title_needs_a_resource_type(client, db, resources):
    m, points, items = resources
    items["open_vr"].title = "校园访谈"
    db.commit()
    enable(client, lambda: "请查看目录", [])
    ambiguous = data(client, turn(m, points[0], "打开校园访谈"))
    assert ambiguous["actions"] == [] and ambiguous["automatic_action_id"] is None
    video = data(client, turn(m, points[0], "播放校园访谈视频"))
    assert video["actions"][0]["resource_id"] == items["play_video"].id
    assert video["automatic_action_id"] == video["actions"][0]["action_id"]
    vr = data(client, turn(m, points[0], "打开校园访谈全景"))
    assert vr["actions"][0]["resource_id"] == items["open_vr"].id
    assert vr["automatic_action_id"] == vr["actions"][0]["action_id"]


def test_multiple_explicit_buildings_do_not_fall_back_to_current_floor(client, db, resources):
    m, points, _ = resources
    add_floor(db, points[2], 2)
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[2], "打开图书馆、周恩来雕像二楼"))
    assert reply["automatic_action_id"] is None
    assert {action["point_id"] for action in reply["actions"]} == {points[0].id, points[1].id}


@pytest.mark.parametrize("query", [
    "打开图书馆的测试官方入口", "播放南门的校园访谈", "打开图书馆红色校园之旅",
])
def test_named_resource_cannot_ignore_an_explicit_conflicting_building(
    client, db, resources, query
):
    m, points, _ = resources
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], query))
    assert reply["actions"] == [] and reply["automatic_action_id"] is None


@pytest.mark.parametrize("kind", ["vr", "media"])
def test_building_name_inside_resource_title_does_not_override_explicit_owner(kind):
    library, gate, item = str(uuid4()), str(uuid4()), str(uuid4())
    title = "图书馆全景" if kind == "vr" else "图书馆访谈"
    directory = [
        {"point_id": library, "name": "图书馆", "aliases": [], "floors": [], "vr": (
            [{"resource_id": item, "title": title}] if kind == "vr" else []
        )},
        {"point_id": gate, "name": "南门", "aliases": [], "floors": [], "vr": []},
    ]
    experiences = [
        {"resource_id": item, "point_id": library, "title": title, "kind": "media"}
    ] if kind == "media" else []
    notices = []
    assert explicit_resources("打开南门的" + title, library, directory, experiences, notices) == []
    assert notices


def test_correction_keeps_positive_resource_choice_without_executing_refused_floor(
    client, db, resources
):
    m, points, _ = resources
    enable(client, lambda: "请查看目录", [])
    reply = data(client, turn(m, points[0], "不要图书馆二楼，打开校园全景地图"))
    assert [action["type"] for action in reply["actions"]] == ["open_vr"]
    assert reply["automatic_action_id"] is None


@pytest.mark.parametrize("change", ["withdraw", "map_revision", "auto_disabled", "action_disabled"])
def test_model_wait_cannot_bypass_current_resource_context_or_policy(
    client, db, resources, change
):
    m, points, items = resources

    def reply_after_change():
        if change == "withdraw":
            items["show_floor"].status = "retired"
        elif change == "map_revision":
            m.revision += 1
        else:
            db.add(GuideSettingsRecord(
                id=1, revision=1, note="测试设置",
                payload={"auto_actions": False} if change == "auto_disabled" else {"allowed_actions": []},
            ))
        db.commit()
        return "学校模型回答夹具"

    enable(client, reply_after_change, [])
    reply = data(client, turn(m, points[0], "打开图书馆二楼A区"))
    assert reply["automatic_action_id"] is None
    if change == "auto_disabled":
        assert len(reply["actions"]) == 1
    else:
        assert reply["actions"] == []
