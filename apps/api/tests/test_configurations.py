"""Real staff/public HTTP behavior, immutable review and durable paid controls."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import SecretStr
from sqlalchemy import func, select
from test_admin import BASE, login, seed_staff
from test_experiences import content as experience_content
from test_experiences import experiences as experiences
from test_experiences import publish as publish_experience

from app.configuration_models import (
    ConfigurationGrantRecord,
    ConfigurationRecord,
    ConfigurationVersionRecord,
    EmergencyStopRecord,
)
from app.core.errors import DomainError
from app.integrations.public_agent_security import PublicAgentCounter, paid_attempt
from app.models import (
    CampusRecord,
    ExperienceRecord,
    GuideSettingsRecord,
    StaffSessionRecord,
    now_utc,
)
from app.modules.admin.security import COOKIE, digest
from app.modules.configurations import effective_runtime

CONFIG = BASE + "/configurations"
SHOWCASE = "/api/v1/campuses/nku-jinnan/showcase"


@pytest.fixture
def staff(client, db):
    users, _ = seed_staff(client, db)
    for role, permissions in {
        "editor": ["configurations.edit", "runtime.edit"],
        "reviewer": ["configurations.review", "runtime.review"],
        "admin": ["configurations.edit", "configurations.review", "runtime.edit", "runtime.review"],
    }.items():
        for permission in permissions:
            db.add(
                ConfigurationGrantRecord(
                    user_id=users[role].id,
                    permission=permission,
                    scope="global",
                    granted_by=users["admin"].id,
                    note="独立测试授权",
                )
            )
    db.commit()
    return users


def body(item, **values):
    return {
        "expected_revision": item["revision"],
        "expected_published_revision": item["published_revision"],
        "operation_id": str(uuid4()),
        "note": "人工检查",
        **values,
    }


def create(
    client, kind="presentation", scope="global", content=None, expected=200, operation_id=None
):
    response = client.post(
        CONFIG,
        json={
            "kind": kind,
            "scope": scope,
            "content": content or {"kind": kind},
            "operation_id": operation_id or str(uuid4()),
            "note": "保存测试草稿",
        },
    )
    assert response.status_code == expected, response.text
    return response.json().get("data")


def action(client, item, verb, expected=200, **values):
    response = client.post(f"{CONFIG}/{item['id']}/{verb}", json=body(item, **values))
    assert response.status_code == expected, response.text
    return response.json().get("data")


def save(client, item, content, expected=200, payload=None):
    response = client.put(f"{CONFIG}/{item['id']}", json=payload or body(item, content=content))
    assert response.status_code == expected, response.text
    return response.json().get("data")


def publish(client, item):
    submitted = action(client, item, "submit")
    login(client, "reviewer")
    return action(client, submitted, "publish")


def test_existing_roles_have_no_automatic_configuration_authority(client, db):
    seed_staff(client, db)
    login(client, "admin")
    create(client, expected=403)
    assert client.get(CONFIG).json()["data"] == []
    assert db.scalar(select(func.count()).select_from(ConfigurationRecord)) == 0


def test_public_drafts_independent_review_and_no_self_admin_exception(client, db, staff):
    login(client)
    item = create(client, content={"kind": "presentation", "site_name": "待审新名称"})
    assert client.get(SHOWCASE).json()["data"]["presentation"]["site_name"] != "待审新名称"
    submitted = action(client, item, "submit")
    save(client, submitted, {"kind": "presentation", "site_name": "篡改"}, expected=409)
    staff["editor"].role = "admin"
    db.add(
        ConfigurationGrantRecord(
            user_id=staff["editor"].id,
            permission="configurations.review",
            scope="global",
            granted_by=staff["admin"].id,
            note="测试变更角色",
        )
    )
    db.commit()
    action(client, submitted, "publish", expected=403)
    login(client, "reviewer")
    item = action(client, submitted, "publish")
    assert item["published_revision"] == 1
    client.cookies.clear()
    assert client.get(SHOWCASE).json()["data"]["presentation"]["site_name"] == "待审新名称"
    assert client.get(f"{CONFIG}/{item['id']}").status_code == 401


def test_serial_cas_noop_operation_replay_and_other_account_isolation(client, db, staff):
    login(client)
    item = create(client)
    payload = body(item, content={"kind": "presentation", "site_name": "第一稿"})
    first = save(client, item, None, payload=payload)
    again = save(client, item, None, payload=payload)
    assert first == again
    assert first["revision"] == item["revision"] + 1
    save(client, item, {"kind": "presentation", "site_name": "迟到第二稿"}, expected=409)
    noop = save(client, first, {"kind": "presentation", "site_name": "第一稿"})
    assert noop["revision"] == first["revision"]
    conflict = {**payload, "content": {"kind": "presentation", "site_name": "不同载荷"}}
    save(client, item, None, expected=409, payload=conflict)
    result = client.get(BASE + "/operations/" + payload["operation_id"])
    assert result.status_code == 200
    assert result.json()["data"]["result"] == first
    login(client, "reviewer")
    assert client.get(BASE + "/operations/" + payload["operation_id"]).status_code == 404


def test_create_operation_retry_is_same_record(client, db, staff):
    login(client)
    operation_id = str(uuid4())
    first = create(client, operation_id=operation_id)
    second = create(client, operation_id=operation_id)
    assert first == second
    assert db.scalar(select(func.count()).select_from(ConfigurationRecord)) == 1


def test_history_restore_new_draft_does_not_replay_approval_or_remove_contributors(
    client, db, staff
):
    login(client)
    initial = create(client, content={"kind": "presentation", "site_name": "初稿"})
    published = publish(client, initial)
    login(client)
    history = client.get(f"{CONFIG}/{initial['id']}/history").json()["data"]
    created = next(v for v in history if v["event"] == "created")
    changed = save(client, published, {"kind": "presentation", "site_name": "未发布修改"})
    response = client.post(
        f"{CONFIG}/{initial['id']}/history/{created['id']}/restore-draft", json=body(changed)
    )
    assert response.status_code == 200, response.text
    restored = response.json()["data"]
    assert (
        restored["state"] == "draft"
        and restored["published_revision"] == published["published_revision"]
    )
    assert restored["published"]["site_name"] == "初稿"
    assert staff["editor"].id in restored["contributor_ids"]
    assert (
        db.get(ConfigurationVersionRecord, created["id"]).content_sha256
        == created["content_sha256"]
    )


def test_published_layers_inherit_fields_and_lists_replace(client, db, staff):
    login(client)
    parent = create(
        client, content={"kind": "presentation", "site_name": "全站名称", "footer": "全站页脚"}
    )
    publish(client, parent)
    login(client)
    child = create(
        client,
        scope="nku-jinnan",
        content={
            "kind": "presentation",
            "description": "校区简介",
            "modules": [{"id": "only", "type": "resource_entries"}],
        },
    )
    publish(client, child)
    data = client.get(SHOWCASE).json()["data"]
    assert data["presentation"]["site_name"] == "全站名称"
    assert data["presentation"]["footer"] == "全站页脚"
    assert data["presentation"]["description"] == "校区简介"
    assert [m["id"] for m in data["presentation"]["modules"]] == ["only"]


def test_scoped_grants_filter_counts_list_detail_and_operations(client, db, staff):
    login(client)
    item = action(client, create(client), "submit")
    for grant in db.scalars(
        select(ConfigurationGrantRecord).where(
            ConfigurationGrantRecord.user_id == staff["reviewer"].id
        )
    ):
        db.delete(grant)
    db.add(
        ConfigurationGrantRecord(
            user_id=staff["reviewer"].id,
            permission="configurations.review",
            scope="nku-jinnan",
            granted_by=staff["admin"].id,
            note="仅校区",
        )
    )
    db.commit()
    login(client, "reviewer")
    assert client.get(CONFIG).json()["data"] == []
    assert client.get(f"{CONFIG}/{item['id']}").status_code == 404
    rows = client.get(BASE + "/changes?kind=configuration").json()
    assert rows["data"] == [] and rows["meta"]["pagination"]["total"] == 0
    assert client.get(BASE + "/workbench").json()["data"]["pending_by_kind"]["configuration"] == 0


def test_configuration_is_in_unified_review_and_real_grants_control_review(client, db, staff):
    login(client)
    item = action(client, create(client), "submit")
    own = client.get(BASE + "/changes?kind=configuration").json()["data"]
    assert own[0]["is_mine"] and not own[0]["can_review"]
    login(client, "reviewer")
    rows = client.get(BASE + "/changes?kind=configuration").json()["data"]
    assert rows[0]["id"] == item["id"] and rows[0]["campus_id"] is None and rows[0]["can_review"]
    assert client.get(BASE + "/workbench").json()["data"]["pending_count"] == 1


def test_legacy_put_is_blocked_and_typed_published_policy_wins(client, db, staff):
    db.add(GuideSettingsRecord(id=1, revision=1, payload={"chat_enabled": False}, note="旧设置"))
    db.commit()
    login(client, "admin")
    result = client.put(
        BASE + "/guide-settings",
        json={"expected_revision": 1, "policy": {"chat_enabled": True}, "note": "旧表单"},
    )
    assert result.status_code == 409 and result.json()["error"]["code"] == "POLICY_REVIEW_REQUIRED"
    assert db.get(GuideSettingsRecord, 1).payload["chat_enabled"] is False
    item = create(client, "runtime", content={"kind": "runtime", "chat_enabled": True})
    item = publish(client, item)
    assert db.get(ConfigurationRecord, item["id"]).published["chat_enabled"] is True
    from app.modules.guide_settings import policy_for

    assert policy_for(db).chat_enabled is True


def test_pause_persists_through_policy_publish_restore_and_new_pause_invalidates_resume(
    client, db, staff
):
    login(client)
    runtime = publish(client, create(client, "runtime"))
    login(client)
    pause = client.post(
        BASE + "/service-controls/navigation/pause",
        json={"operation_id": str(uuid4()), "note": "现场核查"},
    )
    assert pause.status_code == 200
    assert not pause.json()["data"]["effective"]["navigation_enabled"]
    updated = save(client, runtime, {"kind": "runtime", "navigation_enabled": True})
    runtime = publish(client, updated)
    assert not effective_runtime(db, client.app.state.settings).navigation_enabled
    login(client)
    resumed = client.post(
        BASE + "/service-controls/navigation/resume-request",
        json={"operation_id": str(uuid4()), "note": "申请恢复"},
    )
    assert resumed.status_code == 200, resumed.text
    pending = action(client, resumed.json()["data"], "submit")
    client.post(
        BASE + "/service-controls/navigation/pause",
        json={"operation_id": str(uuid4()), "note": "新的现场问题"},
    )
    login(client, "reviewer")
    action(client, pending, "publish", expected=409)
    assert db.get(EmergencyStopRecord, "navigation").stopped


def test_resume_only_independent_publish_clears_specific_stop(client, db, staff):
    login(client)
    publish(client, create(client, "runtime"))
    login(client)
    for service in ("navigation", "narration_playback"):
        assert (
            client.post(
                BASE + "/service-controls/" + service + "/pause",
                json={"operation_id": str(uuid4()), "note": "维护"},
            ).status_code
            == 200
        )
    response = client.post(
        BASE + "/service-controls/navigation/resume-request",
        json={"operation_id": str(uuid4()), "note": "导航已核查"},
    )
    published = publish(client, response.json()["data"])
    assert published["resume_services"] == []
    assert not db.get(EmergencyStopRecord, "navigation").stopped
    assert db.get(EmergencyStopRecord, "narration_playback").stopped


def test_explicit_recent_mfa_guard_for_new_grant_and_resume_endpoints(client, db, staff):
    login(client, "admin")
    session = db.get(StaffSessionRecord, digest(client.cookies.get(COOKIE)))
    staff["admin"].mfa_enabled = True
    session.mfa_verified_at = now_utc() - timedelta(minutes=6)
    db.commit()
    response = client.put(
        BASE + f"/configuration-permissions/{staff['viewer'].id}/configurations.edit",
        json={"scope": "global", "enabled": True, "note": "授权"},
    )
    assert (
        response.status_code == 403 and response.json()["error"]["code"] == "MFA_STEP_UP_REQUIRED"
    )
    assert (
        client.post(
            BASE + "/service-controls/navigation/resume-request",
            json={"operation_id": str(uuid4()), "note": "恢复"},
        ).json()["error"]["code"]
        == "MFA_STEP_UP_REQUIRED"
    )
    assert client.get(BASE + "/configuration-permissions").status_code == 200
    assert (
        db.get(StaffSessionRecord, session.token_hash).last_activity_at == session.last_activity_at
    )


def test_soft_daily_cap_charges_actual_attempts_without_reset_on_policy_change(client, db, staff):
    cfg = client.app.state.settings
    cfg.nk_genios_api_enabled = cfg.agent_public_enabled = True
    cfg.nk_genios_api_key = SecretStr("synthetic-only-model-key")
    login(client)
    runtime = publish(
        client, create(client, "runtime", content={"kind": "runtime", "model_requests_per_day": 1})
    )
    request = SimpleNamespace(
        app=client.app, client=SimpleNamespace(host="203.0.113.1"), headers={}
    )
    paid_attempt(db, request, "visitor", "model", 30, 120)
    with pytest.raises(DomainError) as exceeded:
        paid_attempt(db, request, "visitor", "model", 30, 120)
    assert exceeded.value.code == "PUBLIC_BUDGET_REACHED"
    login(client)
    runtime = publish(
        client,
        save(
            client,
            runtime,
            {"kind": "runtime", "model_requests_per_day": 2, "total_turns_per_hour": 1000},
        ),
    )
    assert effective_runtime(db, cfg).total_turns_per_hour == 120
    paid_attempt(db, request, "visitor", "model", 30, 120)
    with pytest.raises(DomainError):
        paid_attempt(db, request, "visitor", "model", 30, 120)
    assert db.scalar(select(func.count()).select_from(PublicAgentCounter)) > 0


def test_reference_staleness_blocks_submit_and_public_module_falls_back(client, db, experiences):
    users, point, _ = experiences
    for role, permission in (
        ("editor", "configurations.edit"),
        ("reviewer", "configurations.review"),
    ):
        db.add(
            ConfigurationGrantRecord(
                user_id=users[role].id,
                permission=permission,
                scope="global",
                granted_by=users["admin"].id,
                note="测试",
            )
        )
    db.commit()
    image = publish_experience(client, experience_content(point))
    login(client)
    item = create(
        client,
        content={
            "kind": "presentation",
            "modules": [
                {
                    "id": "hero",
                    "type": "hero",
                    "image": {
                        "type": "image",
                        "id": image["id"],
                        "revision": image["published_revision"],
                    },
                    "alt": "图片说明",
                },
                {"id": "all", "type": "all_routes"},
            ],
        },
    )
    item = publish(client, item)
    assert client.get(SHOWCASE).json()["data"]["presentation"]["modules"][0]["image"] is not None
    db.get(ExperienceRecord, image["id"]).status = "retired"
    db.commit()
    assert client.get(SHOWCASE).json()["data"]["presentation"]["modules"][0]["image"] is None
    login(client)
    item = save(
        client,
        item,
        {
            "kind": "presentation",
            "modules": [
                {
                    "id": "hero",
                    "type": "hero",
                    "image": {
                        "type": "image",
                        "id": image["id"],
                        "revision": image["published_revision"],
                    },
                    "alt": "图片说明",
                },
                {"id": "all", "type": "all_routes"},
            ],
        },
    )
    report = action(client, item, "preflight")
    assert not report["valid"]
    action(client, item, "submit", expected=409)


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "presentation", "script": "alert(1)"},
        {"kind": "presentation", "modules": [{"id": "x", "type": "iframe"}]},
        {
            "kind": "presentation",
            "modules": [{"id": "x", "type": "announcement", "source_url": "javascript:alert(1)"}],
        },
        {"kind": "runtime", "profile_id": "arbitrary-provider"},
    ],
)
def test_schema_rejects_code_arbitrary_components_and_profiles(client, db, staff, bad):
    login(client)
    create(client, bad["kind"], content=bad, expected=422)


def test_cross_campus_resource_scope_is_rejected_even_for_admin(client, db, experiences):
    users, point, _ = experiences
    db.add(CampusRecord(id="nku-balitai", name="另一校区"))
    db.add(
        ConfigurationGrantRecord(
            user_id=users["admin"].id,
            permission="configurations.edit",
            scope="global",
            granted_by=users["admin"].id,
            note="测试",
        )
    )
    db.commit()
    image = publish_experience(client, experience_content(point))
    login(client, "admin")
    create(
        client,
        scope="nku-balitai",
        content={
            "kind": "presentation",
            "modules": [
                {
                    "id": "h",
                    "type": "hero",
                    "image": {"type": "image", "id": image["id"], "revision": 1},
                }
            ],
        },
        expected=403,
    )


def test_employee_preview_removes_old_campus_override_without_public_draft_leak(client, db, staff):
    login(client)
    publish(client, create(client, content={"kind": "presentation", "site_name": "父级名称"}))
    login(client)
    campus = publish(
        client,
        create(
            client,
            scope="nku-jinnan",
            content={"kind": "presentation", "site_name": "已发布校区名称"},
        ),
    )
    login(client)
    campus = save(client, campus, {"kind": "presentation", "description": "仅员工草稿"})
    preview_url = f"{CONFIG}/{campus['id']}/preview?campus_id=nku-jinnan&expected_revision={campus['revision']}"
    preview = client.get(preview_url)
    assert preview.status_code == 200, preview.text
    assert preview.json()["data"]["presentation"]["site_name"] == "父级名称"
    assert preview.json()["data"]["presentation"]["description"] == "仅员工草稿"
    assert client.get(SHOWCASE).json()["data"]["presentation"]["site_name"] == "已发布校区名称"
    client.cookies.clear()
    assert client.get(preview_url).status_code == 401


def test_unsaved_employee_preview_uses_real_global_campus_order_without_writes(client, db, staff):
    login(client)
    publish(client, create(client, content={"kind": "presentation", "site_name": "正式全站默认"}))
    login(client)
    publish(
        client,
        create(
            client,
            scope="nku-jinnan",
            content={"kind": "presentation", "site_name": "校区明确覆盖"},
        ),
    )
    login(client)
    count = db.scalar(select(func.count()).select_from(ConfigurationVersionRecord))
    payload = {
        "kind": "presentation",
        "scope": "global",
        "campus_id": "nku-jinnan",
        "content": {
            "kind": "presentation",
            "site_name": "未保存的全站默认",
            "description": "未保存描述",
        },
    }
    preview = client.post(CONFIG + "/preview", json=payload)
    assert preview.status_code == 200, preview.text
    assert preview.json()["data"]["presentation"]["site_name"] == "校区明确覆盖"
    assert preview.json()["data"]["presentation"]["description"] == "未保存描述"
    assert db.scalar(select(func.count()).select_from(ConfigurationVersionRecord)) == count
    assert client.get(SHOWCASE).json()["data"]["presentation"]["description"] == ""
    client.cookies.clear()
    assert client.post(CONFIG + "/preview", json=payload).status_code == 401


def test_reviewer_history_preview_is_read_only_and_uses_actual_sparse_layering(client, db, staff):
    login(client)
    original = create(client, content={"kind": "presentation", "site_name": "历史全站", "description": "历史未发布描述"})
    history = client.get(f"{CONFIG}/{original['id']}/history").json()["data"]
    version = history[0]["id"]
    save(client, original, {"kind": "presentation", "site_name": "当前草稿", "description": "当前草稿描述"})
    campus = create(client, scope="nku-jinnan", content={"kind": "presentation", "site_name": "校区正式覆盖"})
    publish(client, campus)
    before = db.scalar(select(func.count()).select_from(ConfigurationVersionRecord))
    url = f"{CONFIG}/{original['id']}/history/{version}/preview"
    preview = client.get(url, params={"campus_id": "nku-jinnan"})
    assert preview.status_code == 200, preview.text
    assert preview.json()["data"]["presentation"]["site_name"] == "校区正式覆盖"
    assert preview.json()["data"]["presentation"]["description"] == "历史未发布描述"
    assert db.scalar(select(func.count()).select_from(ConfigurationVersionRecord)) == before
    assert client.get(SHOWCASE).json()["data"]["presentation"]["description"] == ""
    assert client.post(CONFIG + "/preview", json={"kind": "presentation", "scope": "global", "campus_id": "nku-jinnan", "content": {"kind": "presentation"}}).status_code == 403
    wrong = client.get(f"{CONFIG}/{campus['id']}/history").json()["data"][0]["id"]
    assert client.get(f"{CONFIG}/{original['id']}/history/{wrong}/preview", params={"campus_id": "nku-jinnan"}).status_code == 404
    staff["reviewer"].campus_ids = []
    db.commit()
    assert client.get(url, params={"campus_id": "nku-jinnan"}).status_code == 404
    client.cookies.clear()
    assert client.get(url, params={"campus_id": "nku-jinnan"}).status_code == 401


def test_pause_operation_is_idempotent_and_cannot_replay_for_other_service(client, db, staff):
    login(client)
    create(client, "runtime")
    payload = {"operation_id": str(uuid4()), "note": "保护停用"}
    first = client.post(BASE + "/service-controls/navigation/pause", json=payload)
    again = client.post(BASE + "/service-controls/navigation/pause", json=payload)
    assert first.status_code == again.status_code == 200
    assert first.json()["data"] == again.json()["data"]
    assert db.get(EmergencyStopRecord, "navigation").revision == 1
    result = client.get(BASE + "/operations/" + payload["operation_id"])
    assert result.status_code == 200 and result.json()["data"]["action"] == "pause"
    assert client.post(BASE + "/service-controls/voice/pause", json=payload).status_code == 409
    assert db.get(EmergencyStopRecord, "voice") is None


def test_showcase_resource_types_are_actual_published_dependencies(client, db, experiences):
    _, point, _ = experiences
    image = publish_experience(client, experience_content(point))
    video = publish_experience(
        client, experience_content(point, media_type="video", url="https://example.com/video.mp4")
    )
    checkin = publish_experience(client, experience_content(point, "checkin"))
    route = publish_experience(
        client,
        experience_content(
            point,
            "tour",
            stops=[
                {
                    "point_id": point.id,
                    "segments": [
                        {
                            "id": "first",
                            "main_view": {"type": "image", "id": image["id"], "revision": 1},
                            "resources": [
                                {"type": "video", "id": video["id"], "revision": 1},
                                {"type": "checkin", "id": checkin["id"], "revision": 1},
                            ],
                        }
                    ],
                }
            ],
        ),
    )
    showcase = client.get(SHOWCASE).json()["data"]
    card = next(r for r in showcase["routes"] if r["id"] == route["id"])
    assert card["resource_types"] == ["checkin", "image", "video"]
    assert showcase["presentation"]["modules"][0]["button_label"] == "开始发现"
    from test_experiences import retire

    retire(client, image)
    assert route["id"] not in {r["id"] for r in client.get(SHOWCASE).json()["data"]["routes"]}


def test_configuration_migration_preserves_legacy_policy_without_granting_roles():
    from importlib import import_module

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine

    from app.models import StaffUserRecord

    engine = create_engine("sqlite://")
    StaffUserRecord.__table__.create(engine)
    GuideSettingsRecord.__table__.create(engine)
    legacy = {"chat_enabled": False, "allowed_actions": [], "total_turns_per_hour": 12}
    with engine.begin() as connection:
        connection.execute(
            GuideSettingsRecord.__table__.insert().values(
                id=1, revision=9, payload=legacy, note="原审计理由", updated_at=now_utc()
            )
        )
        context = MigrationContext.configure(connection)
        migration = import_module("migrations.versions.0013_configurations")
        with Operations.context(context):
            migration.upgrade()
        assert connection.execute(select(GuideSettingsRecord.payload)).scalar_one() == legacy
        assert connection.execute(select(ConfigurationRecord.published)).scalar_one() == {
            "kind": "runtime",
            **legacy,
        }
        assert (
            connection.execute(
                select(func.count()).select_from(ConfigurationGrantRecord)
            ).scalar_one()
            == 0
        )
        with Operations.context(context):
            migration.downgrade()
        assert connection.execute(select(GuideSettingsRecord.revision)).scalar_one() == 9
    engine.dispose()
