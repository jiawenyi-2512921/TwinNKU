import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run the actual hook's effect/cleanup with controlled reads that deliberately
// ignore abort. This checks races, not React rendering or browser layout.
const code = ts.transpileModule(
  readFileSync(
    new URL("../src/features/admin/ui.tsx", import.meta.url),
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const state = [],
    reads = [],
    writes = [];
  let slot = 0,
    effect,
    cleanup;
  const react = {
    useState(initial) {
      const index = slot++;
      if (index >= state.length) state[index] = initial;
      return [
        state[index],
        (value) => {
          state[index] = value;
          writes.push([index, value]);
        },
      ];
    },
    useEffect(callback) {
      effect = callback;
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    AbortController,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return {};
      if (name === "./api")
        return {
          message: (error) => error.message,
          request: (path, method, body, signal) =>
            new Promise((resolve, reject) => {
              reads.push({ path, method, body, signal, resolve, reject });
            }),
        };
      throw new Error("Unexpected import: " + name);
    },
  });
  return {
    state,
    reads,
    writes,
    render(path) {
      slot = 0;
      exports.useResource(path);
      cleanup?.();
      cleanup = effect();
    },
    dispose() {
      cleanup?.();
    },
  };
}

test("an older building/page read cannot replace the newer list after cancellation", async () => {
  const h = harness();
  h.render("/points?page=1");
  h.render("/points?page=2");
  assert.equal(h.reads[0].signal.aborted, true);
  const newest = { data: [{ id: "second-page" }] };
  h.reads[1].resolve(newest);
  await flush();
  h.reads[0].resolve({ data: [{ id: "first-page" }] });
  await flush();
  assert.equal(h.state[0], newest);
  assert.equal(h.state[2], false);
  h.dispose();
});

test("clearing the resource path stops the loading state and ignores the pending result", async () => {
  const h = harness();
  h.render("/resources?point_id=first");
  assert.equal(h.state[2], true);
  h.render(null);
  assert.deepEqual(h.state, [null, "", false]);
  h.reads[0].resolve({ data: [{ id: "old-resource" }] });
  await flush();
  assert.deepEqual(h.state, [null, "", false]);
  assert.equal(h.reads.length, 1);
});

test("unmounted reads cannot write an error or clear another effect's loading state", async () => {
  const h = harness();
  h.render("/points?page=1");
  h.dispose();
  const count = h.writes.length;
  h.reads[0].reject(new Error("old network error"));
  await flush();
  assert.equal(h.writes.length, count);
});
