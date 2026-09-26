import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPlaceMemory,
  MAX_FAVORITES,
  MAX_RECENT,
  parsePlaceMemory,
  placeMemoryKey,
} from "../src/features/places/memory.ts";
import { findPlaces } from "../src/features/places/search.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

test("browser preferences reject malformed, oversized, future-version and non-ID data", () => {
  for (const raw of [
    null,
    "{",
    "null",
    "{}",
    '{"version":2}',
    "x".repeat(32769),
  ]) {
    assert.deepEqual(parsePlaceMemory(raw), {
      version: 1,
      favorites: [],
      recent: [],
    });
  }
  assert.deepEqual(
    parsePlaceMemory(
      JSON.stringify({
        version: 1,
        favorites: [id(1), id(1), "school-token", null],
        recent: [id(2), { name: "private" }],
        name: "copied title",
        query: "my question",
      }),
    ),
    { version: 1, favorites: [id(1)], recent: [id(2)] },
  );
});

test("favorite and recent ordering persists by campus without saving names, queries or timestamps", () => {
  const disk = storage();
  const a = createPlaceMemory(() => disk, "jinnan");
  a.dispatch({ type: "favorite", id: id(1) });
  a.dispatch({ type: "visit", id: id(2) });
  a.dispatch({ type: "visit", id: id(1) });
  a.dispatch({ type: "visit", id: id(2) });
  const restored = createPlaceMemory(() => disk, "jinnan").getSnapshot();
  assert.deepEqual(restored, {
    places: { version: 1, favorites: [id(1)], recent: [id(2), id(1)] },
    memoryOnly: false,
  });
  assert.deepEqual(
    createPlaceMemory(() => disk, "balitai").getSnapshot().places.favorites,
    [],
  );
  assert.deepEqual(
    Object.keys(JSON.parse(disk.getItem(placeMemoryKey("jinnan")))),
    ["version", "favorites", "recent"],
  );
  a.dispatch({ type: "clear-recent" });
  assert.deepEqual(a.getSnapshot().places, {
    version: 1,
    favorites: [id(1)],
    recent: [],
  });
  a.dispatch({ type: "favorite", id: id(1) });
  assert.deepEqual(a.getSnapshot().places.favorites, []);
});

test("recent list is bounded and a full favorites list never silently drops a saved place", () => {
  const disk = storage();
  const favorites = Array.from({ length: MAX_FAVORITES }, (_, n) => id(n + 1));
  disk.setItem(
    placeMemoryKey("jinnan"),
    JSON.stringify({ version: 1, favorites, recent: [] }),
  );
  const store = createPlaceMemory(() => disk, "jinnan");
  assert.equal(store.dispatch({ type: "favorite", id: id(500) }), "limit");
  assert.deepEqual(store.getSnapshot().places.favorites, favorites);
  for (let n = 1; n <= MAX_RECENT + 3; n++)
    store.dispatch({ type: "visit", id: id(n) });
  assert.equal(store.getSnapshot().places.recent.length, MAX_RECENT);
  assert.equal(store.getSnapshot().places.recent[0], id(MAX_RECENT + 3));
  assert.equal(store.dispatch({ type: "visit", id: "not-a-point" }), "ignored");
});

test("a tab's next edit reads another tab's completed changes and refresh handles storage clear", () => {
  const disk = storage();
  const a = createPlaceMemory(() => disk, "jinnan");
  const b = createPlaceMemory(() => disk, "jinnan");
  let notifications = 0;
  const unsubscribe = b.subscribe(() => notifications++);
  a.dispatch({ type: "favorite", id: id(1) });
  b.dispatch({ type: "favorite", id: id(2) });
  a.refresh();
  assert.deepEqual(a.getSnapshot().places.favorites, [id(2), id(1)]);
  b.dispatch({ type: "favorite", id: id(1) });
  a.refresh();
  assert.deepEqual(a.getSnapshot().places.favorites, [id(2)]);
  const count = notifications;
  b.refresh();
  assert.equal(
    notifications,
    count,
    "unchanged reads must not cause re-render loops",
  );
  disk.data.clear();
  b.refresh();
  assert.deepEqual(b.getSnapshot().places.favorites, []);
  unsubscribe();
  const after = notifications;
  b.dispatch({ type: "visit", id: id(3) });
  assert.equal(notifications, after);
});

test("denied storage and quota failures preserve functional in-page state and disclose fallback", () => {
  const blocked = createPlaceMemory(() => {
    throw new Error("denied");
  }, "jinnan");
  blocked.dispatch({ type: "favorite", id: id(1) });
  blocked.dispatch({ type: "visit", id: id(2) });
  assert.equal(blocked.getSnapshot().memoryOnly, true);
  assert.deepEqual(blocked.getSnapshot().places.favorites, [id(1)]);
  const disk = storage();
  const quota = createPlaceMemory(
    () => ({
      ...disk,
      setItem() {
        throw new Error("quota");
      },
    }),
    "jinnan",
  );
  quota.dispatch({ type: "favorite", id: id(1) });
  quota.dispatch({ type: "favorite", id: id(2) });
  assert.deepEqual(quota.getSnapshot().places.favorites, [id(2), id(1)]);
  assert.equal(quota.getSnapshot().memoryOnly, true);
});

const points = [
  {
    id: id(1),
    name: "公共教学楼A区",
    aliases: ["公教A", "教学楼"],
    category: "academic",
  },
  { id: id(2), name: "图书馆广场", aliases: [], category: "public_area" },
  {
    id: id(3),
    name: "津南图书馆",
    aliases: ["图书馆", "Library"],
    category: "academic",
  },
  { id: id(4), name: "图书馆", aliases: [], category: "academic" },
];

test("search ranks exact names and aliases before prefix matches, with NFKC and multi-term matching", () => {
  assert.deepEqual(
    findPlaces(points, " 图书馆 ", "all").map((p) => p.id),
    [id(4), id(3), id(2)],
  );
  assert.deepEqual(findPlaces(points, "公教Ａ", "all"), [points[0]]);
  assert.deepEqual(findPlaces(points, "公共　Ａ区", "all"), [points[0]]);
  assert.deepEqual(findPlaces(points, "LIBRARY", "academic"), [points[2]]);
  assert.deepEqual(findPlaces(points, "图书馆", "public_area"), [points[1]]);
  assert.deepEqual(findPlaces(points, "图书馆 教学楼", "all"), []);
});

test("saved lists intersect the current public catalog, deduplicate IDs and keep saved ordering", () => {
  const saved = [id(3), id(90), id(1), id(3)];
  assert.deepEqual(findPlaces(points, "", "all", saved), [
    points[2],
    points[0],
  ]);
  const revised = [{ ...points[0], name: "更新后的名称" }];
  assert.deepEqual(findPlaces(revised, "", "all", saved), revised);
  assert.deepEqual(findPlaces(points, "图书馆", "all", []), []);
  assert.deepEqual(findPlaces(points, "图书馆", "all", saved), [points[2]]);
});
