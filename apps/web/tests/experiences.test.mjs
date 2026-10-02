import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as progress from "../src/features/experiences/progress.ts";
import * as segments from "../src/features/experiences/segments.ts";
import * as audioOwner from "../src/features/visit/audioOwner.ts";

const names = { media: "图片与视频", checkin: "打卡点", tour: "校园导览路线" };
const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const publicCode = compile("../src/features/experiences/ExperiencePanel.tsx");
const adminCode = compile("../src/features/admin/ExperienceWorkspace.tsx");
const editorCode = compile("../src/features/admin/ExperienceEditor.tsx");
function find(tree, predicate) {
  if (Array.isArray(tree))
    return tree.flatMap((entry) => find(entry, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...find(tree.props?.children, predicate),
  ];
}
const labelText = (value) =>
  Array.isArray(value)
    ? value.map(labelText).join("")
    : value && typeof value === "object"
      ? labelText(value.props?.children)
      : typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
const button = (tree, name) =>
  find(tree, (node) => node.type === "button" && labelText(node) === name)[0];
const field = (tree, name) =>
  find(
    find(
      tree,
      (node) => node.type === "label" && labelText(node).startsWith(name),
    )[0],
    (node) => ["input", "select", "textarea"].includes(node.type),
  )[0];
function harness(code, context = {}, overrides = {}) {
  const slots = [],
    effects = [],
    persisted = new Map(),
    calls = [],
    resources = [];
  let cursor = 0,
    effectCursor = 0;
  const react = {
    createContext: (value) => ({ value, Provider: ({ children }) => children }),
    useContext: () => ({ active: true, ...context }),
    useState(initial) {
      const key = cursor++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (next) => {
          slots[key] = typeof next === "function" ? next(slots[key]) : next;
        },
      ];
    },
    useRef(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(callback, deps) {
      const key = effectCursor++;
      const old = effects[key];
      if (
        !old ||
        deps.some((value, index) => !Object.is(value, old.deps[index]))
      )
        effects[key] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    URLSearchParams,
    AbortController,
    Date,
    window: {
      confirm: () => overrides.confirm ?? true,
      addEventListener() {},
      removeEventListener() {},
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/types") || name === "./types")
        return { experienceNames: names };
      if (name.endsWith("/progress") || name === "./progress")
        return {
          ...progress,
          readLocal: (key) => persisted.get(key) ?? null,
          writeLocal: (key, value) => {
            persisted.set(key, value);
            return true;
          },
        };
      if (name.endsWith("/segments") || name === "./segments") return segments;
      if (name === "./ExperienceEditor")
        return {
          ExperienceEditor: () => null,
          ExperienceTourPreview: () => null,
        };
      if (name.endsWith("/ExperiencePanel"))
        return {
          TourPlayer: function TourPlayer() {
            return null;
          },
        };
      if (name.endsWith("/TourNarrator")) return { TourNarrator: () => null };
      if (name.endsWith("/audioOwner"))
        return overrides.audioOwner ?? audioOwner;
      if (name.endsWith("/client"))
        return {
          get: async (path) =>
            overrides.get
              ? overrides.get(path)
              : {
                  data:
                    path === "/campuses"
                      ? (overrides.campuses ?? [])
                      : (overrides.publicRows ?? []),
                },
        };
      if (name.endsWith("catalogSync"))
        return {
          notifyCatalogPublished() {},
          watchCatalogChanges: () => () => {},
        };
      if (name === "./api")
        return {
          request: async (...args) => {
            calls.push(args);
            if (args[0].startsWith("/points?"))
              return { data: overrides.points ?? [], meta: {} };
            return overrides.request
              ? overrides.request(...args)
              : { data: overrides.record };
          },
          message: (e) => e.message,
          stateNames: {
            draft: "草稿",
            in_review: "待审核",
            published: "已发布",
          },
        };
      if (name === "./ui")
        return {
          Empty: () => null,
          ErrorBox: () => null,
          useResource: (path) => {
            resources.push(path);
            return {
              data: {
                data: path.startsWith("/experiences")
                  ? path.includes("referenceable=true")
                    ? path.includes("kind=checkin")
                      ? (overrides.checkinRows ?? overrides.rows ?? [])
                      : (overrides.mediaRows ?? overrides.rows ?? [])
                    : (overrides.rows ?? [])
                  : [],
              },
              loading: false,
              error: "",
            };
          },
        };
      throw new Error(name);
    },
  });
  return {
    exports,
    persisted,
    calls,
    resources,
    flushEffects() {
      for (const effect of effects)
        if (effect.pending) {
          effect.pending = false;
          effect.cleanup?.();
          effect.cleanup = effect.callback();
        }
    },
    render(name, props) {
      cursor = 0;
      effectCursor = 0;
      return exports[name](props);
    },
  };
}
const media = {
  id: "video",
  revision: 3,
  media_url: "/api/v1/experiences/video/media",
  content: {
    kind: "media",
    point_id: "p1",
    title: "示例测试视频",
    description: "",
    source_note: "测试夹具",
    media_type: "video",
    upload_id: "upload",
    url: null,
  },
};
const playbackRequest = (controller = new AbortController(), revision = 3) => ({
  id: 1,
  resourceId: "video",
  revision,
  pointId: "p1",
  pointRevision: 1,
  signal: controller.signal,
});

function attachPlayer(h, props, player) {
  const tree = h.render("MediaView", props);
  const video = find(tree, (node) => node.type === "video")[0];
  if (video) video.props.ref.current = player;
  h.flushEffects();
  return tree;
}

test("a resolved explicit video request opens and attempts playback once without claiming success", async () => {
  let attempts = 0;
  const playback = [];
  const h = harness(publicCode, {
    onMediaActiveChange: (value) => playback.push(value),
  });
  const props = { item: media, playbackRequest: playbackRequest() };
  const player = { play: async () => attempts++, pause() {} };
  let tree = attachPlayer(h, props, player);
  assert.equal(button(tree, "打开视频播放器"), undefined);
  assert.equal(attempts, 1);
  assert.deepEqual(playback, []);
  tree = attachPlayer(h, props, player);
  assert.equal(attempts, 1);
  find(tree, (node) => node.type === "video")[0].props.onPlay();
  assert.deepEqual(playback, [true]);
  button(tree, "收起视频").props.onClick();
  tree = attachPlayer(h, props, player);
  assert.equal(find(tree, (node) => node.type === "video").length, 0);
  assert.equal(attempts, 1);
});

test("browser autoplay denial gives a truthful click-to-play fallback using the mounted player", async () => {
  let attempts = 0;
  const h = harness(publicCode);
  const props = { item: media, playbackRequest: playbackRequest() };
  const player = {
    play() {
      attempts++;
      return attempts === 1
        ? Promise.reject({ name: "NotAllowedError" })
        : Promise.resolve();
    },
    pause() {},
  };
  attachPlayer(h, props, player);
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render("MediaView", props);
  assert.match(labelText(tree), /浏览器阻止了自动播放/);
  button(tree, "点击播放").props.onClick();
  assert.equal(attempts, 2);
  await new Promise((resolve) => setImmediate(resolve));
  tree = h.render("MediaView", props);
  assert.equal(button(tree, "点击播放"), undefined);
});

test("cancelled playback suppresses a late rejection and leaves normal manual consent available", async () => {
  const controller = new AbortController();
  const h = harness(publicCode);
  const props = { item: media, playbackRequest: playbackRequest(controller) };
  let reject,
    pauses = 0;
  const player = {
    play: () =>
      new Promise((_, no) => {
        reject = no;
      }),
    pause: () => pauses++,
  };
  attachPlayer(h, props, player);
  controller.abort();
  assert.ok(pauses > 0);
  reject({ name: "NotAllowedError" });
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render("MediaView", props);
  assert.equal(find(tree, (node) => node.type === "video").length, 0);
  assert.doesNotMatch(labelText(tree), /浏览器阻止/);
  button(tree, "打开视频播放器").props.onClick();
  tree = h.render("MediaView", props);
  assert.equal(find(tree, (node) => node.type === "video").length, 1);
});

test("explicit playback cannot cross a resource revision or resume after the panel was hidden", () => {
  const context = { active: true };
  const h = harness(publicCode, context);
  const props = { item: media, playbackRequest: playbackRequest(undefined, 2) };
  let attempts = 0;
  const player = { play: async () => attempts++, pause() {} };
  let tree = attachPlayer(h, props, player);
  assert.equal(find(tree, (node) => node.type === "video").length, 0);
  assert.equal(attempts, 0);
  props.playbackRequest = playbackRequest();
  attachPlayer(h, props, player);
  assert.equal(attempts, 1);
  context.active = false;
  attachPlayer(h, props, player);
  context.active = true;
  tree = attachPlayer(h, props, player);
  assert.equal(find(tree, (node) => node.type === "video").length, 0);
  assert.equal(attempts, 1);
});
const tour = {
  id: "tour",
  revision: 2,
  content: {
    kind: "tour",
    campus_id: "campus-a",
    title: "测试路线",
    description: "",
    source_note: "测试夹具",
    stops: [
      {
        point_id: "p1",
        narrative: "阅读介绍",
        video_id: "video",
        prompt_timing: "after_intro",
      },
      {
        point_id: "p2",
        narrative: "第二站",
        video_id: null,
        prompt_timing: "manual",
      },
    ],
  },
};

const segmentedTour = {
  ...tour,
  revision: 4,
  content: {
    ...tour.content,
    stops: [
      {
        ...tour.content.stops[0],
        title: "本站自定义标题",
        segments: [
          {
            id: "opening",
            text: "第一段原文",
            source_note: "第一段来源",
            main_view: { type: "map" },
            resources: [],
          },
          {
            id: "detail",
            text: "第二段原文",
            source_note: "第二段来源",
            main_view: { type: "map" },
            resources: [
              { type: "video", id: media.id, revision: media.revision },
            ],
          },
        ],
      },
      {
        ...tour.content.stops[1],
        point_id: "p1",
        segments: [
          {
            id: "return",
            text: "同地点的下一站",
            source_note: "",
            main_view: { type: "map" },
            resources: [],
          },
        ],
      },
    ],
  },
};

test("legacy fifty-stop fallback and segment reorder preserve content and independent station identity", () => {
  const stops = Array.from({ length: 50 }, (_, i) => ({
    ...tour.content.stops[0],
    narrative: `原讲解 ${i}`,
  }));
  const snapshot = JSON.stringify(stops);
  assert.equal(segments.segmentsForStop(stops[49], 49)[0].text, "原讲解 49");
  assert.notEqual(
    segments.segmentsForStop(stops[0], 0)[0].id,
    segments.segmentsForStop(stops[1], 1)[0].id,
  );
  assert.equal(JSON.stringify(stops), snapshot);
  const chapters = segmentedTour.content.stops[0].segments;
  const moved = segments.moveSegment(chapters, 1, -1);
  assert.deepEqual(
    moved.map((s) => s.id),
    ["detail", "opening"],
  );
  assert.equal(moved[0], chapters[1]);
  assert.equal(
    segments.normalizeTourPosition(
      { revision: 3, stopIndex: 1, segmentId: "return" },
      4,
      segmentedTour.content.stops,
    ).segmentId,
    "opening",
  );
  assert.equal(
    segments.normalizeTourPosition(
      { revision: 4, stopIndex: 0, segmentId: "missing" },
      4,
      segmentedTour.content.stops,
    ).segmentId,
    "opening",
  );
});

test("controlled tour position survives resource opening and supplies revision-bound bookmark and narration", () => {
  const positions = [],
    opened = [],
    bookmarks = [],
    narrated = [];
  const h = harness(publicCode);
  const props = {
    item: segmentedTour,
    items: [media],
    onSelectPoint() {},
    onPositionChange(position) {
      positions.push(position);
      props.position = position;
    },
    onResourceOpen(...args) {
      opened.push(args);
    },
    onBookmark(position) {
      bookmarks.push(position);
    },
    onNarrate(value) {
      narrated.push(value);
    },
  };
  let tree = h.render("TourPlayer", props);
  h.flushEffects();
  tree = h.render("TourPlayer", props);
  button(tree, "开始导览").props.onClick();
  tree = h.render("TourPlayer", props);
  button(tree, "下一段").props.onClick();
  tree = h.render("TourPlayer", props);
  assert.match(labelText(tree), /第二段原文/);
  const resource = find(
    tree,
    (node) => node.type === h.exports.TourResourceView,
  )[0];
  resource.props.onOpen(resource.props.resource, resource.props.pointId);
  assert.equal(opened[0][1], "p1");
  assert.equal(props.position.segmentId, "detail");
  button(tree, "收藏当前段落").props.onClick();
  button(tree, "听小开讲解").props.onClick();
  assert.deepEqual(bookmarks[0], {
    revision: 4,
    stopIndex: 0,
    segmentId: "detail",
  });
  assert.equal(narrated[0].segmentId, "detail");
  assert.equal(narrated[0].text, "第二段原文");
  assert.equal(narrated[0].tourRevision, 4);
  assert.deepEqual(h.persisted.get("twinnku:tour:tour").completed, []);
  props.item = { ...segmentedTour, revision: 5 };
  tree = h.render("TourPlayer", props);
  assert.match(labelText(tree), /第一段原文/);
  assert.doesNotMatch(labelText(tree), /第二段原文/);
  assert.ok(positions.length > 0);
});

test("private route preview stays local when dirty and requests authenticated saved revision otherwise", async () => {
  const h = harness(
    editorCode,
    {},
    { request: async () => ({ data: segmentedTour }) },
  );
  const props = {
    content: segmentedTour.content,
    mediaRows: [],
    checkinRows: [],
    pointNames: {},
    savedId: "tour",
    draftRevision: 4,
    dirty: true,
    onNarrate() {},
  };
  let tree = h.render("ExperienceTourPreview", props);
  assert.equal(button(tree, "预览已保存版本").props.disabled, true);
  button(tree, "预览当前编辑").props.onClick();
  tree = h.render("ExperienceTourPreview", props);
  assert.equal(h.calls.length, 0);
  const localPlayer = find(tree, (node) => node.type?.name === "TourPlayer")[0];
  assert.equal(localPlayer.props.preview, true);
  assert.equal(localPlayer.props.onNarrate, undefined);
  assert.equal(find(tree, (node) => node.type === "a").length, 0);
  props.dirty = false;
  tree = h.render("ExperienceTourPreview", props);
  await button(tree, "预览已保存版本").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  tree = h.render("ExperienceTourPreview", props);
  assert.equal(
    h.calls.at(-1)[0],
    "/experiences/tour/preview?expected_revision=4",
  );
  const savedPlayer = find(tree, (node) => node.type?.name === "TourPlayer")[0];
  assert.equal(savedPlayer.props.draftRevision, 4);
  assert.equal(savedPlayer.props.onNarrate, props.onNarrate);
});

test("preview player writes no progress and exposes no bookmark", () => {
  const h = harness(publicCode);
  const props = {
    item: segmentedTour,
    items: [],
    preview: true,
    onSelectPoint() {},
    onBookmark() {},
  };
  let tree = h.render("TourPlayer", props);
  assert.equal(button(tree, "收藏当前段落"), undefined);
  button(tree, "开始导览").props.onClick();
  tree = h.render("TourPlayer", props);
  button(tree, "下一段").props.onClick();
  assert.equal(h.persisted.size, 0);
});

test("segment editor offers current point-bound published resources, refreshes a cover, and preserves ids when reordering", async () => {
  const image = publishedResource(
    "image-a",
    { ...media.content, title: "本站照片", media_type: "image" },
    { published_revision: 5 },
  );
  const otherImage = publishedResource("other-image", {
    ...image.published_content,
    point_id: "p2",
    title: "其他地点图片",
  });
  const privateImage = publishedResource(
    "private-image",
    { ...image.published_content, title: "未审核图片" },
    { status: "draft", published_content: null },
  );
  const checkin = publishedResource("checkin-a", {
    kind: "checkin",
    point_id: "p1",
    title: "本站打卡",
    description: "",
    source_note: "已核实",
    image_id: null,
  });
  const h = harness(
    editorCode,
    {},
    {
      get: async (path) => ({
        data: path.endsWith("floors")
          ? [
              { id: "floor-a", point_id: "p1", revision: 7, label: "本站一层" },
              {
                id: "floor-other",
                point_id: "p2",
                revision: 1,
                label: "其他楼层",
              },
            ]
          : [
              {
                id: "vr-a",
                point_id: "p1",
                revision: 9,
                title: "本站室外全景",
              },
              {
                id: "vr-other",
                point_id: "p2",
                revision: 1,
                title: "其他全景",
              },
            ],
      }),
    },
  );
  const props = {
    content: {
      ...segmentedTour.content,
      cover_image_id: image.id,
      cover_image_revision: 4,
      stops: [segmentedTour.content.stops[0]],
    },
    activeStop: 0,
    mediaRows: [
      image,
      otherImage,
      privateImage,
      publishedResource(media.id, media.content, {
        published_revision: media.revision,
      }),
    ],
    checkinRows: [checkin],
    onChange(content) {
      props.content = content;
    },
  };
  let tree = h.render("ExperienceEditor", props);
  h.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  tree = h.render("ExperienceEditor", props);
  assert.match(labelText(tree), /本站照片|本站一层|本站室外全景/);
  assert.doesNotMatch(
    labelText(tree),
    /其他地点图片|未审核图片|其他楼层|其他全景/,
  );
  assert.doesNotMatch(
    labelText(field(tree, "本段主画面")),
    /示例测试视频|本站打卡|本站室外全景/,
  );
  field(tree, "路线封面").props.onChange({ target: { value: "image-a:5" } });
  tree = h.render("ExperienceEditor", props);
  assert.equal(props.content.cover_image_revision, 5);
  field(tree, "本段主画面").props.onChange({
    target: { value: "image:image-a:5" },
  });
  for (const key of [
    "floor:floor-a:7",
    "vr:vr-a:9",
    "video:video:3",
    "checkin:checkin-a:1",
  ]) {
    tree = h.render("ExperienceEditor", props);
    field(tree, "添加本段资料").props.onChange({ target: { value: key } });
  }
  tree = h.render("ExperienceEditor", props);
  field(tree, "添加本段资料").props.onChange({
    target: { value: "vr:vr-a:9" },
  });
  const first = props.content.stops[0].segments[0];
  assert.equal(first.resources.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(first.main_view)), {
    type: "image",
    id: "image-a",
    revision: 5,
  });
  tree = h.render("ExperienceEditor", props);
  find(
    tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "第 1 段下移",
  )[0].props.onClick();
  assert.deepEqual(
    props.content.stops[0].segments.map((segment) => segment.id),
    ["detail", "opening"],
  );
  assert.equal(props.content.stops[0].segments[1].text, "第一段原文");
  assert.equal(props.content.stops[0].segments[1].resources.length, 4);
  tree = h.render("ExperienceEditor", props);
  field(tree, "本站显示标题").props.onChange({ target: { value: "" } });
  assert.equal(props.content.stops[0].title, null);
});

