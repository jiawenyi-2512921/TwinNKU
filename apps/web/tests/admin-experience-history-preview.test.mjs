import { test } from "node:test";
import assert from "node:assert/strict";
import * as segments from "../src/features/experiences/segments.ts";
import {
  controlledAdmin,
  find,
  text,
  button,
} from "./helpers/controlled-admin.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const route = "a1111111-1111-4111-8111-111111111111",
  versionId = "b1111111-1111-4111-8111-111111111111";
const image = "c1111111-1111-4111-8111-111111111111",
  described = "d1111111-1111-4111-8111-111111111111";
const point = "e1111111-1111-4111-8111-111111111111",
  asset = "f1111111-1111-4111-8111-111111111111";
const binding = {
  experienceId: route,
  versionId,
  snapshot: "draft",
  stopIndex: 0,
};
const uri = (suffix, path, stop = 0) =>
  `/api/v1/admin/experiences/${route}/history/${versionId}${suffix}?${new URLSearchParams({ snapshot: "draft", stop_index: String(stop), ...(path === undefined ? {} : { path }) })}`;
const stop = (id) => ({
  point_id: point,
  narrative: "",
  title: "",
  legacy_media_compat: false,
  prompt_timing: "manual",
  segments: [
    {
      id,
      text: "历史原文",
      main_view: { type: "map" },
      resources: [{ type: "image", id: image, revision: 1 }],
    },
  ],
});
const item = {
  id: route,
  campus_id: "campus",
  revision: 3,
  media_url: null,
  content: {
    kind: "tour",
    title: "真实测试历史",
    description: "原说明",
    source_note: "测试夹具",
    stops: [stop("first"), stop("second")],
  },
};
function result(index = 0, overrides = {}) {
  return {
    experience_id: route,
    version_id: versionId,
    snapshot: "draft",
    revision: 3,
    published_revision: 1,
    content_sha256: "b".repeat(64),
    snapshot_sha256: "a".repeat(64),
    stop_index: index,
    item,
    resources: [],
    map_context: "current_public_reference",
    ...overrides,
  };
}
function setup(respond = async () => result()) {
  const calls = [],
    leases = [],
    released = [];
  const TourPlayer = () => null,
    MediaView = () => null,
    FloorViewer = () => null,
    VRPresentation = () => null,
    MapPreview = () => null;
  const h = controlledAdmin({
    "../experiences/ExperiencePanel": { TourPlayer, MediaView },
    "../experiences/segments": segments,
    "../floors/FloorViewer": { FloorViewer },
    "../points/VRPresentation": { VRPresentation },
    "../visit/audioOwner": {
      acquireAudio: (owner, stop) => {
        leases.push({ owner, stop });
        return leases.length;
      },
      releaseAudio: (...args) => released.push(args),
    },
    "./AdminTourMapPreview": { default: MapPreview },
    "./ui": { ErrorBox: "error-box" },
    "./api": {
      message: (e) => e.message,
      request: async (...args) => {
        calls.push(args);
        return { data: await respond(...args) };
      },
    },
  });
  const module = h.load("./ExperienceHistoryPreview"),
    types = h.load("./experienceHistoryTypes");
  const props = {
    experienceId: route,
    versionId,
    snapshot: "draft",
    onClose() {},
  };
  const render = () =>
    h.render("preview", module.ExperienceHistoryPreview, props);
  const resource = (row, rows = [row], extra = {}) =>
    h.render("resource", module.HistoricalResourceView, {
      row,
      rows,
      binding,
      ...extra,
    });
  return {
    ...h,
    renderComponent: h.render,
    module,
    types,
    props,
    render,
    resource,
    calls,
    leases,
    released,
    TourPlayer,
    MediaView,
    FloorViewer,
    VRPresentation,
    MapPreview,
  };
}

test("reviewer history preview is a GET of the original snapshot and shares the public player privately", async () => {
  const h = setup();
  h.render();
  await settle();
  const tree = h.render();
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0][0],
    `/experiences/${route}/history/${versionId}/preview?snapshot=draft&stop_index=0`,
  );
  assert.equal(h.calls[0][1], "GET");
  assert.equal(h.calls[0][2], undefined);
  const player = find(tree, (n) => n.type === h.TourPlayer)[0];
  assert.deepEqual(player.props.item, item);
  assert.equal(player.props.preview, true);
  assert.equal(player.props.items.length, 0);
  assert.equal(player.props.onNarrate, undefined);
  assert.equal(player.props.onBookmark, undefined);
  assert.equal(player.props.onProgressChange, undefined);
  assert.equal(
    find(tree, (n) => n.type === h.MapPreview)[0].props.pointId,
    point,
  );
  assert.match(text(tree), /当前公开地图空间参考，不代表该历史版本/);
  const placeholder = player.props.renderPreviewResource(
    { type: "image", id: image, revision: 1 },
    point,
    "stops.0.segments.0.resources.0",
  );
  assert.match(text(placeholder), /无法确认/);
  assert.equal(
    h.calls.some(([path]) =>
      /narration-jobs|prepare|publish|restore/.test(path),
    ),
    false,
  );
  h.dispose();
});

