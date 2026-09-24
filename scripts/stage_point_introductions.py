#!/usr/bin/env python3
"""Stage sourced introductions through the existing authenticated review API.

Standard library only (Python 3.8+). No SQL, auto-publish, asset writes or seed imports.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import json
import re
import sys
from collections import Counter
from datetime import date
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener
from uuid import UUID

DEFAULT_PACK = Path(__file__).resolve().parents[1] / "data/introductions/jinnan-20260924.json"
BASE = "/api/v1/admin"
SOURCE_MARKER = "\n\n资料来源：\n"


class ApiFailure(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(f"HTTP {status} / {code}")


class NoRedirect(HTTPRedirectHandler):
    """Never forward authenticated request bodies or CSRF headers to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def valid_source_url(value):
    if not isinstance(value, str) or re.search(r"[\s\\()\[\]<>]", value):
        return False
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and not parsed.username
            and not parsed.password
            and parsed.port in (None, 443)
        )
    except ValueError:
        return False


def render_summary(pack, entry):
    links = []
    for sid in entry["source_ids"]:
        source = pack["sources"][sid]
        links.append(f"[{source['title']}]({source['url']})" if source["url"] else source["title"])
    return (
        "\n\n".join(entry["paragraphs"])
        + SOURCE_MARKER
        + "\n".join(links)
        + "\n资料核对："
        + pack["checked_on"]
    )


def load_pack(path):
    pack = json.loads(Path(path).read_text(encoding="utf-8"))
    if pack.get("schema_version") != 1 or pack.get("status") != "editorial_draft":
        raise ValueError("需要 schema_version=1 的 editorial_draft 内容包")
    if not re.fullmatch(r"[a-z0-9-]+", pack["id"]):
        raise ValueError("内容包 ID 无效")
    date.fromisoformat(pack["checked_on"])
    if not pack["entries"] or not pack["sources"]:
        raise ValueError("内容包为空")
    for source in pack["sources"].values():
        title = source["title"]
        if not title.strip() or re.search(r"[\n\r\[\]]", title):
            raise ValueError("来源标题格式无效")
        if source["url"] is not None and not valid_source_url(source["url"]):
            raise ValueError("来源只接受无凭据的 HTTPS 链接")
    ids = set()
    for entry in pack["entries"]:
        pid = entry["point_id"]
        if str(UUID(pid)) != pid or pid in ids:
            raise ValueError("点位 ID 重复或无效")
        ids.add(pid)
        if not entry["expected_name"].strip() or not entry["paragraphs"] or not entry["source_ids"]:
            raise ValueError("点位缺少名称、正文或来源")
        if entry["evidence_level"] not in {"official", "map_only"}:
            raise ValueError("证据类型无效")
        if any(
            not isinstance(p, str) or not p.strip() or SOURCE_MARKER in p
            for p in entry["paragraphs"]
        ):
            raise ValueError("正文为空或包含保留的来源分隔符")
        if len(render_summary(pack, entry)) > 2000:
            raise ValueError(f"介绍超过接口 2000 字符限制：{entry['expected_name']}")
    return pack


