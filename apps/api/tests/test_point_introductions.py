"""Content-only import regression: preserve user geometry and the review boundary."""

import copy
import importlib.util
import json
from pathlib import Path
from uuid import uuid4

import pytest
from test_admin import BASE, login, seed_staff

from app.models import PointGeometryRecord, PointRecord

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "introductions", ROOT / "scripts/stage_point_introductions.py"
)
intro = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intro)
PACK = intro.load_pack(ROOT / "data/introductions/jinnan-20260924.json")


class TestAPI:
    __test__ = False

    def __init__(self, client):
        self.client, self.calls = client, []

    def request(self, method, path, payload=None):
        self.calls.append((method, path))
        r = self.client.request(method, path, json=payload)
        if not r.is_success:
            raise intro.ApiFailure(r.status_code, r.json()["error"]["code"])
        return r.json()["data"]


@pytest.fixture
def published(client, db):
    users, m = seed_staff(client, db)
    entry = copy.deepcopy(PACK["entries"][0])
    p = PointRecord(
        id=entry["point_id"],
        campus_id="nku-jinnan",
        name=entry["expected_name"],
        aliases=["后台新补的别名"],
        category="residence",
        summary="",
        status="published",
        visibility="public",
        revision=17,
    )
    geo = PointGeometryRecord(
        point_id=p.id,
        map_id=m.id,
        map_revision=1,
        anchor={"x": 402, "y": 304},
        polygon=[{"x": 380, "y": 290}, {"x": 490, "y": 298}, {"x": 460, "y": 365}],
        label_on_map=False,
        entrance_ids=[str(uuid4())],
    )
    db.add_all([p, geo])
    db.commit()
    login(client)
    api = TestAPI(client)
    maps = api.request("GET", BASE + "/maps")
    return api, maps, entry, p, geo, users


def test_pack_covers_all_83_ids_without_shipping_historical_geometry():
    catalog = json.loads((ROOT / "data/maps/jinnan-v3/catalog.json").read_text())
    assert {e["point_id"] for e in PACK["entries"]} == {p["point"]["id"] for p in catalog["points"]}
    assert len(PACK["entries"]) == 83
    for entry in PACK["entries"]:
        assert not {"geometry", "anchor", "polygon", "aliases", "category"} & entry.keys()
        assert len(entry["paragraphs"]) >= 2
        assert len(intro.render_summary(PACK, entry)) <= 2000
        if entry["evidence_level"] == "official":
            assert any(PACK["sources"][key]["url"] for key in entry["source_ids"])
    assert (ROOT / "data/introductions/REVIEW.md").read_text() == intro.review_markdown(PACK)


def test_preview_is_read_only_and_publish_preserves_current_map(client, db, published):
    api, maps, entry, p, geo, _ = published
    path = BASE + "/points/" + p.id
    before = api.request("GET", path)
    assert intro.stage_one(api, PACK, entry, maps)["status"] == "ready"
    assert all(method == "GET" for method, _ in api.calls)
    result = intro.stage_one(api, PACK, entry, maps, apply=True, submit=True)
    assert result["status"] == "submitted"
    assert client.get("/api/v1/points/" + p.id).json()["data"]["summary"] == ""
    review = {"expected_revision": result["draft_revision"], "note": "独立核对介绍与来源"}
    assert client.post(path + "/publish", json=review).status_code == 403
    login(client, "reviewer")
    r = client.post(path + "/publish", json=review)
    assert r.status_code == 200, r.text
    after = r.json()["data"]
    assert after["geometries"] == before["geometries"]  # Includes entrance IDs and label setting.
    for key in ("id", "name", "aliases", "category", "campus_id"):
        assert after["point"][key] == before["point"][key]
    assert after["point"]["revision"] == 18
    assert client.get("/api/v1/points/" + p.id).json()["data"]["summary"] == intro.render_summary(
        PACK, entry
    )
    assert intro.stage_one(api, PACK, entry, maps, apply=True)["status"] == "unchanged"


