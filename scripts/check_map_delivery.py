#!/usr/bin/env python3
"""Small anonymous HTTP delivery check. Python 3.8+, standard library only.

Example: python3 scripts/check_map_delivery.py --base-url https://2512921.cn \
    --json-out map-delivery.json

Makes at most six GET requests. This is not a browser, rendering, CPU or FPS test.
A short-lived child process bounds each request, including DNS and slow bodies.
"""

import argparse
import base64
import datetime
import json
import re
import subprocess
import sys
import time
import zlib
from html.parser import HTMLParser
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

MAX_REQUESTS = 6
HEADER_NAMES = (
    "content-type",
    "content-encoding",
    "content-length",
    "cache-control",
    "etag",
    "vary",
)
CAMPUS_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
HASH_SCRIPT = re.compile(r"^/assets/[^/?]+-[A-Za-z0-9_-]{6,}\.js$")


class CheckError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin(url):
    try:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError()
        if parts.username is not None or parts.password is not None:
            raise ValueError()
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return parts.scheme.lower(), parts.hostname.lower(), port
    except (ValueError, TypeError):
        raise CheckError("URL必须是无用户名、密码的HTTP(S)地址") from None


def base_origin(url):
    origin(url)
    parts = urlsplit(url)
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        raise CheckError("--base-url只接受站点根地址，不接受路径、查询参数或片段")
    return urlunsplit((parts.scheme.lower(), parts.netloc, "", "", ""))


def resource_url(base, href, allow_query=False):
    if not isinstance(href, str) or any(ord(c) < 32 for c in href) or "\\" in href:
        raise CheckError("资源URL格式无效")
    url = urljoin(base + "/", href)
    parts = urlsplit(url)
    if origin(url) != origin(base):
        raise CheckError("已拒绝跨域资源；检查只允许输入站点的同源资源")
    if parts.fragment or (parts.query and not allow_query):
        raise CheckError("已拒绝带查询参数或片段的资源，避免发送潜在凭据")
    return url


