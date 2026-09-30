import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { canAutoApply, NativeError } from "../src/features/agent/native.ts";
import { createVoiceConversation } from "../src/features/agent/voice.ts";
import {
  createBrowserSpeechFallback,
  createCloudSpeaker,
} from "../src/features/agent/cloudVoice.ts";
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
      ? tree.props?.className?.split(" ").includes("sr-only")
        ? ""
        : words(tree.props?.children)
      : tree == null || typeof tree === "boolean"
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
function harness({
  voiceEnvironment = {},
  sessionError,
  cloudFetch,
  createAudio,
} = {}) {
  const slots = [],
    cleanups = new Map(),
    pending = [],
    posts = [],
    actions = [],
    tabs = [],
    events = [],
    resourceReads = [],
    sessionReads = [];
  let index = 0,
    navigation = 0,
    cancelledActions = 0,
    resolver,
    response = reply,
    resourceResolver,
    blocked = false,
    catalogInvalidation,
    sessionResolver,
    voiceCallbacks;
  const visibilityListeners = new Set();
  const document = {
    visibilityState: "visible",
    addEventListener(type, callback) {
      if (type === "visibilitychange") visibilityListeners.add(callback);
    },
    removeEventListener(type, callback) {
      if (type === "visibilitychange") visibilityListeners.delete(callback);
    },
  };
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
    onAction: (action, options) => {
      actions.push({ ...action, options });
      return true;
    },
    onCancelAction: () => cancelledActions++,
    onNavigate: () => navigation++,
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    crypto: { randomUUID },
    document,
    window: browser,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name === "./Companion") return { Companion: "companion" };
      if (name === "./useCompanionPosition")
        return {
          useCompanionPosition: () => ({
            containerRef: { current: null },
            style: {},
            buttonProps: { onClickCapture: () => {} },
            resetPosition() {},
          }),
        };
      if (name.endsWith("/client"))
        return {
          get: async (path) => {
            sessionReads.push(path);
            if (sessionResolver) return sessionResolver();
            if (sessionError) throw sessionError;
            return { data: { csrf_token: "csrf" } };
          },
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
        return {
          createVoiceConversation(environment, callbacks) {
            voiceCallbacks = callbacks;
            return createVoiceConversation(environment, callbacks);
          },
          browserVoiceEnvironment: () => voiceEnvironment,
        };
      if (name === "./cloudVoice")
        return {
          createBrowserSpeechFallback,
          createCloudSpeaker: (options = {}) =>
            createCloudSpeaker({
              ...options,
              // Controlled clips exercise playback without reaching the network.
              fetchImpl:
                cloudFetch ??
                (async () => ({
                  ok: true,
                  blob: async () => new Blob([new Uint8Array(64)]),
                })),
              createAudio:
                createAudio ??
                (() => ({
                  src: "",
                  muted: false,
                  paused: true,
                  currentTime: 0,
                  play() {
                    this.paused = false;
                    queueMicrotask(() => {
                      this.onplaying?.();
                      this.onended?.();
                    });
                    return Promise.resolve();
                  },
                  pause() {},
                  load() {},
                  removeAttribute() {},
                })),
            }),
        };
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
            if (path === "/agent/login") return { csrf_token: "csrf" };
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
        (node.type === "button" || node.type === "companion") &&
        (node.props["aria-label"] === label ||
          node.props.label?.includes(label) ||
          words(node).includes(label)),
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
    sessionReads,
    get voiceCallbacks() {
      return voiceCallbacks;
    },
    browser,
    setSessionResolver(value) {
      sessionResolver = value;
    },
    setVisibility(value) {
      document.visibilityState = value;
      for (const listener of visibilityListeners) listener();
    },
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
    get cancelledActions() {
      return cancelledActions;
    },
    async open() {
      const minimized = find(
        render(),
        (node) => node.type === "companion" && node.props.label === "展开小开",
      )[0];
      minimized?.props.onClick();
      button("文字交流与记录").props.onClick();
      render();
      await settle();
      render();
      button("收起文字抽屉").props.onClick();
    },
    async ask(question = "从这里到图书馆怎么走") {
      if (!find(render(), (node) => node.type === "textarea").length)
        button("文字交流与记录").props.onClick();
      find(render(), (node) => node.type === "textarea")[0].props.onChange({
        target: { value: question },
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

test("navigation leaves the companion with short captions and reopening preserves conversation", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  h.button("前往图书馆").props.onClick();
  await settle();
  const caption = find(
    h.render(),
    (node) => node.props?.id === "native-agent-captions",
  )[0];
  assert.ok(caption);
  assert.equal(caption.props.role, "status");
  assert.equal(
    find(h.render(), (node) => node.props?.role === "dialog").length,
    0,
  );
  assert.match(words(caption), /已打开路线规划/);
  assert.equal(h.actions.length, 1);
  h.button("文字交流与记录").props.onClick();
  assert.match(words(h.render()), /从这里到图书馆怎么走/);
  h.button("收起小开并暂停语音").props.onClick();
  assert.equal(
    find(h.render(), (node) => node.props?.id === "native-agent-panel").length,
    0,
  );
  await h.open();
  h.button("文字交流与记录").props.onClick();
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
  assert.ok(find(h.render(), (node) => node.type === "companion").length);
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
  h.button("开启语音交流").props.onClick();
  assert.match(words(h.render()), /不支持语音识别/);
  h.button("文字交流与记录").props.onClick();
  h.button("地图选点导航").props.onClick();
  assert.equal(h.navigation, 1);
  assert.ok(find(h.render(), (node) => node.type === "companion").length);
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
  h.button("收起小开并暂停语音").props.onClick();
  h.render();
  complete();
  await settle();
  assert.equal(
    h.actions.length,
    1,
    "the explicitly requested action may complete",
  );
  assert.equal(
    find(h.render(), (node) => node.props?.id === "native-agent-panel").length,
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

test("legacy or suggested VR answers never create automatic popups", async () => {
  const h = await vrHarness();
  assert.equal(h.tabs.length, 0);
  assert.equal(h.resourceReads.length, 0);
  assert.equal(h.actions.length, 0);
  assert.equal(
    h.posts.some((post) => post.path === "/agent/actions/resolve"),
    false,
  );
  assert.ok(h.button("打开全景"));
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
  h.button("打开全景").props.onClick();
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
  assert.match(words(h.render()), /已请求在新标签页打开全景/);
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
  h.button("打开全景").props.onClick();
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
    h.button("打开全景").props.onClick();
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
  h.button("打开全景").props.onClick();
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
    h.button("打开全景").props.onClick();
    if (action === "unmount") h.unmount();
    else h.button("收起小开并暂停语音").props.onClick();
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
    h.button("打开全景").props.onClick();
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
  h.button("打开全景").props.onClick();
  await settle();
  assert.equal(find(h.render(), (node) => node.type === "a").length, 1);
  h.invalidateCatalog();
  assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
  assert.match(words(h.render()), /资料可能已更新/);
  h.button("文字交流与记录").props.onClick();
  assert.match(words(h.render()), /点击按钮在学校原网站查看全景/);
  h.button("打开全景").props.onClick();
  await settle();
  assert.equal(
    h.resourceReads.length,
    2,
    "recheck obtains a fresh published resource",
  );
  assert.equal(find(h.render(), (node) => node.type === "a").length, 1);
  h.unmount();
});

test("authenticated companion stays present with compact captions and optional text drawer", async () => {
  const h = harness();
  assert.equal(find(h.render(), (node) => node.type === "companion").length, 1);
  await h.open();
  assert.equal(
    find(h.render(), (node) => node.props?.id === "native-agent-panel").length,
    0,
  );
  assert.equal(words(h.render()), "");
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 0);
  h.button("文字交流与记录").props.onClick();
  assert.equal(
    find(h.render(), (node) => node.props?.role === "dialog").length,
    1,
  );
  h.button("收起文字抽屉").props.onClick();
  assert.equal(find(h.render(), (node) => node.type === "companion").length, 1);
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 0);
  h.unmount();
});

test("only one matching server-marked action executes automatically", async () => {
  for (const configuration of [
    { automatic_action_id: route.action_id, actions: [route], accepted: true },
    { actions: [route], accepted: false },
    { automatic_action_id: null, actions: [route], accepted: false },
    { automatic_action_id: "other", actions: [route], accepted: false },
    {
      automatic_action_id: route.action_id,
      actions: [route, { ...route, action_id: "other" }],
      accepted: false,
    },
  ]) {
    const h = harness();
    h.props.autoActions = true;
    h.setReply({ ...reply, ...configuration });
    await h.open();
    await h.ask();
    assert.equal(h.actions.length, configuration.accepted ? 1 : 0);
    if (configuration.accepted) {
      assert.equal(h.actions[0].type, "show_route");
      assert.match(words(h.render()), /已打开路线规划/);
      assert.equal(
        find(h.render(), (node) => node.props?.id === "native-agent-captions")
          .length,
        1,
      );
    }
    h.unmount();
  }
});

test("disabled automation and changed context prevent a marked action from starting", async () => {
  for (const kind of ["disabled", "context"]) {
    const h = harness();
    h.props.autoActions = kind !== "disabled";
    let finish;
    h.setReply(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await h.open();
    await h.ask();
    if (kind === "context") {
      h.props.current = { ...h.props.current, revision: 2 };
      h.render();
    }
    finish({ ...reply, automatic_action_id: route.action_id });
    await settle();
    assert.equal(h.actions.length, 0);
    assert.equal(
      h.posts.some((p) => p.path === "/agent/actions/resolve"),
      false,
    );
    h.unmount();
  }
});

test("an explicit VR command attempts a popup only after both checks and never changes the current page", async () => {
  for (const blocked of [false, true]) {
    const h = harness();
    h.props.autoActions = true;
    h.setBlocked(blocked);
    h.setReply({
      ...reply,
      actions: [vrAction],
      automatic_action_id: vrAction.action_id,
    });
    let finish;
    h.setResourceResolver(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const original = h.browser.location.href;
    await h.open();
    await h.ask("打开全景地图");
    assert.equal(h.resourceReads.length, 1);
    assert.equal(
      h.events.some((event) => event[0] === "open"),
      false,
    );
    finish({ data: [publishedVr] });
    await settle();
    assert.equal(h.events.filter((event) => event[0] === "open").length, 1);
    assert.equal(h.browser.location.href, original);
    assert.equal(h.actions.length, 0);
    if (blocked) {
      assert.match(words(h.render()), /全景未在新窗口打开/);
      assert.equal(
        find(h.render(), (node) => node.type === "a")[0].props.href,
        publishedVr.url,
      );
    } else {
      assert.equal(h.tabs[0].url, publishedVr.url);
      assert.equal(h.tabs[0].opener, null);
    }
    h.unmount();
  }
});

test("invalid explicit VR resources do not create even a temporary popup", async () => {
  const h = harness();
  h.props.autoActions = true;
  h.setReply({
    ...reply,
    actions: [vrAction],
    automatic_action_id: vrAction.action_id,
  });
  h.setResourceResolver(async () => ({
    data: [{ ...publishedVr, revision: 8 }],
  }));
  await h.open();
  await h.ask("打开全景地图");
  assert.equal(
    h.events.some((event) => event[0] === "open"),
    false,
  );
  assert.equal(find(h.render(), (node) => node.type === "a").length, 0);
  assert.match(words(h.render()), /全景资料已更新/);
  h.unmount();
});

test("only an explicitly marked video request passes one-shot playback consent to the app", async () => {
  const video = {
    ...route,
    type: "play_video",
    resource_id: "video",
    resource_revision: 2,
  };
  for (const explicit of [true, false]) {
    const h = harness();
    h.props.autoActions = true;
    h.setReply({
      ...reply,
      actions: [video],
      automatic_action_id: explicit ? video.action_id : null,
    });
    await h.open();
    await h.ask("播放校园视频");
    if (!explicit) {
      assert.equal(h.actions.length, 0);
      h.button("观看视频").props.onClick();
      await settle();
    }
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].options.requestedPlayback, explicit);
    h.button("收起小开并暂停语音").props.onClick();
    assert.equal(h.cancelledActions, 1);
    h.unmount();
  }
});

test("closing while an automatic action resolves cancels execution without reopening the companion", async () => {
  const h = harness();
  h.props.autoActions = true;
  h.setReply({ ...reply, automatic_action_id: route.action_id });
  let finish;
  h.setResolver(
    (body) =>
      new Promise((resolve) => {
        finish = () => resolve(body.action);
      }),
  );
  await h.open();
  await h.ask();
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.phase,
    "acting",
  );
  h.button("收起小开并暂停语音").props.onClick();
  finish();
  await settle();
  assert.equal(h.actions.length, 0);
  assert.equal(
    find(h.render(), (node) => node.props?.id === "native-agent-panel").length,
    0,
  );
  assert.equal(h.cancelledActions, 1);
  h.unmount();
});

test("app rejection and mismatched resolver results show failure instead of completion", async () => {
  for (const mismatch of [true, false]) {
    const h = harness();
    h.props.autoActions = true;
    h.setReply({ ...reply, automatic_action_id: route.action_id });
    h.props.onAction = () => false;
    if (mismatch)
      h.setResolver(async (body) => ({ ...body.action, type: "play_video" }));
    await h.open();
    await h.ask();
    assert.equal(h.actions.length, 0);
    assert.match(
      words(h.render()),
      mismatch ? /核验结果与请求不符/ : /地点资料已变化/,
    );
    assert.doesNotMatch(words(h.render()), /已打开路线规划/);
    h.unmount();
  }
});

test("an aborted automatic request does not turn a deliberately closed companion into an error", async () => {
  const h = harness();
  h.props.autoActions = true;
  h.setReply({ ...reply, automatic_action_id: route.action_id });
  let reject;
  h.setResolver(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await h.open();
  await h.ask();
  h.button("收起小开并暂停语音").props.onClick();
  reject(new Error("请求已中止"));
  await settle();
  assert.equal(h.actions.length, 0);
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.phase,
    "idle",
  );
  await h.open();
  assert.doesNotMatch(words(h.render()), /请求已中止/);
  h.unmount();
});

test("closing and reopening while chat waits cannot revive the old automatic command", async () => {
  for (const action of [
    route,
    vrAction,
    { ...route, type: "play_video", resource_id: "video" },
  ]) {
    const h = harness();
    h.props.autoActions = true;
    let finish;
    h.setReply(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    h.setResourceResolver(async () => ({ data: [publishedVr] }));
    await h.open();
    await h.ask();
    h.button("收起小开并暂停语音").props.onClick();
    await h.open();
    finish({
      ...reply,
      actions: [action],
      automatic_action_id: action.action_id,
    });
    await settle();
    assert.equal(h.actions.length, 0);
    assert.equal(h.tabs.length, 0);
    assert.equal(h.resourceReads.length, 0);
    assert.equal(
      h.posts.some((post) => post.path === "/agent/actions/resolve"),
      false,
    );
    assert.match(words(h.render()), /已经找到可用路线/);
    assert.equal(h.cancelledActions, 1);
    h.unmount();
  }
});

function browserMic() {
  let starts = 0,
    aborts = 0;
  const recognition = {
    start() {
      starts++;
    },
    abort() {
      aborts++;
    },
  };
  return {
    environment: { recognize: () => recognition },
    recognition,
    get starts() {
      return starts;
    },
    get aborts() {
      return aborts;
    },
  };
}

test("resting fairy has only icon controls, no unsolicited session request, login, or microphone", () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  const tree = h.render();
  assert.equal(h.sessionReads.length, 0);
  assert.equal(mic.starts, 0);
  assert.equal(words(tree), "");
  assert.equal(
    find(
      tree,
      (node) =>
        node.type === "textarea" ||
        node.type === "input" ||
        node.props?.role === "dialog",
    ).length,
    0,
  );
  for (const label of [
    "开启语音交流",
    "文字交流与记录",
    "收起小开并暂停语音",
  ]) {
    const control = h.button(label);
    assert.equal(words(control), "");
    assert.ok(control.props["aria-label"] || control.props.label);
  }
  const fairy = find(tree, (node) => node.type === "companion")[0];
  assert.equal(typeof fairy.props.buttonProps.onClickCapture, "function");
  h.unmount();
});

test("an explicit fairy tap restores the session and starts voice without opening typing", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  find(h.render(), (node) => node.type === "companion")[0].props.onClick();
  h.render();
  await settle();
  assert.equal(h.sessionReads.length, 1);
  assert.equal(mic.starts, 1);
  assert.equal(
    find(
      h.render(),
      (node) => node.type === "textarea" || node.props?.role === "dialog",
    ).length,
    0,
  );
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.phase,
    "listening",
  );
  h.button("暂停语音交流").props.onClick();
  assert.equal(mic.aborts, 1);
  h.unmount();
});

test("typing is opt-in and never starts the microphone", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  h.button("文字交流与记录").props.onClick();
  h.render();
  await settle();
  assert.equal(mic.starts, 0);
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 1);
  h.button("收起文字抽屉").props.onClick();
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 0);
  assert.equal(words(h.render()), "");
  h.unmount();
});

