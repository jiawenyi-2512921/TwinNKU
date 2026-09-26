import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as navigation from "../src/shared/navigation.ts";
import {
  watchCatalogChanges,
  CATALOG_PUBLISHED,
  CATALOG_REFRESH_MS,
} from "../src/shared/catalogSync.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Execute the actual components' effects with controlled API reads and event
// targets. This verifies subscriptions and state updates, not browser layout.
function mount(kind) {
  const floor = kind === "floor";
  const file = floor ? "floors/FloorPanel" : "points/PanoramaPanel";
  const name = floor ? "FloorPanel" : "PanoramaPanel";
  const code = ts.transpileModule(
    readFileSync(
      new URL(`../src/features/${file}.tsx`, import.meta.url),
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
  const state = [],
    effects = [],
    reads = [],
    writes = [];
  const browser = new EventTarget(),
    page = new EventTarget();
  const channel = { onmessage: null, close() {}, postMessage() {} };
  page.visibilityState = "visible";
  browser.location = {
    href: "https://guide.example/?point=building",
    search: "?point=building",
  };
  browser.clearTimeout = clearTimeout;
  browser.history = {
    state: null,
    replaceState(_state, _title, href) {
      browser.location.href = href;
      browser.location.search = new URL(href).search;
    },
  };
  let slot = 0;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    AbortController,
    URLSearchParams,
    window: browser,
    document: page,
    require(path) {
      if (path === "react")
        return {
          useState(initial) {
            const index = slot++;
            state[index] = initial;
            return [
              initial,
              (value) => {
                const next =
                  typeof value === "function" ? value(state[index]) : value;
                state[index] = next;
                writes.push([index, next]);
              },
            ];
          },
          useRef: (value) => ({ current: value }),
          useEffect: (effect) => effects.push(effect),
        };
      if (path === "react/jsx-runtime") return { jsx() {}, jsxs() {} };
      if (path === "../../shared/catalogSync")
        return {
          watchCatalogChanges: (refresh) =>
            watchCatalogChanges(refresh, page, browser, channel),
        };
      if (path === "../../shared/navigation")
        return {
          ...navigation,
          writeLocation: (href, mode) =>
            navigation.writeLocation(href, mode, browser),
        };
      if (path === "../../shared/api/client") {
        const read = (pointId, signal) =>
          new Promise((resolve, reject) => {
            reads.push({ pointId, signal, resolve, reject });
          });
        return { api: { floors: read, panoramas: read } };
      }
      if (
        path.endsWith(".css") ||
        path.endsWith("/Icon") ||
        path === "./FloorViewer"
      )
        return {};
      throw new Error("Unexpected import: " + path);
    },
  });
  exports[name]({ pointId: "building", pointName: "测试楼" });
  const cleanups = effects.map((effect) => effect());
  return {
    state,
    reads,
    writes,
    browser,
    page,
    channel,
    dispose() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}

function row(kind, revision = 1) {
  return kind === "floor"
    ? {
        id: "resource",
        point_id: "building",
        revision,
        label: `${revision}版楼层`,
        images: [
          {
            variant: "labeled",
            section: "main",
            url: `/floors/${revision}.png`,
          },
        ],
      }
    : {
        id: "resource",
        point_id: "building",
        revision,
        title: `${revision}版全景`,
        url: `https://example.com/scene/${revision}`,
      };
}

for (const kind of ["floor", "panorama"]) {
  test(`${kind}: reconnect recovers a failed read; publication updates and retirement removes resources`, async () => {
    const h = mount(kind);
    try {
      h.reads[0].reject(new Error("offline"));
      await flush();
      assert.equal(h.state[kind === "floor" ? 3 : 1], "error");
      h.browser.dispatchEvent(new Event("online"));
      assert.equal(h.reads.length, 2);
      h.reads[1].resolve({ data: [row(kind)] });
      await flush();
      assert.equal(h.state[kind === "floor" ? 3 : 1], "ready");
      assert.equal(h.state[0][0].revision, 1);
      h.channel.onmessage({ data: CATALOG_PUBLISHED });
      h.reads[2].resolve({ data: [row(kind, 2)] });
      await flush();
      assert.equal(h.state[0][0].revision, 2);
      assert.equal(
        kind === "floor" ? h.state[0][0].images[0].url : h.state[0][0].url,
        kind === "floor" ? "/floors/2.png" : "https://example.com/scene/2",
      );
      assert.equal(
        kind === "floor" ? h.state[0][0].label : h.state[0][0].title,
        kind === "floor" ? "2版楼层" : "2版全景",
      );
      h.channel.onmessage({ data: CATALOG_PUBLISHED });
      h.reads[3].resolve({ data: [] });
      await flush();
      assert.equal(h.state[0].length, 0);
      if (kind === "floor") {
        assert.equal(h.state[1], "");
        assert.equal(h.state[5], false);
      }
    } finally {
      h.dispose();
    }
  });

  test(`${kind}: late reads cannot undo publication; unmount removes listeners and rejects late updates`, async () => {
    const h = mount(kind);
    try {
      h.channel.onmessage({ data: CATALOG_PUBLISHED });
      assert.equal(h.reads[0].signal.aborted, true);
      h.reads[1].resolve({
        data: [row(kind, 2), { ...row(kind), point_id: "other" }],
      });
      await flush();
      h.reads[0].resolve({ data: [row(kind)] });
      await flush();
      assert.equal(h.state[0].length, 1);
      assert.equal(h.state[0][0].revision, 2);
      h.browser.dispatchEvent(new Event("online"));
    } finally {
      h.dispose();
    }
    const count = h.writes.length;
    h.reads[2].resolve({ data: [] });
    await flush();
    h.browser.dispatchEvent(new Event("online"));
    h.browser.dispatchEvent(new Event("focus"));
    assert.equal(h.writes.length, count);
    assert.equal(h.reads.length, 3);
    assert.equal(h.channel.onmessage, null);
  });

  test(`${kind}: hidden panels defer refresh until visible; unchanged polling preserves row identity`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = mount(kind);
    try {
      h.reads[0].resolve({ data: [row(kind)] });
      await flush();
      const before = h.state[0];
      h.page.visibilityState = "hidden";
      h.browser.dispatchEvent(new Event("online"));
      h.channel.onmessage({ data: CATALOG_PUBLISHED });
      t.mock.timers.tick(CATALOG_REFRESH_MS);
      assert.equal(h.reads.length, 1);
      h.page.visibilityState = "visible";
      h.page.dispatchEvent(new Event("visibilitychange"));
      h.reads[1].resolve({ data: [row(kind)] });
      await flush();
      assert.equal(h.state[0], before);
      t.mock.timers.tick(CATALOG_REFRESH_MS);
      assert.equal(h.reads.length, 3);
    } finally {
      h.dispose();
    }
  });
}
