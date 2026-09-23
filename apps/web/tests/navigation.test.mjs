import { test } from "node:test";
import assert from "node:assert/strict";
import {
  floorLocation,
  pointLocation,
  resolveFloor,
} from "../src/shared/navigation.ts";

const start =
  "https://guide.example/?point=library&floor=level-2&channel=official#map";

test("reselecting the same map building preserves the shared floor", () => {
  assert.equal(pointLocation(start, "library"), start);
});

test("switching or closing a building clears its previous floor", () => {
  const next = new URL(pointLocation(start, "dining"));
  assert.equal(next.searchParams.get("point"), "dining");
  assert.equal(next.searchParams.has("floor"), false);
  assert.equal(next.searchParams.get("channel"), "official");
  assert.equal(next.hash, "#map");
  const closed = new URL(pointLocation(start, null));
  assert.equal(closed.searchParams.has("point"), false);
  assert.equal(closed.searchParams.has("floor"), false);
});

test("a late floor response cannot overwrite a newly selected building link", () => {
  const next = pointLocation(start, "dining");
  assert.equal(floorLocation(next, "library", "level-1"), next);
});

test("invalid, removed or cross-building floor links resolve to an available floor", () => {
  const floors = [
    { id: "dining-1", point_id: "dining" },
    { id: "level-1", point_id: "library" },
    { id: "level-2", point_id: "library" },
  ];
  assert.equal(resolveFloor(floors, "library", "level-2"), "level-2");
  for (const requested of [null, "dining-1", "retired-floor"]) {
    const resolved = resolveFloor(floors, "library", requested);
    assert.equal(resolved, "level-1");
    assert.equal(
      new URL(floorLocation(start, "library", resolved)).searchParams.get(
        "floor",
      ),
      "level-1",
    );
  }
});

test("an empty floor list or returning to overview removes a misleading floor link", () => {
  assert.equal(resolveFloor([], "library", "level-2"), null);
  const url = new URL(floorLocation(start, "library", null));
  assert.equal(url.searchParams.get("point"), "library");
  assert.equal(url.searchParams.has("floor"), false);
});
