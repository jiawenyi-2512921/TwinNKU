import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { canAutoApply, NativeError } from "../src/features/agent/native.ts";
import { createVoiceConversation } from "../src/features/agent/voice.ts";
import { externalPanoramaUrl } from "../src/features/points/panorama.ts";

// Controlled React hooks check the component's actual event handlers and state,
// not browser layout, microphone permissions or a live school model response.
const compiled = ts.transpileModule(
  readFileSync(
    new URL("../src/features/agent/NativeAgentDock.tsx", import.meta.url),
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
const find = (tree, condition) =>
  Array.isArray(tree)
    ? tree.flatMap((node) => find(node, condition))
    : !tree || typeof tree !== "object"
      ? []
      : [
          ...(condition(tree) ? [tree] : []),
          ...find(tree.props?.children, condition),
        ];
const words = (tree) =>
  Array.isArray(tree)
    ? tree.map(words).join("")
    : tree && typeof tree === "object"
      ? words(tree.props?.children)
      : tree == null
        ? ""
        : String(tree);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const route = {
  action_id: "action-1",
  type: "show_route",
  point_id: "point-2",
  point_revision: 3,
  context_revision: 1,
  label: "前往图书馆",
};
const reply = {
  answer: "已经找到可用路线。",
  context_revision: 1,
  actions: [route],
  materials: [
    {
      point_id: "point-2",
      revision: 3,
      label: "图书馆资料",
      kind: "focus_point",
    },
  ],
  notices: [],
};
function harness() {
  const slots = [],
    cleanups = new Map(),
    pending = [],
    posts = [],
    actions = [],
    tabs = [],
    events = [],
    resourceReads = [];
  let index = 0,
    navigation = 0,
    resolver,
    response = reply,
    resourceResolver,
    blocked = false,
    catalogInvalidation;
  const browser = {
    confirm: () => true,
    location: { href: "https://guide.test/?point=point-1&experience=tour-1" },
    open(url, target) {
      events.push(["open", url, target]);
      if (blocked) return null;
      const tab = {
        opener: {},
        closed: false,
        document: { title: "", body: { textContent: "" } },
        location: {
          replace(url) {
            events.push(["navigate", url]);
            tab.url = url;
          },
        },
        close() {
          events.push(["close"]);
          this.closed = true;
        },
      };
      tabs.push(tab);
      return tab;
    },
  };
  const react = {
    useState(initial) {
      const key = index++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (value) => {
          slots[key] = typeof value === "function" ? value(slots[key]) : value;
        },
      ];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(effect, deps) {
      const key = index++;
      if (
        !slots[key] ||
        deps.some((value, position) => value !== slots[key][position])
      ) {
        slots[key] = deps;
        pending.push(() => {
          cleanups.get(key)?.();
          cleanups.set(key, effect());
        });
      }
    },
  };
  const props = {
    current: {
      map_id: "map",
      map_revision: 1,
      campus_id: "jinnan",
      revision: 1,
    },
    request: null,
    pointName: "图书馆",
    autoActions: false,
    onAction: (action) => actions.push(action),
    onNavigate: () => navigation++,
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    crypto: { randomUUID },
    document: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
    window: browser,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name.endsWith("/client"))
        return {
          get: async () => ({ data: { csrf_token: "csrf" } }),
          api: {
            async panoramas(pointId, signal) {
              resourceReads.push({ pointId, signal });
              events.push(["read", pointId]);
              return resourceResolver
                ? resourceResolver(pointId, signal)
                : { data: [] };
            },
          },
        };
      if (name === "../points/panorama") return { externalPanoramaUrl };
      if (name === "../../shared/catalogSync")
        return {
          watchCatalogChanges(callback) {
            catalogInvalidation = callback;
            return () => {
              catalogInvalidation = null;
            };
          },
        };
      if (name === "./protocol")
        return { contextQuestion: () => "介绍当前地点" };
      if (name === "./voice")
        return { createVoiceConversation, browserVoiceEnvironment: () => ({}) };
      if (name === "./native.css") return {};
      if (name === "./native")
        return {
          canAutoApply,
          NativeError,
          async post(path, body) {
            posts.push({ path, body });
            events.push(["post", path]);
            if (path === "/agent/chat") return response;
            if (path === "/agent/actions/resolve")
              return resolver ? resolver(body) : body.action;
            throw new Error(path);
          },
        };
      throw new Error(name);
    },
  });
  function render() {
    index = 0;
    const tree = exports.NativeAgentDock(props);
    while (pending.length) pending.shift()();
    return tree;
  }
  function button(label) {
    const result = find(
      render(),
      (node) =>
        node.type === "button" &&
        (node.props["aria-label"] === label || words(node).includes(label)),
    );
    assert.ok(result.length, `button ${label}`);
    return result[0];
  }
  return {
    render,
    button,
    props,
    posts,
    actions,
    tabs,
    events,
    resourceReads,
    browser,
    setReply(value) {
      response = value;
    },
    setResourceResolver(value) {
      resourceResolver = value;
    },
    setBlocked(value) {
      blocked = value;
    },
    invalidateCatalog() {
      catalogInvalidation?.();
    },
    setResolver(value) {
      resolver = value;
    },
    get navigation() {
      return navigation;
    },
    async open() {
      button("问小开").props.onClick();
      render();
      await settle();
      render();
    },
    async ask() {
      button("文字交流与记录").props.onClick();
      find(render(), (node) => node.type === "textarea")[0].props.onChange({
        target: { value: "从这里到图书馆怎么走" },
      });
      find(
        render(),
        (node) =>
          node.type === "form" && node.props.className === "native-composer",
      )[0].props.onSubmit({ preventDefault() {} });
      await settle();
    },
    unmount() {
      for (const cleanup of cleanups.values()) cleanup?.();
    },
  };
}

