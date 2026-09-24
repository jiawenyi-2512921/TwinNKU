#!/usr/bin/env python3
"""Render a reviewable reference from the complete (implemented + planned) contract."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def shape(schema):
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "enum" in schema:
        return " / ".join(str(item) for item in schema["enum"])
    if "const" in schema:
        return repr(schema["const"])
    for key in ("anyOf", "oneOf", "allOf"):
        if key in schema:
            return " / ".join(shape(item) for item in schema[key])
    kind = schema.get("type", "object")
    if kind == "array":
        return f"array<{shape(schema.get('items', {}))}>"
    return kind + (f" ({schema['format']})" if "format" in schema else "")


def rules(schema):
    labels = {
        "minLength": "最短",
        "maxLength": "最长",
        "minimum": "最小",
        "maximum": "最大",
        "exclusiveMinimum": "大于",
        "exclusiveMaximum": "小于",
        "minItems": "至少项数",
        "maxItems": "最多项数",
        "pattern": "格式",
    }
    result = [f"{label}: {schema[key]}" for key, label in labels.items() if key in schema]
    if "default" in schema:
        result.append("默认: " + json.dumps(schema["default"], ensure_ascii=False))
    if schema.get("description"):
        result.append(schema["description"])
    for key in ("anyOf", "oneOf"):
        for item in schema.get(key, []):
            inner = rules(item)
            if inner:
                result.append(inner)
    return "; ".join(result) or "—"


def render():
    raw = (ROOT / "contracts/openapi.json").read_bytes()
    contract = json.loads(raw)
    methods = {"get", "post", "put", "patch", "delete", "head", "options"}
    operations = [
        (path, method.upper(), op)
        for path, item in contract["paths"].items()
        for method, op in item.items()
        if method in methods
    ]
    count = {}
    for _, _, op in operations:
        status = op.get("x-implementation-status", "未标记")
        count[status] = count.get(status, 0) + 1
    out = [
        "# HTTP接口与字段完整参考（自动生成）",
        "",
        "由scripts/render_api_reference.py从contracts/openapi.json生成；不要手工改字段。",
        "完整契约含已实现和planned。planned只供开发，不代表生产可调用。",
        "业务约束见21—29；接口上线前必须先处理24中的协议缺口和旧角色命名，不能猜学校平台API。",
        "字段约束只覆盖JSON Schema；来源有效期、关联权限、跨字段状态仍须service和测试保证。",
        "",
        f"接口操作数：{len(operations)}；状态统计：{json.dumps(count, ensure_ascii=False)}。",
        f"契约SHA256：`{hashlib.sha256(raw).hexdigest()}`。",
        "",
        "## 1. 全部端点",
        "",
        "| 方法 | 路径 | operation_id | 状态 | 权限标签 | 请求 | 成功响应 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for path, method, op in operations:
        request = (
            "; ".join(
                f"{mime}: {shape(v.get('schema', {}))}"
                for mime, v in op.get("requestBody", {}).get("content", {}).items()
            )
            or "—"
        )
        response = (
            "; ".join(
                f"{code}: {mime} {shape(v.get('schema', {}))}"
                for code, data in op.get("responses", {}).items()
                if code.startswith("2")
                for mime, v in data.get("content", {}).items()
            )
            or "见契约响应"
        )
        out.append(
            "| "
            + " | ".join(
                cell(v)
                for v in [
                    method,
                    f"`{path}`",
                    op.get("operationId", "—"),
                    op.get("x-implementation-status", "未标记"),
                    op.get("x-auth", "未标记"),
                    request,
                    response,
                ]
            )
            + " |"
        )
    out += [
        "",
        "## 2. 路径与查询参数",
        "",
        "认证cookie、Origin/CSRF和幂等header的业务规则另见04、15、18、24。以下是契约显式声明的参数。",
        "",
    ]
    for path, method, op in operations:
        params = op.get("parameters", [])
        if not params:
            continue
        out += [
            f"### {method} {path}",
            "",
            "| 字段 | 位置 | 必填 | 类型 | 约束 |",
            "| --- | --- | --- | --- | --- |",
        ]
        for param in params:
            out.append(
                "| "
                + " | ".join(
                    cell(v)
                    for v in [
                        param["name"],
                        param["in"],
                        "是" if param.get("required") else "否",
                        shape(param.get("schema", {})),
                        rules(param.get("schema", {})),
                    ]
                )
                + " |"
            )
        out.append("")
    out += [
        "## 3. 全部DTO与字段",
        "",
        "必填表示字段必须出现；nullable表示允许null，两者不是同一件事。数组、最大长度和枚举均须校验。引用模型继续查本节同名标题。",
        "",
    ]
    for name, schema in sorted(contract.get("components", {}).get("schemas", {}).items()):
        out += [f"### {name}", ""]
        if schema.get("description"):
            out += [schema["description"], ""]
        if "properties" not in schema:
            out += [f"类型：{shape(schema)}；{rules(schema)}。", ""]
            continue
        out += [
            f"未知字段：{'拒绝' if schema.get('additionalProperties') is False else '按源模型定义'}。",
            "",
            "| 字段 | 必填 | 类型/枚举 | 约束/默认 |",
            "| --- | --- | --- | --- |",
        ]
        for field, prop in schema["properties"].items():
            out.append(
                "| "
                + " | ".join(
                    cell(v)
                    for v in [
                        field,
                        "是" if field in schema.get("required", []) else "否",
                        shape(prop),
                        rules(prop),
                    ]
                )
                + " |"
            )
        out.append("")
    out += [
        "## 4. 重新生成与审核",
        "",
        "```bash",
        "python3 scripts/render_api_reference.py",
        "python3 scripts/render_api_reference.py --check",
        "```",
        "",
        "新增HTTP接口先修改contracts.py/planned_contract.py或正式router，导出OpenAPI与TS类型，再重新生成本文件。字段变更必须检查旧客户端、权限、迁移、空/错状态。",
        "",
    ]
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "docs/31-api-reference.md"
    result = render()
    if args.check:
        if not target.exists() or target.read_text() != result:
            raise SystemExit("API reference is stale; run scripts/render_api_reference.py")
        print("API reference matches the contract")
    else:
        target.write_text(result)
        print(f"Wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
