import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  text,
  button,
} from "./helpers/controlled-admin.mjs";

function help(
  permissions = ["points.read", "points.edit"],
  onNavigate = () => true,
) {
  let closed = 0;
  const h = controlledAdmin();
  const exported = h.load("./HelpPanel");
  const props = {
    page: "imports",
    permissions,
    onNavigate,
    onClose: () => closed++,
  };
  const render = () => h.render("help", exported.HelpPanel, props);
  const search = (query) => {
    find(render(), (node) => node.type === "input")[0].props.onChange({
      target: { value: query },
    });
    return render();
  };
  return { ...h, ...exported, props, render, search, closed: () => closed };
}

test("task search accepts common Chinese requests and normalized file keywords, with current page first", () => {
  const h = help();
  assert.equal(h.searchHelpTasks("", "imports")[0].id, "import");
  assert.equal(h.searchHelpTasks("ｘｌｓｘ", "overview")[0].id, "import");
  assert.ok(
    h
      .searchHelpTasks("保存超时", "tours")
      .some((task) => task.id === "unknown"),
  );
  assert.ok(
    h
      .searchHelpTasks("找回版本", "points")
      .some((task) => task.id === "history"),
  );
  assert.equal(h.searchHelpTasks("不存在的任务词", "imports").length, 0);
  h.dispose();
});

test("help distinguishes drafts, review and actual results; unknown-result recovery never calls a service", () => {
  const h = help();
  const tree = h.search("超时");
  assert.match(text(tree), /保留本页输入/);
  assert.match(text(tree), /只查询原来的操作身份/);
  assert.match(text(tree), /不能用新操作代替/);
  assert.match(text(h.search("导入 Excel")), /不会自动提审或发布/);
  assert.equal(
    find(tree, (node) => node.type === "a" || node.type === "form").length,
    0,
  );
  h.dispose();
});

test("help cannot navigate to an unauthorized configuration or runtime editor", () => {
  let navigations = 0;
  const h = help(["points.read"], () => {
    navigations++;
    return true;
  });
  const blocked = button(h.search("我要改首页"), "打开首页与参观编排");
  assert.equal(blocked.props.disabled, true);
  blocked.props.onClick();
  assert.equal(navigations, 0);
  assert.equal(h.closed(), 0);
  assert.equal(
    h.canOpenHelpPage("guide-settings", ["configurations.edit"]),
    false,
  );
  assert.equal(
    h.canOpenHelpPage("configurations", ["configurations.review"]),
    true,
  );
  h.dispose();
});

test("return to the current editor does not invoke navigation or discard inputs", () => {
  let navigations = 0;
  const h = help(undefined, () => {
    navigations++;
    return false;
  });
  button(h.search("我要导入 Excel"), "返回当前编辑器").props.onClick();
  assert.equal(navigations, 0);
  assert.equal(h.closed(), 1);
  h.dispose();
});

test("blocked cross-page navigation keeps help open; Escape closes only help", () => {
  let navigations = 0;
  const h = help(undefined, () => {
    navigations++;
    return false;
  });
  button(h.search("我要添加 VR"), "打开资料中心").props.onClick();
  assert.equal(navigations, 1);
  assert.equal(h.closed(), 0);
  assert.match(text(h.render()), /未保存输入仍需处理/);
  let stopped = false;
  h.render().props.onKeyDown({
    key: "Escape",
    stopPropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  assert.equal(h.closed(), 1);
  h.dispose();
});

test("AdminApp offers read-only help during an uncertain save and preserves the editor on close", async () => {
  const components = Object.fromEntries(
    [
      "GuideSettings",
      "ConfigurationWorkspace",
      "ImportWorkspace",
      "RoadWorkspace",
      "Accounts",
      "Audit",
      "PointWorkspace",
      "ResourceWorkspace",
      "ExperienceWorkspace",
      "Overview",
      "ReviewCenter",
    ].map((name) => [name, () => null]),
  );
  const session = {
    user: {
      id: "editor",
      role: "editor",
      display_name: "编辑",
      campus_ids: [],
      point_ids: [],
      must_change_password: false,
    },
    expires_at: "2026-10-04T00:00:00Z",
    permissions: ["points.read", "points.edit"],
    csrf_token: "test-only",
  };
  const calls = [];
  const h = controlledAdmin({
    ...Object.fromEntries(
      Object.entries(components).map(([name, component]) => [
        `./${name}`,
        { [name]: component },
      ]),
    ),
    "../../shared/ui/EnvironmentBanner": { EnvironmentBanner: () => null },
    "../../shared/ui/Icon": { Icon: () => null },
    "./MfaAuth": {
      MfaSecurity: () => null,
      MfaStepUp: () => null,
      PendingMfa: () => null,
    },
    "./api": {
      roleNames: { editor: "编辑" },
      rememberSession() {},
      rememberCsrf() {},
      message: (e) => e.message,
      request: async (...args) => {
        calls.push(args);
        return { data: session };
      },
    },
    "./ui": {
      ErrorBox: () => null,
      useResource: () => ({ data: { data: [] }, error: "", loading: false }),
    },
  });
  h.browser.setInterval = () => 1;
  h.browser.clearInterval = () => {};
  const App = h.load("./AdminApp").default;
  const render = () => h.render("app", App, {});
  render();
  await new Promise((resolve) => setImmediate(resolve));
  find(
    render(),
    (node) => node.type === components.Overview,
  )[0].props.onNavigate("points");
  const editor = find(
    render(),
    (node) => node.type === components.PointWorkspace,
  )[0];
  editor.props.onDirty(true, true);
  const beforeCalls = calls.length;
  button(render(), "当前页面帮助").props.onClick();
  const panel = find(
    render(),
    (node) => node.type === h.load("./HelpPanel").HelpPanel,
  )[0];
  assert.ok(panel);
  const helpTree = h.render("panel", panel.type, panel.props);
  const search = find(helpTree, (node) => node.type === "input")[0];
  search.props.onChange({ target: { value: "超时" } });
  assert.match(
    text(h.render("panel", panel.type, panel.props)),
    /原来的操作身份/,
  );
  assert.equal(calls.length, beforeCalls);
  assert.equal(panel.props.onNavigate("resources"), false);
  assert.ok(
    find(render(), (node) => node.type === components.PointWorkspace)[0],
  );
  panel.props.onClose();
  assert.equal(find(render(), (node) => node.type === panel.type).length, 0);
  assert.equal(
    find(render(), (node) => node.type === components.PointWorkspace)[0].key,
    editor.key,
  );
  assert.equal(calls.length, beforeCalls);
  h.dispose();
});
