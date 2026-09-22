"""Run from apps/api with uv run python ../../scripts/export_contract.py."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/api"))

from app.contracts import ChatEvent  # noqa: E402
from app.core.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.planned_contract import router  # noqa: E402


def build():
    app = create_app(Settings(app_env="test"))
    app.include_router(router)
    spec = app.openapi()
    spec["info"]["description"] = (
        "Twin NKU v1 complete target contract. Planned endpoints are NOT mounted by the runtime. Inspect x-implementation-status before use."
    )
    spec["servers"] = [{"url": "/", "description": "Same origin; no secrets in browser"}]
    schemas = spec["components"]["schemas"]
    event_schema = ChatEvent.model_json_schema(ref_template="#/components/schemas/{model}")
    schemas.update(event_schema.pop("$defs", {}))
    schemas["ChatEvent"] = event_schema
    spec["components"]["securitySchemes"] = {
        "SessionCookie": {
            "type": "apiKey",
            "in": "cookie",
            "name": "twinnku_session",
            "description": "Opaque session; staff role comes from trusted identity provider.",
        },
    }
    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            auth = operation.get("x-auth", "public")
            if auth not in {"public", "resource_policy"}:
                operation["security"] = [{"SessionCookie": []}]
            if method in {"post", "put", "patch", "delete"} and auth != "public":
                operation.setdefault("parameters", []).append(
                    {
                        "name": "X-CSRF-Token",
                        "in": "header",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                )
            if method == "post" and path.endswith(
                ("/turns", "/routes", "/tour-plans", "/inquiries")
            ):
                operation.setdefault("parameters", []).append(
                    {
                        "name": "Idempotency-Key",
                        "in": "header",
                        "required": True,
                        "schema": {"type": "string", "format": "uuid"},
                    }
                )
            if path.endswith("/events"):
                operation.setdefault("parameters", []).append(
                    {
                        "name": "Last-Event-ID",
                        "in": "header",
                        "required": False,
                        "schema": {"type": "integer", "minimum": 0},
                    }
                )
    return spec


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "contracts/openapi.json"
    content = json.dumps(build(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.check:
        if not target.exists() or target.read_text() != content:
            raise SystemExit("Contract drift: regenerate contracts/openapi.json")
        print("Contract is synchronized.")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        print("Updated contracts/openapi.json")


if __name__ == "__main__":
    main()
