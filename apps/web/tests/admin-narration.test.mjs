import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
const code = ts.transpileModule(
  readFileSync(
    new URL("../src/features/admin/NarrationStudio.tsx", import.meta.url),
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
const operationExports = {};
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL("../src/features/admin/confirmedOperation.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { exports: operationExports },
);
const find = (tree, predicate) =>
  Array.isArray(tree)
    ? tree.flatMap((t) => find(t, predicate))
    : tree && typeof tree === "object"
      ? [
          ...(predicate(tree) ? [tree] : []),
          ...find(tree.props?.children, predicate),
        ]
      : [];
const text = (value) =>
  Array.isArray(value)
    ? value.map(text).join("")
    : value && typeof value === "object"
      ? text(value.props?.children)
      : typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";
const button = (tree, label) =>
  find(tree, (n) => n.type === "button" && text(n) === label)[0];
const asset = "11111111-1111-4111-8111-111111111111";
const tour = {
  kind: "tour",
  title: "测试路线",
  description: "",
  source_note: "测试夹具",
  campus_id: "test-campus",
  lead: "",
  outcomes: [],
  narration_mode: "recorded",
  sort_order: 0,
  stops: [
    {
      point_id: "test-point",
      narrative: "",
      prompt_timing: "manual",
      legacy_media_compat: false,
      segments: [
        {
          id: "segment-one",
          text: "测试讲稿",
          source_note: "测试来源",
          main_view: { type: "map" },
          resources: [],
        },
      ],
    },
  ],
};
async function sha(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function harness(options = {}) {
  const slots = [],
    effects = [],
    calls = [],
    leases = [];
  let cursor = 0,
    effectCursor = 0;
  const react = {
    useState(initial) {
      const key = cursor++;
      if (!(key in slots))
        slots[key] = typeof initial === "function" ? initial() : initial;
      return [
        slots[key],
        (v) => (slots[key] = typeof v === "function" ? v(slots[key]) : v),
      ];
    },
    useRef(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(callback, deps) {
      const key = effectCursor++,
        old = effects[key];
      if (!old || deps.some((v, i) => v !== old.deps[i]))
        effects[key] = { callback, deps, pending: true, cleanup: old?.cleanup };
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    crypto,
    TextEncoder,
    URLSearchParams,
    setTimeout: (fn, delay) => {
      const t = setTimeout(fn, delay);
      t.unref();
      return t;
    },
    clearTimeout,
    document: { visibilityState: "visible" },
    window: { confirm: () => options.confirm ?? true },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return jsx;
      if (name.endsWith("/audioOwner"))
        return {
          acquireAudio: () => {
            leases.push("play");
            return leases.length;
          },
          releaseAudio: (_owner, lease) => leases.push(lease),
        };
      if (name.endsWith("/segments"))
        return {
          normalizeSegment: (s) => ({
            main_view: { type: "map" },
            resources: [],
            ...s,
          }),
        };
      if (name === "./api")
        return {
          message: (e) => e.message,
          request: async (...args) => {
            calls.push(args);
            return options.request
              ? options.request(...args)
              : { data: options.manifest };
          },
        };
      if (name === "./confirmedOperation") return operationExports;
      if (name === "./ui")
        return {
          ErrorBox: () => null,
          useResource: (path) => ({
            data: {
              data:
                path === "/narration-profiles"
                  ? [
                      {
                        id: "standard",
                        available: options.available ?? true,
                        title: "测试配置",
                        max_characters_per_chunk: 200,
                        staff_requests_per_hour: 8,
                        staff_requests_per_day: 40,
                      },
                    ]
                  : (options.jobs ?? [
                      {
                        id: "job",
                        tour_id: "tour",
                        segment_id: "segment-one",
                        state: "ready",
                        asset_id: asset,
                        source_revision: 4,
                        completed_chunks: 2,
                        total_chunks: 2,
                        characters: 4,
                      },
                    ]),
            },
            error: "",
          }),
        };
      throw new Error(name);
    },
  });
  const props = {
    content: structuredClone(tour),
    tourId: "tour",
    revision: 4,
    dirty: false,
    editable: true,
    onSave: async () => true,
    onChange: (next) => {
      props.content = next;
    },
  };
  return {
    exports,
    calls,
    leases,
    props,
    render() {
      cursor = 0;
      effectCursor = 0;
      return exports.NarrationStudio(props);
    },
    effects() {
      for (const e of [...effects])
        if (e.pending) {
          e.pending = false;
          e.cleanup?.();
          e.cleanup = e.callback();
        }
    },
  };
}
async function manifest() {
  return {
    asset_id: asset,
    manifest_id: "test-manifest",
    text_sha256: await sha("测试讲稿"),
    chunks: ["part-1", "part-2"].map((chunk_id) => ({
      chunk_id,
      text: "测试讲稿",
      duration_seconds: 1,
      byte_size: 44,
      sha256: "a".repeat(64),
      url: `/api/v1/admin/narration-assets/${asset}/chunks/${chunk_id}`,
    })),
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function auditionReady(h) {
  for (let i = 0; i < 60; i++) {
    const tree = h.render();
    if (find(tree, (n) => n.type === "audio").length) return tree;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("private audition did not reach a validated audio manifest");
}
test("opening an audio studio makes no paid request and unavailable generation stays disabled", () => {
  const h = harness({ available: false });
  const tree = h.render();
  h.effects();
  assert.equal(h.calls.length, 0);
  assert.equal(button(tree, "明确生成所选讲解").props.disabled, true);
  assert.match(text(tree), /尚未启用或已暂停/);
});

test("an issue may highlight a narration segment but never selects or generates it", () => {
  const h = harness({ available: true });
  h.props.focusSegmentId = "segment-one";
  const tree = h.render();
  const label = find(tree, (node) => node.props?.["data-issue-focus"])[0];
  assert.ok(label);
  assert.match(text(label), /未自动勾选或生成/);
  assert.equal(
    find(label, (node) => node.type === "input")[0].props.checked,
    false,
  );
  assert.equal(button(tree, "明确生成所选讲解").props.disabled, true);
  assert.equal(h.calls.length, 0);
});
test("formal audio requires explicit generation consent, current saved revision and operation identity", async () => {
  const h = harness({
    request: async () => ({
      data: [
        {
          id: "created-job",
          tour_id: "tour",
          source_revision: 4,
          segment_id: "segment-one",
          state: "queued",
        },
      ],
    }),
  });
  let tree = h.render();
  h.effects();
  find(
    tree,
    (n) => n.type === "input" && n.props.type === "checkbox",
  )[0].props.onChange({ target: { checked: true } });
  tree = h.render();
  assert.equal(h.calls.length, 0);
  await button(tree, "明确生成所选讲解").props.onClick();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "/narration-jobs");
  assert.equal(h.calls[0][2].expected_revision, 4);
  assert.match(h.calls[0][2].operation_id, /^[a-f0-9-]{36}$/);
  const refused = harness({ confirm: false });
  tree = refused.render();
  refused.effects();
  find(
    tree,
    (n) => n.type === "input" && n.props.type === "checkbox",
  )[0].props.onChange({ target: { checked: true } });
  tree = refused.render();
  button(tree, "明确生成所选讲解").props.onClick();
  await settle();
  assert.equal(refused.calls.length, 0);
});
test("private manifest validation rejects another asset, foreign URL and duplicate chunks", async () => {
  const h = harness(),
    m = await manifest();
  assert.equal(h.exports.safeAuditionManifest(m, asset), true);
  assert.equal(
    h.exports.safeAuditionManifest({ ...m, asset_id: "other" }, asset),
    false,
  );
  assert.equal(
    h.exports.safeAuditionManifest(
      {
        ...m,
        chunks: [{ ...m.chunks[0], url: "https://foreign.test/audio.wav" }],
      },
      asset,
    ),
    false,
  );
  assert.equal(
    h.exports.safeAuditionManifest(
      { ...m, chunks: [m.chunks[0], m.chunks[0]] },
      asset,
    ),
    false,
  );
});
test("employee audition must finish every real chunk before explicit adoption, never auto-adopts", async () => {
  const h = harness({ manifest: await manifest() });
  let tree = h.render();
  h.effects();
  button(tree, "工作人员试听").props.onClick();
  tree = await auditionReady(h);
  assert.equal(button(tree, "听完并明确采用到草稿").props.disabled, true);
  assert.equal(
    h.props.content.stops[0].segments[0].narration_asset_id,
    undefined,
  );
  find(tree, (n) => n.type === "audio")[0].props.onEnded();
  tree = h.render();
  assert.equal(button(tree, "听完并明确采用到草稿").props.disabled, true);
  button(tree, "下一段").props.onClick();
  tree = h.render();
  find(tree, (n) => n.type === "audio")[0].props.onEnded();
  tree = h.render();
  assert.equal(button(tree, "听完并明确采用到草稿").props.disabled, false);
  button(tree, "听完并明确采用到草稿").props.onClick();
  assert.equal(h.props.content.stops[0].segments[0].narration_asset_id, asset);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0][0], /^\/narration-assets\/.+\/manifest$/);
});
test("late ended events from a previous chunk cannot mark the current chunk as heard", async () => {
  const h = harness({ manifest: await manifest() });
  let tree = h.render();
  h.effects();
  button(tree, "工作人员试听").props.onClick();
  tree = await auditionReady(h);
  const oldEnded = find(tree, (n) => n.type === "audio")[0].props.onEnded;
  button(tree, "下一段").props.onClick();
  tree = h.render();
  oldEnded();
  tree = h.render();
  assert.match(text(tree), /已结束播放 0 \/ 2/);
  assert.equal(button(tree, "听完并明确采用到草稿").props.disabled, true);
});
test("changed text cannot adopt an old ready asset even if its audio has ended", async () => {
  const h = harness({ manifest: await manifest() });
  let tree = h.render();
  h.effects();
  button(tree, "工作人员试听").props.onClick();
  tree = await auditionReady(h);
  find(tree, (n) => n.type === "audio")[0].props.onEnded();
  button(tree, "下一段").props.onClick();
  tree = h.render();
  find(tree, (n) => n.type === "audio")[0].props.onEnded();
  h.props.content = {
    ...h.props.content,
    stops: [
      {
        ...h.props.content.stops[0],
        segments: [
          { ...h.props.content.stops[0].segments[0], text: "修改后的测试稿" },
        ],
      },
    ],
  };
  tree = h.render();
  button(tree, "听完并明确采用到草稿").props.onClick();
  assert.equal(
    h.props.content.stops[0].segments[0].narration_asset_id,
    undefined,
  );
  h.effects();
  tree = h.render();
  assert.equal(find(tree, (n) => n.type === "audio").length, 0);
});
test("a lost formal-generation response only reads its same operation and exact tour segment revision", async () => {
  const created = [
    {
      id: "queued-job",
      tour_id: "tour",
      segment_id: "segment-one",
      source_revision: 4,
      state: "queued",
    },
  ];
  const h = harness({
    request: async (_path, method) => {
      if (method === "POST") throw new Error("lost response");
      return { data: created };
    },
  });
  let tree = h.render();
  h.effects();
  find(
    tree,
    (n) => n.type === "input" && n.props.type === "checkbox",
  )[0].props.onChange({ target: { checked: true } });
  tree = h.render();
  button(tree, "明确生成所选讲解").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  const write = h.calls[0][2],
    query = new URLSearchParams(h.calls[1][0].split("?")[1]);
  assert.equal(query.get("tour_id"), "tour");
  assert.equal(query.get("operation_id"), write.operation_id);
  assert.equal(button(tree, "查询本次生成结果（不重复收费）"), undefined);
});
test("an unknown or mismatched generation stays blocked until the same operation read confirms every original segment", async () => {
  let confirm = false;
  const h = harness({
    request: async (_path, method) => {
      if (method === "POST") throw new Error("timeout");
      return {
        data: [
          {
            id: "job",
            tour_id: confirm ? "tour" : "other-tour",
            source_revision: 4,
            segment_id: "segment-one",
            state: "queued",
          },
        ],
      };
    },
  });
  const pending = [];
  h.props.onPendingChange = (value) => pending.push(value);
  let tree = h.render();
  h.effects();
  find(
    tree,
    (n) => n.type === "input" && n.props.type === "checkbox",
  )[0].props.onChange({ target: { checked: true } });
  tree = h.render();
  button(tree, "明确生成所选讲解").props.onClick();
  await settle();
  tree = h.render();
  h.effects();
  assert.equal(button(tree, "明确生成所选讲解").props.disabled, true);
  assert.equal(pending.at(-1), true);
  confirm = true;
  button(tree, "查询本次生成结果（不重复收费）").props.onClick();
  await settle();
  tree = h.render();
  h.effects();
  assert.equal(button(tree, "查询本次生成结果（不重复收费）"), undefined);
  assert.equal(pending.at(-1), false);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
});
test("late pause from a replaced private audio chunk cannot release the new chunk's audio owner", async () => {
  const h = harness({ manifest: await manifest() });
  let tree = h.render();
  h.effects();
  button(tree, "工作人员试听").props.onClick();
  tree = await auditionReady(h);
  const oldPause = find(tree, (n) => n.type === "audio")[0].props.onPause;
  button(tree, "下一段").props.onClick();
  tree = h.render();
  find(tree, (n) => n.type === "audio")[0].props.onPlay();
  const count = h.leases.length;
  oldPause();
  assert.equal(h.leases.length, count);
});
test("retired unadopted assets keep their job receipt and cannot issue a paid retry", async () => {
  const h = harness({
    jobs: [
      {
        id: "job",
        tour_id: "tour",
        segment_id: "segment-one",
        source_revision: 4,
        state: "failed",
        last_error: "NARRATION_RETIRED",
        attempts: 1,
        total_chunks: 1,
        completed_chunks: 0,
        characters: 4,
      },
    ],
  });
  const tree = h.render();
  assert.match(text(tree), /到期回收/);
  assert.equal(button(tree, "明确重试"), undefined);
  assert.equal(h.calls.length, 0);
});
test("a lost paid retry waits for the original job state and never repeats the retry request", async () => {
  const original = {
    id: "job",
    tour_id: "tour",
    segment_id: "segment-one",
    source_revision: 4,
    state: "failed",
    last_error: "fixture",
    attempts: 1,
    total_chunks: 1,
    completed_chunks: 0,
    characters: 4,
  };
  let confirmed = false;
  const h = harness({
    jobs: [original],
    request: async (path, method) => {
      if (method === "POST") throw new Error("lost paid retry");
      return {
        data: confirmed
          ? { ...original, state: "running", attempts: 2 }
          : original,
      };
    },
  });
  let tree = h.render();
  h.effects();
  button(tree, "明确重试").props.onClick();
  await settle();
  tree = h.render();
  assert.ok(button(tree, "读取原任务操作结果"));
  assert.equal(button(tree, "明确重试").props.disabled, true);
  button(tree, "读取原任务操作结果").props.onClick();
  await settle();
  tree = h.render();
  assert.ok(button(tree, "读取原任务操作结果"));
  assert.equal(h.calls.at(-1)[0], "/narration-jobs/job");
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  confirmed = true;
  button(tree, "读取原任务操作结果").props.onClick();
  await settle();
  tree = h.render();
  assert.equal(button(tree, "读取原任务操作结果"), undefined);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  assert.match(text(tree), /没有重复发起操作/);
});
