"""Validate recovery in a NEW private directory and isolated PostgreSQL.

This is a restore drill, never a production cutover. It does not copy recovered
configuration into /etc, start the application or expose a port. Python 3.8+.
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import wave
from pathlib import Path, PurePosixPath
from uuid import uuid4

from backup import checked_path, file_sha256, inside, inventory, private_file

REQUIRED_TABLES = {
    "alembic_version",
    "campuses",
    "points",
    "maps",
    "point_geometries",
    "floors",
    "floor_uploads",
    "panoramas",
    "resource_changes",
    "experiences",
    "experience_uploads",
    "point_changes",
    "staff_users",
    "admin_audit",
    "guide_settings",
    "navigation_graphs",
}

RESTORE_PAID_JOBS_SQL = (
    "UPDATE narration_jobs SET state='paused', lease_until=NULL, "
    "lease_version=lease_version+1, last_error='RESTORED_REQUIRES_REVIEW' "
    "WHERE state IN ('queued','running','unknown');"
)

RESTORE_ACTOR = "maintenance.database-restore"
RESTORE_AUTH_TABLES = {
    "staff_users", "staff_sessions", "staff_credentials", "staff_mfa_challenges",
    "staff_recovery_codes", "admin_audit", "public_agent_sessions",
    "public_agent_requests", "public_agent_capabilities", "public_agent_leases",
    "public_agent_counters",
}
RESTORE_STOPS = ("chat", "voice", "narration_generation", "narration_playback", "navigation")


def recovery_security_sql(tables, batch_sha):
    """Quarantine a restored database; no content, attempt count or budget reset.

    This is called only after isolated restore verification, before any app or
    worker starts. Frozen table names support the existing 0012 backup baseline.
    Account identity is retained for content attribution; authorization is not.
    """
    tables = set(tables)
    if not RESTORE_AUTH_TABLES.issubset(tables) or not re.fullmatch(r"[0-9a-f]{64}", batch_sha):
        raise ValueError("Recovery authentication schema or batch identity is incomplete")
    actor_id, audit_id = str(uuid4()), str(uuid4())
    statements = [
        "BEGIN;",
        "SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';",
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM staff_users WHERE username='" + RESTORE_ACTOR + "' "
        "AND (is_active OR role<>'viewer' OR campus_ids::jsonb<>'[]'::jsonb OR point_ids::jsonb<>'[]'::jsonb)) "
        "THEN RAISE EXCEPTION 'Recovery audit identity is not disabled and scopeless'; END IF; END $$;",
        "INSERT INTO staff_users (id,username,display_name,password_hash,role,campus_ids,point_ids,"
        "is_active,must_change_password,mfa_enabled,mfa_recovery_until,revision,created_at,updated_at) "
        f"VALUES ('{actor_id}','{RESTORE_ACTOR}','数据库恢复维护（不可登录）','!disabled',"
        "'viewer','[]','[]',false,true,true,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) "
        "ON CONFLICT (username) DO NOTHING;",
    ]
    for name in ("staff_sessions", "staff_mfa_challenges", "staff_credentials", "staff_recovery_codes",
                 "public_agent_requests", "public_agent_capabilities", "public_agent_leases",
                 "public_agent_sessions", "configuration_grants", "backup_grants", "backup_status"):
        if name in tables:
            statements.append(f"DELETE FROM {name};")
    statements.append(
        f"UPDATE staff_users SET is_active=false,password_hash='!restore:{batch_sha}',role='viewer',"
        "campus_ids='[]',point_ids='[]',must_change_password=true,mfa_enabled=true,mfa_recovery_until=NULL,"
        f"revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE username<>'{RESTORE_ACTOR}';"
    )
    if "narration_jobs" in tables:
        statements.append(RESTORE_PAID_JOBS_SQL)
    if "backup_jobs" in tables:
        statements.append(
            "UPDATE backup_jobs SET state='expired',lease_until=NULL,execution_id=NULL,cancel_requested=true,"
            "authorized_until=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP,"
            "failure_code='RESTORED_REQUIRES_REVIEW' WHERE state IN ('queued','running','unknown');"
        )
    if "backup_control" in tables:
        statements.append("UPDATE backup_control SET generation=generation+1;")
    if "configuration_emergency_stops" in tables:
        values = ",".join(f"('{service}')" for service in RESTORE_STOPS)
        statements.append(
            "INSERT INTO configuration_emergency_stops(service,revision,stopped,reason,actor_id,updated_at) "
            "SELECT services.name,1,true,'数据库恢复隔离：须核对当前权限、预算及停用记录',staff.id,CURRENT_TIMESTAMP "
            f"FROM (VALUES {values}) AS services(name) CROSS JOIN staff_users AS staff "
            f"WHERE staff.username='{RESTORE_ACTOR}' ON CONFLICT (service) DO UPDATE "
            "SET revision=configuration_emergency_stops.revision+1,stopped=true,reason=EXCLUDED.reason,"
            "actor_id=EXCLUDED.actor_id,updated_at=EXCLUDED.updated_at;"
        )
    statements.extend([
        "INSERT INTO admin_audit(id,actor_id,actor_name,action,campus_id,point_id,note,details,created_at) "
        f"SELECT '{audit_id}',id,display_name,'system.restore_quarantine',NULL,NULL,"
        "'恢复隔离：旧身份和临时许可撤销，成员须核对现行权限后重新登记',"
        f"json_build_object('batch_sha256','{batch_sha}','permissions_reset',true,'paid_resume_allowed',false),"
        f"CURRENT_TIMESTAMP FROM staff_users WHERE username='{RESTORE_ACTOR}';",
        "COMMIT;",
    ])
    return "\n".join(statements)


def recovery_security_summary_sql(tables):
    tables = set(tables)
    if not RESTORE_AUTH_TABLES.issubset(tables):
        raise ValueError("Recovery authentication schema is incomplete")
    empty = [name for name in ("staff_sessions", "staff_mfa_challenges", "staff_credentials",
                              "staff_recovery_codes", "public_agent_requests", "public_agent_capabilities",
                              "public_agent_leases", "public_agent_sessions", "configuration_grants",
                              "backup_grants", "backup_status") if name in tables]
    cleared = " AND ".join(f"NOT EXISTS (SELECT 1 FROM {name})" for name in empty)
    entries = [
        f"'credentials_and_permissions_cleared', ({cleared})",
        "'staff_quarantined', NOT EXISTS(SELECT 1 FROM staff_users WHERE is_active OR role<>'viewer' "
        "OR campus_ids::jsonb<>'[]'::jsonb OR point_ids::jsonb<>'[]'::jsonb OR mfa_recovery_until IS NOT NULL)",
        "'quota_fingerprint', (SELECT md5(COALESCE(json_agg(row_to_json(counter))::text,'[]')) "
        "FROM (SELECT key,amount,expires_at FROM public_agent_counters ORDER BY key) counter)",
    ]
    if "configuration_emergency_stops" in tables:
        values = ",".join(f"'{name}'" for name in RESTORE_STOPS)
        entries.append("'services_stopped', (SELECT count(*)=5 FROM configuration_emergency_stops "
                       f"WHERE service IN ({values}) AND stopped)")
    if "narration_jobs" in tables:
        entries.append("'paid_jobs_paused', NOT EXISTS(SELECT 1 FROM narration_jobs WHERE state IN ('queued','running','unknown'))")
    if "backup_jobs" in tables:
        entries.append("'backup_jobs_frozen', NOT EXISTS(SELECT 1 FROM backup_jobs WHERE state IN ('queued','running','unknown'))")
    return "SELECT json_build_object(" + ",".join(entries) + ");"


def quarantine_recovered_database(container, tables, batch_sha):
    prefix = ["docker", "exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1",
              "-U", "postgres", "-d", "postgres", "-At", "-c"]
    query = recovery_security_summary_sql(tables)
    before = json.loads(run([*prefix, query]))
    run([*prefix, recovery_security_sql(tables, batch_sha)])
    after = json.loads(run([*prefix, query]))
    if (any(value is not True for key, value in after.items() if key != "quota_fingerprint")
            or after["quota_fingerprint"] != before["quota_fingerprint"]):
        raise ValueError("Recovered authentication quarantine or budget preservation failed")
    return {**{key: value for key, value in after.items() if key != "quota_fingerprint"},
            "quota_rows_preserved": True, "paid_resume_allowed": False,
            "account_reenrollment_required": True}


def run(args, *, env=None, stdin=None):
    return subprocess.run(args, env=env, stdin=stdin, check=True, capture_output=True).stdout


def require_database_image(image, image_id):
    """Resolve a reviewed local candidate to its immutable ID; never pull/fallback."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:@_-]*", image) or not re.fullmatch(
        r"sha256:[0-9a-f]{64}", image_id
    ):
        raise ValueError("Recovery requires an explicit image and immutable image ID")
    metadata = json.loads(run(["docker", "image", "inspect", "--format", "{{json .}}", image]))
    if metadata.get("Id") != image_id or metadata.get("Config", {}).get("User") not in {
        "postgres", "70", "70:70"
    }:
        raise ValueError("Recovery image ID or nonroot user differs from the selected candidate")
    run(
        [
            "docker", "run", "--rm", "--read-only", "--network", "none", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--entrypoint", "sh", image_id, "-ec",
            'test "$(id -u):$(id -g)" = 70:70; test ! -e /usr/local/bin/gosu; ! command -v gosu',
        ]
    )
    return image_id


