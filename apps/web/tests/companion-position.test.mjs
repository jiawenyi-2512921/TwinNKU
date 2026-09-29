import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as position from "../src/features/agent/companionPosition.ts";

const desktop = { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0 };
const size = { width: 176, height: 236 };
const bounds = position.companionBounds(desktop, size);
const pointer = (x, y, pointerId = 1) => ({
  pointerId,
  clientX: x,
  clientY: y,
  button: 0,
  isPrimary: true,
});
const origin = { x: 500, y: 300 };

test("entire companion including controls stays inside desktop and visual viewport safe margins", () => {
  assert.deepEqual(bounds, { minX: 16, maxX: 1088, minY: 16, maxY: 548 });
  assert.deepEqual(
    position.clampCompanionPosition({ x: -900, y: 2000 }, bounds),
    { x: 16, y: 548 },
  );
  const keyboard = position.companionBounds(
    { width: 390, height: 320, offsetLeft: 20, offsetTop: 150 },
    size,
  );
  assert.deepEqual(keyboard, { minX: 36, maxX: 218, minY: 166, maxY: 218 });
  assert.deepEqual(
    position.restoreCompanionPosition({ x: 1, y: 1 }, keyboard),
    { x: 218, y: 218 },
  );
});

test("zero or undersized viewports stay finite and leave the top-left reachable", () => {
  assert.deepEqual(
    position.companionBounds(
      { width: 90, height: 90, offsetLeft: 4, offsetTop: 7 },
      size,
    ),
    { minX: 4, maxX: 4, minY: 7, maxY: 7 },
  );
  const tiny = position.companionBounds(
    { width: NaN, height: Infinity, offsetLeft: NaN, offsetTop: 0 },
    size,
  );
  assert.deepEqual(position.restoreCompanionPosition({ x: 1, y: 1 }, tiny), {
    x: 0,
    y: 0,
  });
});

test("normalized position survives resize, rotation and character size changes", () => {
  const normalized = position.normalizeCompanionPosition(
    { x: 552, y: 282 },
    bounds,
  );
  assert.deepEqual(normalized, { x: 0.5, y: 0.5 });
  const mobile = position.companionBounds(
    { width: 390, height: 700, offsetLeft: 0, offsetTop: 0 },
    { width: 128, height: 180 },
  );
  assert.deepEqual(position.restoreCompanionPosition(normalized, mobile), {
    x: 131,
    y: 260,
  });
  assert.deepEqual(position.restoreCompanionPosition({ x: 1, y: 1 }, bounds), {
    x: 1088,
    y: 548,
  });
});

test("corrupt, old, nonfinite or out-of-range stored values never become screen coordinates", () => {
  for (const raw of [
    null,
    "",
    "{",
    "[]",
    "null",
    '"text"',
    "{}",
    '{"version":2,"x":0,"y":0}',
    '{"version":1,"x":-1,"y":0}',
    '{"version":1,"x":0,"y":1.1}',
    '{"version":1,"x":"1","y":0}',
    '{"version":1,"x":1e309,"y":0}',
    " ".repeat(257),
  ]) {
    assert.equal(position.parseCompanionPosition(raw), null, String(raw));
  }
  assert.deepEqual(
    position.parseCompanionPosition(
      '{"version":1,"x":0.25,"y":1,"ignored":"private"}',
    ),
    { x: 0.25, y: 1 },
  );
});

test("storage writes only normalized version/x/y and blocked storage remains optional", () => {
  const writes = [];
  position.saveCompanionPosition(
    { setItem: (...args) => writes.push(args) },
    { x: 0.2, y: 0.9, chat: "do not store" },
  );
  assert.deepEqual(writes, [
    [position.COMPANION_POSITION_KEY, '{"version":1,"x":0.2,"y":0.9}'],
  ]);
  const blocked = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("full");
    },
  };
  assert.equal(position.readCompanionPosition(blocked), null);
  assert.doesNotThrow(() =>
    position.saveCompanionPosition(blocked, { x: 0, y: 0 }),
  );
});

test("ordinary tap and sub-threshold finger wobble preserve click", () => {
  const drag = position.createCompanionDrag();
  assert.equal(drag.start(pointer(20, 30), origin), true);
  assert.equal(drag.move(pointer(23, 33), bounds), null);
  assert.deepEqual(drag.end(1), { pointerId: 1, dragged: false });
  assert.equal(drag.consumeClick(1), false);
});

test("completed drag consumes exactly its following pointer click even after moving back", () => {
  const drag = position.createCompanionDrag();
  drag.start(pointer(20, 30), origin);
  assert.deepEqual(drag.move(pointer(0, 10), bounds), { x: 480, y: 280 });
  assert.deepEqual(drag.move(pointer(20, 30), bounds), origin);
  assert.deepEqual(drag.end(1), { pointerId: 1, dragged: true });
  assert.equal(
    drag.consumeClick(0),
    false,
    "keyboard activation is not a dragged pointer click",
  );
  assert.equal(drag.consumeClick(1), true);
  assert.equal(drag.consumeClick(1), false);
});

