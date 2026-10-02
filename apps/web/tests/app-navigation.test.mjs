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
  "TourResourceView",
  "Welcome",
  "ShareVisit",
  "TourNarrator",
];
const components = Object.fromEntries(
  componentNames.map((name) => [name, () => null]),
);

// Controlled hooks execute the actual root component and event/effect wiring.
// These checks do not assert browser layout, media playback, or microphone support.
function app(initialHref, options = {}) {
  let href = initialHref;
  const storage = new Map(options.storage ?? []);
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
    CustomEvent: class extends Event {
      constructor(type, options = {}) {
        super(type);
        this.detail = options.detail;
      }
    },
    PopStateEvent: Event,
    AbortController,
    Date,
    document: { querySelector: () => null },
    HTMLElement: Element,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
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
  const visit = module(compile("../src/features/visit/session.ts"));
  const audio = module(compile("../src/features/visit/audioOwner.ts"));
  const segments = module(compile("../src/features/experiences/segments.ts"));
  const resources = module(
    compile("../src/features/visit/resourceLocation.ts"),
    (name) => {
      assert.equal(name, "../experiences/segments");
      return segments;
    },
  );
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
    if (name.endsWith("/session")) return visit;
    if (name.endsWith("/audioOwner")) return audio;
    if (name.endsWith("/segments")) return segments;
    if (name.endsWith("/resourceLocation")) return resources;
    if (name.endsWith("/ExperiencePanel"))
      return {
        ExperiencePanel: components.ExperiencePanel,
        TourResourceView: components.TourResourceView,
      };
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
        get: async (path, signal) =>
          options.get
            ? options.get(path, signal)
            : { data: options.experiences ?? [] },
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
    storage,
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
const tourId = "66666666-6666-4666-8666-666666666666";
const videoB = {
  ...video,
  id: "77777777-7777-4777-8777-777777777777",
  content: { ...video.content, point_id: pointB },
};
const publishedTour = {
  id: tourId,
  revision: 4,
  campus_id: "nku-jinnan",
  media_url: null,
  content: {
    kind: "tour",
    title: "真实编排测试路线",
    description: "测试夹具",
    source_note: "测试来源",
    stops: [
      {
        point_id: pointA,
        narrative: "",
        prompt_timing: "manual",
        segments: [
          {
            id: "opening",
            text: "开场",
            source_note: "来源",
            main_view: { type: "map" },
            resources: [],
          },
        ],
      },
      {
        point_id: pointB,
        narrative: "",
        prompt_timing: "manual",
        segments: [
          {
            id: "detail",
            text: "第二站讲解",
            source_note: "来源",
            main_view: { type: "map" },
            resources: [
              { type: "video", id: videoB.id, revision: videoB.revision },
            ],
          },
        ],
      },
    ],
  },
};
const nodeText = (node) =>
  Array.isArray(node)
    ? node.map(nodeText).join("")
    : node && typeof node === "object"
      ? nodeText(node.props?.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";
const clickButton = (tree, label) =>
  walk(tree, (node) => node.type === "button" && nodeText(node) === label)[0];
async function loadPublishedTour(options = {}) {
  const settings = { experiences: [publishedTour, video, videoB], ...options };
  const testApp = app(
    `https://guide.example/?point=${pointB}&experience=${tourId}&revision=4&stop=1&segment=detail&mode=onsite`,
    settings,
  );
  testApp.render();
  await new Promise((resolve) => setImmediate(resolve));
  const tree = testApp.render();
  clickButton(tree, "继续参观").props.onClick();
  testApp.render();
  return { testApp, settings };
}

test("online mode omits walking controls and only an explicit valid onsite mode enables them", () => {
  for (const mode of ["online", "unknown", "onsite"]) {
    const testApp = app(
      baseHref.replace("#map", `&experience=${experienceId}&mode=${mode}#map`),
    );
    testApp.render();
    assert.equal(
      typeof testApp.node("ExperiencePanel").props.onNavigateStop,
      mode === "onsite" ? "function" : "undefined",
    );
    testApp.dispose();
  }
});

test("a QR visit waits for published content and explicit handoff, preserving position without starting narration", async () => {
  const testApp = app(
    `https://guide.example/?experience=${tourId}&revision=4&stop=1&segment=detail&mode=onsite`,
    { experiences: [publishedTour] },
  );
  let tree = testApp.render();
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(clickButton(tree, "继续参观").props.disabled, true);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  await new Promise((resolve) => setImmediate(resolve));
  tree = testApp.render();
  assert.equal(clickButton(tree, "继续参观").props.disabled, false);
  clickButton(tree, "继续参观").props.onClick();
  testApp.render();
  const position = testApp.node("ExperiencePanel").props.position;
  assert.deepEqual(JSON.parse(JSON.stringify(position)), {
    revision: 4,
    stopIndex: 1,
    segmentId: "detail",
  });
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  assert.equal(
    testApp.node("NativeAgentDock").props.current.visit.segment_id,
    "detail",
  );
  testApp.dispose();
});

test("opening tour resources pauses narration while retaining its mounted component and route position", async () => {
  const { testApp } = await loadPublishedTour();
  const position = testApp.node("ExperiencePanel").props.position;
  const narration = {
    tourId,
    tourRevision: 4,
    stopIndex: 1,
    segmentId: "detail",
    text: "第二站讲解",
    sourceNote: "来源",
  };
  testApp.node("ExperiencePanel").props.onNarrate(narration);
  testApp.render();
  const narrator = testApp.node("TourNarrator");
  let pauses = 0;
  testApp.browser.addEventListener("twinnku:tour-pause", () => pauses++);
  testApp
    .node("ExperiencePanel")
    .props.onResourceOpen(
      { type: "video", id: videoB.id, revision: 3 },
      pointB,
    );
  let tree = testApp.render();
  assert.ok(pauses > 0);
  assert.equal(testApp.node("ExperiencePanel").props.active, false);
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    tourId,
  );
  assert.deepEqual(testApp.node("ExperiencePanel").props.position, position);
  assert.equal(testApp.node("TourNarrator").type, narrator.type);
  assert.equal(testApp.node("TourNarrator").key, narrator.key);
  assert.equal(testApp.node("TourNarrator").props.narration, narration);
  assert.equal(
    walk(tree, (node) => node.props?.className === "visit-controls")[0].props
      .hidden,
    true,
  );
  clickButton(tree, "← 返回本站讲解").props.onClick();
  tree = testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  assert.deepEqual(testApp.node("ExperiencePanel").props.position, position);
  assert.equal(testApp.node("TourNarrator").props.narration, narration);
  assert.equal(
    walk(tree, (node) => node.props?.className === "visit-controls")[0].props
      .hidden,
    false,
  );
  testApp.dispose();
});

test("a publication update clears old audio, drops stale revision position and requires another handoff", async () => {
  const { testApp, settings } = await loadPublishedTour();
  testApp.node("ExperiencePanel").props.onNarrate({
    tourId,
    tourRevision: 4,
    stopIndex: 1,
    segmentId: "detail",
    text: "旧版文本",
    sourceNote: "来源",
  });
  testApp.render();
  settings.experiences = [{ ...publishedTour, revision: 5 }, video];
  testApp.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = testApp.render();
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  const saved = JSON.parse(testApp.storage.get(`twinnku:visit:${tourId}`));
  assert.deepEqual(saved.position, {
    revision: 5,
    stopIndex: 0,
    segmentId: "opening",
  });
  assert.equal(saved.audio, undefined);
  assert.match(nodeText(tree), /路线内容已更新/);
  clickButton(tree, "继续参观").props.onClick();
  tree = testApp.render();
  assert.equal(testApp.node("ExperiencePanel").props.position.revision, 5);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  testApp.dispose();
});

test("AI video actions retain the tour and send only an explicit current request to its resource overlay", async () => {
  const { testApp } = await loadPublishedTour();
  const position = testApp.node("ExperiencePanel").props.position;
  assert.equal(
    testApp.node("NativeAgentDock").props.onAction(videoAction),
    true,
  );
  testApp.render();
  assert.equal(testApp.node("TourResourceView").props.playbackRequest, null);
  assert.equal(
    testApp
      .node("NativeAgentDock")
      .props.onAction(videoAction, { requestedPlayback: true }),
    true,
  );
  let tree = testApp.render();
  const request = testApp.node("TourResourceView").props.playbackRequest;
  assert.equal(request.resourceId, experienceId);
  assert.equal(request.revision, 3);
  assert.equal(request.signal.aborted, false);
  assert.equal(
    testApp.node("ExperiencePanel").props.initialExperienceId,
    tourId,
  );
  assert.deepEqual(testApp.node("ExperiencePanel").props.position, position);
  assert.equal(testApp.node("ExperiencePanel").props.active, false);
  assert.equal(
    testApp
      .node("NativeAgentDock")
      .props.onAction(
        { ...videoAction, resource_revision: 2 },
        { requestedPlayback: true },
      ),
    false,
  );
  clickButton(tree, "← 返回本站讲解").props.onClick();
  tree = testApp.render();
  assert.equal(request.signal.aborted, true);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  assert.deepEqual(testApp.node("ExperiencePanel").props.position, position);
  testApp.dispose();
});

test("a late narration bookmark cannot attach to a different segment or tour revision", async () => {
  const { testApp, settings } = await loadPublishedTour();
  testApp.node("ExperiencePanel").props.onNarrate({
    tourId,
    tourRevision: 4,
    stopIndex: 1,
    segmentId: "detail",
    text: "原讲解",
    sourceNote: "来源",
  });
  testApp.render();
  const oldBookmark = testApp.node("TourNarrator").props.onBookmark;
  oldBookmark({ chunkIndex: 2, time: 4.5 });
  testApp.render();
  assert.equal(testApp.node("ShareVisit").props.session.audio.time, 4.5);
  testApp.node("ExperiencePanel").props.onPositionChange({
    revision: 4,
    stopIndex: 0,
    segmentId: "opening",
  });
  testApp.render();
  oldBookmark({ chunkIndex: 9, time: 80 });
  testApp.render();
  assert.equal(testApp.node("ShareVisit").props.session.audio, undefined);
  settings.experiences = [{ ...publishedTour, revision: 5 }, video];
  testApp.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  oldBookmark({ chunkIndex: 9, time: 80 });
  testApp.render();
  assert.equal(testApp.node("ShareVisit").props.session.position.revision, 5);
  assert.equal(testApp.node("ShareVisit").props.session.audio, undefined);
  testApp.dispose();
});

const detailNarration = () => ({
  tourId,
  tourRevision: 4,
  stopIndex: 1,
  segmentId: "detail",
  text: "第二站讲解",
  sourceNote: "来源",
});

test("Back and Forward retain the same narrator and audio bookmark, restore the actual resource point, and never replay", async () => {
  const { testApp } = await loadPublishedTour();
  const source = detailNarration();
  let primes = 0,
    pauses = 0;
  testApp.browser.addEventListener("twinnku:tour-prime", () => primes++);
  testApp.browser.addEventListener("twinnku:tour-pause", () => pauses++);
  testApp.node("ExperiencePanel").props.onNarrate(source);
  testApp.render();
  const narrator = testApp.node("TourNarrator");
  narrator.props.onBookmark({ chunkIndex: 2, time: 7.25 });
  testApp.render();
  assert.equal(
    testApp
      .node("NativeAgentDock")
      .props.onAction(videoAction, { requestedPlayback: true }),
    true,
  );
  testApp.render();
  const request = testApp.node("TourResourceView").props.playbackRequest;
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointA);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointA);
  const params = new URL(testApp.browser.location.href).searchParams;
  assert.equal(params.get("resource"), "video");
  assert.equal(params.get("resource_id"), experienceId);
  assert.equal(params.get("resource_point"), pointA);
  assert.deepEqual(
    Object.keys(testApp.browser.history.state.twinnkuTourResourcePublic).sort(),
    ["pointId", "resource"],
  );
  testApp.browser.history.back();
  let tree = testApp.render();
  assert.equal(request.signal.aborted, true);
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("NativeAgentDock").props.current.point_id, pointB);
  assert.equal(clickButton(tree, "继续参观"), undefined);
  assert.equal(testApp.node("TourNarrator").type, narrator.type);
  assert.equal(testApp.node("TourNarrator").key, narrator.key);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  assert.equal(testApp.node("TourNarrator").props.initialBookmark.time, 7.25);
  testApp.browser.history.forward();
  tree = testApp.render();
  assert.equal(
    testApp.node("TourResourceView").props.resource.id,
    experienceId,
  );
  assert.equal(testApp.node("TourResourceView").props.playbackRequest, null);
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointA);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  assert.equal(testApp.node("ShareVisit").props.session.audio.time, 7.25);
  clickButton(tree, "← 返回本站讲解").props.onClick();
  testApp.render();
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  assert.equal(primes, 1);
  assert.ok(pauses >= 3);
  testApp.dispose();
});