test("navigation shrinks to a nonmodal voice card and reopening preserves conversation", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  h.button("前往图书馆").props.onClick();
  await settle();
  let dialog = find(h.render(), (node) => node.props?.role === "dialog")[0];
  assert.ok(dialog);
  assert.equal(dialog.props["aria-modal"], "false");
  assert.equal(dialog.props.className.includes("is-expanded"), false);
  assert.match(words(dialog), /已经找到可用路线/);
  assert.equal(h.actions.length, 1);
  h.button("文字交流与记录").props.onClick();
  assert.match(words(h.render()), /从这里到图书馆怎么走/);
  h.button("关闭浮窗并暂停语音").props.onClick();
  assert.equal(
    find(h.render(), (node) => node.props?.role === "dialog").length,
    0,
  );
  await h.open();
  assert.match(words(h.render()), /已经找到可用路线/);
  h.unmount();
});

test("material selection resolves an internal action without a full page link", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
  h.button("图书馆资料").props.onClick();
  await settle();
  const request = h.posts.at(-1);
  assert.equal(request.path, "/agent/actions/resolve");
  assert.equal(request.body.action.type, "focus_point");
  assert.equal(request.body.action.point_revision, 3);
  assert.equal(h.actions[0].point_id, "point-2");
  assert.ok(find(h.render(), (node) => node.props?.role === "dialog").length);
  h.unmount();
});

test("context changing while an action resolves cannot move the newly selected map", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  let complete;
  h.setResolver(
    (body) =>
      new Promise((resolve) => {
        complete = () => resolve(body.action);
      }),
  );
  h.button("前往图书馆").props.onClick();
  h.props.current = {
    ...h.props.current,
    revision: 2,
    point_id: "other-point",
  };
  h.render();
  complete();
  await settle();
  assert.equal(h.actions.length, 0);
  assert.match(words(h.render()), /你已切换地点/);
  h.unmount();
});

test("map navigation remains available beside unsupported voice with typed fallback", async () => {
  const h = harness();
  await h.open();
  assert.match(words(h.render()), /不支持语音识别/);
  assert.equal(h.button("开启语音交流").props.disabled, true);
  h.button("地图选点导航").props.onClick();
  assert.equal(h.navigation, 1);
  assert.ok(find(h.render(), (node) => node.props?.role === "dialog").length);
  h.button("文字交流与记录").props.onClick();
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 1);
  h.unmount();
});

test("closing during a selected action does not reopen the floating card on completion", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  let complete;
  h.setResolver(
    (body) =>
      new Promise((resolve) => {
        complete = () => resolve(body.action);
      }),
  );
  h.button("前往图书馆").props.onClick();
  h.button("关闭浮窗并暂停语音").props.onClick();
  h.render();
  complete();
  await settle();
  assert.equal(
    h.actions.length,
    1,
    "the explicitly requested action may complete",
  );
  assert.equal(
    find(h.render(), (node) => node.props?.role === "dialog").length,
    0,
  );
  h.unmount();
});

const publishedVr = {
  id: "panorama-1",
  point_id: "point-2",
  revision: 7,
  title: "学校全景",
  url: "https://stjgpt.nankai.edu.cn/index-jn.php#scene_4744/0.0/-10.2/120.0",
};
const vrAction = {
  ...route,
  type: "open_vr",
  label: "校园全景",
  resource_id: "panorama-1",
  resource_revision: 7,
  url: "https://untrusted-model.example/ignore-me",
};
async function vrHarness() {
  const h = harness();
  h.props.autoActions = true;
  h.setReply({
    ...reply,
    answer: "点击按钮在学校原网站查看全景。",
    actions: [vrAction],
  });
  h.setResourceResolver(async () => ({ data: [publishedVr] }));
  await h.open();
  await h.ask();
  return h;
}

test("VR answers never create automatic popups, even when automatic map actions are enabled", async () => {
  const h = await vrHarness();
  assert.equal(h.tabs.length, 0);
  assert.equal(h.resourceReads.length, 0);
  assert.equal(h.actions.length, 0);
  assert.equal(
    h.posts.some((post) => post.path === "/agent/actions/resolve"),
    false,
  );
  assert.ok(h.button("原网站打开全景"));
  h.unmount();
});

