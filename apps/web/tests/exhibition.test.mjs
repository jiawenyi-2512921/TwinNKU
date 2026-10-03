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
const id = "66666666-6666-4666-8666-666666666666",
  imageId = "33333333-3333-4333-8333-333333333333";
const code = compile("../src/features/visit/Exhibition.tsx");
const RouteDistribution = () => null;
const segments = {};
vm.runInNewContext(compile("../src/features/experiences/segments.ts"), {
  exports: segments,
});
const progress = {};
vm.runInNewContext(compile("../src/features/experiences/progress.ts"), {
  exports: progress,
  URL,
});
const data = () => ({
  campus_id: "nku-jinnan",
  presentation: {
    site_name: "测试展馆",
    description: "真实简介",
    footer: "来源声明",
    contact_help: "帮助",
    appearance: {
      palette: "light-purple",
      density: "compact",
      radius: "square",
    },
    modules: [
      {
        id: "hero",
        type: "hero",
        enabled: true,
        title: "配置标题",
        body: "配置正文",
        layout: "split",
        image: null,
        routes: [],
        image_focus: { x: 0.2, y: 0.8 },
        button_label: "了解主题",
        target: { type: "tour", id, revision: 4 },
      },
      {
        id: "modes",
        type: "visit_modes",
        enabled: true,
        title: "参观方式",
        body: "配置三入口说明",
        layout: "default",
      },
    ],
  },
  visit_defaults: {
    layout: "balanced",
    assistant_collapsed: true,
    welcome_text: "欢迎",
    recommended_questions: [],
  },
  routes: [
    {
      id,
      revision: 4,
      campus_id: "nku-jinnan",
      title: "已发布路线",
      description: "精确简介",
      stop_count: 2,
      media_url: null,
      resource_types: ["floor", "vr"],
    },
  ],
  resolved_resources: [],
  capabilities: {
    chat: false,
    voice: false,
    narration: true,
    navigation: false,
  },
});
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join("")
    : node && typeof node === "object"
      ? text(node.props?.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";
const expand = (node) =>
  Array.isArray(node)
    ? node.map(expand)
    : node && typeof node === "object"
      ? typeof node.type === "function"
        ? expand(node.type(node.props))
        : {
            ...node,
            props: { ...node.props, children: expand(node.props?.children) },
          }
      : node;
const walk = (node, predicate) =>
  Array.isArray(node)
    ? node.flatMap((n) => walk(n, predicate))
    : node && typeof node === "object"
      ? [
          ...(predicate(node) ? [node] : []),
          ...walk(node.props?.children, predicate),
        ]
      : [];
const button = (node, label) =>
  walk(node, (n) => n.type === "button" && text(n) === label)[0];
function harness(overrides = {}) {
  const slots = [],
    effects = [];
  let cursor = 0,
    dirty = false,
    queued = [];
  const listeners = new Set(),
    reads = [];
  let visitsRead = 0;
  const react = {
    useRef(initial) {
      const i = cursor++;
      return (slots[i] ??= { current: initial });
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in slots))
        slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (v) => {
          const next = typeof v === "function" ? v(slots[i]) : v;
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
      if (!old || deps.some((v, j) => !Object.is(v, old.deps[j])))
        queued.push(() => {
          old?.cleanup?.();
          effects[i] = { deps, cleanup: fn() };
        });
    },
  };
  class ApiError extends Error {
    constructor(status) {
      super("public unavailable");
      this.status = status;
    }
  }
  const module = {};
  vm.runInNewContext(code, {
    exports: module,
    URL,
    AbortController,
    window: {
      location: { href: "https://guide.example/" },
      confirm: () => overrides.confirm ?? false,
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name === "./RouteDistribution") return { RouteDistribution };
      if (name.endsWith("/progress")) return progress;
      if (name.endsWith("/segments")) return segments;
      if (name === "./session")
        return {
          listVisits() {
            visitsRead++;
            return overrides.visits ?? [];
          },
          loadVisit: () => null,
          saveVisit: (record) => {
            overrides.onSave?.(record);
            return true;
          },
          clearVisit: (tourId, revision) =>
            overrides.onClear?.(tourId, revision) ?? true,
        };
      if (name.endsWith("/catalogSync"))
        return {
          watchCatalogChanges(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        };
      if (name.endsWith("/client"))
        return {
          ApiError,
          api: {
            campuses: async () => ({
              data: [{ id: "nku-jinnan", name: "津南" }],
            }),
            point: async () => ({ data: {} }),
          },
          get(path, signal) {
            return new Promise((resolve, reject) =>
              reads.push({ path, signal, resolve, reject }),
            );
          },
        };
      throw new Error(name);
    },
  });
  return {
    module,
    reads,
    listeners,
    ApiError,
    get visitsRead() {
      return visitsRead;
    },
    render(fn, props) {
      let tree,
        n = 0;
      do {
        assert.ok(n++ < 30);
        cursor = 0;
        dirty = false;
        queued = [];
        tree = fn(props);
        queued.forEach((f) => f());
      } while (dirty);
      return tree;
    },
    dispose() {
      effects.forEach((e) => e?.cleanup?.());
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("home hero uses only an explicit exact-revision image and configured target; preview never reads private progress", () => {
  const h = harness(),
    showcase = data(),
    pages = [];
  showcase.resolved_resources = [
    {
      type: "image",
      id: imageId,
      revision: 3,
      title: "真实图片",
      url: "https://media.example/photo.jpg",
    },
  ];
  let tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate: (p) => pages.push(p),
    }),
  );
  assert.equal(h.visitsRead, 0);
  assert.equal(
    walk(tree, (n) => n.type === "img").length,
    0,
    "no implicit first image",
  );
  assert.match(
    tree.props.className,
    /palette-light-purple density-compact radius-square/,
  );
  button(tree, "了解主题").props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(pages[0])), {
    kind: "overview",
    tourId: id,
  });
  showcase.presentation.modules[0].image = {
    type: "image",
    id: imageId,
    revision: 2,
  };
  tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate() {},
    }),
  );
  assert.equal(
    walk(tree, (n) => n.type === "img").length,
    0,
    "wrong revision is not substituted",
  );
  showcase.presentation.modules[0].image.revision = 3;
  tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate() {},
    }),
  );
  const img = walk(tree, (n) => n.type === "img")[0];
  assert.equal(img.props.src, "https://media.example/photo.jpg");
  assert.equal(img.props.style.objectPosition, "20% 80%");
  assert.match(text(tree), /配置三入口说明/);
});
test("home modes preserve online and onsite intent; featured routes require exact configured revisions", () => {
  const h = harness(),
    showcase = data(),
    pages = [];
  showcase.presentation.modules.push({
    id: "feature",
    type: "featured_routes",
    enabled: true,
    title: "人工推荐",
    body: "",
    layout: "wide",
    routes: [{ type: "tour", id, revision: 3 }],
  });
  let tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate: (p) => pages.push(p),
    }),
  );
  button(
    tree,
    "ONLINE在线云游沿主题看画面、听讲解，按自己的节奏认识南开。",
  ).props.onClick();
  button(
    tree,
    "ON CAMPUS到校参观选择路线后切换到校模式，人工确认起点和到达。",
  ).props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(pages)), [
    { kind: "tours", mode: "online" },
    { kind: "tours", mode: "onsite" },
  ]);
  assert.equal(
    walk(tree, (n) => n.props?.className === "exhibition-card").length,
    0,
  );
  showcase.presentation.modules.at(-1).routes[0].revision = 4;
  tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate() {},
    }),
  );
  assert.equal(
    walk(tree, (n) => n.props?.className === "exhibition-card").length,
    1,
  );
  assert.match(text(tree), /楼层/);
  assert.match(text(tree), /VR/);
});

