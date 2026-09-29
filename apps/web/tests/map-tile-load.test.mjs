import { test } from "node:test";
import assert from "node:assert/strict";
import { watchMapTiles } from "../src/features/map/tileLoad.ts";

function events() {
  const handlers = new Map();
  return {
    handlers,
    on(names, callback) {
      for (const name of names.split(" ")) handlers.set(name, callback);
      return this;
    },
    off(names, callback) {
      for (const name of names.split(" ")) {
        if (handlers.get(name) === callback) handlers.delete(name);
      }
      return this;
    },
    fire(name, value) {
      handlers.get(name)?.(value);
    },
  };
}

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const layer = {
    ...events(),
    options: { maxNativeZoom: 3 },
    getTileSize: () => ({ x: 256, y: 256 }),
  };
  const map = {
    ...events(),
    zoom: 3,
    left: 0,
    top: 0,
    right: 512,
    bottom: 256,
    getZoom() {
      return this.zoom;
    },
    getBounds() {
      return {
        getNorthWest: () => ({ x: this.left, y: this.top }),
        getSouthEast: () => ({ x: this.right, y: this.bottom }),
      };
    },
    project(point) {
      return point;
    },
  };
  const network = new EventTarget();
  const states = [{ failed: 0, retrying: false }];
  const controller = watchMapTiles(layer, map, (state) => states.push(state), {
    timeoutMs: 100,
    retryDelays: [10, 20],
    network,
  });
  t.after(controller.dispose);
  function tile(x, y = 0, z = 3) {
    let source = `/tiles/${z}/${x}/${y}.png`;
    const writes = [];
    const image = {
      get src() {
        return source;
      },
      set src(value) {
        source = value;
        writes.push(value);
      },
      getAttribute(name) {
        return name === "src" ? source : null;
      },
      removeAttribute(name) {
        if (name === "src") source = null;
      },
    };
    const event = { tile: image, coords: { x, y, z } };
    layer.fire("tileloadstart", event);
    return { image, writes, event, emit: (name) => layer.fire(name, event) };
  }
  return {
    layer,
    map,
    network,
    states,
    controller,
    tile,
    state: () => states.at(-1),
  };
}

test("a failed visible tile retries its exact URL while successful neighbours remain intact", (t) => {
  const h = harness(t),
    failed = h.tile(0),
    ready = h.tile(1);
  ready.emit("tileload");
  failed.emit("tileerror");
  assert.deepEqual(h.state(), { failed: 1, retrying: true });
  t.mock.timers.tick(10);
  assert.deepEqual(failed.writes, ["/tiles/3/0/0.png"]);
  assert.deepEqual(ready.writes, []);
  failed.emit("tileload");
  assert.deepEqual(h.state(), { failed: 0, retrying: false });
  t.mock.timers.tick(1000);
  assert.equal(failed.writes.length, 1);
});

