import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
const exports = {};
const source = readFileSync(
  new URL("../src/features/admin/RoadWorkspace.tsx", import.meta.url),
  "utf8",
);
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText,
  {
    exports,
    require(name) {
      return name === "react/jsx-runtime" ? jsx : {};
    },
  },
);
const find = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((node) => find(node, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...find(tree.props?.children, predicate),
  ];
};
const textOf = (tree) =>
  Array.isArray(tree)
    ? tree.map(textOf).join("")
    : tree && typeof tree === "object"
      ? textOf(tree.props?.children)
      : String(tree ?? "");
function setup(overrides = {}) {
  const calls = [];
  const props = {
    mode: "select",
    editable: true,
    busy: false,
    dirty: true,
    canUndo: true,
    canRedo: true,
    sketchCount: 0,
    onMode: (mode) => calls.push(mode),
    onSave: () => calls.push("save"),
    onUndo: () => calls.push("undo"),
    onRedo: () => calls.push("redo"),
    onFinish: () => calls.push("finish"),
    onCancel: () => calls.push("cancel"),
    onCheck: () => calls.push("check"),
    children: jsx.jsx("button", { children: "导出草稿备份" }),
    ...overrides,
  };
  const tree = exports.RoadDrawingTools(props);
  const button = (label) =>
    find(tree, (node) => node.type === "button" && textOf(node) === label)[0];
  return { tree, button, calls };
}
test("advanced drawing and backup are collapsed while save and validation remain direct", () => {
  const h = setup();
  const details = find(h.tree, (node) => node.type === "details")[0];
  assert.equal(Boolean(details.props.open), false);
  assert.match(renderToStaticMarkup(details), /绘制弧线/);
  assert.match(renderToStaticMarkup(details), /导出草稿备份/);
  assert.equal(
    find(
      details,
      (node) => node.type === "button" && textOf(node) === "保存草稿",
    ).length,
    0,
  );
  h.button("保存草稿").props.onClick();
  h.button("检查连通与缺口").props.onClick();
  h.button("绘制弧线").props.onClick();
  assert.deepEqual(h.calls, ["save", "check", "curve"]);
  assert.equal(h.button("完成道路"), undefined);
  assert.equal(h.button("取消绘制"), undefined);
});
test("unfinished sketches expose cancellation and prevent saving or validating partial geometry", () => {
  const h = setup({ mode: "road", sketchCount: 1 });
  assert.equal(h.button("保存草稿").props.disabled, true);
  assert.equal(h.button("检查连通与缺口").props.disabled, true);
  assert.equal(h.button("完成道路").props.disabled, true);
  h.button("取消绘制").props.onClick();
  assert.deepEqual(h.calls, ["cancel"]);
  const ready = setup({ mode: "road", sketchCount: 2 });
  assert.equal(ready.button("完成道路").props.disabled, false);
  ready.button("完成道路").props.onClick();
  assert.deepEqual(ready.calls, ["finish"]);
  const curve = setup({ mode: "curve", sketchCount: 1 });
  assert.equal(curve.button("完成道路"), undefined);
  assert.ok(curve.button("取消绘制"));
  assert.match(renderToStaticMarkup(curve.tree), /当前：绘制弧线/);
});
test("read-only review keeps inspection available while edit tools stay disabled", () => {
  const h = setup({ editable: false, dirty: false });
  assert.equal(h.button("选择 / 拖动").props.disabled, false);
  assert.equal(h.button("检查连通与缺口").props.disabled, false);
  for (const label of [
    "添加路口或入口",
    "沿道路连续绘制",
    "绘制弧线",
    "自由描线",
    "拆分路口",
    "保存草稿",
    "撤销",
    "重做",
  ])
    assert.equal(h.button(label).props.disabled, true, label);
});
