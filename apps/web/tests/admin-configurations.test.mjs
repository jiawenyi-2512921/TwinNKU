import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  button,
  text,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("announcement date inputs always represent Beijing time, including a UTC date boundary", () => {
  const h = setup();
  const helpers = h.load("./ConfigurationWorkspace");
  assert.equal(
    helpers.beijingDateTimeInput("2026-10-03T20:30:00Z"),
    "2026-10-04T04:30",
  );
  assert.equal(
    helpers.beijingDateTimeUtc("2026-10-04T04:30"),
    "2026-10-03T20:30:00.000Z",
  );
  assert.equal(helpers.beijingDateTimeUtc(""), null);
  h.dispose();
});

test("configuration issue navigation selects only a module from the exact report revision", () => {
  for (const revision of [4, 3]) {
    const h = setup({
      record: {},
      initialIssue: {
        entity_type: "configuration",
        entity_id: "config",
        revision,
        published_revision: 2,
        path: "modules.1.image",
      },
    });
    const tree = h.open();
    const headings = find(tree, (node) => node.type === "h4").map(text);
    assert.ok(headings.includes(revision === 4 ? "参观方式" : "首页主视觉"));
    assert.equal(
      h.calls.some(([, method]) => method && method !== "GET"),
      false,
    );
    h.dispose();
  }
});
const session = {
  user: { id: "editor", role: "editor", campus_ids: ["campus"], point_ids: [] },
  permissions: ["configurations.edit"],
};
const visitDraft = {
  kind: "visit_defaults",
  layout: "balanced",
  assistant_collapsed: true,
  welcome_text: "",
  recommended_questions: [],
  map_categories: [],
  map_show_labels: true,
  map_default_view: null,
  map_layers: ["point_regions"],
  map_focus_effect: "short",
};
const field = (tree, label) =>
  find(tree, (n) => n.type === "label" && text(n).startsWith(label)).flatMap(
    (n) => find(n, (c) => ["input", "select", "textarea"].includes(c.type)),
  )[0];