test("hung images time out and exhaust a bounded two-retry budget", (t) => {
  const h = harness(t),
    hung = h.tile(0);
  t.mock.timers.tick(99);
  assert.equal(h.state().failed, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(h.state(), { failed: 1, retrying: true });
  t.mock.timers.tick(10);
  t.mock.timers.tick(100);
  t.mock.timers.tick(20);
  t.mock.timers.tick(100);
  assert.deepEqual(h.state(), { failed: 1, retrying: false });
  assert.equal(hung.writes.length, 2);
  for (let i = 0; i < 3; i++) {
    h.network.dispatchEvent(new Event("online"));
    h.map.fire("moveend");
    t.mock.timers.tick(1000);
  }
  assert.equal(
    hung.writes.length,
    2,
    "online and repeated viewport events cannot reset retry budgets",
  );
  h.controller.retry();
  assert.equal(
    hung.writes.length,
    3,
    "an explicit retry can start a new attempt",
  );
  assert.deepEqual(h.state(), { failed: 1, retrying: true });
  hung.emit("tileload");
  assert.equal(h.state().failed, 0);
});

test("offscreen failures clear the warning and never retry hidden tiles or ready neighbours", (t) => {
  const h = harness(t),
    failed = h.tile(0),
    ready = h.tile(1);
  ready.emit("tileload");
  failed.emit("tileerror");
  h.map.left = 256;
  h.map.fire("moveend");
  assert.equal(h.state().failed, 0);
  h.controller.retry();
  t.mock.timers.tick(1000);
  assert.deepEqual(failed.writes, []);
  assert.deepEqual(ready.writes, []);
  h.map.left = 0;
  h.map.fire("moveend");
  assert.deepEqual(h.state(), { failed: 1, retrying: true });
  t.mock.timers.tick(10);
  assert.equal(failed.writes.length, 1);
});

test("a real offline-to-online transition restores visible failures with a fresh bounded cycle", (t) => {
  const h = harness(t),
    tile = h.tile(0),
    hidden = h.tile(2);
  tile.emit("tileerror");
  t.mock.timers.tick(10);
  tile.emit("tileerror");
  t.mock.timers.tick(20);
  tile.emit("tileerror");
  assert.deepEqual(h.state(), { failed: 1, retrying: false });
  h.network.dispatchEvent(new Event("offline"));
  h.controller.retry();
  t.mock.timers.tick(1000);
  assert.equal(tile.writes.length, 2);
  h.network.dispatchEvent(new Event("online"));
  assert.equal(tile.writes.length, 3);
  assert.deepEqual(hidden.writes, []);
  tile.emit("tileload");
  assert.equal(h.state().failed, 0);
  t.mock.timers.tick(1000);
  assert.equal(tile.writes.length, 3);
});

test("a pending tile gets a deadline only while visible; background success stays ready on return", (t) => {
  const h = harness(t),
    pending = h.tile(2);
  t.mock.timers.tick(1000);
  assert.deepEqual(pending.writes, []);
  assert.equal(h.state().failed, 0);
  h.map.right = 768;
  h.map.fire("resize");
  t.mock.timers.tick(50);
  h.map.right = 512;
  h.map.fire("moveend");
  t.mock.timers.tick(1000);
  assert.equal(h.state().failed, 0);
  pending.emit("tileload");
  h.map.right = 768;
  h.map.fire("moveend");
  t.mock.timers.tick(1000);
  assert.deepEqual(pending.writes, []);
});

test("zoom transitions suppress stale errors and max-native overzoom keeps current tiles visible", (t) => {
  const h = harness(t),
    current = h.tile(0),
    old = h.tile(0, 0, 2);
  old.emit("tileerror");
  current.emit("tileerror");
  assert.equal(h.state().failed, 1);
  h.map.zoom = 4;
  h.map.fire("zoomend");
  t.mock.timers.tick(10);
  assert.equal(current.writes.length, 1);
  assert.equal(old.writes.length, 0);
  h.map.zoom = 2.25;
  h.map.fire("zoomend");
  t.mock.timers.tick(10);
  assert.equal(old.writes.length, 1);
  assert.equal(current.writes.length, 1);
});

for (const event of ["tileunload", "tileabort"]) {
  test(`${event} clears retries and rejects late image events after the tile is removed`, (t) => {
    const h = harness(t),
      tile = h.tile(0);
    tile.emit("tileerror");
    tile.emit(event);
    assert.deepEqual(h.state(), { failed: 0, retrying: false });
    tile.emit("tileerror");
    tile.emit("tileload");
    h.controller.retry();
    t.mock.timers.tick(1000);
    assert.deepEqual(tile.writes, []);
    assert.equal(h.state().failed, 0);
  });
}

test("successful late completion cancels queued backoff and stale errors cannot undo it", (t) => {
  const h = harness(t),
    tile = h.tile(0);
  t.mock.timers.tick(100);
  tile.emit("tileload");
  tile.emit("tileerror");
  t.mock.timers.tick(1000);
  assert.deepEqual(tile.writes, []);
  assert.equal(h.state().failed, 0);
});

test("disposal removes all public listeners and ignores callbacks queued before unmount", (t) => {
  const h = harness(t),
    tile = h.tile(0);
  const lateError = h.layer.handlers.get("tileerror");
  const lateStart = h.layer.handlers.get("tileloadstart");
  const lateLoad = h.layer.handlers.get("tileload");
  tile.emit("tileerror");
  const before = [...h.states];
  h.controller.dispose();
  h.controller.dispose();
  lateError(tile.event);
  lateStart(tile.event);
  lateLoad(tile.event);
  h.network.dispatchEvent(new Event("online"));
  h.controller.retry();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.states, before);
  assert.deepEqual(tile.writes, []);
  assert.equal(h.layer.handlers.size, 0);
  assert.equal(h.map.handlers.size, 0);
});
