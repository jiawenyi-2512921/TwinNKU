import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

const compile = (name) =>
  ts.transpileModule(
    readFileSync(
      new URL(`../src/features/admin/${name}`, import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const operation = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const session = (
  id = owner,
  permissions = ["backup.read", "backup.request"],
) => ({ user: { id }, permissions, mfa_enrolled: true });
const caps = {
  requests_enabled: true,
  executor_available: true,
  staff_requests_per_day: 2,
  global_requests_per_day: 6,
  min_interval_seconds: 3600,
};
const job = (values = {}) => ({
  id: jobId,
  operation_id: operation,
  user_id: owner,
  reason: "发布前完整备份",
  state: "queued",
  phase: "queued",
  created_at: "2026-10-03T01:00:00Z",
  authorized_until: "2026-10-03T01:05:00Z",
  started_at: null,
  finished_at: null,
  cancel_requested: false,
  cancel_operation_id: null,
  failure_code: null,
  result: null,
  ...values,
});
const summary = {
  ...caps,
  observed_at: "2026-10-03T01:00:00Z",
  active_job: null,
  summary: { status: "unknown", restore_status: "unknown", snapshots: [] },
};
const walk = (node, predicate) =>
  Array.isArray(node)
    ? node.flatMap((item) => walk(item, predicate))
    : node && typeof node === "object"
      ? [
          ...(predicate(node) ? [node] : []),
          ...walk(node.props?.children, predicate),
        ]
      : [];
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join("")
    : node && typeof node === "object"
      ? text(node.props?.children)
      : node == null
        ? ""
        : String(node);
const button = (tree, title) =>
  walk(tree, (node) => node.type === "button" && text(node) === title)[0];
const statusError = (status) =>
  Object.assign(new Error("controlled failure"), { status });

function harness(options = {}) {
  const slots = [],
    effects = [],
    calls = [],
    storage = new Map(),
    modules = new Map();
  let cursor = 0,
    effectCursor = 0,
    tree,
    props = { session: options.session ?? session() };
  const store = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const react = {
    useState(initial) {
      const key = cursor++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (value) => {
          slots[key] = typeof value === "function" ? value(slots[key]) : value;
        },
      ];
    },
    useRef(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(callback, deps) {
      const key = effectCursor++,
        prior = effects[key];
      if (!prior || deps.some((value, index) => value !== prior.deps[index]))
        effects[key] = {
          callback,
          deps,
          pending: true,
          cleanup: prior?.cleanup,
        };
    },
  };
  function module(name) {
    if (modules.has(name)) return modules.get(name);
    const exports = {};
    modules.set(name, exports);
    vm.runInNewContext(compile(name), {
      exports,
      sessionStorage: store,
      crypto,
      AbortController,
      Date,
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return timer;
      },
      clearTimeout,
      require(name) {
        if (name === "react") return react;
        if (name === "react/jsx-runtime") return jsx;
        if (name === "./api")
          return {
            message: (error) => error.message,
            request: async (...args) => {
              calls.push(args);
              if (options.request) return options.request(...args);
              const [path] = args;
              if (path === "/backup-capabilities")
                return { data: options.caps ?? caps };
              if (path.startsWith("/backup-jobs?"))
                return {
                  data: {
                    items: options.jobs ?? [],
                    page: 1,
                    page_size: 20,
                    has_more: false,
                  },
                };
              if (path === "/backup-status") return { data: summary };
              throw statusError(404);
            },
          };
        if (name === "./ui") return { ErrorBox: () => null };
        if (name.endsWith(".css")) return {};
        if (
          ["./backupHelpers", "./backupTypes", "./confirmedOperation"].includes(
            name,
          )
        )
          return module(`${name.slice(2)}.ts`);
        throw new Error(name);
      },
    });
    return exports;
  }
  const component = module("BackupWorkspace.tsx").BackupWorkspace;
  function render() {
    cursor = 0;
    effectCursor = 0;
    tree = component(props);
    for (const effect of effects)
      if (effect.pending) {
        effect.cleanup?.();
        effect.cleanup = effect.callback();
        effect.pending = false;
      }
    return tree;
  }
  return {
    calls,
    storage,
    modules,
    props,
    render,
    get tree() {
      return tree;
    },
    async flush() {
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        render();
      }
      return tree;
    },
    dispose() {
      for (const effect of effects) effect.cleanup?.();
    },
    setSession(value) {
      props = { session: value };
      render();
    },
    helpers: () => module("backupHelpers.ts"),
  };
}

test("default closed switch and missing enrolled MFA disable the real request button", async () => {
  const h = harness({ caps: { ...caps, requests_enabled: false } });
  h.render();
  await h.flush();
  assert.equal(button(h.tree, "申请备份").props.disabled, true);
  assert.match(text(h.tree), /尚未开启后台申请/);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 0);
  h.setSession({ ...session(), mfa_enrolled: false });
  await h.flush();
  assert.equal(button(h.tree, "申请备份").props.disabled, true);
  h.dispose();
});

test("request-only staff read capabilities and their own list without full summary", async () => {
  const h = harness({ session: session(owner, ["backup.request"]) });
  h.render();
  await h.flush();
  assert.ok(h.calls.some(([path]) => path === "/backup-capabilities"));
  assert.ok(h.calls.some(([path]) => path.startsWith("/backup-jobs?")));
  assert.equal(
    h.calls.some(([path]) => path === "/backup-status"),
    false,
  );
  h.dispose();
});