test("disabling the hero preserves a named main heading and a stale continuation never claims its position belongs to the new route", () => {
  const showcase = data(),
    record = { tourId: id, position: { revision: 3, stopIndex: 1 } };
  showcase.presentation.modules[0].enabled = false;
  showcase.presentation.modules.push({
    id: "continue",
    type: "continue_visit",
    enabled: true,
    title: "",
    body: "",
    layout: "default",
  });
  const h = harness({ visits: [record] }),
    pages = [];
  const tree = expand(
    h.module.ExhibitionHome({
      showcase,
      campusName: "津南",
      onNavigate: (page) => pages.push(page),
    }),
  );
  const heading = walk(tree, (n) => n.type === "h1");
  assert.equal(heading.length, 1);
  assert.equal(text(heading[0]), showcase.presentation.site_name);
  assert.match(text(tree), /旧版进度仍保留/);
  assert.doesNotMatch(text(tree), /第 2 站 · 声音由你继续/);
  button(tree, "查看新版路线").props.onClick();
  assert.equal(pages[0].kind, "overview");
  assert.equal(record.position.revision, 3);
});
test("route filters use actual published resource types and preserve the selected visit mode", () => {
  const h = harness(),
    showcase = data(),
    pages = [];
  showcase.routes.push({
    ...showcase.routes[0],
    id: imageId,
    title: "另一条图文路线",
    resource_types: ["image"],
  });
  const props = {
    showcase,
    initialMode: "onsite",
    onNavigate: (p) => pages.push(p),
  };
  let tree = expand(h.render(h.module.TourCatalog, props));
  const select = walk(tree, (n) => n.type === "select")[0];
  select.props.onChange({ target: { value: "floor" } });
  tree = expand(h.render(h.module.TourCatalog, props));
  const cards = walk(tree, (n) => n.props?.className === "exhibition-card");
  assert.equal(cards.length, 1);
  cards[0].props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(pages[0])), {
    kind: "overview",
    tourId: id,
    mode: "onsite",
  });
  assert.doesNotMatch(text(tree), /另一条图文路线/);
});
test("showcase refresh aborts stale reads, retains existing data, and does not trust the device clock", async () => {
  const h = harness(),
    page = { kind: "home" };
  let value = h.render(h.module.usePublicShowcase, page);
  assert.equal(value.state, "loading");
  await tick();
  assert.equal(h.reads.length, 1);
  const initial = data();
  initial.presentation.modules.push({
    id: "announcement",
    type: "announcement",
    enabled: true,
    title: "服务端已筛选公告",
    body: "",
    layout: "default",
    start_at: "2099-01-01T00:00:00Z",
  });
  h.reads[0].resolve({ data: initial });
  await tick();
  value = h.render(h.module.usePublicShowcase, page);
  assert.equal(value.state, "ready");
  [...h.listeners][0]();
  await tick();
  assert.equal(h.render(h.module.usePublicShowcase, page).showcase, initial);
  [...h.listeners][0]();
  await tick();
  assert.equal(h.reads[1].signal.aborted, true);
  h.reads[1].resolve({
    data: {
      ...initial,
      presentation: { ...initial.presentation, site_name: "obsolete" },
    },
  });
  const next = {
    ...initial,
    presentation: { ...initial.presentation, site_name: "current" },
  };
  h.reads[2].resolve({ data: next });
  await tick();
  value = h.render(h.module.usePublicShowcase, page);
  assert.equal(value.showcase.presentation.site_name, "current");
  const home = expand(
    h.module.ExhibitionHome({
      showcase: value.showcase,
      campusName: "津南",
      previewOnly: true,
      onNavigate() {},
    }),
  );
  assert.match(
    text(home),
    /服务端已筛选公告/,
    "server-filtered modules are not filtered again with the device clock",
  );
  h.dispose();
});
test("a withdrawn route still permits campus navigation while network errors remain errors", async () => {
  const h = harness();
  h.render(h.module.usePublicShowcase, { kind: "overview", tourId: id });
  await tick();
  h.reads[0].reject(new h.ApiError(404));
  await tick();
  assert.match(h.reads[1].path, /campuses\/nku-jinnan\/showcase/);
  h.reads[1].resolve({ data: data() });
  await tick();
  assert.equal(
    h.render(h.module.usePublicShowcase, { kind: "overview", tourId: id })
      .state,
    "ready",
  );
  h.dispose();
});
test("transport moves within actual segments and only explicit final-segment confirmation completes a station", () => {
  const h = harness(),
    m = {};
  vm.runInNewContext(compile("../src/features/visit/VisitTransport.tsx"), {
    exports: m,
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/segments")) return segments;
      throw new Error(name);
    },
  });
  const tour = {
      id,
      revision: 4,
      content: {
        kind: "tour",
        narration_mode: "recorded",
        stops: [
          {
            point_id: imageId,
            segments: [
              {
                id: "a",
                text: "第一段",
                resources: [],
                main_view: { type: "map" },
              },
              {
                id: "b",
                text: "第二段",
                resources: [],
                main_view: { type: "map" },
              },
            ],
          },
          { point_id: id, narrative: "旧版讲稿", prompt_timing: "manual" },
        ],
      },
    },
    moved = [],
    completed = [],
    skipped = [];
  const props = {
    tour,
    position: { revision: 4, stopIndex: 0, segmentId: "a" },
    hasNarration: false,
    onListen() {},
    onMove: (p) => moved.push(p),
    onComplete: (p) => completed.push(p),
    onSkip: (p) => skipped.push(p),
  };
  let tree = m.VisitTransport(props);
  assert.equal(button(tree, "上一段").props.disabled, true);
  button(tree, "下一段").props.onClick();
  assert.equal(moved[0].segmentId, "b");
  assert.equal(completed.length, 0);
  button(tree, "跳过本站").props.onClick();
  assert.equal(skipped[0].stopIndex, 1);
  assert.equal(completed.length, 0);
  tree = m.VisitTransport({
    ...props,
    position: { revision: 4, stopIndex: 0, segmentId: "b" },
  });
  button(tree, "完成阅读，下一站").props.onClick();
  assert.equal(completed[0].segmentId, "legacy-stop-2");
  assert.equal(completed[0].stopIndex, 1);
  assert.equal(
    m.adjacentVisitPosition(
      tour,
      { revision: 3, stopIndex: 0, segmentId: "a" },
      1,
    ),
    null,
  );
  assert.equal(
    m.VisitTransport({
      ...props,
      position: { revision: 4, stopIndex: 0, segmentId: "missing" },
    }),
    null,
  );
  h.dispose();
});

