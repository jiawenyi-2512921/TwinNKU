import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { withRequestDeadline } from "../src/shared/requestDeadline.ts";

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
const panoramaCode = compile("../src/features/points/panorama.ts");
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
const panoramaId = "55555555-5555-4555-8555-555555555555";
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
  "PanoramaDirectory",
  "PanoramaOverlay",
];
const components = Object.fromEntries(
  componentNames.map((name) => [name, () => null]),
);

// Controlled hooks execute the actual root component and event/effect wiring.
// These checks do not assert browser layout, media playback, or microphone support.
function app(initialHref, options = {}) {
  let href = initialHref;
  const catalogWatchers = new Set();
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
  class Element {
    constructor(tagName = "DIV") {
      this.tagName = tagName;
    }
    isContentEditable = false;
    closest(selector) {
      return selector === ".agent-panel" ? this : null;
    }
  }
  const base = {
    window: browser,
    URL,
    URLSearchParams,
    Event,
    PopStateEvent: Event,
    AbortController,
    Date,
    document: { querySelector: () => null },
    HTMLElement: Element,
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
    native = module(nativeCode, (name) => {
      assert.equal(name, "../../shared/requestDeadline.ts");
      return { withRequestDeadline };
    }),
    labels = module(labelsCode),
    panorama = module(panoramaCode);
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
    if (name.endsWith("/panorama")) return panorama;
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
      return {
        api: {},
        get: async () => ({ data: options.experiences ?? [] }),
      };
    if (name.endsWith("/catalog"))
      return {
        reconcileCatalog: (_, next) => next,
        availableSelection: (c, id) =>
          c.points.some((p) => p.id === id) ? id : null,
        loadCatalog: () => options.catalog ?? catalog,
      };
    if (name.endsWith("/catalogSync"))
      return {
        watchCatalogChanges: (callback) => {
          catalogWatchers.add(callback);
          return () => catalogWatchers.delete(callback);
        },
        createCatalogRefresh: ({ apply }) => ({
          refresh: () => apply(options.catalog ?? catalog),
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
    refreshCatalogs() {
      catalogWatchers.forEach((callback) => callback());
    },
    escapeFromDock() {
      const event = new Event("keydown", { cancelable: true });
      const input = new Element("TEXTAREA");
      Object.defineProperties(event, {
        key: { value: "Escape" },
        target: { value: input },
      });
      browser.dispatchEvent(event);
      return event;
    },
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
const video = {
  id: experienceId,
  revision: 3,
  campus_id: "nku-jinnan",
  media_url: `/api/v1/experiences/${experienceId}/media`,
  content: {
    kind: "media",
    point_id: pointA,
    media_type: "video",
    title: "测试视频",
    upload_id: "upload",
  },
};
const videoAction = {
  type: "play_video",
  point_id: pointA,
  point_revision: 1,
  resource_id: experienceId,
  resource_revision: 3,
};

test("VR directory locates only current map geometry and selects the real point without changing labels", () => {
  const options = {
    catalog: {
      ...catalog,
      features: {
        map_id: "map",
        map_revision: 3,
        points: [
          { point_id: pointA, map_id: "map", map_revision: 2 },
          { point_id: pointB, map_id: "map", map_revision: 3 },
          { point_id: "unpublished-point", map_id: "map", map_revision: 3 },
        ],
      },
    },
  };
  const testApp = app(
    baseHref.replace("#map", `&experience=${experienceId}#map`),
    options,
  );
  let tree = testApp.render();
  const browse = () =>
    walk(
      tree,
      (n) => n.type === "button" && n.props.className === "browse-button",
    )[0];
  browse().props.onClick();
  tree = testApp.render();
  testApp.node("PlaceDirectory").props.onMode("vr");
  tree = testApp.render();
  const directory = testApp.node("PlaceDirectory");
  assert.equal(directory.props.mode, "vr");
  const vr = directory.props.panoramas;
  assert.equal(vr.type, components.PanoramaDirectory);
  assert.equal(vr.props.campus.id, "nku-jinnan");
  assert.deepEqual([...vr.props.locatedPointIds], [pointB]);
  assert.equal(
    walk(tree, (n) => n.type === "input")[0].props.placeholder,
    "搜索景点或场景编号",
  );
  vr.props.onLocate(pointA);
  testApp.render();
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.get("point"),
    pointA,
  );
  vr.props.onLocate(pointB);
  tree = testApp.render();
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("PointDetails").props.point.id, pointB);
  assert.equal(testApp.node("PlaceDirectory"), undefined);
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("experience"),
    false,
  );
  assert.equal(testApp.node("MapCanvas").props.points[1].name, points[1].name);
  browse().props.onClick();
  testApp.render();
  options.catalog = {
    ...options.catalog,
    features: { ...options.catalog.features, map_revision: 2 },
  };
  testApp.refreshCatalogs();
  testApp.render();
  assert.equal(
    testApp.node("PlaceDirectory").props.panoramas.props.locatedPointIds.length,
    0,
  );
  testApp.dispose();
});

test("only a resolved explicit video action creates a cancellable playback request; URLs and browsing do not", async () => {
  const testApp = app(
    baseHref.replace("#map", `&experience=${experienceId}&play=1#map`),
    { experiences: [video] },
  );
  testApp.render();
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  assert.equal(testApp.node("ExperiencePanel").props.playbackRequest, null);
  const apply = (...args) =>
    testApp.node("NativeAgentDock").props.onAction(...args);
  assert.equal(apply(videoAction), true);
  testApp.render();
  assert.equal(testApp.node("ExperiencePanel").props.playbackRequest, null);
  assert.equal(apply(videoAction, { requestedPlayback: true }), true);
  testApp.render();
  const first = testApp.node("ExperiencePanel").props.playbackRequest;
  assert.equal(first.resourceId, experienceId);
  assert.equal(first.revision, 3);
  assert.equal(first.signal.aborted, false);
  apply(videoAction, { requestedPlayback: true });
  testApp.render();
  const second = testApp.node("ExperiencePanel").props.playbackRequest;
  assert.ok(second.id > first.id);
  assert.equal(first.signal.aborted, true);
  testApp.node("NativeAgentDock").props.onCancelAction();
  testApp.render();
  assert.equal(second.signal.aborted, true);
  assert.equal(testApp.node("ExperiencePanel").props.playbackRequest, null);
  testApp.dispose();
});

test("outdated video actions are rejected and a changed public revision cancels pending playback", async () => {
  const options = { experiences: [video] };
  const testApp = app(baseHref, options);
  testApp.render();
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  assert.equal(
    testApp
      .node("NativeAgentDock")
      .props.onAction(
        { ...videoAction, resource_revision: 2 },
        { requestedPlayback: true },
      ),
    false,
  );
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(
    testApp
      .node("NativeAgentDock")
      .props.onAction(videoAction, { requestedPlayback: true }),
    true,
  );
  testApp.render();
  const pending = testApp.node("ExperiencePanel").props.playbackRequest;
  const previousRenderAction = testApp.node("NativeAgentDock").props.onAction;
  options.experiences = [{ ...video, revision: 4 }];
  testApp.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  assert.equal(pending.signal.aborted, true);
  assert.equal(testApp.node("ExperiencePanel").props.playbackRequest, null);
  assert.equal(
    previousRenderAction(videoAction, { requestedPlayback: true }),
    false,
    "a resolver started before refresh must use the latest public catalog",
  );
  testApp.dispose();
});

test("unrelated root renders keep the empty route identity stable for the map", () => {
  const testApp = app(baseHref);
  testApp.render();
  const segments = testApp.node("MapCanvas").props.routeSegments;
  assert.equal(segments.length, 0);
  // Opening a help panel should not recreate route layers or recenter a map.
  const help = walk(
    testApp.render(),
    (node) =>
      node.type === "button" && node.props["aria-label"] === "使用帮助与刷新",
  )[0];
  assert.ok(help);
  help.props.onClick();
  testApp.render();
  assert.equal(testApp.node("MapCanvas").props.routeSegments, segments);
  testApp.dispose();
});

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

function openTour(testApp) {
  testApp.node("NativeAgentDock").props.onAction({
    type: "show_tour",
    point_id: pointA,
    point_revision: 1,
    resource_id: experienceId,
  });
  testApp.render();
}
function openVR(testApp, point = pointB) {
  testApp.node("NativeAgentDock").props.onAction({
    type: "open_vr",
    point_id: point,
    point_revision: 1,
    resource_id: panoramaId,
  });
  testApp.render();
}

test("VR action keeps a campus tour mounted and pauses its media while updating point context", () => {
  const testApp = app(baseHref);
  testApp.render();
  openTour(testApp);
  const tour = testApp.node("ExperiencePanel");
  const dock = testApp.node("NativeAgentDock");
  assert.equal(tour.props.active, true);
  assert.equal(tour.props.initialKind, "tour");
  assert.equal(tour.props.pointId, undefined); // The route belongs to the campus.
  openVR(testApp);
  const retained = testApp.node("ExperiencePanel");
  assert.equal(retained.type, tour.type);
  assert.equal(retained.key, tour.key);
  assert.equal(retained.props.initialExperienceId, experienceId);
  assert.equal(retained.props.active, false);
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointB);
  assert.ok(
    testApp.node("NativeAgentDock").props.current.revision >
      dock.props.current.revision,
  );
  const params = new URL(testApp.browser.location.href).searchParams;
  assert.equal(params.get("panorama"), panoramaId);
  assert.equal(params.get("experience"), experienceId);
  assert.equal(params.get("channel"), "official");
  testApp.dispose();
});

test("Escape from the dock textarea closes only VR and restores the same tour", () => {
  const testApp = app(baseHref);
  testApp.render();
  openTour(testApp);
  openVR(testApp);
  const tour = testApp.node("ExperiencePanel");
  const event = testApp.escapeFromDock();
  testApp.render();
  assert.equal(event.defaultPrevented, true);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("panorama"),
    false,
  );
  assert.equal(testApp.node("ExperiencePanel").type, tour.type);
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointB);
  testApp.dispose();
});

