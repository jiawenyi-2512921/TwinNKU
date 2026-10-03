"""Human video decisions and exact public alternatives over real authorized HTTP."""

import copy
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_admin import login
from test_experiences import ADMIN, PUBLIC, action, content, publish, retire, save
from test_experiences import experiences as experiences

from app.models import AdminAuditRecord, ExperienceRecord, ExperienceUploadRecord


def video(point, **values):
    return content(
        point, **{"media_type": "video", "url": "https://example.com/original.mp4", **values}
    )


def described(client, point):
    return publish(client, video(point, title="口述描述测试素材"))


def original(point, target):
    return video(
        point,
        video_visual_information="description_required",
        audio_description_video_id=target["id"],
        audio_description_video_revision=target["published_revision"],
    )


def test_old_unassessed_public_snapshot_is_readable_but_new_submission_requires_assessment(
    client, db, experiences
):
    _, point, _ = experiences
    legacy = ExperienceRecord(
        id=str(uuid4()),
        kind="media",
        point_id=point.id,
        campus_id=point.campus_id,
        revision=1,
        published_revision=1,
        state="published",
        status="published",
        published={
            "kind": "media",
            "media_type": "video",
            "point_id": point.id,
            "title": "旧快照测试",
            "source_note": "非真实内容",
            "url": "https://example.com/old.mp4",
        },
    )
    db.add(legacy)
    db.commit()
    assert client.get(f"{PUBLIC}/{legacy.id}").status_code == 200
    login(client)
    new = save(
        client, video(point, video_visual_information="unassessed", video_accessibility_note="")
    )
    action(client, new, "submit", expected=409)
    result = client.post(
        f"{ADMIN}/{new['id']}/preflight",
        json={
            "expected_revision": new["revision"],
            "expected_published_revision": 0,
            "operation_id": str(uuid4()),
        },
    )
    assert result.status_code == 200, result.text
    assert not result.json()["data"]["valid"]
    assert result.json()["data"]["issues"][0]["code"] == "VIDEO_ASSESSMENT_REQUIRED"


@pytest.mark.parametrize(
    "changes",
    [
        {"video_visual_information": "silent", "transcript": ""},
        {"video_visual_information": "description_required"},
        {"video_accessibility_note": "   "},
    ],
)
def test_missing_equivalent_or_assessment_cannot_be_submitted(client, experiences, changes):
    _, point, _ = experiences
    login(client)
    item = save(client, video(point, **changes))
    action(client, item, "submit", expected=409)


def test_silent_video_with_equivalent_text_requires_independent_explicit_confirmation(
    client, db, experiences
):
    _, point, _ = experiences
    login(client)
    item = action(
        client,
        save(
            client,
            video(point, video_visual_information="silent", transcript="实际画面等价文字测试"),
        ),
        "submit",
    )
    action(client, item, "publish", expected=403)
    login(client, "reviewer")
    denied = client.post(
        f"{ADMIN}/{item['id']}/review/publish",
        json={"expected_revision": item["revision"], "note": "核对测试"},
    )
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "VIDEO_REVIEW_REQUIRED"
    done = action(client, item, "publish")
    event = db.scalar(
        select(AdminAuditRecord).where(
            AdminAuditRecord.action == "experience.published",
            AdminAuditRecord.details["experience_id"].as_string() == item["id"],
        )
    )
    evidence = event.details["video_accessibility_review"]
    assert evidence["draft_revision"] == item["revision"]
    assert evidence["published_revision"] == done["published_revision"]
    assert evidence["assessment"] == "silent" and evidence["description_video"] is None
    assert len(evidence["source_content_sha256"]) == len(evidence["dependency_sha256"]) == 64


def test_description_binding_read_is_exact_and_withdrawal_revokes_source_and_tour(
    client, db, experiences
):
    _, point, _ = experiences
    target = described(client, point)
    source = publish(client, original(point, target))
    route = publish(
        client, content(point, "tour", stops=[{"point_id": point.id, "video_id": source["id"]}])
    )
    path = f"{PUBLIC}/{source['id']}/audio-description/{source['published_revision']}/{target['id']}/{target['published_revision']}"
    result = client.get(path)
    assert result.status_code == 200 and result.json()["data"]["id"] == target["id"]
    controlled = result.json()["data"]["media_url"]
    redirect = client.get(controlled, follow_redirects=False)
    assert (
        redirect.status_code == 307
        and redirect.headers["location"] == target["published_content"]["url"]
    )
    assert redirect.headers["cache-control"] == "no-store"
    assert (
        client.get(path.replace(f"/{source['published_revision']}/", "/999/", 1)).status_code == 404
    )
    assert client.get(path.replace(target["id"], str(uuid4()))).status_code == 404
    retire(client, target)
    for endpoint in (path, controlled, f"{PUBLIC}/{source['id']}", f"{PUBLIC}/{route['id']}"):
        assert client.get(endpoint).status_code == 404


