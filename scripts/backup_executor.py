"""Fixed host backup executor. Run as root, never inside the public API container.

Only a root-owned policy selects deployment, repository and key. Database job
fields cannot select a path, executable, SQL, snapshot, destination or arguments.
Failure output contains controlled codes only. Supports the host Python 3.8.
"""

import argparse
import json
import os
import re
import shlex
import signal
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import backup

UTC = timezone.utc  # noqa: UP017 -- keep the maintenance script compatible with Python 3.8.
PHASES = {"preflight", "dump", "encrypt", "retention", "integrity", "complete"}
ALLOWED = {
    "root",
    "destination",
    "key_file",
    "min_free_gib",
    "nginx_sites",
    "restore_receipt",
    "requests_enabled",
    "staff_requests_per_day",
    "global_requests_per_day",
    "min_interval_seconds",
    "session_idle_minutes",
    "backup_script_sha256",
}


class ExecutorError(ValueError):
    pass


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ExecutorError("SCHEDULED_ARGUMENT_INVALID")


def private_json(path, *, required=True):
    path = backup.checked_path(path)
    if not path.exists() and not required:
        return None
    if any(parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022 for parent in path.parents):
        raise ExecutorError("PRIVATE_PARENT_INVALID")
    info = path.stat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or info.st_size > 65536
    ):
        raise ExecutorError("PRIVATE_FILE_INVALID")
    return json.loads(path.read_text(encoding="utf-8"))


def policy(path):
    value = private_json(path)
    required = {"root", "destination", "key_file", "min_free_gib", "backup_script_sha256"}
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - ALLOWED:
        raise ExecutorError("POLICY_INVALID")
    for name in ("root", "destination", "key_file"):
        if not isinstance(value[name], str) or not Path(value[name]).is_absolute():
            raise ExecutorError("POLICY_PATH_INVALID")
        value[name] = backup.checked_path(value[name])
    root = value["root"]
    if root.stat().st_uid != 0 or root.stat().st_mode & 0o022:
        raise ExecutorError("DEPLOYMENT_OWNER_INVALID")
    executable = backup.checked_path(root / "scripts/backup.py")
    if (
        executable.stat().st_uid != 0
        or executable.stat().st_mode & 0o022
        or not re.fullmatch(r"[a-f0-9]{64}", value["backup_script_sha256"])
        or backup.file_sha256(executable) != value["backup_script_sha256"]
    ):
        raise ExecutorError("BACKUP_SCRIPT_INVALID")
    value["script"] = executable
    defaults = {
        "staff_requests_per_day": 2,
        "global_requests_per_day": 6,
        "min_interval_seconds": 3600,
        "session_idle_minutes": 30,
        "requests_enabled": False,
        "nginx_sites": [],
    }
    for name, default in defaults.items():
        value.setdefault(name, default)
    for name, low, high in (
        ("min_free_gib", 1, 100000),
        ("staff_requests_per_day", 1, 2),
        ("global_requests_per_day", 1, 6),
        ("min_interval_seconds", 3600, 86400),
        ("session_idle_minutes", 1, 30),
    ):
        if type(value[name]) is not int or not low <= value[name] <= high:
            raise ExecutorError("POLICY_LIMIT_INVALID")
    if (
        type(value["requests_enabled"]) is not bool
        or not isinstance(value["nginx_sites"], list)
        or len(value["nginx_sites"]) > 10
    ):
        raise ExecutorError("POLICY_INVALID")
    sites = []
    for item in value["nginx_sites"]:
        site = backup.checked_path(item)
        if (
            site.parent != Path("/etc/nginx/sites-available")
            or not site.is_file()
            or site.stat().st_size > 1024 * 1024
        ):
            raise ExecutorError("NGINX_PATH_INVALID")
        sites.append(site)
    value["nginx_sites"] = sites
    if value.get("restore_receipt"):
        value["restore_receipt"] = backup.checked_path(value["restore_receipt"])
    if backup.inside(value["destination"], root) or backup.inside(root, value["destination"]):
        raise ExecutorError("DESTINATION_INVALID")
    value["destination"].mkdir(parents=True, exist_ok=True, mode=0o700)
    info = value["destination"].stat()
    if info.st_uid != 0 or info.st_mode & 0o077:
        raise ExecutorError("DESTINATION_INVALID")
    return value


