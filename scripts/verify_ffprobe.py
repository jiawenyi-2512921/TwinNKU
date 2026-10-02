"""Bind the minimal upstream probe's source, executable, build scope and SBOM.

The image gate scans distro/Python packages with Trivy. Generic upstream C/C++
components also need a CPE-capable scanner: CI scans this bound SBOM with Grype,
including a vulnerable-version canary so an unrecognized component cannot pass.
"""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

VERSION = "9.0.2"
SOURCE_SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
SOURCE_URL = f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz"
PURL = f"pkg:generic/ffmpeg@{VERSION}?build=twinnku-file-probe&source_sha256={SOURCE_SHA256}"
ALLOWED = {
    "PROTOCOL": {"FILE"},
    "DEMUXER": {"MOV", "MATROSKA"},
    "PARSER": {"H264", "HEVC", "AV1", "VP8", "VP9"},
    "DECODER": {"H264", "HEVC", "VP8", "VP9"},
    "ENCODER": set(),
    "MUXER": set(),
}


def digest(path):
    with Path(path).open("rb") as source:
        value = hashlib.sha256()
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def validate_components(header):
    flags = dict(re.findall(r"^#define (CONFIG_[A-Z0-9_]+) ([01])$", header, re.M))
    if not flags:
        raise ValueError("Probe component inventory is absent")
    for category, allowed in ALLOWED.items():
        actual = {
            name.removeprefix("CONFIG_").removesuffix("_" + category)
            for name, enabled in flags.items()
            if name.endswith("_" + category) and enabled == "1"
        }
        if actual != allowed:
            raise ValueError(f"Unexpected {category} build scope: {sorted(actual)}")
    # The exact VEX assertion below is valid only when all these flags are present
    # and disabled. Never infer absence from a missing/changed config file.
    for flag in ("CONFIG_DVDSUB_PARSER", "CONFIG_DVDSUB_DECODER", "CONFIG_MPEGPS_DEMUXER"):
        if flags.get(flag) != "0":
            raise ValueError("DVD subtitle vulnerability scope is not excluded")
    return {key: sorted(value) for key, value in ALLOWED.items()}


def sbom(version=VERSION):
    purl = PURL if version == VERSION else f"pkg:generic/ffmpeg@{version}"
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "components": [
            {
                "type": "library",
                "bom-ref": purl,
                "name": "ffmpeg",
                "version": version,
                "purl": purl,
                "cpe": f"cpe:2.3:a:ffmpeg:ffmpeg:{version}:*:*:*:*:*:*:*",
                "licenses": [{"license": {"id": "LGPL-2.1-or-later"}}],
                "externalReferences": [
                    {
                        "type": "distribution",
                        "url": f"https://ffmpeg.org/releases/ffmpeg-{version}.tar.xz",
                    }
                ],
                **(
                    {"hashes": [{"alg": "SHA-256", "content": SOURCE_SHA256}]}
                    if version == VERSION
                    else {}
                ),
            }
        ],
    }


def inventory(directory, binary):
    source = directory / f"ffmpeg-{VERSION}.tar.xz"
    if digest(source) != SOURCE_SHA256:
        raise ValueError("Probe source checksum changed")
    components = validate_components((directory / "config_components.h").read_text())
    version = subprocess.run(
        [str(binary), "-version"], capture_output=True, text=True, check=True, timeout=10
    ).stdout
    if not version.startswith(f"ffprobe version {VERSION} "):
        raise ValueError("Probe version does not match the signed release")
    return {
        "version": VERSION,
        "source_url": SOURCE_URL,
        "source_sha256": SOURCE_SHA256,
        "binary_sha256": digest(binary),
        "config_sha256": digest(directory / "config.h"),
        "components_sha256": digest(directory / "config_components.h"),
        "components": components,
    }


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def vex():
    return {
        "@context": "https://openvex.dev/ns/v0.2.0",
        "@id": "https://github.com/jiawenyi-2512921/TwinNKU/deploy/ffprobe-9.0.2",
        "author": "TwinNKU maintainers",
        "timestamp": "2026-10-02T16:00:00Z",
        "version": 1,
        "statements": [
            {
                "vulnerability": {"name": "CVE-2026-6385"},
                "products": [{"@id": PURL}],
                "status": "not_affected",
                "justification": "vulnerable_code_not_present",
                "impact_statement": (
                    "Signed upstream 9.0.2 file probe: config_components.h verifies "
                    "DVDSUB_PARSER=0, DVDSUB_DECODER=0, MPEGPS_DEMUXER=0. "
                    "The vulnerable DVD subtitle fragment parser is not compiled. "
                    "https://security-tracker.debian.org/tracker/CVE-2026-6385"
                ),
            }
        ],
    }


def build(directory):
    write_json(directory / "manifest.json", inventory(directory, directory / "ffprobe"))
    write_json(directory / "sbom.cdx.json", sbom())
    write_json(directory / "vex.json", vex())


def verify(directory, binary):
    expected = json.loads((directory / "manifest.json").read_text())
    if inventory(directory, binary) != expected or digest(directory / "ffprobe") != digest(binary):
        raise ValueError("Installed probe and manifest differ")
    if json.loads((directory / "sbom.cdx.json").read_text()) != sbom():
        raise ValueError("Probe component SBOM differs from the actual build")
    if json.loads((directory / "vex.json").read_text()) != vex():
        raise ValueError("Probe VEX assertion differs from the verified build scope")
    print(json.dumps(expected, indent=2))


def canary(report):
    value = json.loads(report.read_text())
    if not any(
        match.get("artifact", {}).get("name") == "ffmpeg"
        and match.get("artifact", {}).get("version") == "7.1.5"
        and match.get("vulnerability", {}).get("severity", "").lower() in {"high", "critical"}
        for match in value.get("matches", [])
    ):
        raise ValueError("Source-component scanner did not detect the vulnerable FFmpeg canary")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "verify", "canary-sbom", "canary-report"])
    parser.add_argument("path", type=Path)
    parser.add_argument("--binary", type=Path, default=Path("/usr/local/bin/ffprobe"))
    args = parser.parse_args()
    if args.command == "build":
        build(args.path)
    elif args.command == "verify":
        verify(args.path, args.binary)
    elif args.command == "canary-sbom":
        write_json(args.path, sbom("7.1.5"))
    else:
        canary(args.path)


if __name__ == "__main__":
    main()
