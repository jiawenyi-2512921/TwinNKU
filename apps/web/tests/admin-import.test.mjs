import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  text,
  button,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const job = {
  id: "import-job",
  kind: "point",
  filename: "fixture.csv",
  state: "checked",
  source_sha256: "",
  columns: ["名称", "校区"],
  mapping: { 名称: "name", 校区: "campus_id" },
  fields: { name: "地点名称", campus_id: "校区标识" },
  row_count: 1,
  preview: [
    {
      rows: [2],
      title: "真实资料夹具",
      action: "create",
      code: "",
      message: "建立新草稿",
      fields: [],
    },
  ],
  preview_sha256: "a".repeat(64),
  result: [],
  commit_operation_id: null,
  error_code: "",
};
function setup(respond, permissions = ["points.edit"]) {
  const calls = [],
    notices = [];
  const h = controlledAdmin({
    "./api": {
      message: (e) => e.message,
      request: async (...args) => {
        calls.push(args);
        return { data: await respond(...args) };
      },
      readAdminFile: async () => new Blob(["fixture"], { type: "text/csv" }),
    },
    "./ui": { ErrorBox: () => null },
    "./ImportReferences": {
      ImportReferencePicker: () => null,
      ImportScopeExport: () => null,
    },
  });
  const exported = h.load("./ImportWorkspace"),
    props = {
      session: { user: { id: "editor" }, permissions },
      onDirty: (...v) => notices.push(v),
      onUpdate() {},
    };
  const render = () => h.render("imports", exported.ImportWorkspace, props);
  async function upload(kind = "point") {
    let tree = render();
    if (kind !== "point") {
      find(tree, (node) => node.type === "select")[0].props.onChange({
        target: { value: kind },
      });
      tree = render();
    }
    find(
      tree,
      (n) => n.type === "input" && n.props.type === "file",
    )[0].props.onChange({
      target: {
        files: [
          new File(["name,campus\nfixture,campus\n"], "fixture.csv", {
            type: "text/csv",
          }),
        ],
      },
    });
    tree = render();
    button(tree, "上传并读取列").props.onClick();
    for (let i = 0; i < 12; i++) {
      await settle();
      tree = render();
      if (calls.length) return tree;
    }
    return tree;
  }
  return { ...h, ...exported, calls, notices, render, upload };
}
test("import upload and column inspection never commit, submit, publish or fetch a spreadsheet URL", async () => {
  const h = setup(async (path) => ({
    ...job,
    source_sha256:
      new URLSearchParams(path.split("?")[1]).get("source_sha256") || "",
  }));
  assert.equal(h.calls.length, 0);
  h.render();
  assert.equal(h.calls.length, 0);
  const tree = await h.upload();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0][0], /^\/import-jobs\?/);
  assert.equal(h.calls[0][1], "POST");
  assert.equal(h.calls[0][2] instanceof File, true);
  assert.match(
    new URLSearchParams(h.calls[0][0].split("?")[1]).get("source_sha256"),
    /^[a-f0-9]{64}$/,
  );
  assert.match(text(tree), /匹配资料列/);
  assert.equal(
    h.calls.some(([path]) => /commit|submit|publish|https?:/.test(path)),
    false,
  );
  h.dispose();
});
test("a lost upload response queries the exact actor operation and never repeats the file body", async () => {
  let hash;
  const h = setup(async (path, method) => {
    if (method === "POST") {
      hash = new URLSearchParams(path.split("?")[1]).get("source_sha256");
      throw new Error("network disconnected");
    }
    return [{ ...job, source_sha256: hash }];
  });
  const tree = await h.upload();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.equal(h.calls.length, 2);
  const write = new URLSearchParams(h.calls[0][0].split("?")[1]),
    read = new URLSearchParams(h.calls[1][0].split("?")[1]);
  assert.equal(write.get("operation_id"), read.get("operation_id"));
  assert.match(text(tree), /匹配资料列/);
  h.dispose();
});
test("an unknown import result blocks a second upload and preserves only read recovery", async () => {
  const h = setup(async (_, method) => {
    if (method === "POST") throw new Error("timeout");
    return [];
  });
  let tree = await h.upload();
  assert.ok(button(tree, "查询原导入操作结果"));
  assert.equal(
    find(tree, (n) => n.type === "fieldset")[0].props.disabled,
    true,
  );
  button(tree, "查询原导入操作结果").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.ok(button(tree, "查询原导入操作结果"));
  assert.equal(h.notices.at(-1)[1], true);
  h.dispose();
});
test("changed column matching and any row error invalidate commit, and foreign committed IDs never confirm this request", () => {
  const h = setup(async () => job);
  assert.equal(h.importCanCommit(job, job.mapping), true);
  assert.equal(h.importCanCommit(job, { 名称: "campus_id" }), false);
  assert.equal(
    h.importCanCommit(
      { ...job, preview: [{ ...job.preview[0], action: "error" }] },
      job.mapping,
    ),
    false,
  );
  assert.equal(
    h.importCommitOutcome(
      { ...job, state: "committed", commit_operation_id: "other" },
      "this",
    ),
    "another_operation",
  );
  assert.equal(
    h.importCommitOutcome(
      { ...job, state: "committed", commit_operation_id: "this" },
      "this",
    ),
    "this_operation",
  );
  assert.equal(h.importCommitOutcome(job, "this"), "unknown");
  h.dispose();
});
test("a scoped read-only employee cannot start import and malformed formats stay local", async () => {
  const h = setup(async () => job, ["points.read"]);
  const tree = h.render();
  assert.equal(
    find(tree, (n) => n.type === "fieldset")[0].props.disabled,
    true,
  );
  button(tree, "上传并读取列").props.onClick();
  await settle();
  assert.equal(h.calls.length, 0);
  h.dispose();
  const writer = setup(async () => job);
  let t = writer.render();
  find(
    t,
    (n) => n.type === "input" && n.props.type === "file",
  )[0].props.onChange({
    target: { files: [new File(["formula"], "unsafe.xlsm")] },
  });
  t = writer.render();
  button(t, "上传并读取列").props.onClick();
  await settle();
  writer.render();
  assert.equal(writer.calls.length, 0);
  writer.dispose();
});