test("lost request response is recovered by operation UUID without a second write", async () => {
  let recorded;
  const h = harness({
    request: async (path, method = "GET", body) => {
      if (path === "/backup-capabilities") return { data: caps };
      if (path === "/backup-status") return { data: summary };
      if (path.startsWith("/backup-jobs?"))
        return { data: { items: recorded ? [recorded] : [], has_more: false } };
      if (method === "POST") {
        recorded = job({
          operation_id: body.operation_id,
          reason: body.reason,
        });
        throw new Error("transport lost");
      }
      if (path.startsWith("/backup-jobs/operations/"))
        return { data: recorded };
      throw statusError(404);
    },
  });
  h.render();
  await h.flush();
  walk(h.tree, (node) => node.type === "textarea")[0].props.onChange({
    target: { value: "发布前完整备份" },
  });
  h.render();
  button(h.tree, "申请备份").props.onClick();
  await h.flush();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(
    h.calls.filter(([path]) => path.startsWith("/backup-jobs/operations/"))
      .length,
    1,
  );
  assert.match(text(h.tree), /申请已记录/);
  assert.equal(h.storage.size, 0);
  h.dispose();
});

test("unconfirmed operation keeps its ID and query action never resends it", async () => {
  const h = harness({
    request: async (path, method = "GET") => {
      if (path === "/backup-capabilities") return { data: caps };
      if (path === "/backup-status") return { data: summary };
      if (path.startsWith("/backup-jobs?"))
        return { data: { items: [], has_more: false } };
      if (method === "POST") throw new Error("transport lost");
      throw statusError(404);
    },
  });
  h.render();
  await h.flush();
  walk(h.tree, (node) => node.type === "textarea")[0].props.onChange({
    target: { value: "需要完整备份" },
  });
  h.render();
  button(h.tree, "申请备份").props.onClick();
  await h.flush();
  const saved = JSON.parse([...h.storage.values()][0]);
  assert.equal(button(h.tree, "申请备份").props.disabled, true);
  button(h.tree, "核对本次结果").props.onClick();
  await h.flush();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(
    JSON.parse([...h.storage.values()][0]).operationId,
    saved.operationId,
  );
  h.dispose();
});

test("MFA step-up rejection never replays the backup request automatically", async () => {
  const h = harness({
    request: async (path, method = "GET") => {
      if (path === "/backup-capabilities") return { data: caps };
      if (path === "/backup-status") return { data: summary };
      if (path.startsWith("/backup-jobs?"))
        return { data: { items: [], has_more: false } };
      throw statusError(method === "POST" ? 403 : 404);
    },
  });
  h.render();
  await h.flush();
  walk(h.tree, (node) => node.type === "textarea")[0].props.onChange({
    target: { value: "需要完整备份" },
  });
  h.render();
  button(h.tree, "申请备份").props.onClick();
  await h.flush();
  h.setSession({ ...session(), recent_mfa_until: "2099-01-01T00:00:00Z" });
  await h.flush();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(h.storage.size, 0);
  h.dispose();
});

test("late response after staff account changes cannot show the former staff job", async () => {
  let resolve;
  const h = harness({
    request: async (path) => {
      if (path === "/backup-capabilities") return { data: caps };
      if (path === "/backup-status") return { data: summary };
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  h.render();
  await new Promise((done) => setImmediate(done));
  const oldResolve = resolve;
  h.setSession(session(other));
  await new Promise((done) => setImmediate(done));
  oldResolve({
    data: { items: [job({ reason: "旧成员私有申请" })], has_more: false },
  });
  await h.flush();
  assert.doesNotMatch(text(h.tree), /旧成员私有申请/);
  h.dispose();
});

test("cancel confirmation is bound to owner, exact job and cancellation operation", () => {
  const h = harness();
  const helpers = h.helpers();
  const pending = {
    owner,
    operationId: operation,
    jobId,
    reason: "需要完整备份",
  };
  assert.equal(
    helpers.backupOperationConfirmed(
      pending,
      job({ cancel_requested: true, cancel_operation_id: operation }),
    ),
    true,
  );
  assert.equal(
    helpers.backupOperationConfirmed(
      pending,
      job({ cancel_requested: true, cancel_operation_id: other }),
    ),
    false,
  );
  assert.equal(helpers.backupCanCancel(job({ user_id: other }), owner), false);
  assert.equal(
    helpers.backupCanCancel(job({ state: "succeeded" }), owner),
    false,
  );
});

test("session storage cannot bind an operation belonging to another employee", () => {
  const h = harness();
  const helpers = h.helpers();
  h.storage.set(
    `twinnku-backup-operation:${owner}`,
    JSON.stringify({
      owner: other,
      operationId: operation,
      reason: "需要完整备份",
    }),
  );
  assert.equal(helpers.loadPendingBackup(owner), null);
});

test("restored tasks show expired authorization without claiming cancellation is still pending", async () => {
  const h = harness({
    jobs: [
      job({
        state: "expired",
        cancel_requested: true,
        failure_code: "RESTORED_REQUIRES_REVIEW",
      }),
    ],
  });
  h.render();
  await h.flush();
  assert.match(text(h.tree), /随隔离恢复被停止/);
  assert.doesNotMatch(text(h.tree), /已申请取消，等待执行器核对/);
  assert.equal(button(h.tree, "申请取消本任务"), undefined);
  h.dispose();
});