test("one explicit VR click reserves a detached tab before awaits and opens only the checked published URL", async () => {
  const h = await vrHarness();
  let complete;
  h.setResolver(
    (body) =>
      new Promise((resolve) => {
        complete = () => resolve(body.action);
      }),
  );
  const before = h.browser.location.href;
  const eventIndex = h.events.length;
  h.button("原网站打开全景").props.onClick();
  assert.deepEqual(h.events[eventIndex], ["open", "about:blank", "_blank"]);
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].opener, null);
  assert.equal(h.tabs[0].url, undefined);
  assert.equal(h.resourceReads.length, 0);
  complete();
  await settle();
  assert.equal(h.resourceReads[0].pointId, "point-2");
  assert.equal(
    h.tabs[0].url,
    publishedVr.url,
    "model/action url must not be used",
  );
  assert.equal(h.tabs[0].closed, false);
  assert.equal(h.actions.length, 0, "VR never triggers internal navigation");
  assert.equal(
    h.browser.location.href,
    before,
    "existing map/tour selection survives",
  );
  assert.match(words(h.render()), /点击按钮在学校原网站查看全景/);
  h.unmount();
  assert.equal(
    h.tabs[0].closed,
    false,
    "successful external tab is no longer owned by the pending request",
  );
});

test("blocked popup yields a verified explicit link and hides that fallback on context change", async () => {
  const h = await vrHarness();
  h.setBlocked(true);
  h.button("原网站打开全景").props.onClick();
  await settle();
  assert.equal(h.tabs.length, 0);
  const link = find(h.render(), (node) => node.type === "a")[0];
  assert.equal(link.props.href, publishedVr.url);
  assert.equal(link.props.target, "_blank");
  assert.equal(link.props.rel, "noopener noreferrer");
  assert.equal(h.actions.length, 0);
  h.props.current = { ...h.props.current, revision: 2 };
  assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
  h.unmount();
});

test("changed, retired, foreign and unsafe public VR resources close the blank tab without navigating", async () => {
  for (const rows of [
    [],
    [{ ...publishedVr, revision: 8 }],
    [{ ...publishedVr, point_id: "other" }],
    [{ ...publishedVr, id: "other" }],
    [{ ...publishedVr, url: "javascript:alert(1)" }],
  ]) {
    const h = await vrHarness();
    h.setResourceResolver(async () => ({ data: rows }));
    h.button("原网站打开全景").props.onClick();
    await settle();
    assert.equal(h.tabs[0].closed, true);
    assert.equal(h.tabs[0].url, undefined);
    assert.equal(h.actions.length, 0);
    assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
    assert.match(words(h.render()), /全景资料已更新、下架或链接不可用/);
    h.unmount();
  }
});

test("context changing during the public resource read closes the reserved tab", async () => {
  const h = await vrHarness();
  let complete;
  h.setResourceResolver(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ data: [publishedVr] });
      }),
  );
  h.button("原网站打开全景").props.onClick();
  await settle();
  h.props.current = { ...h.props.current, revision: 2, point_id: "new-point" };
  h.render();
  complete();
  await settle();
  assert.equal(h.tabs[0].closed, true);
  assert.equal(h.tabs[0].url, undefined);
  assert.match(words(h.render()), /你已切换地点/);
  h.unmount();
});

test("unmount and explicit floating-card close immediately dispose a pending blank VR tab", async () => {
  for (const action of ["unmount", "close"]) {
    const h = await vrHarness();
    let complete;
    h.setResolver(
      (body) =>
        new Promise((resolve) => {
          complete = () => resolve(body.action);
        }),
    );
    h.button("原网站打开全景").props.onClick();
    if (action === "unmount") h.unmount();
    else h.button("关闭浮窗并暂停语音").props.onClick();
    assert.equal(h.tabs[0].closed, true);
    complete();
    await settle();
    assert.equal(h.tabs[0].url, undefined);
    assert.equal(h.resourceReads.length, 0);
    if (action === "close") h.unmount();
  }
});

test("authentication and network failures close pending VR tabs without offering unchecked links", async () => {
  for (const kind of ["auth", "network"]) {
    const h = await vrHarness();
    if (kind === "auth")
      h.setResolver(async () => {
        throw new NativeError("请重新连接", 401);
      });
    else
      h.setResourceResolver(async () => {
        throw new Error("网络不可用");
      });
    h.button("原网站打开全景").props.onClick();
    await settle();
    assert.equal(h.tabs[0].closed, true);
    assert.equal(h.tabs[0].url, undefined);
    assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
    assert.equal(h.actions.length, 0);
    h.unmount();
  }
});

test("publication or resume invalidates blocked-popup fallback while preserving conversation and recheck button", async () => {
  const h = await vrHarness();
  h.setBlocked(true);
  h.button("原网站打开全景").props.onClick();
  await settle();
  assert.equal(find(h.render(), (node) => node.type === "a").length, 1);
  h.invalidateCatalog();
  assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
  assert.match(words(h.render()), /点击按钮在学校原网站查看全景/);
  assert.match(words(h.render()), /资料可能已更新/);
  h.button("原网站打开全景").props.onClick();
  await settle();
  assert.equal(
    h.resourceReads.length,
    2,
    "recheck obtains a fresh published resource",
  );
  assert.equal(find(h.render(), (node) => node.type === "a").length, 1);
  h.unmount();
});