def verify_scheduled_entry(config):
    """A legacy frozen timer must not bypass the new whole-task lock."""
    raw = subprocess.run(
        ["systemctl", "show", "twinnku-backup.service", "--property=ExecStart", "--value"],
        check=True,
        capture_output=True,
        timeout=15,
    ).stdout.decode()
    entries = re.findall(r"argv\[\]=(.*?) ;", raw)
    if len(entries) != 1:
        raise ExecutorError("SCHEDULED_ENTRY_INVALID")
    args = shlex.split(entries[0])
    if len(args) < 2 or args[0] != "/usr/bin/python3":
        raise ExecutorError("SCHEDULED_ENTRY_INVALID")
    path = backup.checked_path(args[1])
    if (
        not path.is_file()
        or path.stat().st_uid != 0
        or path.stat().st_mode & 0o022
        or backup.file_sha256(path) != config["backup_script_sha256"]
    ):
        raise ExecutorError("SCHEDULED_SCRIPT_NOT_UPDATED")
    parser = SafeParser(add_help=False)
    parser.add_argument("--root", default=str(path.parent.parent))
    parser.add_argument("--destination", default="/var/backups/twinnku")
    parser.add_argument("--key-file", default="/etc/twinnku/backup-password")
    parser.add_argument("--min-free-gib", type=int, default=10)
    parser.add_argument("--nginx-site", action="append", default=[])
    values, unknown = parser.parse_known_args(args[2:])
    if (
        unknown
        or any(
            backup.checked_path(getattr(values, name)) != config[name]
            for name in ("root", "destination", "key_file")
        )
        or values.min_free_gib < config["min_free_gib"]
        or {backup.checked_path(item) for item in values.nginx_site} != set(config["nginx_sites"])
    ):
        raise ExecutorError("SCHEDULED_STORAGE_MISMATCH")


def iso(value):
    if not isinstance(value, str):
        raise ExecutorError("TIMESTAMP_INVALID")
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ExecutorError("TIMESTAMP_INVALID")
    return timestamp.astimezone(UTC)


def uuid(value):
    return str(UUID(value))


def literal(value):
    """Only serialized summaries enter text SQL; identifiers are separately UUIDs."""
    return "'" + value.replace("'", "''") + "'"