test("authentication appears only after requesting voice and login resumes that request", async () => {
  const mic = browserMic();
  const h = harness({
    voiceEnvironment: mic.environment,
    sessionError: new NativeError("需要口令", 401),
  });
  assert.equal(find(h.render(), (node) => node.type === "input").length, 0);
  h.button("开启语音交流").props.onClick();
  h.render();
  await settle();
  assert.equal(mic.starts, 0);
  const input = find(h.render(), (node) => node.type === "input")[0];
  assert.equal(input.props.type, "password");
  input.props.onChange({ target: { value: "test-access-code-for-ui" } });
  find(
    h.render(),
    (node) => node.type === "form" && node.props.className === "native-login",
  )[0].props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(mic.starts, 1);
  assert.equal(
    find(
      h.render(),
      (node) => node.type === "input" || node.type === "textarea",
    ).length,
    0,
  );
  h.unmount();
});

test("closing during session restore cannot start a microphone from a stale success", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  let finish;
  h.setSessionResolver(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.button("开启语音交流").props.onClick();
  h.render();
  h.button("收起小开并暂停语音").props.onClick();
  h.render();
  finish({ data: { csrf_token: "csrf" } });
  await settle();
  assert.equal(mic.starts, 0);
  assert.equal(
    find(h.render(), (node) => node.props?.role === "dialog").length,
    0,
  );
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.label,
    "展开小开",
  );
  h.unmount();
});

