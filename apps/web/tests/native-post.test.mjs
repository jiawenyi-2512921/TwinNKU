import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
const nativeCode = compile("../src/features/agent/native.ts");
const deadlineCode = compile("../src/shared/requestDeadline.ts");
const requestId = "31636ab8-027d-4fa1-91cb-1b36c65fc541";
const headerId = "750e735c-dcc2-4ac0-af51-3ab955e4ecba";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const envelope = (data = { answer: "测试回答" }) => ({
  data,
  meta: { request_id: requestId },
});
const jsonResponse = (payload, status = 200, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// Exercise both real modules with real short timers. Only network replies and
// the 105-second duration are controlled; no model requests are made.
function client(fetch, timeoutMs = 1000) {
  const timers = new Set();
  const stats = { scheduled: 0, cleared: 0, budgets: [] };
  const deadline = {};
  vm.runInNewContext(deadlineCode, {
    exports: deadline,
    AbortController,
    DOMException,
    setTimeout(callback, delay) {
      stats.scheduled++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      stats.cleared++;
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const source = {};
  vm.runInNewContext(nativeCode, {
    exports: source,
    DOMException,
    TypeError,
    fetch,
    require(name) {
      assert.equal(name, "../../shared/requestDeadline.ts");
      return {
        withRequestDeadline(load, signal, budget) {
          stats.budgets.push(budget);
          return deadline.withRequestDeadline(load, signal, timeoutMs);
        },
      };
    },
  });
  return { ...source, stats, timers };
}

function trackedParent() {
  const controller = new AbortController();
  const listeners = new Set();
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener(type, listener, options) {
      listeners.add(listener);
      controller.signal.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
      controller.signal.removeEventListener(type, listener);
    },
  };
  return { controller, signal, listeners };
}

test("native POST keeps its 105-second budget and releases timers and listeners after success", async () => {
  const parent = trackedParent();
  let calls = 0,
    requestSignal;
  const source = client(async (url, options) => {
    calls++;
    assert.equal(url, "/api/v1/agent/chat");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.headers["X-CSRF-Token"], "test-csrf");
    assert.deepEqual(JSON.parse(options.body), { query: "测试问题" });
    requestSignal = options.signal;
    return jsonResponse(envelope());
  });
  assert.deepEqual(
    await source.post(
      "/agent/chat",
      { query: "测试问题" },
      "test-csrf",
      parent.signal,
    ),
    { answer: "测试回答" },
  );
  assert.equal(calls, 1);
  assert.deepEqual(source.stats.budgets, [105_000]);
  assert.equal(source.stats.scheduled, 1);
  assert.equal(source.stats.cleared, 1);
  assert.equal(source.timers.size, 0);
  assert.equal(parent.listeners.size, 0);
  parent.controller.abort();
  assert.equal(requestSignal.aborted, false);
});

test("JSON 503 preserves the fixed upstream stage, business message and envelope request ID", async () => {
  for (const code of [
    "AGENT_CONVERSATION_TIMEOUT",
    "AGENT_REPLY_TIMEOUT",
    "AGENT_UPSTREAM_CONNECTION_FAILED",
    "AGENT_UPSTREAM_UNAVAILABLE",
    "RATE_LIMITED",
    "MAP_UNAVAILABLE",
  ]) {
    let calls = 0;
    const source = client(async () => {
      calls++;
      return jsonResponse(
        {
          error: { code, message: "平台错误提示，请勿立即重复发送" },
          meta: { request_id: requestId },
        },
        503,
        { "X-Request-ID": headerId },
      );
    });
    await assert.rejects(source.post("/agent/chat", {}), (error) => {
      assert.ok(error instanceof source.NativeError);
      assert.equal(error.status, 503);
      assert.equal(error.code, code);
      assert.equal(error.message, "平台错误提示，请勿立即重复发送");
      assert.equal(error.requestId, requestId);
      return true;
    });
    assert.equal(calls, 1, "failed POSTs must never retry automatically");
    assert.equal(source.timers.size, 0);
  }
});

test("an HTML 504 identifies the website proxy timeout and keeps a valid response header ID", async () => {
  const source = client(
    async () =>
      new Response("<html><body>Gateway timeout</body></html>", {
        status: 504,
        headers: { "Content-Type": "text/html", "X-Request-ID": headerId },
      }),
  );
  await assert.rejects(source.post("/agent/chat", {}), (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, "AGENT_PROXY_TIMEOUT");
    assert.equal(error.requestId, headerId);
    assert.match(
      error.message,
      /网站代理等待超时.*结果未确认.*请勿立即重复发送/,
    );
    assert.doesNotMatch(error.message, /html|Gateway/);
    return true;
  });
});

test("malformed successful replies fail safely instead of being accepted as answers", async () => {
  for (const response of [
    new Response("not JSON", { headers: { "X-Request-ID": headerId } }),
    jsonResponse({ data: { answer: "old" } }),
    jsonResponse({
      data: { answer: "old" },
      meta: { request_id: "arbitrary" },
    }),
    jsonResponse({ meta: { request_id: requestId } }),
  ]) {
    const source = client(async () => response);
    await assert.rejects(source.post("/agent/chat", {}), (error) => {
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.equal(error.message, "服务返回格式异常");
      return true;
    });
    assert.equal(source.timers.size, 0);
  }
});

test("arbitrary diagnostic strings are discarded while valid header UUIDs can recover missing metadata", async () => {
  const source = client(async () =>
    jsonResponse(
      {
        error: { code: "UNRECOGNIZED_SECRET", message: "固定业务提示" },
        meta: { request_id: "untrusted upstream text" },
      },
      503,
      { "X-Request-ID": headerId },
    ),
  );
  await assert.rejects(source.post("/agent/chat", {}), (error) => {
    assert.equal(error.code, undefined);
    assert.equal(error.requestId, headerId);
    assert.equal(error.message, "固定业务提示");
    return true;
  });
  const invalid = new source.NativeError("固定提示", 503, {
    code: "https://example.test/private",
    requestId: "token-not-a-request-id",
  });
  assert.equal(invalid.code, undefined);
  assert.equal(invalid.requestId, undefined);
});

test("a stalled JSON body ends at the actual deadline, aborts transport and ignores its late answer", async () => {
  const parent = trackedParent();
  let requestSignal,
    complete,
    calls = 0;
  const source = client(async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "X-Request-ID": headerId }),
      json: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    };
  }, 5);
  await assert.rejects(
    source.post("/agent/chat", {}, "", parent.signal),
    (error) => {
      assert.equal(error.status, 408);
      assert.equal(error.code, "AGENT_CLIENT_TIMEOUT");
      assert.equal(error.requestId, headerId);
      assert.match(error.message, /网页等待请求已超时.*结果未确认/);
      return true;
    },
  );
  assert.equal(requestSignal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.equal(parent.listeners.size, 0);
  assert.equal(source.timers.size, 0);
  complete(envelope({ answer: "迟到回答" }));
  await flush();
  assert.equal(calls, 1);
});

