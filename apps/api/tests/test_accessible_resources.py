"""Reviewed text equivalents and bounded original-caption HTTP behavior."""

import hashlib

import pytest
from sqlalchemy import select
from test_admin import BASE, login, seed_staff
from test_experiences import action, content, retire, save
from test_resources import action as floor_action
from test_resources import floor_content, image_bytes, make_resource_point, upload
from test_resources import save as floor_save

from app.models import ExperienceUploadRecord, UploadBudgetRecord
from app.modules.captions import MAX_CAPTION_BYTES, MAX_CUES, inspect_captions

VTT = "WEBVTT\n\n00:00.000 --> 00:02.000\n真实素材须团队提供，这是测试字幕。\n".encode()


def test_caption_plain_text_is_valid_without_rewriting_original_line_endings():
    for raw in (VTT, b"\xef\xbb\xbf" + VTT.replace(b"\n", b"\r\n")):
        meta = inspect_captions(raw)
        assert meta["cue_count"] == 1 and meta["duration_seconds"] == 2
        assert meta["sha256"] == hashlib.sha256(raw).hexdigest()


@pytest.fixture
def accessible_resources(client, db, tmp_path):
    users, _ = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "media"
    return users, make_resource_point(db), make_resource_point(db)


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"WEBVTT\n\n",
        b"\xff",
        b"WEBVTT\n\n00:02.000 --> 00:01.000\nx\n",
        b"WEBVTT\n\n00:00.000 --> 00:01.000 align:start\nx\n",
        b"WEBVTT\n\n00:00.000 --> 00:01.000\n<script>x</script>\n",
        b"WEBVTT\n\nSTYLE\n::cue {display:none}\n",
        b"WEBVTT\n\nNOTE\n00:00.000 --> 00:01.000\nx\n",
        b"WEBVTT\n\n00:00.000 --> 00:01.000\nx\x00\n",
        b"WEBVTT\n\n00:00.000 --> 00:01.000\nx\xe2\x80\xae\n",
        b"WEBVTT\n\n12:00:00.000 --> 12:00:01.000\nx\n",
        b"WEBVTT\n\n00:00.000 --> 00:10.000\nx\n\n00:00.000 --> 00:00.000\ny\n",
        b"x" * (MAX_CAPTION_BYTES + 1),
        b"WEBVTT\n\n" + b"00:00.000 --> 00:01.000\nx\n\n" * (MAX_CUES + 1),
    ],
    ids=lambda raw: "invalid-" + hashlib.sha256(raw).hexdigest()[:8],
)
def test_captions_reject_unbounded_markup_or_ambiguous_timing(raw):
    with pytest.raises((ValueError, UnicodeError)):
        inspect_captions(raw)


def caption_upload(client, point, raw=VTT, expected=201):
    result = client.post(
        f"{BASE}/points/{point.id}/experience-captions",
        content=raw,
        headers={"Content-Type": "text/vtt"},
    )
    assert result.status_code == expected, result.text
    return result.json().get("data")


def test_captions_exact_published_revision_scope_and_original_bytes(
    client, db, accessible_resources
):
    _, point, other = accessible_resources
    login(client)
    caption = caption_upload(client, point)
    assert caption["cue_count"] == 1
    assert client.get(caption["url"]).content == VTT
    media_content = content(
        point,
        media_type="video",
        url="https://example.com/movie.mp4",
        transcript="测试文字稿",
        caption_upload_id=caption["id"],
    )
    draft = save(client, media_content)
    public_url = f"/api/v1/experiences/{draft['id']}/captions/1/{caption['id']}"
    assert client.get(public_url).status_code == 404
    save(
        client,
        content(
            other,
            media_type="video",
            url="https://example.com/movie.mp4",
            caption_upload_id=caption["id"],
        ),
        expected=422,
    )
    save(client, content(point, caption_upload_id=caption["id"]), expected=422)
    submitted = action(client, draft, "submit")
    action(client, submitted, "publish", expected=403)
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    public = client.get(f"/api/v1/experiences/{draft['id']}").json()["data"]
    assert public["caption_url"] == public_url
    response = client.get(public_url)
    assert response.status_code == 200 and response.content == VTT
    assert response.headers["content-type"].startswith("text/vtt")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    assert client.get(public_url.replace("/captions/1/", "/captions/2/")).status_code == 404
    login(client)
    changed = save(client, {**media_content, "caption_upload_id": None}, published)
    assert client.get(public_url).status_code == 200, (
        "a private draft cannot revoke published captions"
    )
    submitted = action(client, changed, "submit")
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    assert client.get(public_url).status_code == 404, "exact superseded revision is not served"
    assert client.get(f"/api/v1/experiences/{draft['id']}").json()["data"]["caption_url"] is None
    login(client)
    updated = save(client, media_content, published)
    submitted = action(client, updated, "submit")
    login(client, "reviewer")
    published = action(client, submitted, "publish")
    latest = client.get(f"/api/v1/experiences/{draft['id']}").json()["data"]["caption_url"]
    row = db.get(ExperienceUploadRecord, caption["id"])
    path = client.app.state.settings.floor_assets_dir / ".experience-media" / row.id / row.filename
    path.write_bytes(VTT.replace(b"00:02.000", b"00:03.000"))
    assert client.get(latest).status_code == 404, (
        "changed bytes are rejected even if VTT remains valid"
    )
    path.write_bytes(VTT)
    point.visibility = "internal"
    db.commit()
    assert client.get(latest).status_code == 404
    point.visibility = "public"
    db.commit()
    retire(client, published)
    assert client.get(latest).status_code == 404


def test_caption_upload_failure_releases_quota_and_viewer_cannot_write(
    client, db, accessible_resources
):
    _, point, _ = accessible_resources
    login(client)
    caption_upload(client, point, b"invalid", expected=422)
    assert db.scalar(select(ExperienceUploadRecord)) is None
    budgets = db.scalars(select(UploadBudgetRecord)).all()
    assert all(row.active_uploads == 0 and row.reserved_bytes == 0 for row in budgets)
    login(client, "viewer")
    caption_upload(client, point, expected=403)


def test_floor_descriptions_are_reviewed_and_do_not_change_originals(
    client, db, accessible_resources
):
    _, point, _ = accessible_resources
    login(client)
    asset = upload(client, point)
    draft_content = floor_content(asset)
    draft_content["description"] = "楼层总体测试说明"
    draft_content["images"][0]["description"] = "分区测试说明"
    draft = floor_save(client, point, draft_content)
    assert draft["current"] is None
    submitted = floor_action(client, draft, "submit")
    login(client, "reviewer")
    published = floor_action(client, submitted, "publish")
    url = f"/api/v1/floors/{published['id']}"
    public = client.get(url).json()["data"]
    assert public["description"] == draft_content["description"]
    assert public["images"][0]["description"] == "分区测试说明"
    assert client.get(public["images"][0]["url"]).content == image_bytes()
    login(client)
    cleared = {**published["current"], "description": ""}
    cleared["images"][0]["description"] = ""
    draft = floor_save(client, point, cleared, published, expected=200)
    assert client.get(url).json()["data"]["description"] == "楼层总体测试说明"
    submitted = floor_action(client, draft, "submit")
    login(client, "reviewer")
    floor_action(client, submitted, "publish")
    cleared = client.get(url).json()["data"]
    assert cleared["description"] == cleared["images"][0]["description"] == ""
    assert client.get(cleared["images"][0]["url"]).content == image_bytes()
