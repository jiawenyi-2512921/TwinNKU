import { test } from "node:test";
import assert from "node:assert/strict";
import { controlledAdmin, find } from "./helpers/controlled-admin.mjs";

test("VR location management opens the exact real point through normal dirty and uncertain-operation guards", async () => {
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
      point_ids: ["real-point"],
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
  const App = h.load("./AdminApp").default,
    render = () => h.render("app", App, {});
  const workspace = (name) =>
    find(render(), (node) => node.type === components[name])[0];
  render();
  await new Promise((resolve) => setImmediate(resolve));
  workspace("Overview").props.onNavigate("resources");
  let resource = workspace("ResourceWorkspace");
  assert.equal(typeof resource.props.onPoint, "function");
  const before = calls.length;
  resource.props.onDirty(true, true);
  resource.props.onPoint("real-point");
  assert.ok(workspace("ResourceWorkspace"));
  assert.equal(workspace("PointWorkspace"), undefined);
  resource.props.onDirty(true, false);
  h.browser.confirm = () => false;
  resource.props.onPoint("real-point");
  assert.ok(workspace("ResourceWorkspace"));
  assert.equal(workspace("PointWorkspace"), undefined);
  h.browser.confirm = () => true;
  resource.props.onPoint("real-point");
  assert.equal(workspace("ResourceWorkspace"), undefined);
  assert.equal(workspace("PointWorkspace").props.initialId, "real-point");
  assert.equal(calls.length, before);
  assert.ok(calls.every(([, method]) => !method || method === "GET"));
  h.dispose();
});