@pytest.mark.parametrize("mutation", ["point", "revision", "image", "unassessed", "self", "chain"])
def test_invalid_description_choices_cannot_enter_a_new_draft(client, db, experiences, mutation):
    _, point, other = experiences
    target = described(client, other if mutation == "point" else point)
    data = original(point, target)
    login(client)
    if mutation == "revision":
        data["audio_description_video_revision"] += 1
    elif mutation in {"image", "unassessed", "chain"}:
        record = db.get(ExperienceRecord, target["id"])
        body = copy.deepcopy(record.published)
        if mutation == "image":
            body.update(
                media_type="image",
                video_visual_information="unassessed",
                video_accessibility_note="",
            )
        elif mutation == "unassessed":
            body["video_visual_information"] = "unassessed"
        else:
            body.update(
                video_visual_information="description_required",
                audio_description_video_id=str(uuid4()),
                audio_description_video_revision=1,
            )
        record.published = body
        db.commit()
    elif mutation == "self":
        data = original(point, target)
        save(client, data, target, expected=409)
        return
    save(client, data, expected=409)


def test_target_update_after_submission_blocks_publication_without_reusing_old_confirmation(
    client, experiences
):
    _, point, _ = experiences
    target = described(client, point)
    login(client)
    source = action(client, save(client, original(point, target)), "submit")
    changed = save(client, video(point, title="已更新口述描述版"), target)
    changed = action(client, changed, "submit")
    login(client, "reviewer")
    action(client, changed, "publish")
    action(client, source, "publish", expected=409)


def test_hidden_alternative_and_partial_pair_are_dto_errors(client, experiences):
    _, point, _ = experiences
    target = described(client, point)
    login(client)
    save(
        client,
        video(point, audio_description_video_id=target["id"], audio_description_video_revision=1),
        expected=422,
    )
    save(
        client,
        video(
            point,
            video_visual_information="description_required",
            audio_description_video_id=target["id"],
        ),
        expected=422,
    )


def test_impact_read_lists_exact_media_reference_and_respects_scope(client, db, experiences):
    users, point, other = experiences
    target = described(client, point)
    source = publish(client, original(point, target))
    login(client, "viewer")
    response = client.get(f"/api/v1/admin/resources/video/{target['id']}/dependencies")
    assert response.status_code == 200
    rows = [r for r in response.json()["data"] if r["id"] == source["id"]]
    assert rows and "published.audio_description_video_id" in rows[0]["locations"]
    users["viewer"].point_ids = [other.id]
    db.commit()
    login(client, "viewer")
    assert (
        client.get(f"/api/v1/admin/resources/video/{target['id']}/dependencies").status_code == 404
    )


def test_description_original_bytes_require_both_live_versions_on_every_request(
    client, db, experiences
):
    import hashlib

    users, point, _ = experiences
    key = str(uuid4())
    # Synthetic delivery fixture: this test exercises byte authorization, not
    # video format validation. The real FFmpeg format test remains independent.
    original_bytes = b"synthetic video-delivery fixture bytes"
    root = client.app.state.settings.floor_assets_dir / ".experience-media" / key
    root.mkdir(parents=True)
    (root / "original.mp4").write_bytes(original_bytes)
    db.add(
        ExperienceUploadRecord(
            id=key,
            point_id=point.id,
            uploaded_by=users["editor"].id,
            media_type="video",
            mime_type="video/mp4",
            filename="original.mp4",
            size_bytes=len(original_bytes),
            sha256=hashlib.sha256(original_bytes).hexdigest(),
        )
    )
    db.commit()
    target = publish(client, video(point, url=None, upload_id=key))
    source = publish(client, original(point, target))
    path = f"{PUBLIC}/{source['id']}/audio-description/{source['published_revision']}/{target['id']}/{target['published_revision']}"
    url = client.get(path).json()["data"]["media_url"]
    response = client.get(url, headers={"Range": "bytes=0-8"})
    assert response.status_code == 206 and response.content == original_bytes[:9]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    row = db.get(ExperienceRecord, source["id"])
    row.published_revision += 1
    db.commit()
    assert client.get(url).status_code == 404
    row.published_revision -= 1
    db.commit()
    point.visibility = "internal"
    db.commit()
    assert client.get(url).status_code == 404


