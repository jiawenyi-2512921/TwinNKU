import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(get) {
  const calls = [],
    MapCanvas = () => null;
  const h = controlledAdmin({
    "../../shared/api/client": {
      get: async (...args) => {
        calls.push(args);
        return get(...args);
      },
    },
    "../map/MapCanvas": { MapCanvas },
    "./api": { message: (error) => error.message },
  });
  return {
    ...h,
    calls,
    MapCanvas,
    Component: h.load("./AdminTourMapPreview").default,
  };
}
async function ready(h, props) {
  let tree;
  for (let round = 0; round < 4; round++) {
    tree = h.render("map", h.Component, props);
    await settle();
  }
  return h.render("map", h.Component, props);
}
test("private tour map reads all published point pages and uses the exact shared viewer without visitor viewport writes", async () => {
  const info = {
    id: "real-map",
    campus_id: "campus",
    kind: "campus",
    title: "真实校园底图",
    revision: 7,
    tiles: {},
  };
  const features = {
    map_id: info.id,
    map_revision: 7,
    points: [{ point_id: "target" }],
  };
  const h = setup(async (path) =>
    path.includes("/maps?kind=campus")
      ? { data: [info], meta: {} }
      : path.includes("/features")
        ? { data: features, meta: {} }
        : {
            data: Array.from(
              { length: path.includes("page=1&") ? 100 : 35 },
              (_, index) => ({ id: `${path}:${index}`, campus_id: "campus" }),
            ),
            meta: {
              pagination: {
                page: path.includes("page=1&") ? 1 : 2,
                page_size: 100,
                total: 135,
              },
            },
          },
  );
  const props = { campusId: "campus", pointId: "target" };
  let tree = await ready(h, props);
  const canvas = find(tree, (node) => node.type === h.MapCanvas)[0];
  assert.ok(canvas);
  assert.equal(canvas.props.points.length, 135);
  assert.equal(canvas.props.previewOnly, true);
  assert.equal(canvas.props.info.id, "real-map");
  assert.equal(canvas.props.selectedId, "target");
  assert.equal(h.calls.length, 4);
  assert.equal(
    h.calls.some(([path]) =>
      /admin|voice|narration|assistant|navigation/.test(path),
    ),
    false,
  );
  props.pointId = "other-point";
  tree = h.render("map", h.Component, props);
  assert.equal(h.calls.length, 4);
  assert.equal(
    find(tree, (node) => node.type === h.MapCanvas)[0].props.selectedId,
    "other-point",
  );
  assert.match(text(tree), /没有当前底图上的公开几何/);
  h.dispose();
});
test("a failed published feature read preserves the staff route and offers a bounded read retry without made-up geometry", async () => {
  let failed = true;
  const h = setup(async (path) => {
    if (path.includes("/maps?"))
      return {
        data: [{ id: "real-map", title: "真实底图", revision: 1 }],
        meta: {},
      };
    if (path.includes("/features")) {
      if (failed) throw new Error("真实读取故障夹具");
      return {
        data: { map_id: "real-map", map_revision: 1, points: [] },
        meta: {},
      };
    }
    return { data: [], meta: {} };
  });
  const props = { campusId: "campus", pointId: "not-public" };
  let tree = await ready(h, props);
  assert.equal(find(tree, (node) => node.type === h.MapCanvas).length, 0);
  const error = find(
    tree,
    (node) =>
      typeof node.type === "function" && node.props.text === "真实读取故障夹具",
  )[0];
  assert.ok(error);
  failed = false;
  error.props.onRetry();
  tree = await ready(h, props);
  assert.equal(find(tree, (node) => node.type === h.MapCanvas).length, 1);
  assert.match(text(tree), /没有当前底图上的公开几何/);
  assert.equal(
    h.calls.every(([, signal]) => signal instanceof AbortSignal),
    true,
  );
  h.dispose();
});