test("ordinary route clicks require the current published segment resource and exact point and revision", async () => {
  const { testApp } = await loadPublishedTour();
  const before = testApp.browser.location.href;
  const source = detailNarration();
  testApp.node("ExperiencePanel").props.onNarrate(source);
  testApp.render();
  const open = testApp.node("ExperiencePanel").props.onResourceOpen;
  for (const [resource, point] of [
    [{ type: "video", id: experienceId, revision: 3 }, pointA],
    [{ type: "video", id: videoB.id, revision: 2 }, pointB],
    [{ type: "image", id: videoB.id, revision: 3 }, pointB],
    [{ type: "video", id: videoB.id, revision: 3 }, pointA],
    [{ type: "video", id: panoramaId, revision: 3 }, pointB],
  ]) {
    assert.equal(open(resource, point), false);
    testApp.render();
    assert.equal(testApp.browser.location.href, before);
    assert.equal(testApp.node("TourResourceView"), undefined);
    assert.equal(testApp.node("TourNarrator").props.narration, source);
  }
  assert.equal(
    open({ type: "video", id: videoB.id, revision: 3 }, pointB),
    true,
  );
  testApp.render();
  assert.equal(testApp.node("TourResourceView").props.resource.id, videoB.id);
  testApp.dispose();
});