test("resource overlay passes an explicit playback request only after validating resource identity", () => {
  const request = playbackRequest();
  const h = harness(publicCode);
  const props = {
    resource: { type: "video", id: media.id, revision: media.revision },
    pointId: "p1",
    items: [media],
    playbackRequest: request,
  };
  let tree = h.render("TourResourceView", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView)[0].props
      .playbackRequest,
    request,
  );
  props.resource = { ...props.resource, revision: 2 };
  tree = h.render("TourResourceView", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView).length,
    0,
  );
  assert.match(labelText(tree), /资料已变更/);
});

test("legacy prompt state survives temporarily hiding the route while segment resource instances change with the segment", () => {
  const h = harness(publicCode);
  const props = {
    item: tour,
    items: [media],
    onSelectPoint() {},
    active: true,
  };
  let tree = h.render("TourPlayer", props);
  h.flushEffects();
  button(tree, "开始导览").props.onClick();
  tree = h.render("TourPlayer", props);
  h.flushEffects();
  button(tree, "我已阅读本站介绍").props.onClick();
  tree = h.render("TourPlayer", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView).length,
    1,
  );
  props.active = false;
  h.render("TourPlayer", props);
  h.flushEffects();
  props.active = true;
  tree = h.render("TourPlayer", props);
  h.flushEffects();
  tree = h.render("TourPlayer", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView).length,
    1,
  );
  const modern = harness(publicCode);
  const ref = { type: "video", id: media.id, revision: media.revision };
  const modernProps = {
    item: {
      ...segmentedTour,
      content: {
        ...segmentedTour.content,
        stops: [
          {
            ...segmentedTour.content.stops[0],
            segments: segmentedTour.content.stops[0].segments.map(
              (segment) => ({ ...segment, resources: [ref] }),
            ),
          },
        ],
      },
    },
    items: [media],
    onSelectPoint() {},
  };
  tree = modern.render("TourPlayer", modernProps);
  button(tree, "开始导览").props.onClick();
  tree = modern.render("TourPlayer", modernProps);
  const firstKey = find(
    tree,
    (node) => node.type === modern.exports.TourResourceView,
  )[0].key;
  button(tree, "下一段").props.onClick();
  tree = modern.render("TourPlayer", modernProps);
  assert.notEqual(
    find(tree, (node) => node.type === modern.exports.TourResourceView)[0].key,
    firstKey,
  );
});

