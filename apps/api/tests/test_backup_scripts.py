"""Recovery checks against actual private files; never invoke Docker or restic."""

import ast
import importlib.util
import json
import os
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


backup = load_script("backup")
restore = load_script("restore_backup")


@pytest.fixture
def recovered(tmp_path):
    target = tmp_path / "recovered"
    staging = target / "var/backups/twinnku/.staging-batch"
    staging.mkdir(parents=True)
    volumes = {
        name: target / "var/lib/docker/volumes" / name / "_data"
        for name in ("map_assets", "floor_assets")
    }
    for root in volumes.values():
        root.mkdir(parents=True)
    files = {}
    for name in ("database.dump", "deployment.env", "compose.yaml"):
        (staging / name).write_bytes(b"private recovery fixture")
        files[name] = backup.file_sha256(staging / name)
    manifest = {
        "format_version": 1,
        "staging": "/var/backups/twinnku/.staging-batch",
        "volumes": {name: "/var/lib/docker/volumes/" + name + "/_data" for name in volumes},
        "files": files,
        "schema_tables": sorted(restore.REQUIRED_TABLES),
        "migration_heads": ["fixture_migration"],
        "inventory": {name: backup.inventory(root) for name, root in volumes.items()},
    }
    (staging / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return target, staging, manifest, volumes


def asset(root, parts):
    path = root.joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"unmodified raw asset fixture")
    return {
        "filename": parts[-1],
        "sha256": backup.file_sha256(path),
        "size_bytes": path.stat().st_size,
    }


def database_assets(volumes):
    map_root, floor_root = volumes["map_assets"], volumes["floor_assets"]
    tile = asset(map_root, ["campus-map", "1", "tiles", "0", "0", "0.png"])
    (map_root / "campus-map/1/manifest.json").write_text(
        json.dumps(
            {
                "map": {"id": "campus-map", "revision": 1},
                "tile_hashes": {"0/0/0.png": tile["sha256"]},
            }
        ),
        encoding="utf-8",
    )
    floor = asset(floor_root, ["floor-a", "2", "labeled.png"])
    original = asset(floor_root, [".uploads", "floor-original", "original.png"])
    media = asset(floor_root, [".experience-media", "media-original", "original.mp4"])
    return {
        "counts": dict.fromkeys(restore.REQUIRED_TABLES, 1),
        "migration_heads": ["0011_upload_budgets"],
        "maps": [{"id": "campus-map", "revision": 1, "kind": "campus"}],
        "floors": [{"id": "floor-a", "revision": 2, "images": [floor]}],
        "floor_uploads": [{"id": "floor-original", "image": original}],
        "experience_uploads": [{"id": "media-original", **media}],
        "experiences": [
            {"draft": {"kind": "media", "upload_id": "media-original"}, "published": None}
        ],
        "resource_changes": [
            {"payload": {"content": {"kind": "floor", "images": [{"upload_id": "floor-original"}]}}}
        ],
    }


def test_scripts_parse_with_host_python38_and_status_is_atomic_private(tmp_path):
    for name in ("backup.py", "restore_backup.py"):
        ast.parse((SCRIPTS / name).read_text(encoding="utf-8"), feature_version=(3, 8))
    destination = tmp_path / "backups"
    backup.write_status(destination, {"status": "success", "last_success_at": "before"})
    backup.write_status(
        destination, {"status": "failed", "last_success_at": "before", "failure_code": "ValueError"}
    )
    assert json.loads((destination / "status.json").read_text())["last_success_at"] == "before"
    assert not list(destination.glob(".status-*"))
    if os.name == "posix":
        assert (destination / "status.json").stat().st_mode & 0o777 == 0o600
        assert destination.stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("nested", [True, False])
def test_backup_destination_cannot_overlap_deployment(tmp_path, monkeypatch, nested):
    root = tmp_path / "deployment"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}")
    (root / ".env").write_text("fixture only")
    monkeypatch.setattr(backup.os, "geteuid", lambda: 0, raising=False)
    with pytest.raises(ValueError, match="outside the deployment"):
        backup.backup(root, root / "backup" if nested else tmp_path, tmp_path / "key", 10)


