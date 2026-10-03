import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  text,
  button,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const session = {
  user: { id: "editor", role: "editor", campus_ids: ["allowed-campus"] },
  permissions: ["points.edit"],
};
const campuses = [
  { id: "allowed-campus", name: "授权校区" },
  { id: "other-campus", name: "无权校区" },
];
const reference = {
  id: "real-point",
  title: "真实地点夹具",
  kind: "point",
  campus_id: "allowed-campus",
  point_id: "real-point",
  point_name: "真实地点夹具",
  revision: 8,
  draft_revision: 0,
  referenceable: true,
  thumbnail_url: null,
};
const view = {
  id: "job",
  state: "checked",
  fields: { point_id: "所属真实地点", main_id: "主画面", video_id: "视频资料" },
  preview_sha256: "a".repeat(64),
  reference_bindings: [],
};
const image = {
  ...reference,
  id: "cover-image",
  title: "真实地点封面夹具",
  kind: "image",
  revision: 5,
  thumbnail_url: "/api/v1/experiences/cover-image/media",
};
const vrView = {
  ...view,
  kind: "vr",
  fields: { point_id: "所属真实地点", cover_image_id: "封面图片" },
  reference_bindings: [
    {
      rows: [2, 3],
      field: "point_id",
      kind: "point",
      id: "real-point",
      revision: 8,
    },
  ],
};
const descriptionVideo = {
  ...reference, id: "described-video", kind: "video", title: "已审核口述描述夹具", revision: 7,
  audio_description_eligible: true, preview_url: "/api/v1/experiences/described-video/media/7",
};
const mediaView = {
  ...vrView, kind: "media", fields: { point_id: "所属真实地点", audio_description_video_id: "口述描述版视频" },
};
function setup(respond) {
  const calls = [];
  const h = controlledAdmin({
    "../../shared/api/client": { get: async () => ({ data: campuses }) },
    "./api": {
      message: (error) => error.message,
      request: async (...args) => {
        calls.push(args);
        return respond
          ? respond(...args)
          : {
              data: [reference],
              meta: { pagination: { page: 1, page_size: 25, total: 1 } },
            };
      },
    },
  });
  return { ...h, ...h.load("./ImportReferences"), calls };
}
const select = (tree, label) =>
  find(
    tree,
    (node) => node.type === "label" && text(node).startsWith(label),
  ).flatMap((node) => find(node, (child) => child.type === "select"))[0];

test("description choice requires explicit same-point public audio-complete candidate and exact revision", async () => {
  const h = setup(() => ({ data: [descriptionVideo, { ...descriptionVideo, id: "incomplete", audio_description_eligible: false },
    { ...descriptionVideo, id: "elsewhere", point_id: "other-point" }], meta: {} })), applied = [];
  const props = { view: mediaView, rows: [2, 3], session, disabled: false, onApply: async value => applied.push(value), onClose() {} };
  const render = () => h.render("description", h.ImportReferencePicker, props);
  let tree = render(); await settle(); tree = render();
  select(tree, "要填写的关联").props.onChange({ target: { value: "audio_description_video_id" } });
  tree = render(); await settle(); tree = render();
  assert.match(h.calls.at(-1)[0], /purpose=audio_description/);
  assert.match(h.calls.at(-1)[0], /point_id=real-point/);
  const radios = find(tree, node => node.type === "input" && node.props.type === "radio");
  assert.equal(radios.length, 1);
  assert.equal(button(tree, "采用所选真实关联并重新检查").props.disabled, true);
  assert.equal(find(tree, node => node.type === "video").length, 0);
  button(tree, "查看此正式视频").props.onClick({ preventDefault() {}, stopPropagation() {} });
  tree = render();
  const preview = find(tree, node => node.type === "video")[0];
  assert.equal(preview.props.src, descriptionVideo.preview_url);
  assert.equal(preview.props.preload, "none"); assert.equal(preview.props.muted, true); assert.equal(preview.props.autoPlay, undefined);
  assert.equal(button(tree, "采用所选真实关联并重新检查").props.disabled, true, "preview never adopts the candidate");
  radios[0].props.onChange(); tree = render(); button(tree, "采用所选真实关联并重新检查").props.onClick(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [[{ rows: [2, 3], field: "audio_description_video_id", kind: "video", id: "described-video", revision: 7 }]]);
  select(tree, "要填写的关联").props.onChange({ target: { value: "point_id" } });
  tree = render(); assert.equal(find(tree, node => node.type === "video").length, 0);
  h.dispose();
});