def restore_path(target, original):
    """Interpret snapshot Unix paths without accepting parent traversal or links."""
    path = PurePosixPath(original)
    if not path.is_absolute() or path == PurePosixPath("/") or ".." in path.parts:
        raise ValueError("Recovery manifest contains an invalid absolute path")
    candidate = target.joinpath(*path.parts[1:])
    checked_path(candidate)
    if not inside(candidate.resolve(), target.resolve()):
        raise ValueError("Recovery manifest path escaped the private destination")
    return candidate


def prepare_target(target, repository, key_file, deployment_root):
    target = checked_path(target)
    if target.exists():
        raise ValueError("Recovery requires a new destination")
    protected = [
        checked_path(repository),
        checked_path(key_file),
        checked_path(deployment_root),
        Path("/var/lib/docker"),
    ]
    if target == Path("/") or any(
        inside(target, path) or inside(path, target) for path in protected
    ):
        raise ValueError("Recovery destination overlaps production or backup storage")
    target.mkdir(mode=0o700, parents=True)
    return target


def verify_batch(target):
    manifests = [
        path for path in target.rglob("manifest.json") if (path.parent / "database.dump").is_file()
    ]
    if len(manifests) != 1:
        raise ValueError("Recovery must contain one complete batch")
    manifest_path = checked_path(manifests[0])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format_version") != 1 or set(manifest.get("volumes", {})) != {
        "map_assets",
        "floor_assets",
    }:
        raise ValueError("Unsupported or incomplete recovery manifest")
    if restore_path(target, manifest["staging"]) != manifest_path.parent:
        raise ValueError("Recovery staging path does not match its manifest")
    files = manifest.get("files", {})
    required = {"database.dump", "deployment.env", "compose.yaml"}
    if not required.issubset(files) or any(
        name not in required and not re.fullmatch(r"host-nginx-\d+\.conf", name) for name in files
    ):
        raise ValueError("Recovery configuration coverage is incomplete")
    for name, checksum in files.items():
        path = checked_path(manifest_path.parent / name)
        if (
            not path.is_file()
            or not re.fullmatch(r"[0-9a-f]{64}", checksum)
            or file_sha256(path) != checksum
        ):
            raise ValueError("Recovery dump or configuration checksum differs")
        path.chmod(0o600)
    volumes = {}
    for name, original in manifest["volumes"].items():
        volume = restore_path(target, original)
        if not volume.is_dir() or inventory(volume) != manifest.get("inventory", {}).get(name):
            raise ValueError("Recovery asset inventory differs from the complete batch")
        volumes[name] = volume
    return manifest, manifest_path.parent, volumes