test("switching repeated stops cancels old checks and cannot display old resources while a new station loads", async () => {
  const requests = [];
  const h = setup(
    (path, method, body, signal) =>
      new Promise((resolve) => requests.push({ path, signal, resolve })),
  );
  h.render();
  requests[0].resolve(result());
  await settle();
  let tree = h.render();
  let player = find(tree, (n) => n.type === h.TourPlayer)[0];
  player.props.onPositionChange({
    revision: 3,
    stopIndex: 1,
    segmentId: "second",
  });
  tree = h.render();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 2);
  player = find(tree, (n) => n.type === h.TourPlayer)[0];
  assert.match(
    text(
      player.props.renderPreviewResource(
        { type: "image", id: image, revision: 1 },
        point,
        "stops.1.segments.0.resources.0",
      ),
    ),
    /正在核验/,
  );
  player.props.onPositionChange({
    revision: 3,
    stopIndex: 0,
    segmentId: "first",
  });
  h.render();
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve(result(1, { snapshot_sha256: "c".repeat(64) }));
  requests[2].resolve(result(0));
  await settle();
  tree = h.render();
  assert.equal(
    find(tree, (n) => n.type === h.TourPlayer)[0].props.position.stopIndex,
    0,
  );
  assert.equal(find(tree, (n) => n.type === "error-box")[0].props.text, "");
  h.dispose();
});

test("source or original hash mismatch refuses the preview instead of rendering a new route", async () => {
  for (const malformed of [
    { version_id: image },
    { experience_id: image },
    { snapshot: "published" },
    { stop_index: 1 },
    { snapshot_sha256: "invalid" },
  ]) {
    const h = setup(async () => result(0, malformed));
    h.render();
    await settle();
    const tree = h.render();
    assert.equal(find(tree, (n) => n.type === h.TourPlayer).length, 0);
    assert.match(
      find(tree, (n) => n.type === "error-box")[0].props.text,
      /身份|指纹/,
    );
    h.dispose();
  }
  const h = setup();
  assert.throws(
    () => h.types.assertHistoryResponse(result(), binding, "c".repeat(64)),
    /指纹/,
  );
  h.dispose();
});

test("private media, captions, and exact audio-description choice never query the current public video", () => {
  const h = setup();
  const path = "stops.0.segments.0.resources.0",
    childPath = `${path}.audio_description_video_id`;
  const row = {
    path,
    type: "video",
    id: image,
    point_id: point,
    revision: 1,
    state: "ready",
    message: "",
    item: {
      id: image,
      revision: 1,
      campus_id: "campus",
      media_url: uri("/media", path),
      caption_url: uri("/captions", path),
      content: {
        kind: "media",
        media_type: "video",
        point_id: point,
        caption_upload_id: asset,
        audio_description_video_id: described,
        audio_description_video_revision: 2,
        transcript: "原文字稿",
      },
    },
  };
  const child = {
    ...row,
    path: childPath,
    id: described,
    revision: 2,
    item: {
      ...row.item,
      id: described,
      revision: 2,
      media_url: uri("/media", childPath),
      caption_url: null,
      content: {
        ...row.item.content,
        video_visual_information: "audio_complete",
        audio_description_video_id: null,
      },
    },
  };
  let tree = h.resource(row, [row, child]);
  const view = find(tree, (n) => n.type === h.MediaView)[0];
  assert.equal(view.props.previewOnly, true);
  assert.equal(view.props.item.caption_url, null);
  assert.equal(
    find(tree, (n) => n.type === "a")[0].props.href,
    row.item.caption_url,
  );
  button(tree, "查看原引用的口述描述版").props.onClick();
  tree = h.resource(row, [row, child]);
  assert.equal(
    find(tree, (n) => n.type === h.MediaView)[0].props.item.id,
    described,
  );
  assert.equal(
    find(tree, (n) => n.type === h.MediaView)[0].props.playbackRequest,
    undefined,
  );
  assert.equal(h.calls.length, 0);
  for (const unsafe of [
    row.item.media_url + "&stop_index=1",
    row.item.media_url.replace(versionId, image),
    row.item.media_url + "#other",
    `https://other.example/media`,
  ])
    assert.equal(
      h.types.safeHistoryFile(unsafe, binding, "/media", path),
      null,
    );
  h.dispose();
});

test("changed, withdrawn, and unversioned references never mount media and checkin preview is read-only", () => {
  const h = setup();
  for (const state of ["changed", "unavailable", "unversioned"]) {
    const tree = h.resource({
      path: "self",
      type: "image",
      id: image,
      point_id: point,
      revision: 1,
      state,
      message: "保留原文",
    });
    assert.equal(find(tree, (n) => n.type === h.MediaView).length, 0);
    assert.match(text(tree), /保留原文/);
  }
  const checkin = {
    path: "self",
    type: "checkin",
    id: image,
    point_id: point,
    revision: null,
    state: "ready",
    message: "",
    item: {
      id: image,
      revision: 2,
      content: {
        kind: "checkin",
        point_id: point,
        title: "历史打卡",
        description: "原任务",
      },
    },
  };
  const tree = h.resource(checkin);
  assert.match(text(tree), /不记录完成/);
  assert.equal(find(tree, (n) => n.type === "button").length, 0);
  assert.equal(h.calls.length, 0);
  h.dispose();
});

