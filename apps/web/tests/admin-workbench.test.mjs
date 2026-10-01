import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { withRequestDeadline } from "../src/shared/requestDeadline.ts";

function compile(file) {
  return ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
}
const inboxCode = compile("../src/features/admin/ReviewCenter.tsx");
const apiCode = compile("../src/features/admin/api.ts");
const find = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((node) => find(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...find(tree.props?.children, predicate),
  ];
};
const session = {
  user: { id: "editor", role: "editor" },
  permissions: ["points.read", "points.edit"],
};
const vr = {
  id: "vr-1",
  kind: "panorama",
  point_id: "point-1",
  point_name: "资料所属楼",
  title: "全景一",
  state: "in_review",
  operation: "upsert",
  editor_name: "编辑",
  submitted_by_name: "编辑",
  submitted_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
  is_mine: true,
  can_review: false,
};

// Controlled hooks exercise actual component event handlers and JSX. They do
// not simulate a browser, network transport, CSS layout or actual React effects.
function inbox(initial) {
  const slots = [],
    reads = [];
  let index = 0,
    confirm = true;
  const react = {
    useState(value) {
      const key = index++;
      if (!(key in slots)) slots[key] = value;
      return [
        slots[key],
        (next) => {
          slots[key] = typeof next === "function" ? next(slots[key]) : next;
        },
      ];
    },
    useRef(value) {
      const key = index++;
      if (!(key in slots)) slots[key] = { current: value };
      return slots[key];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect() {},
  };
  const PointWorkspace = () => null,
    ResourceWorkspace = () => null,
    Pager = () => null;
  const exports = {};
  vm.runInNewContext(inboxCode, {
    exports,
    URLSearchParams,
    window: { confirm: () => confirm },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name === "./api")
        return {
          stateNames: {
            in_review: "待审核",
            draft: "草稿",
            rejected: "已退回",
            published: "已发布",
            discarded: "已撤回",
          },
        };
      if (name === "./ui")
        return {
          Empty: () => null,
          ErrorBox: () => null,
          Pager,
          timestamp: (v) => v,
          useResource(path) {
            reads.push(path);
            return {
              data: {
                data: [vr],
                meta: { pagination: { page: 1, page_size: 20, total: 1 } },
              },
              error: "",
              loading: false,
            };
          },
        };
      if (name === "./PointWorkspace") return { PointWorkspace };
      if (name === "./ResourceWorkspace") return { ResourceWorkspace };
      throw new Error(name);
    },
  });
  const props = {
    session,
    maps: [{ id: "map" }],
    mapsError: "",
    onRetryMaps() {},
    onDirty() {},
    onUpdate() {},
    revision: 0,
    initial,
  };
  return {
    exports,
    reads,
    PointWorkspace,
    ResourceWorkspace,
    Pager,
    render() {
      index = 0;
      return exports.ReviewCenter(props);
    },
    setConfirm(value) {
      confirm = value;
    },
  };
}

test("the unified inbox loads all kinds and opens the exact VR resource directly", () => {
  const h = inbox();
  const tree = h.render();
  assert.match(h.reads.at(-1), /^\/changes\?/);
  assert.equal(
    new URLSearchParams(h.reads.at(-1).split("?")[1]).has("kind"),
    false,
  );
  find(tree, (n) => n.type === h.exports.ChangeRows)[0].props.onOpen(vr);
  const detail = find(h.render(), (n) => n.type === h.ResourceWorkspace)[0];
  assert.equal(detail.props.initialId, "vr-1");
  assert.equal(detail.props.focused, true);
});

test("point tasks open the point editor, preserving the selected point id", () => {
  const h = inbox({ item: { ...vr, kind: "point", id: "point-1" } });
  const detail = find(h.render(), (n) => n.type === h.PointWorkspace)[0];
  assert.equal(detail.props.initialId, "point-1");
});