def local_asset(root, *parts):
    if any(
        not isinstance(part, str) or not part or part in {".", ".."} or "/" in part or "\\" in part
        for part in parts
    ):
        raise ValueError("Database contains an invalid asset path")
    path = checked_path(root.joinpath(*parts))
    if not inside(path, root.resolve()) or not path.is_file():
        raise ValueError("Database references a missing recovered asset")
    return path


def verify_asset(root, parts, checksum, size=None):
    path = local_asset(root, *parts)
    if (
        not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        or file_sha256(path) != checksum
    ):
        raise ValueError("Database-referenced recovered asset checksum differs")
    if size is not None and path.stat().st_size != size:
        raise ValueError("Database-referenced recovered asset size differs")


def verify_database_assets(data, volumes):
    """Validate actual DB-owned raw files, not merely nonempty volume folders."""
    map_root, floor_root = volumes["map_assets"], volumes["floor_assets"]
    counts = data["counts"]
    if not REQUIRED_TABLES.issubset(counts) or not data["migration_heads"]:
        raise ValueError("Restored schema or migration state is incomplete")
    verified = {"map_tiles": 0, "floor_images": 0, "floor_originals": 0, "media_originals": 0}
    for row in data["maps"]:
        if row["kind"] != "campus":
            continue
        manifest = json.loads(
            local_asset(map_root, row["id"], str(row["revision"]), "manifest.json").read_text(
                encoding="utf-8"
            )
        )
        if (
            manifest["map"]["id"] != row["id"]
            or manifest["map"]["revision"] != row["revision"]
            or not manifest.get("tile_hashes")
        ):
            raise ValueError("Recovered campus map does not match its database revision")
        for relative, checksum in manifest["tile_hashes"].items():
            parts = PurePosixPath(relative).parts
            if not re.fullmatch(r"\d+/\d+/\d+\.png", relative):
                raise ValueError("Recovered map tile manifest has an invalid path")
            verify_asset(map_root, [row["id"], str(row["revision"]), "tiles", *parts], checksum)
            verified["map_tiles"] += 1
    for row in data["floors"]:
        for image in row["images"]:
            verify_asset(
                floor_root,
                [row["id"], str(row["revision"]), image["filename"]],
                image["sha256"],
                image["size_bytes"],
            )
            verified["floor_images"] += 1
    for row in data["floor_uploads"]:
        image = row["image"]
        verify_asset(
            floor_root,
            [".uploads", row["id"], image["filename"]],
            image["sha256"],
            image["size_bytes"],
        )
        verified["floor_originals"] += 1
    for row in data["experience_uploads"]:
        verify_asset(
            floor_root,
            [".experience-media", row["id"], row["filename"]],
            row["sha256"],
            row["size_bytes"],
        )
        verified["media_originals"] += 1
    upload_rows = {row["id"]: row for row in data["experience_uploads"]}
    uploads = set(upload_rows)
    floor_uploads = {row["id"] for row in data["floor_uploads"]}
    experience_payloads = []
    for row in data["experiences"]:
        experience_payloads.extend((row["draft"], row["published"]))
    for table in ("experience_versions", "experience_operations", "content_versions"):
        if table in counts and table not in data:
            raise ValueError("Recovered retained history metadata is incomplete")
    for row in data.get("experience_versions", []):
        experience_payloads.extend((row["content"], row["published_content"]))
    for row in data.get("experience_operations", []):
        experience_payloads.append((row.get("result") or {}).get("content"))
    for payload in experience_payloads:
        if payload and payload.get("upload_id") and payload["upload_id"] not in uploads:
            raise ValueError("Recovered media draft or public snapshot lost its original")
        if payload and payload.get("caption_upload_id"):
            caption = upload_rows.get(payload["caption_upload_id"])
            if (not caption or caption.get("media_type") != "subtitle"
                    or caption.get("mime_type") != "text/vtt"
                    or caption.get("point_id") != payload.get("point_id")):
                raise ValueError("Recovered video caption lost its scoped original")
    for row in data["resource_changes"]:
        content = (row.get("payload") or {}).get("content", {})
        if content.get("kind") == "floor" and any(
            image.get("upload_id") and image["upload_id"] not in floor_uploads
            for image in content.get("images", [])
        ):
            raise ValueError("Recovered floor draft lost its original")
    for row in data.get("content_versions", []):
        if row["entity_type"] != "floor":
            continue
        snapshot = row["content"]
        content = ((snapshot.get("draft") or {}).get("content") or {})
        if any(image.get("upload_id") and image["upload_id"] not in floor_uploads
               for image in content.get("images", [])):
            raise ValueError("Recovered floor history lost its original")
        published = snapshot.get("published") or {}
        for image in published.get("images", []):
            verify_asset(floor_root, [row["entity_id"], str(published["revision"]), image["filename"]],
                         image["sha256"], image["size_bytes"])
    if "narration_assets" in counts:
        if "narration_assets" not in data or "narration_jobs" not in data:
            raise ValueError("Recovered narration metadata is incomplete")
        verified["narration_chunks"] = 0
        assets = {row["id"]: row for row in data["narration_assets"]}
        for row in data["narration_jobs"]:
            for chunk in row["completed_chunks"]:
                verify_asset(floor_root, [".narration", row["id"], chunk["sha256"] + ".wav"],
                             chunk["sha256"], chunk["byte_size"])
        for row in assets.values():
            canonical = json.dumps({"fingerprint": row["fingerprint"], "chunks": row["chunks"]},
                                   sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            if hashlib.sha256(canonical.encode()).hexdigest() != row["manifest_sha256"]:
                raise ValueError("Recovered narration manifest differs")
            for chunk in row["chunks"]:
                parts = [".narration", row["id"], chunk["sha256"] + ".wav"]
                verify_asset(floor_root, parts, chunk["sha256"], chunk["byte_size"])
                if not 0 < chunk["byte_size"] <= 32 * 1024 * 1024:
                    raise ValueError("Recovered narration chunk exceeds limits")
                try:
                    with wave.open(str(local_asset(floor_root, *parts)), "rb") as audio:
                        expected = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
                        duration = audio.getnframes() / audio.getframerate()
                        if (not 0 < duration <= 180 or abs(duration - chunk["duration_seconds"]) > 0.001
                                or expected > 32 * 1024 * 1024
                                or len(audio.readframes(audio.getnframes())) != expected):
                            raise ValueError("Recovered narration waveform is incomplete")
                except (wave.Error, EOFError, ZeroDivisionError):
                    raise ValueError("Recovered narration waveform is invalid") from None
                verified["narration_chunks"] += 1
        for payload in experience_payloads:
            for stop in (payload or {}).get("stops", []):
                for segment in stop.get("segments") or []:
                    asset_id = segment.get("narration_asset_id")
                    if asset_id and asset_id not in assets:
                        raise ValueError("Recovered tour lost adopted narration")
    return verified


def read_database(container):
    def sql(query):
        return json.loads(
            run(
                [
                    "docker",
                    "exec",
                    container,
                    "psql",
                    "-X",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "postgres",
                    "-d",
                    "postgres",
                    "-At",
                    "-c",
                    query,
                ]
            )
        )

    tables = sql(
        "SELECT COALESCE(json_agg(tablename ORDER BY tablename), '[]'::json) FROM pg_catalog.pg_tables WHERE schemaname='public';"
    )
    if (
        not isinstance(tables, list)
        or not REQUIRED_TABLES.issubset(tables)
        or any(not re.fullmatch(r"[a-z_][a-z0-9_]*", name) for name in tables)
    ):
        raise ValueError("Restored database tables are incomplete or unexpected")
    count_queries = " UNION ALL ".join(
        f"SELECT '{name}' AS name, count(*) AS n FROM public.\"{name}\"" for name in tables
    )
    keys = [
        "maps",
        "floors",
        "floor_uploads",
        "experience_uploads",
        "experiences",
        "resource_changes",
    ]
    columns = {
        "maps": "id, revision, kind",
        "floors": "id, revision, images",
        "floor_uploads": "id, image",
        "experience_uploads": "id, point_id, media_type, mime_type, filename, sha256, size_bytes",
        "experiences": "draft, published",
        "resource_changes": "payload",
    }
    for name, fields in (
        ("narration_jobs", "id, completed_chunks"),
        ("narration_assets", "id, fingerprint, manifest_sha256, chunks"),
        ("experience_versions", "content, published_content"),
        ("experience_operations", "result"),
        ("content_versions", "entity_type, entity_id, content"),
    ):
        if name in tables:
            keys.append(name)
            columns[name] = fields
    entries = [
        f"'counts', (SELECT json_object_agg(name,n) FROM ({count_queries}) counted)",
        "'migration_heads', (SELECT COALESCE(json_agg(version_num), '[]'::json) FROM alembic_version)",
    ]
    entries += [
        f"'{key}', (SELECT COALESCE(json_agg(row_to_json(record)), '[]'::json) FROM (SELECT {columns[key]} FROM {key}) record)"
        for key in keys
    ]
    return sql("SELECT json_build_object({});".format(",".join(entries)))


def restore(args):
    if os.geteuid() != 0:
        raise ValueError("Recovery drill must run as root")
    image_id = require_database_image(args.image, args.image_id)
    target = prepare_target(args.target, Path(args.repository), Path(args.key_file), args.root)
    env = {
        **os.environ,
        "RESTIC_REPOSITORY": str(checked_path(args.repository)),
        "RESTIC_PASSWORD_FILE": str(checked_path(args.key_file)),
    }
    run(["restic", "check", "--read-data"], env=env)
    run(
        [
            "restic",
            "restore",
            args.snapshot,
            "--tag",
            "twinnku-complete",
            "--target",
            str(target),
            "--verify",
        ],
        env=env,
    )
    manifest, staging, volumes = verify_batch(target)
    container = "twinnku-restore-" + secrets.token_hex(6)
    password_file = target / ".postgres.env"
    private_file(password_file, ("POSTGRES_PASSWORD=" + secrets.token_hex(32)).encode())
    try:
        run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                container,
                "--network",
                "none",
                "--memory",
                "1g",
                "--pids-limit",
                "128",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--env-file",
                str(password_file),
                image_id,
            ]
        )
        run(
            [
                "docker",
                "exec",
                container,
                "sh",
                "-c",
                "for n in $(seq 1 60); do pg_isready -h 127.0.0.1 -U postgres >/dev/null && exit 0; sleep 1; done; exit 1",
            ]
        )
        with checked_path(staging / "database.dump").open("rb") as dump:
            run(
                [
                    "docker", "exec", "-i", container, "pg_restore", "-U", "postgres", "-d",
                    "postgres", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl",
                ],
                stdin=dump,
            )
        data = read_database(container)
        if set(data["counts"]) != set(manifest["schema_tables"]) or set(
            data["migration_heads"]
        ) != set(manifest["migration_heads"]):
            raise ValueError(
                "Restored schema or migration heads differ from the captured deployment"
            )
        verified = verify_database_assets(data, volumes)
        security = quarantine_recovered_database(
            container, data["counts"], file_sha256(staging / "database.dump"),
        )
        return {
            "database_restore": "passed",
            "repository_read_check": "passed",
            "schema_tables": len(data["counts"]),
            "migration_heads": data["migration_heads"],
            "assets": verified,
            "volume_inventory": manifest["inventory"],
            "dump_sha256": file_sha256(staging / "database.dump"),
            "database_image_id": image_id,
            "production_modified": False,
            "restored_paid_jobs": "paused" if "narration_jobs" in data["counts"] else "not_present",
            "restored_security": security,
        }
    finally:
        result = subprocess.run(
            ["docker", "rm", "-f", "-v", container], check=False, capture_output=True
        )
        if password_file.exists():
            password_file.unlink()
        if result.returncode:
            raise ValueError("Recovery container cleanup failed; inspect isolated drill container")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--repository", default="/var/backups/twinnku/repository")
    parser.add_argument("--key-file", default="/etc/twinnku/backup-password")
    parser.add_argument("--snapshot", default="latest")
    parser.add_argument("--image", required=True, help="Reviewed, already built nonroot database image")
    parser.add_argument("--image-id", required=True, help="Expected immutable Docker image ID (sha256:...)")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    try:
        result = restore(parser.parse_args())
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as exc:
        # Subprocess error text can include restored secret rows or command output.
        raise SystemExit(f"Private recovery validation failed ({type(exc).__name__})") from None
    print(json.dumps(result))


if __name__ == "__main__":
    main()