@pytest.mark.parametrize(
    "change,expected",
    [
        ("summary", "existing_summary"),
        ("name", "name_changed"),
        ("status", "not_public"),
        ("draft", "pending_draft"),
        ("geometry", "ambiguous_geometry"),
        ("map", "stale_map"),
    ],
)
def test_manual_work_or_ambiguous_records_are_never_overwritten(published, change, expected):
    api, maps, entry, p, _, _ = published
    current = api.request("GET", BASE + "/points/" + p.id)
    original = copy.deepcopy(current)
    if change == "summary":
        current["point"]["summary"] = "用户刚刚审核的新介绍"
    elif change == "name":
        current["point"]["name"] += "（新名称）"
    elif change == "status":
        current["status"] = "retired"
    elif change == "draft":
        current["draft"] = {"state": "in_review", "revision": 6}
    elif change == "geometry":
        current["geometries"].append(copy.deepcopy(current["geometries"][0]))
    else:
        current["geometries"][0]["map_revision"] += 1
    saved = copy.deepcopy(current)
    status, payload = intro.prepare_update(current, PACK, entry, maps)
    assert status == expected and payload is None
    assert current == saved  # Planning must not mutate the response object.
    assert original["point"]["summary"] == ""


def test_explicit_replace_still_uses_latest_point_and_refuses_pending_draft(published):
    api, maps, entry, p, _, _ = published
    current = api.request("GET", BASE + "/points/" + p.id)
    current["point"]["summary"] = "旧的正式介绍"
    status, payload = intro.prepare_update(current, PACK, entry, maps, replace_existing=True)
    assert status == "ready"
    assert payload["expected_point_revision"] == 17
    current["draft"] = {"state": "rejected", "revision": 6}
    assert intro.prepare_update(current, PACK, entry, maps, True)[0] == "pending_draft"


def test_concurrent_map_edit_is_rejected_without_retry(client, db, published):
    api, maps, entry, p, geo, _ = published
    original_request = api.request

    def concurrent_request(method, path, payload=None):
        if method == "PUT":
            p.revision += 1
            geo.anchor = {"x": 700, "y": 500}
            db.commit()
        return original_request(method, path, payload)

    api.request = concurrent_request
    result = intro.stage_one(api, PACK, entry, maps, apply=True)
    assert result["status"] == "error" and result["http_status"] == 409
    db.refresh(p)
    db.refresh(geo)
    assert p.summary == "" and geo.anchor == {"x": 700, "y": 500}
    assert sum(method == "PUT" for method, _ in api.calls) == 1


def test_viewer_cannot_stage_and_editor_scope_is_enforced(client, db, published):
    api, maps, entry, p, _, users = published
    login(client, "viewer")
    result = intro.stage_one(api, PACK, entry, maps, apply=True)
    assert result["http_status"] == 403
    users["editor"].point_ids = [str(uuid4())]
    db.commit()
    login(client, "editor")
    result = intro.stage_one(api, PACK, entry, maps, apply=True)
    assert result["http_status"] in {403, 404}
    assert result["phase"] == "reading"
    assert p.summary == ""


def test_submit_timeout_is_partial_success_and_does_not_retry(published):
    api, maps, entry, p, _, _ = published
    original_request = api.request

    def lost_response(method, path, payload=None):
        result = original_request(method, path, payload)
        if path.endswith("/submit"):
            raise intro.ApiFailure(0, "TRANSPORT_OR_RESPONSE_ERROR")
        return result

    api.request = lost_response
    result = intro.stage_one(api, PACK, entry, maps, apply=True, submit=True)
    assert result["phase"] == "submitting" and result["check_backend_before_retry"]
    current = original_request("GET", BASE + "/points/" + p.id)
    assert current["draft"]["state"] == "in_review"
    assert sum(path.endswith("/submit") for _, path in api.calls) == 1
    assert intro.stage_one(api, PACK, entry, maps, apply=True)["status"] == "pending_draft"


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.org",
        "https://u:p@example.org",
        "https://example.org/path",
        "https://example.org?x=1",
    ],
)
def test_importer_rejects_unsafe_credential_destinations(origin):
    with pytest.raises(ValueError):
        intro.Client(origin)
    assert (
        intro.NoRedirect().redirect_request(None, None, 307, "", {}, "https://other.test") is None
    )
