"""Host-side fixed command, phase handshake and durable budget behavior."""

import ast
import importlib.util
import json
import os
import sys
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("backup_executor", SCRIPTS / "backup_executor.py")
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


def test_host_script_python38_compatible():
    ast.parse((SCRIPTS / "backup_executor.py").read_text(encoding="utf-8"), feature_version=(3, 8))
    assert "from datetime import UTC" not in (SCRIPTS / "backup_executor.py").read_text()


def test_scheduled_legacy_script_or_different_repository_is_rejected(tmp_path, monkeypatch):
    script = tmp_path / "backup.py"
    script.write_text("# fixed test script")
    script.chmod(0o644)
    if os.name != "posix" or script.stat().st_uid != 0:
        # Owner safety is Linux-only; keep command parsing assertions portable.
        original = Path.stat

        def root_stat(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            return type(
                "Stat", (), {"st_uid": 0, "st_mode": info.st_mode & ~0o022, "st_size": info.st_size}
            )()

        monkeypatch.setattr(Path, "stat", root_stat)
    settings = {
        "root": tmp_path,
        "destination": executor.backup.checked_path("/var/backups/twinnku"),
        "key_file": executor.backup.checked_path("/etc/twinnku/backup-password"),
        "min_free_gib": 10,
        "nginx_sites": [],
        "backup_script_sha256": "a" * 64,
    }
    monkeypatch.setattr(
        executor.subprocess,
        "run",
        lambda *args, **kwargs: type(
            "Result",
            (),
            {
                "stdout": f"{{ argv[]=/usr/bin/python3 {script.as_posix()} --root {tmp_path.as_posix()} ; ignore_errors=no ; }}".encode()
            },
        )(),
    )
    with pytest.raises(executor.ExecutorError, match="SCHEDULED_SCRIPT_NOT_UPDATED"):
        executor.verify_scheduled_entry(settings)
    settings["backup_script_sha256"] = executor.backup.file_sha256(script)
    executor.verify_scheduled_entry(settings)
    settings["destination"] = tmp_path / "different-repository"
    with pytest.raises(executor.ExecutorError, match="SCHEDULED_STORAGE_MISMATCH"):
        executor.verify_scheduled_entry(settings)


def test_policy_has_no_job_controlled_executable_or_recovery_target(tmp_path, monkeypatch):
    monkeypatch.setattr(
        executor,
        "private_json",
        lambda _: {
            "root": str(tmp_path),
            "destination": str(tmp_path / "backups"),
            "key_file": str(tmp_path / "key"),
            "min_free_gib": 1,
            "backup_script_sha256": "a" * 64,
            "command": "untrusted",
        },
    )
    with pytest.raises(executor.ExecutorError, match="POLICY_INVALID"):
        executor.policy(tmp_path / "policy")


def test_private_policy_rejects_symlink(tmp_path):
    target = tmp_path / "target"
    target.write_text("{}")
    link = tmp_path / "policy"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("Host cannot create test symlinks")
    with pytest.raises(ValueError, match="Symlink"):
        executor.private_json(link)


def test_private_json_does_not_accept_public_parent_or_owner(tmp_path):
    path = tmp_path / "policy"
    path.write_text("{}")
    path.chmod(0o644)
    with pytest.raises((executor.ExecutorError, AttributeError)):
        executor.private_json(path)


def config(tmp_path):
    return {
        "destination": tmp_path,
        "staff_requests_per_day": 2,
        "global_requests_per_day": 6,
        "min_interval_seconds": 3600,
    }


def budget_reader(path, *, required=True):
    return json.loads(path.read_text()) if path.exists() else None


def test_host_budget_is_durable_and_counts_every_attempt(tmp_path, monkeypatch):
    monkeypatch.setattr(executor, "private_json", budget_reader)
    job = {"id": str(uuid4()), "user_id": str(uuid4())}
    executor.reserve_host_budget(config(tmp_path), job)
    ledger = json.loads((tmp_path / "manual-budget.json").read_text())
    assert ledger["attempts"][0]["job_id"] == job["id"]
    assert not list(tmp_path.glob(".manual-budget-*"))
    with pytest.raises(executor.ExecutorError, match="HOST_RATE_LIMITED"):
        executor.reserve_host_budget(
            config(tmp_path), {"id": str(uuid4()), "user_id": job["user_id"]}
        )
    ledger["attempts"][0]["at"] = (
        executor.datetime.now(executor.UTC) - timedelta(hours=2)
    ).isoformat()
    (tmp_path / "manual-budget.json").write_text(json.dumps(ledger))
    executor.reserve_host_budget(config(tmp_path), {"id": str(uuid4()), "user_id": job["user_id"]})
    ledger = json.loads((tmp_path / "manual-budget.json").read_text())
    for row in ledger["attempts"]:
        row["at"] = (executor.datetime.now(executor.UTC) - timedelta(hours=3)).isoformat()
    (tmp_path / "manual-budget.json").write_text(json.dumps(ledger))
    with pytest.raises(executor.ExecutorError, match="HOST_RATE_LIMITED"):
        executor.reserve_host_budget(
            config(tmp_path), {"id": str(uuid4()), "user_id": job["user_id"]}
        )


def test_corrupt_or_future_host_budget_fails_closed(tmp_path, monkeypatch):
    row = {
        "job_id": str(uuid4()),
        "user_id": str(uuid4()),
        "at": (executor.datetime.now(executor.UTC) + timedelta(hours=1)).isoformat(),
    }
    monkeypatch.setattr(executor, "private_json", lambda *args, **kwargs: {"attempts": [row]})
    with pytest.raises(executor.ExecutorError, match="HOST_BUDGET_INVALID"):
        executor.reserve_host_budget(
            config(tmp_path), {"id": str(uuid4()), "user_id": str(uuid4())}
        )


def test_status_drops_paths_keys_private_error_and_unverified_restore(tmp_path, monkeypatch):
    def read(path, **kwargs):
        if path.name == "status.json":
            return {
                "status": "failed",
                "failure_code": "private arbitrary error",
                "path": "/private",
                "key": "forbidden",
                "last_success_at": "2026-10-03T01:00:00+00:00",
                "repository_bytes": 12,
            }
        return {"status": "passed"}

    monkeypatch.setattr(executor, "private_json", read)
    result = executor.summary(
        {"destination": tmp_path, "min_free_gib": 2, "restore_receipt": tmp_path / "proof"}
    )
    assert result["status"] == "failed"
    assert result["restore_status"] == "unknown"
    assert result["reserve_bytes"] == 2 * 1024**3
    assert not {"path", "key", "failure_code"} & result.keys()


def test_start_authorization_and_running_authorization_are_distinct():
    db = object.__new__(executor.Database)
    statements = []
    db.sql = lambda value: statements.append(value) or "1"
    key = str(uuid4())
    assert db.authorized(key, {"session_idle_minutes": 30}, starting=True)
    assert "j.authorized_until > now()" in statements[-1]
    assert "interval '5 minutes'" in statements[-1]
    assert db.authorized(key, {"session_idle_minutes": 30})
    assert "j.authorized_until > now()" not in statements[-1]
    assert "interval '5 minutes'" not in statements[-1]
    assert "u.is_active AND u.mfa_enabled" in statements[-1]
    assert "NOT j.cancel_requested" in statements[-1]
    assert "s.expires_at > now()" in statements[-1]


def test_unknown_results_never_requeued_or_implicitly_repeated():
    db = object.__new__(executor.Database)
    statements = []
    db.sql = lambda value: statements.append(value) or ""
    db.reconcile()
    assert "state='unknown'" in statements[0]
    assert "SET state='queued'" not in statements[0]
    assert "state='running'" in statements[0]


def test_execution_ids_and_phase_prevent_untrusted_sql():
    db = object.__new__(executor.Database)
    db.sql = lambda _: pytest.fail("Rejected inputs must not reach SQL")
    with pytest.raises(ValueError):
        db.claim("not-uuid');drop table backup_jobs;--", str(uuid4()))
    with pytest.raises(executor.ExecutorError):
        db.touch(str(uuid4()), str(uuid4()), "untrusted SQL")


class FakeDB:
    def __init__(self, denied_phase=None):
        self.events = []
        self.denied_phase = denied_phase
        self.current = "queued"

    def authorized(self, key, config, *, starting=False):
        self.events.append(("authorize", starting, self.current))
        return self.current != self.denied_phase

    def claim(self, key, execution):
        self.events.append(("claim",))
        return True

    def touch(self, key, execution, phase):
        self.current = phase
        self.events.append(("touch", phase))
        return phase != self.denied_phase

    def heartbeat(self, key, execution):
        self.events.append(("heartbeat",))
        return True

    def finish(self, key, execution, state, code, result=None):
        self.events.append(("finish", state, code, result))

    def publish_status(self, value):
        self.events.append(("status",))


def child_config(tmp_path):
    script = tmp_path / "fixed-backup.py"
    script.write_text(
        "import sys,json\nfor phase in ['preflight','dump','encrypt','retention','integrity','complete']:\n print(json.dumps({'phase':phase}),flush=True)\n if sys.stdin.readline() != 'continue\\n': sys.exit(2)\n",
        encoding="utf-8",
    )
    return {
        "root": tmp_path,
        "destination": tmp_path,
        "key_file": tmp_path / "private-key",
        "min_free_gib": 1,
        "script": script,
        "nginx_sites": [],
    }


def test_actual_subprocess_requires_each_phase_ack_before_succeeding(tmp_path, monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(executor, "reserve_host_budget", lambda *args: None)
    monkeypatch.setattr(
        executor, "summary", lambda *args, **kwargs: {"status": "success", "offsite": False}
    )
    monkeypatch.setattr(
        executor,
        "record_result",
        lambda config, db, job, execution, state, code, phases, result=None: db.finish(
            job["id"], execution, state, code, result
        ),
    )
    executor.execute(child_config(tmp_path), db, {"id": str(uuid4()), "user_id": str(uuid4())})
    assert [event[1] for event in db.events if event[0] == "touch"] == [
        "preflight",
        "dump",
        "encrypt",
        "retention",
        "integrity",
        "complete",
    ]
    assert db.events[-1][:3] == ("finish", "succeeded", None)


@pytest.mark.skipif(os.name != "posix", reason="Linux process-group cancellation")
def test_revoked_permission_prevents_next_real_child_phase(tmp_path, monkeypatch):
    db = FakeDB(denied_phase="encrypt")
    monkeypatch.setattr(executor, "reserve_host_budget", lambda *args: None)
    monkeypatch.setattr(
        executor,
        "record_result",
        lambda config, db, job, execution, state, code, phases, result=None: db.finish(
            job["id"], execution, state, code, result
        ),
    )
    executor.execute(child_config(tmp_path), db, {"id": str(uuid4()), "user_id": str(uuid4())})
    assert "retention" not in [event[1] for event in db.events if event[0] == "touch"]
    assert db.events[-1][:3] == ("finish", "failed", "AUTHORIZATION_REVOKED")


def test_expired_start_does_not_launch_any_process(tmp_path, monkeypatch):
    db = FakeDB(denied_phase="queued")
    statements = []
    db.sql = lambda value: statements.append(value)
    monkeypatch.setattr(
        executor.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Expired authorization cannot start backup"),
    )
    executor.execute(child_config(tmp_path), db, {"id": str(uuid4()), "user_id": str(uuid4())})
    assert "AUTHORIZATION_REVOKED" in statements[0]


def test_capacity_reserve_is_checked_before_key_or_repository_creation(tmp_path, monkeypatch):
    root = tmp_path / "deployment"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}")
    (root / ".env").write_text("test fixture")
    destination = tmp_path / "private-backups"
    destination.mkdir()
    monkeypatch.setattr(executor.backup.os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(
        executor.backup.shutil, "disk_usage", lambda _: type("Space", (), {"free": 1})()
    )
    monkeypatch.setattr(
        executor.backup,
        "command",
        lambda *args, **kwargs: pytest.fail("Capacity must be checked before external commands"),
    )
    key = tmp_path / "new-private-key"
    with pytest.raises(ValueError, match="Insufficient backup disk reserve"):
        executor.backup._backup(root, destination, key, 10)
    assert not key.exists()
    assert not (destination / "repository").exists()


def test_key_inside_served_assets_is_rejected_before_secret_creation(tmp_path, monkeypatch):
    root = tmp_path / "deployment"
    root.mkdir()
    (root / "compose.yaml").write_text("fixture")
    (root / ".env").write_text("fixture")
    destination = tmp_path / "private-backups"
    destination.mkdir()
    maps = tmp_path / "maps"
    maps.mkdir()
    key = maps / "never-created-key"
    calls = []
    monkeypatch.setattr(executor.backup.os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(
        executor.backup.shutil, "disk_usage", lambda _: type("Space", (), {"free": 100 * 1024**3})()
    )

    def command(args, **kwargs):
        calls.append(args)
        if args[:3] == ["docker", "compose", "config"]:
            return json.dumps(
                {
                    "services": {"db": {"environment": {}}},
                    "volumes": {"map_assets": {"name": "maps"}, "floor_assets": {"name": "floors"}},
                }
            ).encode()
        return json.dumps([{"Mountpoint": str(maps)}]).encode()

    monkeypatch.setattr(executor.backup, "command", command)
    with pytest.raises(ValueError, match="Backup key cannot be included in served assets"):
        executor.backup._backup(root, destination, key, 10)
    assert not key.exists()
    assert not any(args[0] == "restic" for args in calls)


@pytest.mark.skipif(os.name != "posix", reason="Actual Linux root receipt ownership")
def test_host_receipt_is_immutable_and_precedes_published_success(tmp_path):
    if tmp_path.stat().st_uid != 0:
        pytest.skip("Root host ownership is required for a private receipt")
    config = {"destination": tmp_path, "backup_script_sha256": "a" * 64}
    db = FakeDB()
    job = {"id": str(uuid4())}
    execution = str(uuid4())
    executor.record_result(
        config, db, job, execution, "succeeded", None, ["complete"], {"status": "success"}
    )
    receipt = tmp_path / "executions" / (job["id"] + "-" + execution + ".json")
    original = receipt.read_bytes()
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert db.events[-1][:3] == ("finish", "succeeded", None)
    with pytest.raises(FileExistsError):
        executor.record_result(config, db, job, execution, "failed", "CHANGED", [], None)
    assert receipt.read_bytes() == original
    assert len(db.events) == 1
    assert not list(receipt.parent.glob(".receipt-*"))


@pytest.mark.skipif(os.name != "posix", reason="Linux flock behavior")
def test_outer_lock_serializes_actual_cli_and_worker_entrypoints(tmp_path, monkeypatch):
    # Exercise a real second flock rather than merely mirroring lock code.
    monkeypatch.setattr(executor.backup.os, "geteuid", lambda: 0)
    if tmp_path.stat().st_uid != 0:
        pytest.skip("Root host ownership is required for the private lock")
    with executor.backup.backup_lock(tmp_path):
        with pytest.raises(executor.backup.BackupBusy):
            with executor.backup.backup_lock(tmp_path):
                pytest.fail("Second caller acquired an active lock")