class Database:
    def __init__(self, config):
        self.root = config["root"]
        self.requests_enabled = config["requests_enabled"]
        result = backup.command(["docker", "compose", "config", "--format", "json"], cwd=self.root)
        deployment = json.loads(result)
        env = deployment["services"]["db"]["environment"]
        self.user, self.name = env["POSTGRES_USER"], env["POSTGRES_DB"]
        if not all(
            isinstance(value, str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", value)
            for value in (self.user, self.name)
        ):
            raise ExecutorError("DATABASE_IDENTITY_INVALID")

    def sql(self, statement):
        # No password in argv and no API owner credentials; local socket inside
        # the existing DB is accessible only to the trusted root host service.
        result = subprocess.run(
            [
                "docker",
                "compose",
                "exec",
                "-T",
                "db",
                "psql",
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                self.user,
                "-d",
                self.name,
            ],
            input=statement.encode(),
            cwd=self.root,
            capture_output=True,
            timeout=30,
            check=True,
        )
        if len(result.stdout) > 65536:
            raise ExecutorError("DATABASE_RESULT_TOO_LARGE")
        return result.stdout.decode().strip()

    def authorized(self, key, config, *, starting=False):
        key = uuid(key)
        initial = (
            "AND j.authorized_until > now() AND s.mfa_verified_at + interval '5 minutes' > now()"
            if starting
            else ""
        )
        return (
            self.sql(
                "SELECT count(*) FROM backup_jobs j JOIN staff_users u ON u.id=j.user_id JOIN staff_sessions s ON s.public_id=j.request_session_id AND s.user_id=u.id JOIN backup_grants g ON g.user_id=u.id AND g.permission='backup.request' WHERE j.id="
                + literal(key)
                + " AND u.is_active AND u.mfa_enabled AND NOT j.cancel_requested AND s.expires_at > now() AND s.mfa_verified_at <= now() AND j.mfa_verified_at <= now() AND s.last_activity_at + interval '"
                + str(config["session_idle_minutes"])
                + " minutes' > now() AND s.mfa_verified_at >= j.mfa_verified_at "
                + initial
                + ";"
            )
            == "1"
        )

    def publish_status(self, summary):
        summary = {"summary": summary, "requests_enabled": self.requests_enabled}
        self.sql(
            "INSERT INTO backup_status(id, observed_at, summary) VALUES(1,now(),"
            + literal(json.dumps(summary, separators=(",", ":")))
            + "::json) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at, summary=excluded.summary;"
        )

    def reconcile(self):
        # Never repeat an execution whose result is unknown.
        self.sql(
            "UPDATE backup_jobs SET state='expired',finished_at=now(),failure_code='AUTHORIZATION_EXPIRED' WHERE state='queued' AND authorized_until<=now(); UPDATE backup_jobs SET state='cancelled',finished_at=now(),failure_code='CANCELLED' WHERE state='queued' AND cancel_requested; UPDATE backup_jobs SET state='unknown',failure_code='EXECUTION_RESULT_UNKNOWN' WHERE state='running' AND (lease_until IS NULL OR lease_until<=now());"
        )

    def next_job(self):
        value = self.sql(
            "SELECT json_build_object('id',id,'user_id',user_id) FROM backup_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1;"
        )
        if not value:
            return None
        value = json.loads(value)
        return {name: uuid(value[name]) for name in ("id", "user_id")}

    def claim(self, key, execution):
        return self.sql(
            "UPDATE backup_jobs SET state='running',phase='preflight',started_at=now(),execution_id="
            + literal(uuid(execution))
            + ",lease_until=now()+interval '90 seconds' WHERE id="
            + literal(uuid(key))
            + " AND state='queued' AND NOT cancel_requested AND authorized_until>now() RETURNING id;"
        ) == uuid(key)

    def touch(self, key, execution, phase):
        if phase not in PHASES:
            raise ExecutorError("PHASE_INVALID")
        return self.sql(
            "UPDATE backup_jobs SET phase="
            + literal(phase)
            + ",lease_until=now()+interval '90 seconds' WHERE id="
            + literal(uuid(key))
            + " AND execution_id="
            + literal(uuid(execution))
            + " AND state='running' RETURNING id;"
        ) == uuid(key)

    def heartbeat(self, key, execution):
        return self.sql(
            "UPDATE backup_jobs SET lease_until=now()+interval '90 seconds' WHERE id="
            + literal(uuid(key))
            + " AND execution_id="
            + literal(uuid(execution))
            + " AND state='running' RETURNING id;"
        ) == uuid(key)

    def finish(self, key, execution, state, code, result=None):
        if state not in {"succeeded", "failed", "unknown", "cancelled", "expired"} or (
            code and not re.fullmatch(r"[A-Z_]{1,48}", code)
        ):
            raise ExecutorError("RESULT_INVALID")
        result_sql = (
            "NULL"
            if result is None
            else literal(json.dumps(result, separators=(",", ":"))) + "::json"
        )
        self.sql(
            "UPDATE backup_jobs SET state="
            + literal(state)
            + ",finished_at=now(),lease_until=NULL,failure_code="
            + (literal(code) if code else "NULL")
            + ",result="
            + result_sql
            + " WHERE id="
            + literal(uuid(key))
            + " AND execution_id="
            + literal(uuid(execution))
            + " AND state='running';"
        )


def summary(config, *, snapshots=False):
    result = {
        "status": "unknown",
        "coverage": [],
        "offsite": False,
        "snapshots": [],
        "restore_status": "unknown",
    }
    source = private_json(config["destination"] / "status.json", required=False)
    if source:
        if not isinstance(source, dict) or source.get("status") not in {
            "success",
            "failed",
            "running",
        }:
            raise ExecutorError("STATUS_INVALID")
        result["status"] = source["status"]
        for name in ("last_success_at", "attempted_at"):
            if source.get(name):
                result[name] = iso(source[name]).isoformat()
        value = source.get("repository_bytes")
        if value is not None:
            if type(value) is not int or value < 0:
                raise ExecutorError("STATUS_INVALID")
            result["repository_bytes"] = value
        if source.get("last_success_at"):
            result["coverage"] = ["database", "maps", "uploaded_media", "deployment_configuration"]
    result["free_bytes"] = backup.shutil.disk_usage(config["destination"]).free
    result["reserve_bytes"] = config["min_free_gib"] * 1024**3
    if config.get("restore_receipt"):
        proof = private_json(config["restore_receipt"], required=False)
        # A generic unrelated JSON status is insufficient to claim restoration.
        if (
            isinstance(proof, dict)
            and proof.get("status") == "passed"
            and proof.get("production_modified") is False
            and proof.get("content_unchanged") is True
            and proof.get("runtime_role_verified") is True
            and re.fullmatch(r"[a-f0-9]{64}", proof.get("backup_dump_sha256", ""))
            and re.fullmatch(r"[a-f0-9]{64}", proof.get("restore_receipt_sha256", ""))
        ):
            result["restore_status"] = "passed"
            if proof.get("verified_at"):
                result["restore_verified_at"] = iso(proof["verified_at"]).isoformat()
    if snapshots and (config["destination"] / "repository/config").is_file():
        env = {
            **os.environ,
            "RESTIC_REPOSITORY": str(config["destination"] / "repository"),
            "RESTIC_PASSWORD_FILE": str(config["key_file"]),
            "XDG_CACHE_HOME": "/var/cache/twinnku",
        }
        raw = subprocess.run(
            ["restic", "snapshots", "--json", "--tag", "twinnku-complete"],
            env=env,
            capture_output=True,
            check=True,
            timeout=60,
        ).stdout
        if len(raw) > 1024 * 1024:
            raise ExecutorError("SNAPSHOT_RESULT_TOO_LARGE")
        items = json.loads(raw)
        for item in sorted(items, key=lambda row: iso(row["time"]), reverse=True)[:20]:
            if not re.fullmatch(r"[a-f0-9]{64}", item["id"]):
                raise ExecutorError("SNAPSHOT_INVALID")
            result["snapshots"].append(
                {"id": item["id"], "created_at": iso(item["time"]).isoformat()}
            )
    return result


def reserve_host_budget(config, job):
    # API/DB cannot relax this private host ledger. Charge attempts before start.
    path = config["destination"] / "manual-budget.json"
    ledger = private_json(path, required=False) or {"attempts": []}
    if (
        set(ledger) != {"attempts"}
        or not isinstance(ledger["attempts"], list)
        or len(ledger["attempts"]) > 100
    ):
        raise ExecutorError("HOST_BUDGET_INVALID")
    now = datetime.now(UTC)
    attempts = []
    for row in ledger["attempts"]:
        if set(row) != {"job_id", "user_id", "at"}:
            raise ExecutorError("HOST_BUDGET_INVALID")
        uuid(row["job_id"])
        uuid(row["user_id"])
        if iso(row["at"]) > now + timedelta(seconds=30):
            raise ExecutorError("HOST_BUDGET_INVALID")
        if iso(row["at"]) > now - timedelta(days=1):
            attempts.append(row)
    if (
        len(attempts) >= config["global_requests_per_day"]
        or sum(row["user_id"] == job["user_id"] for row in attempts)
        >= config["staff_requests_per_day"]
        or any(
            iso(row["at"]) > now - timedelta(seconds=config["min_interval_seconds"])
            for row in attempts
        )
    ):
        raise ExecutorError("HOST_RATE_LIMITED")
    attempts.append({"job_id": job["id"], "user_id": job["user_id"], "at": now.isoformat()})
    temporary = path.with_name(".manual-budget-" + str(uuid4()))
    try:
        backup.private_file(temporary, json.dumps({"attempts": attempts}).encode())
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
        if os.name == "posix":
            parent_fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def kill(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)


def record_result(config, db, job, execution, state, code, phases, result=None):
    """Archive an immutable, non-secret host receipt before publishing success."""
    directory = backup.checked_path(config["destination"] / "executions")
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.stat()
    if info.st_uid != 0 or info.st_mode & 0o077:
        raise ExecutorError("RECEIPT_DIRECTORY_INVALID")
    receipt = {
        "format_version": 1,
        "job_id": uuid(job["id"]),
        "execution_id": uuid(execution),
        "purpose": "complete_encrypted_local_backup",
        "state": state,
        "failure_code": code,
        "phases": phases,
        "recorded_at": datetime.now(UTC).isoformat(),
        "backup_script_sha256": config["backup_script_sha256"],
        "summary": result,
    }
    filename = directory / (receipt["job_id"] + "-" + receipt["execution_id"] + ".json")
    temporary = directory / (".receipt-" + str(uuid4()))
    try:
        backup.private_file(temporary, json.dumps(receipt, separators=(",", ":")).encode())
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        # link is atomic and refuses an existing final receipt; no overwrite.
        os.link(str(temporary), str(filename), follow_symlinks=False)
        temporary.unlink()
        if os.name == "posix":
            fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if temporary.exists():
            temporary.unlink()
    db.finish(job["id"], execution, state, code, result)


def execute(config, db, job):
    execution = str(uuid4())
    if not db.authorized(job["id"], config, starting=True):
        db.sql(
            "UPDATE backup_jobs SET state='expired',finished_at=now(),failure_code='AUTHORIZATION_REVOKED' WHERE id="
            + literal(job["id"])
            + " AND state='queued';"
        )
        return
    if not db.claim(job["id"], execution):
        return
    try:
        reserve_host_budget(config, job)
    except ExecutorError as exc:
        record_result(config, db, job, execution, "failed", str(exc), [])
        return
    args = [
        sys.executable,
        str(config["script"]),
        "--root",
        str(config["root"]),
        "--destination",
        str(config["destination"]),
        "--key-file",
        str(config["key_file"]),
        "--min-free-gib",
        str(config["min_free_gib"]),
        "--progress-json",
        "--progress-ack",
    ]
    for site in config["nginx_sites"]:
        args.extend(["--nginx-site", str(site)])
    process = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "XDG_CACHE_HOME": "/var/cache/twinnku"},
        start_new_session=True,
    )
    phases = []
    stop = threading.Event()
    failure = []

    def read_progress():
        try:
            while True:
                line = process.stdout.readline(257)
                if not line:
                    break
                if len(line) >= 257:
                    failure.append("EXECUTOR_OUTPUT_INVALID")
                    kill(process)
                    break
                if line.startswith(b"{"):
                    value = json.loads(line)
                    if set(value) != {"phase"} or value["phase"] not in PHASES:
                        raise ExecutorError("EXECUTOR_OUTPUT_INVALID")
                    if not db.authorized(job["id"], config) or not db.touch(
                        job["id"], execution, value["phase"]
                    ):
                        failure.append("AUTHORIZATION_REVOKED")
                        kill(process)
                        break
                    phases.append(value["phase"])
                    process.stdin.write(b"continue\n")
                    process.stdin.flush()
        except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
            failure.append("EXECUTOR_PROGRESS_UNKNOWN")
            kill(process)
        finally:
            stop.set()

    reader = threading.Thread(target=read_progress, daemon=True)
    reader.start()
    deadline = time.monotonic() + 1800
    try:
        while not stop.wait(20):
            if time.monotonic() >= deadline:
                failure.append("EXECUTION_TIMEOUT")
                kill(process)
                break
            if not db.authorized(job["id"], config) or not db.heartbeat(job["id"], execution):
                failure.append("AUTHORIZATION_REVOKED")
                kill(process)
                break
            db.publish_status(summary(config))
        process.wait(timeout=20)
    except (OSError, ValueError, subprocess.SubprocessError):
        failure.append("EXECUTION_RESULT_UNKNOWN")
        kill(process)
    finally:
        reader.join(timeout=15)
        process.stdin.close()
        process.stdout.close()
    if failure:
        code = failure[0]
        record_result(
            config, db, job, execution, "unknown" if "UNKNOWN" in code else "failed", code, phases
        )
    elif process.returncode == 0 and phases == [
        "preflight",
        "dump",
        "encrypt",
        "retention",
        "integrity",
        "complete",
    ]:
        result = summary(config, snapshots=True)
        if result["status"] != "success":
            record_result(config, db, job, execution, "unknown", "EXECUTION_RESULT_UNKNOWN", phases)
        else:
            record_result(config, db, job, execution, "succeeded", None, phases, result)
    else:
        record_result(config, db, job, execution, "failed", "BACKUP_COMMAND_FAILED", phases)


def run(config):
    import fcntl

    lock_path = config["destination"] / ".executor.lock"
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
            raise ExecutorError("EXECUTOR_LOCK_INVALID")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # An existing bounded execution owns this timer tick.
        db = Database(config)
        db.reconcile()
        db.publish_status(summary(config, snapshots=True))
        if config["requests_enabled"]:
            job = db.next_job()
            if job:
                execute(config, db, job)
        db.publish_status(summary(config, snapshots=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=Path("/etc/twinnku/backup-executor.json"))
    args = parser.parse_args()
    phase = "policy"
    try:
        if os.geteuid() != 0:
            raise ExecutorError("ROOT_REQUIRED")
        config = policy(args.policy)
        verify_scheduled_entry(config)
        phase = "execute"
        run(config)
        print(json.dumps({"status": "completed", "phase": phase}))
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
        print(json.dumps({"status": "failed", "phase": phase}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