test("video audio leases stop the prior video and ignore delayed pause events from its old lease", () => {
  audioOwner.releaseAudio("video");
  const first = harness(publicCode),
    second = harness(publicCode);
  const props = { item: media, playbackRequest: playbackRequest() };
  let firstPauses = 0,
    secondPauses = 0;
  const a = attachPlayer(first, props, {
    play: async () => {},
    pause() {
      firstPauses++;
    },
  });
  const b = attachPlayer(second, props, {
    play: async () => {},
    pause() {
      secondPauses++;
    },
  });
  const firstEvents = find(a, (node) => node.type === "video")[0].props;
  const secondEvents = find(b, (node) => node.type === "video")[0].props;
  firstEvents.onPlay();
  secondEvents.onPlay();
  assert.equal(firstPauses, 1);
  firstEvents.onPause();
  const tourLease = audioOwner.acquireAudio("tour", () => {});
  assert.equal(secondPauses, 1);
  audioOwner.releaseAudio("tour", tourLease);
});

test("tour recovery rejects stale revision and malicious progress without inventing completion", () => {
  assert.deepEqual(
    progress.normalizeProgress(
      { revision: 1, index: 1, completed: [0, 1] },
      2,
      2,
    ),
    { revision: 2, index: 0, completed: [], paused: true },
  );
  assert.deepEqual(
    progress.normalizeProgress(
      {
        revision: 2,
        index: 999,
        completed: [0, 0, 9, -1, "1", 1.1],
        paused: false,
      },
      2,
      2,
    ),
    { revision: 2, index: 1, completed: [0], paused: true },
  );
  const done = progress.advanceProgress(
    { revision: 2, index: 1, completed: [], paused: false },
    2,
  );
  assert.deepEqual(done.completed, [1]); // Skipping the first station did not mark it complete.
  assert.equal(done.paused, true);
});

