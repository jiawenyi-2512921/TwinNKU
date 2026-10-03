"""Initialize and operate the separate localhost content-training stack on Linux.

Uses its own private env file and a standalone Compose definition. No production
configuration, data or employee credentials are copied. Images must exist locally.
"""

import argparse
import json
import os
import re
import secrets
import subprocess
from pathlib import Path

PURPOSE = "org.twinnku.purpose"
PROJECT = "twinnku-practice"
SERVICES = {"db", "migrate", "api", "web"}
VOLUMES = {"practice_db", "practice_maps", "practice_assets"}
IMAGE_USERS = {"API": {"10001", "10001:10001"}, "WEB": {"nginx", "101", "101:101"},
               "DB": {"postgres", "70", "70:70"}}
COMPOSE = Path(__file__).resolve().parents[1] / "compose.practice.yaml"


def command(arguments):
    # Ambient production Compose flags or similarly named passwords cannot override
    # the dedicated env file. Never print `compose config`, which contains secrets.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("COMPOSE_", "PRACTICE_"))}
    try:
        result = subprocess.run(arguments, env=env, capture_output=True, text=True, check=False, timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Training command outcome unknown; inspect the original practice operation") from None
    if result.returncode:
        raise RuntimeError("Training command failed; inspect the named practice service locally")
    return result.stdout


def private_directory(path, *, new=False):
    path = Path(os.path.abspath(path))
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Practice directory must not traverse symbolic links")
    if new:
        path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if not path.is_dir() or path.stat().st_mode & 0o077:
        raise ValueError("Practice directory must be private (mode 0700)")
    if path.stat().st_uid != os.geteuid():
        raise ValueError("Practice directory must belong to the invoking maintenance account")
    return path


def image_identity(image, kind):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Practice images must be explicit immutable local image IDs")
    metadata = json.loads(command(["docker", "image", "inspect", "--format", "{{json .}}", image]))
    if metadata["Id"] != image or metadata.get("Config", {}).get("User") not in IMAGE_USERS[kind]:
        raise ValueError("Practice image user does not match the reviewed nonroot runtime")
    return image


def initialize(directory, images, port):
    if not 1024 <= port <= 65535:
        raise ValueError("Practice port must be between 1024 and 65535")
    verified = {kind: image_identity(images[kind], kind) for kind in IMAGE_USERS}
    root = private_directory(directory, new=True)
    values = {f"PRACTICE_{kind}_IMAGE": value for kind, value in verified.items()}
    values.update(PRACTICE_PORT=str(port), PRACTICE_OWNER_PASSWORD=secrets.token_hex(32),
                  PRACTICE_RUNTIME_PASSWORD=secrets.token_hex(32))
    fd = os.open(root / "practice.env", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write("\n".join(f"{key}={value}" for key, value in values.items()) + "\n")
    marker = {"format": 1, "purpose": "practice", "project": PROJECT,
              "port": port, "images": verified}
    fd = os.open(root / "identity.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(marker, stream)
    return root


def compose_command(root):
    return ["docker", "compose", "--project-name", PROJECT, "--env-file", str(root / "practice.env"),
            "-f", str(COMPOSE)]


def validate_definition(config):
    if config.get("name") != PROJECT or set(config.get("services", {})) != SERVICES:
        raise ValueError("Unexpected practice project or services")
    networks = config.get("networks", {})
    if set(networks) != {"practice", "entry"} or networks["practice"].get("internal") is not True:
        raise ValueError("Practice requires its private internal and dedicated entry networks")
    for name, network in networks.items():
        if (network.get("name") != PROJECT + "_" + name or network.get("external")
                or network.get("driver", "bridge") != "bridge" or network.get("driver_opts")
                or network.get("ipam") or (name == "entry" and network.get("internal", False))):
            raise ValueError("Practice cannot reuse or customize another network")
    if set(config.get("volumes", {})) != VOLUMES:
        raise ValueError("Unexpected practice volumes")
    for key, volume in config["volumes"].items():
        if (volume.get("name") != PROJECT + "_" + key or volume.get("external")
                or volume.get("driver_opts") or volume.get("labels", {}).get(PURPOSE) != "practice"):
            raise ValueError("Practice cannot attach external or host-backed data volumes")
    for name, service in config["services"].items():
        expected_networks = {"practice", "entry"} if name == "web" else {"practice"}
        if set(service.get("networks", {})) != expected_networks:
            raise ValueError("Practice service has unexpected network access")
        if service.get("labels", {}).get(PURPOSE) != "practice" or service.get("privileged"):
            raise ValueError("Practice requires unprivileged labelled services")
        if service.get("network_mode") or service.get("env_file"):
            raise ValueError("Practice must not inherit host networking or other env files")
        for mount in service.get("volumes", []):
            if mount.get("type") != "volume" or mount.get("source") not in VOLUMES:
                raise ValueError("Practice services cannot mount host or production paths")
        ports = service.get("ports", [])
        if name != "web" and ports:
            raise ValueError("Only the practice web service may publish a port")
        if name == "web" and (len(ports) != 1 or ports[0].get("host_ip") != "127.0.0.1"):
            raise ValueError("Practice web must bind only localhost")
        if name in {"api", "migrate"}:
            environment = service["environment"]
            if environment.get("PRACTICE_MODE") != "true":
                raise ValueError("Practice runtime guard must be enabled")
            for key in ("NK_GENIOS_API_ENABLED", "NK_GENIOS_WEB_ENABLED", "AGENT_PUBLIC_ENABLED",
                        "VOICE_ENABLED", "NARRATION_GENERATION_ENABLED", "BACKUP_REQUESTS_ENABLED"):
                if environment.get(key) != "false":
                    raise ValueError("Practice cannot enable supplier or host-maintenance capabilities")
            for key in ("NK_GENIOS_API_KEY", "NK_GENIOS_WEB_APP_KEY", "VOICE_API_KEY", "AGENT_ACCESS_CODE"):
                if environment.get(key):
                    raise ValueError("Practice cannot contain supplier credentials")
    owner = config["services"]["db"]["environment"].get("POSTGRES_PASSWORD")
    migration = config["services"]["migrate"]["environment"]
    runtime = config["services"]["api"]["environment"]
    if not owner or migration.get("DB_PASSWORD") != owner:
        raise ValueError("Practice migration must receive its own database owner credential")
    if runtime.get("DB_PASSWORD") or runtime.get("DB_APP_PASSWORD"):
        raise ValueError("Practice online runtime must not receive owner or role-management credentials")
    database = config["services"]["db"]["environment"]
    runtime_password = migration.get("DB_APP_PASSWORD", "")
    if (database.get("POSTGRES_USER") != "practice_owner" or database.get("POSTGRES_DB") != "twinnku_practice"
            or not runtime_password or runtime_password == owner
            or migration.get("DATABASE_URL") != f"postgresql+psycopg://practice_owner:{owner}@db:5432/twinnku_practice"
            or runtime.get("DATABASE_URL") != f"postgresql+psycopg://practice_runtime:{runtime_password}@db:5432/twinnku_practice"):
        raise ValueError("Practice database URLs must match their separate migration and runtime roles")
    return config


def validate_existing(kind, metadata, marker):
    expected_network = PROJECT + "_practice"
    entry_network = PROJECT + "_entry"
    expected_volumes = {PROJECT + "_" + name for name in VOLUMES}
    if kind == "volume":
        if (metadata.get("Name") not in expected_volumes or metadata.get("Driver") != "local"
                or metadata.get("Options") not in (None, {})):
            raise ValueError("Existing practice volume has unexpected name, driver or host backing")
    elif kind == "network":
        name = metadata.get("Name")
        if (name not in {expected_network, entry_network} or metadata.get("Driver") != "bridge"
                or metadata.get("Internal") is not (name == expected_network) or metadata.get("Ingress")
                or metadata.get("Options")):
            raise ValueError("Existing practice network has unexpected identity or external access")
    else:
        config, host = metadata.get("Config", {}), metadata.get("HostConfig", {})
        service = config.get("Labels", {}).get("com.docker.compose.service")
        roles = {"api": "API", "migrate": "API", "db": "DB", "web": "WEB"}
        if service not in roles or metadata.get("Image") != marker["images"][roles[service]]:
            raise ValueError("Existing practice container has unexpected service or image")
        expected_networks = {expected_network, entry_network} if service == "web" else {expected_network}
        if (host.get("Privileged") or host.get("CapAdd")
                or host.get("NetworkMode") not in expected_networks or host.get("PidMode") == "host"):
            raise ValueError("Existing practice container has unexpected host access")
        networks = metadata.get("NetworkSettings", {}).get("Networks", {})
        if set(networks) - expected_networks:
            raise ValueError("Existing practice container is attached to another network")
        if metadata.get("State", {}).get("Running") and set(networks) != expected_networks:
            raise ValueError("Running practice container is missing a required owned network")
        destinations = {
            "db": {"/var/lib/postgresql/data": (PROJECT + "_practice_db", True)},
            "api": {"/data/maps": (PROJECT + "_practice_maps", False),
                    "/data/floors": (PROJECT + "_practice_assets", True)},
            "web": {}, "migrate": {},
        }[service]
        # Compose short-syntax named volumes also appear in HostConfig.Binds.
        # Accept only the exact owned volume/target/mode, then independently
        # inspect the resolved mounts below; an actual host bind is never valid.
        allowed_binds = {
            f"{name}:{destination}:{'rw' if writable else 'ro'}"
            for destination, (name, writable) in destinations.items()
        }
        allowed_binds.update(
            f"{name}:{destination}" for destination, (name, writable) in destinations.items() if writable
        )
        binds = host.get("Binds") or []
        if not isinstance(binds, list) or any(bind not in allowed_binds for bind in binds):
            raise ValueError("Existing practice container has an unexpected host bind definition")
        seen = set()
        for mount in metadata.get("Mounts", []):
            if mount.get("Type") == "tmpfs" and mount.get("Destination") == "/tmp":
                continue
            destination = mount.get("Destination")
            if (mount.get("Type") != "volume" or destination not in destinations or destination in seen
                    or (mount.get("Name"), mount.get("RW")) != destinations[destination]):
                raise ValueError("Existing practice container has an unexpected data mount")
            seen.add(destination)
        if seen != set(destinations):
            raise ValueError("Existing practice container data mounts do not match its service")
        ports = host.get("PortBindings") or {}
        if service == "web":
            if ports != {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(marker["port"])}]}:
                raise ValueError("Existing practice web has an unexpected published port")
            if metadata.get("State", {}).get("Running"):
                actual_ports = metadata.get("NetworkSettings", {}).get("Ports", {})
                if actual_ports.get("8080/tcp") != ports["8080/tcp"] or any(
                        value for key, value in actual_ports.items() if key != "8080/tcp"):
                    raise ValueError("Practice web port was not actually published to loopback")
        elif ports:
            raise ValueError("Existing practice internal service exposes a host port")


def verify(root):
    for filename in ("practice.env", "identity.json"):
        path = root / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError("Practice configuration files must be private regular files")
    marker = json.loads((root / "identity.json").read_text(encoding="utf-8"))
    if marker.get("purpose") != "practice" or marker.get("project") != PROJECT or marker.get("format") != 1:
        raise ValueError("Missing practice ownership marker")
    for kind, image in marker["images"].items():
        image_identity(image, kind)
    config = validate_definition(json.loads(command([*compose_command(root), "config", "--format", "json"])))
    for service, kind in (("api", "API"), ("migrate", "API"), ("web", "WEB"), ("db", "DB")):
        if config["services"][service]["image"] != marker["images"][kind]:
            raise ValueError("Practice configuration images differ from the initialized set")
    if int(config["services"]["web"]["ports"][0]["published"]) != marker["port"]:
        raise ValueError("Practice port differs from its ownership marker")
    # An existing Docker resource with the same project name must also carry our
    # explicit purpose label. This check precedes stop/reset as well as startup.
    for kind in ("container", "network", "volume"):
        listing = ["docker", kind, "ls", "-aq" if kind == "container" else "-q"]
        keys = set(command([*listing, "--filter", f"label=com.docker.compose.project={PROJECT}"]).split())
        # Also reject unlabelled pre-existing resources that collide with names;
        # a project-label filter alone would miss those foreign volumes.
        keys.update(command([*listing, "--filter", f"name={PROJECT}"]).split())
        for key in keys:
            metadata = json.loads(command(["docker", kind, "inspect", key]))[0]
            labels = metadata.get("Config", {}).get("Labels", {}) if kind == "container" else metadata.get("Labels", {})
            if labels.get(PURPOSE) != "practice" or labels.get("com.docker.compose.project") != PROJECT:
                raise ValueError("Existing project resource lacks the practice ownership label")
            validate_existing(kind, metadata, marker)
    return marker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("init", "verify", "up", "stop", "reset"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--api-image")
    parser.add_argument("--web-image")
    parser.add_argument("--db-image")
    parser.add_argument("--port", type=int, default=8098)
    parser.add_argument("--confirm-reset", action="store_true")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("Run this maintenance tool on the Linux Docker host")
    try:
        if args.action == "init":
            if not all((args.api_image, args.web_image, args.db_image)):
                parser.error("init requires all three reviewed local image IDs")
            root = initialize(args.directory, {"API": args.api_image, "WEB": args.web_image,
                                               "DB": args.db_image}, args.port)
        else:
            root = private_directory(args.directory)
        marker = verify(root)
        if args.action == "up":
            command([*compose_command(root), "up", "-d", "--wait", "--wait-timeout", "120"])
            probe = "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/api/v1/system/status').read().decode())"
            status = json.loads(command([*compose_command(root), "exec", "-T", "api", "python", "-c", probe]))
            if status["data"].get("environment") != "practice" or status["data"]["capabilities"]["chat"]:
                command([*compose_command(root), "stop"])
                raise ValueError("Practice runtime attestation failed; practice stack was stopped")
        elif args.action == "stop":
            command([*compose_command(root), "stop"])
        elif args.action == "reset":
            if not args.confirm_reset:
                parser.error("reset erases only training data and requires --confirm-reset")
            command([*compose_command(root), "down", "--volumes"])
        print(json.dumps({"action": args.action, "project": PROJECT,
                          "url": f"http://localhost:{marker['port']}",
                          "suppliers": "disabled", "production_changed": False}))
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as error:
        # Do not print subprocess output or configuration values containing secrets.
        parser.exit(1, f"{type(error).__name__}: practice operation did not complete; private configuration preserved\n")


if __name__ == "__main__":
    main()