function setup(options = {}) {
  const calls = [],
    notices = [],
    ExhibitionHome = () => null,
    TourCatalog = () => null,
    MapDefaultsEditor = () => null;
  let record;
  const h = controlledAdmin({
    "../../shared/api/client": {
      get: async () => ({ data: options.showcase ?? showcase }),
    },
    "../visit/Exhibition": { ExhibitionHome, TourCatalog },
    "./MapDefaultsEditor": { MapDefaultsEditor },
    "./ui": {
      ErrorBox: () => null,
      useResource: (path) => ({
        data: {
          data:
            path === ""
              ? [
                  { id: "campus", name: "测试校区" },
                  { id: "outside", name: "范围外校区" },
                ]
              : path === "/configuration-permissions"
                ? (options.grants ?? [
                    {
                      user_id: "editor",
                      permission: "configurations.edit",
                      scope: "campus",
                    },
                  ])
                : record
                  ? [record]
                  : [],
        },
        error: "",
        loading: false,
      }),
    },
    "./api": {
      stateNames: { draft: "草稿", in_review: "待审核", published: "已发布" },
      message: (e) => e.message,
      request: async (...args) => {
        calls.push(args);
        const [path, method = "GET", body] = args;
        if (options.request) {
          const value = await options.request(
            path,
            method,
            body,
            record,
            showcase,
          );
          if (value !== undefined) return { data: value };
        }
        if (path.startsWith("/experiences?")) return { data: [] };
        if (path === "/configurations/preview")
          return {
            data: {
              ...showcase,
              presentation: { ...showcase.presentation, ...body.content },
              visit_defaults:
                body.kind === "visit_defaults"
                  ? { ...showcase.visit_defaults, ...body.content }
                  : showcase.visit_defaults,
            },
          };
        if (path.includes("/preview?")) return { data: showcase };
        if (path.includes("/history")) return { data: [] };
        if (method !== "GET") {
          record = {
            ...(record ?? base),
            id: "config",
            revision: (record?.revision ?? 0) + 1,
            draft: {
              ...(body.content.kind === "visit_defaults"
                ? defaults
                : defaultContent),
              ...body.content,
            },
            override_fields: Object.keys(body.content || {}).filter(
              (key) => key !== "kind",
            ),
          };
          return { data: record };
        }
        return { data: record };
      },
    },
  });
  const defaultContent = h
      .load("./configurationTypes")
      .defaultConfiguration("presentation"),
    defaults = h
      .load("./configurationTypes")
      .defaultConfiguration("visit_defaults");
  const showcase = {
    campus_id: "campus",
    presentation: defaultContent,
    visit_defaults: defaults,
    configuration_revisions: {},
    routes: [],
    resolved_resources: [],
    capabilities: {
      chat: false,
      voice: false,
      navigation: true,
      narration: true,
    },
  };
  const base = {
    id: "config",
    kind: "presentation",
    scope: "campus",
    revision: 4,
    published_revision: 2,
    state: "draft",
    draft: defaultContent,
    published: defaultContent,
    override_fields: [],
    contributor_ids: ["editor"],
    submitted_by: null,
    permissions: { edit: true, review: false },
    content_sha256: "a".repeat(64),
    updated_at: "2026-10-03T01:00:00Z",
    resume_services: [],
    review_note: "",
  };
  record = options.record
    ? {
        ...base,
        ...options.record,
        draft: options.record.draft ?? defaultContent,
      }
    : null;
  const exported = h.load("./ConfigurationWorkspace"),
    props = {
      session: options.session ?? session,
      onDirty: (...value) => notices.push(value),
      onSaved() {},
      onUpdate() {},
      review: options.review ?? false,
      initialIssue: options.initialIssue,
    };
  let inner;
  const renderOuter = () =>
    h.render("outer", exported.ConfigurationWorkspace, props);
  function render() {
    const tree = renderOuter();
    inner = find(
      tree,
      (n) =>
        typeof n.type === "function" &&
        n.props.initial !== undefined &&
        n.props.kind,
    )[0];
    return inner ? h.render("editor", inner.type, inner.props) : tree;
  }
  function open() {
    let tree = renderOuter();
    if (record) button(tree, "测试校区 · 草稿 · v4")?.props.onClick();
    else {
      field(tree, "新建范围").props.onChange({ target: { value: "campus" } });
      tree = renderOuter();
      button(tree, "＋ 新建该范围草稿").props.onClick();
    }
    return render();
  }
  return {
    ...h,
    calls,
    notices,
    render,
    renderOuter,
    open,
    ExhibitionHome,
    TourCatalog,
    MapDefaultsEditor,
    defaults,
    base,
    defaultContent,
    get record() {
      return record;
    },
  };
}
test("new configuration creation is restricted to the exact editor grant and legacy campus scope", () => {
  const h = setup();
  let tree = h.renderOuter();
  assert.equal(button(tree, "＋ 新建该范围草稿").props.disabled, true);
  assert.equal(
    find(tree, (n) => n.type === "option" && n.props.value === "outside")
      .length,
    0,
  );
  field(tree, "新建范围").props.onChange({ target: { value: "campus" } });
  tree = h.renderOuter();
  assert.equal(button(tree, "＋ 新建该范围草稿").props.disabled, false);
  h.dispose();
});
test("campus configuration autosave sends only explicit overrides, a UUID and no publish or paid request", async () => {
  const h = setup();
  let tree = h.open();
  field(tree, "站点名称").props.onChange({ target: { value: "校区展示名" } });
  h.render();
  h.runTimers(3000);
  await settle();
  tree = h.render();
  const write = h.calls.find(
    ([path, method]) => path === "/configurations" && method === "POST",
  );
  assert.ok(write);
  assert.deepEqual(Object.keys(write[2].content).sort(), ["kind", "site_name"]);
  assert.equal(write[2].scope, "campus");
  assert.match(write[2].operation_id, /^[a-f0-9-]{36}$/);
  assert.equal(
    h.calls.some(([path]) => /publish|narration|voice|assistant/.test(path)),
    false,
  );
  h.dispose();
});

test("explicit fit auto-saves null while restoring inheritance omits the view and keeps CAS plus the original operation boundary", async () => {
  const h = setup({
    record: { kind: "visit_defaults", draft: visitDraft, override_fields: [] },
  });
  let tree = h.open();
  let editor = find(tree, (node) => node.type === h.MapDefaultsEditor)[0];
  assert.equal(editor.props.campusId, "campus");
  assert.equal(editor.props.scope, "campus");
  editor.props.onChange({ map_default_view: null });
  h.render();
  h.runTimers(3000);
  await settle();
  tree = h.render();
  const first = h.calls.filter(
    ([path, method]) => path === "/configurations/config" && method === "PUT",
  )[0];
  assert.ok(
    first,
    "explicit fit is saved even when local default was already null",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(first[2].content)), {
    kind: "visit_defaults",
    map_default_view: null,
  });
  assert.equal(first[2].expected_revision, 4);
  assert.equal(first[2].expected_published_revision, 2);
  assert.match(first[2].operation_id, /^[a-f0-9-]{36}$/);
  editor = find(tree, (node) => node.type === h.MapDefaultsEditor)[0];
  editor.props.onInherit("map_default_view");
  h.render();
  h.runTimers(3000);
  await settle();
  h.render();
  const second = h.calls.filter(
    ([path, method]) => path === "/configurations/config" && method === "PUT",
  )[1];
  assert.deepEqual(JSON.parse(JSON.stringify(second[2].content)), {
    kind: "visit_defaults",
  });
  assert.equal(second[2].expected_revision, 5);
  assert.notEqual(first[2].operation_id, second[2].operation_id);
  assert.equal(
    h.calls.some(([path]) => /publish|narration|voice|assistant/.test(path)),
    false,
  );
  h.dispose();
});