test("a backgrounded page does not start voice when a requested session finishes", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  let finish;
  h.setSessionResolver(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.button("开启语音交流").props.onClick();
  h.render();
  h.setVisibility("hidden");
  finish({ data: { csrf_token: "csrf" } });
  await settle();
  assert.equal(mic.starts, 0);
  assert.match(words(h.render()), /页面已切到后台/);
  h.setVisibility("visible");
  assert.equal(mic.starts, 0);
  h.unmount();
});

test("expired restored session stops the active recognizer before showing authentication", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  await h.open();
  h.button("收起小开并暂停语音").props.onClick();
  h.render();
  let fail;
  h.setSessionResolver(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  find(h.render(), (node) => node.type === "companion")[0].props.onClick();
  h.button("开启语音交流").props.onClick();
  h.render();
  assert.equal(mic.starts, 1);
  fail(new NativeError("会话过期", 401));
  await settle();
  assert.equal(mic.aborts, 1);
  assert.equal(
    find(h.render(), (node) => node.type === "input")[0].props.type,
    "password",
  );
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.phase,
    "idle",
  );
  h.unmount();
});

test("speech captions follow actual callbacks, recognized speech takes precedence and source actions stay in drawer", async () => {
  const h = harness();
  await h.open();
  await h.ask();
  h.button("收起文字抽屉").props.onClick();
  h.voiceCallbacks.onPhase("speaking");
  h.voiceCallbacks.onCaption("正在朗读的第二句。");
  assert.equal(
    words(
      find(h.render(), (node) => node.props?.id === "native-agent-captions")[0],
    ),
    "正在朗读的第二句。",
  );
  h.voiceCallbacks.onTranscript("用户当前说的话");
  assert.equal(
    words(
      find(h.render(), (node) => node.props?.id === "native-agent-captions")[0],
    ),
    "用户当前说的话",
  );
  assert.equal(
    find(
      h.render(),
      (node) => node.type === "button" && words(node).includes("前往图书馆"),
    ).length,
    0,
  );
  h.button("文字交流与记录").props.onClick();
  assert.ok(h.button("前往图书馆"));
  assert.match(words(h.render()), /已经找到可用路线/);
  h.unmount();
});

