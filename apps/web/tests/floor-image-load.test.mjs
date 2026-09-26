import { test } from "node:test";
import assert from "node:assert/strict";
import { mountFloorImage } from "../src/features/floors/imageLoad.ts";

function overlay(onAdd) {
  const handlers = new Map();
  return {
    handlers,
    attached: false,
    on(event, callback) {
      handlers.set(event, callback);
    },
    off(event, callback) {
      if (handlers.get(event) === callback) handlers.delete(event);
    },
    addTo(map) {
      this.map = map;
      this.attached = true;
      onAdd?.(this);
    },
    remove() {
      this.attached = false;
    },
    emit(event) {
      handlers.get(event)?.();
    },
  };
}

test("an immediately cached image is observed and completion releases its deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const layer = overlay((image) => image.emit("load"));
  const dispose = mountFloorImage(layer, {}, (state) => states.push(state), 30);
  assert.deepEqual(states, ["loading", "ready"]);
  assert.equal(layer.handlers.size, 0);
  assert.equal(layer.attached, true);
  t.mock.timers.tick(100);
  assert.deepEqual(states, ["loading", "ready"]);
  dispose();
  assert.equal(layer.attached, false);
});

test("a failed image detaches and a previously queued load cannot replace the error", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const layer = overlay();
  mountFloorImage(layer, {}, (state) => states.push(state), 30);
  const lateLoad = layer.handlers.get("load");
  layer.emit("error");
  lateLoad();
  t.mock.timers.tick(100);
  assert.deepEqual(states, ["loading", "error"]);
  assert.equal(layer.attached, false);
  assert.equal(layer.handlers.size, 0);
});

test("a stalled original reaches a retryable timeout and cannot later become visible", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const layer = overlay();
  mountFloorImage(layer, {}, (state) => states.push(state), 30);
  const lateLoad = layer.handlers.get("load");
  t.mock.timers.tick(29);
  assert.deepEqual(states, ["loading"]);
  t.mock.timers.tick(1);
  lateLoad();
  assert.deepEqual(states, ["loading", "timeout"]);
  assert.equal(layer.attached, false);
  assert.equal(layer.handlers.size, 0);
});

for (const ready of [false, true]) {
  test(`leaving a ${ready ? "loaded" : "pending"} floor removes listeners and ignores late events`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const states = [];
    const layer = overlay();
    const dispose = mountFloorImage(
      layer,
      {},
      (state) => states.push(state),
      30,
    );
    const lateLoad = layer.handlers.get("load");
    const lateError = layer.handlers.get("error");
    if (ready) layer.emit("load");
    const before = [...states];
    dispose();
    dispose();
    lateLoad();
    lateError();
    t.mock.timers.tick(100);
    assert.deepEqual(states, before);
    assert.equal(layer.attached, false);
    assert.equal(layer.handlers.size, 0);
  });
}

test("retry uses a new overlay and old callbacks cannot finish the new attempt", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const map = { zoom: 1, center: [35, 40] };
  const first = overlay();
  const dispose = mountFloorImage(
    first,
    map,
    (state) => states.push(state),
    30,
  );
  const lateLoad = first.handlers.get("load");
  const lateError = first.handlers.get("error");
  t.mock.timers.tick(30);
  dispose();
  const next = overlay();
  mountFloorImage(next, map, (state) => states.push(state), 30);
  lateLoad();
  lateError();
  assert.deepEqual(states, ["loading", "timeout", "loading"]);
  next.emit("load");
  t.mock.timers.tick(100);
  assert.deepEqual(states, ["loading", "timeout", "loading", "ready"]);
  assert.equal(next.map, map);
  assert.deepEqual(map, { zoom: 1, center: [35, 40] });
  assert.equal(first.attached, false);
  assert.equal(next.attached, true);
});

test("a synchronous overlay error also releases its deadline and listeners", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const layer = overlay(() => {
    throw new Error("image setup failed");
  });
  const states = [];
  mountFloorImage(layer, {}, (state) => states.push(state), 30);
  t.mock.timers.tick(100);
  assert.deepEqual(states, ["loading", "error"]);
  assert.equal(layer.handlers.size, 0);
  assert.equal(layer.attached, false);
});
