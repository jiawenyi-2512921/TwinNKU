import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as external from "../src/features/points/panorama.ts";
import { loadCatalog } from "../src/features/map/catalog.ts";

const compile = (name) =>
  ts.transpileModule(readFileSync(new URL(name, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const helpers = {};
vm.runInNewContext(compile("../src/features/places/panoramas.ts"), {
  exports: helpers,
  URL,
  Error,
  require: () => external,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (n, extra = {}) => ({
  id: `vr-${n}`,
  point_id: `point-${n}`,
  campus_id: "nku-jinnan",
  point_name: "同名景点",
  point_category: "public_area",
  title: "湖畔",
  description: "",
  revision: 1,
  url: `https://stjgpt.nankai.edu.cn/index-jn.php#scene_${n}/-1/2/3`,
  ...extra,
});
const envelope = (data, total = data.length, page = 1) => ({
  data,
  meta: { pagination: { page, page_size: 100, total } },
});
const walk = (node, predicate) =>
  Array.isArray(node)
    ? node.flatMap((n) => walk(n, predicate))
    : !node || typeof node !== "object"
      ? []
      : [
          ...(predicate(node) ? [node] : []),
          ...walk(node.props?.children, predicate),
        ];
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node?.props
        ? text(node.props.children)
        : "";

test("VR filters use actual categories, campus, safe URLs and source scene IDs", () => {
  const items = [
    row(1, { title: "教学楼外广场" }),
    row(2, { point_category: "academic", title: "湖畔" }),
    row(3, { point_category: "history" }),
    row(4, { campus_id: "nku-other" }),
    row(5, { url: "javascript:alert(1)" }),
  ];
  assert.deepEqual(
    helpers.findPanoramas(items, "nku-jinnan", "", "outdoor").map((r) => r.id),
    ["vr-1"],
  );
  assert.deepEqual(
    helpers.findPanoramas(items, "nku-jinnan", "", "building").map((r) => r.id),
    ["vr-2"],
  );
  assert.deepEqual(
    helpers
      .findPanoramas(items, "nku-jinnan", "scene_3", "all")
      .map((r) => r.id),
    ["vr-3"],
  );
  assert.equal(helpers.panoramaScene(items[0].url), "scene_1");
});

test("VR reads every page and rejects incomplete, duplicate and mixed-campus catalogs", async () => {
  const data = Array.from({ length: 135 }, (_, i) => row(i));
  const pages = [];
  const source = {
    campusPanoramas: async (_campus, _signal, page) => {
      pages.push(page);
      return envelope(data.slice((page - 1) * 100, page * 100), 135, page);
    },
  };
  assert.equal(
    (
      await helpers.loadPanoramaDirectory(
        source,
        "nku-jinnan",
        new AbortController().signal,
      )
    ).length,
    135,
  );
  assert.deepEqual(pages, [1, 2]);
  for (const invalid of [
    envelope([row(1)], 2),
    envelope([row(1), row(1)]),
    envelope([row(1, { campus_id: "nku-other" })]),
  ])
    await assert.rejects(
      helpers.loadPanoramaDirectory(
        { campusPanoramas: async () => invalid },
        "nku-jinnan",
        new AbortController().signal,
      ),
    );
});

function component() {
  let position = 0,
    props,
    refresh;
  const slots = [],
    pending = [],
    cleanups = new Map(),
    reads = [],
    located = [];
  const react = {
    useState(initial) {
      const key = position++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (next) => {
          slots[key] = typeof next === "function" ? next(slots[key]) : next;
        },
      ];
    },
    useEffect(effect, deps) {
      const key = position++;
      if (!slots[key] || deps.some((v, i) => slots[key][i] !== v)) {
        slots[key] = deps;
        pending.push(() => {
          cleanups.get(key)?.();
          cleanups.set(key, effect());
        });
      }
    },
  };
  const exports = {};
  vm.runInNewContext(compile("../src/features/places/PanoramaDirectory.tsx"), {
    exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/client"))
        return {
          api: {
            campusPanoramas: (campus, signal, page) =>
              new Promise((resolve, reject) =>
                reads.push({ campus, signal, page, resolve, reject }),
              ),
          },
        };
      if (name.endsWith("/catalogSync"))
        return {
          watchCatalogChanges: (callback) => {
            refresh = callback;
            return () => {
              refresh = undefined;
            };
          },
        };
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name.endsWith("/PointDetails"))
        return {
          categoryLabels: {
            public_area: "公共空间",
            academic: "教学建筑",
            landscape: "自然景观",
          },
        };
      if (name === "./panoramas") return helpers;
      if (name.endsWith("/panorama")) return external;
      if (name.endsWith(".css")) return {};
      throw new Error(name);
    },
    AbortController,
  });
  const render = (next) => {
    props = next ??
      props ?? {
        campus: { id: "nku-jinnan", name: "津南校区" },
        query: "",
        locatedPointIds: ["point-1"],
        onLocate: (id) => located.push(id),
      };
    position = 0;
    const tree = exports.PanoramaDirectory(props);
    while (pending.length) pending.shift()();
    return tree;
  };
  return {
    render,
    reads,
    located,
    refresh: () => refresh(),
    dispose: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

test("directory separately locates mapped places and opens the complete HTTPS URL with safe new-tab attributes", async () => {
  const c = component();
  assert.match(text(c.render()), /正在读取已发布全景/);
  c.reads[0].resolve(envelope([row(1), row(2)]));
  await tick();
  const tree = c.render();
  const links = walk(tree, (n) => n.type === "a");
  assert.equal(links[0].props.href, row(1).url);
  assert.equal(links[0].props.target, "_blank");
  assert.equal(links[0].props.rel, "noopener noreferrer");
  assert.match(links[0].props["aria-label"], /scene_1.*新标签页/);
  assert.equal(walk(tree, (n) => n.type === "iframe").length, 0);
  const buttons = walk(
    tree,
    (n) => n.type === "button" && n.props["data-place-result"] !== undefined,
  );
  assert.equal(buttons[0].props.disabled, false);
  buttons[0].props.onClick();
  assert.deepEqual(c.located, ["point-1"]);
  assert.equal(buttons[1].props.disabled, true);
  assert.match(text(tree), /此地点暂无当前底图定位/);
  c.dispose();
});

test("same-campus refresh preserves cards while disabling stale actions; errors and retry are usable", async () => {
  const c = component();
  c.render();
  c.reads[0].resolve(envelope([row(1)]));
  await tick();
  const initial = c.render();
  const initialCard = walk(initial, (n) => n.type === "li")[0];
  assert.equal(walk(initial, (n) => n.type === "a").length, 1);
  c.refresh();
  let tree = c.render();
  assert.equal(walk(tree, (n) => n.type === "li")[0].key, initialCard.key);
  let link = walk(tree, (n) => n.type === "a")[0];
  assert.equal(link.props.href, undefined);
  assert.equal(link.props["aria-disabled"], true);
  assert.equal(
    walk(tree, (n) => n.props?.["data-place-result"] !== undefined)[0].props
      .disabled,
    true,
  );
  assert.match(text(tree), /正在核验全景目录/);
  c.reads[1].reject(new Error("offline"));
  await tick();
  tree = c.render();
  assert.match(text(tree), /暂时无法读取全景目录/);
  assert.equal(walk(tree, (n) => n.type === "li")[0].key, initialCard.key);
  assert.equal(walk(tree, (n) => n.type === "a")[0].props.href, undefined);
  const retry = walk(
    tree,
    (n) => n.type === "button" && text(n) === "重新加载全景",
  )[0];
  retry.props.onClick();
  c.render();
  c.reads[2].resolve(envelope([]));
  await tick();
  tree = c.render();
  assert.match(text(tree), /本校区暂无已发布全景/);
  c.dispose();
});

test("same-name views use source scenes and stable entry order without exposing database IDs", async () => {
  const c = component();
  c.render();
  c.reads[0].resolve(
    envelope([
      row(1, { id: "secret-database-id-abcdefgh" }),
      row(1, { id: "secret-database-id-ijklmnop" }),
      row(2, { id: "secret-database-id-qrstuvwx" }),
    ]),
  );
  await tick();
  let tree = c.render();
  assert.match(text(tree), /scene_1 · 入口 1/);
  assert.match(text(tree), /scene_1 · 入口 2/);
  assert.match(text(tree), /scene_2/);
  assert.doesNotMatch(text(tree), /secret-database|abcdefgh|ijklmnop|qrstuvwx/);
  const filter = walk(
    tree,
    (n) => n.type === "button" && text(n) === "室外景点",
  )[0];
  filter.props.onClick();
  c.refresh();
  tree = c.render();
  assert.equal(
    walk(tree, (n) => n.type === "button" && text(n) === "室外景点")[0].props[
      "aria-pressed"
    ],
    true,
  );
  c.reads[1].resolve(
    envelope([
      row(1, { id: "secret-database-id-abcdefgh" }),
      row(1, { id: "secret-database-id-ijklmnop" }),
    ]),
  );
  await tick();
  tree = c.render();
  assert.match(text(tree), /scene_1 · 入口 2/);
  assert.equal(walk(tree, (n) => n.type === "a")[0].props.href, row(1).url);
  c.dispose();
});

test("campus changes and unmount abort reads and reject late previous-campus results", async () => {
  const c = component();
  c.render();
  const next = {
    campus: { id: "nku-other", name: "其他校区" },
    query: "",
    locatedPointIds: [],
    onLocate: () => assert.fail(),
  };
  assert.equal(walk(c.render(next), (n) => n.type === "a").length, 0);
  assert.equal(c.reads[0].signal.aborted, true);
  c.reads[0].resolve(envelope([row(1)]));
  await tick();
  assert.equal(walk(c.render(), (n) => n.type === "a").length, 0);
  c.dispose();
  assert.equal(c.reads[1].signal.aborted, true);
});

test("missing campus has separate pending, empty and retryable error states without sending a VR read", () => {
  const c = component();
  let retries = 0;
  const props = {
    campus: null,
    query: "",
    locatedPointIds: [],
    onLocate: () => assert.fail(),
    onRetryCampus: () => retries++,
  };
  assert.match(
    text(c.render({ ...props, campusStatus: "loading" })),
    /正在读取校区/,
  );
  let tree = c.render({ ...props, campusStatus: "error" });
  assert.match(text(tree), /暂时无法读取校区资料/);
  walk(tree, (n) => n.type === "button")[0].props.onClick();
  assert.equal(retries, 1);
  tree = c.render({ ...props, campusStatus: "empty" });
  assert.match(text(tree), /暂无公开校区资料/);
  assert.equal(c.reads.length, 0);
  c.dispose();
});

test("map catalog includes all 135 published mapped places and checks abortion after later pages", async () => {
  const points = Array.from({ length: 135 }, (_, i) => ({
    id: `point-${i}`,
    campus_id: "nku-jinnan",
    name: `地点${i}`,
  }));
  const source = {
    campuses: async () => ({ data: [{ id: "nku-jinnan" }] }),
    maps: async () => ({
      data: [{ id: "map", revision: 3, kind: "campus", tiles: {} }],
    }),
    mapFeatures: async () => ({
      data: {
        map_id: "map",
        map_revision: 3,
        points: points.map((p) => ({ point_id: p.id })),
      },
    }),
    points: async (_campus, _query, _signal, page = 1) => ({
      data: points.slice((page - 1) * 100, page * 100),
      meta: { pagination: { total: 135 } },
    }),
  };
  const catalog = await loadCatalog(source, new AbortController().signal);
  assert.equal(catalog.points.length, 135);
  assert.equal(
    catalog.points.some((p) => p.id === "point-134"),
    true,
  );
  const controller = new AbortController();
  source.points = async (_campus, _query, _signal, page = 1) => {
    if (page === 2) controller.abort();
    return {
      data: points.slice((page - 1) * 100, page * 100),
      meta: { pagination: { total: 135 } },
    };
  };
  await assert.rejects(loadCatalog(source, controller.signal), {
    name: "AbortError",
  });
});
