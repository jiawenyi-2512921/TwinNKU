import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRecordedPlayer,
  recordedOffset,
  sha256,
  validateRecordedManifest,
} from "../src/features/visit/recordedAudio.ts";

const route = "11111111-1111-4111-8111-111111111111",
  asset = "22222222-2222-4222-8222-222222222222";
const bytes = new TextEncoder().encode("RIFFtest-audio-WAVE");
const digest = await sha256(bytes),
  textHash = await sha256(new TextEncoder().encode("正式原文"));
const chunk = (id = "c1") => ({
  chunk_id: id,
  text: "正式原文",
  duration_seconds: 3,
  byte_size: bytes.byteLength,
  sha256: digest,
  url: `/api/v1/experiences/${route}/narration/${asset}/chunks/${id}?revision=4&stop_index=1&segment_id=detail`,
});
const manifest = () => ({
  asset_id: asset,
  manifest_id: "manifest-one",
  text_sha256: textHash,
  chunks: [chunk()],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (test) => {
  for (let n = 0; n < 100 && !test(); n++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(test(), "playback reached expected actual state");
};

test("formal audio accepts only exact public or authorized staff asset URLs and bounded files", () => {
  assert.deepEqual(
    validateRecordedManifest(manifest(), route, 4, 1, "detail"),
    manifest(),
  );
  for (const mutate of [
    (m) => (m.chunks[0].url = "https://other.example/audio.wav"),
    (m) =>
      (m.chunks[0].url = m.chunks[0].url.replace("revision=4", "revision=5")),
    (m) => (m.chunks[0].url += "&revision=4#private"),
    (m) => m.chunks.push({ ...m.chunks[0] }),
    (m) => (m.chunks[0].byte_size = 9 * 1024 * 1024),
    (m) => (m.chunks[0].duration_seconds = 181),
    (m) => (m.asset_id = "../private"),
    (m) => (m.chunks[0].sha256 = "bad"),
  ]) {
    const value = manifest();
    mutate(value);
    assert.throws(() => validateRecordedManifest(value, route, 4, 1, "detail"));
  }
  const staff = manifest();
  staff.chunks[0].url = `/api/v1/admin/narration-assets/${asset}/chunks/c1`;
  for (const url of [
    chunk().url + "&revision=4",
    chunk().url + "&csrf=private",
    chunk().url.replace("/chunks/c1", "/chunks/nested/../c1"),
    chunk().url.replace("/chunks/c1", "/chunks/../../../../admin/chunks/c1"),
  ]) {
    const invalid = manifest();
    invalid.chunks[0].url = url;
    assert.throws(() =>
      validateRecordedManifest(invalid, route, 4, 1, "detail"),
    );
  }
  assert.deepEqual(
    validateRecordedManifest(staff, route, 4, 1, "detail", asset),
    staff,
  );
  assert.throws(() => validateRecordedManifest(staff, route, 4, 1, "detail"));
  assert.throws(() =>
    validateRecordedManifest(
      staff,
      route,
      4,
      1,
      "detail",
      "33333333-3333-4333-8333-333333333333",
    ),
  );
});

test("resume binds manifest, chunk ID and text fingerprint rather than the former array position", () => {
  const m = manifest();
  m.chunks = [chunk("second"), chunk("first")];
  assert.deepEqual(
    recordedOffset(m, {
      manifestId: m.manifest_id,
      chunkId: "first",
      textSha256: textHash,
      chunkIndex: 0,
      time: 1.25,
    }),
    { index: 1, time: 1.25, reset: false },
  );
  for (const bookmark of [
    { chunkIndex: 1, time: 2 },
    {
      manifestId: "old",
      chunkId: "first",
      textSha256: textHash,
      chunkIndex: 1,
      time: 2,
    },
    {
      manifestId: m.manifest_id,
      chunkId: "first",
      textSha256: "0".repeat(64),
      chunkIndex: 1,
      time: 2,
    },
  ])
    assert.deepEqual(recordedOffset(m, bookmark), {
      index: 0,
      time: 0,
      reset: true,
    });
});

async function playerTest(
  run,
  fetcher = async () =>
    new Response(bytes, { headers: { "content-type": "audio/wav" } }),
) {
  const previousAudio = globalThis.Audio,
    previousFetch = globalThis.fetch;
  const instances = [],
    requests = [],
    states = [];
  class Audio {
    currentTime = 0;
    duration = 3;
    src = "";
    plays = 0;
    denied = false;
    constructor() {
      instances.push(this);
    }
    pause() {}
    load() {}
    removeAttribute() {
      this.src = "";
    }
    play() {
      this.plays++;
      return this.denied
        ? Promise.reject(
            Object.assign(new Error("blocked"), { name: "NotAllowedError" }),
          )
        : Promise.resolve();
    }
  }
  globalThis.Audio = Audio;
  globalThis.fetch = (url, options) => {
    requests.push({ url, options });
    return fetcher(url, options);
  };
  const player = createRecordedPlayer((value) => states.push(value));
  try {
    await run({ player, audio: instances[0], instances, requests, states });
  } finally {
    player.cancel();
    globalThis.fetch = previousFetch;
    if (previousAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = previousAudio;
  }
}

test("public playback fetches verified chunks without credentials or a guest/paid request, and one mounted audio is reused", async () => {
  await playerTest(async ({ player, audio, instances, requests }) => {
    const captions = [],
      bookmarks = [],
      m = manifest();
    m.chunks.push(chunk("c2"));
    const result = player.play(
      m,
      undefined,
      (v) => captions.push(v),
      (v) => bookmarks.push(v),
      new AbortController().signal,
    );
    await until(() => typeof audio.ontimeupdate === "function");
    assert.equal(instances.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, "omit");
    assert.equal(requests[0].options.redirect, "error");
    audio.currentTime = 1.5;
    audio.ontimeupdate();
    assert.equal(bookmarks[0].chunkId, "c1");
    assert.equal(bookmarks[0].manifestId, m.manifest_id);
    assert.equal(bookmarks[0].textSha256, textHash);
    audio.onended();
    await until(
      () => requests.length === 2 && typeof audio.onended === "function",
    );
    assert.equal(requests.length, 2);
    assert.equal(instances.length, 1);
    audio.onended();
    assert.equal(await result, true);
    assert.deepEqual(captions, ["正式原文", "正式原文"]);
    assert.ok(
      requests.every(
        (r) => r.url.includes("/narration/") && !r.url.includes("prepare"),
      ),
    );
  });
});

test("staff playback uses the normal same-origin cookie only for an exact private asset", async () => {
  await playerTest(async ({ player, audio, requests }) => {
    const m = manifest();
    m.chunks[0].url = `/api/v1/admin/narration-assets/${asset}/chunks/c1`;
    validateRecordedManifest(m, route, 4, 1, "detail", asset);
    const result = player.play(
      m,
      undefined,
      () => {},
      () => {},
      new AbortController().signal,
      true,
    );
    await until(() => typeof audio.onended === "function");
    assert.equal(requests[0].options.credentials, "same-origin");
    audio.onended();
    assert.equal(await result, true);
  });
});

test("corrupt, oversized or wrong-type audio never reaches Audio.play", async () => {
  for (const response of [
    () =>
      new Response(new TextEncoder().encode("RIFFcorrupt-WAVE"), {
        headers: { "content-type": "audio/wav" },
      }),
    () =>
      new Response(new Uint8Array(bytes.length + 1), {
        headers: { "content-type": "audio/wav" },
      }),
    () => new Response(bytes, { headers: { "content-type": "text/html" } }),
  ])
    await playerTest(async ({ player, audio }) => {
      await assert.rejects(
        player.play(
          manifest(),
          undefined,
          () => {},
          () => {},
          new AbortController().signal,
        ),
      );
      assert.equal(audio.plays, 0);
    }, response);
});

test("cancellation during download rejects late playback and a blocked clip resumes only after explicit unlock", async () => {
  let deliver;
  const waiting = new Promise((resolve) => (deliver = resolve));
  await playerTest(
    async ({ player, audio }) => {
      const controller = new AbortController();
      const result = player.play(
        manifest(),
        undefined,
        () => {},
        () => {},
        controller.signal,
      );
      controller.abort();
      deliver(
        new Response(bytes, { headers: { "content-type": "audio/wav" } }),
      );
      assert.equal(await result, false);
      assert.equal(audio.plays, 0);
    },
    () => waiting,
  );
  await playerTest(async ({ player, audio, requests, states }) => {
    audio.denied = true;
    const result = player.play(
      manifest(),
      undefined,
      () => {},
      () => {},
      new AbortController().signal,
    );
    await until(() => states.at(-1) === "blocked");
    assert.equal(states.at(-1), "blocked");
    assert.equal(requests.length, 1);
    audio.denied = false;
    player.unlock();
    await tick();
    assert.equal(states.at(-1), "speaking");
    assert.equal(requests.length, 1);
    audio.onended();
    assert.equal(await result, true);
  });
});
