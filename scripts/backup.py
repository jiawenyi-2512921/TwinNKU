"""Encrypted, complete local backup. Requires root, Docker Compose and restic.

Database dumps are transactionally consistent; uploaded published assets are
immutable. Hold the maintenance lock during imports/garbage collection too.
Secrets and dump contents are never written to logs.
"""

import argparse
import hashlib
import json
import os
import secrets
import shutil
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

UTC = timezone.utc  # noqa: UP017 -- the Ubuntu host runs Python 3.8.


class StorageLocationError(ValueError):
    """An invalid destination must not receive even a failure-status write."""


def inside(path, parent):
    try:
        return os.path.commonpath([str(path), str(parent)]) == str(parent)
    except ValueError:
        return False  # Distinct Windows drives cannot contain one another.


def checked_path(path):
    """Check the supplied spelling before resolve erases a symlink."""
    path = Path(os.path.abspath(path))
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError("Symlink paths are not permitted for backup storage")
    return path.resolve()


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root):
    count, size = 0, 0
    for path in root.rglob("*"):
        if path.name == ".maintenance.lock" or any(
            part.startswith(".staging-") for part in path.relative_to(root).parts
        ):
            continue
        mode = path.lstat().st_mode
        if stat.S_ISREG(mode):
            count += 1
            size += path.stat().st_size
        elif not stat.S_ISDIR(mode):
            raise ValueError("Backup assets must contain only directories and regular files")
    return {"files": count, "bytes": size}


@contextmanager
def maintenance_lock(path):
    import fcntl

    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o660)
    with os.fdopen(fd, "r+b") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("Maintenance lock must be a regular file")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Set permissions on the opened inode, never on a symlink supplied by assets.
        os.fchown(lock.fileno(), 10001, 10001)
        os.fchmod(lock.fileno(), 0o660)
        yield