test("minimize pauses voice and expanding the small fairy does not restart it", async () => {
  const mic = browserMic();
  const h = harness({ voiceEnvironment: mic.environment });
  h.button("开启语音交流").props.onClick();
  h.render();
  await settle();
  h.button("收起小开并暂停语音").props.onClick();
  assert.equal(mic.aborts, 1);
  assert.equal(words(h.render()), "");
  find(h.render(), (node) => node.type === "companion")[0].props.onClick();
  assert.equal(mic.starts, 1);
  assert.equal(find(h.render(), (node) => node.type === "textarea").length, 0);
  h.unmount();
});

function cloudPlayer() {
  const players = [];
  let blocked = false;
  return {
    players,
    setBlocked(value) {
      blocked = value;
    },
    create() {
      const player = {
        src: "",
        muted: false,
        paused: true,
        currentTime: 0,
        played: 0,
        onplaying: null,
        onended: null,
        onerror: null,
        pause() {
          this.paused = true;
        },
        load() {},
        removeAttribute() {
          this.src = "";
        },
        play() {
          this.played++;
          if (blocked)
            return Promise.reject(
              new DOMException("blocked", "NotAllowedError"),
            );
          this.paused = false;
          queueMicrotask(() => this.onplaying?.());
          return Promise.resolve();
        },
      };
      players.push(player);
      return player;
    },
  };
}

