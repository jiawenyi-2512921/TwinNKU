import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBrowserSpeechFallback,
  createCloudSpeaker,
  speakableText,
  splitForSpeech,
} from "../src/features/agent/cloudVoice.ts";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(mode = "ok", sizes = [1024], extra = {}) {
  const created = [],
    calls = [],
    states = [],
    silent = [];
  const speaker = createCloudSpeaker({
    async fetchImpl(_url, init) {
      calls.push({ ...JSON.parse(init.body), signal: init.signal });
      const size = sizes[Math.min(calls.length - 1, sizes.length - 1)];
      return {
        ok: size !== null,
        blob: async () => new Blob([new Uint8Array(size ?? 0)]),
      };
    },
    createAudio() {
      const element = {
        src: "",
        muted: false,
        paused: true,
        currentTime: 0,
        onended: null,
        onerror: null,
        onplaying: null,
        played: [],
        pause() {
          this.paused = true;
        },
        load() {},
        removeAttribute(name) {
          if (name === "src") this.src = "";
        },
        play() {
          this.played.push(this.src);
          if (mode === "blocked")
            return Promise.reject(
              new DOMException("blocked", "NotAllowedError"),
            );
          if (mode === "hanging") return new Promise(() => {});
          if (mode === "deferred") return Promise.resolve();
          this.paused = false;
          queueMicrotask(() => {
            if (mode === "error") this.onerror?.();
            else {
              this.onplaying?.();
              if (mode !== "manual") this.onended?.();
            }
          });
          return Promise.resolve();
        },
      };
      created.push(element);
      return element;
    },
    onState: (value) => states.push(value),
    onSilent: (value) => silent.push(value),
    ...extra,
  });
  return {
    speaker,
    created,
    calls,
    states,
    silent,
    setMode(value) {
      mode = value;
    },
  };
}
test("splitting preserves text and bounds clips; blank and short answers remain correct", () => {
  assert.deepEqual(splitForSpeech("  "), []);
  assert.deepEqual(splitForSpeech("图书馆在正前方。"), ["图书馆在正前方。"]);
  for (const text of [
    "这是一句用于测试的中文句子。".repeat(60),
    "甲".repeat(750),
  ]) {
    const parts = splitForSpeech(text, 100);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= 100));
    assert.equal(parts.join(""), text);
  }
});
test("spoken copy removes markup and code", () => {
  assert.equal(
    speakableText(
      "## 标题\n请看[链接](https://example.com)和`代码`\n```js\nlet a=1;\n```",
    ),
    "标题 请看链接和代码",
  );
});
test("first gesture primes an unmuted blob player synchronously and every clip reuses it", async () => {
  const h = harness();
  assert.equal(h.created.length, 0);
  assert.equal(h.speaker.unlock(), true);
  const player = h.created[0];
  assert.equal(
    player.played.length,
    1,
    "play runs inside the gesture, before any await",
  );
  assert.match(
    player.played[0],
    /^blob:/,
    "data: audio is forbidden by the site CSP",
  );
  assert.equal(player.muted, false);
  await settle();
  await h.speaker.speak("这是第一句。".repeat(90));
  await h.speaker.speak("第二轮回答。");
  assert.ok(h.calls.length > 2);
  assert.equal(h.created.length, 1, "Safari permission belongs to this player");
  assert.equal(player.played.length, h.calls.length + 1);
  assert.equal(h.speaker.state, "idle");
  h.speaker.cancel();
});
test("cloud caption follows the real clip start", async () => {
  const h = harness(),
    captions = [];
  assert.equal(
    await h.speaker.speak("图书馆在正前方。", (value) => captions.push(value)),
    true,
  );
  assert.deepEqual(captions, ["图书馆在正前方。"]);
  assert.deepEqual(h.states, ["loading", "speaking", "idle"]);
  h.speaker.cancel();
});
test("autoplay denial retains audio and a gesture resumes it without refetch or fallback", async () => {
  const spoken = [],
    h = harness("blocked", undefined, {
      fallbackSpeak: (text, done) => {
        spoken.push(text);
        done();
      },
    });
  const pending = h.speaker.speak("津南校区");
  await settle();
  assert.equal(h.speaker.state, "blocked");
  assert.match(h.silent.at(-1), /播放图标/);
  assert.deepEqual(spoken, []);
  const player = h.created[0],
    clip = player.src;
  assert.match(clip, /^blob:/);
  h.setMode("ok");
  h.speaker.unlock();
  assert.equal(
    player.played.length,
    2,
    "retry is synchronous in the click handler",
  );
  assert.equal(player.played[1], clip);
  assert.equal(await pending, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.created.length, 1);
  h.speaker.cancel();
});
test("resolved play without progress exposes recovery instead of pretending to finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("deferred"),
    pending = h.speaker.speak("马蹄湖在哪儿");
  await settle();
  t.mock.timers.tick(1500);
  assert.equal(h.speaker.state, "blocked");
  h.setMode("ok");
  h.speaker.unlock();
  assert.equal(await pending, true);
  h.speaker.cancel();
});
test("cancel settles a blocked clip and removes callbacks and source", async () => {
  const h = harness("blocked"),
    pending = h.speaker.speak("旧回答");
  await settle();
  const player = h.created[0],
    lateEnd = player.onended;
  h.speaker.cancel();
  assert.equal(await pending, false);
  assert.equal(player.src, "");
  assert.equal(player.onended, null);
  lateEnd();
  assert.equal(h.speaker.state, "idle");
});
test("cancel aborts synthesis and a late response cannot create audio", async () => {
  let finish, signal;
  const h = harness("ok", undefined, {
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = h.speaker.speak("旧回答");
  h.speaker.cancel();
  assert.equal(signal.aborted, true);
  finish({ ok: true, blob: async () => new Blob([new Uint8Array(64)]) });
  assert.equal(await pending, false);
  assert.equal(h.created.length, 0);
});
test("stalled play promises are bounded by the watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness("hanging"),
    pending = h.speaker.speak("测试");
  await settle();
  t.mock.timers.tick(1500);
  assert.equal(h.speaker.state, "blocked");
  t.mock.timers.tick(120000);
  assert.equal(await pending, false);
  assert.equal(h.speaker.state, "idle");
  assert.match(h.silent.at(-1), /未能播放/);
  h.speaker.cancel();
});
test("service, decode and empty audio failures use browser completion callbacks", async () => {
  for (const [mode, sizes] of [
    ["ok", [null]],
    ["error", [64]],
    ["ok", [0]],
  ]) {
    const spoken = [],
      h = harness(mode, sizes, {
        fallbackSpeak: (text, done) => {
          spoken.push(text);
          queueMicrotask(() => done(true));
        },
      });
    assert.equal(await h.speaker.speak("马蹄湖在哪"), true);
    assert.deepEqual(spoken, ["马蹄湖在哪"]);
    assert.equal(h.speaker.supported, false);
    h.speaker.cancel();
  }
});
test("fallback does not repeat cloud segments that already finished", async () => {
  const text = "甲".repeat(300) + "乙".repeat(20),
    spoken = [];
  const h = harness("ok", [64, null], {
    fallbackSpeak: (value, done) => {
      spoken.push(value);
      done(true);
    },
  });
  assert.equal(await h.speaker.speak(text), true);
  assert.deepEqual(spoken, ["乙".repeat(20)]);
  h.speaker.cancel();
});
test("temporary service failure is retried after cooldown instead of disabling cloud forever", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const h = harness("ok", [null, 64], {
    fallbackSpeak: (_text, done) => done(true),
  });
  await h.speaker.speak("第一句");
  await h.speaker.speak("第二句");
  assert.equal(h.calls.length, 1);
  assert.equal(h.speaker.unlock(), false);
  t.mock.timers.tick(60000);
  assert.equal(await h.speaker.speak("第三句"), true);
  assert.equal(h.calls.length, 2);
  h.speaker.cancel();
});
test("missing, false, throwing and asynchronous-error browser fallbacks report failure", async () => {
  for (const fallbackSpeak of [
    undefined,
    () => false,
    () => {
      throw new Error("failed");
    },
    (_text, done) => queueMicrotask(() => done(false)),
  ]) {
    const h = harness("ok", [null], { fallbackSpeak });
    assert.equal(await h.speaker.speak("回答"), false);
    assert.match(h.silent.at(-1), /未能播放/);
    h.speaker.cancel();
  }
});
test("cancel settles browser fallback and suppresses late completion", async () => {
  let lateDone;
  const h = harness("ok", [null], {
    fallbackSpeak: (_text, done) => {
      lateDone = done;
    },
  });
  const pending = h.speaker.speak("回答");
  await settle();
  h.speaker.cancel();
  assert.equal(await pending, false);
  lateDone(true);
  assert.equal(h.speaker.state, "idle");
  assert.deepEqual(h.silent, []);
});
test("actual browser adapter distinguishes missing synthesis, errors and thrown calls", () => {
  for (const kind of ["missing", "error", "throw"]) {
    const outcomes = [],
      utterance = {},
      environment =
        kind === "missing"
          ? {}
          : {
              utterance: () => utterance,
              speak() {
                if (kind === "throw") throw new Error("failed");
              },
            };
    const fallback = createBrowserSpeechFallback(environment);
    fallback.speak("回答", (success) => outcomes.push(success));
    if (kind === "error") utterance.onerror();
    assert.deepEqual(outcomes, [false]);
    fallback.cancel();
  }
});
test("browser boundaries follow real offsets and stale callbacks cannot revive cancelled speech", () => {
  const outcomes = [],
    captions = [],
    utterance = {};
  const fallback = createBrowserSpeechFallback({
    utterance: () => utterance,
    speak() {},
  });
  fallback.speak(
    "第一句。第二句。",
    (value) => outcomes.push(value),
    (value) => captions.push(value),
  );
  utterance.onboundary({ charIndex: 4 });
  assert.deepEqual(captions, ["第一句。", "第二句。"]);
  const lateEnd = utterance.onend,
    lateBoundary = utterance.onboundary;
  fallback.cancel();
  lateEnd();
  lateBoundary({ charIndex: 0 });
  assert.deepEqual(outcomes, [false]);
  assert.deepEqual(captions, ["第一句。", "第二句。"]);
});
