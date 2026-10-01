"""Requested rename stages only current records, without importing historical geometry."""

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
for name in ("stage_point_introductions", "stage_point_label_corrections"):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
rename = sys.modules["stage_point_label_corrections"]


def fixture():
    image = {"id": rename.MAP_ID, "revision": 3, "source_sha256": rename.MAP_SHA}
    point = {
        "id": rename.POINT_ID,
        "name": "新闻与传播学院",
        "campus_id": "nku-jinnan",
        "aliases": ["团队新增别名"],
        "category": "academic",
        "summary": "新闻与传播学院的已发布介绍。",
        "revision": 12,
    }
    geometry = {
        "map_id": image["id"],
        "map_revision": 3,
        "anchor": {"x": 25, "y": 99},
        "polygon": [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 25, "y": 110}],
        "label_on_map": False,
        "entrance_ids": ["existing-entrance"],
    }
    return {
        "point": point,
        "status": "published",
        "visibility": "public",
        "draft": None,
        "geometries": [geometry],
    }, [image]


def test_rename_preserves_current_geometry_and_revision_with_exact_leading_name_only():
    current, maps = fixture()
    original = copy.deepcopy(current)
    status, payload = rename.prepare_update(current, maps)
    assert status == "ready"
    assert payload["name"] == "信息与传媒学院"
    assert payload["summary"] == "信息与传媒学院的已发布介绍。"
    assert payload["aliases"][0] == "团队新增别名"
    assert payload["geometry"]["anchor"] == current["geometries"][0]["anchor"]
    assert payload["expected_point_revision"] == 12
    assert current == original


def test_rename_respects_new_names_pending_work_and_map_fingerprint():
    current, maps = fixture()
    for value, expected in [("另一个审核后新名称", "name_changed"), (rename.NEW_NAME, "unchanged")]:
        changed = copy.deepcopy(current)
        changed["point"]["name"] = value
        assert rename.prepare_update(changed, maps)[0] == expected
    current["draft"] = {"state": "in_review", "revision": 3}
    assert rename.prepare_update(current, maps)[0] == "pending_draft"
    current["draft"] = None
    maps[0]["source_sha256"] = "another-image"
    assert rename.prepare_update(current, maps)[0] == "stale_map"


def test_preview_is_read_only_and_apply_never_calls_publish():
    current, maps = fixture()

    class API:
        def __init__(self):
            self.calls = []

        def request(self, method, path, payload=None):
            self.calls.append((method, path, payload))
            if method == "GET":
                return copy.deepcopy(current)
            return {"draft": {"revision": 2}}

    api = API()
    assert rename.stage(api, maps)["status"] == "ready"
    assert [method for method, _, _ in api.calls] == ["GET"]
    assert rename.stage(api, maps, apply=True, submit=True)["status"] == "submitted"
    assert [method for method, _, _ in api.calls] == ["GET", "GET", "PUT", "POST"]
    assert all(not path.endswith("/publish") for _, path, _ in api.calls)