test("VR navigation preserves the active route and tour across Back and Forward", () => {
  const testApp = app(baseHref);
  testApp.render();
  openTour(testApp);
  testApp.node("ExperiencePanel").props.onNavigateStop(pointA, pointB);
  testApp.render();
  const route = {
    start_point_id: pointA,
    end_point_id: pointB,
    segments: [
      {
        map_id: "map",
        map_revision: 3,
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
    ],
  };
  testApp.node("NavigationPanel").props.onRoute(route);
  testApp.node("NavigationPanel").props.onSelectionChange({
    start: pointA,
    end: pointB,
    availablePointIds: [pointA, pointB],
  });
  testApp.node("NavigationPanel").props.onPickMode("start");
  testApp.render();
  const navigation = testApp.node("NavigationPanel"),
    tour = testApp.node("ExperiencePanel");
  openVR(testApp);
  assert.equal(
    testApp.node("NavigationPanel").props.initial,
    navigation.props.initial,
  );
  assert.equal(testApp.node("MapCanvas").props.routeSegments, route.segments);
  assert.equal(
    testApp.node("NativeAgentDock").props.current.start_point_id,
    pointA,
  );
  assert.equal(testApp.node("ExperiencePanel").props.active, false);
  testApp.browser.history.back();
  testApp.render();
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("panorama"),
    false,
  );
  assert.equal(
    testApp.node("NavigationPanel").props.initial,
    navigation.props.initial,
  );
  assert.equal(testApp.node("MapCanvas").props.routeSegments, route.segments);
  assert.equal(testApp.node("MapCanvas").props.routePickMode, "start");
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointA);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointA);
  assert.equal(testApp.node("ExperiencePanel").type, tour.type);
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  testApp.browser.history.forward();
  testApp.render();
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.get("panorama"),
    panoramaId,
  );
  assert.equal(
    testApp.node("NavigationPanel").props.initial,
    navigation.props.initial,
  );
  assert.equal(testApp.node("MapCanvas").props.routeSegments, route.segments);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointB);
  const event = testApp.escapeFromDock();
  testApp.render();
  assert.equal(event.defaultPrevented, true);
  assert.equal(
    testApp.node("NavigationPanel").props.initial,
    navigation.props.initial,
  );
  assert.equal(testApp.node("MapCanvas").props.routePickMode, "start");
  testApp.node("NavigationPanel").props.onClose();
  testApp.render();
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    experienceId,
  );
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  testApp.dispose();
});
