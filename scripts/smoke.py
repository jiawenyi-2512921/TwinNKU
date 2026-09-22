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