const savedTour = () => ({
  id,
  campus_id: "nku-jinnan",
  revision: 4,
  content: {
    kind: "tour",
    title: "回顾测试路线",
    stops: [
      {
        point_id: imageId,
        title: "真实测试站点",
        segments: [
          {
            id: "a",
            title: "实际段落",
            text: "审核文字",
            takeaway: "审核回顾要点",
            resources: [{ type: "image", id: imageId, revision: 2 }],
            main_view: { type: "map" },
          },
        ],
      },
    ],
  },
});
const savedRecord = () => ({
  tourId: id,
  campusId: "nku-jinnan",
  mode: "online",
  position: { revision: 4, stopIndex: 0, segmentId: "a" },
  completed: [],
  skipped: [0],
  arrived: [],
  notes: { a: "私人测试笔记" },
  collections: [
    { stopIndex: 0, segmentId: "a" },
    { stopIndex: 0, segmentId: "a", resourceId: imageId },
  ],
  audio: {
    manifestId: "old",
    chunkId: "1",
    time: 3,
    textSha256: "f".repeat(64),
  },
  updatedAt: "2026-10-03T00:00:00Z",
});

test("the route overview exposes only actual resource tags and choosing an actual map point sets the station without starting audio or completing predecessors", () => {
  const h = harness(),
    tour = savedTour(),
    begun = [];
  tour.content.stops.push({ point_id: id, title: "实际第二站", segments: [] });
  const props = {
    tour,
    showcase: data(),
    campusName: "津南",
    onNavigate() {},
    onBegin: (...args) => begun.push(args),
  };
  try {
    let tree = h.render(h.module.TourOverview, props);
    assert.match(text(tree), /楼层/);
    assert.match(text(tree), /VR 全景/);
    assert.doesNotMatch(text(tree), /分钟|公里/);
    const distribution = walk(
      tree,
      (node) => node.type === RouteDistribution,
    )[0];
    assert.equal(distribution.props.campusId, tour.campus_id);
    assert.deepEqual(Array.from(distribution.props.pointIds), [imageId, id]);
    distribution.props.onSelect("unpublished-point");
    assert.equal(
      walk(
        h.render(h.module.TourOverview, props),
        (node) => node.type === "select",
      )[0].props.value,
      0,
    );
    distribution.props.onSelect(id);
    tree = h.render(h.module.TourOverview, props);
    assert.equal(
      walk(tree, (node) => node.type === "select")[0].props.value,
      1,
    );
    assert.equal(
      begun.length,
      0,
      "map selection alone never starts a visit or sound",
    );
    button(tree, "开始参观").props.onClick();
    assert.equal(begun[0][2], 1);
    assert.equal(begun[0][3], true);
  } finally {
    h.dispose();
  }
});

