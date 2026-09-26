import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { withRequestDeadline } from "../src/shared/requestDeadline.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a stalled transport fails at its deadline and aborts the network request", async () => {
  let signal;
  const result = withRequestDeadline(
    (requestSignal) => {
      signal = requestSignal;
      return new Promise(() => {});
    },
    undefined,
    5,
  );
  await assert.rejects(result, { name: "TimeoutError" });
  assert.equal(signal.aborted, true);
});

test("a request cancelled before starting never calls the transport", async () => {
  const parent = new AbortController();
  parent.abort();
  let called = false;
  await assert.rejects(
    withRequestDeadline(async () => {
      called = true;
    }, parent.signal),
    { name: "AbortError" },
  );
  assert.equal(called, false);
});

test("leaving a point cancels a pending response body and rejects any late answer", async () => {
  const parent = new AbortController();
  let signal;
  let resolveBody;
  const result = withRequestDeadline(
    async (requestSignal) => {
      signal = requestSignal;
      // Headers have arrived, but reading the body is still pending.
      return await new Promise((resolve) => {
        resolveBody = resolve;
      });
    },
    parent.signal,
    1000,
  );
  await flush();
  const rejection = assert.rejects(result, { name: "AbortError" });
  parent.abort();
  await rejection;
  assert.equal(signal.aborted, true);
  resolveBody({ data: "old-building" });
  await flush();
});

test("successful reads release the abort listener and do not abort after completion", async () => {
  const parent = new AbortController();
  let added = 0,
    removed = 0;
  const port = {
    get aborted() {
      return parent.signal.aborted;
    },
    addEventListener(...args) {
      added++;
      parent.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      removed++;
      parent.signal.removeEventListener(...args);
    },
  };
  let signal;
  const value = await withRequestDeadline(
    async (requestSignal) => {
      signal = requestSignal;
      return { data: ["published"] };
    },
    port,
    1000,
  );
  assert.deepEqual(value, { data: ["published"] });
  assert.equal(added, 1);
  assert.equal(removed, 1);
  parent.abort();
  assert.equal(signal.aborted, false);
});

test("a synchronous network failure keeps its original error and cleans up", async () => {
  const failure = new TypeError("offline");
  await assert.rejects(
    withRequestDeadline(
      () => {
        throw failure;
      },
      undefined,
      1000,
    ),
    (error) => error === failure,
  );
});

test("deadline failure wins over an abort rejection from the fetch implementation", async () => {
  const result = withRequestDeadline(
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    undefined,
    5,
  );
  await assert.rejects(result, { name: "TimeoutError" });
});

// Exercise the real public API client as well as the transport helper. Only the
// timeout duration and network are controlled; this is not a browser layout test.
const clientCode = ts.transpileModule(
  readFileSync(new URL("../src/shared/api/client.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function client(fetch) {
  const exports = {};
  vm.runInNewContext(clientCode, {
    exports,
    DOMException,
    fetch,
    require: () => ({
      withRequestDeadline: (load, signal) =>
        withRequestDeadline(load, signal, 5),
    }),
  });
  return exports;
}

test("a stalled public JSON body becomes a retryable 408 without cancelling the panel owner", async () => {
  const parent = new AbortController();
  let signal;
  const source = client(async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  await assert.rejects(
    source.get("/points/p/floors", parent.signal),
    (error) =>
      error instanceof source.ApiError &&
      error.status === 408 &&
      error.message.includes("超时"),
  );
  assert.equal(signal.aborted, true);
  assert.equal(
    parent.signal.aborted,
    false,
    "the panel must render its retry state, not suppress the failure as superseded",
  );
});

test("a superseded public read stays AbortError, so the previous building cannot render a retry state", async () => {
  const parent = new AbortController();
  const source = client(() => new Promise(() => {}));
  const request = source.get("/points/p/panoramas", parent.signal);
  const rejected = assert.rejects(request, { name: "AbortError" });
  parent.abort();
  await rejected;
});

test("server error envelopes retain status and request ID after deadline wrapping", async () => {
  const source = client(async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      error: { message: "资料服务暂不可用" },
      meta: { request_id: "public-test-request" },
    }),
  }));
  await assert.rejects(
    source.get("/points/p/floors"),
    (error) =>
      error instanceof source.ApiError &&
      error.status === 503 &&
      error.requestId === "public-test-request",
  );
});
