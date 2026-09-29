import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
const code = ts.transpileModule(
  readFileSync(
    new URL("../src/features/admin/ResourceWorkspace.tsx", import.meta.url),
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
const walk = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((n) => walk(n, predicate))
    : tree && typeof tree === "object"
      ? [
          ...(predicate(tree) ? [tree] : []),
          ...walk(tree.props?.children, predicate),
        ]
      : [];
const text = (tree) =>
  Array.isArray(tree)
    ? tree.map(text).join("")
    : tree && typeof tree === "object"
      ? text(tree.props?.children)
      : String(tree ?? "");
const button = (tree, label) =>
  walk(tree, (n) => n.type === "button" && text(n) === label)[0];
const field = (tree, label) =>
  walk(tree, (n) => n.type === "label" && text(n).startsWith(label)).flatMap(
    (n) => walk(n, (c) => ["input", "textarea", "select"].includes(c.type)),
  )[0];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const content = {
  kind: "panorama",
  title: "测试全景",
  url: "https://example.edu/vr",
  description: "测试",
};
const record = {
  id: "vr",
  kind: "panorama",
  point_id: "point",
  point_name: "测试楼",
  status: "published",
  published_revision: 4,
  current: content,
  images: [],
  draft: {
    revision: 6,
    state: "draft",
    operation: "upsert",
    contributor_ids: ["editor"],
    submitted_by: null,
    payload: { content, source_note: "审核来源" },
  },
};
const saved = { ...record, draft: { ...record.draft, revision: 7 } };
const submitted = {
  ...saved,
  draft: { ...saved.draft, revision: 8, state: "in_review" },
};

function harness(reply, permissions = ["points.edit"]) {
  const slots = [],
    effects = [];
  let index = 0,
    dirty = false,
    queued = [],
    confirm = true,
    focused = [],
    scrolled = [];
  const calls = [],
    paths = [];
  const react = {
    useState(initial) {
      const k = index++;
      if (!(k in slots))
        slots[k] = typeof initial === "function" ? initial() : initial;
      return [
        slots[k],
        (next) => {
          const value = typeof next === "function" ? next(slots[k]) : next;
          if (!Object.is(value, slots[k])) {
            slots[k] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(value) {
      const k = index++;
      if (!(k in slots)) slots[k] = { current: value };
      return slots[k];
    },
    useEffect(effect, deps) {
      const k = index++,
        old = effects[k];
      if (!old || deps.some((v, i) => !Object.is(v, old.deps[i])))
        queued.push(() => {
          old?.cleanup?.();
          effects[k] = { deps, cleanup: effect() };
        });
    },
  };
  const rows = {
    data: [record],
    meta: { pagination: { page: 1, page_size: 20, total: 1 } },
  };
  const pointRows = {
    data: [{ point: { id: "point", name: "测试楼" }, status: "published" }],
    meta: { pagination: { page: 1, page_size: 20, total: 1 } },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    URLSearchParams,
    AbortController,
    window: {
      confirm: () => confirm,
      addEventListener() {},
      removeEventListener() {},
    },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name === "./api")
        return {
          message: (e) => e.message,
          stateNames: {
            draft: "草稿",
            in_review: "待审核",
            published: "已发布",
          },
          request: async (path, method = "GET", body) => {
            calls.push({ path, method, body });
            return { data: await reply(path, method, body) };
          },
        };
      if (name === "./ui")
        return {
          Empty: () => null,
          ErrorBox: () => null,
          Pager: () => null,
          useResource(path) {
            paths.push(path);
            return {
              data: path?.startsWith("/points?")
                ? pointRows
                : path?.startsWith("/resources?")
                  ? rows
                  : null,
              error: "",
              loading: false,
            };
          },
        };
      if (name === "./ChangeDiff") return { ChangeDiff: () => null };
      if (name.endsWith("/FloorViewer")) return { FloorViewer: () => null };
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name.endsWith("/catalogSync")) return { notifyCatalogPublished() {} };
      if (name.endsWith("/client"))
        return {
          get: async () => {
            throw new Error("unexpected public verification");
          },
        };
      throw new Error(name);
    },
  });
  const props = {
    session: { user: { id: "editor", role: "editor" }, permissions },
    onDirty() {},
    onUpdate() {},
  };
  let tree;
  return {
    calls,
    paths,
    focused,
    scrolled,
    setConfirm: (v) => (confirm = v),
    render() {
      let n = 0;
      do {
        assert.ok(++n < 25);
        index = 0;
        dirty = false;
        queued = [];
        tree = exports.ResourceWorkspace(props);
        for (const node of walk(tree, (n) => n.props?.ref)) {
          if (!node.props.ref.current)
            node.props.ref.current = {
              focus: () => focused.push(text(node)),
              scrollIntoView: () => scrolled.push(text(node)),
            };
        }
        queued.forEach((fn) => fn());
      } while (dirty);
      return tree;
    },
    async open() {
      const tree = this.render();
      button(tree, "测试全景VR 全景链接草稿")?.props.onClick();
      if (!calls.length) {
        walk(
          tree,
          (n) => n.type === "button" && text(n).includes("测试全景"),
        )[0].props.onClick();
      }
      await tick();
      return this.render();
    },
  };
}
function form(tree) {
  return walk(tree, (n) => n.type === "form")[0];
}

test("resource primary saves then submits returned revision and preserves the full source note", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = harness(async (path, method) =>
    method === "GET"
      ? record
      : method === "PUT"
        ? (await gate, saved)
        : submitted,
  );
  let tree = await h.open();
  const note = "已核实资料".repeat(250);
  field(tree, "本次资料依据").props.onChange({ target: { value: note } });
  tree = h.render();
  const submit = form(tree).props.onSubmit;
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  assert.equal(
    h.calls.filter((c) => c.method === "PUT").length,
    1,
    "synchronous duplicate submission is blocked",
  );
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("review/submit")).length,
    0,
    "submission waits for save",
  );
  release();
  await tick();
  tree = h.render();
  const writes = h.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.expected_revision, 6);
  assert.equal(writes[0].body.expected_published_revision, 4);
  assert.equal(writes[0].body.source_note, note);
  assert.equal(writes[1].path, "/resources/vr/review/submit");
  assert.equal(writes[1].body.expected_revision, 7);
  assert.equal(writes[1].body.note, note.slice(0, 1000));
  assert.equal(h.focused.length, 1, "save/poll refresh does not steal focus");
  assert.equal(
    writes.some((c) => /publish|reject/.test(c.path)),
    false,
  );
});

