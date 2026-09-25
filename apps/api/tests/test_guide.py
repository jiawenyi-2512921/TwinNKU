import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
from pydantic import SecretStr, ValidationError
from test_api import add_point
from test_floors import floor_bundle as floor_bundle
from test_floors import install

from app.core.config import Settings
from app.models import CampusRecord, MapRecord, PanoramaRecord, PointRecord

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from export_nk_genios_knowledge import export  # noqa: E402
from export_nk_genios_plugin import OPERATIONS, build, references  # noqa: E402


def test_public_embed_config_never_returns_server_credentials(client):
    settings = client.app.state.settings
    settings.nk_genios_api_key = SecretStr("server-api-token-must-not-appear")
    settings.nk_genios_web_app_key = SecretStr("public-embed-fixture")
    result = client.get("/api/v1/agent/web-config")
    assert result.json()["data"]["enabled"] is False
    assert result.json()["data"]["app_key"] is None
    assert "server-api-token" not in result.text
    settings.nk_genios_web_enabled = True
    result = client.get("/api/v1/agent/web-config")
    assert result.json()["data"]["app_key"] == "public-embed-fixture"
    assert "server-api-token" not in result.text
    assert result.headers["cache-control"] == "no-store"
    status = client.get("/api/v1/system/status").json()["data"]["capabilities"]
    assert status["chat_embed"] and not status["chat"]
    assert client.post("/api/v1/chat/sessions", json={}).status_code == 404


@pytest.mark.parametrize(
    "origin",
    [
        "http://x.test",
        "https://x.test/path",
        "https://u:p@x.test",
        "https://x.test/?q=a",
        "https://x.test#fragment",
        "https://x.test:8443",
    ],
)
def test_public_origin_rejects_unsafe_values(origin):
    with pytest.raises(ValidationError):
        Settings(public_site_origin=origin)


def test_embed_requires_explicit_public_key():
    with pytest.raises(ValidationError):
        Settings(nk_genios_web_enabled=True)
    with pytest.raises(ValidationError):
        Settings(nk_genios_web_enabled=True, nk_genios_web_app_key="a<script>alert(1)</script>")
    assert not Settings(nk_genios_web_app_key="").web_agent_configured