test("media URLs refuse active content and non-public schemes while retaining scoped uploads", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "http://example.com/v.mp4",
    "https://user:secret@example.com/v",
    "//example.com/v.mp4",
    "/api/v1/admin/../secrets",
    "https://example.com/with space",
  ])
    assert.equal(progress.safeMediaUrl(url), null);
  assert.equal(
    progress.safeMediaUrl("/api/v1/admin/experience-media/id"),
    "/api/v1/admin/experience-media/id",
  );
  assert.equal(
    progress.inlineVideo("https://example.com/watch?id=1", false),
    false,
  );
  assert.equal(
    progress.inlineVideo("https://example.com/movie.mp4?token=public", false),
    true,
  );
});

test("video requires explicit consent and reports actual playback/pause for voice coordination", () => {
  const playback = [],
    h = harness(publicCode, {
      onMediaActiveChange: (value) => playback.push(value),
    });
  let tree = h.render("MediaView", { item: media });
  assert.equal(find(tree, (node) => node.type === "video").length, 0);
  button(tree, "打开视频播放器").props.onClick();
  tree = h.render("MediaView", { item: media });
  const video = find(tree, (node) => node.type === "video")[0];
  assert.equal(video.props.autoPlay, undefined);
  assert.equal(video.props.controls, true);
  assert.deepEqual(playback, []);
  video.props.onPlay();
  video.props.onPause();
  video.props.onEnded();
  assert.deepEqual(playback, [true, false, false]);
  button(tree, "收起视频").props.onClick();
  assert.equal(
    find(
      h.render("MediaView", { item: media }),
      (node) => node.type === "video",
    ).length,
    0,
  );
});

