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
  const manifests = new Map();
  const speaker = createCloudSpeaker({
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body);
      calls.push({
        ...body,
        text: manifests.get(body.permit)?.[body.chunk_index],
        signal: init.signal,
      });
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
  const speak = speaker.speak.bind(speaker);
  speaker.speak = (text, caption, manifest) => {
    manifest ??= {
      permit: `test-permit-${manifests.size}`,
      chunks: splitForSpeech(speakableText(text)),
      csrf: "test-only-csrf",
    };
    manifests.set(manifest.permit, manifest.chunks);
    return speak(text, caption, manifest);
  };
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
test("the first sentence is a short clip even when an entire answer fits the API limit", () => {
  const text = "先为你打开图书馆。" + "接下来是楼层资料的介绍。".repeat(12);
  const parts = splitForSpeech(text);
  assert.ok(text.length < 300);
  assert.equal(parts[0], "先为你打开图书馆。");
  assert.equal(parts.join(""), text);
  assert.ok(parts.slice(1).every((part) => part.length <= 300));
  const unpunctuated = splitForSpeech("甲".repeat(750));
  assert.equal(unpunctuated[0].length, 80);
  assert.ok(unpunctuated.every((part) => part.length <= 300));
  assert.equal(unpunctuated.join(""), "甲".repeat(750));
});
test("first and later clip limits preserve complete Unicode characters", () => {
  for (const text of [
    "甲".repeat(79) + "😊" + "乙".repeat(350),
    "甲".repeat(78) + "😊" + "乙".repeat(350),
    "第一句。" + "乙".repeat(299) + "😊" + "丙".repeat(20),
  ]) {
    const parts = splitForSpeech(text);
    assert.equal(parts.join(""), text);
    assert.ok(
      parts.every((part) => part.isWellFormed()),
      "no request contains an isolated high or low surrogate",
    );
    assert.ok(parts[0].length <= 80);
    assert.ok(parts.every((part) => part.length <= 300));
  }
  const opening = splitForSpeech("甲".repeat(79) + "😊" + "乙");
  assert.equal(opening[0].length, 79);
  assert.ok(opening[1].startsWith("😊"));
  const later = splitForSpeech(
    "第一句。" + "乙".repeat(299) + "😊" + "丙".repeat(20),
  );
  assert.equal(later[1].length, 299);
  assert.ok(later[2].startsWith("😊"));
});
test("spoken copy removes markup and code", () => {
  assert.equal(
    speakableText(
      "## 标题\n请看[链接](https://example.com)和`代码`\n```js\nlet a=1;\n```",
    ),
    "标题 请看链接和代码",
  );
});
test("short multi-sentence answers stay in one clip and make one synthesis request", async () => {
  for (const text of ["你好。我是小开。", "第一句。" + "乙".repeat(75)]) {
    assert.ok(text.length <= 80);
    assert.deepEqual(splitForSpeech(text), [text]);
    const h = harness();
    assert.equal(await h.speaker.speak(text), true);
    assert.deepEqual(
      h.calls.map((call) => call.text),
      [text],
    );
    assert.equal(h.created[0].played.length, 1);
    h.speaker.cancel();
  }
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
test("only one next clip is requested during current playback and requests never repeat", async () => {
  const text = "第一句。" + "后续内容用于分段预取验证。".repeat(60),
    clips = splitForSpeech(text),
    requests = [];
  const h = harness("deferred", undefined, {
    fetchImpl: (_url, init) =>
      new Promise((resolve, reject) => {
        requests.push({
          ...JSON.parse(init.body),
          signal: init.signal,
          complete: () =>
            resolve({
              ok: true,
              blob: async () => new Blob([new Uint8Array(64)]),
            }),
        });
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
  });
  const pending = h.speaker.speak(text);
  assert.deepEqual(
    requests.map((request) => request.chunk_index),
    [0],
  );
  requests[0].complete();
  await settle();
  assert.equal(h.speaker.state, "loading");
  assert.equal(requests.length, 1, "play() alone does not start prefetch");
  h.setMode("manual");
  h.created[0].paused = false;
  h.created[0].onplaying();
  await settle();
  assert.equal(h.speaker.state, "speaking");
  assert.equal(h.created[0].played.length, 1);
  assert.deepEqual(
    requests.map((request) => request.chunk_index),
    [0, 1],
  );
  // Finishing synthesis alone cannot fetch a third clip or interrupt this one.
  requests[1].complete();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(h.created[0].played.length, 1);
  h.created[0].onended();
  await settle();
  assert.equal(h.created[0].played.length, 2);
  assert.deepEqual(
    requests.map((request) => request.chunk_index),
    [0, 1, 2],
  );
  for (let index = 2; index < clips.length; index++) {
    requests[index].complete();
    await settle();
    h.created[0].onended();
    await settle();
  }
  // Finish the last real playback event after the rolling requests complete.
  h.created[0].onended?.();
  assert.equal(await pending, true);
  assert.deepEqual(
    requests.map((request) => request.chunk_index),
    clips.map((_, index) => index),
  );
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].played.length, clips.length);
  h.speaker.cancel();
});
test("refused autoplay does not prefetch until the retained clip is resumed", async () => {
  const h = harness("blocked"),
    text = "第一句。" + "第二句用于说明。".repeat(12),
    pending = h.speaker.speak(text);
  await settle();
  assert.equal(h.speaker.state, "blocked");
  assert.equal(h.calls.length, 1);
  h.setMode("ok");
  h.speaker.unlock();
  assert.equal(await pending, true);
  assert.deepEqual(
    h.calls.map((call) => call.text),
    splitForSpeech(text),
  );
  h.speaker.cancel();
});
test("cancellation aborts the next clip and late prefetch cannot replace a new answer", async () => {
  const requests = [],
    captions = [];
  let finishPrefetch;
  const h = harness("manual", undefined, {
    fetchImpl: (_url, init) => {
      requests.push({ ...JSON.parse(init.body), signal: init.signal });
      if (requests.length === 2)
        return new Promise((resolve) => {
          finishPrefetch = resolve;
        });
      return Promise.resolve({
        ok: true,
        blob: async () => new Blob([new Uint8Array(64)]),
      });
    },
  });
  const pending = h.speaker.speak(
    "第一句。" + "旧回答的后续内容。".repeat(12),
    (caption) => captions.push(caption),
  );
  await settle();
  assert.equal(requests.length, 2);
  h.speaker.cancel();
  assert.equal(await pending, false);
  assert.equal(requests[1].signal.aborted, true);
  h.setMode("ok");
  const replacement = h.speaker.speak("新回答。", (caption) =>
    captions.push(caption),
  );
  finishPrefetch({
    ok: true,
    blob: async () => new Blob([new Uint8Array(64)]),
  });
  assert.equal(await replacement, true);
  assert.deepEqual(captions, ["第一句。", "新回答。"]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].signal.aborted, false);
  assert.equal(h.created[0].played.length, 2);
  assert.equal(h.speaker.state, "idle");
  h.speaker.cancel();
});
test("failed prefetch waits for the current clip to finish and degrades only the unplayed text", async () => {
  const spoken = [],
    text = "第一句。" + "乙".repeat(100),
    h = harness("manual", [64, null], {
      fallbackSpeak: (value, done) => {
        spoken.push(value);
        done(true);
      },
    });
  let completed = false;
  const pending = h.speaker.speak(text).then((result) => {
    completed = true;
    return result;
  });
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(completed, false);
  assert.equal(h.speaker.state, "speaking");
  assert.deepEqual(spoken, []);
  h.created[0].onended();
  assert.equal(await pending, true);
  assert.deepEqual(spoken, ["乙".repeat(100)]);
  h.speaker.cancel();
});
test("playback failure aborts pending prefetch before falling back", async () => {
  const spoken = [],
    requests = [],
    text = "第一句。" + "未播放的第二句。".repeat(12);
  const h = harness("manual", undefined, {
    fetchImpl: (_url, init) => {
      requests.push(init);
      if (requests.length === 1)
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob([new Uint8Array(64)]),
        });
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    },
    fallbackSpeak: (value, done) => {
      spoken.push(value);
      done(true);
    },
  });
  const pending = h.speaker.speak(text);
  await settle();
  assert.equal(requests.length, 2);
  h.created[0].onerror();
  assert.equal(await pending, true);
  assert.equal(requests[1].signal.aborted, true);
  assert.deepEqual(spoken, [text]);
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
  const text = "第一句。" + "乙".repeat(100),
    spoken = [];
  const h = harness("ok", [64, null], {
    fallbackSpeak: (value, done) => {
      spoken.push(value);
      done(true);
    },
  });
  assert.equal(await h.speaker.speak(text), true);
  assert.deepEqual(spoken, ["乙".repeat(100)]);
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

test("unpermitted text uses browser fallback and never becomes a paid raw-text request", async () => {
  let paid = 0;
  const speaker = createCloudSpeaker({
    fetchImpl: async () => {
      paid++;
      throw new Error("must not be called");
    },
    fallbackSpeak: (_text, done) => done(true),
  });
  assert.equal(await speaker.speak("只有本地文本，没有服务器许可。"), true);
  assert.equal(paid, 0);
});

test("server manifest owns chunks and paid request carries only permit/index plus csrf", async () => {
  const requests = [];
  const manifest = {
    permit: "server-only-permit",
    csrf: "session-only-csrf",
    chunks: ["后台第一段。", "后台第二段。"],
  };
  const h = harness("ok", undefined, {
    fetchImpl: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(init.body),
        headers: init.headers,
        credentials: init.credentials,
      });
      return { ok: true, blob: async () => new Blob([new Uint8Array(20)]) };
    },
  });
  assert.equal(
    await h.speaker.speak(manifest.chunks.join(""), undefined, manifest),
    true,
  );
  assert.deepEqual(
    requests.map((request) => request.body),
    [
      { permit: manifest.permit, chunk_index: 0 },
      { permit: manifest.permit, chunk_index: 1 },
    ],
  );
  assert.ok(requests.every((request) => !Object.hasOwn(request.body, "text")));
  assert.ok(
    requests.every(
      (request) => request.headers["x-csrf-token"] === manifest.csrf,
    ),
  );
  assert.ok(requests.every((request) => request.credentials === "same-origin"));
});