test("a direct public route resource waits for handoff and its return replaces rather than backs out of the visit", async () => {
  const href = `https://guide.example/?point=${pointB}&experience=${tourId}&revision=4&stop=1&segment=detail&mode=onsite&resource=video&resource_id=${videoB.id}&resource_revision=3&resource_point=${pointB}&play=1`;
  const testApp = app(href, { experiences: [publishedTour, videoB] });
  testApp.render();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  clickButton(tree, "继续参观").props.onClick();
  tree = testApp.render();
  assert.equal(testApp.node("TourResourceView").props.resource.id, videoB.id);
  assert.equal(testApp.node("TourResourceView").props.playbackRequest, null);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  clickButton(tree, "← 返回本站讲解").props.onClick();
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  const params = new URL(testApp.browser.location.href).searchParams;
  assert.equal(params.has("resource"), false);
  assert.equal(params.get("experience"), tourId);
  assert.equal(params.get("point"), pointB);
  testApp.dispose();
});

test("forged, non-stop, private, duplicate and outdated resource URLs are removed before they can open", async () => {
  const base = `https://guide.example/?point=${pointB}&experience=${tourId}&revision=4&stop=1&segment=detail&mode=onsite`;
  for (const tail of [
    `&resource=video&resource_id=${experienceId}&resource_revision=3&resource_point=${pointA}`,
    `&resource=video&resource_id=${panoramaId}&resource_revision=3&resource_point=${pointB}`,
    `&resource=video&resource_id=${videoB.id}&resource_revision=2&resource_point=${pointB}`,
    `&resource=checkin&resource_id=${videoB.id}&resource_revision=3&resource_point=${pointB}`,
    `&resource=video&resource_id=${videoB.id}&resource_id=${experienceId}&resource_revision=3&resource_point=${pointB}`,
    `&resource_id=${videoB.id}`,
  ]) {
    const testApp = app(base + tail, {
      experiences: [publishedTour, video, videoB],
    });
    testApp.render();
    await new Promise((resolve) => setImmediate(resolve));
    const tree = testApp.render();
    assert.equal(testApp.node("TourResourceView"), undefined);
    const params = new URL(testApp.browser.location.href).searchParams;
    assert.equal(params.has("resource"), false);
    assert.equal(params.has("resource_id"), false);
    assert.equal(params.get("point"), pointB);
    clickButton(tree, "继续参观").props.onClick();
    testApp.render();
    assert.equal(testApp.node("TourResourceView"), undefined);
    testApp.dispose();
  }
});