test("controlled video preview refuses arbitrary URLs and missing point confirmation", async () => {
  const h = setup();
  assert.equal(h.importVideoPreview({ ...descriptionVideo, preview_url: "https://elsewhere.example/video" }), null);
  assert.equal(h.importVideoPreview({ ...descriptionVideo, preview_url: "/api/v1/experiences/described-video/media/8" }), null);
  assert.equal(h.importVideoPreview({ ...descriptionVideo, referenceable: false }), null);
  const props = { view: { ...mediaView, reference_bindings: [] }, rows: [2], session, disabled: false, onApply: async () => {}, onClose() {} };
  const render = () => h.render("missing-point", h.ImportReferencePicker, props);
  let tree = render(); await settle(); tree = render();
  select(tree, "要填写的关联").props.onChange({ target: { value: "audio_description_video_id" } });
  tree = render(); await settle(); tree = render();
  assert.match(text(tree), /先为每个勾选行按名称确认/);
  assert.equal(h.calls.length, 1, "blocked until the point name is confirmed");
  assert.equal(find(tree, node => node.type === "input" && node.props.type === "radio").length, 0);
  h.dispose();
});

test("reference picker uses server identity/version, filters scope, and never writes before explicit adoption", async () => {
  const h = setup(),
    applied = [];
  const props = {
    view,
    rows: [2, 3],
    session,
    disabled: false,
    onApply: async (value) => applied.push(value),
    onClose() {},
  };
  const render = () => h.render("picker", h.ImportReferencePicker, props);
  let tree = render();
  await settle();
  tree = render();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0][0], /kind=point/);
  assert.equal(
    find(
      tree,
      (node) => node.type === "option" && node.props.value === "other-campus",
    ).length,
    0,
  );
  assert.equal(
    find(
      tree,
      (node) =>
        node.type === "input" &&
        node.props.type !== "checkbox" &&
        node.props.type !== "radio" &&
        /ID|编号/.test(node.props.placeholder ?? ""),
    ).length,
    0,
  );
  assert.equal(applied.length, 0);
  find(
    tree,
    (node) => node.type === "input" && node.props.type === "radio",
  )[0].props.onChange();
  tree = render();
  button(tree, "采用所选真实关联并重新检查").props.onClick();
  await settle();
  assert.equal(applied.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(applied[0])), [
    {
      rows: [2, 3],
      field: "point_id",
      kind: "point",
      id: "real-point",
      revision: 8,
    },
  ]);
  assert.equal(
    h.calls.some(([, method]) => method === "POST"),
    false,
  );
  h.dispose();
});

test("changing reference kind clears selection and same-point media search inherits the actual selected point", async () => {
  const h = setup();
  const props = {
    view: {
      ...view,
      reference_bindings: [
        {
          rows: [2],
          field: "point_id",
          kind: "point",
          id: "real-point",
          revision: 8,
        },
      ],
    },
    rows: [2],
    session,
    disabled: false,
    onApply: async () => {},
    onClose() {},
  };
  const render = () => h.render("picker", h.ImportReferencePicker, props);
  let tree = render();
  await settle();
  tree = render();
  find(
    tree,
    (node) => node.type === "input" && node.props.type === "radio",
  )[0].props.onChange();
  tree = render();
  select(tree, "要填写的关联").props.onChange({
    target: { value: "video_id" },
  });
  tree = render();
  await settle();
  tree = render();
  assert.match(h.calls.at(-1)[0], /kind=video/);
  assert.match(h.calls.at(-1)[0], /point_id=real-point/);
  assert.equal(button(tree, "采用所选真实关联并重新检查").props.disabled, true);
  h.dispose();
});

