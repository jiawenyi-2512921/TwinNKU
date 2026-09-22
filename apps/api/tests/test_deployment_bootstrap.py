import json
import os
import shutil
import socket
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def bootstrap(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    for name in ["init_env.py", "first-run.sh"]:
        shutil.copyfile(REPO / "scripts" / name, scripts / name)
    return scripts / "init_env.py"


def run_init(bootstrap, *args):
    return subprocess.run(
        [sys.executable, str(bootstrap), *args], capture_output=True, text=True, check=False
    )


def test_password_is_private_and_never_rotated(bootstrap):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    result = run_init(bootstrap, "--port", str(port), "--host", "guide.example.edu")
    assert result.returncode == 0, result.stderr
    env = bootstrap.parent.parent / ".env"
    original = env.read_bytes()
    config = dict(line.split("=", 1) for line in original.decode().splitlines() if "=" in line)
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    password = config["DB_PASSWORD"]
    assert len(password) == 48 and all(c in "0123456789abcdef" for c in password)
    assert password not in result.stdout + result.stderr
    assert "guide.example.edu" in json.loads(config["ALLOWED_HOSTS"])
    repeated = run_init(bootstrap, "--port", str(port))
    assert repeated.returncode != 0
    assert env.read_bytes() == original


def test_existing_env_symlink_is_not_followed(bootstrap):
    target = bootstrap.parent.parent / "private-config"
    target.write_text("preserved")
    (target.parent / ".env").symlink_to(target)
    result = run_init(bootstrap)
    assert result.returncode != 0
    assert target.read_text() == "preserved"


def test_occupied_port_does_not_create_credentials(bootstrap):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        result = run_init(bootstrap, "--port", str(listener.getsockname()[1]))
    assert result.returncode != 0
    assert not (bootstrap.parent.parent / ".env").exists()


@pytest.mark.parametrize(
    "value", ["*", "https://guide.example.edu", "host\nDB_PASSWORD=x", "999.999.999.999"]
)
def test_invalid_host_cannot_inject_configuration(bootstrap, value):
    result = run_init(bootstrap, "--host", value)
    assert result.returncode != 0
    assert not (bootstrap.parent.parent / ".env").exists()


def test_existing_project_blocks_first_install(bootstrap, tmp_path):
    # A test CLI isolates the guard from a real server/daemon; this is not a Docker integration test.
    binary = tmp_path / "bin"
    binary.mkdir()
    docker = binary / "docker"
    docker.write_text(
        '#!/usr/bin/env bash\nif [[ "$1" == ps ]]; then echo existing-container; fi\n'
    )
    docker.chmod(0o755)
    result = subprocess.run(
        ["bash", str(bootstrap.parent / "first-run.sh")],
        env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ["PATH"]},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "existing Twin NKU" in result.stderr
    assert not (bootstrap.parent.parent / ".env").exists()
