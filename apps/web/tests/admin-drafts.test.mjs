import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const exports = {};
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL("../src/features/admin/draftCoordinator.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  {
    exports,
    structuredClone,
    crypto,
    Date,
    setTimeout: (fn, delay) => {
      const t = setTimeout(fn, delay);
      t.unref();
      return t;
    },
    clearTimeout,
  },
);
const { DraftCoordinator, stableContent, contentDiff } = exports;
const operationExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/features/admin/confirmedOperation.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: operationExports });
const { confirmedOperation, UnconfirmedOperation } = operationExports;
const snap = (text, revision = 1) => ({
  id: "private-record",
  revision,
  published_revision: 3,
  content: { text },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("unchanged content including reordered object keys makes no write or revision", async () => {
  let writes = 0;
  const c = new DraftCoordinator(
    { ...snap("one"), content: { text: "one", meta: { a: 1, b: 2 } } },
    {
      save: async () => {
        writes++;
      },
      recover: async () => null,
      latest: async () => snap("one"),
    },
  );
  c.edit({ meta: { b: 2, a: 1 }, text: "one" });
  assert.equal(await c.flush(), true);
  assert.equal(writes, 0);
  assert.equal(c.state.base.revision, 1);
  c.dispose();
});
test("typing is debounced and only the most recent input is saved", async () => {
  const calls = [];
  const c = new DraftCoordinator(
    snap("start"),
    {
      save: async (value, version) => {
        calls.push({ value, version });
        return snap(value.text, 2);
      },
      recover: async () => null,
      latest: async () => snap("start"),
    },
    { delay: 12 },
  );
  c.edit({ text: "one" });
  c.edit({ text: "two" });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.text, "two");
  assert.equal(calls[0].version.expected_published_revision, 3);
  assert.match(calls[0].version.operation_id, /^[a-f0-9-]{36}$/);
  c.dispose();
});
test("serial CAS saving does not overwrite edits made during an older response", async () => {
  const first = deferred(),
    calls = [];
  const c = new DraftCoordinator(snap("start"), {
    save: async (value, version) => {
      calls.push({ value, version });
      return calls.length === 1 ? first.promise : snap(value.text, 3);
    },
    recover: async () => null,
    latest: async () => snap("start"),
  });
  c.edit({ text: "older" });
  const pending = c.flush();
  c.edit({ text: "newer" });
  assert.equal(calls.length, 1);
  first.resolve(snap("older", 2));
  await pending;
  assert.equal(c.state.value.text, "newer");
  assert.equal(c.state.dirty, true);
  await c.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].version.expected_revision, 2);
  assert.notEqual(calls[0].version.operation_id, calls[1].version.operation_id);
  assert.equal(c.state.phase, "clean");
  c.dispose();
});
test("canonical server acknowledgement updates unchanged input without an endless trim save loop", async () => {
  let writes = 0;
  const c = new DraftCoordinator(snap("start"), {
    save: async () => {
      writes++;
      return snap("trimmed", 2);
    },
    recover: async () => null,
    latest: async () => snap("start"),
  });
  c.edit({ text: " trimmed " });
  await c.flush();
  assert.equal(c.state.value.text, "trimmed");
  assert.equal(await c.flush(), true);
  assert.equal(writes, 1);
  c.dispose();
});
test("lost response queries the same operation and never replays its save", async () => {
  let writes = 0,
    queried;
  const c = new DraftCoordinator(snap("start"), {
    save: async (_value, version) => {
      writes++;
      queried = version.operation_id;
      throw new TypeError("network");
    },
    recover: async (id) => {
      assert.equal(id, queried);
      return snap("acknowledged", 2);
    },
    latest: async () => snap("start"),
  });
  c.edit({ text: "acknowledged" });
  assert.equal(await c.flush(), true);
  assert.equal(writes, 1);
  assert.equal(c.state.base.revision, 2);
  c.dispose();
});
test("unknown operation keeps private input in memory and blocks later blind writes", async () => {
  let writes = 0;
  const c = new DraftCoordinator(snap("start"), {
    save: async () => {
      writes++;
      throw new TypeError("network");
    },
    recover: async () => null,
    latest: async () => snap("start"),
  });
  c.edit({ text: "private" });
  await c.flush();
  c.edit({ text: "later" });
  c.forceDirty();
  assert.equal(await c.flush(), false);
  assert.equal(c.state.phase, "uncertain");
  assert.equal(c.state.value.text, "later");
  assert.equal(writes, 1);
  c.dispose();
});
test("version conflict keeps opening, local and server content and requires explicit resolution save", async () => {
  let writes = 0;
  const c = new DraftCoordinator(snap("opened"), {
    save: async (value, version) => {
      writes++;
      if (writes === 1) throw Object.assign(new Error("CAS"), { status: 409 });
      assert.equal(version.expected_revision, 7);
      return snap(value.text, 8);
    },
    recover: async () => null,
    latest: async () => snap("server", 7),
  });
  c.edit({ text: "mine" });
  await c.flush();
  assert.equal(c.state.phase, "conflict");
  assert.equal(c.state.conflict.opened.text, "opened");
  assert.equal(c.state.conflict.local.text, "mine");
  assert.equal(c.state.conflict.server.content.text, "server");
  assert.equal(await c.flush(), false);
  c.resolve("local");
  assert.equal(await c.flush(), false);
  c.retryValidation();
  await c.flush();
  assert.equal(c.state.value.text, "mine");
  assert.equal(writes, 2);
  c.dispose();
});
test("scope or account disposal prevents an old response from updating the replacement draft", async () => {
  const pending = deferred();
  let emitted = 0;
  const c = new DraftCoordinator(snap("start"), {
    save: () => pending.promise,
    recover: async () => null,
    latest: async () => snap("start"),
  });
  c.subscribe(() => emitted++);
  c.edit({ text: "private" });
  const save = c.flush();
  c.dispose();
  const before = emitted;
  pending.resolve(snap("private", 2));
  await save;
  assert.equal(emitted, before);
  assert.equal(c.state.base.revision, 1);
});
test("metadata-only inheritance edits during a save remain dirty until separately confirmed", async () => {
  const pending = deferred();
  let writes = 0;
  const c = new DraftCoordinator(snap("start"), {
    save: async () => {
      writes++;
      return writes === 1 ? pending.promise : snap("start", 3);
    },
    recover: async () => null,
    latest: async () => snap("start"),
  });
  c.forceDirty();
  const saving = c.flush();
  c.forceDirty();
  pending.resolve(snap("start", 2));
  await saving;
  assert.equal(c.state.dirty, true);
  await c.flush();
  assert.equal(writes, 2);
  c.dispose();
});
test("field differences include missing values and arrays without exposing storage", () => {
  assert.equal(
    stableContent({ b: 1, a: [2] }),
    stableContent({ a: [2], b: 1 }),
  );
  assert.deepEqual(
    Array.from(
      contentDiff({ title: "old", rows: [1] }, { title: "new", rows: [1, 2] }),
      (d) => d.path,
    ),
    ["内容.title", "内容.rows"],
  );
});
test("a lost submit or restore response can only be recovered by its exact operation ID", async () => {
  let writes = 0;
  const result = await confirmedOperation("one-operation", async () => { writes++; throw new TypeError("network"); }, async id => { assert.equal(id, "one-operation"); return { state: "in_review" }; });
  assert.equal(result.state, "in_review"); assert.equal(writes, 1);
});
test("unconfirmed actions and definitive authorization failures cannot trigger a replay", async () => {
  let reads = 0, writes = 0;
  await assert.rejects(confirmedOperation("pending", async () => { writes++; throw new TypeError("network"); }, async () => { reads++; return null; }), e => e instanceof UnconfirmedOperation && e.operationId === "pending");
  const forbidden = Object.assign(new Error("permission"), { status: 403 });
  await assert.rejects(confirmedOperation("denied", async () => { writes++; throw forbidden; }, async () => { reads++; return {}; }), e => e === forbidden);
  assert.equal(writes, 2); assert.equal(reads, 1);
});
