import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addStroke,
  connectCrossing,
  curvePoint,
  edgePath,
  makeHistory,
  moveNode,
  simplify,
  snap,
  splitEdge,
} from "../src/features/admin/roadGeometry.ts";
const n = (id, x, y, extra = {}) => ({
  id,
  position: { x, y },
  label: id,
  kind: "junction",
  point_id: null,
  candidate: false,
  evidence: "",
  ...extra,
});
const e = (id, start, end, extra = {}) => ({
  id,
  start,
  end,
  label: id,
  via: [],
  bidirectional: false,
  closed: false,
  verified: true,
  distance_m: 100,
  evidence: "field inspection",
  step_free: true,
  ...extra,
});
const g = () => ({
  map_revision: 3,
  note: "fixture",
  nodes: [n("a", 0, 0), n("b", 100, 0)],
  edges: [e("ab", "a", "b")],
});
test("curve shape rendered for routing follows control geometry", () => {
  const graph = g();
  graph.edges[0].curve_control = { x: 50, y: 100 };
  const path = edgePath(graph.edges[0], graph);
  assert.equal(path.length, 33);
  assert.deepEqual(path[16], { x: 50, y: 50 });
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path.at(-1), { x: 100, y: 0 });
});
test("curve split preserves Bezier shape, direction and closure, invalidates measured length", () => {
  const graph = g();
  graph.edges[0] = {
    ...graph.edges[0],
    curve_control: { x: 50, y: 100 },
    closed: true,
  };
  const result = splitEdge(graph, "ab", { x: 50, y: 50 });
  assert.equal(result.graph.edges.length, 2);
  for (const edge of result.graph.edges) {
    assert.equal(edge.bidirectional, false);
    assert.equal(edge.closed, true);
    assert.equal(edge.verified, false);
    assert.equal(edge.distance_m, null);
  }
  const left = result.graph.edges[0],
    right = result.graph.edges[1];
  for (let i = 0; i <= 32; i++) {
    const expected = curvePoint(
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 0 },
      i / 32,
    );
    const edge = i <= 16 ? left : right;
    const t = i <= 16 ? i / 16 : (i - 16) / 16;
    const a = result.graph.nodes.find((n) => n.id === edge.start).position,
      b = result.graph.nodes.find((n) => n.id === edge.end).position;
    const actual = curvePoint(a, edge.curve_control, b, t);
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-7);
  }
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
});
test("polyline split keeps bend points on appropriate side", () => {
  const graph = g();
  graph.edges[0].via = [
    { x: 20, y: 30 },
    { x: 80, y: 30 },
  ];
  const r = splitEdge(graph, "ab", { x: 50, y: 30 });
  assert.deepEqual(
    r.graph.edges.map((e) => e.via),
    [[{ x: 20, y: 30 }], [{ x: 80, y: 30 }]],
  );
});
test("new stroke splits existing road with one shared junction", () => {
  const graph = addStroke(
    g(),
    [
      { x: 50, y: 30 },
      { x: 50, y: 1 },
    ],
    3,
  );
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 3);
  const p = graph.nodes.find((n) => n.position.x === 50 && n.position.y === 0);
  assert.equal(
    graph.edges.filter((e) => e.start === p.id || e.end === p.id).length,
    3,
  );
});
test("snapping uses tolerance and prefers existing junction", () => {
  const graph = g();
  assert.equal(snap(graph, { x: 1, y: 1 }, 3).nodeId, "a");
  assert.equal(snap(graph, { x: 50, y: 5 }, 3).edgeId, null);
  assert.equal(snap(graph, { x: 50, y: 2 }, 3).edgeId, "ab");
});
test("crossing connection joins two roads with one junction", () => {
  const graph = g();
  graph.nodes.push(n("c", 50, -50), n("d", 50, 50));
  graph.edges.push(e("cd", "c", "d"));
  const r = connectCrossing(graph, ["ab", "cd"], { x: 50, y: 0 });
  assert.equal(r.nodes.length, 5);
  assert.equal(r.edges.length, 4);
  const mid = r.nodes.find((n) => n.position.x === 50 && n.position.y === 0);
  assert.equal(
    r.edges.filter((e) => e.start === mid.id || e.end === mid.id).length,
    4,
  );
});
test("distinct coincident endpoint IDs merge into a real junction", () => {
  const graph = g();
  graph.nodes.push(n("c", 100, 0), n("d", 100, 50));
  graph.edges.push(e("cd", "c", "d"));
  const r = connectCrossing(graph, ["ab", "cd"], { x: 100, y: 0 });
  assert.equal(r.nodes.length, 3);
  assert.ok(r.edges.some((e) => e.end === r.edges[1].start));
});
test("moving entrance preserves association and marks candidate", () => {
  const graph = g();
  graph.nodes[0] = {
    ...graph.nodes[0],
    kind: "entrance",
    point_id: "building",
  };
  const r = moveNode(graph, "a", { x: 10, y: 10 }, 0);
  assert.equal(r.nodes[0].candidate, true);
  assert.equal(r.nodes[0].point_id, "building");
  assert.equal(r.edges[0].distance_m, null);
});
test("different building entrances cannot merge", () => {
  const graph = g();
  graph.nodes[0] = { ...graph.nodes[0], kind: "entrance", point_id: "one" };
  graph.nodes[1] = { ...graph.nodes[1], kind: "entrance", point_id: "two" };
  assert.throws(() => moveNode(graph, "a", { x: 100, y: 0 }, 5), /不同建筑/);
  assert.equal(graph.nodes.length, 2);
});
test("loose endpoint dragged onto road becomes its junction", () => {
  const graph = g();
  graph.nodes.push(n("c", 50, 50), n("d", 50, 20));
  graph.edges.push(e("cd", "c", "d"));
  const r = moveNode(graph, "d", { x: 50, y: 2 }, 4);
  assert.equal(r.nodes.length, 4);
  assert.equal(r.edges.length, 3);
  assert.equal(
    r.edges.filter((e) => e.start === "d" || e.end === "d").length,
    3,
  );
});
test("freehand simplification removes noise and keeps corners", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0.1 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 20, y: 20 },
  ];
  assert.deepEqual(simplify(points, 1), [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
  ]);
});
test("undo and redo restore whole topology as a single edit", () => {
  const original = g(),
    h = makeHistory(original);
  const next = addStroke(
    original,
    [
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ],
    2,
  );
  h.change(next);
  assert.equal(h.current.edges.length, 3);
  assert.equal(h.undo(), original);
  assert.equal(h.redo(), next);
  h.undo();
  h.change({ ...original, note: "other" });
  assert.equal(h.canRedo, false);
  h.reset(original);
  assert.equal(h.canUndo, false);
});
