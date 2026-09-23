import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPoint,
  rectangle,
  validPolygon,
} from "../src/features/admin/geometry.ts";

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
