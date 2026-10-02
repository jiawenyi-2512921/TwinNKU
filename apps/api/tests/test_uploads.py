"""Important storage boundaries: authorization, durable quotas, cleanup and references."""

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import timedelta
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from test_admin import BASE, login, seed_staff
from test_resources import floor_content, image_bytes, make_resource_point, save, upload

from app.core.errors import DomainError
from app.models import (
    Base,
    CampusRecord,
    FloorUploadRecord,
    StaffUserRecord,
    UploadBudgetRecord,
    UploadReservationRecord,
    now_utc,
)
from app.modules import uploads
from app.modules.upload_gc import apply_gc, maintenance_plan, protected_uploads
from app.modules.uploads import inspect_upload, storage_guard, upload_slot


@pytest.fixture
def storage(client, db, tmp_path):
    staff, _ = seed_staff(client, db)
    client.app.state.settings.floor_assets_dir = tmp_path / "floor-assets"
    point = make_resource_point(db)
    login(client, "admin")
    return staff, point, client.app.state.settings


def budget(db, scope):
    return db.get(UploadBudgetRecord, scope, populate_existing=True)


def test_permission_and_scope_fail_before_reserving_bytes(client, db, storage):
    staff, point, _ = storage
    staff["editor"].campus_ids = []
    db.commit()
    for user in ("viewer", "editor"):
        login(client, user)
        # Empty non-admin scope gives no point access.
        response = client.post(
            f"{BASE}/points/{point.id}/floor-images",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        )
        assert response.status_code == (403 if user == "viewer" else 404)
    assert db.scalar(select(func.count()).select_from(UploadReservationRecord)) == 0


def test_budget_reserves_maximum_not_declared_length_and_refunds_failure(client, db, storage):
    staff, point, settings = storage
    settings.upload_actor_budget_bytes = 32 * 1024 * 1024 - 1
    response = client.post(
        f"{BASE}/points/{point.id}/floor-images",
        content=image_bytes(),
        headers={"Content-Type": "image/png", "Content-Length": "1"},
    )
    assert response.status_code == 413 and response.json()["error"]["code"] == "UPLOAD_QUOTA"
    assert db.scalar(select(func.count()).select_from(FloorUploadRecord)) == 0
    settings.upload_actor_budget_bytes = 1024 * 1024 * 1024
    response = client.post(
        f"{BASE}/points/{point.id}/floor-images",
        content=b"bad PNG",
        headers={"Content-Type": "image/png"},
    )
    assert response.status_code == 422
    assert budget(db, "global").active_uploads == 0
    assert budget(db, "actor:" + staff["admin"].id).reserved_bytes == 0
    assert budget(db, "campus:" + point.campus_id).used_bytes == 0
    assert not list((settings.floor_assets_dir / ".uploads").iterdir())


def test_success_original_bytes_and_actual_usage_then_commit_failure_cleanup(
    client, db, storage, monkeypatch
):
    staff, point, settings = storage
    original = image_bytes()
    result = upload(client, point, original)
    row = db.get(FloorUploadRecord, result["id"])
    assert row.image["sha256"] == hashlib.sha256(original).hexdigest()
    assert budget(db, "actor:" + staff["admin"].id).used_bytes == len(original)
    assert budget(db, "global").active_uploads == 0
    before = {p.name for p in (settings.floor_assets_dir / ".uploads").iterdir()}
    commit, calls = db.commit, 0

    def fail_completion():
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Injected publication transaction failure")
        return commit()

    monkeypatch.setattr(db, "commit", fail_completion)
    response = client.post(
        f"{BASE}/points/{point.id}/floor-images",
        content=image_bytes("blue"),
        headers={"Content-Type": "image/png"},
    )
    assert response.status_code == 500
    assert budget(db, "global").active_uploads == 0
    assert budget(db, "actor:" + staff["admin"].id).used_bytes == len(original)
    assert budget(db, "campus:" + point.campus_id).reserved_bytes == 0
    assert {p.name for p in (settings.floor_assets_dir / ".uploads").iterdir()} == before
    assert db.scalar(select(func.count()).select_from(FloorUploadRecord)) == 1