test("resource submit failure retains saved draft and retry submits without saving again", async () => {
  let failed = false;
  const h = harness(async (path, method) => {
    if (method === "GET") return record;
    if (method === "PUT") return saved;
    if (!failed) {
      failed = true;
      throw new Error("提交连接中断");
    }
    return submitted;
  });
  let tree = await h.open();
  field(tree, "全景名称").props.onChange({ target: { value: "更名全景" } });
  tree = h.render();
  form(tree).props.onSubmit({ preventDefault() {} });
  await tick();
  tree = h.render();
  assert.ok(text(tree).includes("已保留刚保存的草稿"));
  assert.ok(button(tree, "提交审核"));
  assert.equal(button(tree, "仅保存草稿").props.disabled, true);
  form(tree).props.onSubmit({ preventDefault() {} });
  await tick();
  h.render();
  assert.equal(h.calls.filter((c) => c.method === "PUT").length, 1);
  const submits = h.calls.filter((c) => c.path.endsWith("review/submit"));
  assert.equal(submits.length, 2);
  assert.ok(submits.every((c) => c.body.expected_revision === 7));
});

test("resource secondary saves only and return to list guards dirty changes while preserving filters", async () => {
  const h = harness(async (_, method) => (method === "GET" ? record : saved));
  let tree = h.render();
  walk(
    tree,
    (n) => n.props?.["aria-label"] === "搜索资料名称或所属地点",
  )[0].props.onChange({ target: { value: "全景筛选" } });
  tree = await h.open();
  field(tree, "全景名称").props.onChange({ target: { value: "另一名称" } });
  tree = h.render();
  h.setConfirm(false);
  button(tree, "返回资料列表").props.onClick();
  tree = h.render();
  assert.ok(form(tree));
  button(tree, "仅保存草稿").props.onClick();
  await tick();
  tree = h.render();
  assert.equal(h.calls.filter((c) => c.method !== "GET").length, 1);
  button(tree, "返回资料列表").props.onClick();
  tree = h.render();
  assert.equal(form(tree), undefined);
  assert.equal(
    walk(tree, (n) => n.props?.["aria-label"] === "搜索资料名称或所属地点")[0]
      .props.value,
    "全景筛选",
  );
  assert.equal(h.focused.at(-1), "全部地点资料");
  assert.equal(h.scrolled.length, 2);
});

test("creating a floor brings its editor into view and awaiting-review contributors remain blocked", async () => {
  const h = harness(async () => record);
  let tree = h.render();
  walk(
    tree,
    (n) => n.type === "button" && text(n) === "测试楼已发布",
  )[0].props.onClick();
  tree = h.render();
  button(tree, "＋ 新增楼层").props.onClick();
  tree = h.render();
  assert.ok(button(tree, "保存并提交审核"));
  assert.equal(h.focused.at(-1), "楼层资料");
  const reviewer = harness(
    async () => submitted,
    ["points.edit", "points.review"],
  );
  tree = await reviewer.open();
  assert.equal(button(tree, "通过并发布").props.disabled, true);
  assert.equal(button(tree, "保存并提交审核"), undefined);
});