test("explicit association removal returns to original cell without supplying a guessed resource", async () => {
  const h = setup(),
    applied = [];
  const props = {
    view: {
      ...view,
      reference_bindings: [
        {
          rows: [2],
          field: "point_id",
          kind: "point",
          id: "real-point",
          revision: 8,
        },
      ],
    },
    rows: [2],
    session,
    disabled: false,
    onApply: async (value) => applied.push(value),
    onClose() {},
  };
  let tree = h.render("picker", h.ImportReferencePicker, props);
  await settle();
  tree = h.render("picker", h.ImportReferencePicker, props);
  button(tree, "撤销本页选择，恢复原表单元格").props.onClick();
  await settle();
  assert.equal(applied[0][0].id, null);
  assert.equal(applied[0][0].revision, 0);
  h.dispose();
});

test("scope export checks exact selected range then binds the download to returned SHA; edits invalidate approval", async () => {
  const manifest = {
    kind: "point",
    campus_id: "allowed-campus",
    record_count: 1,
    row_count: 1,
    sha256: "b".repeat(64),
    filename: "safe.csv",
    warnings: [
      {
        id: "real-point",
        code: "fixture",
        message: "保留真实版本列",
        fields: [],
      },
    ],
  };
  const h = setup(async (path) =>
    path.includes("/preview?")
      ? { data: manifest }
      : {
          data: [reference],
          meta: { pagination: { page: 1, page_size: 25, total: 1 } },
        },
  );
  const downloads = [],
    busy = [],
    errors = [];
  const props = {
    kind: "point",
    session,
    disabled: false,
    onBusy: (value) => busy.push(value),
    onError: (value) => errors.push(value),
    onDownload: async (...value) => downloads.push(value),
  };
  const render = () => h.render("export", h.ImportScopeExport, props);
  let tree = render();
  assert.equal(h.calls.length, 0);
  button(tree, "导出已有资料作为更新表格").props.onClick();
  tree = render();
  await settle();
  tree = render();
  select(tree, "要导出的校区").props.onChange({
    target: { value: "allowed-campus" },
  });
  tree = render();
  await settle();
  tree = render();
  assert.equal(
    find(
      tree,
      (node) => node.type === "option" && node.props.value === "other-campus",
    ).length,
    0,
  );
  find(
    tree,
    (node) => node.type === "input" && node.props.type === "checkbox",
  )[0].props.onChange({ target: { checked: true } });
  tree = render();
  button(tree, "检查导出范围与提醒").props.onClick();
  await settle();
  tree = render();
  const previewQuery = new URLSearchParams(h.calls.at(-1)[0].split("?")[1]);
  assert.equal(previewQuery.get("campus_id"), "allowed-campus");
  assert.deepEqual(previewQuery.getAll("ids"), ["real-point"]);
  assert.match(text(tree), /保留真实版本列/);
  assert.deepEqual(busy, [true, false]);
  button(tree, "下载已核对范围的 CSV").props.onClick();
  await settle();
  assert.equal(downloads.length, 1);
  const downloaded = new URLSearchParams(downloads[0][0].split("?")[1]);
  assert.equal(downloaded.get("expected_sha256"), manifest.sha256);
  assert.deepEqual(downloaded.getAll("ids"), ["real-point"]);
  button(tree, "清除选择，改为全校区范围").props.onClick();
  tree = render();
  assert.equal(button(tree, "下载已核对范围的 CSV"), undefined);
  assert.equal(
    h.calls.some(([, method]) => method === "POST"),
    false,
  );
  h.dispose();
});

