import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { withRequestDeadline } from "../src/shared/requestDeadline.ts";

const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const mfaCode = compile("../src/features/admin/MfaAuth.tsx");
const apiCode = compile("../src/features/admin/api.ts");
const currentId = "11111111-1111-4111-8111-111111111111",
  otherId = "22222222-2222-4222-8222-222222222222";
const session = {
  user: { id: "member" },
  csrf_token: "staff-csrf",
  mfa_enrolled: true,
  mfa_verified: true,
};
const row = (id, current) => ({
  id,
  is_current: current,
  created_at: "2026-10-03T01:00:00Z",
  last_activity_at: "2026-10-03T01:04:00Z",
  expires_at: "2026-10-03T09:00:00Z",
  idle_expires_at: "2026-10-03T01:34:00Z",
  mfa_verified: true,
});
const inventory = {
  server_time: "2026-10-03T01:05:00Z",
  sessions: [row(currentId, true), row(otherId, false)],
};
const walk = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((node) => walk(node, predicate))
    : !tree || typeof tree !== "object"
      ? []
      : [
          ...(predicate(tree) ? [tree] : []),
          ...walk(tree.props?.children, predicate),
        ];
const text = (tree) =>
  Array.isArray(tree)
    ? tree.map(text).join("")
    : tree && typeof tree === "object"
      ? text(tree.props?.children)
      : tree == null
        ? ""
        : String(tree);
const button = (tree, name) =>
  walk(
    tree,
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === name || text(node) === name),
  )[0];
const response = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () =>
    status < 400
      ? { data, meta: { request_id: "test" } }
      : { error: data, meta: { request_id: "test" } },
});

function harness(
  handler = async (_, options) =>
    response(options.method === "GET" ? inventory : { revoked_count: 1 }),
) {
  const calls = [],
    slots = [],
    effects = [],
    events = new EventTarget();
  let props = { session },
    cursor = 0,
    dirty = false,
    queued = [],
    tree;
  const browser = {
    dispatchEvent: events.dispatchEvent.bind(events),
    addEventListener: events.addEventListener.bind(events),
    confirm: () => true,
  };
  const base = {
    window: browser,
    AbortController,
    Blob,
    DOMException,
    Event,
    Date,
    Error,
  };
  const api = {};
  vm.runInNewContext(apiCode, {
    ...base,
    exports: api,
    fetch: async (path, options) => {
      calls.push({ path, ...options });
      return handler(path, options);
    },
    require(name) {
      if (name.endsWith("/client"))
        return {
          ApiError: class extends Error {
            constructor(status, message) {
              super(message);
              this.status = status;
            }
          },
        };
      assert.ok(name.endsWith("/requestDeadline"));
      return { withRequestDeadline };
    },
  });
  api.rememberSession(session);
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (next) => {
          const value = typeof next === "function" ? next(slots[index]) : next;
          if (!Object.is(value, slots[index])) {
            slots[index] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++,
        previous = effects[index];
      if (
        !previous ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))
      )
        queued.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: effect() };
        });
    },
  };
  const exports = {};
  const ErrorBox = ({ text: value }) =>
    value ? jsx.jsx("p", { role: "alert", children: value }) : null;
  vm.runInNewContext(mfaCode, {
    ...base,
    exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "./api") return api;
      if (name === "./ui") return { ErrorBox };
      if (name === "./webauthn") return {};
      throw new Error(name);
    },
  });
  return {
    calls,
    browser,
    render() {
      let count = 0;
      do {
        assert.ok(++count < 20, "session effects settle");
        cursor = 0;
        dirty = false;
        queued = [];
        tree = exports.OwnSessions(props);
        queued.forEach((effect) => effect());
      } while (dirty);
      return tree;
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      return this.render();
    },
    setSession(value) {
      props = { session: value };
      api.rememberSession(value);
    },
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}

