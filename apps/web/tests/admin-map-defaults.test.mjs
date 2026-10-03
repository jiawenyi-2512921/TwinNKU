import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
import * as mapDefaults from "../src/features/map/mapDefaults.ts";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (data) => JSON.parse(JSON.stringify(data));
const baseMap = {
  id: "map",
  revision: 3,
  campus_id: "campus",
  title: "真实测试底图",
  kind: "campus",
  width_px: 800,
  height_px: 600,
  tiles: { min_zoom: 0, max_native_zoom: 3 },
};
const savedView = {
  map_id: "map",
  map_revision: 3,
  center: { x: 100, y: 200 },
  zoom: -1,
  min_zoom: -3,
  max_zoom: 4,
};
const value = {
  kind: "visit_defaults",
  map_default_view: null,
  map_layers: ["point_regions"],
  map_show_labels: true,
  map_focus_effect: "short",
};
const field = (tree, label) =>
  find(
    tree,
    (node) => node.type === "label" && text(node).startsWith(label),
  ).flatMap((node) =>
    find(node, (child) => ["select", "input"].includes(child.type)),
  )[0];
function setup(options = {}) {
  const changes = [],
    inherits = [],
    calls = [],
    MapCanvas = () => null;
  const h = controlledAdmin({
    "../map/MapCanvas": { MapCanvas },
    "../map/mapDefaults": mapDefaults,
    "../../shared/api/client": {
      get: async (path, signal) => {
        calls.push({ path, signal });
        if (options.get) return options.get(path, signal);
        if (path.includes("features"))
          return {
            data: {
              map_id: "map",
              map_revision: options.featureRevision ?? 3,
              points: [],
            },
            meta: {},
          };
        const page = Number(
          new URLSearchParams(path.split("?")[1]).get("page"),
        );
        return {
          data: [{ id: `point-${page}` }],
          meta: {
            pagination: { total: options.total ?? 101, page_size: 100, page },
          },
        };
      },
    },
    "./api": {
      message: (e) => e.message,
      request: async (path, method, body, signal) => {
        calls.push({ path, method, body, signal });
        if (options.request) return options.request(path, method, body, signal);
        return {
          data: [
            baseMap,
            { ...baseMap, id: "outside", campus_id: "outside" },
            { ...baseMap, id: "floor", kind: "floor" },
            { ...baseMap, id: "missing-tiles", tiles: null },
          ],
        };
      },
    },
    "./ui": { ErrorBox: (props) => props.text },
  });
  const component = h.load("./MapDefaultsEditor").MapDefaultsEditor;
  const props = {
    campusId: "campus",
    scope: "campus",
    value,
    overrides: [],
    ...options.props,
    onChange: (patch) => changes.push(patch),
    onInherit: (key) => inherits.push(key),
  };
  const render = () => h.render("map-editor", component, props);
  const canvas = (tree) => find(tree, (node) => node.type === MapCanvas)[0];
  async function ready() {
    render();
    await settle();
    render();
    await settle();
    return render();
  }
  return { ...h, props, changes, inherits, calls, render, canvas, ready };
}
test("staff map selection reads authorized actual metadata and all published point pages without adopting a view", async () => {
  const h = setup();
  const tree = await h.ready();
  const options = find(field(tree, "真实公开底图"), (n) => n.type === "option");
  assert.deepEqual(
    options.map((n) => n.props.value),
    ["map"],
  );
  assert.match(text(options), /v3.*800×600/);
  assert.equal(h.canvas(tree).props.previewOnly, true);
  assert.equal(h.canvas(tree).props.points.length, 2);
  assert.deepEqual(
    h.calls
      .filter((c) => c.path.includes("points?"))
      .map((c) => new URLSearchParams(c.path.split("?")[1]).get("page")),
    ["1", "2"],
  );
  assert.deepEqual(h.changes, []);
  assert.equal(
    h.calls.every((c) => !c.method || c.method === "GET"),
    true,
  );
  h.dispose();
});
test("capture requires measured current pixels, exact map revision and finite ordered camera limits", async () => {
  const h = setup();
  let tree = await h.ready();
  assert.equal(button(tree, "采用当前地图视角").props.disabled, true);
  const measure = h.canvas(tree).props.onViewportChange;
  for (const measured of [
    { ...savedView, map_id: "other" },
    { ...savedView, map_revision: 2 },
    { ...savedView, center: { x: -1, y: 2 } },
    { ...savedView, zoom: Number.NaN },
  ]) {
    measure(measured);
    tree = h.render();
    assert.equal(button(tree, "采用当前地图视角").props.disabled, true);
  }
  measure(savedView);
  tree = h.render();
  field(tree, "访客允许的最小缩放").props.onChange({ target: { value: "" } });
  tree = h.render();
  assert.equal(button(tree, "采用当前地图视角").props.disabled, true);
  field(tree, "访客允许的最小缩放").props.onChange({ target: { value: "-2" } });
  tree = h.render();
  field(tree, "访客允许的最大缩放").props.onChange({ target: { value: "5" } });
  tree = h.render();
  assert.equal(button(tree, "采用当前地图视角").props.disabled, true);
  field(tree, "访客允许的最大缩放").props.onChange({ target: { value: "4" } });
  tree = h.render();
  button(tree, "采用当前地图视角").props.onClick();
  assert.equal(h.changes.length, 1);
  assert.deepEqual(plain(h.changes[0]), {
    map_default_view: { ...savedView, min_zoom: -2 },
  });
  measure({ ...savedView, center: { x: 801, y: 10 } });
  tree = h.render();
  assert.equal(
    button(tree, "采用当前地图视角").props.disabled,
    true,
    "out-of-bounds latest view cannot adopt previous valid pixels",
  );
  h.dispose();
});
test("explicit fit, inherited null and read-only preview remain separate actions", async () => {
  const h = setup({
    props: {
      value: { ...value, map_default_view: savedView },
      effective: { ...value, map_default_view: null },
      sources: { map_default_view: "global" },
    },
  });
  let tree = await h.ready();
  assert.equal(h.canvas(tree).props.defaultView, null);
  assert.match(text(tree), /继承已审全站设置.*适合全图/);
  button(tree, "查看全图（仅预览）").props.onClick();
  tree = h.render();
  assert.deepEqual(h.changes, []);
  button(tree, "设置为适合全图").props.onClick();
  assert.deepEqual(plain(h.changes), [{ map_default_view: null }]);
  h.props.overrides = ["map_default_view"];
  tree = h.render();
  button(tree, "恢复继承视角").props.onClick();
  assert.deepEqual(h.inherits, ["map_default_view"]);
  h.props.disabled = true;
  tree = h.render();
  assert.equal(button(tree, "设置为适合全图").props.disabled, true);
  assert.equal(button(tree, "恢复继承视角").props.disabled, true);
  h.dispose();
});
test("only registered regions, independent labels and reduced-motion-compatible focus presets are editable", async () => {
  const h = setup({
    props: {
      effective: {
        ...value,
        map_layers: [],
        map_show_labels: false,
        map_focus_effect: "instant",
      },
      sources: {
        map_layers: "builtin",
        map_show_labels: "global",
        map_focus_effect: "campus",
      },
    },
  });
  const tree = await h.ready();
  assert.equal(h.canvas(tree).props.showRegions, false);
  assert.equal(h.canvas(tree).props.showLabels, false);
  assert.equal(h.canvas(tree).props.focusEffect, "instant");
  field(tree, "显示地点区域覆盖层").props.onChange({
    target: { checked: true },
  });
  field(tree, "默认显示地图名称").props.onChange({ target: { checked: true } });
  field(tree, "定位效果").props.onChange({ target: { value: "short" } });
  assert.deepEqual(plain(h.changes), [
    { map_layers: ["point_regions"] },
    { map_show_labels: true },
    { map_focus_effect: "short" },
  ]);
  assert.match(text(tree), /必要导航始终保留/);
  assert.match(text(tree), /减少动态效果/);
  h.dispose();
});
test("map revision races fail closed and do not show a geometry snapshot from a different base", async () => {
  const h = setup({ featureRevision: 4 });
  const tree = await h.ready();
  assert.equal(h.canvas(tree), undefined);
  assert.equal(button(tree, "采用当前地图视角"), undefined);
  assert.equal(
    h.calls.some((c) => c.path.includes("points?")),
    false,
  );
  assert.deepEqual(h.changes, []);
  const error = find(
    tree,
    (node) => typeof node.type === "function" && node.props.text,
  )[0];
  assert.match(error.props.text, /底图版本/);
  h.dispose();
});
test("a late authorized metadata response for a previous campus is cancelled before it can supply capture candidates", async () => {
  let resolve;
  const h = setup({
    request: (path, method, body, signal) =>
      signal.aborted
        ? Promise.resolve({ data: [] })
        : new Promise((done) => {
            resolve = done;
          }),
  });
  h.render();
  const firstResolve = resolve,
    firstSignal = h.calls[0].signal;
  h.props.campusId = "outside";
  h.render();
  assert.equal(firstSignal.aborted, true);
  firstResolve({ data: [baseMap] });
  await settle();
  const tree = h.render();
  assert.equal(h.canvas(tree), undefined);
  assert.equal(
    h.calls.some((c) => c.path.includes("features")),
    false,
  );
  assert.deepEqual(h.changes, []);
  h.dispose();
});
