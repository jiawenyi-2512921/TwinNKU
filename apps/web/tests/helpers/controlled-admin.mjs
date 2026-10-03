import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

export const find = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((t) => find(t, predicate))
    : tree && typeof tree === "object"
      ? [
          ...(predicate(tree) ? [tree] : []),
          ...find(tree.props?.children, predicate),
        ]
      : [];
export const text = (tree) =>
  Array.isArray(tree)
    ? tree.map(text).join("")
    : tree && typeof tree === "object"
      ? text(tree.props?.children)
      : typeof tree === "string" || typeof tree === "number"
        ? String(tree)
        : "";
export const button = (tree, label) =>
  find(tree, (node) => node.type === "button" && text(node) === label)[0];
export function controlledAdmin(externals = {}, globals = {}) {
  const stores = new Map(),
    timers = new Map(),
    modules = new Map();
  let active,
    cursor = 0,
    timerId = 0;
  const react = {
    useState(initial) {
      const store = active,
        key = cursor++;
      if (!(key in store.slots))
        store.slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        store.slots[key],
        (next) => {
          const value =
            typeof next === "function" ? next(store.slots[key]) : next;
          if (!Object.is(value, store.slots[key])) {
            store.slots[key] = value;
            store.dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const store = active,
        key = cursor++;
      if (!(key in store.slots)) store.slots[key] = { current: initial };
      return store.slots[key];
    },
    useEffect(callback, deps) {
      const store = active,
        key = cursor++,
        previous = store.effects[key];
      if (
        !previous ||
        !deps ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))
      )
        store.queue.push(() => {
          previous?.cleanup?.();
          store.effects[key] = { deps, cleanup: callback() };
        });
    },
    useCallback(callback, deps) {
      const store = active,
        key = cursor++,
        previous = store.slots[key];
      if (
        !previous ||
        !deps ||
        deps.some((value, index) => !Object.is(value, previous.deps[index]))
      )
        store.slots[key] = { callback, deps };
      return store.slots[key].callback;
    },
  };
  const browser = new EventTarget();
  browser.confirm = () => true;
  function load(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsx;
    if (name.endsWith(".css")) return {};
    if (name in externals) return externals[name];
    if (modules.has(name)) return modules.get(name);
    if (!name.startsWith("./"))
      throw new Error(`Unexpected dependency ${name}`);
    const tsFile = new URL(
      `../../src/features/admin/${name.slice(2)}.ts`,
      import.meta.url,
    );
    const filename = new URL(
      `../../src/features/admin/${name.slice(2)}${existsSync(tsFile) ? ".ts" : ".tsx"}`,
      import.meta.url,
    );
    const exports = {};
    modules.set(name, exports);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      require: load,
      structuredClone,
      crypto,
      TextEncoder,
      URLSearchParams,
      AbortController,
      Blob,
      File,
      URL,
      Error,
      Event,
      Date,
      window: browser,
      document: { visibilityState: "visible" },
      setTimeout: (callback, delay) => {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      ...globals,
    });
    return exports;
  }
  return {
    load,
    browser,
    render(key, component, props) {
      let store = stores.get(key);
      if (!store) {
        store = { slots: [], effects: [], queue: [], dirty: true };
        stores.set(key, store);
      }
      let tree,
        rounds = 0;
      do {
        if (++rounds > 30) throw new Error("Controlled hooks did not settle");
        active = store;
        cursor = 0;
        store.dirty = false;
        store.queue = [];
        tree = component(props);
        store.queue.forEach((run) => run());
      } while (store.dirty);
      return tree;
    },
    runTimers(delay) {
      for (const [id, timer] of [...timers])
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
    },
    dispose() {
      for (const store of stores.values())
        store.effects.forEach((e) => e?.cleanup?.());
      timers.clear();
    },
  };
}