test("drag at a clamped edge cannot activate voice and unrelated pointers cannot hijack it", () => {
  const drag = position.createCompanionDrag();
  assert.equal(drag.start({ ...pointer(0, 0), button: 2 }, origin), false);
  assert.equal(
    drag.start({ ...pointer(0, 0), isPrimary: false }, origin),
    false,
  );
  drag.start(pointer(0, 0), { x: 16, y: 16 });
  assert.equal(drag.start(pointer(30, 30, 2), origin), false);
  assert.equal(drag.move(pointer(80, 80, 2), bounds), null);
  assert.equal(drag.end(2), null);
  assert.deepEqual(drag.move(pointer(-100, -100), bounds), { x: 16, y: 16 });
  drag.end(1);
  assert.equal(drag.consumeClick(1), true);
});

test("cancel and lost capture end the gesture without swallowing a later fresh tap", () => {
  const drag = position.createCompanionDrag();
  drag.start(pointer(0, 0), origin);
  drag.move(pointer(10, 0), bounds);
  assert.deepEqual(drag.cancel(), { pointerId: 1, dragged: true });
  assert.equal(drag.move(pointer(40, 0), bounds), null);
  assert.equal(drag.end(1), null);
  drag.start(pointer(40, 0), origin);
  drag.end(1);
  assert.equal(drag.consumeClick(1), false);
});

test("arrow movement clamps, supports shift step and leaves Enter/Space untouched", () => {
  assert.deepEqual(
    position.keyboardCompanionPosition("ArrowLeft", false, origin, bounds),
    { x: 488, y: 300 },
  );
  assert.deepEqual(
    position.keyboardCompanionPosition("ArrowUp", true, origin, bounds),
    { x: 500, y: 260 },
  );
  assert.deepEqual(
    position.keyboardCompanionPosition(
      "ArrowDown",
      true,
      { x: 100, y: 548 },
      bounds,
    ),
    { x: 100, y: 548 },
  );
  assert.equal(
    position.keyboardCompanionPosition("Enter", false, origin, bounds),
    null,
  );
  assert.equal(
    position.keyboardCompanionPosition(" ", false, origin, bounds),
    null,
  );
});

