import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureVisitorSession,
  forgetVisitorSession,
  rememberVisitorSession,
  endVisitorSession,
  prepareTourVoice,
  prepareDraftVoice,
} from "../src/shared/visitorSession.ts";

const response = (status, data) =>
  new Response(
    JSON.stringify(
      status >= 400
        ? { error: { code: "LOGIN_REQUIRED", message: "会话过期" } }
        : {
            data,
            meta: { request_id: "123e4567-e89b-42d3-a456-426614174000" },
          },
    ),
    { status, headers: { "Content-Type": "application/json" } },
  );

test("public bootstrap deduplicates concurrent callers and never resends user text", async () => {
  forgetVisitorSession();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/session")
      ? response(401)
      : response(200, { csrf_token: "guest-csrf" });
  };
  try {
    const sessions = await Promise.all([
      ensureVisitorSession(),
      ensureVisitorSession(),
    ]);
    assert.deepEqual(
      sessions.map((s) => s.csrf_token),
      ["guest-csrf", "guest-csrf"],
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ["/api/v1/agent/session", "/api/v1/agent/guest"],
    );
    assert.equal(calls[1].init.body, undefined);
    assert.equal((await ensureVisitorSession()).csrf_token, "guest-csrf");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});

test("private entry and non-authentication failures never create a guest", async () => {
  const original = globalThis.fetch;
  try {
    for (const [enabled, status] of [
      [false, 401],
      [true, 503],
    ]) {
      forgetVisitorSession();
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        return response(status);
      };
      await assert.rejects(ensureVisitorSession(enabled));
      assert.deepEqual(calls, ["/api/v1/agent/session"]);
    }
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});

test("private login invalidates an older public bootstrap", async () => {
  forgetVisitorSession();
  const original = globalThis.fetch;
  let finish;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    const old = ensureVisitorSession();
    await new Promise((resolve) => setImmediate(resolve));
    rememberVisitorSession("private-csrf");
    finish(response(200, { csrf_token: "obsolete-csrf" }));
    await assert.rejects(old, { name: "AbortError" });
    assert.equal(
      (await ensureVisitorSession(false)).csrf_token,
      "private-csrf",
    );
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});

test("tour prepare replaces an expired guest once and posts only a typed source", async () => {
  rememberVisitorSession("expired-csrf");
  const original = globalThis.fetch;
  const calls = [];
  const source = {
    kind: "tour_segment",
    tour_id: "tour",
    tour_revision: 2,
    stop_index: 4,
    segment_id: "part",
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return response(401);
    if (url.endsWith("/session")) return response(401);
    if (url.endsWith("/guest"))
      return response(200, { csrf_token: "renewed-csrf" });
    return response(200, {
      permit: "server-permit",
      chunks: ["完整服务端段落"],
    });
  };
  try {
    const manifest = await prepareTourVoice(source);
    assert.equal(manifest.csrf, "renewed-csrf");
    const prepares = calls.filter((c) => c.url.endsWith("/voice/prepare"));
    assert.equal(prepares.length, 2);
    assert.deepEqual(JSON.parse(prepares[1].init.body), { source });
    assert.equal(prepares[1].init.headers["X-CSRF-Token"], "renewed-csrf");
    assert.ok(calls.every((c) => !c.url.endsWith("/speech")));
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});

test("ending a session blocks simultaneous bootstrap and clears local state on failure", async () => {
  rememberVisitorSession("ending-csrf");
  const original = globalThis.fetch;
  let finish;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    const ending = endVisitorSession();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(ensureVisitorSession(), { name: "AbortError" });
    finish(response(503));
    await assert.rejects(ending);
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return response(401);
    };
    await assert.rejects(ensureVisitorSession(false));
    assert.deepEqual(calls, ["/api/v1/agent/session"]);
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});

test("draft prepare uses the staff CSRF and private speech endpoint without guest bootstrap", async () => {
  forgetVisitorSession();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response(200, { permit: "draft-permit", chunks: ["后台预览"] });
  };
  try {
    const manifest = await prepareDraftVoice(
      {
        kind: "draft_segment",
        tour_id: "draft",
        draft_revision: 3,
        stop_index: 0,
      },
      "staff-csrf",
    );
    assert.equal(manifest.endpoint, "/admin/voice/speech");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/v1/admin/voice/prepare");
    assert.equal(calls[0].init.headers["X-CSRF-Token"], "staff-csrf");
  } finally {
    globalThis.fetch = original;
    forgetVisitorSession();
  }
});
