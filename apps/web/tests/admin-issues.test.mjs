import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlledAdmin,
  find,
  text,
  button,
} from "./helpers/controlled-admin.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const issue = {
  entity_type: "tour",
  entity_id: "tour",
  title: "真实路线夹具",
  campus_id: "campus",
  point_id: null,
  state: "draft",
  revision: 3,
  published_revision: 2,
  code: "RESOURCE_VERSION",
  severity: "error",
  message: "引用已变化",
  path: "stops.2.segments.0.resources.0",
  stop_index: 2,
  segment_id: "second-visit",
  resource_type: "image",
  resource_id: "image",
  expected_revision: 1,
  current_revision: 2,
  actions: ["open", "edit", "replace_reference"],
};
const tour = {
  id: "tour",
  revision: 3,
  published_revision: 2,
  content: {
    kind: "tour",
    stops: [
      { point_id: "repeated", segments: [{ id: "first-visit" }] },
      { point_id: "middle", segments: [{ id: "middle" }] },
      { point_id: "repeated", segments: [{ id: "second-visit" }] },
    ],
  },
};
const batch = {
  coverage: "saved_entity_page",
  checked_entity_count: 20,
  issue_count: 1,
  items: [issue],
  has_more: true,
  next_cursor: "opaque-saved-page",
  omitted_issue_count: 0,
};
function setup(respond = () => batch) {
  const calls = [],
    opened = [],
    reviewed = [];
  const h = controlledAdmin({
    "./api": {
      message: (e) => e.message,
      stateNames: { draft: "草稿" },
      request: async (...args) => {
        calls.push(args);
        return { data: await respond(...args) };
      },
    },
    "./ui": { ErrorBox: ({ text }) => text },
  });
  const exports = h.load("./WorkspaceIssues");
  const props = {
    session: {
      user: {
        id: "editor",
        role: "editor",
        campus_ids: ["campus"],
        point_ids: [],
      },
      permissions: ["points.read", "points.edit"],
    },
    campuses: [
      { id: "campus", name: "真实授权校区" },
      { id: "outside", name: "范围外校区" },
    ],
    revision: 0,
    onOpen: (target) => opened.push(target),
    onReview: (target) => reviewed.push(target),
  };
  const render = () => h.render("issues", exports.WorkspaceIssues, props);
  const ready = async () => {
    render();
    await settle();
    return render();
  };
  return { ...h, ...exports, props, render, ready, calls, opened, reviewed };
}

test("saved issues are bounded pages, not all-site health; older traversal uses the opaque cursor", async () => {
  const h = setup();
  let tree = await h.ready();
  assert.match(text(tree), /不代表全站全部问题/);
  assert.match(text(tree), /本页检查 20 项/);
  assert.equal(
    new URLSearchParams(h.calls[0][0].split("?")[1]).get("limit"),
    "20",
  );
  assert.doesNotMatch(text(tree), /范围外校区/);
  button(tree, "检查较早保存的内容").props.onClick();
  tree = await h.ready();
  assert.equal(
    new URLSearchParams(h.calls.at(-1)[0].split("?")[1]).get("cursor"),
    "opaque-saved-page",
  );
  assert.match(text(tree), /第 2 批/);
  const kind = find(tree, (node) => node.type === "select")[0];
  kind.props.onChange({ target: { value: "floor" } });
  await h.ready();
  const params = new URLSearchParams(h.calls.at(-1)[0].split("?")[1]);
  assert.equal(params.get("entity_type"), "floor");
  assert.equal(params.has("cursor"), false);
  assert.ok(h.calls.every(([, method]) => method === "GET"));
  h.dispose();
});

test("scope changes discard the old cursor and reject late object reads", async () => {
  let resolve;
  const h = setup((path) =>
    path.startsWith("/experiences/")
      ? new Promise((done) => {
          resolve = done;
        })
      : batch,
  );
  button(await h.ready(), "打开此项并定位").props.onClick();
  h.props.session = {
    ...h.props.session,
    user: { ...h.props.session.user, point_ids: ["different"] },
  };
  h.render();
  await settle();
  h.render();
  resolve(tour);
  await settle();
  h.render();
  assert.equal(h.opened.length, 0);
  assert.equal(h.calls.at(-1)[0].includes("cursor="), false);
  h.dispose();
});

