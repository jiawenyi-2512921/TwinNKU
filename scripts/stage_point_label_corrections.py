"""Prepare the requested college rename using current data and independent review.

Default is read-only. No map imports, SQL, publish endpoints, passwords in arguments,
write retries, or automatic review. The public UI correction is separately reversible.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import json
import sys

from stage_point_introductions import BASE, ApiFailure, Client

POINT_ID = "b041e7c6-3481-51c1-b06f-9a33197ea0db"
OLD_NAMES = ("新闻与传播学院", "新闻与传媒学院")
NEW_NAME = "信息与传媒学院"
MAP_ID = "eee88cf5-87a0-592e-b1cc-a70674941bbf"
MAP_SHA = "aa5f84fc993dca7371e1d1bf6a5e190925ec2ce5f0d2d4dc968093346028218f"


def prepare_update(current, maps):
    point = current["point"]
    if point["id"] != POINT_ID or point["campus_id"] != "nku-jinnan":
        return "identity_mismatch", None
    if point["name"] == NEW_NAME:
        return "unchanged", None
    if point["name"] not in OLD_NAMES:
        return "name_changed", None
    if current["status"] != "published" or current["visibility"] != "public":
        return "not_public", None
    draft = current.get("draft")
    if draft and draft["state"] not in {"published", "discarded"}:
        return "pending_draft", None
    geometries = current["geometries"]
    if len(geometries) != 1:
        return "ambiguous_geometry", None
    geo = geometries[0]
    image = next((m for m in maps if m["id"] == geo["map_id"]), None)
    if (
        not image
        or image["id"] != MAP_ID
        or image["revision"] != 3
        or geo["map_revision"] != 3
        or image.get("source_sha256") != MAP_SHA
    ):
        return "stale_map", None
    payload = {
        key: copy.deepcopy(point[key])
        for key in ("campus_id", "name", "aliases", "category", "summary")
    }
    payload["name"] = NEW_NAME
    # Preserve former lookup terms; no official-history claim is added.
    payload["aliases"] = list(dict.fromkeys([*payload["aliases"], *OLD_NAMES]))
    # Only rename the exact leading name, keeping the rest of the published text.
    if payload["summary"].startswith(point["name"]):
        payload["summary"] = NEW_NAME + payload["summary"][len(point["name"]) :]
    payload.update(
        visibility=current["visibility"],
        geometry={
            key: copy.deepcopy(geo[key])
            for key in ("map_id", "map_revision", "anchor", "polygon", "label_on_map")
        },
        source_note="用户2026-09-29明确要求名称显示为信息与传媒学院；须独立核对后发布。仅改名称、原名检索别名和介绍首部同名，不改几何。",
        expected_point_revision=point["revision"],
        expected_revision=draft["revision"] if draft else 0,
    )
    return "ready", payload


def stage(api, maps, apply=False, submit=False):
    path = BASE + "/points/" + POINT_ID
    current = api.request("GET", path)
    status, payload = prepare_update(current, maps)
    if status != "ready" or not apply:
        return {"status": status, "point_id": POINT_ID, "target_name": NEW_NAME}
    saved = api.request("PUT", path, payload)
    if submit:
        saved = api.request(
            "POST",
            path + "/submit",
            {
                "expected_revision": saved["draft"]["revision"],
                "note": payload["source_note"],
            },
        )
    return {
        "status": "submitted" if submit else "staged",
        "draft_revision": saved["draft"]["revision"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--apply", action="store_true", help="保存草稿；默认只读")
    parser.add_argument(
        "--submit", action="store_true", help="保存并提交独立审核，不发布"
    )
    args = parser.parse_args()
    if args.submit and not args.apply:
        parser.error("--submit requires --apply")
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
            raise ValueError("请先在后台完成首次密码修改")
        if args.apply and "points.edit" not in session["permissions"]:
            raise ValueError("保存草稿需要 points.edit 权限")
        result = stage(api, api.request("GET", BASE + "/maps"), args.apply, args.submit)
        print(json.dumps({**result, "published_by_script": 0}, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, ApiFailure) as exc:
        print(
            f"未完成：{exc}；如已发出写请求，请检查后台草稿后再运行。", file=sys.stderr
        )
        return 1
    finally:
        if api.csrf:
            try:
                api.request("POST", BASE + "/auth/logout", {})
            except ApiFailure:
                print("退出请求未确认，请检查后台会话。", file=sys.stderr)
            api.csrf = None


if __name__ == "__main__":
    sys.exit(main())