test("external video pages use safe links rather than arbitrary iframes", () => {
  const h = harness(publicCode);
  const tree = h.render("MediaView", {
    item: {
      ...media,
      media_url: "https://example.com/watch/1",
      content: {
        ...media.content,
        upload_id: null,
        url: "https://example.com/watch/1",
      },
    },
  });
  assert.equal(
    find(tree, (node) => node.type === "iframe" || node.type === "video")
      .length,
    0,
  );
  const link = find(tree, (node) => node.type === "a")[0];
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.equal(link.props.target, "_blank");
});

test("tour prompts follow intro confirmation and skipping does not claim participation", () => {
  const points = [],
    routes = [],
    h = harness(publicCode, {
      onNavigateStop: (...args) => routes.push(args),
      pointNames: { p1: "测试点一", p2: "测试点二" },
    });
  const props = {
    item: tour,
    items: [media],
    onSelectPoint: (id) => points.push(id),
  };
  let tree = h.render("TourPlayer", props);
  button(tree, "开始导览").props.onClick();
  tree = h.render("TourPlayer", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView).length,
    0,
  );
  button(tree, "我已阅读本站介绍").props.onClick();
  tree = h.render("TourPlayer", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.MediaView).length,
    1,
  );
  button(tree, "跳过本站").props.onClick();
  tree = h.render("TourPlayer", props);
  assert.deepEqual(h.persisted.get("twinnku:tour:tour").completed, []);
  button(tree, "从上一站导航到本站").props.onClick();
  assert.deepEqual(routes, [["p1", "p2"]]);
  button(tree, "确认完成本站").props.onClick();
  assert.deepEqual(h.persisted.get("twinnku:tour:tour").completed, [1]);
  assert.deepEqual(points, ["p1", "p2"]);
});