def test_media_description_export_roundtrip_and_old_manual_columns_preserve_all_fields(
    client, db, experiences
):
    from test_import_exports import exported, upload_body
    from test_import_jobs import commit, upload

    _, point, _ = experiences
    target = described(client, point)
    login(client)
    source = save(client, original(point, target))
    body, _ = exported(client, "media", source["id"])
    checked = upload_body(client, "media", body)
    assert checked["preview"][0]["action"] == "skip", checked
    assert commit(client, checked).status_code == 200
    preserved = db.get(ExperienceRecord, source["id"]).draft
    old_table = {
        "id": source["id"],
        "expected_revision": str(source["revision"]),
        "expected_published_revision": "0",
        "point_id": point.id,
        "media_type": "video",
        "url": "https://example.com/original.mp4",
        "title": "旧模板更改标题",
        "source_note": "测试私有导入",
    }
    checked = upload(client, "media", [old_table]).json()["data"]
    assert checked["preview"][0]["action"] == "update", checked
    assert commit(client, checked).status_code == 200
    actual = db.get(ExperienceRecord, source["id"]).draft
    for key in (
        "video_visual_information",
        "video_accessibility_note",
        "audio_description_video_id",
        "audio_description_video_revision",
    ):
        assert actual[key] == preserved[key]
    assert actual["title"] == "旧模板更改标题"


def test_media_description_import_rechecks_target_revision_at_commit(client, db, experiences):
    from test_import_jobs import commit, upload

    _, point, _ = experiences
    target = described(client, point)
    login(client)
    values = original(point, target)
    checked = upload(client, "media", [values]).json()["data"]
    assert checked["preview"][0]["action"] == "create", checked
    target_row = db.get(ExperienceRecord, target["id"])
    target_row.published_revision += 1
    db.commit()
    assert commit(client, checked).status_code == 409
    assert db.query(ExperienceRecord).count() == 1


def test_vr_cover_impact_includes_private_new_drafts_and_formal_versions_without_scope_leaks(
    client, db, experiences
):
    from test_resources import save as resource_save
    from test_vr_management import publish_vr, vr

    users, point, other = experiences
    image = publish(client, content(point))
    values = vr(cover_image_id=image["id"], cover_image_revision=image["published_revision"])
    formal = publish_vr(client, point, values)
    login(client)
    draft = resource_save(client, point, values)
    hidden = resource_save(client, other, vr(title="范围外私有VR名称"))
    from app.models import ResourceChangeRecord

    hidden_row = db.get(ResourceChangeRecord, hidden["id"])
    hidden_row.payload = {
        **hidden_row.payload,
        "content": {**hidden_row.payload["content"], **values},
    }
    users["viewer"].point_ids = [point.id]
    db.commit()
    login(client, "viewer")
    response = client.get(f"/api/v1/admin/resources/image/{image['id']}/dependencies")
    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["data"] if row["entity_type"] == "vr"}
    assert set(rows) == {formal["id"], draft["id"]}
    assert "published.cover_image_id" in rows[formal["id"]]["locations"]
    assert "draft.content.cover_image_id" in rows[draft["id"]]["locations"]
    assert "范围外私有" not in response.text
    login(client)
    check = client.post(
        f"/api/v1/admin/content/vr/{draft['id']}/preflight",
        json={
            "expected_revision": draft["draft"]["revision"],
            "expected_published_revision": 0,
            "operation_id": str(uuid4()),
        },
    )
    assert check.status_code == 200 and check.json()["data"]["valid"], check.text
    old = check.json()["data"]["dependency_sha256"]
    db.get(ExperienceRecord, image["id"]).published_revision += 1
    db.commit()
    check = client.post(
        f"/api/v1/admin/content/vr/{draft['id']}/preflight",
        json={
            "expected_revision": draft["draft"]["revision"],
            "expected_published_revision": 0,
            "operation_id": str(uuid4()),
        },
    )
    assert check.status_code == 200 and not check.json()["data"]["valid"]
    assert check.json()["data"]["dependency_sha256"] != old