test("recap shows actual notes and valid collections without completing skipped stations or exposing another version", () => {
  const h = harness(),
    record = savedRecord(),
    tour = savedTour();
  record.collections.push({ stopIndex: 0, segmentId: "a", resourceId: id });
  let tree = h.module.VisitRecap({ tour, record, onNavigate() {} });
  assert.match(text(tree), /0 站完成阅读 · 1 站跳过/);
  assert.match(text(tree), /审核回顾要点/);
  assert.match(text(tree), /私人测试笔记/);
  const collections = walk(
    tree,
    (n) =>
      n.type === "section" &&
      n.props?.["aria-labelledby"] === "recap-collections",
  )[0];
  assert.equal(
    walk(collections, (n) => n.type === "li").length,
    2,
    "unreferenced local resources are not presented as formal collections",
  );
  assert.deepEqual(record.completed, []);
  for (const stale of [
    { ...record, position: { ...record.position, revision: 3 } },
    { ...record, tourId: imageId },
  ]) {
    tree = h.module.VisitRecap({ tour, record: stale, onNavigate() {} });
    assert.doesNotMatch(text(tree), /私人测试笔记/);
    assert.match(text(tree), /旧版记录/);
  }
});

test("private notes return to the exact current segment without an unrelated audio bookmark and all records are attempted during clear", () => {
  const record = savedRecord(),
    second = { ...record, tourId: imageId },
    resumed = [],
    cleared = [],
    saved = [];
  const h = harness({
    visits: [record, second],
    confirm: true,
    onSave: (value) => saved.push(value),
    onClear: (tourId, revision) => {
      cleared.push([tourId, revision]);
      return tourId !== id;
    },
  });
  const props = {
    showcase: data(),
    items: [savedTour()],
    onNavigate() {},
    onResume: (value) => resumed.push(value),
  };
  let tree = h.render(h.module.MyVisits, props);
  const jump = walk(
    tree,
    (n) =>
      n.type === "button" &&
      n.props?.["aria-label"] === "回到笔记所属讲解：实际段落",
  )[0];
  jump.props.onClick();
  assert.equal(resumed[0].position.segmentId, "a");
  assert.equal(resumed[0].position.revision, 4);
  assert.equal(resumed[0].audio, undefined);
  assert.equal(
    record.audio.chunkId,
    "1",
    "original local record is not rewritten by a jump",
  );
  button(tree, "删除这条笔记").props.onClick();
  assert.equal(saved[0].notes.a, undefined);
  tree = h.render(h.module.MyVisits, props);
  button(tree, "清除全部参观记录").props.onClick();
  assert.deepEqual(
    cleared,
    [
      [id, 4],
      [imageId, 4],
    ],
    "a failed deletion cannot prevent the other records from being attempted",
  );
});
