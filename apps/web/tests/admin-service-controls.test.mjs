import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(respond, state = "warning") {
  const calls = [],
    notices = [],
    ConfigurationWorkspace = () => null;
  const controls = {
    published_revision: 2,
    approved: { chat_enabled: true },
    effective: { chat_enabled: true },
    deployment_allowed: { chat: true },
    stops: { chat: { stopped: false } },
    permissions: { edit: true, review: false },
    provider_connectivity: "not_verified",
    narration_storage: {
      used_bytes: 85,
      maximum_bytes: 100,
      unadopted_retention_days: 7,
      state,
    },
  };
  const h = controlledAdmin({
    "./ConfigurationWorkspace": { ConfigurationWorkspace },
    "./ui": {
      ErrorBox: () => null,
      useResource: () => ({ data: { data: controls }, error: "" }),
    },
    "./api": {
      message: (error) => error.message,
      request: async (...args) => {
        calls.push(args);
        return { data: await respond(...args) };
      },
    },
  });
  const exported = h.load("./GuideSettings"),
    props = {
      session: { user: { id: "editor" }, permissions: ["runtime.edit"] },
      onDirty: (...value) => notices.push(value),
    };
  const render = () => h.render("controls", exported.GuideSettings, props);
  return { ...h, calls, notices, controls, ConfigurationWorkspace, render };
}
test("emergency pause can reduce service while a configuration draft is dirty; it never publishes that draft", async () => {
  const h = setup(async () => h.controls);
  let tree = h.render();
  find(tree, (n) => n.type === h.ConfigurationWorkspace)[0].props.onDirty(
    true,
    false,
  );
  tree = h.render();
  find(tree, (n) => n.type === "input")[0].props.onChange({
    target: { value: "真实故障夹具" },
  });
  tree = h.render();
  const pause = find(
    tree,
    (n) => n.type === "button" && text(n) === "立即暂停",
  )[0];
  assert.equal(pause.props.disabled, false);
  pause.props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "/service-controls/chat/pause");
  assert.match(h.calls[0][2].operation_id, /^[a-f0-9-]{36}$/);
  assert.equal(h.notices.at(-1)[0], true);
  assert.match(text(tree), /80%容量警戒/);
  assert.equal(
    h.calls.some(([path]) =>
      /configurations|publish|narration-jobs/.test(path),
    ),
    false,
  );
  h.dispose();
});
test("unknown pause result blocks repeated writes, warns unload, and recovery reads only the original operation", async () => {
  let known = false;
  const h = setup(async (path, method) => {
    if (method === "POST") throw new Error("lost response");
    if (!known) throw Object.assign(new Error("unknown"), { status: 404 });
    return { result: h.controls };
  });
  let tree = h.render();
  find(tree, (n) => n.type === "input")[0].props.onChange({
    target: { value: "暂停调查" },
  });
  tree = h.render();
  find(
    tree,
    (n) => n.type === "button" && text(n) === "立即暂停",
  )[0].props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  const original = h.calls[0][2].operation_id;
  assert.equal(h.calls[1][0], `/operations/${original}`);
  assert.equal(h.notices.at(-1)[1], true);
  const unload = new Event("beforeunload", { cancelable: true });
  h.browser.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  known = true;
  button(tree, "查询本次服务操作结果").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.at(-1)[0], `/operations/${original}`);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(button(tree, "查询本次服务操作结果"), undefined);
  h.dispose();
});
test("storage full and unavailable are honest states and cannot falsely report a successful supplier connection", () => {
  for (const state of ["full", "unavailable"]) {
    const h = setup(async () => ({}), state);
    const tree = h.render();
    assert.match(
      text(tree),
      state === "full" ? /已满，不能继续创建正式讲解/ : /容量无法核验/,
    );
    assert.match(text(tree), /供应商连通性尚未实测/);
    assert.equal(h.calls.length, 0);
    h.dispose();
  }
});
