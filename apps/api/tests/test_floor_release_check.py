import copy
import hashlib
import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import pytest
from PIL import Image

from app.models import PointRecord
from app.modules.floors.import_bundle import import_bundle, inspect_image

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "floor_release_check", ROOT / "scripts/verify_floor_release.py"
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def envelope(data):
    return json.dumps({"data": data, "meta": {"request_id": "test-request"}}).encode()


@pytest.fixture
def release():
    # Disposable wire fixtures; these bytes are not claimed to be campus originals.
    points = [str(uuid4()), str(uuid4())]
    floors, resources = [], {}
    for index in range(3):
        floor = {
            "id": str(uuid4()),
            "point_id": points[index // 2],
            "map_id": str(uuid4()),
            "label": f"{index + 1}层",
            "ordinal": index + 1,
            "revision": 2,
            "attribution": "Test fixture",
            "images": [],
        }
        for section in ["a", "b"] if index == 0 else ["main"]:
            original = f"fixture {index} {section}".encode()
            image = {
                "variant": "labeled",
                "section": section,
                "section_label": section.upper(),
                "width_px": 20,
                "height_px": 30,
                "media_type": "image/png",
                "size_bytes": len(original),
                "sha256": hashlib.sha256(original).hexdigest(),
            }
            floor["images"].append(image)
            url = f"/api/v1/floors/{floor['id']}/images/2/labeled" + (
                f"?section={section}" if section != "main" else ""
            )
            resources[url] = (original, "image/png")
        floors.append(floor)
    manifest = {"schema_version": 1, "floors": floors}
    published = copy.deepcopy(floors)
    for floor in published:
        for image in floor["images"]:
            section = image["section"]
            image["url"] = f"/api/v1/floors/{floor['id']}/images/2/labeled" + (
                f"?section={section}" if section != "main" else ""
            )
    reads = []

    def read(path):
        reads.append(path)
        if path == "/api/v1/system/status":
            return envelope({"capabilities": {"floors": True}}), "application/json"
        for point in points:
            if path == f"/api/v1/points/{point}/floors":
                return envelope(
                    [f for f in published if f["point_id"] == point]
                ), "application/json"
        return resources[path]

    return manifest, published, resources, reads, read


def test_all_sections_and_legacy_verify_interface(release):
    manifest, _, _, reads, read = release
    report = check.audit(manifest, read)
    assert report["passed"]
    assert report["verified"] == report["expected"] == {"buildings": 2, "floors": 3, "images": 4}
    assert len(reads) == 7  # status + two buildings + four originals
    assert all(
        c["http_readable"] and c["bytes_match"] for c in report["checks"] if c["kind"] == "image"
    )
    assert check.verify(manifest, read) == report["expected"]


def test_collects_multiple_failures_and_preserves_reviewed_newer_revision(release):
    manifest, published, resources, reads, read = release
    corrupt = published[0]["images"][1]["url"]
    resources[corrupt] = (b"changed bytes", "image/png")
    missing = published.pop(1)
    published[-1]["revision"] = 3
    report = check.audit(manifest, read)
    assert not report["passed"]
    assert report["verified"] == {"buildings": 0, "floors": 0, "images": 1}
    assert report["expected"]["images"] == 4
    image = next(c for c in report["checks"] if c.get("section") == "b")
    assert image["metadata_matches"] and image["http_readable"] and image["bytes_match"] is False
    absent = next(
        c for c in report["checks"] if c["kind"] == "floor" and c["floor_id"] == missing["id"]
    )
    assert absent["status"] == "fail"
    updated = next(
        c for c in report["checks"] if c["kind"] == "floor" and c["floor_id"] == published[-1]["id"]
    )
    assert updated["observed_revision"] == 3 and updated["expected_revision"] == 2
    assert len([path for path in reads if "/images/" in path]) == 2
    with pytest.raises(ValueError):
        check.verify(manifest, read)


def test_image_metadata_drift_is_distinct_from_matching_bytes(release):
    manifest, published, _, _, read = release
    published[0]["images"][0]["width_px"] += 1
    report = check.audit(manifest, read)
    image = next(c for c in report["checks"] if c.get("section") == "a")
    assert image["status"] == "fail" and not image["metadata_matches"]
    assert image["http_readable"] and image["bytes_match"]
    assert report["verified"] == {"buildings": 1, "floors": 2, "images": 3}


def test_additional_published_floors_are_reported_but_not_counted_as_this_release(release):
    manifest, published, _, reads, read = release
    extra = copy.deepcopy(published[-1])
    extra["id"] = str(uuid4())
    published.append(extra)
    report = check.audit(manifest, read)
    assert report["passed"]
    assert report["verified"] == {"buildings": 2, "floors": 3, "images": 4}
    assert sum(c.get("additional_floors", 0) for c in report["checks"]) == 1
    assert not any(extra["id"] in path for path in reads)


def test_disabled_floor_capability_cannot_produce_a_pass(release):
    manifest, _, _, _, read = release

    def disabled(path):
        if path == "/api/v1/system/status":
            return envelope({"capabilities": {"floors": False}}), "application/json"
        return read(path)

    report = check.audit(manifest, disabled)
    assert not report["passed"]
    assert report["checks"][0]["status"] == "fail"


@pytest.mark.parametrize("change", ["duplicate", "missing", "extra"])
def test_invalid_section_set_is_not_silently_collapsed(release, change):
    manifest, published, _, reads, read = release
    images = published[0]["images"]
    if change == "duplicate":
        images.append(copy.deepcopy(images[0]))
    elif change == "missing":
        images.pop()
    else:
        images.append({**images[0], "section": "c"})
    report = check.audit(manifest, read)
    assert not report["passed"]
    assert report["verified"]["floors"] == 2
    assert not any(published[0]["id"] in path for path in reads)
    assert sum(c["status"] == "skipped" for c in report["checks"]) == 2


@pytest.mark.parametrize("suffix", ["foreign", "revision", "query", "traversal"])
def test_wrong_image_url_is_never_fetched(release, suffix):
    manifest, published, _, reads, read = release
    image = published[0]["images"][0]
    original = image["url"]
    image["url"] = {
        "foreign": "https://invalid.example" + original,
        "revision": original.replace("/2/", "/9/"),
        "query": original + "&token=not-a-real-token",
        "traversal": original.replace("/images/2/", "/images/2/../2/"),
    }[suffix]
    report = check.audit(manifest, read)
    row = next(c for c in report["checks"] if c.get("section") == "a")
    assert row["status"] == "fail" and row["http_readable"] is None
    assert original not in reads and image["url"] not in reads
    assert "not-a-real-token" not in json.dumps(report)


def test_a_building_error_does_not_stop_the_other_building(release):
    manifest, _, _, _, read = release
    first = manifest["floors"][0]["point_id"]

    def failure(path):
        if first in path:
            raise check.CheckError("HTTP 404; redirects are not followed.")
        return read(path)

    report = check.audit(manifest, failure)
    assert not report["passed"]
    assert report["verified"] == {"buildings": 1, "floors": 1, "images": 1}
    assert "HTTP 404" in json.dumps(report)
    assert sum(c["status"] == "skipped" for c in report["checks"]) == 5


@pytest.mark.parametrize(
    "body",
    [b"<html>login</html>", b"null", b'{"data": [], "meta": null}', envelope({"unexpected": True})],
)
def test_malformed_building_response_is_reported_not_crashed(release, body):
    manifest, _, _, _, read = release

    def malformed(path):
        if "/points/" in path:
            return body, "application/json"
        return read(path)

    report = check.audit(manifest, malformed)
    assert not report["passed"] and report["verified"]["images"] == 0


@pytest.mark.parametrize("invalid", ["floor", "section", "clean", "size"])
def test_invalid_manifest_fails_before_any_network_read(release, invalid):
    manifest, _, _, reads, read = release
    if invalid == "floor":
        manifest["floors"].append(copy.deepcopy(manifest["floors"][0]))
    elif invalid == "section":
        manifest["floors"][0]["images"].append(copy.deepcopy(manifest["floors"][0]["images"][0]))
    elif invalid == "clean":
        manifest["floors"][0]["images"][0]["variant"] = "clean"
    else:
        manifest["floors"][0]["images"][0]["size_bytes"] = check.IMAGE_LIMIT + 1
    with pytest.raises(ValueError, match="Invalid manifest"):
        check.audit(manifest, read)
    assert not reads


@pytest.fixture
def local_http():
    routes, seen = {}, []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            assert "Authorization" not in self.headers and "Cookie" not in self.headers
            status, mime, body, headers = routes.get(self.path, (404, "text/plain", b"missing", {}))
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", routes, seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_real_http_cli_writes_success_and_failure_reports(release, local_http, tmp_path, capsys):
    manifest, _, _, _, read = release
    origin, routes, seen = local_http
    check.audit(manifest, read)
    # Materialize the exact wire responses in a real local HTTP server.
    for path in set(release[3]):
        body, mime = read(path)
        routes[path] = (200, mime, body, {})
    manifest_file, output = tmp_path / "manifest.json", tmp_path / "report.json"
    manifest_file.write_text(json.dumps(manifest))
    args = [origin, str(manifest_file), "--json-out", str(output)]
    assert check.main(args) == 0
    report = json.loads(output.read_text())
    assert report["passed"] and report["expected"] == report["verified"]
    assert report["manifest_sha256"] == hashlib.sha256(manifest_file.read_bytes()).hexdigest()
    assert report["generated_at"] and report["base_url"] == origin
    assert len(seen) == 7 and "PASS" in capsys.readouterr().out
    path = next(path for path in routes if "/images/" in path)
    routes[path] = (403, "text/html", b"private body must never be printed", {})
    assert check.main(args) == 1
    report = json.loads(output.read_text())
    assert not report["passed"] and "HTTP 403" in json.dumps(report)
    assert "private body" not in output.read_text() + capsys.readouterr().out


def test_json_output_cannot_overwrite_the_original_manifest(release, tmp_path):
    path = tmp_path / "manifest.json"
    original = json.dumps(release[0])
    path.write_text(original)
    with pytest.raises(SystemExit) as error:
        check.main(["http://localhost", str(path), "--json-out", str(path)])
    assert error.value.code == 2
    assert path.read_text() == original


def test_delivered_full_manifest_is_accepted_without_network_access():
    manifest = json.loads(
        (ROOT / "data/floors/jinnan-v1/labeled-manifest-20260924.json").read_text()
    )
    floors = check.validate_manifest(manifest)
    assert len(floors) == 96
    assert len({floor["point_id"] for floor in floors}) == 20
    assert sum(len(floor["images"]) for floor in floors) == 100


def test_http_reader_rejects_redirect_and_caps_response(local_http, monkeypatch):
    origin, routes, seen = local_http
    routes["/redirect"] = (302, "text/plain", b"", {"Location": origin + "/elsewhere"})
    read = check.http_reader(origin)
    with pytest.raises(check.CheckError, match="HTTP 302"):
        read("/redirect")
    assert seen == ["/redirect"]
    monkeypatch.setattr(check, "JSON_LIMIT", 16)
    routes["/large"] = (200, "application/json", b"x" * 17, {})
    with pytest.raises(check.CheckError, match="byte limit"):
        read("/large")


def test_expired_total_budget_never_opens_another_request(local_http, monkeypatch):
    origin, _, seen = local_http
    clock = [100]
    monkeypatch.setattr(check.time, "monotonic", lambda: clock[0])
    read = check.http_reader(origin, max_seconds=5)
    clock[0] = 106
    with pytest.raises(check.CheckError, match="budget exhausted"):
        read("/not-requested")
    assert not seen


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?token=private",
        "file:///tmp/file",
    ],
)
def test_invalid_origins_are_rejected_without_echoing_input(origin):
    with pytest.raises(ValueError) as error:
        check.site_origin(origin)
    assert origin not in str(error.value)