def shown_url(url):
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def request_worker(payload):
    """One GET; redirects and proxy/cookie/auth handlers are intentionally absent."""
    url = payload["url"]
    maximum = payload["max_bytes"]
    headers = {
        "User-Agent": "TwinNKU-Map-Delivery-Check/1",
        "Accept": "*/*",
        "Accept-Encoding": "gzip",
    }
    if payload.get("etag"):
        headers["If-None-Match"] = payload["etag"]
    req = Request(url, headers=headers, method="GET")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    started = time.monotonic()
    try:
        try:
            response = opener.open(req, timeout=payload["timeout"])
        except HTTPError as exc:
            response = exc
        with response:
            status = response.code
            selected = {
                name: response.headers.get(name, "")[:512] for name in HEADER_NAMES
            }
            # Do not read or report redirected destinations or error body contents.
            if status not in (200, 304):
                return {
                    "status": status,
                    "headers": selected,
                    "wire_bytes": 0,
                    "decoded_bytes": 0,
                    "body": "",
                    "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                }
            wire = response.read(maximum + 1)
            if len(wire) > maximum:
                raise CheckError("响应体超过字节上限，已停止读取")
            encoding = selected["content-encoding"].lower().strip()
            if encoding == "gzip" and wire:
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                body = decoder.decompress(wire, maximum + 1)
                if len(body) > maximum or decoder.unconsumed_tail:
                    raise CheckError("解压后的响应超过字节上限")
                if not decoder.eof or decoder.unused_data:
                    raise CheckError("gzip响应不完整或包含多个未支持的数据段")
            elif encoding in ("", "identity") or not wire:
                body = wire
            else:
                raise CheckError("响应使用了未支持的压缩格式")
            return {
                "status": status,
                "headers": selected,
                "wire_bytes": len(wire),
                "decoded_bytes": len(body),
                "body": base64.b64encode(body).decode("ascii"),
                "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
            }
    except CheckError as exc:
        return {
            "error": str(exc),
            "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
        }
    except (OSError, ValueError, HTTPException, zlib.error):
        # Raw exceptions can include proxy URLs, redirect URLs or returned content.
        return {
            "error": "网络、TLS、超时或响应解码失败；未记录返回内容和凭据",
            "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
        }


class ScriptSources(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self)
        self.sources = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag.lower() == "script" and values.get("src"):
            self.sources.append(values["src"])


class DeliveryCheck:
    def __init__(self, base_url, timeout=8, max_seconds=45, max_bytes=2097152):
        self.base = base_origin(base_url)
        if (
            not 0 < timeout <= 30
            or not 0 < max_seconds <= 120
            or not 1024 <= max_bytes <= 8388608
        ):
            raise CheckError(
                "timeout须为(0,30]秒，max-seconds须为(0,120]秒，max-bytes须为1024至8388608"
            )
        self.timeout, self.max_seconds, self.max_bytes = timeout, max_seconds, max_bytes
        self.started = time.monotonic()
        self.count = 0
        self.steps = []

    def add(self, name, state, detail, **fields):
        step = {"step": name, "state": state, "detail": detail}
        step.update(fields)
        self.steps.append(step)
        return step

    def get(self, name, href, etag=None, allow_query=False):
        try:
            url = resource_url(self.base, href, allow_query)
        except CheckError as exc:
            self.add(name, "fail", str(exc))
            return None
        remaining = self.max_seconds - (time.monotonic() - self.started)
        if self.count >= MAX_REQUESTS or remaining <= 0:
            self.add(name, "fail", "已达到总请求数或总耗时预算，未发送请求")
            return None
        limit = min(self.timeout, remaining)
        self.count += 1
        payload = {
            "url": url,
            "timeout": limit,
            "max_bytes": self.max_bytes,
            "etag": etag,
        }
        started = time.monotonic()
        try:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--_request"],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=limit,
                check=False,
            )
            if result.returncode:
                raise CheckError("请求子进程失败，未输出可能含敏感信息的诊断文本")
            response = json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            response = {"error": "单请求或总耗时预算已用尽，请求已结束"}
        except (ValueError, OSError, CheckError):
            response = {"error": "无法完成受限HTTP请求"}
        fields = {
            "url": shown_url(url),
            "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
        }
        if "elapsed_ms" in response:
            fields["network_elapsed_ms"] = response["elapsed_ms"]
        fields.update(
            {
                key: response[key]
                for key in ("status", "headers", "wire_bytes", "decoded_bytes")
                if key in response
            }
        )
        if response.get("error"):
            self.add(name, "fail", response["error"], **fields)
            return None
        step = self.add(name, "pass", "已收到HTTP响应；正在核对协议", **fields)
        response["step"] = step
        response["body"] = base64.b64decode(response.get("body", ""))
        if response["status"] not in (200, 304):
            step.update(
                state="fail",
                detail="HTTP {}；所有重定向均拒绝跟随".format(response["status"]),
            )
            return None
        return response

    def data(self, response):
        if response is None:
            return None
        step = response["step"]
        try:
            value = json.loads(response["body"].decode("utf-8"))
            if (
                response["status"] != 200
                or not isinstance(value, dict)
                or not isinstance(value.get("data"), list)
            ):
                raise ValueError()
            if (
                not response["headers"]["content-type"]
                .lower()
                .startswith("application/json")
            ):
                raise ValueError()
            step["detail"] = "API返回有效列表，共{}项".format(len(value["data"]))
            return value["data"]
        except (ValueError, UnicodeDecodeError):
            step.update(
                state="fail", detail="API未返回预期JSON列表；未在报告记录响应正文"
            )
            return None

    def homepage(self):
        response = self.get("homepage", "/")
        if response is None:
            self.add("entry_script", "skip", "首页请求失败，无法确定当前构建脚本")
            return
        step = response["step"]
        if (
            response["status"] != 200
            or "text/html" not in response["headers"]["content-type"].lower()
        ):
            step.update(state="fail", detail="首页不是HTTP200 HTML文档")
            self.add("entry_script", "skip", "首页响应不是应用文档")
            return
        parser = ScriptSources()
        try:
            parser.feed(response["body"].decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            step.update(state="fail", detail="无法解析首页HTML")
            self.add("entry_script", "skip", "无法解析首页脚本入口")
            return
        step["detail"] = "首页HTML可读；未执行页面脚本"
        try:
            sources = [
                src
                for src in parser.sources
                if HASH_SCRIPT.fullmatch(urlsplit(urljoin(self.base, src)).path)
            ]
        except ValueError:
            self.add("entry_script", "fail", "首页脚本URL格式无效，未发送资源请求")
            return
        if not sources:
            self.add(
                "entry_script",
                "skip",
                "首页未发现带hash的/assets/*.js入口，可能尚未部署前端构建",
            )
            return
        script = self.get("entry_script", sources[0])
        if script is None:
            return
        step = script["step"]
        headers = script["headers"]
        if (
            script["status"] != 200
            or not script["body"]
            or not any(
                kind in headers["content-type"].lower()
                for kind in ("javascript", "ecmascript")
            )
        ):
            step.update(state="fail", detail="hash脚本未返回非空HTTP200 JavaScript")
            return
        gzip_ok = headers["content-encoding"].lower().strip() == "gzip"
        cache = headers["cache-control"].lower()
        directives = {part.strip() for part in cache.split(",")}
        cache_ok = (
            "immutable" in directives
            and not {"no-store", "no-cache"}.intersection(directives)
            and bool(re.search(r"(?:^|,)\s*max-age=[1-9][0-9]*(?:\s*,|$)", cache))
        )
        step.update(
            state="pass" if gzip_ok and cache_ok else "warn",
            detail=f"当前入口脚本已读取；gzip={gzip_ok}，hash长期缓存={cache_ok}",
            gzip=gzip_ok,
            immutable_cache=cache_ok,
        )

    def maps(self, requested_campus=None):
        campuses = self.data(self.get("campuses", "/api/v1/campuses"))
        if campuses is None:
            self.skip_map("校区接口读取失败")
            return
        ids = [
            item.get("id")
            for item in campuses
            if isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and CAMPUS_ID.fullmatch(item["id"])
        ]
        if requested_campus and requested_campus not in ids:
            self.add("campus_maps", "skip", "指定校区没有公开部署，未请求地图")
            self.skip_tiles("没有可选公开校区")
            return
        if not ids:
            self.skip_map("没有公开校区；不视为地图性能验收通过")
            return
        campus = requested_campus or ids[0]
        response = self.get(
            "campus_maps",
            f"/api/v1/campuses/{quote(campus)}/maps?kind=campus",
            allow_query=True,
        )
        maps = self.data(response)
        if maps is None:
            self.skip_tiles("地图API读取失败")
            return
        campus_maps = [
            item
            for item in maps
            if isinstance(item, dict)
            and item.get("kind") == "campus"
            and item.get("campus_id") == campus
        ]
        if any(
            not isinstance(item, dict) or item.get("kind") != "campus" for item in maps
        ):
            response["step"].update(
                state="warn",
                detail="kind=campus请求仍返回非校园地图；可能尚未部署筛选优化",
            )
        if not campus_maps:
            self.skip_tiles("没有已公开的校园地图；功能关闭或内容尚未发布")
            return
        info = campus_maps[0]
        try:
            map_id = str(UUID(info["id"]))
            revision = info["revision"]
            tiles = info["tiles"]
            zoom = tiles["min_zoom"]
            if (
                isinstance(revision, bool)
                or not isinstance(revision, int)
                or revision < 1
                or isinstance(zoom, bool)
                or not isinstance(zoom, int)
                or not 0 <= zoom <= 20
            ):
                raise ValueError()
            href = (
                tiles["url_template"]
                .replace("{z}", str(zoom))
                .replace("{x}", "0")
                .replace("{y}", "0")
            )
            validated = resource_url(self.base, href)
            expected_path = f"/api/v1/maps/{map_id}/tiles/{revision}/{zoom}/0/0.png"
            if urlsplit(validated).path != expected_path:
                raise CheckError("瓦片地址不属于选中地图的当前revision，已拒绝请求")
        except CheckError as exc:
            self.add("tile", "fail", str(exc))
            self.add("tile_revalidation", "skip", "首个瓦片地址未通过同源和版本检查")
            return
        except (ValueError, KeyError, TypeError, AttributeError):
            self.add("tile", "fail", "地图缺少有效当前版本或瓦片元数据")
            self.add("tile_revalidation", "skip", "没有可验证的瓦片地址")
            return
        tile = self.get("tile", href)
        if tile is None:
            self.add("tile_revalidation", "skip", "首次瓦片请求失败")
            return
        step = tile["step"]
        step.update(
            map_id=map_id,
            map_revision=revision,
            sampled_tile={"z": zoom, "x": 0, "y": 0},
        )
        if (
            tile["status"] != 200
            or not tile["body"].startswith(b"\x89PNG\r\n\x1a\n")
            or "image/png" not in tile["headers"]["content-type"].lower()
        ):
            step.update(state="fail", detail="瓦片未返回HTTP200 PNG数据")
            self.add("tile_revalidation", "skip", "首次瓦片内容无效")
            return
        cache = {
            part.strip() for part in tile["headers"]["cache-control"].lower().split(",")
        }
        private_cache = {"private", "no-cache"}.issubset(
            cache
        ) and "no-store" not in cache
        step.update(
            state="pass" if private_cache else "warn",
            detail=f"当前版本单瓦片可读；private,no-cache={private_cache}",
            private_revalidation=private_cache,
        )
        etag = tile["headers"]["etag"]
        if not etag or len(etag) > 256 or any(ord(char) < 32 for char in etag):
            self.add(
                "tile_revalidation",
                "fail",
                "首个瓦片缺少有效ETag，无法验证If-None-Match",
            )
            return
        again = self.get("tile_revalidation", href, etag=etag)
        if again is not None:
            matches = (
                again["status"] == 304
                and again["wire_bytes"] == 0
                and again["headers"]["etag"] == etag
            )
            again["step"].update(
                state="pass" if matches else "fail",
                detail="If-None-Match验证%s；期望HTTP304、无正文且ETag一致"
                % ("通过" if matches else "失败"),
            )

    def skip_tiles(self, reason):
        self.add("tile", "skip", reason)
        self.add("tile_revalidation", "skip", reason)

    def skip_map(self, reason):
        self.add("campus_maps", "skip", reason)
        self.skip_tiles(reason)

    def run(self, campus_id=None, strict=False):
        if campus_id and not CAMPUS_ID.fullmatch(campus_id):
            raise CheckError("campus-id格式无效")
        self.homepage()
        self.maps(campus_id)
        if strict:
            for step in self.steps:
                if step["state"] == "warn" or (
                    step["step"] == "entry_script" and step["state"] == "skip"
                ):
                    step.update(
                        state="fail", detail="严格验收未通过：" + step["detail"]
                    )
        states = {step["state"] for step in self.steps}
        overall = (
            "fail"
            if "fail" in states
            else "partial"
            if "skip" in states
            else "warn"
            if "warn" in states
            else "pass"
        )
        return {
            "schema_version": 1,
            "checked_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),  # noqa: UP017 — Python 3.8 compatibility
            "base_url": self.base,
            "result": overall,
            "requests_sent": self.count,
            "elapsed_ms": round((time.monotonic() - self.started) * 1000, 2),
            "limits": {
                "max_requests": MAX_REQUESTS,
                "per_request_seconds": self.timeout,
                "max_seconds": self.max_seconds,
                "max_response_bytes": self.max_bytes,
                "max_decoded_bytes": self.max_bytes,
            },
            "strict": strict,
            "timing_note": "elapsed_ms包含请求子进程启动；network_elapsed_ms为子进程内HTTP读取耗时。",
            "scope": "匿名GET传输与缓存抽样；只测一张瓦片和一个当前hash脚本；不是浏览器渲染、CPU、FPS、全图完整性或真机验收",
            "steps": self.steps,
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        required=True,
        help="站点根地址，例如https://2512921.cn；禁止凭据和查询参数",
    )
    parser.add_argument("--campus-id")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="gzip、hash缓存或瓦片缓存警告按失败退出；未发布地图仍标记skip",
    )
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--timeout", type=float, default=8)
    parser.add_argument("--max-seconds", type=float, default=45)
    parser.add_argument("--max-bytes", type=int, default=2097152)
    args = parser.parse_args(argv)
    try:
        report = DeliveryCheck(
            args.base_url, args.timeout, args.max_seconds, args.max_bytes
        ).run(args.campus_id, strict=args.strict)
    except CheckError as exc:
        parser.error(str(exc))
    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.json_out:
        try:
            args.json_out.write_text(output + "\n", encoding="utf-8")
        except OSError:
            print("无法保存JSON报告；以下仍为实际检测结果。", file=sys.stderr)
            print(output)
            return 2
    print(output)
    return 1 if report["result"] == "fail" else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--_request"]:
        print(json.dumps(request_worker(json.load(sys.stdin))))
    else:
        sys.exit(main())