test("Forward revalidates a formerly public AI video and does not reopen it after retirement", async () => {
  const { testApp, settings } = await loadPublishedTour();
  const source = detailNarration();
  testApp.node("ExperiencePanel").props.onNarrate(source);
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction(videoAction);
  testApp.render();
  testApp.browser.history.back();
  testApp.render();
  settings.experiences = [publishedTour, videoB];
  testApp.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  testApp.browser.history.forward();
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("resource"),
    false,
  );
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  assert.equal(testApp.node("ExperiencePanel").props.active, true);
  testApp.dispose();
});

test("changing stations while a resource is open clears the resource, old narration and audio bookmark", async () => {
  const { testApp } = await loadPublishedTour();
  testApp.node("ExperiencePanel").props.onNarrate(detailNarration());
  testApp.render();
  testApp.node("TourNarrator").props.onBookmark({ chunkIndex: 2, time: 5 });
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction(videoAction);
  testApp.render();
  testApp.node("ExperiencePanel").props.onPositionChange({
    revision: 4,
    stopIndex: 0,
    segmentId: "opening",
  });
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  assert.equal(testApp.node("ShareVisit").props.session.audio, undefined);
  assert.equal(testApp.node("ShareVisit").props.session.position.stopIndex, 0);
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointA);
  const params = new URL(testApp.browser.location.href).searchParams;
  assert.equal(params.has("resource"), false);
  assert.equal(params.get("point"), pointA);
  assert.equal(params.get("segment"), "opening");
  testApp.dispose();
});