test("VR column matching preserves all four display fields, explains omitted old columns, and only asks the server to recheck", async () => {
  const fields = {
    observation_prompt: "全景观察提示",
    cover_image_id: "封面图片",
    cover_image_revision: "封面图片版本",
    sort_order: "目录顺序",
  };
  const mapping = Object.fromEntries(
    Object.entries(fields).map(([key, label]) => [label, key]),
  );
  const vr = {
    ...job,
    kind: "vr",
    columns: Object.keys(mapping),
    mapping,
    fields,
  };
  const h = setup(async (path, method, body) => ({
    ...vr,
    source_sha256:
      new URLSearchParams(path.split("?")[1]).get("source_sha256") || "",
    ...(path.endsWith("/mapping") ? { mapping: body.mapping } : {}),
  }));
  let tree = h.render();
  find(tree, (node) => node.type === "select")[0].props.onChange({
    target: { value: "vr" },
  });
  assert.match(text(h.render()), /观察提示、封面图片、封面图片版本和目录顺序/);
  tree = await h.upload("vr");
  const summary = find(
    tree,
    (node) => node.props?.["aria-label"] === "VR 展示字段列匹配",
  )[0];
  assert.equal(find(summary, (node) => node.type === "li").length, 4);
  assert.equal((text(summary).match(/已对应表格列/g) || []).length, 4);
  assert.match(text(summary), /未提供的展示字段保留原值/);
  assert.match(text(summary), /两列空白封面值会移除原封面/);
  button(tree, "按当前列匹配重新检查").props.onClick();
  await settle();
  tree = h.render();
  const write = h.calls.find(([path]) => path.endsWith("/mapping"));
  assert.deepEqual(JSON.parse(JSON.stringify(write[2].mapping)), mapping);
  assert.equal(write[2].expected_preview_sha256, job.preview_sha256);
  assert.equal(
    h.calls.some(([path]) => /commit|submit|publish/.test(path)),
    false,
  );
  assert.equal(h.calls[0][2] instanceof File, true);
  assert.equal(await h.calls[0][2].text(), "name,campus\nfixture,campus\n");
  button(tree, "2. 匹配资料列").props.onClick();
  tree = h.render();
  find(
    tree,
    (node) =>
      node.type === "select" && node.props.value === "cover_image_revision",
  )[0].props.onChange({ target: { value: "" } });
  tree = h.render();
  assert.match(
    text(
      find(
        tree,
        (node) => node.props?.["aria-label"] === "VR 展示字段列匹配",
      )[0],
    ),
    /封面图片版本：未对应；本批不从此列更新/,
  );
  h.dispose();
});

test("a recovered cover binding must match every selected row, image identity and precise revision", () => {
  const h = setup(async () => job),
    binding = {
      rows: [2, 3],
      field: "cover_image_id",
      kind: "image",
      id: "cover",
      revision: 6,
    };
  const recovered = { ...job, kind: "vr", reference_bindings: [binding] };
  assert.equal(h.importBindingsConfirmed(recovered, [binding]), true);
  for (const actual of [
    { ...binding, rows: [2] },
    { ...binding, revision: 5 },
    { ...binding, id: "another-cover" },
    { ...binding, kind: "video" },
  ])
    assert.equal(
      h.importBindingsConfirmed(
        { ...recovered, reference_bindings: [actual] },
        [binding],
      ),
      false,
    );
  assert.equal(
    h.importBindingsConfirmed(recovered, [
      { ...binding, id: null, revision: 0 },
    ]),
    false,
  );
  assert.equal(
    h.importBindingsConfirmed({ ...recovered, reference_bindings: [] }, [
      { ...binding, id: null, revision: 0 },
    ]),
    true,
  );
  h.dispose();
});