test("own sessions display server IDs and times, keep current protected and send an authenticated single revocation", async () => {
  let data = inventory;
  const h = harness(async (_, options) => {
    if (options.method === "GET") return response(data);
    data = { ...inventory, sessions: [row(currentId, true)] };
    return response({ revoked_count: 1 });
  });
  h.render();
  let tree = await h.settle();
  assert.equal(button(tree, `撤销会话 ${currentId}`).props.disabled, true);
  assert.equal(button(tree, `撤销会话 ${otherId}`).props.disabled, false);
  assert.ok(
    walk(tree, (node) => node.type === "time").some(
      (node) => node.props.dateTime === inventory.server_time,
    ),
  );
  assert.ok(text(tree).includes(currentId) && text(tree).includes(otherId));
  assert.ok(!text(tree).includes("staff-csrf"));
  button(tree, `撤销会话 ${otherId}`).props.onClick();
  tree = h.render();
  assert.equal(button(tree, `撤销会话 ${otherId}`).props.disabled, true);
  tree = await h.settle();
  await h.settle();
  const write = h.calls.find((call) => call.method === "DELETE");
  assert.equal(write.path, `/api/v1/admin/auth/sessions/${otherId}`);
  assert.equal(write.headers["X-CSRF-Token"], "staff-csrf");
  assert.equal(write.credentials, "same-origin");
  assert.equal(write.cache, "no-store");
  tree = h.render();
  assert.equal(button(tree, `撤销会话 ${otherId}`), undefined);
  assert.ok(text(tree).includes("本次登录保持有效"));
  h.dispose();
});

test("bulk revocation sends no session token or member selector and an MFA rejection never replays the write", async () => {
  const h = harness(async (_, options) =>
    options.method === "GET"
      ? response(inventory)
      : response({ code: "MFA_STEP_UP_REQUIRED", message: "再次验证" }, 403),
  );
  let stepUps = 0;
  h.browser.addEventListener("staff-mfa-required", () => stepUps++);
  h.render();
  let tree = await h.settle();
  button(tree, "撤销其他会话，保留本次").props.onClick();
  h.render();
  await h.settle();
  assert.equal(stepUps, 1);
  let writes = h.calls.filter((call) => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/v1/admin/auth/sessions/revoke-others");
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].body, undefined);
  h.setSession({ ...session, csrf_token: "new-verified-csrf" });
  h.render();
  await h.settle();
  writes = h.calls.filter((call) => call.method !== "GET");
  assert.equal(
    writes.length,
    1,
    "successful step-up only refreshes the list; the member retries explicitly",
  );
  h.dispose();
});

test("staged password-only members can read their sessions but cannot invoke revocation buttons", async () => {
  const h = harness();
  h.setSession({ ...session, mfa_enrolled: false, mfa_verified: false });
  h.render();
  const tree = await h.settle();
  assert.ok(text(tree).includes("请先登记并验证通行密钥"));
  assert.equal(button(tree, `撤销会话 ${otherId}`).props.disabled, true);
  assert.equal(button(tree, "撤销其他会话，保留本次").props.disabled, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  h.dispose();
});

test("switching members aborts old reads and never displays the previous account's sessions", async (t) => {
  const pending = [];
  const h = harness(
    (_, options) =>
      new Promise((resolve) =>
        pending.push({ resolve, signal: options.signal }),
      ),
  );
  t.after(() => h.dispose());
  h.render();
  await h.settle();
  pending[0].resolve(response(inventory));
  let tree = await h.settle();
  assert.ok(text(tree).includes(otherId));
  button(tree, "刷新会话列表").props.onClick();
  h.render();
  await h.settle();
  assert.equal(pending.length, 2);
  h.setSession({
    ...session,
    user: { id: "other-member" },
    csrf_token: "other-member-csrf",
  });
  tree = h.render();
  await h.settle();
  assert.ok(!text(tree).includes(otherId));
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(response(inventory));
  tree = await h.settle();
  assert.ok(!text(tree).includes(otherId));
  pending[2].resolve(
    response({
      ...inventory,
      sessions: [row("33333333-3333-4333-8333-333333333333", true)],
    }),
  );
  tree = await h.settle();
  assert.ok(!text(tree).includes(otherId));
  assert.ok(text(tree).includes("33333333-3333-4333-8333-333333333333"));
  h.dispose();
});
