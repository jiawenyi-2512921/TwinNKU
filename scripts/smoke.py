import json
import sys
import urllib.request

base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8080"
for path in [
    "/health/live",
    "/health/ready",
    "/api/v1/system/status",
    "/api/v1/campuses",
    "/api/v1/campuses/nku-jinnan/points",
]:
    with urllib.request.urlopen(base + path, timeout=10) as response:
        body = json.load(response)
        if path.startswith("/health"):
            assert body["status"] == "ok", path
        else:
            assert "data" in body and body["meta"]["request_id"], path
    print("PASS", path)
with urllib.request.urlopen(base + "/", timeout=10) as response:
    assert "Twin NKU" in response.read().decode("utf-8")
print("PASS frontend index")
with urllib.request.urlopen(base + "/api/v1/system/status", timeout=10) as response:
    enabled = json.load(response)["data"]["capabilities"]["map"]
if enabled:
    with urllib.request.urlopen(base + "/api/v1/campuses/nku-jinnan/maps", timeout=10) as response:
        maps = json.load(response)["data"]
    assert maps, "map capability enabled without a published map"
    for info in maps:
        with urllib.request.urlopen(base + f'/api/v1/maps/{info["id"]}/features', timeout=10) as response:
            features = json.load(response)["data"]
            assert features["map_id"] == info["id"] and features["map_revision"] == info["revision"]
        tile = info["tiles"]["url_template"].format(z=0, x=0, y=0)
        with urllib.request.urlopen(base + tile, timeout=10) as response:
            assert response.headers["Content-Type"] == "image/png"
            assert response.read(8) == b"\x89PNG\r\n\x1a\n"
    print("PASS published maps, versioned geometries and PNG tiles")
else:
    print("Map content is not published or MAP_ENABLED is false; map checks not run.")