def test_guide_links_reuse_existing_published_resources(client, db, floor_bundle):
    _, floor = install(floor_bundle, db, client)
    p = floor["point_id"]
    panorama_id = str(uuid4())
    db.add(
        PanoramaRecord(
            id=panorama_id, point_id=p, title="测试全景", url="https://nankai.edu.cn/vr", revision=2
        )
    )
    db.add(
        PanoramaRecord(
            id=str(uuid4()),
            point_id=p,
            title="下架资料",
            url="https://nankai.edu.cn/retired",
            revision=1,
            status="retired",
        )
    )
    db.commit()
    response = client.get(f"/api/v1/guide/points/{p}", headers={"X-Forwarded-Host": "evil.example"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["interaction"] == "user_click_link"
    assert {link["kind"] for link in data["links"]} == {"focus_point", "show_floor", "open_vr"}
    assert len(data["panoramas"]) == 1
    assert all(image["variant"] == "labeled" for row in data["floors"] for image in row["images"])
    for link in data["links"]:
        parsed = urlsplit(link["url"])
        assert parsed.netloc == "2512921.cn"
        query = parse_qs(parsed.query)
        assert query["point"] == [p]
        if link["kind"] == "show_floor":
            assert query["floor"] == [floor["id"]]
            assert client.get(f"/api/v1/floors/{floor['id']}").status_code == 200
        if link["kind"] == "open_vr":
            assert query["panorama"] == [panorama_id]
    assert "下架资料" not in response.text and "evil.example" not in response.text
    client.app.state.settings.floors_enabled = False
    client.app.state.settings.vr_enabled = False
    data = client.get(f"/api/v1/guide/points/{p}").json()["data"]
    assert data["floors"] == data["panoramas"] == []
    assert [link["kind"] for link in data["links"]] == ["focus_point"]


@pytest.mark.parametrize(
    "visibility,status",
    [
        ("internal", "published"),
        ("restricted", "published"),
        ("public", "draft"),
        ("public", "retired"),
    ],
)
def test_guide_hides_nonpublic_points(client, db, visibility, status):
    point_id = add_point(db, visibility=visibility, status=status, summary="不可公开的资料")
    result = client.get(f"/api/v1/guide/points/{point_id}")
    assert result.status_code == 404 and "不可公开" not in result.text


def test_guide_hides_inactive_campus_and_mismatched_floor_revision(client, db, floor_bundle):
    _, floor = install(floor_bundle, db, client)
    db.get(MapRecord, floor["map_id"]).revision += 1
    db.commit()
    data = client.get(f"/api/v1/guide/points/{floor['point_id']}").json()["data"]
    assert not data["floors"]
    db.get(CampusRecord, "nku-jinnan").is_active = False
    db.commit()
    assert client.get(f"/api/v1/guide/points/{floor['point_id']}").status_code == 404


def test_plugin_search_supports_chinese_aliases_without_exposing_drafts(client, db):
    p = add_point(db, name="综合业务西楼", aliases=["业务西楼", "西楼100%"])
    add_point(db, name="未公开西楼", aliases=["业务西楼"], status="draft")
    for query in ["业务西楼", "西楼100%"]:
        data = client.get("/api/v1/campuses/nku-jinnan/points", params={"q": query}).json()["data"]
        assert [row["id"] for row in data] == [p]


@pytest.mark.parametrize("version", ["3.0.3", "3.1.0"])
def test_plugin_contains_only_six_implemented_public_operations(version):
    spec = build(version=version)
    ops = [operation for methods in spec["paths"].values() for operation in methods.values()]
    assert {op["operationId"] for op in ops} == set(OPERATIONS)
    assert all(set(methods) == {"get"} for methods in spec["paths"].values())
    assert all(
        op["x-implementation-status"] == "implemented" and op["security"] == [] for op in ops
    )
    assert set(references(spec)) <= spec["components"]["schemas"].keys()
    encoded = json.dumps(spec, ensure_ascii=False)
    assert len(encoded.encode()) < 2 * 1024 * 1024
    assert "/admin" not in encoded and "app_key" not in encoded and "Staff" not in encoded
    if version == "3.0.3":
        assert '"type": "null"' not in encoded and '"const":' not in encoded


def test_knowledge_export_reads_only_public_data_and_is_repeat_safe(client, db, tmp_path):
    published = add_point(db, name="公开测试点", summary="经过审核的介绍。")
    add_point(db, summary="", name="空介绍")
    add_point(db, status="draft", summary="草稿不会导出")

    def local_get(_base, path):
        response = client.get(path)
        assert response.status_code == 200
        return response.json()

    output = tmp_path / "snapshot"
    manifest = export("https://2512921.cn", "nku-jinnan", output, local_get)
    assert manifest["status"] == "complete_snapshot"
    assert [row["point_id"] for row in manifest["documents"]] == [published]
    assert len(manifest["skipped"]) == 1
    text = (output / "documents" / f"point-{published}.md").read_text()
    assert "经过审核的介绍" in text and "草稿不会导出" not in text
    with pytest.raises(ValueError, match="already exists"):
        export("https://2512921.cn", "nku-jinnan", output, local_get)
    assert db.get(PointRecord, published).revision == 1


def test_failed_export_leaves_no_complete_snapshot(tmp_path):
    def fail(_base, path):
        if path == "/api/v1/campuses":
            return {"data": [{"id": "nku-jinnan", "name": "测试校区"}]}
        raise OSError("offline")

    output = tmp_path / "snapshot"
    with pytest.raises(OSError):
        export("https://2512921.cn", "nku-jinnan", output, fail)
    assert not output.exists()