@pytest.fixture
def dump_workflow(tmp_path, monkeypatch):
    """Run the real staging/status flow without Docker, root or private data."""
    root, destination, key = tmp_path / "deployment", tmp_path / "backups", tmp_path / "key"
    root.mkdir()
    (root / "compose.yaml").write_text("services: {}")
    (root / ".env").write_text("fixture")
    destination.mkdir()
    repository = destination / "repository"
    repository.mkdir()
    (repository / "config").write_text("fixture existing repository")
    key.write_bytes(b"fixture password, never logged")
    volumes = {name: tmp_path / name for name in ("map_assets", "floor_assets")}
    for path in volumes.values():
        path.mkdir()
    original_stat = Path.stat

    def root_private_stat(path, *args, **kwargs):
        info = original_stat(path, *args, **kwargs)
        if path in (destination, key):
            values = list(info)
            values[0], values[4] = info.st_mode & ~0o077, 0
            return os.stat_result(values)
        return info

    monkeypatch.setattr(Path, "stat", root_private_stat)
    monkeypatch.setattr(backup.os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(backup, "backup_lock", lambda _: nullcontext())
    monkeypatch.setattr(backup, "maintenance_lock", lambda _: nullcontext())
    monkeypatch.setattr(backup.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    calls, phases = [], []

    def command(args, **kwargs):
        calls.append(args)
        if args[:3] == ["docker", "compose", "config"]:
            return json.dumps({
                "services": {"db": {"environment": {"POSTGRES_USER": "fixture", "POSTGRES_DB": "fixture"}}},
                "volumes": {name: {"name": name} for name in volumes},
            }).encode()
        if args[:3] == ["docker", "volume", "inspect"]:
            return json.dumps([{"Mountpoint": str(volumes[args[-1]])}]).encode()
        if "psql" in args:
            return b'{"schema_tables":["fixture"],"migration_heads":["fixture"]}'
        assert args[0] == "restic"
        return b""

    monkeypatch.setattr(backup, "command", command)
    monkeypatch.setattr(backup, "report_phase", lambda phase, **_: phases.append(phase))
    return SimpleNamespace(root=root, destination=destination, key=key, calls=calls, phases=phases)


def assert_fixed_dump_command(args, kwargs, workflow):
    assert args == [
        "docker", "compose", "exec", "-T", "db", "/bin/busybox", "timeout", "-s", "KILL",
        "1140", "pg_dump", "-U", "fixture", "-d", "fixture", "-Fc", "--no-owner", "--no-acl",
    ]
    assert kwargs["cwd"] == workflow.root
    assert kwargs["check"] is True and kwargs["stderr"] == subprocess.PIPE
    assert kwargs["timeout"] == 1200 > backup.DUMP_CONTAINER_TIMEOUT_SECONDS
    assert "shell" not in kwargs


@pytest.mark.parametrize("failure", ["container_deadline", "missing_watchdog", "host_deadline"])
def test_dump_deadline_failure_preserves_last_success_and_never_encrypts(
    dump_workflow, monkeypatch, capsys, failure
):
    workflow = dump_workflow
    backup.write_status(workflow.destination, {"status": "success", "last_success_at": "before"})
    dump_calls = []

    def failed_dump(args, **kwargs):
        assert_fixed_dump_command(args, kwargs, workflow)
        dump_calls.append(args)
        kwargs["stdout"].write(b"partial dump must not be backed up")
        if failure == "host_deadline":
            raise subprocess.TimeoutExpired(args, kwargs["timeout"], stderr=b"private failure fixture")
        raise subprocess.CalledProcessError(
            137 if failure == "container_deadline" else 127, args, stderr=b"private failure fixture"
        )

    monkeypatch.setattr(backup.subprocess, "run", failed_dump)
    monkeypatch.setattr(sys, "argv", [
        "backup.py", "--root", str(workflow.root), "--destination", str(workflow.destination),
        "--key-file", str(workflow.key), "--min-free-gib", "1", "--progress-json",
    ])
    with pytest.raises(SystemExit) as stopped:
        backup.main()
    assert stopped.value.code == 1
    assert len(dump_calls) == 1 and workflow.phases == ["preflight", "dump"]
    assert not any(args[0] == "restic" or "psql" in args for args in workflow.calls)
    assert not list(workflow.destination.glob(".staging-*"))
    status = json.loads((workflow.destination / "status.json").read_text())
    assert status["status"] == "failed" and status["last_success_at"] == "before"
    assert status["failure_code"] == (
        "TimeoutExpired" if failure == "host_deadline" else "CalledProcessError"
    )
    assert "private failure fixture" not in capsys.readouterr().out
    assert "private failure fixture" not in json.dumps(status)


def test_successful_guarded_dump_enters_encrypt_and_checks_repository(dump_workflow, monkeypatch):
    workflow = dump_workflow
    dump_calls = []

    def successful_dump(args, **kwargs):
        assert_fixed_dump_command(args, kwargs, workflow)
        dump_calls.append(args)
        kwargs["stdout"].write(b"complete database dump fixture")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(backup.subprocess, "run", successful_dump)
    result = backup._backup(
        workflow.root, workflow.destination, workflow.key, 1, progress=workflow.phases.append
    )
    assert result["status"] == "success" and len(dump_calls) == 1
    assert workflow.phases == ["preflight", "dump", "encrypt", "retention", "integrity", "complete"]
    assert [args[1] for args in workflow.calls if args[0] == "restic"] == ["backup", "forget", "check"]
    assert not list(workflow.destination.glob(".staging-*"))


def test_complete_batch_verifies_dump_config_and_volume_inventory(recovered):
    target, staging, manifest, volumes = recovered
    assert restore.verify_batch(target)[2] == volumes
    (volumes["floor_assets"] / ".maintenance.lock").write_bytes(b"changed lock bytes")
    assert restore.verify_batch(target)[0] == manifest
    (staging / "deployment.env").write_bytes(b"damaged fixture")
    with pytest.raises(ValueError, match="checksum"):
        restore.verify_batch(target)


@pytest.mark.parametrize("path", ["/../../etc", "relative/volume", "/"])
def test_manifest_paths_cannot_escape_new_target(recovered, path):
    target, staging, manifest, _ = recovered
    manifest["volumes"]["floor_assets"] = path
    (staging / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="invalid absolute path"):
        restore.verify_batch(target)


def test_restore_target_rejects_repository_deployment_and_existing_directories(tmp_path):
    repository, deployment = tmp_path / "repo", tmp_path / "deployment"
    repository.mkdir()
    deployment.mkdir()
    for target in (repository, deployment / "new-recovery", repository / "new-recovery"):
        with pytest.raises(ValueError):
            restore.prepare_target(target, repository, tmp_path / "key", deployment)
    safe = restore.prepare_target(
        tmp_path / "private-drill", repository, tmp_path / "key", deployment
    )
    assert safe.is_dir()


def test_recovery_verifies_all_raw_assets_and_draft_original_dependencies(recovered):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    assert restore.verify_database_assets(data, volumes) == {
        "map_tiles": 1,
        "floor_images": 1,
        "floor_originals": 1,
        "media_originals": 1,
    }
    data["experiences"][0]["published"] = {"upload_id": "missing"}
    with pytest.raises(ValueError, match="lost its original"):
        restore.verify_database_assets(data, volumes)
    data["experiences"][0]["published"] = None
    (volumes["floor_assets"] / "floor-a/2/labeled.png").write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="checksum"):
        restore.verify_database_assets(data, volumes)


def test_restore_failure_cleans_only_the_isolated_container_and_private_password(
    recovered, tmp_path, monkeypatch
):
    _, staging, manifest, volumes = recovered
    target = tmp_path / "new-recovery"
    args = SimpleNamespace(
        target=target,
        repository=tmp_path / "repo",
        key_file=tmp_path / "key",
        root=tmp_path / "deployment",
        snapshot="latest",
        image="twinnku-db:reviewed",
        image_id="sha256:" + "a" * 64,
    )
    monkeypatch.setattr(restore.os, "geteuid", lambda: 0, raising=False)
    calls = []
    streamed = []

    def command_run(command, **kwargs):
        calls.append(command)
        if kwargs.get("stdin") is not None:
            streamed.append(kwargs["stdin"].read())

    (staging / "database.dump").chmod(0o600)
    monkeypatch.setattr(restore, "run", command_run)
    monkeypatch.setattr(restore, "require_database_image", lambda _image, image_id: image_id)
    monkeypatch.setattr(restore, "verify_batch", lambda _target: (manifest, staging, volumes))
    monkeypatch.setattr(
        restore,
        "read_database",
        lambda _container: {
            "counts": dict.fromkeys(manifest["schema_tables"], 0),
            "migration_heads": manifest["migration_heads"],
        },
    )
    monkeypatch.setattr(
        restore,
        "verify_database_assets",
        lambda *_args: (_ for _ in ()).throw(ValueError("fixture failure")),
    )
    monkeypatch.setattr(
        restore.subprocess,
        "run",
        lambda command, **_kwargs: calls.append(command) or SimpleNamespace(returncode=0),
    )
    with pytest.raises(ValueError, match="fixture failure"):
        restore.restore(args)
    assert calls[-1][:4] == ["docker", "rm", "-f", "-v"]
    assert calls[-1][4].startswith("twinnku-restore-")
    assert not (target / ".postgres.env").exists()
    start = next(command for command in calls if command[:2] == ["docker", "run"])
    assert "none" in start and start[-1] == args.image_id and "--mount" not in start
    restore_call = next(command for command in calls if "pg_restore" in command)
    assert restore_call[:3] == ["docker", "exec", "-i"]
    assert "/incoming/database.dump" not in restore_call
    assert streamed == [b"private recovery fixture"]
    if os.name == "posix":
        assert (staging / "database.dump").stat().st_mode & 0o777 == 0o600


def test_restore_requires_selected_image_id_and_verifies_actual_nonroot_binary(monkeypatch):
    image_id = "sha256:" + "a" * 64
    calls = []

    def command_run(command, **_kwargs):
        calls.append(command)
        return json.dumps({"Id": image_id, "Config": {"User": "postgres"}}).encode()

    monkeypatch.setattr(restore, "run", command_run)
    assert restore.require_database_image("twinnku-db:reviewed", image_id) == image_id
    assert calls[0][-1] == "twinnku-db:reviewed"
    assert image_id in calls[1] and "twinnku-db:reviewed" not in calls[1]
    assert "none" in calls[1] and "--read-only" in calls[1]
    assert "70:70" in calls[1][-1] and "gosu" in calls[1][-1]


@pytest.mark.parametrize(
    "metadata",
    [
        {"Id": "sha256:" + "b" * 64, "Config": {"User": "postgres"}},
        {"Id": "sha256:" + "a" * 64, "Config": {"User": "root"}},
        {"Id": "sha256:" + "a" * 64, "Config": {"User": ""}},
    ],
)
def test_restore_rejects_retagged_or_root_image_without_starting_it(monkeypatch, metadata):
    calls = []
    monkeypatch.setattr(
        restore,
        "run",
        lambda command, **_kwargs: calls.append(command) or json.dumps(metadata).encode(),
    )
    with pytest.raises(ValueError, match="image ID or nonroot"):
        restore.require_database_image("twinnku-db:reviewed", "sha256:" + "a" * 64)
    assert len(calls) == 1 and calls[0][:3] == ["docker", "image", "inspect"]


@pytest.mark.parametrize("image,image_id", [("--pull", "sha256:" + "a" * 64), ("twinnku-db:reviewed", "latest")])
def test_restore_rejects_missing_immutable_image_identity_before_docker(monkeypatch, image, image_id):
    calls = []
    monkeypatch.setattr(restore, "run", lambda command, **_kwargs: calls.append(command))
    with pytest.raises(ValueError, match="explicit image"):
        restore.require_database_image(image, image_id)
    assert not calls


def test_database_table_list_is_checked_before_building_count_sql(monkeypatch):
    monkeypatch.setattr(
        restore,
        "run",
        lambda *_args, **_kwargs: json.dumps(
            [*restore.REQUIRED_TABLES, "x;DROP TABLE points"]
        ).encode(),
    )
    with pytest.raises(ValueError, match="incomplete or unexpected"):
        restore.read_database("twinnku-restore-fixture")


@pytest.mark.parametrize("kind", ["map", "floor_original", "media_original", "floor_draft"])
def test_missing_map_floor_media_or_draft_dependency_fails_recovery(recovered, kind):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    if kind == "map":
        (volumes["map_assets"] / "campus-map/1/tiles/0/0/0.png").unlink()
    elif kind == "floor_original":
        (volumes["floor_assets"] / ".uploads/floor-original/original.png").unlink()
    elif kind == "media_original":
        (volumes["floor_assets"] / ".experience-media/media-original/original.mp4").unlink()
    else:
        data["resource_changes"][0]["payload"]["content"]["images"][0]["upload_id"] = "missing"
    with pytest.raises(ValueError):
        restore.verify_database_assets(data, volumes)


def test_restore_verifies_narration_manifest_waveform_and_adoption(recovered):
    import hashlib
    import io
    import wave

    _, _, _, volumes = recovered
    data = database_assets(volumes)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 1600)
    raw = buffer.getvalue()
    checksum = hashlib.sha256(raw).hexdigest()
    folder = volumes["floor_assets"] / ".narration" / "fixture-asset"
    folder.mkdir(parents=True)
    (folder / (checksum + ".wav")).write_bytes(raw)
    chunks = [{"sha256": checksum, "byte_size": len(raw), "duration_seconds": 0.1,
               "chunk_id": "0", "text": "fixture"}]
    manifest = {"fingerprint": "a" * 64, "chunks": chunks}
    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    data["counts"].update(narration_assets=1, narration_jobs=1)
    data["narration_assets"] = [{"id": "fixture-asset", **manifest,
                                 "manifest_sha256": hashlib.sha256(canonical.encode()).hexdigest()}]
    data["narration_jobs"] = [{"id": "fixture-asset", "completed_chunks": chunks}]
    assert restore.verify_database_assets(data, volumes)["narration_chunks"] == 1
    data["experiences"][0]["published"] = {"stops": [{"segments": [{"narration_asset_id": "missing"}]}]}
    with pytest.raises(ValueError, match="lost adopted narration"):
        restore.verify_database_assets(data, volumes)
    data["experiences"][0]["published"] = None
    data["narration_assets"][0]["manifest_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="manifest differs"):
        restore.verify_database_assets(data, volumes)


def test_symlink_ancestors_are_rejected_before_resolution(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Platform does not grant symlink creation")
    with pytest.raises(ValueError, match="Symlink"):
        backup.checked_path(link / "new-backup")


@pytest.mark.parametrize("source", ["experience_versions", "experience_operations"])
def test_recovery_checks_originals_referenced_only_by_retained_history(recovered, source):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    payload = {"kind": "media", "upload_id": "missing-history-original"}
    data["counts"][source] = 1
    data[source] = ([{"content": payload, "published_content": None}]
                    if source == "experience_versions" else [{"result": {"content": payload}}])
    with pytest.raises(ValueError, match="lost its original"):
        restore.verify_database_assets(data, volumes)


def test_recovery_checks_old_floor_revision_files_and_originals(recovered):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    data["counts"]["content_versions"] = 1
    current = data["floors"][0]
    history = {"entity_type": "floor", "entity_id": current["id"], "content": {
        "draft": None, "published": {"revision": current["revision"], "images": current["images"]}}}
    data["content_versions"] = [history]
    assert restore.verify_database_assets(data, volumes)["floor_images"] == 1
    history["content"]["published"]["revision"] = 1
    with pytest.raises(ValueError, match="missing recovered asset"):
        restore.verify_database_assets(data, volumes)
    history["content"] = {"draft": {"content": {"images": [{"upload_id": "missing"}]}}, "published": None}
    with pytest.raises(ValueError, match="floor history lost"):
        restore.verify_database_assets(data, volumes)


def test_recovery_checks_narration_referenced_only_by_old_route(recovered):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    data["counts"].update(narration_assets=0, narration_jobs=0, experience_versions=1)
    data["narration_assets"], data["narration_jobs"] = [], []
    data["experience_versions"] = [{"content": None, "published_content": {
        "stops": [{"segments": [{"narration_asset_id": "missing-historical-asset"}]}]}}]
    with pytest.raises(ValueError, match="lost adopted narration"):
        restore.verify_database_assets(data, volumes)


@pytest.mark.parametrize("change", ["point", "type", "mime", "missing"])
def test_recovery_caption_must_belong_to_the_same_point_and_valid_type(recovered, change):
    _, _, _, volumes = recovered
    data = database_assets(volumes)
    root = volumes["floor_assets"] / ".experience-media" / "caption-original"
    root.mkdir()
    path = root / "original.vtt"
    path.write_bytes(b"WEBVTT\n\n00:00.000 --> 00:01.000\nFixture\n")
    caption = {"id": "caption-original", "point_id": "point-a", "media_type": "subtitle",
               "mime_type": "text/vtt", "filename": path.name,
               "sha256": backup.file_sha256(path), "size_bytes": path.stat().st_size}
    data["experience_uploads"].append(caption)
    data["experiences"][0]["draft"].update(point_id="point-a", caption_upload_id=caption["id"])
    assert restore.verify_database_assets(data, volumes)["media_originals"] == 2
    if change == "point":
        caption["point_id"] = "point-b"
    elif change == "type":
        caption["media_type"] = "video"
    elif change == "mime":
        caption["mime_type"] = "text/html"
    else:
        data["experience_uploads"].pop()
    with pytest.raises(ValueError, match="caption lost its scoped original"):
        restore.verify_database_assets(data, volumes)
