import { test } from "node:test";
import assert from "node:assert/strict";
import {
  floorLocation,
  pointLocation,
  resolveFloor,
  resolveFloorImage,
  reconcileFloorView,
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

test("section deep links follow the selected floor and clear on building changes", () => {
  const shared = floorLocation(start, "library", "level-2", "b");
  assert.equal(new URL(shared).searchParams.get("floor_section"), "b");
  assert.equal(pointLocation(shared, "library"), shared);
  for (const href of [
    pointLocation(shared, "dining"),
    pointLocation(shared, null),
    floorLocation(shared, "library", "level-1"),
    floorLocation(shared, "library", null),
    floorLocation(shared, "library", "level-2", "../secret"),
  ]) {
    assert.equal(new URL(href).searchParams.has("floor_section"), false);
  }
  assert.equal(floorLocation(shared, "dining", "other", "a"), shared);
});

test("section selection excludes clean assets and safely handles legacy images", () => {
  const images = [
    { variant: "clean", section: "main" },
    { variant: "labeled", section: "a" },
    { variant: "labeled", section: "b" },
  ];
  assert.equal(resolveFloorImage(images, "b"), images[2]);
  assert.equal(resolveFloorImage(images, "retired"), images[1]);
  assert.equal(resolveFloorImage(images.slice(0, 1), "main"), undefined);
  const legacy = { variant: "labeled" };
  assert.equal(resolveFloorImage([legacy], "main"), legacy);
});

const planRows = [
  { id: "one", point_id: "library", images: [{ variant: "labeled" }] },
  {
    id: "two",
    point_id: "library",
    images: [
      { variant: "labeled", section: "a" },
      { variant: "labeled", section: "b" },
    ],
  },
  { id: "hidden", point_id: "library", images: [{ variant: "clean" }] },
  { id: "other", point_id: "gym", images: [{ variant: "labeled" }] },
];
const closedView = { floorId: "", section: "main", expanded: false };
test("resource preloading never opens the viewer or invents a floor URL", () => {
  const result = reconcileFloorView(
    planRows,
    "library",
    closedView,
    new URLSearchParams("point=library"),
  );
  assert.equal(result.expanded, false);
  assert.equal(result.syncLocation, false);
  assert.deepEqual(
    result.floors.map((f) => f.id),
    ["one", "two"],
  );
});
test("a valid initial deep link opens the correct section, but polling after close does not reopen it", () => {
  const first = reconcileFloorView(
    planRows,
    "library",
    closedView,
    new URLSearchParams("point=library&floor=two&floor_section=b"),
  );
  assert.equal(first.floorId, "two");
  assert.equal(first.section, "b");
  assert.equal(first.expanded, true);
  const polled = reconcileFloorView(
    planRows,
    "library",
    { ...first, expanded: false },
    null,
  );
  assert.equal(polled.expanded, false);
  assert.equal(polled.floorId, "two");
  assert.equal(polled.section, "b");
  assert.equal(polled.syncLocation, false);
});
test("a link for another point cannot open the previous building", () => {
  const result = reconcileFloorView(
    planRows,
    "library",
    closedView,
    new URLSearchParams("point=gym&floor=other"),
  );
  assert.equal(result.expanded, false);
  assert.equal(result.floorId, "one");
});
test("a removed floor or section resolves only to a published labeled resource", () => {
  const result = reconcileFloorView(
    planRows,
    "library",
    { floorId: "hidden", section: "b", expanded: true },
    null,
  );
  assert.equal(result.floorId, "one");
  assert.equal(result.section, "main");
  assert.equal(result.syncLocation, true);
  const missingSection = reconcileFloorView(
    planRows,
    "library",
    { floorId: "two", section: "c", expanded: true },
    null,
  );
  assert.equal(missingSection.section, "a");
});
test("retiring all floor images closes the viewer and clears the deep link", () => {
  const result = reconcileFloorView(
    [{ id: "one", point_id: "library" }],
    "library",
    { floorId: "one", section: "main", expanded: true },
    null,
  );
  assert.equal(result.floorId, "");
  assert.equal(result.expanded, false);
  assert.equal(result.syncLocation, true);
});
