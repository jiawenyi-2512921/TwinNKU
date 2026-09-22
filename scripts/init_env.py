"""Create first-install configuration without overwriting existing credentials."""

import argparse
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
from pathlib import Path


def host_value(value: str) -> str:
    value = value.lower().rstrip(".")
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        labels = value.split(".")
        if len(value) > 253 or not all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
        ):
            raise argparse.ArgumentTypeError(
                "host must be an IPv4 address or DNS hostname"
            ) from None
        if all(label.isdigit() for label in labels):
            raise argparse.ArgumentTypeError("invalid IPv4 address") from None
    else:
        if address.version != 4:
            raise argparse.ArgumentTypeError(
                "this bootstrap accepts IPv4 addresses or DNS hostnames"
            )
    return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create .env once, with a random database password. Print only the smoke URL."
    )
    parser.add_argument("--port", type=int, default=8080, help="loopback HTTP port, default 8080")
    parser.add_argument(
        "--host",
        action="append",
        type=host_value,
        default=[],
        help="allowed proxy hostname; repeatable",
    )
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    root = Path(__file__).resolve().parent.parent
    target = root / ".env"
    if target.exists() or target.is_symlink():
        parser.error(".env already exists; preserve it and use scripts/deploy.sh for updates")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", args.port))
        except OSError:
            parser.error("loopback port is unavailable; choose another --port")
    hosts = list(dict.fromkeys(["localhost", "127.0.0.1", "api", *args.host]))
    contents = "\n".join(
        [
            "# Generated on this server. Do not commit or share this file.",
            "APP_ENV=production",
            "APP_VERSION=0.1.0",
            "DB_NAME=twinnku",
            "DB_USER=twinnku",
            "DB_PASSWORD=" + secrets.token_hex(24),
            "ALLOWED_HOSTS=" + json.dumps(hosts, separators=(",", ":")),
            "HTTP_PORT=" + str(args.port),
            "",
        ]
    )
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(contents)
    except FileExistsError:
        parser.error(".env was created concurrently; existing credentials have been preserved")
    print("http://127.0.0.1:" + str(args.port))
    return 0


if __name__ == "__main__":
    sys.exit(main())