test("public floor validation is cancellable across Back and rejects a stale revision on Forward", async () => {
  const requests = [];
  const { testApp } = await loadPublishedTour({
    get: async (path, signal) => {
      if (path.startsWith("/experiences"))
        return { data: [publishedTour, video, videoB] };
      assert.equal(path, `/floors/${floorId}`);
      return new Promise((resolve) => requests.push({ resolve, signal }));
    },
  });
  const source = detailNarration();
  testApp.node("ExperiencePanel").props.onNarrate(source);
  testApp.render();
  assert.equal(
    testApp.node("NativeAgentDock").props.onAction({
      type: "show_floor",
      point_id: pointA,
      point_revision: 1,
      resource_id: floorId,
      resource_revision: 2,
    }),
    true,
  );
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(requests.length, 1);
  assert.equal(testApp.node("ExperiencePanel").props.active, false);
  assert.ok(clickButton(testApp.render(), "← 返回本站讲解"));
  testApp.browser.history.back();
  testApp.render();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ data: { id: floorId, point_id: pointA, revision: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  testApp.browser.history.forward();
  testApp.render();
  assert.equal(requests.length, 2);
  requests[1].resolve({ data: { id: floorId, point_id: pointA, revision: 3 } });
  await new Promise((resolve) => setImmediate(resolve));
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("resource"),
    false,
  );
  assert.equal(testApp.node("MapCanvas").props.selectedId, pointB);
  assert.equal(testApp.node("TourNarrator").props.narration, source);
  testApp.dispose();
});