test("revoking a campus scope clears its old filter before any new request", async () => {
  const h = setup();
  let tree = await h.ready();
  find(tree, (node) => node.type === "select")[1].props.onChange({
    target: { value: "campus" },
  });
  tree = await h.ready();
  assert.equal(
    new URLSearchParams(h.calls.at(-1)[0].split("?")[1]).get("campus_id"),
    "campus",
  );
  h.props.session = {
    ...h.props.session,
    user: { ...h.props.session.user, campus_ids: [] },
  };
  await h.ready();
  assert.equal(
    new URLSearchParams(h.calls.at(-1)[0].split("?")[1]).has("campus_id"),
    false,
  );
  h.dispose();
});

test("opening a result reads the current authenticated entity and marks changed revisions", async () => {
  const h = setup((path) =>
    path.startsWith("/experiences/") ? { ...tour, revision: 4 } : batch,
  );
  button(await h.ready(), "打开此项并定位").props.onClick();
  await settle();
  h.render();
  assert.equal(h.calls.at(-1)[0], "/experiences/tour");
  assert.equal(h.opened[0].changed, true);
  assert.equal(h.opened[0].page, "tours");
  assert.equal(
    h.calls.some(([, method]) => method !== "GET"),
    false,
  );
  h.dispose();
});

test("a wrong identity, forbidden detail or mismatched media type cannot open the editor", async () => {
  for (const response of [
    { ...tour, id: "outside" },
    { ...tour, content: { kind: "media" } },
    new Error("权限已撤回"),
  ]) {
    const h = setup((path) => {
      if (path.startsWith("/experiences/")) {
        if (response instanceof Error) throw response;
        return response;
      }
      return batch;
    });
    button(await h.ready(), "打开此项并定位").props.onClick();
    await settle();
    h.render();
    assert.equal(h.opened.length, 0);
    h.dispose();
  }
});

test("repeated route locations bind the exact stop and stable segment, never an old revision", () => {
  const h = setup();
  const identity = { id: "tour", revision: 3, published_revision: 2 };
  assert.equal(h.locateTourIssue(tour.content, issue, identity).stopIndex, 2);
  assert.equal(
    h.locateTourIssue(tour.content, issue, identity).segmentId,
    "second-visit",
  );
  assert.equal(
    h.locateTourIssue(tour.content, { ...issue, stop_index: 0 }, identity),
    null,
  );
  assert.equal(
    h.locateTourIssue(tour.content, issue, { ...identity, revision: 4 }),
    null,
  );
  assert.equal(
    h.locateTourIssue(tour.content, { ...issue, stop_index: 50 }, identity),
    null,
  );
  assert.equal(
    h.locateTourIssue(
      tour.content,
      { ...issue, resource_type: "narration" },
      identity,
    ).step,
    3,
  );
  h.dispose();
});

test("truncated checks explicitly require complete preflight and review requires a server-listed action", async () => {
  const h = setup(() => ({
    ...batch,
    omitted_issue_count: 7,
    items: [{ ...issue, code: "DETAIL_CHECK_REQUIRED", actions: ["open"] }],
  }));
  const tree = await h.ready();
  assert.match(text(tree), /7 条检查未完整展示/);
  assert.match(text(tree), /必须打开此对象运行完整检查/);
  assert.equal(button(tree, "进入独立审核"), undefined);
  h.dispose();
});

test("resource and runtime targets use exact identities and the published version field", async () => {
  const h = setup((path) =>
    path.startsWith("/resources/")
      ? {
          id: "vr",
          kind: "panorama",
          draft: { revision: 3 },
          published_revision: 2,
        }
      : { id: "config", kind: "runtime", revision: 3, published_revision: 2 },
  );
  const vr = await h.readIssueTarget({
    ...issue,
    entity_id: "vr",
    entity_type: "vr",
  });
  assert.equal(vr.changed, false);
  assert.equal(vr.page, "resources");
  const runtime = await h.readIssueTarget({
    ...issue,
    entity_id: "config",
    entity_type: "configuration",
  });
  assert.equal(runtime.page, "guide-settings");
  h.dispose();
});