def prepare_update(current, pack, entry, maps, replace_existing=False):
    """Copy only the CURRENT formal record; reject ambiguity and any pending work."""
    point = current["point"]
    if point["id"] != entry["point_id"] or point["campus_id"] != pack["campus_id"]:
        return "identity_mismatch", None
    if point["name"] != entry["expected_name"]:
        return "name_changed", None
    if current["status"] != "published" or current["visibility"] != "public":
        return "not_public", None
    draft = current.get("draft")
    if draft and draft["state"] not in {"published", "discarded"}:
        return "pending_draft", None
    summary = render_summary(pack, entry)
    if point["summary"] == summary:
        return "unchanged", None
    if point["summary"].strip() and not replace_existing:
        return "existing_summary", None
    geometries = current["geometries"]
    # The v1 draft API carries a single geometry. Never choose an arbitrary one.
    if len(geometries) != 1:
        return "ambiguous_geometry", None
    geo = geometries[0]
    m = next((m for m in maps if m["id"] == geo["map_id"]), None)
    if (
        not m
        or m["campus_id"] != point["campus_id"]
        or m["kind"] != "campus"
        or m["revision"] != geo["map_revision"]
    ):
        return "stale_map", None
    payload = {k: copy.deepcopy(point[k]) for k in ("campus_id", "name", "aliases", "category")}
    payload.update(
        summary=summary,
        visibility=current["visibility"],
        geometry={
            k: copy.deepcopy(geo[k])
            for k in ("map_id", "map_revision", "anchor", "polygon", "label_on_map")
        },
        source_note=f"介绍补充包 {pack['id']}；仅补正文，沿用当前正式点位几何。\n"
        f"证据级别：{entry['evidence_level']}；来源见正文末尾。\n" + entry.get("editor_note", ""),
        expected_point_revision=point["revision"],
        expected_revision=draft["revision"] if draft else 0,
    )
    return "ready", payload


class Client:
    def __init__(self, origin):
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"https", "http"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
            or re.search(r"[\s\\]", origin)
        ):
            raise ValueError("站点地址必须是完整 HTTPS origin，不含路径或凭据")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("非本机连接必须使用 HTTPS")
        self.origin = origin.rstrip("/")
        self.csrf = None
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()), NoRedirect())

    def request(self, method, path, payload=None):
        if not path.startswith(BASE + "/") or "?" in path or ".." in path:
            raise ValueError("只调用本项目固定后台路径")
        headers = {"Accept": "application/json", "Origin": self.origin}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = Request(
            self.origin + path,
            method=method,
            headers=headers,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
        )
        try:
            with self.opener.open(request, timeout=25) as response:
                result = json.loads(response.read(4 * 1024 * 1024))
        except HTTPError as exc:
            # Do not dump response bodies, which may include request values.
            try:
                code = json.loads(exc.read(65536)).get("error", {}).get("code", "HTTP_ERROR")
            except (ValueError, AttributeError):
                code = "HTTP_ERROR"
            if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,80}", code):
                code = "HTTP_ERROR"
            raise ApiFailure(exc.code, code) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise ApiFailure(0, "TRANSPORT_OR_RESPONSE_ERROR") from None
        if not isinstance(result, dict) or "data" not in result:
            raise ApiFailure(0, "INVALID_RESPONSE")
        return result["data"]


def stage_one(api, pack, entry, maps, apply=False, submit=False, replace_existing=False):
    path = BASE + "/points/" + entry["point_id"]
    state = "reading"
    try:
        current = api.request("GET", path)
        status, payload = prepare_update(current, pack, entry, maps, replace_existing)
        if status != "ready" or not apply:
            return {"status": status}
        state = "saving"
        saved = api.request("PUT", path, payload)
        if not submit:
            return {"status": "staged", "draft_revision": saved["draft"]["revision"]}
        state = "submitting"
        submitted = api.request(
            "POST",
            path + "/submit",
            {
                "expected_revision": saved["draft"]["revision"],
                "note": f"资料包 {pack['id']}：请独立审核正文、来源及名称差异说明。",
            },
        )
        return {"status": "submitted", "draft_revision": submitted["draft"]["revision"]}
    except ApiFailure as exc:
        # A response timeout cannot prove a write failed. No write retries here.
        return {
            "status": "error",
            "phase": state,
            "http_status": exc.status,
            "code": exc.code,
            "check_backend_before_retry": state != "reading",
        }


