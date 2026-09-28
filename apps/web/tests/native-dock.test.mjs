import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { canAutoApply, NativeError } from "../src/features/agent/native.ts";
import { createVoiceConversation } from "../src/features/agent/voice.ts";

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
    actions = [];
  let index = 0,
    navigation = 0,
    resolver;
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
    window: { confirm: () => true },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/Icon")) return { Icon: () => null };
      if (name.endsWith("/client"))
        return { get: async () => ({ data: { csrf_token: "csrf" } }) };
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
            if (path === "/agent/chat") return reply;
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
