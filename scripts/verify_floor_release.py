"""Read-only, labeled-original release verification (Python 3.8+ standard library).

Checks every manifest floor, continues after individual failures, and optionally
writes a JSON report. Exit 0: matches; 1: verification failed; 2: invalid input.
An older manifest can legitimately differ after a reviewed resource update.
"""

import argparse
import hashlib
import ipaddress
import json
import math
import re
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from http.client import HTTPException
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

JSON_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 32 * 1024 * 1024
FLOOR_FIELDS = ("id", "point_id", "map_id", "label", "ordinal", "revision", "attribution")
IMAGE_FIELDS = ("media_type", "width_px", "height_px", "size_bytes", "sha256", "section_label")


class CheckError(ValueError):
    """Fixed diagnostics only; never echo server bodies or redirect URLs."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def site_origin(value):
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        loopback = host == "localhost"
        try:
            loopback = loopback or ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if (
            not host
            or parts.scheme not in ("http", "https")
            or (parts.scheme == "http" and not loopback)
            or parts.username is not None
            or parts.password is not None
            or parts.path not in ("", "/")
            or parts.query
            or parts.fragment
            or any(ord(c) <= 32 for c in value)
        ):
            raise ValueError
        _ = parts.port
        return f"{parts.scheme}://{parts.netloc}"
    except ValueError:
        raise ValueError(
            "Use an HTTPS site origin, or HTTP localhost/loopback; no credentials or path."
        ) from None


def http_reader(base, timeout=30, max_seconds=600):
    """Bound memory and check the total budget between reads; never retry/redirect."""
    base = site_origin(base)
    end = time.monotonic() + max_seconds
    opener = urllib.request.build_opener(NoRedirect)

    def read(path):
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise CheckError("Verification time budget exhausted; resource not read.")
        limit = IMAGE_LIMIT if "/images/" in path else JSON_LIMIT
        request = urllib.request.Request(base + path, headers={"Cache-Control": "no-cache"})
        try:
            with opener.open(request, timeout=min(timeout, remaining)) as response:
                if response.status != 200:
                    raise CheckError(f"Expected HTTP 200, received {response.status}.")
                chunks, size = [], 0
                while True:
                    if time.monotonic() >= end:
                        raise CheckError("Verification time budget exhausted while reading.")
                    chunk = response.read1(min(65536, limit + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        raise CheckError("Response exceeds the JSON/image byte limit.")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get_content_type()
        except urllib.error.HTTPError as error:
            raise CheckError(f"HTTP {error.code}; redirects are not followed.") from None
        except (urllib.error.URLError, OSError, HTTPException):
            raise CheckError(
                "Connection, TLS or response read failed; check network and timeout."
            ) from None

    return read


def validate_manifest(manifest):
    try:
        if (
            manifest["schema_version"] != 1
            or not isinstance(manifest["floors"], list)
            or not manifest["floors"]
        ):
            raise ValueError
        ids, maps, ordinals = set(), set(), set()
        for floor in manifest["floors"]:
            for key in ("id", "point_id", "map_id"):
                if str(UUID(floor[key])) != floor[key]:
                    raise ValueError
            ordinal = (floor["point_id"], floor["ordinal"])
            if floor["id"] in ids or floor["map_id"] in maps or ordinal in ordinals:
                raise ValueError
            ids.add(floor["id"])
            maps.add(floor["map_id"])
            ordinals.add(ordinal)
            if (
                type(floor["ordinal"]) is not int
                or type(floor["revision"]) is not int
                or floor["revision"] < 1
                or not isinstance(floor["label"], str)
                or not floor["label"].strip()
                or not isinstance(floor["attribution"], str)
                or not isinstance(floor["images"], list)
                or not 1 <= len(floor["images"]) <= 32
            ):
                raise ValueError
            sections = set()
            for asset in floor["images"]:
                section = asset.get("section", "main")
                if (
                    asset["variant"] != "labeled"
                    or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", section)
                    or section in sections
                    or asset["media_type"] not in ("image/png", "image/jpeg")
                    or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"])
                    or any(
                        type(asset[key]) is not int or asset[key] < 1
                        for key in ("width_px", "height_px", "size_bytes")
                    )
                    or max(asset["width_px"], asset["height_px"]) > 20000
                    or asset["width_px"] * asset["height_px"] > 40_000_000
                    or asset["size_bytes"] > IMAGE_LIMIT
                ):
                    raise ValueError
                sections.add(section)
        return manifest["floors"]
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ValueError(
            "Invalid manifest: use a complete labeled-only release with unique floor/map/section identities and valid metadata."
        ) from None


def api_data(read, path):
    body, media_type = read(path)
    try:
        if media_type != "application/json" or len(body) > JSON_LIMIT:
            raise ValueError
        payload = json.loads(body)
        if not isinstance(payload, dict) or not payload.get("meta", {}).get("request_id"):
            raise ValueError
        return payload["data"]
    except (ValueError, TypeError, KeyError, AttributeError):
        raise CheckError(
            "Expected a bounded JSON API envelope, not an HTML page or invalid response."
        ) from None


def image_path(served, floor, section):
    path = f"/api/v1/floors/{floor['id']}/images/{floor['revision']}/labeled"
    try:
        url = served["url"]
        parts = urlsplit(url)
        query = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True)
        allowed = [[("section", section)]]
        if section == "main":
            allowed.append([])
        if (
            not isinstance(url, str)
            or any(ord(c) <= 32 for c in url)
            or parts.scheme
            or parts.netloc
            or parts.fragment
            or parts.path != path
            or query not in allowed
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError):
        raise CheckError(
            "Image URL does not match this floor, revision and section; not fetched."
        ) from None
    return path if section == "main" else path + "?section=" + section


def audit(manifest, read):
    floors = validate_manifest(manifest)
    grouped = defaultdict(list)
    for floor in floors:
        grouped[floor["point_id"]].append(floor)
    checks = []

    def record(kind, status, issues=(), **context):
        row = {"kind": kind, "status": status, "issues": list(issues), **context}
        checks.append(row)
        return row

    def skipped_images(floor, message):
        for asset in floor["images"]:
            record(
                "image",
                "skipped",
                [message],
                point_id=floor["point_id"],
                floor_id=floor["id"],
                section=asset.get("section", "main"),
                http_readable=None,
                bytes_match=None,
            )

    try:
        status = api_data(read, "/api/v1/system/status")
        if status["capabilities"]["floors"] is not True:
            raise CheckError("Floor display is disabled or no floor is published.")
        record("system", "pass")
    except CheckError as error:
        record("system", "fail", [str(error)])
    except (KeyError, TypeError):
        record("system", "fail", ["Invalid system capability response."])

    for point_id, expected in grouped.items():
        try:
            rows = api_data(read, f"/api/v1/points/{point_id}/floors")
            if not isinstance(rows, list):
                raise CheckError("Expected a floor list.")
            current = {floor["id"]: floor for floor in rows}
            if len(current) != len(rows):
                raise CheckError("The public floor list contains duplicate IDs.")
            record(
                "building",
                "pass",
                point_id=point_id,
                additional_floors=len(set(current) - {f["id"] for f in expected}),
            )
            error_message = None
        except CheckError as error:
            error_message = str(error)
        except (KeyError, TypeError):
            error_message = "Public floor list is malformed."
        if error_message:
            record("building", "fail", [error_message], point_id=point_id)
            for floor in expected:
                record(
                    "floor",
                    "skipped",
                    ["Building list could not be read."],
                    point_id=point_id,
                    floor_id=floor["id"],
                    label=floor["label"],
                    expected_revision=floor["revision"],
                )
                skipped_images(floor, "Floor metadata could not be read.")
            continue
        for floor in expected:
            actual = current.get(floor["id"])
            context = {
                "point_id": point_id,
                "floor_id": floor["id"],
                "label": floor["label"],
                "expected_revision": floor["revision"],
            }
            if actual is None:
                record("floor", "fail", ["Missing floor in the public building list."], **context)
                skipped_images(floor, "Floor is not public; image not requested.")
                continue
            differences = [key for key in FLOOR_FIELDS if actual.get(key) != floor[key]]
            revision = actual.get("revision")
            floor_check = record(
                "floor",
                "fail" if differences else "pass",
                ["Floor metadata differs: " + ", ".join(differences)] if differences else [],
                observed_revision=revision if type(revision) is int else None,
                **context,
            )
            try:
                assets = actual["images"]
                if not isinstance(assets, list):
                    raise ValueError
                images = {(a["variant"], a.get("section", "main")): a for a in assets}
                expected_keys = {("labeled", a.get("section", "main")) for a in floor["images"]}
                if len(images) != len(assets) or set(images) != expected_keys:
                    raise ValueError
            except (KeyError, TypeError, ValueError):
                floor_check["status"] = "fail"
                floor_check["issues"].append(
                    "Missing, extra, duplicate or malformed image sections."
                )
                skipped_images(floor, "Section identities are inconsistent; images not requested.")
                continue
            if any(key in differences for key in ("id", "point_id", "map_id", "revision")):
                skipped_images(
                    floor,
                    "Floor identity/revision differs; verify the current reviewed manifest, do not reimport an older release.",
                )
                continue
            for asset in floor["images"]:
                section = asset.get("section", "main")
                served = images[("labeled", section)]
                differences = [key for key in IMAGE_FIELDS if served.get(key) != asset.get(key)]
                issues = (
                    ["Image metadata differs: " + ", ".join(differences)] if differences else []
                )
                readable, matches = None, None
                try:
                    path = image_path(served, floor, section)
                    readable = False
                    original, media_type = read(path)
                    readable = True
                    matches = (
                        media_type == asset["media_type"]
                        and len(original) == asset["size_bytes"]
                        and hashlib.sha256(original).hexdigest() == asset["sha256"]
                    )
                    if not matches:
                        issues.append("Original MIME, byte count or SHA256 differs.")
                except CheckError as error:
                    issues.append(str(error))
                record(
                    "image",
                    "fail" if issues else "pass",
                    issues,
                    point_id=point_id,
                    floor_id=floor["id"],
                    section=section,
                    metadata_matches=not differences,
                    http_readable=readable,
                    bytes_match=matches,
                )

    passing_floors = {
        f["id"]
        for f in floors
        if all(c["status"] == "pass" for c in checks if c.get("floor_id") == f["id"])
    }
    passing_buildings = {
        point_id
        for point_id, items in grouped.items()
        if all(f["id"] in passing_floors for f in items)
    }
    return {
        "schema_version": 1,
        "passed": all(c["status"] == "pass" for c in checks),
        "expected": {
            "buildings": len(grouped),
            "floors": len(floors),
            "images": sum(len(f["images"]) for f in floors),
        },
        "verified": {
            "buildings": len(passing_buildings),
            "floors": len(passing_floors),
            "images": sum(c["kind"] == "image" and c["status"] == "pass" for c in checks),
        },
        "checks": checks,
    }


def verify(manifest, read):
    """Keep the original all-or-error library interface for existing callers."""
    report = audit(manifest, read)
    if not report["passed"]:
        raise ValueError(
            next("; ".join(c["issues"]) for c in report["checks"] if c["status"] != "pass")
        )
    return report["verified"]


def bounded_seconds(value):
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= 3600:
        raise argparse.ArgumentTypeError("Use seconds greater than 0 and no more than 3600.")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="Same-origin HTTPS site, or localhost HTTP")
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--json-out", type=Path, help="Save all checks, including failures, as JSON"
    )
    parser.add_argument(
        "--timeout",
        type=bounded_seconds,
        default=30,
        help="Network inactivity timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--max-seconds",
        type=bounded_seconds,
        default=600,
        help="Total budget, checked between reads (default: 600)",
    )
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        if args.json_out and (
            args.json_out.resolve() == args.manifest.resolve()
            or (args.json_out.exists() and args.json_out.samefile(args.manifest))
        ):
            parser.error("The JSON report must not overwrite the source manifest.")
        base = site_origin(args.base_url)
        with args.manifest.open("rb") as source:
            raw = source.read(JSON_LIMIT + 1)
        if len(raw) > JSON_LIMIT:
            raise ValueError("Manifest exceeds 2 MiB.")
        manifest = json.loads(raw)
        report = audit(manifest, http_reader(base, args.timeout, args.max_seconds))
    except (ValueError, OSError):
        parser.error(
            "Invalid site origin or manifest; use the original labeled-only JSON release and an HTTPS origin."
        )
    report.update(
        base_url=base,
        manifest_sha256=hashlib.sha256(raw).hexdigest(),
        generated_at=datetime.now(timezone.utc).isoformat(),  # noqa: UP017 — CLI supports Python 3.8
        elapsed_seconds=round(time.monotonic() - started, 3),
    )
    if args.json_out:
        try:
            args.json_out.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        except OSError:
            parser.error("Cannot write JSON report; choose an existing writable directory.")
    print(
        "PASS" if report["passed"] else "FAIL",
        json.dumps(report["verified"], ensure_ascii=False),
        "— labeled originals matched against manifest",
    )
    for check in report["checks"]:
        if check["status"] == "fail":
            print(
                "FAIL",
                check.get("floor_id", check.get("point_id", "system")),
                check.get("section", ""),
                "; ".join(check["issues"]),
            )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