test("inherited legal category order is reordered without losing its remaining categories or mutating the server result", async () => {
  const h = setup({
    record: { kind: "visit_defaults", draft: visitDraft, override_fields: [] },
    request: (path, method, body, _row, showcase) =>
      path === "/configurations/preview"
        ? {
            ...showcase,
            visit_defaults: {
              ...visitDraft,
              map_categories: ["history", "academic"],
            },
            visit_default_sources: { map_categories: "global" },
          }
        : undefined,
  });
  h.open();
  await settle();
  h.render();
  h.runTimers(350);
  await settle();
  let tree = h.render();
  assert.match(text(tree), /继承已审全站设置/);
  const down = find(
    tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "下移历史文化",
  )[0];
  assert.ok(down);
  down.props.onClick();
  h.render();
  h.runTimers(3000);
  await settle();
  tree = h.render();
  const write = h.calls.find(
    ([path, method]) => path === "/configurations/config" && method === "PUT",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(write[2].content)), {
    kind: "visit_defaults",
    map_categories: ["academic", "history"],
  });
  assert.equal(button(tree, "恢复继承分类顺序").props.disabled, false);
  assert.match(text(tree), /不会隐藏地点/);
  h.dispose();
});

test("a read-only reviewer receives disabled map controls, and forged callback invocation cannot save a setting", async () => {
  const h = setup({
    record: {
      kind: "visit_defaults",
      draft: visitDraft,
      permissions: { edit: false, review: true },
    },
    review: true,
  });
  const outer = h.renderOuter();
  find(
    outer,
    (node) =>
      node.type === "button" && text(node).startsWith("测试校区 · 草稿"),
  )[0].props.onClick();
  const tree = h.render(),
    editor = find(tree, (node) => node.type === h.MapDefaultsEditor)[0];
  assert.equal(editor.props.disabled, true);
  assert.equal(
    find(
      tree,
      (node) =>
        node.type === "fieldset" &&
        node.props.disabled &&
        find(node, (child) => child.type === h.MapDefaultsEditor).length > 0,
    ).length,
    0,
    "read-only review may pan, zoom, choose and reload real preview maps",
  );
  editor.props.onChange({ map_layers: [] });
  editor.props.onInherit("map_default_view");
  h.render();
  h.runTimers(3000);
  await settle();
  h.render();
  assert.equal(
    h.calls.some(([, method]) => method && method !== "GET"),
    false,
  );
  h.dispose();
});
test("unsaved preview reads the service's real layered result and uses the public component without navigation history or progress", async () => {
  const h = setup({
    request: (path, method, body, _row, showcase) =>
      path === "/configurations/preview"
        ? {
            ...showcase,
            presentation: {
              ...showcase.presentation,
              site_name: "服务器层叠结果",
            },
          }
        : undefined,
  });
  h.open();
  await settle();
  h.render();
  h.runTimers(350);
  await settle();
  let tree = h.render();
  const preview = find(tree, (n) => n.type === h.ExhibitionHome)[0];
  assert.ok(preview);
  assert.equal(preview.props.previewOnly, true);
  assert.equal(preview.props.showcase.presentation.site_name, "服务器层叠结果");
  preview.props.onNavigate({ kind: "tours" });
  tree = h.render();
  assert.ok(find(tree, (n) => n.type === h.TourCatalog)[0]);
  const read = h.calls.find(([path]) => path === "/configurations/preview");
  assert.equal(read[1], "POST");
  assert.equal(read[2].campus_id, "campus");
  assert.deepEqual(Object.keys(read[2].content), ["kind"]);
  assert.equal(
    h.calls.some(([path]) =>
      /configurations$|submit|publish|narration/.test(path),
    ),
    false,
  );
  h.dispose();
});
test("selecting an existing campus draft preserves its real scope and self-review disables publishing and rejection", async () => {
  const h = setup({
    record: {
      state: "in_review",
      submitted_by: "editor",
      permissions: { edit: true, review: true },
    },
    review: true,
  });
  const outer = h.renderOuter();
  const pick = find(
    outer,
    (n) => n.type === "button" && text(n).includes("测试校区 · 待审核"),
  )[0];
  pick.props.onClick();
  let tree = h.render();
  assert.match(text(tree), /首页与展示编排 · 测试校区/);
  assert.equal(button(tree, "审核通过并发布").props.disabled, true);
  assert.equal(button(tree, "退回修改").props.disabled, true);
  h.runTimers(350);
  await settle();
  h.render();
  assert.ok(
    h.calls.find(
      ([path, method]) =>
        path.includes("/configurations/config/preview?") && method === "GET",
    ),
  );
  assert.equal(
    h.calls.some(([path]) => path === "/configurations/preview"),
    false,
  );
  h.dispose();
});
test("a lost configuration submit queries only its original operation and freezes further mutation until confirmed", async () => {
  const h = setup({
    record: {},
    request: (path, method) => {
      if (path.endsWith("/submit")) throw new Error("lost submit response");
      if (path.startsWith("/operations/"))
        throw Object.assign(new Error("unknown"), { status: 404 });
      return undefined;
    },
  });
  let tree = h.open();
  field(tree, "变更／审核说明").props.onChange({
    target: { value: "测试提交说明" },
  });
  tree = h.render();
  button(tree, "保存并提交审核").props.onClick();
  await settle();
  tree = h.render();
  assert.ok(button(tree, "查询本次审核／恢复操作结果"));
  const write = h.calls.find(([path]) => path.endsWith("/submit")),
    query = h.calls.find(([path]) => path.startsWith("/operations/"));
  assert.equal(query[0], `/operations/${write[2].operation_id}`);
  assert.equal(h.notices.at(-1)[1], true);
  button(tree, "查询本次审核／恢复操作结果").props.onClick();
  await settle();
  h.render();
  assert.equal(h.calls.filter(([path]) => path.endsWith("/submit")).length, 1);
  h.dispose();
});
test("a reviewer without edit permission gets real server-layered history preview through an authenticated GET and never restores or charges", async () => {
  const h = setup({
    record: {
      state: "in_review",
      permissions: { edit: false, review: true },
      submitted_by: "editor",
    },
    review: true,
    session: {
      user: {
        id: "reviewer",
        role: "reviewer",
        campus_ids: ["campus"],
        point_ids: [],
      },
      permissions: ["configurations.review"],
    },
    request: (path, _method, _body, _row, showcase) =>
      path === "/configurations/config/history"
        ? [
            {
              id: "history-version",
              configuration_id: "config",
              event: "submit",
              revision: 3,
              published_revision: 1,
              content: showcase.presentation,
              override_fields: ["site_name"],
              content_sha256: "b".repeat(64),
              created_at: "2026-10-03T00:00:00Z",
            },
          ]
        : path.includes("/history/history-version/preview?")
          ? {
              ...showcase,
              presentation: {
                ...showcase.presentation,
                site_name: "服务端历史真实层叠",
              },
            }
          : undefined,
  });
  const outer = h.renderOuter();
  find(
    outer,
    (node) =>
      node.type === "button" && text(node).includes("测试校区 · 待审核"),
  )[0].props.onClick();
  let tree = h.render();
  button(tree, "查看历史与恢复草稿").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(button(tree, "恢复为新草稿").props.disabled, true);
  button(tree, "用此历史配置私有预览").props.onClick();
  await settle();
  tree = h.render();
  const section = find(
    tree,
    (node) => node.props?.["aria-label"] === "历史配置私有预览",
  )[0];
  assert.ok(section);
  const preview = find(section, (node) => node.type === h.ExhibitionHome)[0];
  assert.equal(preview.props.previewOnly, true);
  assert.equal(
    preview.props.showcase.presentation.site_name,
    "服务端历史真实层叠",
  );
  assert.match(text(section), /当前正式继承层/);
  const read = h.calls.find(([path]) =>
    path.includes("/history/history-version/preview?"),
  );
  assert.equal(
    read[0],
    "/configurations/config/history/history-version/preview?campus_id=campus",
  );
  assert.equal(read[1], "GET");
  assert.equal(
    h.calls.some(([, method]) => method === "POST"),
    false,
  );
  preview.props.onNavigate({ kind: "tours" });
  tree = h.render();
  assert.ok(
    find(
      find(
        tree,
        (node) => node.props?.["aria-label"] === "历史配置私有预览",
      )[0],
      (node) => node.type === h.TourCatalog,
    )[0],
  );
  h.dispose();
});