test("tour stop reorder preserves the narrative, media and trigger as one unit", () => {
  const stops = tour.content.stops;
  const moved = progress.moveStop(stops, 1, -1);
  assert.equal(moved[0], stops[1]);
  assert.equal(moved[1], stops[0]);
  assert.equal(stops[0].point_id, "p1");
  assert.equal(progress.moveStop(stops, 0, -1), stops);
});

test("admin saves a structured media draft with revision guards, never auto-submits", async () => {
  const record = {
    id: "record",
    revision: 1,
    published_revision: 0,
    state: "draft",
    status: "draft",
    operation: "upsert",
    content: media.content,
    published_content: null,
    contributor_ids: ["editor"],
    submitted_by: null,
    review_note: "",
    media_url: media.media_url,
  };
  const h = harness(adminCode, {}, { record });
  const props = {
    session: {
      user: { id: "editor", role: "editor" },
      permissions: ["points.edit"],
    },
    onDirty() {},
  };
  let tree = h.render("ExperienceWorkspace", props);
  button(tree, "＋图片与视频").props.onClick();
  tree = h.render("ExperienceWorkspace", props);
  for (const [label, value] of [
    ["归属地点", "p1"],
    ["标题", "测试内容"],
    ["公开 HTTPS 链接", "https://example.com/movie.mp4"],
    ["来源与公开依据", "已核实来源"],
  ]) {
    field(tree, label).props.onChange({ target: { value } });
    tree = h.render("ExperienceWorkspace", props);
  }
  button(tree, "保存草稿").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  const [url, method, body] = h.calls[0];
  assert.equal(url, "/experiences");
  assert.equal(method, "POST");
  assert.equal(body.expected_revision, 0);
  assert.equal(body.expected_published_revision, 0);
  assert.equal(body.content.kind, "media");
  assert.equal(body.content.url, "https://example.com/movie.mp4");
  assert.equal(body.content.source_note, "已核实来源");
});

test("retirement is explicitly labeled and independent submitter cannot review own request", async () => {
  const record = {
    id: "record",
    revision: 3,
    published_revision: 1,
    state: "in_review",
    status: "published",
    operation: "retire",
    content: media.content,
    published_content: media.content,
    contributor_ids: ["another"],
    submitted_by: "reviewer",
    review_note: "核对",
    media_url: media.media_url,
  };
  const h = harness(adminCode, {}, { record, rows: [record] });
  const props = {
    session: {
      user: { id: "reviewer", role: "reviewer" },
      permissions: ["points.read", "points.review"],
    },
    onDirty() {},
    review: true,
  };
  let tree = h.render("ExperienceWorkspace", props);
  find(
    tree,
    (node) =>
      node.type === "button" &&
      node.props.className?.includes("ad-experience-row"),
  )[0].props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  tree = h.render("ExperienceWorkspace", props);
  assert.equal(button(tree, "审核通过并下架").props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /下架申请/);
});

test("hiding a consented video removes its player immediately", () => {
  const context = { active: true },
    h = harness(publicCode, context);
  const props = { item: media };
  button(h.render("MediaView", props), "打开视频播放器").props.onClick();
  assert.equal(
    find(h.render("MediaView", props), (n) => n.type === "video").length,
    1,
  );
  context.active = false;
  assert.equal(
    find(h.render("MediaView", props), (n) => n.type === "video").length,
    0,
  );
});

test("check-in requires user confirmation and labels the record as local self-report", () => {
  const h = harness(publicCode);
  const props = {
    item: {
      id: "checkin",
      revision: 1,
      content: {
        kind: "checkin",
        title: "测试打卡",
        point_id: "p1",
        image_id: null,
        source_note: "测试夹具",
      },
    },
    items: [],
  };
  let tree = h.render("CheckinCard", props);
  assert.equal(h.persisted.size, 0);
  assert.match(renderToStaticMarkup(tree), /不代表定位核验或官方签到/);
  button(tree, "我已完成本次打卡").props.onClick();
  assert.ok(
    !Number.isNaN(Date.parse(h.persisted.get("twinnku:checkin:checkin"))),
  );
  tree = h.render("CheckinCard", props);
  button(tree, "撤销我的打卡").props.onClick();
  assert.equal(h.persisted.get("twinnku:checkin:checkin"), "");
});

test("switching tabs from an externally selected tour survives selected-id synchronization", async () => {
  const h = harness(publicCode, {}, { publicRows: [tour, media] });
  const props = {
    initialKind: "tour",
    initialExperienceId: "tour",
    onSelectPoint() {},
    onExperienceChange(id) {
      props.initialExperienceId = id;
    },
  };
  h.render("ExperiencePanel", props);
  h.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render("ExperiencePanel", props);
  button(tree, "图片与视频").props.onClick();
  tree = h.render("ExperiencePanel", props);
  h.flushEffects();
  tree = h.render("ExperiencePanel", props);
  assert.equal(button(tree, "图片与视频").props["aria-pressed"], true);
  assert.equal(button(tree, "校园导览路线").props["aria-pressed"], false);
  assert.equal(props.initialExperienceId, "");
});

