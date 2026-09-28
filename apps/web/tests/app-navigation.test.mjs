import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const appCode = compile("../src/app/App.tsx");
const navCode = compile("../src/shared/navigation.ts");
const nativeCode = compile("../src/features/agent/native.ts");
const labelsCode = compile("../src/features/map/labelCorrections.ts");
const walk = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((node) => walk(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...walk(tree.props?.children, predicate),
  ];
};
const pointA = "11111111-1111-4111-8111-111111111111";
const pointB = "22222222-2222-4222-8222-222222222222";
const experienceId = "33333333-3333-4333-8333-333333333333";
const floorId = "44444444-4444-4444-8444-444444444444";
const collegeId = "b041e7c6-3481-51c1-b06f-9a33197ea0db";
const points = [
  {
    id: pointA,
    name: "测试甲楼",
    summary: "测试介绍",
    revision: 1,
    category: "academic",
  },
  {
    id: pointB,
    name: "测试乙楼",
    summary: "测试介绍",
    revision: 1,
    category: "academic",
  },
  {
    id: collegeId,
    name: "新闻与传媒学院",
    summary: "新闻与传媒学院：测试内容",
    revision: 2,
    category: "academic",
  },
];
const catalog = {
  campus: { id: "nku-jinnan", name: "测试校区" },
  map: { id: "map", revision: 3 },
  points,
  features: { points: [] },
};
const componentNames = [
  "MapCanvas",
  "PointDetails",
  "ExperiencePanel",
  "NativeAgentDock",
  "NavigationPanel",
  "AgentDock",
  "PlaceDirectory",
];
const components = Object.fromEntries(
  componentNames.map((name) => [name, () => null]),
);

