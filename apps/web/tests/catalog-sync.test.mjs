import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCatalogRefresh,
  watchCatalogChanges,
  CATALOG_PUBLISHED,
  CATALOG_REFRESH_MS,
} from "../src/shared/catalogSync.ts";
import {
  loadCatalog,
  reconcileCatalog,
  availableSelection,
} from "../src/features/map/catalog.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const catalog = () => ({
  campus: { id: "nku-jinnan" },
  map: { id: "map", revision: 3 },
  features: {
    map_id: "map",
    map_revision: 3,
    points: [
      { point_id: "p", anchor: { x: 4, y: 8 }, polygon: [{ x: 1, y: 2 }] },
    ],
  },
  points: [{ id: "p", name: "图书馆", revision: 1 }],
});

test("a publication arriving during an older read skips that read and fetches again", async () => {
  const first = deferred(),
    second = deferred(),
    applied = [],
    busy = [];
  let reads = 0;
  const sync = createCatalogRefresh({
    load: () => (++reads === 1 ? first.promise : second.promise),
    apply: (x) => applied.push(x),
    failed: () => assert.fail(),
    busy: (x) => busy.push(x),
  });
  const done = sync.refresh();
  await tick();
  assert.equal(sync.refresh(), done); // ordinary polling is coalesced
  sync.refresh(true); // committed publication invalidates the older read
  first.resolve("old");
  await tick();
  assert.equal(reads, 2);
  assert.deepEqual(applied, []);
  second.resolve("published");
  await done;
  assert.deepEqual(applied, ["published"]);
  assert.deepEqual(busy, [true, false]);
  sync.dispose();
});

test("failed or timed-out refreshes preserve the previous catalog, and a later retry can recover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const applied = [],
    failed = [];
  let mode = "success";
  const sync = createCatalogRefresh({
    load: (signal) => {
      if (mode === "throw") throw new Error("offline");
      if (mode === "timeout")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("timeout"))),
        );
      return Promise.resolve(mode);
    },
    apply: (x) => applied.push(x),
    failed: () => failed.push(true),
    busy: () => {},
    timeoutMs: 100,
  });
  await sync.refresh();
  mode = "throw";
  await sync.refresh();
  mode = "timeout";
  const waiting = sync.refresh();
  await tick();
  t.mock.timers.tick(100);
  await waiting;
  assert.deepEqual(applied, ["success"]);
  assert.equal(failed.length, 2);
  mode = "recovered";
  await sync.refresh();
  assert.deepEqual(applied, ["success", "recovered"]);
  sync.dispose();
});

test("disposing a client aborts its read and rejects late updates and queued publications", async () => {
  const response = deferred();
  let signal,
    calls = 0;
  const sync = createCatalogRefresh({
    load: (value) => {
      signal = value;
      calls++;
      return response.promise;
    },
    apply: () => assert.fail(),
    failed: () => assert.fail(),
    busy: () => {},
  });
  const waiting = sync.refresh();
  await tick();
  sync.refresh(true);
  sync.dispose();
  assert.equal(signal.aborted, true);
  response.resolve("late");
  await waiting;
  await sync.refresh();
  assert.equal(calls, 1);
});

test("visible clients poll and react to focus/online/publication; hidden and disposed clients do not poll", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new EventTarget(),
    browser = new EventTarget(),
    calls = [];
  page.visibilityState = "visible";
  let closed = false;
  const channel = {
    onmessage: null,
    close: () => {
      closed = true;
    },
    postMessage: () => {},
  };
  const stop = watchCatalogChanges(
    (force) => calls.push(force),
    page,
    browser,
    channel,
  );
  t.mock.timers.tick(CATALOG_REFRESH_MS);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("online"));
  channel.onmessage({ data: CATALOG_PUBLISHED });
  channel.onmessage({ data: "untrusted point payload" });
  assert.deepEqual(calls, [undefined, true, true, true]);
  page.visibilityState = "hidden";
  t.mock.timers.tick(CATALOG_REFRESH_MS);
  channel.onmessage({ data: CATALOG_PUBLISHED });
  assert.equal(calls.length, 4);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls.length, 5);
  stop();
  t.mock.timers.tick(CATALOG_REFRESH_MS);
  browser.dispatchEvent(new Event("focus"));
  assert.equal(calls.length, 5);
  assert.equal(closed, true);
  assert.equal(channel.onmessage, null);
});

test("focus and polling remain available when BroadcastChannel is unavailable", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = new EventTarget(),
    browser = new EventTarget();
  page.visibilityState = "visible";
  let calls = 0;
  const stop = watchCatalogChanges(() => calls++, page, browser, null);
  browser.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(CATALOG_REFRESH_MS);
  assert.equal(calls, 2);
  stop();
});