def test_verifier_reads_real_published_api_bytes_then_detects_withdrawal(tmp_path, client, db):
    point_id, floor_id = str(uuid4()), str(uuid4())
    db.add(
        PointRecord(
            id=point_id,
            campus_id="nku-jinnan",
            name="验收测试楼",
            aliases=[],
            category="academic",
            summary="",
            revision=1,
            status="published",
            visibility="public",
        )
    )
    db.commit()
    root = tmp_path / "bundle"
    directory = root / floor_id / "1"
    directory.mkdir(parents=True)
    original = directory / "labeled.png"
    Image.new("RGB", (30, 20), "white").save(original)
    manifest = {
        "schema_version": 1,
        "source_note": "Test only",
        "floors": [
            {
                "id": floor_id,
                "point_id": point_id,
                "map_id": str(uuid4()),
                "label": "1层",
                "ordinal": 1,
                "revision": 1,
                "attribution": "Test fixture",
                "images": [
                    {"variant": "labeled", "filename": "labeled.png", **inspect_image(original)}
                ],
            }
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    client.app.state.settings.floor_assets_dir = tmp_path / "public-assets"
    import_bundle(
        root,
        client.app.state.settings.floor_assets_dir,
        db,
        reviewer="Test reviewer",
        rights_note="Test fixture",
        publish=True,
    )
    db.commit()

    def read(path):
        response = client.get(path)
        if response.status_code != 200:
            raise check.CheckError(f"HTTP {response.status_code}")
        return response.content, response.headers["content-type"].split(";")[0]

    assert check.verify(manifest, read) == {"buildings": 1, "floors": 1, "images": 1}
    db.get(PointRecord, point_id).status = "retired"
    db.commit()
    report = check.audit(manifest, read)
    assert not report["passed"] and report["verified"]["images"] == 0
    assert any(c["kind"] == "image" and c["status"] == "skipped" for c in report["checks"])