def write_status(destination, status):
    destination = checked_path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.stat().st_uid != getattr(os, "geteuid", lambda: 0)():
        raise StorageLocationError("Backup status directory has an unexpected owner")
    destination.chmod(0o700)
    fd, filename = tempfile.mkstemp(prefix=".status-", dir=destination)
    temporary = Path(filename)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(status, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(str(temporary), str(destination / "status.json"))
    finally:
        if temporary.exists():
            temporary.unlink()


def command(args, *, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=True).stdout


def private_file(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)


def backup(root: Path, destination: Path, key_file: Path, min_free_gib: int, nginx_sites=()):
    root, destination, key_file = (
        checked_path(root),
        checked_path(destination),
        checked_path(key_file),
    )
    if os.geteuid() != 0:
        raise ValueError("Backup must run as root")
    if not (root / "compose.yaml").is_file() or not (root / ".env").is_file():
        raise ValueError("Missing deployment configuration")
    checked_path(root / "compose.yaml")
    checked_path(root / ".env")
    sites = [checked_path(path) for path in nginx_sites]
    if len(sites) > 10 or any(
        path.parent != Path("/etc/nginx/sites-available")
        or not path.is_file()
        or path.stat().st_size > 1024 * 1024
        for path in sites
    ):
        raise ValueError("Only explicit small Nginx site configuration files may be included")
    if inside(destination, root) or inside(root, destination):
        raise StorageLocationError("Backup destination must be outside the deployment")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.stat().st_uid != 0:
        raise StorageLocationError("Backup destination must belong to root")
    destination.chmod(0o700)
    if min_free_gib < 1:
        raise ValueError("A positive disk reserve is required")
    if shutil.disk_usage(destination).free < min_free_gib * 1024**3:
        raise ValueError("Insufficient backup disk reserve")
    key_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not key_file.exists():
        private_file(key_file, secrets.token_hex(32).encode())
    key_stat = key_file.stat()
    if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_uid != 0 or key_stat.st_mode & 0o077:
        raise ValueError("Backup key must be a private regular file")
    env = {
        **os.environ,
        "RESTIC_REPOSITORY": str(destination / "repository"),
        "RESTIC_PASSWORD_FILE": str(key_file),
    }
    checked_path(destination / "repository")
    if not (destination / "repository/config").is_file():
        command(["restic", "init"], env=env)
    config = json.loads(command(["docker", "compose", "config", "--format", "json"], cwd=root))
    db = config["services"]["db"]["environment"]
    volumes = {}
    for name in ("map_assets", "floor_assets"):
        volume_name = config["volumes"][name]["name"]
        details = json.loads(command(["docker", "volume", "inspect", volume_name]))[0]
        path = Path(details["Mountpoint"]).resolve()
        if inside(destination, path) or inside(path, destination):
            raise StorageLocationError("Backup repository cannot overlap served assets")
        if inside(key_file, path):
            raise ValueError("Backup key cannot be included in served assets")
        volumes[name] = str(path)
    lock_path = Path(volumes["floor_assets"]) / ".maintenance.lock"
    with maintenance_lock(lock_path):
        with tempfile.TemporaryDirectory(prefix=".staging-", dir=destination) as staging_name:
            staging = Path(staging_name)
            dump_path = staging / "database.dump"
            with dump_path.open("wb") as stream:
                subprocess.run(
                    [
                        "docker",
                        "compose",
                        "exec",
                        "-T",
                        "db",
                        "pg_dump",
                        "-U",
                        db["POSTGRES_USER"],
                        "-d",
                        db["POSTGRES_DB"],
                        "-Fc",
                        "--no-owner",
                        "--no-acl",
                    ],
                    cwd=root,
                    stdout=stream,
                    stderr=subprocess.PIPE,
                    check=True,
                )
            if not dump_path.stat().st_size:
                raise ValueError("Empty database dump")
            database_meta = json.loads(
                command(
                    [
                        "docker",
                        "compose",
                        "exec",
                        "-T",
                        "db",
                        "psql",
                        "-X",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-U",
                        db["POSTGRES_USER"],
                        "-d",
                        db["POSTGRES_DB"],
                        "-At",
                        "-c",
                        "SELECT json_build_object('schema_tables', (SELECT json_agg(tablename ORDER BY tablename) FROM pg_catalog.pg_tables WHERE schemaname='public'), 'migration_heads', (SELECT json_agg(version_num) FROM alembic_version));",
                    ],
                    cwd=root,
                )
            )
            shutil.copyfile(root / ".env", staging / "deployment.env")
            shutil.copyfile(root / "compose.yaml", staging / "compose.yaml")
            staged_files = ["database.dump", "deployment.env", "compose.yaml"]
            host_sites = {}
            for index, site in enumerate(sites):
                name = f"host-nginx-{index}.conf"
                shutil.copyfile(site, staging / name)
                staged_files.append(name)
                host_sites[name] = str(site)
            for name in staged_files:
                (staging / name).chmod(0o600)
            manifest = {
                "format_version": 1,
                "created_at": datetime.now(UTC).isoformat(),
                "database": db["POSTGRES_DB"],
                "volumes": volumes,
                "staging": staging_name,
                "files": {name: file_sha256(staging / name) for name in staged_files},
                "host_nginx_files": host_sites,
                "inventory": {name: inventory(Path(path)) for name, path in volumes.items()},
                **database_meta,
            }
            (staging / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            command(
                ["restic", "backup", "--tag", "twinnku-complete", str(staging), *volumes.values()],
                env=env,
            )
        command(
            [
                "restic",
                "forget",
                "--tag",
                "twinnku-complete",
                "--group-by",
                "tags",
                "--keep-daily",
                "14",
                "--keep-weekly",
                "4",
                "--prune",
            ],
            env=env,
        )
        command(["restic", "check"], env=env)
    return {
        "status": "success",
        "last_success_at": datetime.now(UTC).isoformat(),
        "repository_bytes": sum(
            p.stat().st_size for p in (destination / "repository").rglob("*") if p.is_file()
        ),
        "coverage": ["database", "maps", "uploaded_media", "deployment_configuration"],
        "offsite": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--destination", type=Path, default=Path("/var/backups/twinnku"))
    parser.add_argument("--key-file", type=Path, default=Path("/etc/twinnku/backup-password"))
    parser.add_argument("--min-free-gib", type=int, default=10)
    parser.add_argument(
        "--nginx-site",
        type=Path,
        action="append",
        default=[],
        help="Explicit /etc/nginx/sites-available file; excludes TLS and SSH private keys",
    )
    args = parser.parse_args()
    status_path = args.destination / "status.json"
    previous = {}
    if status_path.is_file() and not status_path.is_symlink():
        try:
            previous = json.loads(status_path.read_text(encoding="utf-8"))
            if not isinstance(previous, dict):
                previous = {}
        except (ValueError, OSError):
            pass
    try:
        status = backup(
            args.root, args.destination, args.key_file, args.min_free_gib, args.nginx_site
        )
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as exc:
        if isinstance(exc, StorageLocationError):
            raise SystemExit(
                "Backup storage location rejected; no status file was written"
            ) from None
        status = {
            **previous,
            "status": "failed",
            "failure_code": type(exc).__name__,
            "attempted_at": datetime.now(UTC).isoformat(),
        }
        print("Complete encrypted backup failed; see private operations status")
    try:
        write_status(args.destination, status)
    except (OSError, ValueError):
        raise SystemExit("Backup status could not be safely recorded") from None
    if status["status"] != "success":
        raise SystemExit(1)
    print("Complete encrypted backup and repository integrity check passed")


if __name__ == "__main__":
    main()
