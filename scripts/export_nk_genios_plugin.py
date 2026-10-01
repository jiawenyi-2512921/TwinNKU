"""Build a read-only, implemented-only plugin from the canonical OpenAPI.

No keys, admin endpoints or planned chat endpoints are included.
"""

import argparse
import copy
import json
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
OPERATIONS = {
    "listCampuses": "列出已启用校区，获取真实 campus_id，不要猜测校区ID。",
    "listPoints": "按校区和名称/别名搜索已公开点位；从返回值获取 point_id。结果过多先澄清。",
    "getPoint": "查询已公开点位介绍和版本；资料来源如有记载保留在 summary 中。",
    "listFloors": "查询已发布的楼层和标注图，不据此推断图片中的房间或通行路线。",
    "listPointPanoramas": "查询该点位已审核发布的全景链接；空列表表示当前没有可用全景。",
    "getGuidePoint": "查询点位介绍、楼层、全景和已生成的网页链接；原样返回 links 中的URL供用户点击，不能声称已操作地图。",
}


def validate_origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or "\\" in value
        or any(c.isspace() for c in value)
    ):
        raise ValueError("server must be an HTTPS origin without credentials, path or query")
    return value.rstrip("/")


def references(value):
    if isinstance(value, dict):
        if "$ref" in value:
            prefix = "#/components/schemas/"
            if not value["$ref"].startswith(prefix):
                raise ValueError("external/non-schema references are not permitted")
            yield value["$ref"][len(prefix) :]
        for child in value.values():
            yield from references(child)
    elif isinstance(value, list):
        for child in value:
            yield from references(child)


def to_oas30(value, schemas):
    """Convert the limited JSON Schema constructs used by these six GET DTOs.

    Nullable refs are expanded so nullable has an explicit type in this schema.
    Not a general-purpose OpenAPI converter; fail when new unsupported forms appear.
    """
    if isinstance(value, list):
        return [to_oas30(child, schemas) for child in value]
    if not isinstance(value, dict):
        return value
    result = copy.deepcopy(value)
    variants = result.get("anyOf", [])
    nonnull = [v for v in variants if v.get("type") != "null"]
    if variants and len(nonnull) != len(variants):
        if len(nonnull) != 1:
            raise ValueError("unsupported nullable union")
        inner = nonnull[0]
        if "$ref" in inner:
            inner = schemas[inner["$ref"].split("/")[-1]]
        result.pop("anyOf")
        result = {**inner, **result, "nullable": True}
    if "const" in result:
        result["enum"] = [result.pop("const")]
    for key, bound in (("exclusiveMinimum", "minimum"), ("exclusiveMaximum", "maximum")):
        if key in result and not isinstance(result[key], bool):
            result[bound] = result[key]
            result[key] = True
    if result.get("type") == "null" or isinstance(result.get("type"), list):
        raise ValueError("unsupported JSON Schema type")
    if "default" in result and result["default"] is None:
        result.pop("default")
    return {key: to_oas30(child, schemas) for key, child in result.items()}


def build(server="https://2512921.cn", version="3.0.3"):
    source = json.loads((ROOT / "contracts/openapi.json").read_text())
    paths = {}
    found = set()
    for path, methods in source["paths"].items():
        for method, operation in methods.items():
            name = operation.get("operationId")
            if name not in OPERATIONS:
                continue
            if method != "get" or operation.get("x-implementation-status") != "implemented":
                raise ValueError(f"operation is not implemented and read-only: {name}")
            operation = copy.deepcopy(operation)
            operation["summary"] = OPERATIONS[name].split("；")[0]
            operation["description"] = OPERATIONS[name]
            operation["security"] = []
            paths.setdefault(path, {})[method] = operation
            found.add(name)
    if found != set(OPERATIONS):
        raise ValueError("missing expected operations")
    all_schemas = source["components"]["schemas"]
    schemas = {}
    pending = set(references(paths))
    while pending:
        name = pending.pop()
        if name not in schemas:
            schemas[name] = copy.deepcopy(all_schemas[name])
            pending.update(set(references(schemas[name])) - schemas.keys())
    result = {
        "openapi": version,
        "info": {
            "title": "Twin NKU 校园公开资料",
            "version": "1.0.0",
            "description": "只读查询已公开校园资料。无后台写权限；链接需要用户点击，不会自动控制地图。",
        },
        "servers": [{"url": validate_origin(server)}],
        "paths": paths,
        "components": {"schemas": schemas},
    }
    if version == "3.0.3":
        result = to_oas30(result, schemas)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="https://2512921.cn")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for version, filename in (
        ("3.0.3", "nk-genios.openapi.json"),
        ("3.1.0", "nk-genios.openapi-3.1.json"),
    ):
        text = (
            json.dumps(build(args.server, version), ensure_ascii=False, indent=2, sort_keys=True)
            + "\n"
        )
        if len(text.encode()) > 2 * 1024 * 1024:
            raise SystemExit("plugin exceeds the platform's 2 MiB file limit")
        path = ROOT / "contracts" / filename
        if args.check:
            if not path.exists() or path.read_text() != text:
                raise SystemExit(f"Plugin drift: regenerate {filename}")
        else:
            path.write_text(text)
        print(f"{filename}: {len(text.encode())} bytes, {len(OPERATIONS)} public GET tools")


if __name__ == "__main__":
    main()
