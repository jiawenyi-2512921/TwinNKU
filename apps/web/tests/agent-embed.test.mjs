// Execute the actual frame bootstrap in an isolated JS context with a controlled
// transport. This checks lifecycle/error handling, not real platform answers or layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as protocol from "../src/features/agent/protocol.ts";

const code = ts.transpileModule(
  readFileSync(
    new URL("../src/features/agent/embed.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(overrides = {}) {
  const posts = [],
    scripts = [],
    requests = [],
    options = [],
    timers = new Map();
  const status = { hidden: false, textContent: "loading" };
  const parent = {
    postMessage: (message, origin) => posts.push({ message, origin }),
  };
  const config = {
    enabled: true,
    base_url: protocol.SDK_ORIGIN,
    sdk_url: protocol.SDK_URL,
    app_key: "public-test-key",
    hide_sidebar: true,
    context_enabled: true,
    ...overrides,
  };
  let listener;
  let nextTimer = 0;
  const window = {
    parent,
    location: { origin: "https://2512921.cn", hash: "#instance=frame-1" },
    setTimeout: (fn, delay) => {
      timers.set(++nextTimer, { fn, delay });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => {
      if (name === "message") listener = fn;
    },
    HiagentWebSDK: {
      WebClient: class {
        constructor(input) {
          options.push(input);
        }
      },
    },
  };
  vm.runInNewContext(code, {
    window,
    URLSearchParams,
    AbortController,
    exports: {},
    require: (path) => (path === "./protocol" ? protocol : {}),
    document: {
      getElementById: () => status,
      createElement: () => ({
        remove() {
          this.removed = true;
        },
      }),
      body: { append: (script) => scripts.push(script) },
    },
    fetch: async (path, init) => {
      requests.push({ path, init });
      return { ok: true, json: async () => ({ data: config }) };
    },
  });
  const context = {
    ...protocol.EMPTY_CONTEXT,
    campus_id: "nku-jinnan",
    campus_name: "津南校区",
    token: "must-not-forward",
  };
  const send = (patch = {}) =>
    listener({
      source: parent,
      origin: window.location.origin,
      data: {
        channel: protocol.FRAME_CHANNEL,
        instance: "frame-1",
        type: "initialize",
        context,
      },
      ...patch,
    });
  return { posts, scripts, requests, options, timers, status, window, send };
}

test("the real bootstrap initializes exactly once and uses only the supplied SDK contract", async () => {
  const h = harness();
  h.send({ source: {} });
  h.send({ origin: "https://untrusted.test" });
  await flush();
  assert.equal(h.requests.length, 0);
  h.send();
  h.send();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.credentials, "omit");
  assert.equal(h.scripts[0].src, protocol.SDK_URL);
  assert.equal(h.posts.at(-1).message.type, "loading");
  h.scripts[0].onload();
  await flush();
  assert.equal(h.options.length, 1);
  assert.deepEqual(
    Object.keys(h.options[0]).sort(),
    ["appKey", "baseUrl", "hideSidebar", "variables"].sort(),
  );
  assert.equal(h.options[0].variables.token, undefined);
  assert.equal(h.posts.at(-1).message.type, "initialized");
  assert.ok(h.status.hidden);
  assert.equal(h.timers.size, 0);
  h.send();
  await flush();
  assert.equal(h.options.length, 1);
});

test("context disabled sends the platform's original empty variables object", async () => {
  const h = harness({ context_enabled: false });
  h.send();
  await flush();
  h.scripts[0].onload();
  await flush();
  assert.equal(Object.keys(h.options[0].variables).length, 0);
});

test("disabled config and foreign script URLs never load an external script", async () => {
  for (const config of [
    { enabled: false },
    { sdk_url: "https://evil.test/script.js" },
    { base_url: "https://evil.test" },
  ]) {
    const h = harness(config);
    h.send();
    await flush();
    assert.equal(h.scripts.length, 0);
    assert.equal(h.posts.at(-1).message.type, "error");
    assert.equal(h.options.length, 0);
  }
});

test("blocked, missing, thrown and timed-out SDKs produce errors rather than mock answers", async () => {
  for (const kind of ["blocked", "missing", "throws", "timeout"]) {
    const h = harness();
    h.send();
    await flush();
    if (kind === "blocked") h.scripts[0].onerror();
    if (kind === "timeout")
      [...h.timers.values()].find((item) => item.delay === 20000).fn();
    if (kind === "missing") {
      h.window.HiagentWebSDK = {};
      h.scripts[0].onload();
    }
    if (kind === "throws") {
      h.window.HiagentWebSDK.WebClient = class {
        constructor() {
          throw new Error("private-detail");
        }
      };
      h.scripts[0].onload();
    }
    await flush();
    assert.equal(h.posts.at(-1).message.type, "error");
    assert.equal(h.status.hidden, false);
    assert.equal(h.options.length, 0);
    assert.ok(!JSON.stringify(h.posts).includes("private-detail"));
    if (kind === "timeout") {
      h.scripts[0].onload();
      await flush();
      assert.equal(h.options.length, 0);
    }
  }
});