test("actual dock microphone path requests cloud speech once and resumes after audio ends", async () => {
  const clips = [],
    mics = [],
    player = cloudPlayer();
  const h = harness({
    voiceEnvironment: {
      recognize() {
        const mic = { start() {}, abort() {} };
        mics.push(mic);
        return mic;
      },
    },
    createAudio: player.create,
    cloudFetch: async (_url, init) => {
      clips.push(JSON.parse(init.body).text);
      return { ok: true, blob: async () => new Blob([new Uint8Array(64)]) };
    },
  });
  await h.open();
  h.button("开启语音交流").props.onClick();
  h.render();
  mics[0].onresult({
    results: [{ isFinal: true, 0: { transcript: "介绍图书馆" } }],
  });
  await settle();
  h.render();
  assert.deepEqual(clips, [reply.answer]);
  assert.equal(mics.length, 1);
  assert.equal(
    find(h.render(), (node) => node.type === "companion")[0].props.phase,
    "speaking",
  );
  player.players[0].onended();
  await settle();
  h.render();
  assert.equal(mics.length, 2);
  assert.equal(clips.length, 1, "no duplicate announcement");
  h.unmount();
});
test("autoplay recovery notice outranks answer captions and play icon resumes without a new TTS call", async () => {
  const player = cloudPlayer();
  player.setBlocked(true);
  let requests = 0;
  const h = harness({
    createAudio: player.create,
    cloudFetch: async () => {
      requests++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(64)]) };
    },
  });
  await h.open();
  await h.ask();
  await settle();
  h.button("收起文字抽屉").props.onClick();
  const captions = find(
    h.render(),
    (node) => node.props?.id === "native-agent-captions",
  )[0];
  assert.match(words(captions), /浏览器已拦截.*播放图标/);
  const before = player.players[0].played;
  player.setBlocked(false);
  h.button("播放回答").props.onClick();
  assert.equal(player.players[0].played, before + 1);
  await settle();
  assert.equal(requests, 1);
  player.players[0].onended();
  await settle();
  h.unmount();
});
test("system synthesis absence is visible instead of hidden behind the answer", async () => {
  const h = harness({ cloudFetch: async () => ({ ok: false }) });
  await h.open();
  await h.ask();
  await settle();
  assert.match(words(h.render()), /回答未能播放/);
  h.button("收起文字抽屉").props.onClick();
  assert.match(
    words(
      find(h.render(), (node) => node.props?.id === "native-agent-captions")[0],
    ),
    /未能播放/,
  );
  assert.ok(h.button("播放回答"));
  h.unmount();
});
test("background, close and mute abort pending typed speech; late audio cannot play", async () => {
  for (const action of ["background", "close", "mute"]) {
    let complete, signal;
    const player = cloudPlayer(),
      h = harness({
        createAudio: player.create,
        cloudFetch: (_url, init) => {
          signal = init.signal;
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
      });
    await h.open();
    await h.ask();
    await settle();
    if (action === "background") h.setVisibility("hidden");
    else if (action === "close") h.button("收起小开并暂停语音").props.onClick();
    else h.button("关闭回答播报").props.onClick();
    assert.equal(signal.aborted, true);
    const before = player.players.reduce(
      (total, item) => total + item.played,
      0,
    );
    complete({ ok: true, blob: async () => new Blob([new Uint8Array(64)]) });
    await settle();
    assert.equal(
      player.players.reduce((total, item) => total + item.played, 0),
      before,
    );
    h.unmount();
  }
});