test("VR cover candidates are published images at the confirmed real point and adoption carries the precise revision", async () => {
  const h = setup(async (path) => ({
    data: path.includes("kind=image")
      ? [
          image,
          { ...image, id: "other-point-image", point_id: "other-point" },
          { ...image, id: "private-image", referenceable: false },
          { ...image, id: "other-campus-image", campus_id: "other-campus" },
        ]
      : [reference],
    meta: { pagination: { page: 1, page_size: 25, total: 4 } },
  }));
  const applied = [],
    props = {
      view: vrView,
      rows: [2, 3],
      session,
      disabled: false,
      onApply: async (value) => applied.push(value),
      onClose() {},
    };
  const render = () => h.render("cover", h.ImportReferencePicker, props);
  render();
  await settle();
  select(render(), "要填写的关联").props.onChange({
    target: { value: "cover_image_id" },
  });
  render();
  await settle();
  let tree = render();
  const params = new URLSearchParams(h.calls.at(-1)[0].split("?")[1]);
  assert.equal(params.get("kind"), "image");
  assert.equal(params.get("referenceable"), "true");
  assert.equal(params.get("point_id"), "real-point");
  const radios = find(
    tree,
    (node) => node.type === "input" && node.props.type === "radio",
  );
  assert.equal(radios.length, 1);
  assert.equal(
    find(tree, (node) => node.type === "img")[0].props.src,
    image.thumbnail_url,
  );
  radios[0].props.onChange();
  tree = render();
  button(tree, "采用所选真实关联并重新检查").props.onClick();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [
    [
      {
        rows: [2, 3],
        field: "cover_image_id",
        kind: "image",
        id: "cover-image",
        revision: 5,
      },
    ],
  ]);
  assert.ok(h.calls.every(([, method]) => method === "GET"));
  h.dispose();
});

test("cover selection requires every selected row to have the same confirmed point and never fetches an unbounded image catalog", async () => {
  const h = setup(),
    props = {
      view: {
        ...vrView,
        reference_bindings: [{ ...vrView.reference_bindings[0], rows: [2] }],
      },
      rows: [2, 3],
      session,
      disabled: false,
      onApply: async () => assert.fail("must not apply"),
      onClose() {},
    };
  const render = () => h.render("cover", h.ImportReferencePicker, props);
  render();
  await settle();
  select(render(), "要填写的关联").props.onChange({
    target: { value: "cover_image_id" },
  });
  render();
  await settle();
  let tree = render();
  assert.equal(
    h.calls.some(([path]) => path.includes("kind=image")),
    false,
  );
  assert.match(text(tree), /先为每个勾选行/);
  assert.equal(button(tree, "采用所选真实关联并重新检查").props.disabled, true);
  props.view = {
    ...vrView,
    reference_bindings: [
      { ...vrView.reference_bindings[0], rows: [2] },
      { ...vrView.reference_bindings[0], rows: [3], id: "other-point" },
    ],
  };
  tree = render();
  assert.match(text(tree), /属于不同地点/);
  assert.equal(
    h.calls.some(([path]) => path.includes("kind=image")),
    false,
  );
  button(tree, "先按名称确认所属地点").props.onClick();
  tree = render();
  assert.equal(select(tree, "要填写的关联").props.value, "point_id");
  h.dispose();
});

test("row selection, inspection version and authorization changes invalidate a picked cover before it can be adopted", async () => {
  const h = setup(async (path) => ({
    data: path.includes("kind=image") ? [image] : [reference],
    meta: { pagination: { page: 1, page_size: 25, total: 1 } },
  }));
  const applied = [],
    props = {
      view: vrView,
      rows: [2, 3],
      session,
      disabled: false,
      onApply: async (value) => applied.push(value),
      onClose() {},
    };
  const render = () => h.render("cover", h.ImportReferencePicker, props);
  render();
  await settle();
  select(render(), "要填写的关联").props.onChange({
    target: { value: "cover_image_id" },
  });
  render();
  await settle();
  function pick() {
    find(
      render(),
      (node) => node.type === "input" && node.props.type === "radio",
    )[0].props.onChange();
    return render();
  }
  assert.equal(
    button(pick(), "采用所选真实关联并重新检查").props.disabled,
    false,
  );
  find(
    render(),
    (node) => node.type === "input" && node.props.type === "checkbox",
  )[1].props.onChange({ target: { checked: false } });
  assert.equal(
    button(render(), "采用所选真实关联并重新检查").props.disabled,
    true,
  );
  pick();
  props.view = { ...vrView, preview_sha256: "b".repeat(64) };
  assert.equal(
    button(render(), "采用所选真实关联并重新检查").props.disabled,
    true,
  );
  pick();
  props.session = { ...session, permissions: ["points.read"] };
  let tree = render();
  assert.equal(button(tree, "采用所选真实关联并重新检查").props.disabled, true);
  button(tree, "采用所选真实关联并重新检查").props.onClick();
  assert.equal(applied.length, 0);
  h.dispose();
});

