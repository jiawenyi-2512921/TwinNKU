import { test } from "node:test";
import assert from "node:assert/strict";
import {
  placeLabels,
  intersects,
  labelPriority,
  shouldLabel,
} from "../src/features/map/labels.ts";

const candidate = (id, x, y, extra = {}) => ({
  id,
  x,
  y,
  width: 100,
  height: 32,
  priority: 50,
  selected: false,
  ...extra,
});
const viewport = { width: 400, height: 500 };

test("crowded names never overlap; selected building takes precedence", () => {
  const labels = placeLabels(
    [
      candidate("landmark", 100, 100, { priority: 100 }),
      candidate("selected", 104, 104, { selected: true }),
      candidate("far", 280, 240),
    ],
    viewport,
  );
  assert.deepEqual(
    labels.map((p) => p.id),
    ["selected", "far"],
  );
  assert.ok(!intersects(labels[0].box, labels[1].box));
});

test("viewport edges keep names readable and offscreen points are omitted", () => {
  const labels = placeLabels(
    [candidate("edge", 396, 480), candidate("offscreen", 450, 250)],
    viewport,
  );
  assert.equal(labels.length, 1);
  assert.ok(labels[0].box.right <= viewport.width - 8);
  assert.ok(labels[0].box.bottom <= viewport.height - 8);
});

test("controls and details reserve space instead of covering names", () => {
  assert.deepEqual(
    placeLabels([candidate("covered", 150, 100)], viewport, [
      { left: 80, top: 60, right: 220, bottom: 160 },
    ]),
    [],
  );
});

test("map detail progressively reveals dormitories; unknown buildings have no mass labels", () => {
  assert.ok(shouldLabel(labelPriority("图书馆", "academic"), 8, false));
  assert.equal(
    shouldLabel(labelPriority("学5-A", "residence"), 20, false),
    false,
  );
  assert.ok(shouldLabel(labelPriority("学5-A", "residence"), 80, false));
  assert.equal(
    shouldLabel(labelPriority("未命名建筑", "public_area"), 200, false),
    false,
  );
  assert.ok(shouldLabel(labelPriority("未命名建筑", "public_area"), 200, true));
});

test("layout is stable across API ordering changes", () => {
  const candidates = [
    candidate("a", 100, 100),
    candidate("b", 104, 104),
    candidate("c", 280, 300),
  ];
  assert.deepEqual(
    placeLabels(candidates, viewport),
    placeLabels([...candidates].reverse(), viewport),
  );
});