test("an already-cancelled POST never starts transport or allocates a timer", async () => {
  const parent = trackedParent();
  parent.controller.abort();
  let calls = 0;
  const source = client(async () => {
    calls++;
    return jsonResponse(envelope());
  });
  await assert.rejects(
    source.post("/agent/chat", {}, "", parent.signal),
    (error) => {
      assert.equal(error.code, "REQUEST_CANCELLED");
      assert.match(error.message, /在网页取消.*后台可能仍在处理/);
      assert.doesNotMatch(error.message, /已超时/);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(source.stats.scheduled, 0);
  assert.equal(parent.listeners.size, 0);
});

test("explicit cancellation while parsing a response body stays distinct from timeout and cleans up", async () => {
  const parent = trackedParent();
  let requestSignal;
  const source = client(async (_url, options) => {
    requestSignal = options.signal;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "X-Request-ID": headerId }),
      json: () => new Promise(() => {}),
    };
  });
  const pending = source.post("/agent/chat", {}, "", parent.signal);
  await flush();
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, "REQUEST_CANCELLED");
    assert.equal(error.requestId, headerId);
    assert.match(error.message, /后台可能仍在处理/);
    return true;
  });
  parent.controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(source.stats.cleared, 1);
  assert.equal(source.timers.size, 0);
  assert.equal(parent.listeners.size, 0);
});

test("network failures identify the website connection without exposing raw exceptions and release deadline resources", async () => {
  const parent = trackedParent();
  const failure = new TypeError("Controlled network failure");
  let calls = 0;
  const source = client(() => {
    calls++;
    throw failure;
  });
  await assert.rejects(
    source.post("/agent/chat", {}, "", parent.signal),
    (error) => {
      assert.equal(error.code, "NETWORK_ERROR");
      assert.equal(error.status, 0);
      assert.match(error.message, /网页未能连接本站服务.*结果未确认/);
      assert.doesNotMatch(error.message, /Controlled network failure|学校/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(source.stats.cleared, 1);
  assert.equal(source.timers.size, 0);
  assert.equal(parent.listeners.size, 0);
});
