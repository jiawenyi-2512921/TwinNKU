import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

const code = ts.transpileModule(
  readFileSync(
    new URL("../src/features/visit/TourNarrator.tsx", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const manifest = {
  permit: "test-only-permit",
  chunks: ["本段讲解"],
  csrf: "test-only-csrf",
};
const source = {
  tourId: "published-tour",
  tourRevision: 2,
  stopIndex: 0,
  segmentId: "first",
  text: "本段讲解",
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function findButton(tree, text) {
  if (Array.isArray(tree))
    return tree.map((entry) => findButton(entry, text)).find(Boolean);
  if (!tree || typeof tree !== "object") return;
  if (tree.type === "button" && tree.props.children === text) return tree;
  return findButton(tree.props?.children, text);
}
function harness(prepare = async () => manifest) {
  const slots = [],
    effects = [],
    listeners = new Map(),
    bookmarks = [],
    calls = [],
    prepares = [];
  let cursor = 0,
    effectCursor = 0,
    props,
    currentLease = null,
    lease = 0;
  let progress = { chunkIndex: 0, time: 0 },
    speakerOptions;
  const speaker = {
    unlock() {},
    cancel() {
      speakerOptions.onState("idle");
    },
    pause() {
      const saved = { ...progress };
      this.cancel();
      return saved;
    },
    speak(text, caption, value) {
      progress = { chunkIndex: value.startChunk, time: value.startTime };
      const done = deferred();
      calls.push({ text, caption, manifest: value, done });
      speakerOptions.onState("speaking");
      return done.promise;
    },
  };
  const document = {
    visibilityState: "visible",
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const react = {
    useRef(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useState(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = initial;
      return [
        slots[key],
        (value) => {
          slots[key] = value;
        },
      ];
    },
    useEffect(callback, deps) {
      const key = effectCursor++,
        old = effects[key];
      if (
        !old ||
        deps.some((value, index) => !Object.is(value, old.deps[index]))
      )
        effects[key] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    AbortController,
    document,
    window: {
      addEventListener(name, callback) {
        listeners.set(name, callback);
      },
      removeEventListener(name) {
        listeners.delete(name);
      },
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/cloudVoice"))
        return {
          createBrowserSpeechFallback: () => ({ speak() {}, cancel() {} }),
          createCloudSpeaker: (options) => {
            speakerOptions = options;
            return speaker;
          },
        };
      if (name.endsWith("/voice"))
        return { browserVoiceEnvironment: () => ({}) };
      if (name.endsWith("/visitorSession"))
        return {
          prepareTourVoice: async (value, signal) => {
            prepares.push({ kind: "public", value, signal });
            return prepare(value, signal);
          },
          prepareDraftVoice: async (value, csrf, signal) => {
            prepares.push({ kind: "draft", value, csrf, signal });
            return prepare(value, signal);
          },
        };
      if (name.endsWith("/audioOwner"))
        return {
          acquireAudio(owner, stop) {
            const previous = currentLease;
            currentLease = null;
            previous?.stop();
            currentLease = { owner, stop, lease: ++lease };
            return lease;
          },
          releaseAudio(owner, expected) {
            if (
              currentLease?.owner === owner &&
              currentLease.lease === expected
            )
              currentLease = null;
          },
        };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  function render(next = props) {
    props = next;
    cursor = effectCursor = 0;
    return exports.TourNarrator(props);
  }
  function flush() {
    const pending = effects.filter((entry) => entry.pending);
    pending.forEach((entry) => entry.cleanup?.());
    pending.forEach((entry) => {
      entry.pending = false;
      entry.cleanup = entry.callback();
    });
  }
  return {
    render,
    flush,
    calls,
    prepares,
    bookmarks,
    document,
    initial(extra = {}) {
      render({
        narration: source,
        onBookmark: (value) => bookmarks.push(value),
        ...extra,
      });
      flush();
    },
    pause() {
      listeners.get("twinnku:tour-pause")();
    },
    advance(value) {
      progress = value;
      calls.at(-1).manifest.onProgress(value);
    },
    unmount() {
      effects.forEach((entry) => entry.cleanup?.());
    },
  };
}

test("pausing during permit preparation preserves the restored audio bookmark", async () => {
  const first = deferred();
  let count = 0;
  const h = harness(async () => (++count === 1 ? first.promise : manifest));
  h.initial({ initialBookmark: { chunkIndex: 2, time: 4.5 } });
  h.pause();
  assert.equal(h.bookmarks.length, 0);
  first.resolve(manifest);
  await tick();
  assert.equal(h.calls.length, 0);
  findButton(h.render(), "继续本站讲解").props.onClick();
  await tick();
  assert.equal(h.calls[0].manifest.startChunk, 2);
  assert.equal(h.calls[0].manifest.startTime, 4.5);
  h.unmount();
});

test("late progress and captions from a previous segment cannot affect the new segment", async () => {
  const h = harness();
  h.initial();
  await tick();
  const old = h.calls[0];
  const nextBookmarks = [];
  h.render({
    narration: { ...source, segmentId: "second" },
    onBookmark: (value) => nextBookmarks.push(value),
  });
  old.manifest.onProgress({ chunkIndex: 5, time: 9 });
  old.caption("旧字幕");
  assert.equal(nextBookmarks.length, 0);
  h.flush();
  await tick();
  old.manifest.onProgress({ chunkIndex: 5, time: 9 });
  old.caption("旧字幕");
  old.done.resolve(true);
  await tick();
  assert.equal(nextBookmarks.length, 0);
  assert.equal(h.calls[1].manifest.startChunk, 0);
  h.unmount();
});

test("late prepared audio from a replaced segment never starts playback", async () => {
  const first = deferred();
  let count = 0;
  const h = harness(async () => (++count === 1 ? first.promise : manifest));
  h.initial();
  h.render({
    narration: { ...source, segmentId: "second" },
    onBookmark: (value) => h.bookmarks.push(value),
  });
  h.flush();
  await tick();
  first.resolve(manifest);
  await tick();
  assert.equal(h.prepares[0].signal.aborted, true);
  assert.equal(h.calls.length, 1);
  h.unmount();
});

test("pausing active playback saves its position and explicit resume uses the same offset", async () => {
  const h = harness();
  h.initial();
  await tick();
  h.advance({ chunkIndex: 1, time: 3.25 });
  h.pause();
  assert.equal(h.bookmarks.at(-1).time, 3.25);
  findButton(h.render(), "继续本站讲解").props.onClick();
  await tick();
  assert.equal(h.calls[1].manifest.startChunk, 1);
  assert.equal(h.calls[1].manifest.startTime, 3.25);
  h.unmount();
});

test("draft narration without staff authentication never calls the public prepare endpoint", async () => {
  const h = harness();
  h.initial({ narration: { ...source, draftRevision: 3 } });
  await tick();
  assert.equal(h.prepares.length, 0);
  assert.equal(h.calls.length, 0);
  assert.ok(findButton(h.render(), "继续本站讲解"));
  h.unmount();
});

test("hidden-page preparation waits for an explicit visible-page resume", async () => {
  const h = harness();
  h.document.visibilityState = "hidden";
  h.initial({ initialBookmark: { chunkIndex: 1, time: 2.5 } });
  await tick();
  assert.equal(h.prepares.length, 0);
  h.document.visibilityState = "visible";
  findButton(h.render(), "继续本站讲解").props.onClick();
  await tick();
  assert.equal(h.calls[0].manifest.startTime, 2.5);
  h.unmount();
});
