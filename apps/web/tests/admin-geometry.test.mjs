import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPoint,
  moveGeometry,
  rectangle,
  validPolygon,
} from "../src/features/admin/geometry.ts";

test("moving a point translates its clickable polygon and keeps map metadata and the input intact", () => {
  const value = {
    map_id: "map",
    map_revision: 3,
    label_on_map: false,
    anchor: { x: 50, y: 40 },
    polygon: rectangle({ x: 20, y: 20 }, { x: 80, y: 60 }),
  };
  const before = structuredClone(value);
  const moved = moveGeometry(value, { x: 150, y: 170 }, 8279, 5604);
  assert.deepEqual(
    moved.polygon,
    rectangle({ x: 120, y: 150 }, { x: 180, y: 190 }),
  );
  assert.deepEqual(moved.anchor, { x: 150, y: 170 });
  assert.equal(moved.label_on_map, false);
  assert.equal(moved.map_revision, 3);
  assert.deepEqual(value, before);
});

test("a move cannot silently clip the polygon at an image boundary", () => {
  const value = {
    anchor: { x: 50, y: 40 },
    polygon: rectangle({ x: 20, y: 20 }, { x: 80, y: 60 }),
  };
  for (const target of [
    { x: 10, y: 40 },
    { x: 90, y: 40 },
    { x: 50, y: 10 },
    { x: 50, y: 90 },
    { x: NaN, y: 50 },
  ])
    assert.throws(() => moveGeometry(value, target, 100, 100));
  const exact = moveGeometry(value, { x: 70, y: 80 }, 100, 100);
  assert.equal(validPolygon(exact.polygon, 100, 100), null);
  assert.deepEqual(exact.polygon[2], { x: 100, y: 100 });
});

test("rectangle works when drawn from any corner and retains native image coordinates", () => {
  const forward = rectangle({ x: 80, y: 70 }, { x: 130, y: 120 });
  const reversed = rectangle({ x: 130, y: 120 }, { x: 80, y: 70 });
  assert.deepEqual(forward, reversed);
  assert.equal(validPolygon(forward, 8279, 5604), null);
  assert.deepEqual(clampPoint({ x: 8300.22, y: -0.8 }, 8279, 5604), {
    x: 8279,
    y: 0,
  });
});
test("rejects crossings, duplicate points, degenerate areas and out-of-image edits", () => {
  const cases = [
    [
      { x: 10, y: 10 },
      { x: 70, y: 60 },
      { x: 10, y: 80 },
      { x: 60, y: 10 },
    ],
    [
      { x: 1, y: 1 },
      { x: 10, y: 1 },
      { x: 1, y: 1 },
    ],
    rectangle({ x: 15, y: 15 }, { x: 15, y: 30 }),
    rectangle({ x: -1, y: 15 }, { x: 15, y: 30 }),
    rectangle({ x: 15, y: 15 }, { x: 101, y: 30 }),
    [
      { x: NaN, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ],
  ];
  for (const points of cases)
    assert.notEqual(validPolygon(points, 100, 100), null);
});
test("a concave building boundary is valid and exact boundary coordinates are accepted", () => {
  assert.equal(
    validPolygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 40, y: 50 },
        { x: 40, y: 100 },
        { x: 0, y: 100 },
      ],
      100,
      100,
    ),
    null,
  );
});