def test_atomic_two_slot_limit_across_independent_database_sessions(tmp_path, monkeypatch):
    # Windows's maintenance lock is deliberately exclusive. Replace only that
    # platform adapter here so the actual database's cross-session slot limit runs.
    monkeypatch.setattr(uploads, "storage_guard", lambda *_a, **_k: nullcontext())
    engine = create_engine(
        "sqlite:///" + (tmp_path / "concurrent.db").as_posix(),
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    Base.metadata.create_all(engine)
    user_id = str(uuid4())
    settings = SimpleNamespace(
        floor_assets_dir=tmp_path,
        upload_max_concurrency=2,
        upload_actor_budget_bytes=100,
        upload_campus_budget_bytes=100,
        upload_reservation_minutes=20,
    )
    with Session(engine) as db:
        db.add(CampusRecord(id="nku-jinnan", name="校区", description=""))
        db.add(
            StaffUserRecord(
                id=user_id,
                username="u",
                display_name="u",
                role="admin",
                password_hash="not-a-login",
                campus_ids=[],
                point_ids=[],
            )
        )
        db.commit()
    entered, release = [Event(), Event()], Event()

    def hold(index):
        with Session(engine) as db:
            with upload_slot(
                db,
                settings,
                SimpleNamespace(id=user_id),
                SimpleNamespace(campus_id="nku-jinnan"),
                kind="floor",
                upload_id=str(uuid4()),
                max_bytes=40,
            ):
                entered[index].set()
                assert release.wait(5)

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = pool.submit(hold, 0), pool.submit(hold, 1)
            assert all(e.wait(5) for e in entered)
            with Session(engine) as db, pytest.raises(DomainError) as error:
                with upload_slot(
                    db,
                    settings,
                    SimpleNamespace(id=user_id),
                    SimpleNamespace(campus_id="nku-jinnan"),
                    kind="floor",
                    upload_id=str(uuid4()),
                    max_bytes=1,
                ):
                    pytest.fail("Third upload must never start")
            assert error.value.code == "UPLOAD_BUSY"
            release.set()
            first.result()
            second.result()
        with Session(engine) as db:
            assert budget(db, "global").active_uploads == 0
            assert budget(db, "actor:" + user_id).reserved_bytes == 0
    finally:
        release.set()
        engine.dispose()


@pytest.mark.parametrize("scope", ["actor", "campus"])
def test_concurrent_capacity_cannot_overbook_otherwise_available_slot(tmp_path, monkeypatch, scope):
    monkeypatch.setattr(uploads, "storage_guard", lambda *_a, **_k: nullcontext())
    engine = create_engine("sqlite:///" + (tmp_path / "quota.db").as_posix())
    Base.metadata.create_all(engine)
    settings = SimpleNamespace(
        floor_assets_dir=tmp_path,
        upload_max_concurrency=2,
        upload_actor_budget_bytes=100 if scope == "actor" else 1000,
        upload_campus_budget_bytes=100 if scope == "campus" else 1000,
        upload_reservation_minutes=20,
    )
    user = SimpleNamespace(id=str(uuid4()))
    point = SimpleNamespace(campus_id="nku-jinnan")
    try:
        with Session(engine) as db:
            db.add(CampusRecord(id=point.campus_id, name="校区", description=""))
            db.add(
                StaffUserRecord(
                    id=user.id,
                    username="u",
                    display_name="u",
                    role="admin",
                    password_hash="not-a-login",
                    campus_ids=[],
                    point_ids=[],
                )
            )
            db.commit()
            with upload_slot(
                db, settings, user, point, kind="floor", upload_id=str(uuid4()), max_bytes=70
            ):
                with Session(engine) as other, pytest.raises(DomainError) as error:
                    with upload_slot(
                        other,
                        settings,
                        user,
                        point,
                        kind="floor",
                        upload_id=str(uuid4()),
                        max_bytes=40,
                    ):
                        pytest.fail("Budget must not be overbooked")
                assert error.value.code == "UPLOAD_QUOTA"
    finally:
        engine.dispose()


def test_gc_preserves_all_retained_and_audit_versions_and_only_removes_old_unused(
    client, db, storage
):
    _, point, settings = storage
    referenced, old_orphan, fresh = [
        upload(client, point, image_bytes(color)) for color in ("green", "blue", "red")
    ]
    draft = save(client, point, floor_content(referenced))
    from app.models import ResourceChangeRecord

    change = db.get(ResourceChangeRecord, draft["id"])
    # Even replacing a discarded draft cannot remove the original retained audit.
    change.state, change.payload = "discarded", None
    for item in (referenced, old_orphan):
        db.get(FloorUploadRecord, item["id"]).created_at = now_utc() - timedelta(days=8)
    db.commit()
    assert referenced["id"] in protected_uploads(db)
    plan = maintenance_plan(db, settings)
    assert [i["id"] for i in plan["uploads"]] == [old_orphan["id"]]
    assert db.get(FloorUploadRecord, old_orphan["id"]) is not None  # Dry-run did not mutate.
    with storage_guard(settings, exclusive=True):
        with pytest.raises(ValueError, match="changed"):
            apply_gc(db, settings, expected_sha="wrong", reason="核对后的维护")
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="核对后只回收未引用旧上传")
    assert db.get(FloorUploadRecord, old_orphan["id"]) is None
    assert all(db.get(FloorUploadRecord, i["id"]) for i in (referenced, fresh))
    actor = db.scalar(
        select(StaffUserRecord).where(StaffUserRecord.username == "maintenance.upload-gc")
    )
    assert not actor.is_active and not actor.campus_ids and actor.role == "viewer"


