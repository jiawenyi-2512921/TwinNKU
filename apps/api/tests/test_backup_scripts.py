"""Recovery checks against actual private files; never invoke Docker or restic."""

import ast
import importlib.util
import json
import os
import sys
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