test("published floor and VR stop refs re-open through public validation and return to paused narration", async () => {
  for (const type of ["floor", "vr"]) {
    const id = type === "floor" ? floorId : panoramaId;
    const tour = structuredClone(publishedTour);
    tour.content.stops[1].segments[0].resources = [{ type, id, revision: 2 }];
    let reads = 0;
    const { testApp } = await loadPublishedTour({
      get: async (path) => {
        if (path.startsWith("/experiences")) return { data: [tour] };
        reads++;
        if (type === "floor") {
          assert.equal(path, `/floors/${id}`);
          return { data: { id, point_id: pointB, revision: 2 } };
        }
        assert.equal(path, `/points/${pointB}/panoramas`);
        return { data: [{ id, point_id: pointB, revision: 2 }] };
      },
    });
    const source = detailNarration();
    testApp.node("ExperiencePanel").props.onNarrate(source);
    testApp.render();
    assert.equal(
      testApp
        .node("ExperiencePanel")
        .props.onResourceOpen({ type, id, revision: 2 }, pointB),
      true,
    );
    testApp.render();
    await new Promise((resolve) => setImmediate(resolve));
    testApp.render();
    assert.equal(testApp.node("TourResourceView").props.resource.id, id);
    testApp.browser.history.back();
    testApp.render();
    assert.equal(testApp.node("TourResourceView"), undefined);
    assert.equal(testApp.node("TourNarrator").props.narration, source);
    testApp.browser.history.forward();
    testApp.render();
    await new Promise((resolve) => setImmediate(resolve));
    testApp.render();
    assert.equal(testApp.node("TourResourceView").props.resource.id, id);
    assert.equal(testApp.node("TourResourceView").props.playbackRequest, null);
    assert.equal(testApp.node("TourNarrator").props.narration, source);
    assert.equal(reads, 2);
    testApp.dispose();
  }
});

test("retiring a public tour closes its resource and old narration and requires an available published route to continue", async () => {
  const { testApp, settings } = await loadPublishedTour();
  testApp.node("ExperiencePanel").props.onNarrate(detailNarration());
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction(videoAction);
  testApp.render();
  settings.experiences = [video, videoB];
  testApp.refreshCatalogs();
  await new Promise((resolve) => setImmediate(resolve));
  const tree = testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("TourNarrator").props.narration, null);
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  assert.equal(clickButton(tree, "继续参观").props.disabled, true);
  assert.equal(
    new URL(testApp.browser.location.href).searchParams.has("resource"),
    false,
  );
  testApp.dispose();
});

test("ordinary map exploration exits a resource visit and removes its media history parameters", async () => {
  const { testApp } = await loadPublishedTour();
  testApp.node("ExperiencePanel").props.onNarrate(detailNarration());
  testApp.render();
  testApp.node("NativeAgentDock").props.onAction(videoAction);
  testApp.render();
  testApp.node("MapCanvas").props.onSelect(pointB);
  testApp.render();
  assert.equal(testApp.node("TourResourceView"), undefined);
  assert.equal(testApp.node("TourNarrator"), undefined);
  assert.equal(testApp.node("ExperiencePanel"), undefined);
  const params = new URL(testApp.browser.location.href).searchParams;
  assert.equal(params.has("experience"), false);
  assert.equal(params.has("resource"), false);
  assert.equal(params.has("resource_id"), false);
  assert.equal(params.get("point"), pointB);
  testApp.dispose();
});

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
    baseHref.replace("#map", `&mode=onsite&experience=${experienceId}#map`),
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
  const testApp = app(baseHref.replace("#map", "&mode=onsite#map"));
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
  const testApp = app(baseHref.replace("#map", "&mode=onsite#map"));
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
