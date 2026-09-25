"""Export public published data to per-point Markdown files for NK-GeniOS.

Only GET requests; does not publish drafts or upload anything to the school platform.
"""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from export_nk_genios_plugin import validate_origin


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(base, path):
    request = Request(
        base + path,
        headers={"Accept": "application/json", "User-Agent": "TwinNKU-Knowledge-Export/1"},
    )
    with build_opener(NoRedirect).open(request, timeout=20) as response:
        if "application/json" not in response.headers.get("Content-Type", ""):
            raise ValueError(
                "server returned a non-JSON response; check domain and login restrictions"
            )
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("response too large")
    payload = json.loads(raw)
    if "data" not in payload or not payload.get("meta", {}).get("request_id"):
        raise ValueError("invalid API envelope")
    return payload


def document(guide, campus_name, exported_at):
    point = guide["point"]
    point_id = str(UUID(point["id"]))
    if not point.get("summary", "").strip():
        return None
    lines = [
        f"# {campus_name} · {point['name']}",
        "",
        f"点位 ID：{point_id}",
        f"校区 ID：{point['campus_id']}",
        f"别名：{'、'.join(point['aliases']) or '未设置'}",
        f"点位版本：{point['revision']}",
        f"点位更新时间：{point['updated_at']}",
        f"导出时间：{exported_at}",
        "资料范围：网站公开接口在导出时返回的已发布内容。后续变更以实时插件为准。",
        "",
        "## 已发布介绍与原文来源",
        "",
        point["summary"],
        "",
        "## 可用资源（导出时快照）",
        "",
    ]
    for floor in guide["floors"]:
        sections = [
            asset.get("section_label") or asset.get("section", "main")
            for asset in floor["images"]
            if asset["variant"] == "labeled"
        ]
        lines.append(
            f"- 楼层：{floor['label']}；ID：{floor['id']}；版本：{floor['revision']}；分区：{'、'.join(sections)}"
        )
    for panorama in guide["panoramas"]:
        lines.append(
            f"- 全景：{panorama['title']}；ID：{panorama['id']}；版本：{panorama['revision']}"
        )
    if not guide["floors"] and not guide["panoramas"]:
        lines.append("当前未返回已发布楼层或全景。")
    lines += ["", "以上资源清单不构成房间位置、无障碍条件或开放时段的依据。", ""]
    return "\n".join(lines)


def export(base, campus_id, output, fetcher=fetch):
    base = validate_origin(base)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,63}", campus_id):
        raise ValueError("invalid campus ID; retrieve the actual ID from /api/v1/campuses")
    if output.exists():
        raise ValueError("output directory already exists; choose a new snapshot directory")
    campuses = fetcher(base, "/api/v1/campuses")["data"]
    campus = next((row for row in campuses if row["id"] == campus_id), None)
    if campus is None:
        raise ValueError("campus is not publicly available")
    now = datetime.now(timezone.utc).isoformat()  # noqa: UP017 -- Python 3.8 CLI compatibility.
    manifest = {
        "schema_version": 1,
        "base": base,
        "campus_id": campus_id,
        "exported_at": now,
        "status": "collecting",
        "documents": [],
        "skipped": [],
    }
    # Build all files in memory; a failed request must not leave an apparently complete snapshot.
    files = {}
    seen = set()
    for page in range(1, 102):
        payload = fetcher(
            base,
            f"/api/v1/campuses/{campus_id}/points?" + urlencode({"page": page, "page_size": 100}),
        )
        rows = payload["data"]
        for point in rows:
            point_id = str(UUID(point["id"]))
            if point_id in seen:
                raise ValueError("catalog changed during export; retry with a new snapshot")
            seen.add(point_id)
            try:
                guide = fetcher(base, f"/api/v1/guide/points/{point_id}")["data"]
            except HTTPError as error:
                if error.code != 404:
                    raise
                manifest["skipped"].append({"point_id": point_id, "reason": "no_longer_public"})
                continue
            if guide["point"]["id"] != point_id or guide["point"]["campus_id"] != campus_id:
                raise ValueError("guide resource mismatch")
            text = document(guide, campus["name"], now)
            if text is None:
                manifest["skipped"].append({"point_id": point_id, "reason": "empty_summary"})
                continue
            filename = f"point-{point_id}.md"
            files[filename] = text
            manifest["documents"].append(
                {
                    "filename": filename,
                    "point_id": point_id,
                    "name": guide["point"]["name"],
                    "revision": guide["point"]["revision"],
                    "sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            )
        total = payload.get("meta", {}).get("pagination", {}).get("total")
        if total is None:
            raise ValueError("missing pagination")
        if len(seen) >= total:
            break
        if not rows:
            raise ValueError("incomplete catalog")
    else:
        raise ValueError("catalog exceeds export limit")
    manifest["status"] = "complete_snapshot"
    output.mkdir(parents=True)
    documents = output / "documents"
    documents.mkdir()
    for filename, text in files.items():
        (documents / filename).write_text(text, encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://2512921.cn")
    parser.add_argument("--campus-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = export(args.base_url, args.campus_id, args.output)
    except (ValueError, OSError) as error:
        raise SystemExit(
            f"Export failed ({type(error).__name__}); check HTTPS/API availability and the output path."
        ) from None
    print(
        f"Exported {len(manifest['documents'])} published introductions; skipped {len(manifest['skipped'])}."
    )
    print(
        "Upload documents/ only after reviewing manifest.json. Retire old platform documents separately."
    )


if __name__ == "__main__":
    main()
