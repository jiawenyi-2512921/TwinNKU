import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as geometry from "../src/features/admin/geometry.ts";
import { adminLogic } from "./helpers/admin-logic.mjs";
const compile = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const code = compile("../src/features/admin/PointWorkspace.tsx");
const mapCode = compile("../src/features/admin/MapEditor.tsx");
const walk = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((node) => walk(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...walk(tree.props?.children, predicate),
  ];
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function hooks() {
  const slots = [],
    effects = [];
  let index = 0,
    dirty = false,
    queue = [];
  return {
    react: {
      useState(value) {
        const key = index++;
        if (!(key in slots)) slots[key] = value;
        return [
          slots[key],
          (next) => {
            const value = typeof next === "function" ? next(slots[key]) : next;
            if (!Object.is(value, slots[key])) {
              slots[key] = value;
              dirty = true;
            }
          },
        ];
      },
      useRef(value) {
        const key = index++;
        if (!(key in slots)) slots[key] = { current: value };
        return slots[key];
      },
      useEffect(effect, deps) {
        const key = index++,
          before = effects[key];
        if (
          !before ||
          !deps ||
          deps.some((value, i) => !Object.is(value, before.deps[i]))
        )
          queue.push(() => {
            before?.cleanup?.();
            effects[key] = { deps, cleanup: effect() };
          });
      },
    },
    render(component, props) {
      let tree,
        iteration = 0;
      do {
        assert.ok(++iteration < 25);
        index = 0;
        dirty = false;
        queue = [];
        tree = component(props);
        queue.forEach((effect) => effect());
      } while (dirty);
      return tree;
    },
    dispose() {
      effects.forEach((effect) => effect?.cleanup?.());
    },
  };
}
const location = {
  map_id: "map",
  map_revision: 3,
  anchor: { x: 200, y: 200 },
  polygon: [
    { x: 180, y: 180 },
    { x: 220, y: 180 },
    { x: 220, y: 220 },
    { x: 180, y: 220 },
  ],
  label_on_map: true,
};
const content = {
  campus_id: "campus",
  name: "待改地点",
  aliases: [],
  category: "academic",
  summary: "已有介绍",
  visibility: "public",
  source_note: "团队核对地图位置",
  geometry: location,
};
const record = (state = "draft", revision = 3, payload = content) => ({
  point: {
    id: "point",
    campus_id: "campus",
    name: "正式地点",
    summary: "正式介绍",
    aliases: [],
    category: "academic",
    revision: 8,
    updated_at: "2026-09-29T00:00:00Z",
  },
  status: "published",
  visibility: "public",
  geometries: [location],
  draft: {
    state,
    revision,
    operation: "upsert",
    payload,
    contributor_ids: ["editor"],
    submitted_by: state === "in_review" ? "editor" : null,
    updated_at: "2026-09-29T00:00:00Z",
  },
});
const map = {
  id: "map",
  campus_id: "campus",
  revision: 3,
  width_px: 1000,
  height_px: 1000,
  title: "校园底图",
};
async function workspace(value = record(), overrides = {}) {
  const h = hooks(),
    reads = [],
    dirty = [],
    browser = new EventTarget(),
    exported = {};
  browser.confirm = () => true;
  const MapEditor = () => null,
    ErrorBox = () => null;
  const props = {
    session: {
      permissions: ["points.edit"],
      user: { id: "editor", role: "editor", point_ids: [] },
    },
    maps: [map],
    initialId: "point",
    onDirty: (...state) => dirty.push(state),
    onUpdate() {},
    ...overrides,
  };
  const draftLogic = adminLogic(
    h.react,
    {
      request: (path, method = "GET", body) =>
        new Promise((resolve, reject) =>
          reads.push({ path, method, body, resolve, reject }),
        ),
    },
    { setTimeout: () => 1, clearTimeout() {} },
  );
  vm.runInNewContext(code, {
    exports: exported,
    Error,
    AbortSignal,
    URLSearchParams,
    window: browser,
    setTimeout: () => 1,
    clearTimeout() {},
    require(name) {
      if (name === "./useManagedDraft") return draftLogic(name);
      if (name === "./DraftStatus") return { DraftStatusBar: () => null };
      if (name === "./ContentHistory") return { ContentHistory: () => null };
      if (name === "react") return h.react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith(".css")) return {};
      if (name === "./api")
        return {
          activeDraft: (p) =>
            p.draft &&
            ["draft", "rejected", "in_review"].includes(p.draft.state),
          categories: { academic: "教学科研" },
          stateNames: { draft: "草稿", published: "已发布", in_review: "待审" },
          message: (e) => e.message,
          request: (path, method = "GET", body) =>
            new Promise((resolve, reject) =>
              reads.push({ path, method, body, resolve, reject }),
            ),
        };
      if (name === "./ui")
        return {
          ErrorBox,
          Empty: () => null,
          Pager: () => null,
          timestamp: (v) => v,
          useResource: () => ({
            data: { data: [], meta: {} },
            loading: false,
            error: "",
          }),
        };
      if (name === "./MapEditor") return { MapEditor };
      if (name === "./geometry") return geometry;
      if (name === "./ChangeDiff") return { ChangeDiff: () => null };
      if (name === "./publication")
        return { verifyPublication: async () => ({ ok: true }) };
      if (name === "../../shared/api/client") return { api: {} };
      if (name === "../../shared/catalogSync")
        return { notifyCatalogPublished() {} };
      throw new Error(name);
    },
  });
  const render = () => h.render(exported.PointWorkspace, props);
  render();
  reads[0].resolve({ data: value });
  await flush();
  render();
  const button = (title) =>
    walk(
      render(),
      (node) => node.type === "button" && node.props.children === title,
    )[0];
  const nameInput = () =>
    walk(
      render(),
      (node) => node.type === "input" && node.props.maxLength === 120,
    )[0];
  return {
    ...h,
    render,
    reads,
    dirty,
    props,
    button,
    nameInput,
    MapEditor,
    ErrorBox,
    submit: () =>
      walk(render(), (node) => node.type === "form")[0].props.onSubmit({
        preventDefault() {},
      }),
    editName(value) {
      nameInput().props.onChange({ target: { value } });
      render();
    },
    async respond(value) {
      reads.at(-1).resolve({ data: value });
      await flush();
      render();
    },
  };
}

