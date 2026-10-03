import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/** Load the actual shared draft logic against a test's controlled React/network. */
export function adminLogic(react, api, extra = {}) {
  const modules = new Map();
  function load(name) {
    if (name === "react") return react;
    if (name === "./api") return api;
    if (modules.has(name)) return modules.get(name);
    if (
      ![
        "./useManagedDraft",
        "./draftCoordinator",
        "./confirmedOperation",
      ].includes(name)
    )
      throw new Error(`Unexpected admin logic dependency ${name}`);
    const exports = {};
    modules.set(name, exports);
    const code = ts.transpileModule(
      readFileSync(
        new URL(
          `../../src/features/admin/${name.slice(2)}.ts`,
          import.meta.url,
        ),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    vm.runInNewContext(code, {
      exports,
      require: load,
      structuredClone,
      crypto,
      Date,
      Error,
      setTimeout: (fn, delay) => {
        const timer = setTimeout(fn, delay);
        timer.unref();
        return timer;
      },
      clearTimeout,
      ...extra,
    });
    return exports;
  }
  return load;
}
