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

test("external VR destinations preserve the scene hash and reject unsafe schemes or credentials", () => {
  assert.equal(helpers.externalPanoramaUrl(official), official);
  assert.equal(
    helpers.externalPanoramaUrl("https://another.example/vr#scene-7"),
    "https://another.example/vr#scene-7",
  );
  for (const url of [
    "https://user:secret@stjgpt.nankai.edu.cn/index-jn.php",
    "http://stjgpt.nankai.edu.cn/index-jn.php",
    "javascript:alert(1)",
    "data:text/html,test",
    "/local",
    "//another.example/vr",
  ])
    assert.equal(helpers.externalPanoramaUrl(url), null, url);
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
// not original-site rendering or native browser focus behavior.
function overlay(
  initial = "https://guide.test/?point=point-1&panorama=pano-1",
  component = "PanoramaOverlay",
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
  vm.runInNewContext(compile(component), {
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
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name.endsWith(".css")) return {};
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
    const tree = exports[component](
      component === "PanoramaPanel" ? { pointId: "point-1" } : undefined,
    );
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
    "no original-site destination until a published read",
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

test("publication retirement, failure and point change remove stale original-site resources", async () => {
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

test("legacy VR links offer the original website for official and external sources without an iframe", () => {
  for (const url of [official, "https://another.example/vr#scene-7"]) {
    const tree = viewer({ ...item, url });
    assert.equal(find(tree, (node) => node.type === "iframe").length, 0);
    const link = find(tree, (node) => node.type === "a")[0];
    assert.equal(link.props.href, url);
    assert.equal(link.props.target, "_blank");
    assert.equal(link.props.rel, "noopener noreferrer");
    assert.match(words(tree), /原网站/);
    assert.match(words(tree), /返回地图/);
    assert.doesNotMatch(words(tree), /正在连接学校全景|重新载入/);
  }
});

test("invalid legacy destinations never become clickable links or frames", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://another.example/vr",
    "https://user:secret@another.example/vr",
  ]) {
    const tree = viewer({ ...item, url });
    assert.equal(find(tree, (node) => node.type === "iframe").length, 0);
    assert.equal(find(tree, (node) => node.type === "a").length, 0);
  }
});

test("primary panorama cards link directly to the original scene without rewriting the tour URL", async () => {
  const original = "https://guide.test/?point=point-1&experience=tour-1";
  const h = overlay(original, "PanoramaPanel");
  const tree = await h.ready([item]);
  const link = find(tree, (node) => node.type === "a")[0];
  assert.equal(link.props.href, official);
  assert.equal(link.props.target, "_blank");
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.match(words(link), /原网站/);
  assert.equal(
    link.props.onClick,
    undefined,
    "native navigation must not be intercepted into an internal viewer",
  );
  assert.equal(find(tree, (node) => node.type === "iframe").length, 0);
  assert.equal(
    find(tree, (node) => node.props?.["aria-haspopup"] === "dialog").length,
    0,
  );
  assert.equal(h.browser.location.href, original);
  assert.equal(h.history.length, 0);
  h.dispose();
});

test("primary panorama cards never expose invalid destination anchors", async () => {
  const h = overlay("https://guide.test/?point=point-1", "PanoramaPanel");
  const tree = await h.ready([
    { ...item, url: "javascript:alert(1)" },
    {
      ...item,
      id: "credentials",
      url: "https://user:secret@another.example/vr",
    },
  ]);
  assert.equal(find(tree, (node) => node.type === "a").length, 0);
  assert.equal(find(tree, (node) => node.type === "iframe").length, 0);
  h.dispose();
});

function focusHarness({ wasInert = false, triggerConnected = true } = {}) {
  const effects = [];
  let restoredFocusInert,
    focusedTitle = false,
    restored = false;
  class Element {
    constructor() {
      this.inert = false;
      this.isConnected = true;
    }
    focus() {
      if (this === title) focusedTitle = true;
      if (this === trigger) {
        restored = true;
        restoredFocusInert = stage.inert;
      }
    }
  }
  const stage = new Element(),
    dock = new Element(),
    trigger = new Element(),
    title = new Element();
  stage.inert = wasInert;
  trigger.isConnected = triggerConnected;
  const exports = {};
  vm.runInNewContext(compile("PanoramaViewer"), {
    exports,
    HTMLElement: Element,
    document: {
      body: {},
      activeElement: trigger,
      querySelectorAll: () => [stage],
    },
    require(name) {
      if (name === "react")
        return {
          useRef: () => ({ current: title }),
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
  let closes = 0;
  const tree = exports.PanoramaViewer({
    item,
    onClose() {
      closes++;
    },
  });
  const cleanups = effects.map((effect) => effect());
  return {
    stage,
    dock,
    tree,
    get focusedTitle() {
      return focusedTitle;
    },
    get restored() {
      return restored;
    },
    get restoredFocusInert() {
      return restoredFocusInert;
    },
    get closes() {
      return closes;
    },
    dispose() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}

test("legacy link dialog focuses its heading and restores covered map state before trigger focus", () => {
  const h = focusHarness();
  assert.equal(h.focusedTitle, true);
  assert.equal(h.stage.inert, true);
  assert.equal(h.dock.inert, false);
  let stopped = false;
  h.tree.props.onKeyDown({
    key: "Escape",
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  assert.equal(h.closes, 1);
  h.dispose();
  assert.equal(h.stage.inert, false);
  assert.equal(h.restoredFocusInert, false);
  const existing = focusHarness({ wasInert: true });
  existing.dispose();
  assert.equal(existing.stage.inert, true);
  const removed = focusHarness({ triggerConnected: false });
  removed.dispose();
  assert.equal(removed.restored, false);
});