test("save-and-submit uses the returned draft revision and one evidence note, never publishes", async () => {
  const h = await workspace();
  try {
    h.editName("更新后的名称");
    h.submit();
    assert.equal(h.reads[1].method, "PUT");
    assert.equal(h.reads[1].body.expected_revision, 3);
    assert.equal(h.reads[1].body.expected_point_revision, 8);
    await h.respond(record("draft", 4, { ...content, name: "更新后的名称" }));
    assert.equal(h.reads[2].path, "/points/point/submit");
    assert.equal(h.reads[2].body.expected_revision, 4);
    assert.equal(h.reads[2].body.note, content.source_note);
    await h.respond(
      record("in_review", 5, { ...content, name: "更新后的名称" }),
    );
    assert.equal(h.nameInput().props.value, "更新后的名称");
    assert.equal(
      h.reads.some((r) => r.path.endsWith("/publish")),
      false,
    );
    assert.ok(h.button("撤回并继续修改"));
  } finally {
    h.dispose();
  }
});
test("failed save preserves unsaved edits; retry cannot submit before a save succeeds", async () => {
  const h = await workspace();
  try {
    h.editName("尚未保存的新名称");
    h.submit();
    h.reads[1].reject(
      Object.assign(new Error("资料格式错误"), { status: 422 }),
    );
    await flush();
    h.render();
    assert.equal(h.nameInput().props.value, "尚未保存的新名称");
    assert.equal(h.dirty.at(-1)[0], true);
    assert.equal(h.reads.length, 2);
    assert.equal(h.button("保存草稿").props.disabled, false);
    h.submit();
    assert.equal(h.reads[2].method, "PUT");
    assert.equal(h.reads[2].body.name, "尚未保存的新名称");
  } finally {
    h.dispose();
  }
});
test("submit failure retains the saved revision and retries submission without a duplicate save", async () => {
  const h = await workspace();
  try {
    h.editName("已保存名称");
    h.submit();
    await h.respond(record("draft", 7, { ...content, name: "已保存名称" }));
    h.reads[2].reject(
      Object.assign(new Error("提交说明被拒绝"), { status: 422 }),
    );
    await flush();
    h.render();
    assert.equal(h.nameInput().props.value, "已保存名称");
    assert.equal(h.button("保存草稿").props.disabled, true);
    h.submit();
    await flush();
    assert.equal(h.reads[3].path, "/points/point/submit");
    assert.equal(h.reads[3].body.expected_revision, 7);
    assert.equal(h.reads[3].body.note, content.source_note);
  } finally {
    h.dispose();
  }
});
test("withdrawing an authored review preserves its content for the next edit and revision", async () => {
  const h = await workspace(
    record("in_review", 5, { ...content, name: "待审新名称" }),
  );
  try {
    h.button("撤回并继续修改").props.onClick();
    assert.equal(h.reads[1].path, "/content/point/point/withdraw");
    assert.equal(h.reads[1].body.expected_revision, 5);
    await h.respond(record("draft", 6, { ...content, name: "待审新名称" }));
    assert.equal(h.nameInput().props.value, "待审新名称");
    assert.equal(h.dirty.at(-1)[0], false);
    h.editName("撤回后继续修改");
    h.button("保存草稿").props.onClick();
    assert.equal(h.reads[2].method, "PUT");
    assert.equal(h.reads[2].body.expected_revision, 6);
    assert.equal(h.reads[2].body.name, "撤回后继续修改");
  } finally {
    h.dispose();
  }
});
test("review permissions remain independent and advanced coordinate fields start collapsed", async () => {
  const h = await workspace(record("in_review"), {
    review: true,
    session: {
      permissions: ["points.edit", "points.review"],
      user: { id: "editor", role: "editor", point_ids: [] },
    },
  });
  try {
    assert.equal(h.button("审核并发布").props.disabled, true);
    const coordinates = walk(
      h.render(),
      (node) =>
        node.type === "details" &&
        walk(
          node,
          (n) =>
            n.type === "summary" && n.props.children === "精确坐标（高级调整）",
        ).length,
    )[0];
    assert.equal(coordinates.props.open, undefined);
    assert.equal(
      walk(h.render(), (node) => node.type === h.MapEditor)[0].props.editable,
      false,
    );
  } finally {
    h.dispose();
  }
  const other = await workspace(record("in_review"), {
    session: {
      permissions: ["points.edit"],
      user: { id: "other", role: "editor", point_ids: [] },
    },
  });
  try {
    assert.equal(other.button("撤回并继续修改"), undefined);
  } finally {
    other.dispose();
  }
});