const campusPoints = [
  {
    point: {
      id: "p1",
      campus_id: "campus-a",
      name: "测试地点甲",
      aliases: ["甲楼"],
    },
  },
  {
    point: { id: "p2", campus_id: "campus-a", name: "测试地点乙", aliases: [] },
  },
  {
    point: {
      id: "p3",
      campus_id: "campus-b",
      name: "另一校区地点",
      aliases: [],
    },
  },
];
const campusRows = [
  { id: "campus-a", name: "测试校区甲" },
  { id: "campus-b", name: "测试校区乙" },
];
const editorProps = {
  session: {
    user: { id: "editor", role: "editor" },
    permissions: ["points.edit"],
  },
  onDirty() {},
  kindScope: "tours",
};
async function routeEditor(overrides = {}) {
  const h = harness(
    adminCode,
    {},
    { points: campusPoints, campuses: campusRows, ...overrides },
  );
  h.render("ExperienceWorkspace", editorProps);
  h.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = h.render("ExperienceWorkspace", editorProps);
  button(tree, "＋校园导览路线").props.onClick();
  tree = h.render("ExperienceWorkspace", editorProps);
  field(tree, "路线所属校区").props.onChange({ target: { value: "campus-a" } });
  return { h, render: () => h.render("ExperienceWorkspace", editorProps) };
}

test("campus route composer has no parent building and filters authorized stations by campus", async () => {
  const { h, render } = await routeEditor();
  let tree = render();
  assert.equal(
    find(
      tree,
      (node) => node.type === "label" && labelText(node).startsWith("归属地点"),
    ).length,
    0,
  );
  assert.equal(button(tree, "＋图片与视频"), undefined);
  const candidates = find(
    tree,
    (node) => node.props?.className === "ad-tour-candidates",
  )[0];
  assert.match(labelText(candidates), /测试地点甲/);
  assert.doesNotMatch(labelText(candidates), /另一校区地点/);
  button(tree, "测试地点甲＋ 加入路线").props.onClick();
  tree = render();
  button(tree, "测试地点乙＋ 加入路线").props.onClick();
  tree = render();
  field(tree, "本站讲解").props.onChange({
    target: { value: "已核实的第二站讲解" },
  });
  tree = render();
  find(
    tree,
    (node) => node.props?.["aria-label"] === "第 2 站上移",
  )[0].props.onClick();
  tree = render();
  assert.equal(field(tree, "本站讲解").props.value, "已核实的第二站讲解");
  assert.equal(field(tree, "本站地点").props.value, "p2");
  for (const [label, value] of [
    ["标题", "测试校园多站路线"],
    ["来源与公开依据", "测试已核验来源"],
  ]) {
    field(tree, label).props.onChange({ target: { value } });
    tree = render();
  }
  button(tree, "保存草稿").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const body = h.calls.find(
    ([path, method]) => path === "/experiences" && method === "POST",
  )[2];
  assert.equal(body.content.campus_id, "campus-a");
  assert.equal("point_id" in body.content, false);
  assert.deepEqual(
    Array.from(body.content.stops, (stop) => stop.point_id),
    ["p2", "p1"],
  );
  assert.equal(body.content.stops[0].narrative, "已核实的第二站讲解");
});

test("save-and-submit uses the returned revision and retains a saved draft when submission fails", async () => {
  let saved;
  const { h, render } = await routeEditor({
    request: async (path, method, body) => {
      if (path === "/experiences" && method === "POST") {
        saved = {
          id: "saved-route",
          campus_id: "campus-a",
          revision: 7,
          published_revision: 0,
          operation: "upsert",
          state: "draft",
          status: "draft",
          content: body.content,
          published_content: null,
          contributor_ids: ["editor"],
          submitted_by: null,
          review_note: "",
        };
        return { data: saved };
      }
      if (path.endsWith("/review/submit")) throw new Error("暂时不能提交");
      throw new Error("unexpected request");
    },
  });
  let tree = render();
  button(tree, "测试地点甲＋ 加入路线").props.onClick();
  tree = render();
  for (const [label, value] of [
    ["标题", "测试路线"],
    ["来源与公开依据", "资料来源"],
  ]) {
    field(tree, label).props.onChange({ target: { value } });
    tree = render();
  }
  button(tree, "保存并提交审核").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const writes = h.calls.filter(([, method]) => method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0], "/experiences/saved-route/review/submit");
  assert.equal(writes[1][2].expected_revision, 7);
  tree = render();
  assert.equal(button(tree, "保存草稿").props.disabled, true);
  assert.ok(button(tree, "提交审核"));
  assert.ok(
    find(
      tree,
      (node) =>
        typeof node.props?.text === "string" &&
        node.props.text.includes("草稿已保存，但提交审核未完成"),
    ).length,
  );
});

function publishedResource(id, published, overrides = {}) {
  return {
    id,
    campus_id: published.point_id === "p3" ? "campus-b" : "campus-a",
    revision: 3,
    published_revision: 1,
    state: "published",
    status: "published",
    operation: "upsert",
    content: published,
    published_content: published,
    contributor_ids: ["another"],
    submitted_by: null,
    review_note: "",
    ...overrides,
  };
}
const routeVideo = publishedResource("route-video", {
  ...media.content,
  title: "校园视频甲",
});
const routeCheckin = publishedResource("route-checkin", {
  kind: "checkin",
  point_id: "p1",
  title: "校园打卡甲",
  description: "已核实打卡说明",
  source_note: "测试夹具",
  image_id: null,
});

