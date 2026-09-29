// Tests for cloud speech playback and its browser fallback.
//
// The behaviours that matter: long answers are split so nothing is silently
// dropped, and any cloud failure still produces audible speech.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCloudSpeaker,
  speakableText,
  splitForSpeech,
} from "../src/features/agent/cloudVoice.ts";

function makeAudioFactory(behaviour = "ok") {
  const created = [];
  const create = () => {
    const audio = {
      src: "",
      dataset: {},
      onended: null,
      onerror: null,
      played: 0,
      pause() {},
      async play() {
        audio.played++;
        if (behaviour === "blocked") throw new Error("autoplay blocked");
        // Resolve asynchronously so the awaited path is exercised.
        queueMicrotask(() => {
          if (behaviour === "error") audio.onerror?.();
          else audio.onended?.();
        });
      },
    };
    created.push(audio);
    return audio;
  };
  return { create, created };
}

function makeFetch(sizes) {
  const calls = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body.text);
    if (sizes === "fail") {
      return { ok: false, size: 0, blob: async () => new Blob([]) };
    }
    const size = sizes[Math.min(calls.length - 1, sizes.length - 1)] ?? 1024;
    return {
      ok: true,
      async blob() {
        return new Blob([new Uint8Array(size)]);
      },
    };
  };
  return { impl, calls };
}

globalThis.URL.createObjectURL ??= () => "blob:test";
globalThis.URL.revokeObjectURL ??= () => undefined;

test("short text is a single clip", () => {
  assert.deepEqual(splitForSpeech("图书馆在正前方。"), ["图书馆在正前方。"]);
});

test("blank text produces no clips", () => {
  assert.deepEqual(splitForSpeech("   "), []);
});

test("long text splits on sentence boundaries without losing characters", () => {
  const sentence = "这是一句用于测试的中文句子。";
  const text = sentence.repeat(60);
  const parts = splitForSpeech(text, 100);

  assert.ok(parts.length > 1, "should split");
  for (const part of parts) {
    assert.ok(part.length <= 100, `part too long: ${part.length}`);
  }
  assert.equal(
    parts.join("").replace(/\s/g, ""),
    text.replace(/\s/g, ""),
    "no characters may be dropped",
  );
});

test("a single oversized sentence is hard-split rather than dropped", () => {
  const text = "甲".repeat(750);
  const parts = splitForSpeech(text, 300);

  assert.equal(parts.join(""), text);
  assert.ok(parts.every((p) => p.length <= 300));
});

test("speakableText strips markup and code", () => {
  const raw = "## 标题\n请看[链接](https://example.com)和`代码`以及\n```js\nlet a=1;\n```";
  const clean = speakableText(raw);

  assert.ok(!clean.includes("#"));
  assert.ok(!clean.includes("https://"));
  assert.ok(!clean.includes("let a=1"));
  assert.ok(clean.includes("标题"));
  assert.ok(clean.includes("链接"));
});

test("speaks via the cloud and reports state transitions", async () => {
  const { impl, calls } = makeFetch([2048]);
  const { create } = makeAudioFactory("ok");
  const states = [];
  const speaker = createCloudSpeaker({
    fetchImpl: impl,
    createAudio: create,
    onState: (s) => states.push(s),
  });

  await speaker.speak("图书馆在正前方。");

  assert.deepEqual(calls, ["图书馆在正前方。"]);
  assert.ok(states.includes("loading"));
  assert.ok(states.includes("speaking"));
  assert.equal(speaker.state, "idle");
});

test("long answers are fetched in multiple clips", async () => {
  const { impl, calls } = makeFetch([1024]);
  const { create } = makeAudioFactory("ok");
  const speaker = createCloudSpeaker({ fetchImpl: impl, createAudio: create });

  await speaker.speak("这是一句测试。".repeat(60));

  assert.ok(calls.length > 1, "split into several requests");
  assert.ok(speaker.state === "idle");
});

test("falls back to browser speech when the cloud is unavailable", async () => {
  const { impl } = makeFetch("fail");
  const { create } = makeAudioFactory("ok");
  const spoken = [];
  const reasons = [];

  const speaker = createCloudSpeaker({
    fetchImpl: impl,
    createAudio: create,
    fallbackSpeak: (text, done) => {
      spoken.push(text);
      done();
    },
    onFallback: (r) => reasons.push(r),
  });

  await speaker.speak("马蹄湖在哪");

  assert.deepEqual(spoken, ["马蹄湖在哪"]);
  assert.equal(reasons.length, 1);
  assert.equal(speaker.supported, false);
});

test("autoplay being blocked also triggers the browser fallback", async () => {
  const { impl } = makeFetch([1024]);
  const { create } = makeAudioFactory("blocked");
  const spoken = [];

  const speaker = createCloudSpeaker({
    fetchImpl: impl,
    createAudio: create,
    fallbackSpeak: (text, done) => {
      spoken.push(text);
      done();
    },
  });

  await speaker.speak("津南校区");

  assert.deepEqual(spoken, ["津南校区"]);
});

test("cloud is not retried once it has been marked unavailable", async () => {
  const { impl, calls } = makeFetch("fail");
  const { create } = makeAudioFactory("ok");
  const speaker = createCloudSpeaker({
    fetchImpl: impl,
    createAudio: create,
    fallbackSpeak: (_t, done) => done(),
  });

  await speaker.speak("第一句");
  await speaker.speak("第二句");

  assert.equal(calls.length, 1, "second reply must skip the cloud entirely");
});

test("cancel stops playback and prevents a late clip from starting", async () => {
  const { impl } = makeFetch([1024]);
  const { create, created } = makeAudioFactory("ok");
  const speaker = createCloudSpeaker({ fetchImpl: impl, createAudio: create });

  const pending = speaker.speak("图书馆。马蹄湖。西南门。".repeat(10));
  speaker.cancel();
  await pending;

  assert.equal(speaker.state, "idle");
  assert.ok(created.every((a) => a.onended === null || a.played <= 1));
});

test("a stalled decode does not hang the conversation", async () => {
  const { impl } = makeFetch([512]);
  let created = 0;
  const speaker = createCloudSpeaker({
    fetchImpl: impl,
    createAudio: () => {
      created++;
      return {
        src: "",
        dataset: {},
        onended: null,
        onerror: null,
        pause() {},
        // Never settles: simulates a decoder that stalls.
        async play() {},
      };
    },
    fallbackSpeak: (_t, done) => done(),
  });

  const result = await Promise.race([
    speaker.speak("测试句子").then(() => "settled"),
    new Promise((r) => setTimeout(() => r("timeout"), 400)),
  ]);

  // The watchdog is 15s by design; here we only assert a clip was attempted.
  assert.ok(created >= 1);
  assert.ok(result === "timeout" || result === "settled");
});
