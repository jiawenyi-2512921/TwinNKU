import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
const code = ts.transpileModule(
  readFileSync(
    new URL("../src/shared/ui/EnvironmentBanner.tsx", import.meta.url),
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
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join("")
    : node && typeof node === "object"
      ? text(node.props?.children)
      : typeof node === "string"
        ? node
        : "";
const walk = (node, match) =>
  Array.isArray(node)
    ? node.flatMap((child) => walk(child, match))
    : node && typeof node === "object"
      ? [...(match(node) ? [node] : []), ...walk(node.props?.children, match)]
      : [];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const slots = [],
    effects = [],
    reads = [],
    watchers = new Set();
  let cursor = 0,
    queued = [],
    dirty = false;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value) => {
          const next = typeof value === "function" ? value(slots[i]) : value;
          if (!Object.is(next, slots[i])) {
            slots[i] = next;
            dirty = true;
          }
        },
      ];
    },
    useEffect(fn, deps) {
      const i = cursor++,
        old = effects[i];
      if (!old || deps.some((value, j) => !Object.is(value, old.deps[j])))
        queued.push(() => {
          old?.cleanup?.();
          effects[i] = { deps, cleanup: fn() };
        });
    },
  };
  const module = {};
  vm.runInNewContext(code, {
    exports: module,
    AbortController,
    Error,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/client"))
        return {
          api: {
            status(signal) {
              return new Promise((resolve, reject) =>
                reads.push({ signal, resolve, reject }),
              );
            },
          },
        };
      if (name.endsWith("/catalogSync"))
        return {
          watchCatalogChanges(fn) {
            watchers.add(fn);
            return () => watchers.delete(fn);
          },
        };
      throw Error(name);
    },
  });
  const render = () => {
    let n = 0,
      tree;
    do {
      assert.ok(n++ < 20);
      cursor = 0;
      dirty = false;
      queued = [];
      tree = module.EnvironmentBanner();
      queued.forEach((fn) => fn());
    } while (dirty);
    return tree;
  };
  return {
    reads,
    watchers,
    render,
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}
test("environment notice trusts only the explicit server value; standard hides it and practice has a truthful persistent notice", async () => {
  const h = harness();
  try {
    assert.match(text(h.render()), /正在确认/);
    h.reads[0].resolve({ data: { environment: "standard" } });
    await tick();
    assert.equal(h.render(), null);
    [...h.watchers][0]();
    h.reads[1].resolve({ data: { environment: "practice" } });
    await tick();
    const notice = h.render();
    assert.equal(notice.props.role, "status");
    assert.match(text(notice), /独立练习环境/);
    assert.match(text(notice), /真实供应商调用已关闭/);
    [...h.watchers][0]();
    h.reads[2].reject(Error("network"));
    await tick();
    assert.match(text(h.render()), /独立练习环境/);
    assert.equal(walk(h.render(), (node) => node.type === "button").length, 1);
  } finally {
    h.dispose();
  }
});
test("unknown environments and read failures never imply standard; retry is cancellable and late results cannot replace the current server state", async () => {
  const h = harness();
  try {
    h.render();
    h.reads[0].resolve({ data: { environment: "production-assumed" } });
    await tick();
    assert.match(text(h.render()), /暂时无法确认/);
    walk(h.render(), (node) => node.type === "button")[0].props.onClick();
    h.render();
    assert.equal(h.reads[0].signal.aborted, true);
    [...h.watchers][0]();
    assert.equal(h.reads[1].signal.aborted, true);
    h.reads[1].resolve({ data: { environment: "standard" } });
    h.reads[2].resolve({ data: { environment: "practice" } });
    await tick();
    assert.match(text(h.render()), /独立练习环境/);
    h.dispose();
    assert.equal(h.reads[2].signal.aborted, true);
    assert.equal(h.watchers.size, 0);
  } finally {
    h.dispose();
  }
});