test("floor sections and VR share public components only after exact identity checks", () => {
  const h = setup();
  const floor = {
    path: "main",
    type: "floor",
    id: image,
    point_id: point,
    revision: 4,
    state: "ready",
    message: "",
    floor: {
      id: image,
      point_id: point,
      revision: 4,
      label: "原楼层",
      description: "楼层说明",
      images: [
        { variant: "labeled", section: "west", description: "西区原说明" },
        { variant: "labeled", section: "east", description: "东区原说明" },
      ],
    },
  };
  let tree = h.resource(floor, [floor], { sectionId: "east" });
  assert.equal(
    find(tree, (n) => n.type === h.FloorViewer)[0].props.asset.section,
    "east",
  );
  assert.match(text(tree), /东区原说明/);
  tree = h.resource({ ...floor, floor: { ...floor.floor, revision: 5 } });
  assert.equal(find(tree, (n) => n.type === h.FloorViewer).length, 0);
  const vr = {
    path: "vr",
    type: "vr",
    id: image,
    point_id: point,
    revision: 2,
    state: "ready",
    message: "",
    panorama: {
      id: image,
      point_id: point,
      revision: 2,
      title: "原场景",
      url: "https://example.com/scene?x=1",
    },
  };
  tree = h.resource(vr);
  assert.equal(
    find(tree, (n) => n.type === h.VRPresentation)[0].props.item,
    vr.panorama,
  );
  assert.equal(find(tree, (n) => n.type === "a")[0].props.target, "_blank");
  assert.match(text(tree), /不保证外站画面与当时相同/);
  h.dispose();
});

test("history audio accepts only adopted segment-bound chunks and releases the captured player on unmount", () => {
  const h = setup();
  const row = {
    path: "stops.0.segments.0.narration_asset_id",
    id: asset,
    segment_id: "first",
    type: "narration",
    point_id: point,
    state: "ready",
  };
  const chunk = {
    chunk_id: "chunk-1",
    text: "原音频字幕",
    url: uri(`/narration/first/${asset}/chunks/chunk-1`),
  };
  const manifest = { asset_id: asset, chunks: [chunk] };
  let paused = 0;
  const element = { pause: () => paused++ };
  let tree = h.renderComponent("audio", h.module.HistoryAudio, {
    manifest,
    row,
    binding,
  });
  const audio = find(tree, (n) => n.type === "audio")[0];
  assert.equal(audio.props.preload, "none");
  assert.equal(audio.props.autoPlay, undefined);
  audio.props.ref.current = element;
  audio.props.onPlay({ currentTarget: element });
  assert.equal(h.leases.length, 1);
  audio.props.ref.current = null;
  h.dispose();
  assert.ok(paused);
  assert.deepEqual(h.released.at(-1), ["tour", 1]);
  const invalid = setup();
  tree = invalid.renderComponent("audio", invalid.module.HistoryAudio, {
    manifest: {
      ...manifest,
      chunks: [{ ...chunk, url: chunk.url.replace("/first/", "/second/") }],
    },
    row,
    binding,
  });
  assert.equal(find(tree, (n) => n.type === "audio").length, 0);
  assert.match(text(tree), /身份无法确认/);
  invalid.dispose();
});

test("history list exposes distinct draft and published read previews without save or restore", async () => {
  const h = setup(async () => [
    {
      id: versionId,
      experience_id: route,
      event: "checkpoint",
      revision: 3,
      published_revision: 1,
      content: item.content,
      published_content: { ...item.content, title: "原正式" },
      content_sha256: "a".repeat(64),
      created_at: "2026-10-03T00:00:00Z",
    },
  ]);
  const module = h.load("./ExperienceHistory");
  let saved = 0,
    loaded = 0,
    opened = 0;
  const props = {
    getRecord: () => ({
      id: route,
      revision: 4,
      published_revision: 1,
      content: item.content,
    }),
    editable: false,
    dirty: true,
    onSave: async () => {
      saved++;
      return true;
    },
    onLoad: () => loaded++,
    onReport() {},
    onJump() {},
    onPreviewOpen: () => opened++,
  };
  let tree = h.renderComponent("history", module.ExperienceHistory, props);
  button(tree, "查看历史").props.onClick();
  await settle();
  tree = h.renderComponent("history", module.ExperienceHistory, props);
  button(tree, "只读预览历史正式快照").props.onClick();
  tree = h.renderComponent("history", module.ExperienceHistory, props);
  const preview = find(
    tree,
    (n) => n.type === h.module.ExperienceHistoryPreview,
  )[0];
  assert.equal(preview.props.snapshot, "published");
  assert.equal(preview.props.versionId, versionId);
  assert.equal(saved, 0);
  assert.equal(loaded, 0);
  assert.equal(opened, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1], "GET");
  assert.equal(button(tree, "恢复为新草稿").props.disabled, true);
  h.dispose();
});
