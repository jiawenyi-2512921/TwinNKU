import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as visit from "../src/features/visit/session.ts";
import * as audio from "../src/features/visit/audioOwner.ts";

const tourId = "66666666-6666-4666-8666-666666666666";
const anotherTour = "77777777-7777-4777-8777-777777777777";
const session = {
  tourId,
  position: { revision: 4, stopIndex: 1, segmentId: "detail" },
  mode: "onsite",
  audio: { chunkIndex: 2, time: 7.5 },
};
const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const walk = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((item) => walk(item, predicate))
    : tree && typeof tree === "object"
      ? [
          ...(predicate(tree) ? [tree] : []),
          ...walk(tree.props?.children, predicate),
        ]
      : [];
const nodeText = (node) =>
  Array.isArray(node)
    ? node.map(nodeText).join("")
    : node && typeof node === "object"
      ? nodeText(node.props?.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";
const button = (tree, text) =>
  walk(tree, (node) => node.type === "button" && nodeText(node) === text)[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("visit storage projects only validated route, position and bounded audio fields", () => {
  const polluted = {
    ...session,
    csrf: "private",
    token: "private",
    position: { ...session.position, question: "private" },
    audio: { ...session.audio, answer: "private" },
  };
  const normalized = visit.normalizeVisit(polluted);
  assert.deepEqual(normalized, session);
  assert.notEqual(normalized.position, polluted.position);
  assert.notEqual(normalized.audio, polluted.audio);
  assert.equal(visit.normalizeVisit({ ...session, tourId: [tourId] }), null);
  assert.equal(
    visit.normalizeVisit({
      ...session,
      position: { ...session.position, segmentId: ["detail"] },
    }),
    null,
  );
  for (const segmentId of ["../detail", "-starts-invalid", "a".repeat(65)])
    assert.equal(
      visit.normalizeVisit({
        ...session,
        position: { ...session.position, segmentId },
      }),
      null,
    );
  for (const stopIndex of [-1, 50, 1.5])
    assert.equal(
      visit.normalizeVisit({
        ...session,
        position: { ...session.position, stopIndex },
      }),
      null,
    );
  for (const bookmark of [
    { chunkIndex: 100, time: 1 },
    { chunkIndex: 1, time: 180 },
    { chunkIndex: 1, time: Infinity },
  ])
    assert.equal(
      visit.normalizeVisit({ ...session, audio: bookmark }).audio,
      undefined,
    );
});

test("QR links contain only allowed public visit identifiers and opening them carries no audio or autoplay", () => {
  const link = new URL(
    visit.visitLink(
      "https://username:secret@guide.example/admin?session=secret&csrf=secret&point=private&play=1&draft=private&resource=video&resource_id=private&resource_revision=3&resource_point=private#voice",
      session,
    ),
  );
  assert.equal(link.username, "");
  assert.equal(link.password, "");
  assert.throws(
    () => visit.visitLink("javascript:private", session),
    /Invalid visit origin/,
  );
  assert.equal(link.pathname, `/visit/${tourId}`);
  assert.equal(link.hash, "");
  assert.deepEqual(
    [...link.searchParams.keys()],
    ["experience", "revision", "stop", "segment", "mode"],
  );
  assert.equal(link.searchParams.get("experience"), tourId);
  assert.equal(link.searchParams.get("stop"), "1");
  assert.deepEqual(visit.readVisit(link.href), {
    tourId,
    position: session.position,
    mode: "onsite",
  });
  assert.equal(
    visit.readVisit(link.href.replace("revision=4", "revision=0")),
    null,
  );
  assert.equal(
    visit.readVisit(
      link.href.replace("segment=detail", "segment=..%2Fprivate"),
    ),
    null,
  );
  assert.equal(
    visit.readVisit(link.href.replace("mode=onsite", "mode=unknown")).mode,
    "online",
  );
});

test("local recovery rejects a different tour identity and storage failures remain recoverable", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
  });
  try {
    assert.equal(visit.saveVisit(session), true);
    const restored = visit.loadVisit(tourId);
    assert.ok(restored.updatedAt > 0);
    delete restored.updatedAt;
    assert.deepEqual(restored, session);
    stored.set(
      visit.visitStorageKey(tourId, session.position.revision),
      JSON.stringify({ ...session, tourId: anotherTour }),
    );
    assert.equal(visit.loadVisit(tourId), null);
    stored.set(
      visit.visitStorageKey(tourId, session.position.revision),
      "broken-json",
    );
    assert.equal(visit.loadVisit(tourId), null);
    globalThis.localStorage.setItem = () => {
      throw new Error("storage denied");
    };
    assert.equal(visit.saveVisit(session), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("legacy progress migrates only after durable v2 storage and revisions retain independent private records", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    stored = new Map();
  const legacyVisit = `twinnku:visit:${tourId}`,
    legacyProgress = `twinnku:tour:${tourId}`;
  stored.set(legacyVisit, JSON.stringify(session));
  stored.set(
    legacyProgress,
    JSON.stringify({
      revision: 4,
      index: 1,
      completed: [0],
      segmentId: "detail",
    }),
  );
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
    key: (index) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const originalSet = storage.setItem;
    storage.setItem = () => {
      throw new Error("quota");
    };
    const pending = visit.loadVisit(tourId, 4);
    assert.deepEqual(pending.completed, [0]);
    assert.equal(stored.has(legacyVisit), true);
    assert.equal(stored.has(legacyProgress), true);
    storage.setItem = originalSet;
    const migrated = visit.loadVisit(tourId, 4);
    assert.deepEqual(migrated.completed, [0]);
    assert.equal(stored.has(legacyVisit), false);
    assert.equal(stored.has(legacyProgress), false);
    const newer = {
      ...session,
      position: { revision: 5, stopIndex: 0, segmentId: "new" },
      notes: { new: "私人的短笔记" },
      collections: [
        {
          stopIndex: 0,
          segmentId: "new",
          resourceId: anotherTour,
          privateToken: "must not persist",
        },
      ],
    };
    assert.equal(visit.saveVisit(newer), true);
    assert.deepEqual(visit.loadVisit(tourId, 4).completed, [0]);
    assert.equal(visit.loadVisit(tourId).position.revision, 5);
    assert.equal(
      JSON.stringify(visit.listVisits()).includes("privateToken"),
      false,
    );
    stored.set(visit.visitStorageKey(anotherTour, 1), "corrupt-json");
    stored.set(visit.visitStorageKey(anotherTour, 2), JSON.stringify(newer));
    assert.equal(
      visit.listVisits().length,
      2,
      "corrupt or mismatched key records cannot hide or impersonate real records",
    );
    assert.equal(visit.clearVisit(tourId, 4), true);
    assert.equal(visit.loadVisit(tourId).position.revision, 5);
    assert.equal(visit.clearVisit(tourId, 5), true);
    assert.equal(visit.listVisits().length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("stale releases cannot silence a newer tour, video or assistant lease", () => {
  audio.releaseAudio("tour");
  audio.releaseAudio("video");
  audio.releaseAudio("assistant");
  const stops = [];
  const first = audio.acquireAudio("tour", () => stops.push("old-tour"));
  const second = audio.acquireAudio("tour", () => stops.push("new-tour"));
  assert.deepEqual(stops, ["old-tour"]);
  audio.releaseAudio("tour", first);
  const video = audio.acquireAudio("video", () => stops.push("video"));
  assert.deepEqual(stops, ["old-tour", "new-tour"]);
  audio.releaseAudio("tour", second);
  const assistant = audio.acquireAudio("assistant", () =>
    stops.push("old-assistant"),
  );
  assert.equal(stops.at(-1), "video");
  audio.releaseAudio("video", video);
  const thinking = audio.acquireAudio("assistant", () =>
    stops.push("current-assistant"),
  );
  assert.equal(stops.includes("old-assistant"), false);
  audio.releaseAudio("assistant", assistant);
  const final = audio.acquireAudio("tour", () => {});
  assert.equal(stops.at(-1), "current-assistant");
  audio.releaseAudio("assistant", thinking);
  audio.releaseAudio("tour", final);
});

function component(file, modules = {}) {
  const slots = [],
    effects = [];
  let cursor = 0,
    effectCursor = 0;
  const windowEvents = new EventTarget(),
    documentEvents = new EventTarget();
  const browser = {
    location: {
      href: "https://guide.example/?csrf=private&session=private&play=1",
    },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  };
  const document = {
    visibilityState: "visible",
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener:
      documentEvents.removeEventListener.bind(documentEvents),
  };
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots))
        slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === "function" ? next(slots[i]) : next;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(callback, deps) {
      const i = effectCursor++,
        old = effects[i];
      if (
        !old ||
        deps.some((value, index) => !Object.is(value, old.deps[index]))
      )
        effects[i] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
  };
  const exports = {};
  vm.runInNewContext(compile(file), {
    exports,
    Event,
    AbortController,
    window: browser,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "./session") return visit;
      if (name.endsWith(".css")) return {};
      if (name in modules) return modules[name];
      throw new Error("Unexpected test dependency " + name);
    },
  });
  return {
    browser,
    render(name, props) {
      cursor = 0;
      effectCursor = 0;
      return exports[name](props);
    },
    flush() {
      for (const effect of effects)
        if (effect.pending) {
          effect.pending = false;
          effect.cleanup?.();
          effect.cleanup = effect.callback();
        }
    },
    dispose() {
      for (const effect of effects) effect.cleanup?.();
    },
  };
}

test("changing the shared position never shows a stale QR image and an old QR result cannot replace the current link", async () => {
  const requested = [];
  const h = component("../src/features/visit/ShareVisit.tsx", {
    qrcode: {
      default: {
        toDataURL: (link) =>
          new Promise((resolve) => requested.push({ link, resolve })),
      },
    },
  });
  const props = { session };
  let tree = h.render("ShareVisit", props);
  h.flush();
  button(tree, "在手机继续").props.onClick();
  tree = h.render("ShareVisit", props);
  h.flush();
  assert.equal(new URL(requested[0].link).searchParams.has("csrf"), false);
  requested[0].resolve("data:image/png;base64,first");
  await tick();
  tree = h.render("ShareVisit", props);
  assert.equal(
    walk(tree, (node) => node.type === "img")[0].props.src,
    "data:image/png;base64,first",
  );
  props.session = {
    ...session,
    position: { ...session.position, stopIndex: 0, segmentId: "opening" },
  };
  tree = h.render("ShareVisit", props);
  assert.equal(
    walk(tree, (node) => node.type === "img").length,
    0,
    "no stale image even before its effect runs",
  );
  h.flush();
  props.session = {
    ...session,
    position: { ...session.position, revision: 5 },
  };
  h.render("ShareVisit", props);
  h.flush();
  requested[1].resolve("data:image/png;base64,stale");
  await tick();
  tree = h.render("ShareVisit", props);
  assert.equal(walk(tree, (node) => node.type === "img").length, 0);
  requested[2].resolve("data:image/png;base64,current");
  await tick();
  tree = h.render("ShareVisit", props);
  assert.equal(
    walk(tree, (node) => node.type === "img")[0].props.src,
    "data:image/png;base64,current",
  );
  assert.equal(
    new URL(
      walk(tree, (node) => node.type === "input")[0].props.value,
    ).searchParams.get("revision"),
    "5",
  );
  h.dispose();
});

test("a mounted narrator pauses for a resource and resumes saved audio only after a user click", async () => {
  const prepared = [],
    spoken = [],
    saved = [];
  let pauses = 0;
  const speaker = {
    unlock() {},
    cancel() {},
    pause() {
      pauses++;
      return { chunkIndex: 2, time: 7.5 };
    },
    speak(text, _caption, options) {
      spoken.push({ text, options });
      return new Promise(() => {});
    },
  };
  const h = component("../src/features/visit/TourNarrator.tsx", {
    "../agent/Companion": { Companion: () => null },
    "../agent/cloudVoice": {
      createBrowserSpeechFallback: () => ({ speak() {}, cancel() {} }),
      createCloudSpeaker: () => speaker,
    },
    "../agent/voice": { browserVoiceEnvironment: () => ({}) },
    "../../shared/visitorSession": {
      prepareDraftVoice: async (source) => {
        prepared.push(source);
        return { chunks: [] };
      },
    },
    "../../shared/api/client": {
      get: async () => {
        throw new Error("No public request expected");
      },
    },
    "./recordedAudio": {
      createRecordedPlayer: () => ({ cancel() {}, pause() {}, unlock() {} }),
    },
    "./audioOwner": audio,
  });
  const props = {
    narration: {
      tourId,
      tourRevision: 4,
      stopIndex: 1,
      segmentId: "detail",
      text: "服务器对应讲解",
      sourceNote: "来源",
    },
    onBookmark: (value) => saved.push(value),
  };
  h.render("TourNarrator", props);
  h.flush();
  await tick();
  assert.equal(
    prepared.length,
    0,
    "text narration has no paid or visitor-session request",
  );
  assert.equal(spoken.length, 1);
  h.browser.dispatchEvent(new Event("twinnku:tour-pause"));
  let tree = h.render("TourNarrator", props);
  h.flush();
  await tick();
  assert.ok(pauses > 0);
  assert.equal(saved.at(-1).time, 7.5);
  assert.equal(prepared.length, 0);
  assert.ok(button(tree, "继续本站讲解"));
  tree = h.render("TourNarrator", props);
  h.flush();
  await tick();
  assert.equal(
    prepared.length,
    0,
    "returning to the same mounted narrator does not prepare or autoplay",
  );
  button(tree, "继续本站讲解").props.onClick();
  await tick();
  assert.equal(prepared.length, 0);
  assert.equal(spoken[1].options.startChunk, 2);
  assert.equal(spoken[1].options.startTime, 7.5);
  h.dispose();
});
