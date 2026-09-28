import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as progress from "../src/features/experiences/progress.ts";

const names = { media: "图片与视频", checkin: "打卡点", tour: "定制路线" };
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
    calls = [];
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
    window: { confirm: () => true },
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
      if (name.endsWith("/client"))
        return { get: async () => ({ data: overrides.publicRows ?? [] }) };
      if (name.endsWith("catalogSync"))
        return {
          notifyCatalogPublished() {},
          watchCatalogChanges: () => () => {},
        };
      if (name === "./api")
        return {
          request: async (...args) => {
            calls.push(args);
            return { data: overrides.record };
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
          useResource: (path) => ({
            data: {
              data: path.startsWith("/experiences")
                ? (overrides.rows ?? [])
                : [],
            },
            loading: false,
            error: "",
          }),
        };
      throw new Error(name);
    },
  });
  return {
    exports,
    persisted,
    calls,
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
const tour = {
  id: "tour",
  revision: 2,
  content: {
    kind: "tour",
    point_id: "p1",
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
  assert.equal(button(tree, "定制路线").props["aria-pressed"], false);
  assert.equal(props.initialExperienceId, "");
});
