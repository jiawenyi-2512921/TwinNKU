import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as helpers from "../src/features/points/panorama.ts";
import * as navigation from "../src/shared/navigation.ts";
const official =
  "https://stjgpt.nankai.edu.cn/index-jn.php#scene_4744/0.0/-10.2/120.0";
const item = {
  id: "pano-1",
  point_id: "point-1",
  title: "学校全景",
  description: "公开全景",
  revision: 1,
  url: official,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const find = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((node) => find(node, predicate))
    : !tree || typeof tree !== "object"
      ? []
      : [
          ...(predicate(tree) ? [tree] : []),
          ...find(tree.props?.children, predicate),
        ];
const words = (tree) =>
  Array.isArray(tree)
    ? tree.map(words).join("")
    : tree && typeof tree === "object"
      ? words(tree.props?.children)
      : tree == null
        ? ""
        : String(tree);
function compile(name) {
  return ts.transpileModule(
    readFileSync(
      new URL(`../src/features/points/${name}.tsx`, import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
}

test("only the exact school origin and supported portal path are embedded", () => {
  assert.equal(helpers.embeddedPanoramaUrl(official), official);
  for (const url of [
    "https://stjgpt.nankai.edu.cn.evil.test/index-jn.php",
    "https://evil.test/?host=stjgpt.nankai.edu.cn",
    "https://user:secret@stjgpt.nankai.edu.cn/index-jn.php",
    "http://stjgpt.nankai.edu.cn/index-jn.php",
    "https://stjgpt.nankai.edu.cn:8443/index-jn.php",
    "https://stjgpt.nankai.edu.cn/login",
    "javascript:alert(1)",
    "data:text/html,test",
    "/local",
  ])
    assert.equal(helpers.embeddedPanoramaUrl(url), null, url);
  assert.equal(helpers.externalPanoramaUrl("javascript:alert(1)"), null);
  assert.equal(
    helpers.externalPanoramaUrl("https://another.example/vr"),
    "https://another.example/vr",
  );
});

test("VR selection preserves tour/filter state and ignores stale building callbacks", () => {
  const original =
    "https://guide.test/?point=point-1&q=library&floor=old&floor_section=main&experience=tour-1&experience_point=point-2";
  const opened = new URL(
    helpers.panoramaLocation(original, "point-1", "pano-1"),
  );
  assert.equal(opened.searchParams.get("panorama"), "pano-1");
  assert.equal(opened.searchParams.get("q"), "library");
  assert.equal(opened.searchParams.has("floor"), false);
  assert.equal(opened.searchParams.get("experience"), "tour-1");
  assert.equal(opened.searchParams.get("experience_point"), "point-2");
  assert.equal(helpers.requestedPanorama(opened.href, "point-1"), "pano-1");
  assert.equal(helpers.requestedPanorama(opened.href, "other"), null);
  assert.equal(
    helpers.panoramaLocation(opened.href, "other", null),
    opened.href,
  );
  const closed = new URL(
    helpers.panoramaLocation(opened.href, "point-1", null),
  );
  assert.equal(closed.searchParams.has("panorama"), false);
  assert.equal(closed.searchParams.get("point"), "point-1");
  assert.equal(closed.searchParams.get("experience"), "tour-1");
});

// Controlled component effects verify publication checks and URL/back lifecycle,
// not third-party frame rendering or native browser focus behavior.
function overlay(
  initial = "https://guide.test/?point=point-1&panorama=pano-1",
) {
  const slots = [],
    cleanups = new Map(),
    pendingEffects = [],
    reads = [],
    history = [];
  let position = 0,
    refresh;
  const browser = new EventTarget();
  browser.location = { href: initial, search: new URL(initial).search };
  const change = (href, event) => {
    browser.location.href = href;
    browser.location.search = new URL(href).search;
    browser.dispatchEvent(new Event(event));
  };
  const react = {
    useState(value) {
      const key = position++;
      if (!(key in slots))
        slots[key] = typeof value === "function" ? value() : value;
      return [
        slots[key],
        (next) => {
          slots[key] = typeof next === "function" ? next(slots[key]) : next;
        },
      ];
    },
    useRef(value) {
      const key = position++;
      if (!(key in slots)) slots[key] = { current: value };
      return slots[key];
    },
    useEffect(effect, deps) {
      const key = position++;
      if (!slots[key] || deps.some((value, i) => value !== slots[key][i])) {
        slots[key] = deps;
        pendingEffects.push(() => {
          cleanups.get(key)?.();
          cleanups.set(key, effect());
        });
      }
    },
  };
  const exports = {},
    Viewer = () => null;
  vm.runInNewContext(compile("PanoramaOverlay"), {
    exports,
    window: browser,
    AbortController,
    URLSearchParams,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/client"))
        return {
          api: {
            panoramas(pointId, signal) {
              return new Promise((resolve, reject) =>
                reads.push({ pointId, signal, resolve, reject }),
              );
            },
          },
        };
      if (name === "./panorama") return helpers;
      if (name === "./PanoramaViewer") return { PanoramaViewer: Viewer };
      if (name.endsWith("/catalogSync"))
        return {
          watchCatalogChanges(callback) {
            refresh = callback;
            return () => {
              refresh = null;
            };
          },
        };
      if (name.endsWith("/navigation"))
        return {
          ...navigation,
          writeLocation(href, mode = "push") {
            history.push({ href, mode });
            change(href, navigation.LOCATION_CHANGE_EVENT);
          },
        };
      throw new Error(name);
    },
  });
  function render() {
    position = 0;
    const tree = exports.PanoramaOverlay();
    while (pendingEffects.length) pendingEffects.shift()();
    return tree;
  }
  render();
  return {
    render,
    reads,
    history,
    browser,
    Viewer,
    change,
    refresh: () => refresh(),
    async ready(rows = [item]) {
      reads.at(-1).resolve({ data: rows });
      await flush();
      return render();
    },
    dispose() {
      for (const cleanup of cleanups.values()) cleanup?.();
    },
  };
}

test("global viewer validates published shared link then follows Back/Forward while preserving tour context", async () => {
  const h = overlay(
    "https://guide.test/?point=point-1&panorama=pano-1&experience=tour-1",
  );
  assert.equal(
    h.render().props.item,
    undefined,
    "no iframe resource until a published read",
  );
  await h.ready([item, { ...item, id: "foreign", point_id: "other-point" }]);
  assert.equal(h.render().props.item.id, "pano-1");
  h.change("https://guide.test/?point=point-1&experience=tour-1", "popstate");
  assert.equal(h.render(), null);
  h.change(
    "https://guide.test/?point=point-1&panorama=pano-1&experience=tour-1",
    "popstate",
  );
  h.render();
  await h.ready();
  h.render().props.onClose();
  assert.equal(
    h.history.at(-1).mode,
    "replace",
    "shared link close never goes back to another website",
  );
  const url = new URL(h.browser.location.href);
  assert.equal(url.searchParams.get("point"), "point-1");
  assert.equal(url.searchParams.get("experience"), "tour-1");
  assert.equal(h.render(), null);
  h.dispose();
});

test("publication retirement, failure and point change remove stale iframe resources", async () => {
  const h = overlay();
  await h.ready();
  h.refresh();
  await h.ready([]);
  assert.equal(h.render().props.item, undefined);
  assert.match(h.render().props.notice, /已下架/);
  h.refresh();
  h.reads.at(-1).reject(new Error("offline"));
  await flush();
  assert.equal(h.render().props.item, undefined);
  assert.match(h.render().props.notice, /无法读取/);
  assert.equal(typeof h.render().props.onRetry, "function");
  h.change(
    "https://guide.test/?point=point-2&panorama=pano-2",
    navigation.LOCATION_CHANGE_EVENT,
  );
  assert.equal(h.render().props.item, undefined);
  const latest = h.reads.at(-1);
  assert.equal(latest.pointId, "point-2");
  h.dispose();
  assert.equal(latest.signal.aborted, true);
});

test("crafted foreign resource never opens, and superseded late reads cannot undo a new selection", async () => {
  const h = overlay("https://guide.test/?point=point-1&panorama=foreign");
  await h.ready([item, { ...item, id: "foreign", point_id: "other-point" }]);
  assert.equal(h.render().props.item, undefined);
  h.refresh();
  const old = h.reads.at(-1);
  h.change(
    "https://guide.test/?point=point-2&panorama=pano-2",
    navigation.LOCATION_CHANGE_EVENT,
  );
  h.render();
  await h.ready([{ ...item, point_id: "point-2", id: "pano-2" }]);
  old.resolve({ data: [item] });
  await flush();
  assert.equal(h.render().props.item.id, "pano-2");
  h.dispose();
});

function viewer(row) {
  const exports = {};
  vm.runInNewContext(compile("PanoramaViewer"), {
    exports,
    document: { body: {} },
    window: { setTimeout: () => 1, clearTimeout() {} },
    require(name) {
      if (name === "react")
        return {
          useRef: () => ({ current: null }),
          useState: (initial) => [initial, () => {}],
          useEffect() {},
        };
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react-dom") return { createPortal: (element) => element };
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name === "./panorama") return helpers;
      if (name.endsWith(".css")) return {};
      throw new Error(name);
    },
  });
  return exports.PanoramaViewer({ item: row, onClose() {} });
}

test("trusted viewer uses a nonmodal sandboxed iframe and always offers explicit original website", () => {
  const tree = viewer(item);
  assert.equal(tree.props["aria-modal"], "false");
  const frame = find(tree, (node) => node.type === "iframe")[0];
  assert.equal(frame.props.src, official);
  assert.equal(frame.props.allow, "fullscreen");
  assert.doesNotMatch(frame.props.sandbox, /allow-popups|allow-top-navigation/);
  assert.equal(frame.props.referrerPolicy, "no-referrer");
  const link = find(tree, (node) => node.type === "a")[0];
  assert.equal(link.props.href, official);
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.match(words(tree), /返回地图/);
});

test("unconfigured source gets explicit fallback, invalid links never become iframe or clickable script", () => {
  const external = viewer({ ...item, url: "https://another.example/vr" });
  assert.equal(find(external, (node) => node.type === "iframe").length, 0);
  assert.equal(
    find(external, (node) => node.type === "a")[0].props.href,
    "https://another.example/vr",
  );
  const invalid = viewer({ ...item, url: "javascript:alert(1)" });
  assert.equal(find(invalid, (node) => node.type === "iframe").length, 0);
  assert.equal(find(invalid, (node) => node.type === "a").length, 0);
});

function layoutHarness({
  width,
  height,
  headerBottom,
  dockBounds,
  wasInert = false,
}) {
  const effects = [],
    states = [],
    resizeObservers = [];
  let index = 0,
    restoredFocusInert;
  class Element {
    constructor(rect = {}) {
      this.rect = rect;
      this.inert = false;
      this.isConnected = true;
    }
    getBoundingClientRect() {
      return this.rect;
    }
    focus() {
      restoredFocusInert = stage.inert;
    }
  }
  const stage = new Element(),
    header = new Element({ bottom: headerBottom });
  stage.inert = wasInert;
  const dock = new Element(dockBounds),
    native = new Element(),
    trigger = new Element(),
    title = new Element();
  class Resize {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class Mutation {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const exports = {};
  vm.runInNewContext(compile("PanoramaViewer"), {
    exports,
    HTMLElement: Element,
    ResizeObserver: Resize,
    MutationObserver: Mutation,
    document: {
      body: {},
      activeElement: trigger,
      querySelectorAll: () => [stage],
      querySelector: (query) =>
        query === ".app-header"
          ? header
          : query === ".native-dock"
            ? native
            : dock,
    },
    window: {
      innerWidth: width,
      innerHeight: height,
      addEventListener() {},
      removeEventListener() {},
      setTimeout: () => 1,
      clearTimeout() {},
    },
    require(name) {
      if (name === "react")
        return {
          useRef: () => ({ current: title }),
          useState(initial) {
            const key = index++;
            states[key] = initial;
            return [
              initial,
              (value) => {
                states[key] =
                  typeof value === "function" ? value(states[key]) : value;
              },
            ];
          },
          useEffect: (effect) => effects.push(effect),
        };
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react-dom") return { createPortal: (element) => element };
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name === "./panorama") return helpers;
      if (name.endsWith(".css")) return {};
      throw new Error(name);
    },
  });
  exports.PanoramaViewer({ item, onClose() {} });
  const cleanups = effects.map((effect) => effect());
  return {
    states,
    stage,
    dock,
    header,
    resize: () => resizeObservers[0].callback(),
    get restoredFocusInert() {
      return restoredFocusInert;
    },
    dispose() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}

test("viewer reserves actual wrapped header and mobile voice dock instead of overlaying their controls", () => {
  const h = layoutHarness({
    width: 390,
    height: 800,
    headerBottom: 122,
    dockBounds: { left: 60, top: 545 },
  });
  assert.deepEqual({ ...h.states[2] }, { top: 130, right: 8, bottom: 265 });
  h.header.rect.bottom = 150;
  h.dock.rect.top = 510;
  h.resize();
  assert.deepEqual({ ...h.states[2] }, { top: 158, right: 8, bottom: 300 });
  h.dispose();
});

test("desktop and short landscape keep VR and microphone beside each other", () => {
  const desktop = layoutHarness({
    width: 1280,
    height: 800,
    headerBottom: 74,
    dockBounds: { left: 912, top: 420 },
  });
  assert.deepEqual(
    { ...desktop.states[2] },
    { top: 82, right: 380, bottom: 12 },
  );
  desktop.dispose();
  const landscape = layoutHarness({
    width: 740,
    height: 430,
    headerBottom: 110,
    dockBounds: { left: 410, top: 136 },
  });
  assert.deepEqual(
    { ...landscape.states[2] },
    { top: 118, right: 342, bottom: 12 },
  );
  landscape.dispose();
});

test("covered map becomes inert while assistant stays usable; close restores previous state before focus", () => {
  const h = layoutHarness({
    width: 1280,
    height: 800,
    headerBottom: 74,
    dockBounds: { left: 912, top: 420 },
  });
  assert.equal(h.stage.inert, true);
  assert.equal(h.dock.inert, false);
  h.dispose();
  assert.equal(h.stage.inert, false);
  assert.equal(h.restoredFocusInert, false);
  const existing = layoutHarness({
    width: 1280,
    height: 800,
    headerBottom: 74,
    dockBounds: { left: 912, top: 420 },
    wasInert: true,
  });
  existing.dispose();
  assert.equal(existing.stage.inert, true);
});