test("cover thumbnails only request the published same-origin owned image endpoint", () => {
  const h = setup();
  assert.equal(h.importImageThumbnail(image), image.thumbnail_url);
  for (const thumbnail_url of [
    "https://third-party.test/cover.jpg",
    "//third-party.test/a",
    "/api/v1/experiences/other/media",
    "/admin/private",
    image.thumbnail_url + "?token=unsafe",
  ]) {
    assert.equal(h.importImageThumbnail({ ...image, thumbnail_url }), null);
  }
  assert.equal(
    h.importImageThumbnail({ ...image, referenceable: false }),
    null,
  );
  assert.equal(h.importImageThumbnail({ ...image, kind: "video" }), null);
  h.dispose();
});

test("point-scoped editors can use their authorized same-point published cover without campus-wide permission", async () => {
  const h = setup(async (path) => ({
    data: path.includes("kind=image") ? [image] : [reference],
    meta: { pagination: { page: 1, page_size: 25, total: 1 } },
  }));
  const props = {
    view: vrView,
    rows: [2],
    session: {
      ...session,
      user: { ...session.user, campus_ids: [], point_ids: ["real-point"] },
    },
    disabled: false,
    onApply: async () => {},
    onClose() {},
  };
  const render = () => h.render("cover", h.ImportReferencePicker, props);
  render();
  await settle();
  select(render(), "要填写的关联").props.onChange({
    target: { value: "cover_image_id" },
  });
  render();
  await settle();
  assert.equal(
    find(
      render(),
      (node) => node.type === "input" && node.props.type === "radio",
    ).length,
    1,
  );
  h.dispose();
});

test("VR scope export keeps the server CSV and four display columns under the checked content SHA", async () => {
  const h = setup(async (path) =>
    path.includes("/preview?")
      ? {
          data: {
            kind: "vr",
            campus_id: "allowed-campus",
            record_count: 1,
            row_count: 1,
            sha256: "c".repeat(64),
            filename: "vr.csv",
            warnings: [],
          },
        }
      : {
          data: [{ ...reference, kind: "vr" }],
          meta: { pagination: { page: 1, page_size: 25, total: 1 } },
        },
  );
  const downloads = [],
    props = {
      kind: "vr",
      session,
      disabled: false,
      onBusy() {},
      onError: (error) => {
        if (error) assert.fail(error);
      },
      onDownload: async (...args) => downloads.push(args),
    };
  const render = () => h.render("export", h.ImportScopeExport, props);
  button(render(), "导出已有资料作为更新表格").props.onClick();
  render();
  await settle();
  select(render(), "要导出的校区").props.onChange({
    target: { value: "allowed-campus" },
  });
  render();
  await settle();
  let tree = render();
  assert.match(
    text(tree),
    /全景观察提示、封面图片及其精确版本、目录顺序这四列/,
  );
  assert.match(text(tree), /人工核查记录不从表格导入/);
  button(tree, "检查导出范围与提醒").props.onClick();
  await settle();
  tree = render();
  button(tree, "下载已核对范围的 CSV").props.onClick();
  await settle();
  assert.equal(
    downloads[0][0],
    "/import-exports/vr?campus_id=allowed-campus&expected_sha256=" +
      "c".repeat(64),
  );
  assert.equal(downloads[0][1], "vr.csv");
  assert.ok(h.calls.every(([, method]) => !method || method === "GET"));
  h.dispose();
});