test("point editing routes review to the center even when the account can review", async () => {
  const opened = [];
  const h = await workspace(record("in_review"), {
    session: {
      permissions: ["points.edit", "points.review"],
      user: { id: "other", role: "admin", point_ids: [] },
    },
    onReview: (id) => opened.push(id),
  });
  try {
    assert.equal(h.button("审核并发布"), undefined);
    assert.equal(h.button("退回修改"), undefined);
    h.button("去审核中心").props.onClick();
    assert.deepEqual(opened, ["point"]);
    assert.equal(h.reads.filter((call) => call.method === "POST").length, 0);
  } finally {
    h.dispose();
  }
});
test("rapid duplicate save clicks issue only one request", async () => {
  const h = await workspace();
  try {
    h.editName("并发保护");
    const button = h.button("保存草稿");
    button.props.onClick();
    button.props.onClick();
    assert.equal(h.reads.length, 2);
  } finally {
    h.dispose();
  }
});

// Map tools are explicitly selected; default browsing does not expose boundary handles.
test("map boundary drawing controls are revealed only when requested, and Escape returns to browsing", () => {
  const h = hooks(),
    exported = {},
    browser = new EventTarget();
  vm.runInNewContext(mapCode, {
    exports: exported,
    window: browser,
    require(name) {
      if (name === "react") return h.react;
      if (name === "react/jsx-runtime") return jsx;
      if (name === "leaflet" || name.endsWith(".css")) return {};
      if (name === "./geometry") return geometry;
      if (name === "../map/coordinates") return {};
      if (name === "./ui") return { ErrorBox: () => null };
      throw new Error(name);
    },
  });
  const props = {
    info: map,
    points: [],
    selectedId: "point",
    value: location,
    name: "地点",
    editable: true,
    onSelect() {},
    onChange() {},
    onUndo() {},
    canUndo: false,
  };
  const render = () => h.render(exported.MapEditor, props);
  const button = (title) =>
    walk(
      render(),
      (node) => node.type === "button" && node.props.children === title,
    )[0];
  try {
    assert.equal(button("重新画多边形"), undefined);
    button("调整点击范围").props.onClick();
    assert.ok(button("重新画多边形"));
    assert.ok(button("拖动边界角点"));
    const event = new Event("keydown", { cancelable: true });
    event.key = "Escape";
    browser.dispatchEvent(event);
    render();
    assert.equal(event.defaultPrevented, true);
    assert.equal(button("重新画多边形"), undefined);
  } finally {
    h.dispose();
  }
});