def review_markdown(pack):
    lines = [
        f"# 津南校区点位介绍审阅稿（{pack['checked_on']}）",
        "",
        "状态：编辑初稿，须经独立审核后发布。仅补介绍，不导入历史地图。",
        "",
        "学院沿革不等于楼宇历史；map_only 条目只提供地图可确认的信息。",
        "",
    ]
    for entry in pack["entries"]:
        lines += [
            "## " + entry["expected_name"],
            "",
            f"点位 ID：`{entry['point_id']}` · 证据：`{entry['evidence_level']}`",
            "",
            render_summary(pack, entry),
            "",
        ]
        if entry.get("editor_note"):
            lines += ["编辑核对：" + entry["editor_note"], ""]
    lines += ["## 来源适用范围", ""]
    for key, source in pack["sources"].items():
        lines += [f"- `{key}` — {source['title']}：{source['evidence_scope']}"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, default=DEFAULT_PACK)
    parser.add_argument(
        "--validate-only", action="store_true", help="仅校验本地内容包，不访问服务器"
    )
    parser.add_argument("--render-review", type=Path, help="将完整审阅稿写入此文件，不访问服务器")
    parser.add_argument("--base-url", help="例如 https://2512921.cn")
    parser.add_argument("--username", help="已有后台账号；密码交互输入，不传命令行")
    parser.add_argument("--apply", action="store_true", help="保存草稿；缺省仅预览")
    parser.add_argument(
        "--submit", action="store_true", help="保存后提请独立审核，须与 --apply 合用"
    )
    parser.add_argument("--point-id", action="append", default=[], help="仅处理指定 UUID，可重复")
    parser.add_argument(
        "--replace-point-id",
        action="append",
        default=[],
        help="显式允许更新此 UUID 的非空正式介绍，可重复；仍不覆盖待处理草稿",
    )
    args = parser.parse_args()
    try:
        pack = load_pack(args.pack)
        if args.render_review:
            args.render_review.write_text(review_markdown(pack), encoding="utf-8")
            return 0
        if args.validate_only:
            print(
                json.dumps(
                    {
                        "entries": len(pack["entries"]),
                        "evidence": dict(Counter(e["evidence_level"] for e in pack["entries"])),
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        if not args.base_url or not args.username or (args.submit and not args.apply):
            parser.error("连接后台需要 --base-url 和 --username；--submit 必须配合 --apply")
        ids = {e["point_id"] for e in pack["entries"]}
        if (set(args.point_id) | set(args.replace_point_id)) - ids:
            parser.error("指定了内容包中不存在的点位 ID")
        api = Client(args.base_url)
        try:
            session = api.request(
                "POST",
                BASE + "/auth/login",
                {
                    "username": args.username,
                    "password": getpass.getpass("后台密码（不回显）："),
                },
            )
            api.csrf = session["csrf_token"]
            if session["user"]["must_change_password"]:
                raise ValueError("请先在网页后台完成首次密码修改")
            if args.apply and "points.edit" not in session["permissions"]:
                raise ValueError("保存草稿需要 points.edit 权限")
            maps = api.request("GET", BASE + "/maps")
            counts = Counter()
            for entry in pack["entries"]:
                if args.point_id and entry["point_id"] not in args.point_id:
                    continue
                result = stage_one(
                    api,
                    pack,
                    entry,
                    maps,
                    args.apply,
                    args.submit,
                    entry["point_id"] in args.replace_point_id,
                )
                counts[result["status"]] += 1
                print(
                    json.dumps(
                        {"point_id": entry["point_id"], "name": entry["expected_name"], **result},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                if result.get("http_status") in {0, 401, 429, 503}:
                    print("连接或服务状态异常，停止后续操作；请核对后台后再运行。", file=sys.stderr)
                    break
            print(
                json.dumps({"totals": dict(counts), "published_by_script": 0}, ensure_ascii=False)
            )
            return 2 if counts["error"] else 0
        finally:
            if api.csrf:
                try:
                    api.request("POST", BASE + "/auth/logout", {})
                except ApiFailure:
                    print("退出请求未确认；可在后台会话管理中检查。", file=sys.stderr)
                api.csrf = None
    except (ValueError, KeyError, TypeError, OSError, ApiFailure) as exc:
        print(f"未完成：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