const hookCode = ts.transpileModule(
  readFileSync(
    new URL("../src/features/agent/useCompanionPosition.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function target() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (count, list) => count + list.size,
        0,
      );
    },
  };
}
function hookHarness({ captureFails = false, blockedStorage = false } = {}) {
  const frames = new Map();
  const writes = [];
  const visual = {
    ...target(),
    width: 1280,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
  };
  const browser = {
    ...target(),
    innerWidth: 1280,
    innerHeight: 800,
    visualViewport: visual,
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  Object.defineProperty(browser, "localStorage", {
    get() {
      if (blockedStorage) throw Error("blocked");
      return { getItem: () => null, setItem: (...args) => writes.push(args) };
    },
  });
  const element = {
    style: {},
    dataset: {},
    getBoundingClientRect: () => dimensions,
  };
  let dimensions = { width: 176, height: 236 },
    nextFrame = 0,
    observeResize,
    disconnected = false,
    captured = null;
  const button = {
    setPointerCapture(id) {
      if (captureFails) throw Error("unavailable");
      captured = id;
    },
    hasPointerCapture: (id) => captured === id,
    releasePointerCapture() {
      captured = null;
    },
  };
  const effects = [],
    refs = [];
  const exports = {};
  vm.runInNewContext(hookCode, {
    exports,
    window: browser,
    ResizeObserver: class {
      constructor(callback) {
        observeResize = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
    require(name) {
      if (name === "./companionPosition") return position;
      if (name === "react")
        return {
          useRef: (value) => {
            const ref = { current: value };
            refs.push(ref);
            return ref;
          },
          useEffect: (effect) => effects.push(effect),
        };
      throw Error(name);
    },
  });
  const hook = exports.useCompanionPosition();
  hook.containerRef.current = element;
  const cleanups = effects.map((effect) => effect());
  const event = (x = 20, y = 30, extra = {}) => ({
    ...pointer(x, y),
    currentTarget: button,
    stopped: false,
    prevented: false,
    stopPropagation() {
      this.stopped = true;
    },
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  });
  return {
    hook,
    browser,
    visual,
    element,
    writes,
    frames,
    event,
    paint() {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
    },
    resize(width, height) {
      dimensions = { width, height };
      observeResize();
    },
    cleanup() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
    get captured() {
      return captured;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

test("actual hook coalesces movement and captures pointer without any React state updates", () => {
  const h = hookHarness();
  assert.equal(h.element.style.transform, "translate3d(1088px, 548px, 0)");
  const down = h.event();
  h.hook.buttonProps.onPointerDown(down);
  assert.equal(down.stopped, true);
  assert.equal(h.captured, 1);
  h.hook.buttonProps.onPointerMove(h.event(0, 10));
  h.hook.buttonProps.onPointerMove(h.event(-20, -10));
  assert.equal(h.frames.size, 1);
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(1048px, 508px, 0)");
  h.hook.buttonProps.onPointerUp(h.event(-20, -10));
  assert.equal(h.captured, null);
  assert.equal(h.element.dataset.dragging, undefined);
  assert.equal(h.writes.length, 1);
  const click = h.event(0, 0, { detail: 1 });
  h.hook.buttonProps.onClickCapture(click);
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  h.cleanup();
});

test("actual hook keeps mobile taps usable and respects keyboard activation shortcuts", () => {
  const h = hookHarness();
  h.hook.buttonProps.onPointerDown(h.event());
  h.hook.buttonProps.onPointerUp(h.event(21, 31));
  const click = h.event(0, 0, { detail: 1 });
  h.hook.buttonProps.onClickCapture(click);
  assert.equal(click.prevented, false);
  for (const key of ["Enter", " "]) {
    const event = h.event(0, 0, { key });
    h.hook.buttonProps.onKeyDown(event);
    assert.equal(event.prevented, false);
  }
  const move = h.event(0, 0, { key: "ArrowLeft", shiftKey: true });
  h.hook.buttonProps.onKeyDown(move);
  assert.equal(move.stopped, true);
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(1048px, 548px, 0)");
  const alt = h.event(0, 0, { key: "ArrowLeft", altKey: true });
  h.hook.buttonProps.onKeyDown(alt);
  assert.equal(alt.prevented, false);
  h.cleanup();
});

test("actual hook responds to keyboard viewport, offset scrolling, rotation and size changes", () => {
  const h = hookHarness();
  Object.assign(h.visual, {
    width: 390,
    height: 320,
    offsetLeft: 20,
    offsetTop: 150,
  });
  h.visual.fire("resize");
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(218px, 218px, 0)");
  h.visual.offsetTop = 200;
  h.visual.fire("scroll");
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(218px, 268px, 0)");
  h.resize(72, 82);
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(322px, 422px, 0)");
  Object.assign(h.visual, {
    width: 800,
    height: 390,
    offsetLeft: 0,
    offsetTop: 0,
  });
  h.browser.fire("orientationchange");
  h.paint();
  assert.equal(h.element.style.transform, "translate3d(712px, 292px, 0)");
  h.cleanup();
});

test("capture failure falls back to window events and cleans them on cancellation", () => {
  const h = hookHarness({ captureFails: true, blockedStorage: true });
  const listeners = h.browser.listenerCount();
  h.hook.buttonProps.onPointerDown(h.event());
  assert.equal(h.browser.listenerCount(), listeners + 3);
  h.browser.fire("pointermove", h.event(0, 10));
  h.browser.fire("pointercancel", h.event(0, 10));
  assert.equal(h.browser.listenerCount(), listeners);
  assert.equal(h.element.dataset.dragging, undefined);
  h.hook.buttonProps.onPointerDown(h.event());
  h.browser.fire("pointerup", h.event());
  const click = h.event(0, 0, { detail: 1 });
  h.hook.buttonProps.onClickCapture(click);
  assert.equal(click.prevented, false);
  h.cleanup();
});

test("lost capture and viewport interruption end dragging, cleanup cancels stale frames/listeners", () => {
  const h = hookHarness();
  h.hook.buttonProps.onPointerDown(h.event());
  h.hook.buttonProps.onPointerMove(h.event(0, 10));
  h.hook.buttonProps.onLostPointerCapture(h.event(0, 10));
  assert.equal(h.captured, null);
  assert.equal(h.element.dataset.dragging, undefined);
  h.hook.buttonProps.onPointerDown(h.event());
  h.hook.buttonProps.onPointerMove(h.event(0, 10));
  h.visual.fire("resize");
  assert.equal(h.captured, null);
  assert.equal(h.frames.size, 1);
  const stale = [...h.frames.values()][0];
  const previous = h.element.style.transform;
  h.cleanup();
  assert.equal(h.frames.size, 0);
  assert.equal(h.browser.listenerCount(), 0);
  assert.equal(h.visual.listenerCount(), 0);
  assert.equal(h.disconnected, true);
  stale();
  assert.equal(h.element.style.transform, previous);
  h.hook.resetPosition();
  assert.equal(h.frames.size, 0);
});