// Controlled hooks execute the actual root component and event/effect wiring.
// These checks do not assert browser layout, media playback, or microphone support.
function app(initialHref) {
  let href = initialHref;
  const events = new EventTarget();
  const entries = [{ href, state: null }];
  let position = 0;
  const browser = {
    location: {
      get href() {
        return href;
      },
      get search() {
        return new URL(href).search;
      },
    },
    history: {
      get state() {
        return entries[position].state;
      },
      pushState(state, _, next) {
        entries.splice(++position);
        entries.push({ href: next, state });
        href = next;
      },
      replaceState(state, _, next) {
        entries[position] = { href: next, state };
        href = next;
      },
      back() {
        if (position) href = entries[--position].href;
        events.dispatchEvent(new Event("popstate"));
      },
      forward() {
        if (position < entries.length - 1) href = entries[++position].href;
        events.dispatchEvent(new Event("popstate"));
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const base = {
    window: browser,
    URL,
    URLSearchParams,
    Event,
    PopStateEvent: Event,
    AbortController,
    Date,
    document: { querySelector: () => null },
    HTMLElement: class {},
  };
  function module(
    code,
    require = () => {
      throw new Error("unexpected require");
    },
  ) {
    const exports = {};
    vm.runInNewContext(code, { ...base, exports, require });
    return exports;
  }
  const nav = module(navCode),
    native = module(nativeCode),
    labels = module(labelsCode);
  const slots = [],
    effects = [];
  let index = 0,
    dirty = false,
    queued = [];
  const react = {
    useState(initial) {
      const key = index++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (next) => {
          const value = typeof next === "function" ? next(slots[key]) : next;
          if (!Object.is(slots[key], value)) {
            slots[key] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useMemo(make, deps) {
      const key = index++;
      const old = slots[key];
      if (!old || deps.some((d, i) => !Object.is(d, old.deps[i])))
        slots[key] = { value: make(), deps };
      return slots[key].value;
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps);
    },
    useEffect(effect, deps) {
      const key = index++,
        old = effects[key];
      if (!old || !deps || deps.some((d, i) => !Object.is(d, old.deps[i])))
        queued.push(() => {
          old?.cleanup?.();
          effects[key] = { deps, cleanup: effect() };
        });
    },
  };
  const memory = {
    places: { favorites: [], recent: [] },
    dispatch: () => "ok",
  };
  const entry = module(appCode, (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsx;
    if (name.endsWith("/navigation")) return nav;
    if (name.endsWith("/native")) return native;
    if (name.endsWith("/labelCorrections")) return labels;
    if (name.endsWith("/protocol"))
      return { EMPTY_CONTEXT: {}, safeContext: (c) => c };
    if (name.endsWith("/useAgentConfig"))
      return {
        useAgentConfig: () => ({
          enabled: true,
          provider: "nk-genios-api",
          auto_actions: true,
        }),
      };
    if (name.endsWith("/usePlaceMemory"))
      return { usePlaceMemory: () => memory };
    if (name.endsWith("/search")) return { findPlaces: (p) => p };
    if (name.endsWith("/client"))
      return { api: {}, get: async () => ({ data: [] }) };
    if (name.endsWith("/catalog"))
      return {
        reconcileCatalog: (_, next) => next,
        availableSelection: (c, id) =>
          c.points.some((p) => p.id === id) ? id : null,
        loadCatalog: () => catalog,
      };
    if (name.endsWith("/catalogSync"))
      return {
        watchCatalogChanges: () => () => {},
        createCatalogRefresh: ({ apply }) => ({
          refresh: () => apply(catalog),
          dispose() {},
        }),
      };
    if (name.endsWith("/Icon")) return { Icon: () => null };
    for (const [key, value] of Object.entries(components))
      if (name.endsWith("/" + key)) return { [key]: value };
    throw new Error(name);
  });
  let tree;
  return {
    browser,
    nav,
    render() {
      let count = 0;
      do {
        assert.ok(++count < 25, "root effects settle");
        index = 0;
        dirty = false;
        queued = [];
        tree = entry.App();
        queued.forEach((fn) => fn());
      } while (dirty);
      return tree;
    },
    node(name) {
      return walk(tree, (node) => node.type === components[name])[0];
    },
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}
const baseHref = `https://guide.example/?point=${pointA}&channel=official#map`;

test("experience deep link restores, tour navigation hides without unmounting and close returns", () => {
  const testApp = app(
    baseHref.replace("#map", `&experience=${experienceId}#map`),
  );
  testApp.render();
  const panel = testApp.node("ExperiencePanel");
  assert.equal(panel.props.initialExperienceId, experienceId);
  assert.equal(panel.props.active, true);
  const dockType = testApp.node("NativeAgentDock").type;
  panel.props.onNavigateStop(pointA, pointB);
  testApp.render();
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  assert.equal(testApp.node("ExperiencePanel").props.active, false);
  assert.equal(testApp.node("NativeAgentDock").type, dockType);
  testApp.node("NavigationPanel").props.onClose();
  testApp.render();
  assert.equal(testApp.node("NavigationPanel"), undefined);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  testApp.node("ExperiencePanel").props.onClose();
  testApp.render();
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("experience"),
    false,
  );
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.get("channel"),
    "official",
  );
  testApp.dispose();
});

test("experience action writes shareable URL and ordinary exploration clears it", () => {
  const testApp = app(baseHref);
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction({
    type: "show_tour",
    point_id: pointA,
    point_revision: 1,
    resource_id: experienceId,
  });
  testApp.render();
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.get("experience"),
    experienceId,
  );
  testApp.node("ExperiencePanel").props.onSelectPoint(pointB);
  testApp.render();
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.get("experience"),
    experienceId,
  );
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  testApp.node("MapCanvas").props.onSelect(pointA);
  testApp.render();
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("experience"),
    false,
  );
  testApp.browser.history.back();
  testApp.render();
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  testApp.dispose();
});

test("browser Back and Forward restore experience and clear obsolete route/pick state", () => {
  const testApp = app(baseHref);
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction({
    type: "show_checkin",
    point_id: pointA,
    point_revision: 1,
    resource_id: experienceId,
  });
  testApp.render();
  testApp.node("ExperiencePanel").props.onNavigateStop(pointA, pointB);
  testApp.render();
  testApp.node("NavigationPanel").props.onPickMode("start");
  testApp.render();
  testApp.browser.history.back();
  testApp.render();
  assert.equal(testApp.node("NavigationPanel"), undefined);
  assert.equal(testApp.node("MapCanvas").props.routePickMode, null);
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  testApp.browser.history.forward();
  testApp.render();
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  testApp.dispose();
});

test("floor view context follows URL replace/close rather than last ask payload", () => {
  const testApp = app(baseHref);
  testApp.render();
  testApp.node("PointDetails").props.onAsk({
    floor_id: floorId,
    floor_label: "二楼",
    floor_section: "a",
  });
  testApp.render();
  assert.equal(testApp.node("NativeAgentDock").props.current.floor_id, null);
  testApp.nav.writeLocation(
    testApp.nav.floorLocation(
      testApp.browser.location.href,
      pointA,
      floorId,
      "a",
    ),
    "replace",
  );
  testApp.render();
  assert.equal(testApp.node("NativeAgentDock").props.current.floor_id, floorId);
  testApp.nav.closeFloorLocation(pointA);
  testApp.render();
  assert.equal(testApp.node("NativeAgentDock").props.current.floor_id, null);
  testApp.dispose();
});

test("corrected college name and summary are projected without mutating catalog", () => {
  const testApp = app(baseHref);
  testApp.render();
  const displayed = testApp
    .node("MapCanvas")
    .props.points.find((point) => point.id === collegeId);
  assert.equal(displayed.name, "信息与传媒学院");
  assert.equal(displayed.summary, "信息与传媒学院：测试内容");
  assert.equal(displayed.revision, 2);
  assert.equal(
    points.find((point) => point.id === collegeId).name,
    "新闻与传媒学院",
  );
  testApp.dispose();
});