def test_parser_timeout_kills_child_without_blocking_event_loop(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PASSWORD", "TEST_ONLY_NOT_FOR_DECODER")
    monkeypatch.setenv("VOICE_API_KEY", "TEST_ONLY_NOT_FOR_DECODER")
    path = tmp_path / "original"
    path.write_bytes(b"not an image")
    settings = SimpleNamespace(
        floor_assets_dir=tmp_path,
        upload_parser_memory_bytes=512 * 1024 * 1024,
        upload_parser_cpu_seconds=15,
        upload_parser_timeout_seconds=0.01,
    )

    class Process:
        returncode = None
        pid = 99999999
        stdout = None
        killed = False

        async def read(self, _size):
            await asyncio.sleep(1)

        def kill(self):
            self.killed, self.returncode = True, -9

        async def wait(self):
            self.returncode = -9

    process = Process()
    process.stdout = process

    async def spawn(*_a, **_k):
        assert "DB_PASSWORD" not in _k["env"] and "VOICE_API_KEY" not in _k["env"]
        assert _k["env"]["DATABASE_URL"] == "sqlite://"
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(uploads.os, "killpg", lambda *_a: process.kill(), raising=False)
    with pytest.raises(DomainError) as error:
        asyncio.run(inspect_upload(path, "image/png", kind="floor", settings=settings))
    assert error.value.code == "INVALID_IMAGE" and process.killed


def test_backup_exclusive_lock_blocks_upload_before_any_reservation(client, db, storage):
    _, point, settings = storage
    with storage_guard(settings, exclusive=True):
        response = client.post(
            f"{BASE}/points/{point.id}/floor-images",
            content=image_bytes(),
            headers={"Content-Type": "image/png"},
        )
        assert response.status_code == 503 and response.json()["error"]["code"] == "STORAGE_BUSY"
    assert db.scalar(select(func.count()).select_from(UploadReservationRecord)) == 0


def test_gc_deletion_failure_keeps_charge_and_is_resumable(client, db, storage, monkeypatch):
    staff, point, settings = storage
    item = upload(client, point, image_bytes("blue"))
    db.get(FloorUploadRecord, item["id"]).created_at = now_utc() - timedelta(days=8)
    db.commit()
    size = len(image_bytes("blue"))
    from app.modules import upload_gc

    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        rmtree = upload_gc.shutil.rmtree
        monkeypatch.setattr(
            upload_gc.shutil,
            "rmtree",
            lambda _path: (_ for _ in ()).throw(OSError("Injected delete failure")),
        )
        with pytest.raises(OSError, match="delete failure"):
            apply_gc(db, settings, expected_sha=plan["sha256"], reason="中断保护核验")
        assert budget(db, "actor:" + staff["admin"].id).used_bytes == size
        assert db.get(FloorUploadRecord, item["id"]) is None
        assert (settings.floor_assets_dir / ".gc-quarantine" / ("floor-" + item["id"])).is_dir()
        resume = maintenance_plan(db, settings)
        assert resume["quarantined"] and not resume["uploads"]
        monkeypatch.setattr(upload_gc.shutil, "rmtree", rmtree)
        apply_gc(db, settings, expected_sha=resume["sha256"], reason="恢复中断的已核对回收")
    assert budget(db, "actor:" + staff["admin"].id).used_bytes == 0
    assert budget(db, "campus:" + point.campus_id).used_bytes == 0


def test_expired_crash_lease_releases_slot_but_retains_physical_bytes_until_seven_days(
    client, db, storage
):
    staff, point, settings = storage
    owner = staff["admin"]
    key, original = str(uuid4()), image_bytes("red")
    # Simulate a process crash after durable reservation/body receipt, without
    # running the normal context-manager cleanup; no fake web session is made.
    from app.modules.uploads import ensure_budget

    for scope in ("global", "actor:" + owner.id, "campus:" + point.campus_id):
        ensure_budget(db, scope)
    budget(db, "global").active_uploads = 1
    for scope in ("actor:" + owner.id, "campus:" + point.campus_id):
        budget(db, scope).reserved_bytes = 32 * 1024 * 1024
    reservation = UploadReservationRecord(
        kind="floor",
        upload_id=key,
        user_id=owner.id,
        campus_id=point.campus_id,
        size_bytes=32 * 1024 * 1024,
        state="reserved",
        expires_at=now_utc() - timedelta(minutes=1),
        created_at=now_utc() - timedelta(hours=1),
    )
    db.add(reservation)
    db.commit()
    folder = settings.floor_assets_dir / ".uploads" / key
    folder.mkdir(parents=True)
    (folder / "original").write_bytes(original)
    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        assert not plan["abandoned"] and plan["expired_reservations"]
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="释放崩溃进程的并发名额")
    assert folder.is_dir() and reservation.state == "orphaned"
    assert budget(db, "global").active_uploads == 0
    assert budget(db, "actor:" + owner.id).used_bytes == len(original)
    assert budget(db, "campus:" + point.campus_id).reserved_bytes == 0
    reservation.created_at = now_utc() - timedelta(days=8)
    db.commit()
    with storage_guard(settings, exclusive=True):
        plan = maintenance_plan(db, settings)
        assert plan["abandoned"] == [{"kind": "floor", "id": key}]
        apply_gc(db, settings, expected_sha=plan["sha256"], reason="核对七天以上未引用原件")
    assert not folder.exists()
    assert budget(db, "actor:" + owner.id).used_bytes == 0
