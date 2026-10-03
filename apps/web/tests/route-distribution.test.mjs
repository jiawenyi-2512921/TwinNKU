import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const catalog = {};
vm.runInNewContext(compile("../src/features/map/catalog.ts"), {
  exports: catalog,
  DOMException,
});
const component = compile("../src/features/visit/RouteDistribution.tsx");
const walk = (node, match) =>
  Array.isArray(node)
    ? node.flatMap((child) => walk(child, match))
    : node && typeof node === "object"
      ? [...(match(node) ? [node] : []), ...walk(node.props?.children, match)]
      : [];
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join("")
    : node && typeof node === "object"
      ? text(node.props?.children)
      : typeof node === "string"
        ? node
        : "";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const MapCanvas = () => null;
function harness(options = {}) {
  const slots = [],
    effects = [],
    reads = [],
    watchers = new Set();
  let cursor = 0,
    queued = [],
    dirty = false;
  const react = {
    lazy: () => MapCanvas,
    Suspense: Symbol("Suspense"),
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value) => {
          const next = typeof value === "function" ? value(slots[i]) : value;
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
  const point = (id, campus_id = "second") => ({
    id,
    campus_id,
    name: `地点 ${id}`,
    category: "public_area",
  });
  const info = {
    id: "actual-map",
    campus_id: "second",
    kind: "campus",
    revision: 3,
    tiles: { max_native_zoom: 3 },
    width_px: 800,
    height_px: 600,
  };
  const features = {
    map_id: info.id,
    map_revision: info.revision,
    points: ["a", "b", "other"].map((point_id) => ({
      point_id,
      map_id: info.id,
      map_revision: info.revision,
      anchor: { x: 20, y: 40 },
      polygon: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 20, y: 30 },
      ],
    })),
  };
  const api = {
    async campuses(signal) {
      reads.push({ type: "campuses", signal });
      return { data: [{ id: "nku-jinnan" }, { id: "second" }], meta: {} };
    },
    async maps(campusId, signal) {
      reads.push({ type: "maps", campusId, signal });
      if (options.deferMap) return options.deferMap(signal);
      if (options.fail) throw Error("unavailable");
      return { data: [info] };
    },
    async mapFeatures(id, signal) {
      reads.push({ type: "features", id, signal });
      return { data: options.features ?? features };
    },
    async points(campusId, _, signal, page = 1) {
      reads.push({ type: "points", campusId, page, signal });
      return {
        data:
          page === 1
            ? [point("a"), point("other")]
            : [point("b"), point("private-cross-campus", "wrong")],
        meta: { pagination: { total: 4 } },
      };
    },
  };
  const exported = {};
  vm.runInNewContext(component, {
    exports: exported,
    AbortController,
    Set,
    Error,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/client")) return { api };
      if (name.endsWith("/catalog")) return catalog;
      if (name.endsWith("/catalogSync"))
        return {
          watchCatalogChanges(fn) {
            watchers.add(fn);
            return () => watchers.delete(fn);
          },
        };
      throw Error(name);
    },
  });
  const props = {
      campusId: "second",
      pointIds: ["a", "b", "missing", "private-cross-campus"],
      onSelect: (id) => selected.push(id),
    },
    selected = [];
  let tree;
  const render = () => {
    let n = 0;
    do {
      assert.ok(n++ < 25);
      cursor = 0;
      queued = [];
      dirty = false;
      tree = exported.RouteDistribution(props);
      queued.forEach((fn) => fn());
    } while (dirty);
    return tree;
  };
  const button = (label) =>
    walk(tree, (node) => node.type === "button" && text(node) === label)[0];
  return {
    props,
    reads,
    watchers,
    selected,
    options,
    render,
    button,
    map: () => walk(tree, (node) => node.type === MapCanvas)[0],
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}

test("route distribution loads only on request, uses all current-campus pages and real geometry, and never draws walk lines", async () => {
  const h = harness();
  try {
    h.render();
    assert.equal(h.reads.length, 0);
    h.button("查看地点地图").props.onClick();
    h.render();
    await tick();
    h.render();
    assert.equal(h.reads.find((row) => row.type === "maps").campusId, "second");
    assert.deepEqual(
      h.reads.filter((row) => row.type === "points").map((row) => row.page),
      [1, 2],
    );
    const map = h.map();
    assert.ok(map);
    assert.equal(map.props.info.id, "actual-map");
    assert.deepEqual(
      Array.from(map.props.points, (row) => row.id),
      ["a", "b"],
    );
    assert.deepEqual(
      Array.from(map.props.features.points, (row) => row.point_id),
      ["a", "b"],
    );
    assert.equal(map.props.routeSegments, undefined);
    assert.equal(map.props.previewOnly, true);
    assert.equal(map.props.showLabels, false);
    assert.deepEqual(Array.from(map.props.highlightedPointIds), ["a", "b"]);
    map.props.onSelect("other");
    assert.deepEqual(h.selected, []);
    map.props.onSelect("b");
    h.render();
    assert.deepEqual(h.selected, ["b"]);
    assert.match(text(h.render()), /部分站点尚无/);
    const originalInfo = h.map().props.info;
    [...h.watchers][0]();
    h.render();
    assert.ok(h.map(), "poll does not unmount the actual map");
    await tick();
    h.render();
    assert.equal(
      h.map().props.info,
      originalInfo,
      "unchanged publication retains Leaflet identity",
    );
    h.button("收起地点地图").props.onClick();
    h.render();
    assert.equal(h.map(), undefined);
    assert.equal(h.watchers.size, 0);
  } finally {
    h.dispose();
  }
});
test("distribution errors and mismatched map revisions do not silently replace current route locations", async () => {
  const options = { fail: true };
  const h = harness(options);
  try {
    h.render();
    h.button("查看地点地图").props.onClick();
    h.render();
    await tick();
    assert.match(text(h.render()), /暂时无法读取/);
    assert.equal(h.map(), undefined);
    options.fail = false;
    h.button("重试地点地图").props.onClick();
    h.render();
    await tick();
    h.render();
    assert.ok(h.map());
    options.features = { map_id: "actual-map", map_revision: 999, points: [] };
    [...h.watchers][0]();
    await tick();
    h.render();
    assert.equal(h.map(), undefined);
    assert.match(text(h.render()), /暂时无法读取/);
  } finally {
    h.dispose();
  }
});
test("collapsing distribution cancels an in-flight public read and a late map cannot reopen it", async () => {
  let resolve;
  const h = harness({
    deferMap: () => new Promise((done) => (resolve = done)),
  });
  try {
    h.render();
    h.button("查看地点地图").props.onClick();
    h.render();
    await tick();
    const pending = h.reads.find((row) => row.type === "maps");
    h.button("收起地点地图").props.onClick();
    h.render();
    assert.equal(pending.signal.aborted, true);
    resolve({ data: [] });
    await tick();
    h.render();
    assert.equal(h.map(), undefined);
    assert.equal(h.watchers.size, 0);
  } finally {
    h.dispose();
  }
});