test("returning from review preserves filters and paging, with unsaved and processing guards", () => {
  const h = inbox();
  let tree = h.render();
  find(tree, (n) => n.props?.["aria-label"] === "资料类型")[0].props.onChange({
    target: { value: "panorama" },
  });
  find(tree, (n) => n.type === h.Pager)[0].props.onChange(3);
  tree = h.render();
  find(tree, (n) => n.type === h.exports.ChangeRows)[0].props.onOpen(vr);
  let detail = find(h.render(), (n) => n.type === h.ResourceWorkspace)[0];
  detail.props.onDirty(true, true);
  let back = find(h.render(), (n) => n.type === "button")[0];
  assert.equal(back.props.disabled, true);
  back.props.onClick();
  assert.equal(
    find(h.render(), (n) => n.type === h.ResourceWorkspace).length,
    1,
  );
  detail.props.onDirty(true, false);
  h.setConfirm(false);
  find(h.render(), (n) => n.type === "button")[0].props.onClick();
  assert.equal(
    find(h.render(), (n) => n.type === h.ResourceWorkspace).length,
    1,
  );
  detail.props.onDirty(false, false);
  find(h.render(), (n) => n.type === "button")[0].props.onClick();
  tree = h.render();
  assert.equal(find(tree, (n) => n.type === h.ResourceWorkspace).length, 0);
  const params = new URLSearchParams(h.reads.at(-1).split("?")[1]);
  assert.equal(params.get("kind"), "panorama");
  assert.equal(params.get("page"), "3");
});

test("queue rows show location and operation and escape submitted titles", () => {
  const h = inbox();
  const html = renderToStaticMarkup(
    h.exports.ChangeRows({
      rows: [{ ...vr, title: "<script>bad()</script>", operation: "retire" }],
      onOpen() {},
    }),
  );
  assert.match(html, /资料所属楼/);
  assert.match(html, /下架申请/);
  assert.match(html, /查看详情/);
  assert.doesNotMatch(html, /<script>/);
});

function adminClient(fetch, events = []) {
  const exports = {};
  class ApiError extends Error {
    constructor(status, message, requestId) {
      super(message);
      Object.assign(this, { status, requestId });
    }
  }
  vm.runInNewContext(apiCode, {
    exports,
    fetch,
    Blob,
    DOMException,
    Event,
    window: { dispatchEvent: (event) => events.push(event.type) },
    require(name) {
      if (name.endsWith("requestDeadline"))
        return {
          withRequestDeadline: (load, signal) =>
            withRequestDeadline(load, signal, 5),
        };
      if (name.endsWith("api/client")) return { ApiError };
      throw new Error(name);
    },
  });
  return exports;
}

test("a stalled admin read becomes a retryable timeout without aborting its owner", async () => {
  const parent = new AbortController();
  const source = adminClient(async () => ({
    ok: true,
    json: () => new Promise(() => {}),
  }));
  await assert.rejects(
    source.request("/changes", "GET", undefined, parent.signal),
    (error) => error.status === 408,
  );
  assert.equal(parent.signal.aborted, false);
});

test("admin writes are never timed out and replayed by the read wrapper", async () => {
  let calls = 0,
    release;
  const source = adminClient(async (_url, options) => {
    calls++;
    assert.equal(options.method, "POST");
    return await new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = source.request("/resources/a/review/publish", "POST", {
    expected_revision: 2,
    note: "核对",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  release({
    ok: true,
    json: async () => ({ data: { published_revision: 3 } }),
  });
  assert.equal((await pending).data.published_revision, 3);
});

test("a cancelled admin read cannot expire a replacement session when its 401 body arrives late", async () => {
  const events = [];
  let release;
  const source = adminClient(
    async () => ({
      ok: false,
      status: 401,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
    events,
  );
  const controller = new AbortController();
  const pending = source.request(
    "/changes",
    "GET",
    undefined,
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  release({ error: { message: "旧会话" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
});