test("route composer adds a published video with its point and combines a matching checkin", async () => {
  const { h, render } = await routeEditor({
    mediaRows: [
      routeVideo,
      publishedResource("wrong-campus", {
        ...media.content,
        point_id: "p3",
        title: "其他校区视频",
      }),
      publishedResource(
        "private-video",
        { ...media.content, title: "待审视频" },
        { status: "draft", published_content: null },
      ),
    ],
    checkinRows: [
      routeCheckin,
      publishedResource("wrong-point", {
        ...routeCheckin.published_content,
        point_id: "p2",
        title: "其他地点打卡",
      }),
    ],
  });
  let tree = render();
  field(tree, "添加来源").props.onChange({ target: { value: "videos" } });
  tree = render();
  const candidates = find(
    tree,
    (node) => node.props?.className === "ad-tour-candidates",
  )[0];
  assert.match(labelText(candidates), /校园视频甲/);
  assert.doesNotMatch(labelText(candidates), /其他校区视频|待审视频/);
  button(tree, "校园视频甲测试地点甲 · ＋ 加入路线").props.onClick();
  tree = render();
  assert.equal(field(tree, "本站地点").props.value, "p1");
  assert.equal(field(tree, "本站视频").props.value, "route-video");
  assert.match(labelText(field(tree, "本站打卡")), /校园打卡甲/);
  assert.doesNotMatch(labelText(field(tree, "本站打卡")), /其他地点打卡/);
  field(tree, "本站打卡").props.onChange({
    target: { value: "route-checkin" },
  });
  tree = render();
  for (const [label, value] of [
    ["标题", "组合路线"],
    ["来源与公开依据", "已核对"],
  ]) {
    field(tree, label).props.onChange({ target: { value } });
    tree = render();
  }
  button(tree, "保存草稿").props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  const stop = h.calls.find(
    ([path, method]) => path === "/experiences" && method === "POST",
  )[2].content.stops[0];
  assert.equal(stop.point_id, "p1");
  assert.equal(stop.video_id, "route-video");
  assert.equal(stop.checkin_id, "route-checkin");
  assert.ok(h.resources.includes("/experiences?kind=media&referenceable=true"));
  assert.ok(
    h.resources.includes("/experiences?kind=checkin&referenceable=true"),
  );
});

test("an independent checkin can add its station and changing the point clears resource references", async () => {
  const checkin = publishedResource("checkin-p2", {
    ...routeCheckin.published_content,
    point_id: "p2",
    title: "独立地点打卡",
  });
  const { render } = await routeEditor({ checkinRows: [checkin] });
  let tree = render();
  field(tree, "添加来源").props.onChange({ target: { value: "checkins" } });
  tree = render();
  button(tree, "独立地点打卡测试地点乙 · ＋ 加入路线").props.onClick();
  tree = render();
  assert.equal(field(tree, "本站地点").props.value, "p2");
  assert.equal(field(tree, "本站打卡").props.value, "checkin-p2");
  field(tree, "本站地点").props.onChange({ target: { value: "p1" } });
  tree = render();
  assert.equal(field(tree, "本站打卡").props.value, "");
  assert.equal(field(tree, "本站视频").props.value, "");
});

test("tour displays the referenced checkin without implying automatic participation", () => {
  const checkin = {
    id: routeCheckin.id,
    revision: 1,
    content: routeCheckin.published_content,
  };
  const h = harness(publicCode);
  const linkedTour = {
    ...tour,
    content: {
      ...tour.content,
      stops: [{ ...tour.content.stops[0], checkin_id: checkin.id }],
    },
  };
  const props = {
    item: linkedTour,
    items: [media, checkin],
    onSelectPoint() {},
  };
  button(h.render("TourPlayer", props), "开始导览").props.onClick();
  let tree = h.render("TourPlayer", props);
  const card = find(tree, (node) => node.type === h.exports.CheckinCard)[0];
  assert.equal(card.props.item, checkin);
  assert.equal(h.persisted.has("twinnku:checkin:route-checkin"), false);
  props.items = [
    media,
    { ...checkin, content: { ...checkin.content, point_id: "p2" } },
  ];
  tree = h.render("TourPlayer", props);
  assert.equal(
    find(tree, (node) => node.type === h.exports.CheckinCard).length,
    0,
  );
  assert.match(labelText(tree), /本站打卡暂时不可用/);
});

test("experience publication controls exist only in the focused review center", async () => {
  const record = {
    ...routeCheckin,
    state: "in_review",
    submitted_by: "another",
  };
  const session = {
    user: { id: "admin", role: "admin" },
    permissions: ["points.edit", "points.review"],
  };
  const calls = [];
  const props = {
    session,
    initialId: record.id,
    onDirty() {},
    onReview: (id) => calls.push(id),
  };
  const editor = harness(adminCode, {}, { record });
  editor.render("ExperienceWorkspace", props);
  editor.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  let tree = editor.render("ExperienceWorkspace", props);
  assert.equal(button(tree, "审核通过并发布"), undefined);
  assert.equal(button(tree, "退回修改"), undefined);
  button(tree, "去审核中心").props.onClick();
  assert.deepEqual(calls, [record.id]);
  const reviewer = harness(adminCode, {}, { record });
  const reviewProps = { ...props, review: true, focused: true };
  reviewer.render("ExperienceWorkspace", reviewProps);
  reviewer.flushEffects();
  await new Promise((resolve) => setImmediate(resolve));
  tree = reviewer.render("ExperienceWorkspace", reviewProps);
  assert.equal(find(tree, (node) => node.type === "aside").length, 0);
  assert.equal(button(tree, "＋打卡点"), undefined);
  assert.equal(button(tree, "保存草稿"), undefined);
  assert.equal(button(tree, "撤回草稿"), undefined);
  assert.equal(button(tree, "审核通过并发布").props.disabled, false);
  assert.ok(button(tree, "退回修改"));
});
