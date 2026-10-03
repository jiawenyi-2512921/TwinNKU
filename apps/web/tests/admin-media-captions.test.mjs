import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const upload = "11111111-1111-4111-8111-111111111111";
const mediaContent = {
  kind: "media",
  media_type: "video",
  point_id: "point",
  title: "真实视频夹具",
  description: "",
  source_note: "真实测试来源",
  upload_id: null,
  url: "https://example.com/fixture.mp4",
  alternative_text: "",
  transcript: "已有文字稿",
  caption_upload_id: null,
  caption_language: "zh-CN",
  caption_label: "中文字幕",
};
function setup(response) {
  const calls = [],
    notices = [];
  const record = {
    id: "media",
    revision: 2,
    published_revision: 0,
    state: "draft",
    status: "draft",
    content: mediaContent,
    published_content: null,
    contributor_ids: ["editor"],
    submitted_by: null,
    media_url: mediaContent.url,
    caption_url: null,
  };
  const h = controlledAdmin({
    "../../shared/api/client": { get: async () => ({ data: [], meta: {} }) },
    "../../shared/catalogSync": { notifyCatalogPublished() {} },
    "../experiences/types": {
      experienceNames: {
        media: "图片与视频",
        checkin: "打卡点",
        tour: "校园导览路线",
      },
    },
    "../experiences/progress": {
      safeMediaUrl: (value) => value,
      inlineVideo: () => true,
      moveStop: (values) => values,
    },
    "../experiences/segments": {
      newSegment: () => ({
        id: "new",
        text: "",
        source_note: "",
        main_view: { type: "map" },
        resources: [],
      }),
      normalizeSegment: (value) => value,
    },
    "../visit/audioOwner": { acquireAudio: () => 1, releaseAudio() {} },
    "../visit/TourNarrator": { TourNarrator: () => null },
    "./ExperienceEditor": {
      ExperienceEditor: () => null,
      ExperienceTourPreview: () => null,
    },
    "./NarrationStudio": { NarrationStudio: () => null },
    "./ExperienceHistory": { ExperienceHistory: () => null },
    "./ui": {
      Empty: () => null,
      ErrorBox: () => null,
      useResource: () => ({ data: { data: [] }, error: "" }),
    },
    "./api": {
      message: (error) => error.message,
      stateNames: { draft: "草稿" },
      request: async (...args) => {
        calls.push(args);
        if (args[0].startsWith("/points?")) return { data: [], meta: {} };
        if (args[0] === "/experiences/media") return { data: record };
        return { data: await response(...args) };
      },
    },
  });
  const exported = h.load("./ExperienceWorkspace"),
    props = {
      session: {
        user: { id: "editor", role: "editor", campus_ids: [] },
        permissions: ["points.edit"],
      },
      initialId: "media",
      focused: true,
      onDirty: (...value) => notices.push(value),
    };
  const render = () => h.render("media", exported.ExperienceWorkspace, props);
  async function ready() {
    render();
    await settle();
    return render();
  }
  return { ...h, calls, notices, render, ready };
}
const field = (tree, label) =>
  find(
    tree,
    (node) => node.type === "label" && text(node).startsWith(label),
  ).flatMap((node) =>
    find(node, (child) => ["input", "textarea", "select"].includes(child.type)),
  )[0];
test("explicit staff VTT upload adds only a private controlled track; a video replacement removes the old subtitle association", async () => {
  const h = setup(async () => ({
    id: upload,
    point_id: "point",
    mime_type: "text/vtt",
    size_bytes: 36,
    sha256: "a".repeat(64),
    cue_count: 1,
    url: `/api/v1/admin/experience-captions/${upload}`,
  }));
  let tree = await h.ready();
  assert.equal(find(tree, (node) => node.type === "track").length, 0);
  field(tree, "上传并采用 WebVTT 字幕").props.onChange({
    currentTarget: {
      files: [
        new File(["WEBVTT\n\n00:00.000 --> 00:01.000\n测试"], "captions.vtt"),
      ],
      value: "captions.vtt",
    },
  });
  await settle();
  tree = h.render();
  const write = h.calls.find(([path]) => path.endsWith("/experience-captions"));
  assert.equal(write[0], "/points/point/experience-captions");
  assert.equal(write[1], "POST");
  assert.equal(write[2] instanceof Blob, true);
  assert.equal(write[2].type, "text/vtt");
  const track = find(tree, (node) => node.type === "track")[0];
  assert.equal(track.props.src, `/api/v1/admin/experience-captions/${upload}`);
  assert.equal(track.props.srcLang, "zh-CN");
  assert.equal(
    h.calls.some(
      ([path, method]) => path === "/experiences/media" && method === "PUT",
    ),
    false,
  );
  assert.equal(
    h.calls.some(([path]) => /submit|publish|voice|narration/.test(path)),
    false,
  );
  field(tree, "公开 HTTPS 链接").props.onChange({
    target: { value: "https://example.com/replaced.mp4" },
  });
  tree = h.render();
  assert.equal(find(tree, (node) => node.type === "track").length, 0);
  assert.equal(button(tree, "解除字幕关联"), undefined);
  h.dispose();
});
test("foreign caption preview URLs and wrong point ownership cannot be adopted as a video track", async () => {
  for (const response of [
    {
      id: upload,
      point_id: "other-point",
      mime_type: "text/vtt",
      sha256: "a".repeat(64),
      url: `/api/v1/admin/experience-captions/${upload}`,
    },
    {
      id: upload,
      point_id: "point",
      mime_type: "text/vtt",
      sha256: "a".repeat(64),
      url: "https://example.com/captions.vtt",
    },
  ]) {
    const h = setup(async () => response);
    let tree = await h.ready();
    field(tree, "上传并采用 WebVTT 字幕").props.onChange({
      currentTarget: {
        files: [new File(["WEBVTT"], "captions.vtt")],
        value: "",
      },
    });
    await settle();
    tree = h.render();
    assert.equal(find(tree, (node) => node.type === "track").length, 0);
    assert.equal(button(tree, "解除字幕关联"), undefined);
    h.dispose();
  }
});
test("invalid caption file formats remain local and never request a paid or upload endpoint", async () => {
  const h = setup(async () => ({}));
  let tree = await h.ready();
  field(tree, "上传并采用 WebVTT 字幕").props.onChange({
    currentTarget: { files: [new File(["html"], "wrong.html")], value: "" },
  });
  await settle();
  tree = h.render();
  assert.equal(
    h.calls.some(([path]) => path.endsWith("/experience-captions")),
    false,
  );
  assert.equal(find(tree, (node) => node.type === "track").length, 0);
  h.dispose();
});
