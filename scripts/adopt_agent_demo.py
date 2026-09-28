"""Import existing demo credentials into the main deployment's private .env.

Run on the server with Python 3.8+. Does not restart services or print secrets.
"""

import argparse
import os
import re
import secrets
import shlex
import subprocess
from pathlib import Path


def parse_env(text, *, raw=False):
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            continue
        if raw:
            values[key.strip()] = value
        else:
            value = value.strip()
            if value.startswith("'") and value.endswith("'"):
                values[key.strip()] = re.sub(r"\\(['\\])", r"\1", value[1:-1])
            else:
                parts = shlex.split(value, comments=True)
                values[key.strip()] = parts[0] if len(parts) == 1 else " ".join(parts)
    return values


def adopt(root, state):
    env = root / ".env"
    if not env.is_file() or env.is_symlink():
        raise ValueError("Project .env must be an existing regular file")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", ".env"],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if tracked.returncode == 0:
        raise ValueError("Refusing to write credentials into a tracked file")
    source = state / "demo.env"
    if not source.is_file() or source.is_symlink():
        raise ValueError("Existing demo.env was not found")
    legacy = parse_env(source.read_text(), raw=True)
    key, code = legacy.get("NK_GENIOS_API_KEY", ""), legacy.get("DEMO_CODE", "")
    if not key or not key.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in key):
        raise ValueError("Legacy API key has an invalid format")
    if not 16 <= len(code) <= 128 or any(c in code for c in "\r\n\x00"):
        raise ValueError("Legacy access code has an invalid format")
    text = env.read_text()
    current = parse_env(text)
    desired = {"NK_GENIOS_API_KEY": key, "AGENT_ACCESS_CODE": code, "NK_GENIOS_API_ENABLED": "true"}
    for name in ["NK_GENIOS_API_KEY", "AGENT_ACCESS_CODE"]:
        if current.get(name) and current[name] != desired[name]:
            raise ValueError("Existing native credentials differ; no file was changed")
    if all(current.get(k) == v for k, v in desired.items()):
        return False
    backup = env.with_name(".env.before-native-agent-" + secrets.token_hex(4))
    fd = os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    kept = [line for line in text.splitlines() if line.partition("=")[0].strip() not in desired]

    def quote(value):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

    content = (
        "\n".join(kept) + "\n" + "\n".join(k + "=" + quote(v) for k, v in desired.items()) + "\n"
    )
    temp = env.with_name(".env.native-agent-" + secrets.token_hex(4))
    try:
        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, env)
    finally:
        if temp.exists():
            temp.unlink()
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--state-dir", type=Path, default=Path("/opt/twinnku-agent-demo"))
    args = parser.parse_args()
    try:
        changed = adopt(args.project_root.resolve(), args.state_dir.resolve())
    except (OSError, ValueError):
        raise SystemExit(
            "Credential import failed; inspect file access and existing configuration. No credentials were printed."
        ) from None
    print(
        "Native agent configuration saved with a private backup."
        if changed
        else "Native agent configuration already matches."
    )
    print("Run the normal deployment to activate it; the old companion is retained for rollback.")


if __name__ == "__main__":
    main()