test("pause returns current cloud position; resumed audio seeks only after metadata", async () => {
  const h = harness("manual");
  const manifest = {
    permit: "permit",
    csrf: "csrf",
    chunks: ["第一段。", "第二段。"],
  };
  const first = h.speaker.speak(manifest.chunks.join(""), undefined, manifest);
  await settle();
  h.created[0].currentTime = 3.25;
  h.created[0].ontimeupdate();
  const bookmark = h.speaker.pause();
  assert.deepEqual(bookmark, { chunkIndex: 0, time: 3.25 });
  assert.equal(await first, false);
  const previousPlays = h.created[0].played.length;
  const progress = [];
  const resume = h.speaker.speak(manifest.chunks.join(""), undefined, {
    ...manifest,
    startChunk: bookmark.chunkIndex,
    startTime: bookmark.time,
    onProgress: (value) => progress.push(value),
  });
  await settle();
  assert.equal(h.created[0].played.length, previousPlays);
  h.created[0].duration = 20;
  h.created[0].onloadedmetadata();
  assert.equal(h.created[0].currentTime, 3.25);
  h.created[0].currentTime = 4;
  h.created[0].ontimeupdate();
  assert.deepEqual(progress.at(-1), { chunkIndex: 0, time: 4 });
  h.speaker.cancel();
  assert.equal(await resume, false);
});
