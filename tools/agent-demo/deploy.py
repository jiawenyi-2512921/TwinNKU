"""Run on the existing TwinNKU Docker host. Probe first, switch only after success."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "scripts"))
from probe_nk_genios_api import run_probe  # noqa: E402


def command(args, *, cwd=None, input_text=None):
    result = subprocess.run(
        args, cwd=cwd, input=input_text, text=True, capture_output=True, check=False
    )
    if result.returncode:
        if "/demo/probe_nk_genios_api.py" in args:
            for line in result.stdout.splitlines():
                if re.fullmatch(r"(?:PASS|FAIL|SKIP) +[a-z_]+: [A-Z_]+", line):
                    print(line)
        # docker inspect/config output can contain secrets. Do not echo raw output.
        raise RuntimeError(
            f"Command failed: {args[0]} {args[1] if len(args) > 1 else ''}; exit={result.returncode}"
        )
    return result.stdout


def inspect_container(project, service):
    ids = command(
        [
            "docker",
            "ps",
            "-q",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--filter",
            f"label=com.docker.compose.service={service}",
        ]
    ).split()
    if len(ids) != 1:
        raise RuntimeError(
            f"Expected exactly one running {service} container for project {project}"
        )
    return json.loads(command(["docker", "inspect", ids[0]]))[0]


def patch_nginx(source):
    if "agent-demo" in source:
        raise RuntimeError("An agent demo configuration already exists")
    needle = "location = /agent/embed.html {"
    if source.count(needle) != 1:
        raise RuntimeError(
            "Existing embed location is not recognized; no automatic change"
        )
    start = source.index(needle)
    end = source.index("}", start) + 1
    block = source[start:end]
    if block.count("{") != 1 or "try_files $uri =404;" not in block:
        raise RuntimeError("Custom embed configuration requires review")
    common = """
            proxy_pass http://agent-demo:8100;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_buffering off;
            proxy_connect_timeout 5s;
            proxy_read_timeout 115s;
            client_max_body_size 12k;
        }"""
    return (
        source[:start]
        + "location = /agent/embed.html {"
        + common
        + "\n        location ^~ /agent-demo/ {"
        + common
        + source[end:]
    )


def compose_args(state):
    args = [
        "docker",
        "compose",
        "--project-name",
        state["project"],
        "--project-directory",
        state["cwd"],
    ]
    for name in state["files"]:
        args += ["-f", name]
    return args


def rollback(directory):
    state = json.loads((directory / "state.json").read_text())
    base = compose_args(state)
    command(
        base
        + [
            "-f",
            str(directory / "rollback.json"),
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "web",
        ],
        cwd=state["cwd"],
    )
    # Only the demo container is removed; no down, volume removal, migration or seed.
    command(
        base
        + ["-f", str(directory / "compose.demo.json"), "rm", "-s", "-f", "agent-demo"],
        cwd=state["cwd"],
    )
    print("Original embedded page restored. Demo container stopped.")


def install(args):
    directory = Path(args.state_dir).resolve()
    if directory.exists():
        raise RuntimeError(
            "State directory already exists; use --rollback or choose a new --state-dir"
        )
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+", args.origin):
        raise RuntimeError("Use the exact HTTPS site origin without a trailing slash")
    web, api = (
        inspect_container(args.project, "web"),
        inspect_container(args.project, "api"),
    )
    labels = web["Config"]["Labels"]
    cwd = labels.get("com.docker.compose.project.working_dir", "")
    files = labels.get("com.docker.compose.project.config_files", "").split(",")
    if (
        not cwd
        or not Path(cwd).is_dir()
        or not files
        or not all(Path(f).is_absolute() and Path(f).is_file() for f in files)
    ):
        raise RuntimeError("Original Compose files and working directory are required")
    state = {"project": args.project, "cwd": cwd, "files": files}
    base = compose_args(state)
    current_hash = command(base + ["config", "--hash", "web"], cwd=cwd).strip().split()
    if len(current_hash) != 2 or current_hash[1] != labels.get(
        "com.docker.compose.config-hash"
    ):
        raise RuntimeError(
            "Compose settings differ from the running web container; resolve this before deployment"
        )
    networks = set(web["NetworkSettings"]["Networks"]) & set(
        api["NetworkSettings"]["Networks"]
    )
    if len(networks) != 1:
        raise RuntimeError("Expected exactly one shared web/API Docker network")
    network = networks.pop()
    # Ensure the current widget exists/enabled; no forced changes to the main API settings.
    config = command(
        [
            "docker",
            "exec",
            api["Id"],
            "python",
            "-c",
            "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/agent/web-config',timeout=5)); print('enabled' if d.get('data',{}).get('enabled') else 'disabled')",
        ]
    )
    if config.strip() != "enabled":
        raise RuntimeError(
            "Enable the existing Ask Xiaokai widget before using this replacement"
        )
    key = os.environ.get("NK_GENIOS_API_KEY") or getpass.getpass(
        "Application API key (hidden, not a school password): "
    )
    if not key:
        raise RuntimeError("Application API key is required")
    report = run_probe(key, chat=True, timeout=60)
    for check in report["checks"]:
        print(f"{check['status'].upper()}: {check['check']} {check['code']}")
    if not report["ok"]:
        raise RuntimeError(
            "Real school API probe failed. Existing website has not been modified"
        )
    code = getpass.getpass(
        "Demo access code (at least 16 characters; Enter generates one): "
    ) or secrets.token_urlsafe(24)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", code):
        raise RuntimeError(
            "Demo code must be 16–128 letters, digits, underscores or hyphens"
        )
    if any(c.isspace() or c in "'\"\\$#" for c in key) or not key.isascii():
        raise RuntimeError("Unsupported key format; nothing deployed")
    directory.mkdir(mode=0o700, parents=True)
    runtime = directory / "runtime"
    runtime.mkdir(mode=0o755)
    for name in ("server.py", "index.html", "app.js", "style.css"):
        shutil.copyfile(HERE / name, runtime / name)
        (runtime / name).chmod(0o644)
    probe = HERE.parent.parent / "scripts" / "probe_nk_genios_api.py"
    shutil.copyfile(probe, runtime / "probe_nk_genios_api.py")
    (runtime / "probe_nk_genios_api.py").chmod(0o644)
    env = directory / "demo.env"
    env.write_text(
        f"NK_GENIOS_API_KEY={key}\nDEMO_CODE={code}\nDEMO_ORIGIN={args.origin}\n"
    )
    env.chmod(0o600)
    backup = directory / "nginx.original.conf"
    command(["docker", "cp", f"{web['Id']}:/etc/nginx/nginx.conf", str(backup)])
    backup.chmod(0o644)
    nginx = directory / "nginx.demo.conf"
    nginx.write_text(patch_nginx(backup.read_text()))
    nginx.chmod(0o644)
    demo = {
        "services": {
            "agent-demo": {
                "image": api["Image"],
                "entrypoint": ["python"],
                "command": ["/demo/server.py"],
                "env_file": [str(env)],
                "volumes": [f"{runtime}:/demo:ro"],
                "networks": ["demo-shared"],
                "restart": "unless-stopped",
                "read_only": True,
                "user": "10001:10001",
                "tmpfs": ["/tmp"],
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "pids_limit": 64,
                "mem_limit": "256m",
                "healthcheck": {
                    "test": [
                        "CMD",
                        "python",
                        "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/agent-demo/health',timeout=3)",
                    ],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 3,
                },
                "logging": {
                    "driver": "json-file",
                    "options": {"max-size": "2m", "max-file": "2"},
                },
            },
            "web": {
                "image": web["Image"],
                "volumes": [f"{nginx}:/etc/nginx/nginx.conf:ro"],
            },
        },
        "networks": {"demo-shared": {"external": True, "name": network}},
    }
    restore = {
        "services": {
            "web": {
                "image": web["Image"],
                "volumes": [f"{backup}:/etc/nginx/nginx.conf:ro"],
            }
        }
    }
    for name, data in (
        ("compose.demo.json", demo),
        ("rollback.json", restore),
        ("state.json", state),
    ):
        (directory / name).write_text(json.dumps(data, indent=2) + "\n")
    active = base + ["-f", str(directory / "compose.demo.json")]
    switched = False
    try:
        command(
            active
            + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "agent-demo"],
            cwd=cwd,
        )
        ready = False
        for _ in range(15):
            try:
                # This container-side check also detects missing Python dependencies.
                command(
                    active
                    + [
                        "exec",
                        "-T",
                        "agent-demo",
                        "python",
                        "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/agent-demo/health',timeout=2)",
                    ],
                    cwd=cwd,
                )
                ready = True
                break
            except RuntimeError:
                time.sleep(1)
        if not ready:
            raise RuntimeError("Demo service did not become ready")
        # Verify API egress from the actual companion container, before changing the web service.
        probe_output = command(
            active
            + [
                "exec",
                "-T",
                "agent-demo",
                "python",
                "/demo/probe_nk_genios_api.py",
                "--chat",
                "--timeout",
                "60",
            ],
            cwd=cwd,
        )
        print(probe_output, end="")
        command(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                network,
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--mount",
                f"type=bind,src={nginx},dst=/etc/nginx/nginx.conf,readonly",
                "--entrypoint",
                "nginx",
                web["Image"],
                "-t",
            ]
        )
        switched = True  # Also rollback when Compose fails after stopping the original web container.
        command(
            active + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "web"],
            cwd=cwd,
        )
        route_ready = False
        for _ in range(15):
            try:
                result = command(
                    active
                    + [
                        "exec",
                        "-T",
                        "web",
                        "wget",
                        "-qO-",
                        "http://127.0.0.1:8080/agent-demo/health",
                    ],
                    cwd=cwd,
                )
                if json.loads(result).get("mode") == "private-demo":
                    route_ready = True
                    break
            except (RuntimeError, ValueError):
                pass
            time.sleep(1)
        if not route_ready:
            raise RuntimeError("Web-to-demo route did not become ready")
    except Exception:
        if switched:
            rollback(directory)
        else:
            command(active + ["rm", "-s", "-f", "agent-demo"], cwd=cwd)
        raise
    print("Backend and embed route deployed. Browser acceptance is still required.")
    print(
        f"Open: {args.origin} — Ask Xiaokai. Demo code is stored in {env} (server only)."
    )
    if not args.quiet_code:
        print(f"Demo access code: {code}")
    print(f"Rollback: python3 {HERE / 'deploy.py'} --rollback --state-dir {directory}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="twinnku")
    parser.add_argument("--origin", default="https://2512921.cn")
    parser.add_argument("--state-dir", default="/opt/twinnku-agent-demo")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--quiet-code", action="store_true")
    args = parser.parse_args()
    try:
        if args.rollback:
            rollback(Path(args.state_dir).resolve())
        else:
            install(args)
    except (RuntimeError, ValueError, OSError, EOFError, KeyboardInterrupt) as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