test("unchanged map identity preserves the viewport; geometry and retirement still reach the client", () => {
  const before = catalog();
  assert.equal(reconcileCatalog(before, structuredClone(before)), before);
  const changed = structuredClone(before);
  changed.features.points[0].polygon[0].x = 11;
  const next = reconcileCatalog(before, changed);
  assert.equal(next.map, before.map);
  assert.equal(next.points, before.points);
  assert.notEqual(next.features, before.features);
  assert.equal(availableSelection(next, "p"), "p");
  assert.equal(availableSelection({ ...next, points: [] }, "p"), null);
  assert.equal(availableSelection(null, "p"), null);
  assert.equal(reconcileCatalog(before, null), null);
});

test("catalog loads later pages, excludes unmapped points and fails on truncated or mismatched data", async () => {
  let revision = 3,
    missing = false;
  const campus = { id: "nku-jinnan" },
    map = { id: "m", kind: "campus", revision: 3, tiles: {} };
  const source = {
    status: async () => ({ data: { capabilities: { map: true } } }),
    campuses: async () => ({ data: [campus] }),
    maps: async () => ({ data: [map] }),
    mapFeatures: async () => ({
      data: {
        map_id: "m",
        map_revision: revision,
        points: [{ point_id: "b" }],
      },
    }),
    points: async (_campus, _query, _signal, page = 1) => ({
      data:
        page === 1
          ? [{ id: "a", name: "不可点击" }]
          : missing
            ? []
            : [{ id: "b", name: "图书馆" }],
      meta: { pagination: { total: 2 } },
    }),
  };
  const signal = new AbortController().signal;
  const result = await loadCatalog(source, signal);
  assert.deepEqual(
    result.points.map((p) => p.id),
    ["b"],
  );
  missing = true;
  await assert.rejects(loadCatalog(source, signal), /Incomplete/);
  revision = 2;
  await assert.rejects(loadCatalog(source, signal), /revision/);
});

test("campus loading is independent of status and overlaps points with map and geometry reads", async () => {
  const maps = deferred(),
    points = deferred(),
    events = [];
  const signal = new AbortController().signal;
  const source = {
    status: () => assert.fail("status is not a prerequisite for public maps"),
    campuses: async () => ({ data: [{ id: "nku-jinnan" }] }),
    maps: (_campus, receivedSignal, kind) => {
      assert.equal(receivedSignal, signal);
      assert.equal(kind, "campus");
      events.push("maps");
      return maps.promise;
    },
    points: () => {
      events.push("points");
      return points.promise;
    },
    mapFeatures: async () => {
      events.push("features");
      return {
        data: { map_id: "m", map_revision: 3, points: [{ point_id: "p" }] },
      };
    },
  };
  const loading = loadCatalog(source, signal);
  await tick();
  assert.deepEqual(events, ["maps", "points"]);
  maps.resolve({ data: [{ id: "m", revision: 3, kind: "campus", tiles: {} }] });
  await tick();
  assert.deepEqual(events, ["maps", "points", "features"]);
  points.resolve({ data: [{ id: "p", name: "图书馆" }], meta: {} });
  assert.equal((await loading).points[0].id, "p");
});

test("disabled or unpublished campus maps remain empty without bypassing the public API", async () => {
  const result = await loadCatalog(
    {
      status: () => assert.fail("no status request"),
      campuses: async () => ({ data: [{ id: "nku-jinnan" }] }),
      maps: async () => ({ data: [{ id: "f", kind: "floor", tiles: null }] }),
      points: async () => ({ data: [], meta: {} }),
      mapFeatures: () => assert.fail("never request unavailable geometry"),
    },
    new AbortController().signal,
  );
  assert.equal(result.map, null);
  assert.equal(result.features, null);
});

test("a failed parallel catalog read cancels siblings before they can start more requests", async () => {
  const maps = deferred();
  let receivedSignal;
  const source = {
    campuses: async () => ({ data: [{ id: "nku-jinnan" }] }),
    maps: (_campus, signal) => {
      receivedSignal = signal;
      return maps.promise; // A transport that resolves late despite cancellation.
    },
    points: async () => {
      throw new Error("offline");
    },
    mapFeatures: () =>
      assert.fail("a completed failed refresh must not start geometry reads"),
  };
  let failures = 0;
  const sync = createCatalogRefresh({
    load: (signal) => loadCatalog(source, signal),
    apply: () => assert.fail("never apply a partial catalog"),
    failed: () => failures++,
    busy: () => {},
  });
  await sync.refresh();
  assert.equal(failures, 1);
  assert.equal(receivedSignal.aborted, true);
  maps.resolve({ data: [{ id: "m", revision: 3, kind: "campus", tiles: {} }] });
  await tick();
  sync.dispose();
});
