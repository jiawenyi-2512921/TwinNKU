import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const version = {
  id: "old-version",
  entity_type: "floor",
  entity_id: "resource",
  event: "checkpoint",
  revision: 2,
  published_revision: 1,
  content: { kind: "floor", label: "旧真实楼层" },
  content_sha256: "a".repeat(64),
  created_at: "2026-10-03T00:00:00Z",
};
function setup(respond) {
  const calls = [],
    loads = [],
    pending = [];
  const h = controlledAdmin({
    "./api": {
      message: (error) => error.message,
      request: async (...args) => {
        calls.push(args);
        return { data: await respond(...args) };
      },
    },
  });
  const exported = h.load("./ContentHistory"),
    props = {
      entity: "floor",
      id: "resource",
      revision: 5,
      publishedRevision: 3,
      state: "draft",
      editable: true,
      dirty: false,
      onSave: async () => true,
      onLoad: (value) => loads.push(value),
      onPendingChange: (value) => pending.push(value),
    };
  const render = () => h.render("history", exported.ContentHistory, props);
  return { ...h, calls, loads, pending, props, render };
}
test("restoring history binds current CAS versions and creates a new private draft without old approval", async () => {
  const restored = { id: "resource", draft: { revision: 6, state: "draft" } };
  const h = setup(async (path) =>
    path.startsWith("/content-history?") ? [version] : restored,
  );
  let tree = h.render();
  button(tree, "查看可访问历史").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(
    h.calls[0][0],
    "/content-history?entity_type=floor&entity_id=resource",
  );
  button(tree, "恢复为新草稿").props.onClick();
  await settle();
  h.render();
  const write = h.calls[1];
  assert.equal(
    write[0],
    "/content/floor/resource/history/old-version/restore-draft",
  );
  assert.equal(write[1], "POST");
  assert.equal(write[2].expected_revision, 5);
  assert.equal(write[2].expected_published_revision, 3);
  assert.match(write[2].operation_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(h.loads, [restored]);
  assert.equal(
    h.calls.some(([path]) => /publish|narration-jobs/.test(path)),
    false,
  );
  h.dispose();
});
test("dirty history operations save first and require the newly rendered version before a mutation", async () => {
  const h = setup(async () => [version]);
  h.props.dirty = true;
  let saved = 0;
  h.props.onSave = async () => {
    saved++;
    return true;
  };
  let tree = h.render();
  button(tree, "建立检查点").props.onClick();
  await settle();
  h.render();
  assert.equal(saved, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.loads.length, 0);
  h.dispose();
});
test("lost checkpoint acknowledgements freeze mutations and recover only the exact operation", async () => {
  let confirmed = false;
  const row = { id: "resource", draft: { revision: 5 } };
  const h = setup(async (path, method) => {
    if (method === "POST") throw new Error("lost checkpoint");
    if (!confirmed) throw Object.assign(new Error("unknown"), { status: 404 });
    return { result: row };
  });
  let tree = h.render();
  button(tree, "建立检查点").props.onClick();
  await settle();
  tree = h.render();
  const operation = h.calls[0][2].operation_id;
  assert.equal(h.calls[1][0], `/operations/${operation}`);
  assert.equal(h.pending.at(-1), true);
  assert.equal(button(tree, "建立检查点").props.disabled, true);
  confirmed = true;
  button(tree, "查询原版本操作结果").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.at(-1)[0], `/operations/${operation}`);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.deepEqual(h.loads, [row]);
  h.dispose();
});
test("navigation dependency checks use the underlying map and preflight results expire with field changes", async () => {
  const h = setup(async (path) =>
    path.includes("/dependencies")
      ? []
      : {
          valid: true,
          revision: 5,
          content_sha256: "a".repeat(64),
          dependency_sha256: "b".repeat(64),
          issues: [],
        },
  );
  h.props.entity = "navigation";
  let tree = h.render();
  button(tree, "查看受影响内容").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls[0][0], "/resources/map/resource/dependencies");
  button(tree, "检查当前保存版本").props.onClick();
  await settle();
  tree = h.render();
  assert.match(text(tree), /预检通过/);
  h.props.dirty = true;
  tree = h.render();
  assert.doesNotMatch(text(tree), /预检通过/);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  h.dispose();
});
