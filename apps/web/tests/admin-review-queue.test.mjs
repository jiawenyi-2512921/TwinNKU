import { test } from "node:test";
import assert from "node:assert/strict";
import { controlledAdmin, find, text, button } from "./helpers/controlled-admin.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = { user: { id: id(100), role: "reviewer", campus_ids: ["nku-jinnan"], point_ids: [] }, permissions: ["points.read", "points.review"], recent_mfa_until: new Date(Date.now() + 290_000).toISOString() };
const change = n => ({ id: id(n), kind: "media", revision: 2, title: `待审视频夹具${n}`, point_name: "测试地点", state: "in_review", can_review: true });
const draft = n => ({ id: id(n), kind: "media", revision: 2, published_revision: 0, state: "in_review", operation: "upsert", status: "draft",
  content: { kind: "media", media_type: "video", point_id: id(90), title: `待审视频夹具${n}`, video_visual_information: "audio_complete", video_accessibility_note: "人工核对夹具", transcript: "等价说明夹具", source_note: "测试，非实际内容" }, media_url: null, caption_url: null });
const published = n => ({ ...draft(n), revision: 3, published_revision: 1, state: "published", status: "published", published_content: draft(n).content });
function memory() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }
function failure(status, description = "测试失败") { const error = new Error(description); error.status = status; return error; }
function setup({ respond, storage = memory(), rows = [change(1)], currentSession = session } = {}) {
  const calls = [], dirties = [], updates = [];
  const h = controlledAdmin({ "./api": { message: error => error.message, request: async (...args) => {
    calls.push(args); const [path, method, body] = args;
    if (respond) { const result = await respond(path, method, body, storage); if (result !== undefined) return result; }
    if (path.startsWith("/changes?")) {
      const key = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("item_id");
      return { data: rows.filter(item => item.id === key), meta: {} };
    }
    if (path.startsWith("/experiences/")) { const key = path.slice("/experiences/".length); return { data: draft(Number(key.slice(-12))), meta: {} }; }
    if (path.startsWith("/operations/")) throw failure(404);
    if (path === "/review-queue/publish") {
      assert.equal(method, "POST");
      const journal = JSON.parse(storage.getItem(`twinnku-review-queue-v1:${currentSession.user.id}`));
      assert.equal(journal.at(-1).operationId, body.operation_id, "intent exists durably before POST");
      return { data: published(Number(body.id.slice(-12))), meta: {} };
    }
    throw new Error(`unexpected ${path}`);
  } } });
  h.browser.localStorage = storage;
  const module = h.load("./ReviewQueue"), helpers = h.load("./reviewQueueHelpers");
  const props = { rows, session: currentSession, onOpen() {}, onClose() {}, onDirty: (...value) => dirties.push(value), onUpdate: () => updates.push(true) };
  return { ...h, ...module, ...helpers, calls, props, storage, updates, dirties, renderQueue: () => h.render("queue", module.ReviewQueue, props) };
}
const labels = (tree, fragment) => find(tree, node => node.type === "label" && text(node).includes(fragment));
const input = label => find(label, node => node.type === "input")[0];
function approveAll(h) {
  let tree = h.renderQueue();
  labels(tree, "我已核对本版本画面").forEach(label => input(label).props.onChange({ target: { checked: true } }));
  tree = h.renderQueue();
  labels(tree, "我已审阅本项完整稿件").forEach(label => input(label).props.onChange({ target: { checked: true } }));
  return h.renderQueue();
}

test("journal validates fixed kinds and targets and never accepts arbitrary data or duplicate unknown writes", () => {
  const h = setup();
  const key = h.queueJournalKey(session.user.id), intent = { id: id(1), kind: "media", revision: 2, publishedRevision: 0, operationId: id(10) };
  h.addQueueIntent(h.storage, key, intent);
  assert.deepEqual(JSON.parse(JSON.stringify(h.readQueueJournal(h.storage, key))), [intent]);
  assert.throws(() => h.addQueueIntent(h.storage, key, { ...intent, operationId: id(11) }), /先查询/);
  assert.throws(() => h.readQueueJournal({ getItem: () => JSON.stringify([{ ...intent, csrf: "never store credentials" }]) }, key), /记录无效/);
  assert.throws(() => h.readQueueJournal({ getItem: () => JSON.stringify([{ ...intent, kind: "arbitrary-admin" }]) }, key), /记录无效/);
  assert.throws(() => h.addQueueIntent({ getItem: () => null, setItem() {} }, key, intent), /无法保存/);
  assert.throws(() => h.verifyQueueResult(intent, { ...published(1), published_revision: 99 }), /回执版本不一致/);
  h.dispose();
});

test("all eight actual staff DTO shapes and retirement revision rules are read without guessing fields", () => {
  const h = setup(), revision = 2, published_revision = 4;
  const base = { id: id(1), revision, published_revision, state: "in_review", operation: "upsert" };
  const values = {
    point: { point: { id: id(1), revision: published_revision }, draft: { revision, state: "in_review", operation: "upsert", payload: { name: "真实点位夹具" } } },
    floor: { ...base, draft: { revision, state: "in_review", operation: "upsert", payload: { content: { kind: "floor", label: "一层" } } } },
    panorama: { ...base, draft: { revision, state: "in_review", operation: "upsert", payload: { content: { kind: "panorama", title: "VR夹具" } } } },
    media: { ...base, content: { ...draft(1).content } },
    checkin: { ...base, content: { kind: "checkin", title: "打卡夹具" } },
    tour: { ...base, content: { kind: "tour", stops: [] } },
    navigation: { ...base, map_id: id(1), draft: { nodes: [], edges: [] } },
    configuration: { ...base, draft: { kind: "presentation", site_name: "展馆夹具" } },
  };
  for (const [kind, value] of Object.entries(values)) {
    const snapshot = h.queueSnapshot({ kind, id: id(1) }, value);
    assert.equal(snapshot.revision, revision); assert.equal(snapshot.publishedRevision, published_revision);
    assert.equal(snapshot.state, "in_review");
  }
  const intent = { id: id(1), kind: "floor", revision: 2, publishedRevision: 4, operationId: id(10) };
  const retired = { id: id(1), published_revision: 4, draft: { revision: 3, state: "published", operation: "retire", payload: null }, current: { kind: "floor", label: "旧一层" } };
  assert.doesNotThrow(() => h.verifyQueueResult(intent, retired), "retirement leaves immutable floor revision unchanged");
  assert.throws(() => h.queueSnapshot({ kind: "media", id: id(1) }, { ...base, draft: draft(1).content }), /内容类型不一致/, "AdminExperience uses content, never a made-up draft field");
  h.dispose();
});

test("video items require both their own decision confirmation and independent approval, without autoplay", async () => {
  const h = setup({ respond(path) { if (path === `/experiences/${id(1)}`) return { data: { ...draft(1), media_url: `/api/v1/admin/experience-media/${id(50)}`, content: { ...draft(1).content, upload_id: id(50) } }, meta: {} }; } });
  let tree = h.renderQueue(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /声音完整表达关键画面/);
  assert.equal(input(labels(tree, "我已审阅本项完整稿件")[0]).props.disabled, true);
  assert.equal(find(tree, node => node.type === "video").length, 0);
  button(tree, "查看本项待审视频").props.onClick(); tree = h.renderQueue();
  const preview = find(tree, node => node.type === "video")[0];
  assert.equal(preview.props.muted, true); assert.equal(preview.props.preload, "none"); assert.equal(preview.props.autoPlay, undefined);
  assert.equal(h.calls.some(([, method]) => method === "POST"), false);
  tree = approveAll(h);
  button(tree, "逐项处理已勾选的 1 项").props.onClick(); await settle(); tree = h.renderQueue();
  const writes = h.calls.filter(([, method]) => method === "POST");
  assert.equal(writes.length, 1); assert.equal(writes[0][2].video_accessibility_confirmed, true);
  assert.equal(writes[0][2].expected_revision, 2); assert.equal(writes[0][2].expected_published_revision, 0);
  assert.match(text(tree), /已完成 1 项/);
  assert.equal(h.storage.getItem(h.queueJournalKey(session.user.id)), "[]");
  h.dispose();
});

test("staged enrollment still requires explicit actual step-up before any queue POST", async () => {
  const h = setup({ currentSession: { ...session, recent_mfa_until: null, mfa_enforced: false } });
  let requested = 0; h.browser.addEventListener("staff-mfa-required", () => ++requested);
  h.renderQueue(); await settle(); const tree = approveAll(h);
  button(tree, "逐项处理已勾选的 1 项").props.onClick(); await settle();
  assert.equal(requested, 1); assert.equal(h.calls.some(([, method]) => method === "POST"), false);
  assert.equal(find(h.renderQueue(), node => typeof node.props?.text === "string" && /先验证通行密钥/.test(node.props.text)).length, 1);
  h.dispose();
});

test("uncertain POST followed by missing receipt preserves intent and only queries, including after reload", async () => {
  const storage = memory();
  const h = setup({ storage, respond(path) { if (path === "/review-queue/publish") throw new Error("connection lost"); } });
  h.renderQueue(); await settle(); let tree = approveAll(h);
  button(tree, "逐项处理已勾选的 1 项").props.onClick(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /待确认 1 项/);
  button(tree, "查询本项原操作结果").props.onClick(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /仍是未知结果/);
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1);
  const intent = JSON.parse(storage.getItem(h.queueJournalKey(session.user.id)))[0];
  h.dispose();
  const restored = setup({ storage });
  tree = restored.renderQueue(); await settle(); tree = restored.renderQueue();
  assert.equal(restored.calls.length, 0, "restored intent does not automatically replay or query");
  assert.match(text(tree), /待确认 1 项/);
  button(tree, "查询本项原操作结果").props.onClick(); await settle();
  assert.deepEqual(restored.calls.map(([path]) => path), [`/operations/${intent.operationId}`]);
  assert.equal(restored.calls.some(([, method]) => method === "POST"), false);
  restored.dispose();
});

test("receipt recovery checks owner-scoped operation identity, action and exact revision before marking complete", async () => {
  const storage = memory(), key = `twinnku-review-queue-v1:${session.user.id}`;
  const intent = { kind: "media", id: id(1), revision: 2, publishedRevision: 0, operationId: id(10) };
  storage.setItem(key, JSON.stringify([intent]));
  let valid = false;
  const h = setup({ storage, respond(path) { if (path.startsWith("/operations/")) return { data: { id: valid ? id(10) : id(11), target_id: id(1), action: "experience.publish", result: published(1) }, meta: {} }; } });
  let tree = h.renderQueue(); button(tree, "查询本项原操作结果").props.onClick(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /仍未确认/); assert.equal(JSON.parse(storage.getItem(key)).length, 1);
  valid = true; button(tree, "查询本项原操作结果").props.onClick(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /已完成 1 项/); assert.equal(storage.getItem(key), "[]");
  assert.equal(h.calls.some(([, method]) => method === "POST"), false);
  h.dispose();
});

test("a queue stops at definite failure with truthful partial success and untouched successors", async () => {
  const h = setup({ rows: [change(1), change(2), change(3)], respond(path, method, body) { if (path === "/review-queue/publish" && body.id === id(2)) throw failure(409, "版本冲突夹具"); } });
  h.renderQueue(); await settle(); let tree = approveAll(h);
  button(tree, "逐项处理已勾选的 3 项").props.onClick(); await settle(); tree = h.renderQueue();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 2);
  assert.match(text(tree), /已完成 1 项/); assert.match(text(tree), /版本冲突夹具/);
  assert.equal(h.storage.getItem(h.queueJournalKey(session.user.id)), "[]");
  assert.equal(labels(tree, "我已核对本版本画面").filter(label => input(label).props.checked).length, 1, "successors remain unprocessed");
  h.dispose();
});

test("changed scope and late old-account responses cannot continue a queue or appear in the new account", async () => {
  let release;
  const h = setup({ rows: [change(1), change(2)], respond(path) { if (path === "/review-queue/publish") return new Promise(resolve => { release = resolve; }); } });
  h.renderQueue(); await settle(); let tree = approveAll(h);
  button(tree, "逐项处理已勾选的 2 项").props.onClick(); await settle();
  assert.equal(typeof release, "function");
  const originalKey = h.queueJournalKey(session.user.id);
  assert.equal(JSON.parse(h.storage.getItem(originalKey)).length, 1);
  h.props.session = { ...session, user: { ...session.user, id: id(101), campus_ids: [] } };
  h.props.rows = []; tree = h.renderQueue(); await settle();
  assert.doesNotMatch(text(tree), /待审视频夹具/);
  release({ data: published(1), meta: {} }); await settle(); tree = h.renderQueue();
  assert.equal(h.calls.filter(([, method]) => method === "POST").length, 1, "old generation never publishes the next item");
  assert.doesNotMatch(text(tree), /已完成 1 项/);
  assert.equal(h.storage.getItem(h.queueJournalKey(id(101))), null, "no old operation is written into the new account");
  h.dispose();
});

test("restored pending operations are isolated per account and are not restored as approval", async () => {
  const storage = memory(), key = `twinnku-review-queue-v1:${id(999)}`;
  storage.setItem(key, JSON.stringify([{ kind: "media", id: id(1), revision: 2, publishedRevision: 0, operationId: id(10) }]));
  const h = setup({ storage }); h.renderQueue(); await settle(); const tree = h.renderQueue();
  assert.match(text(tree), /待确认 0 项/);
  assert.equal(input(labels(tree, "我已核对本版本画面")[0]).props.checked, false);
  assert.equal(input(labels(tree, "我已审阅本项完整稿件")[0]).props.checked, false);
  assert.equal(h.calls.some(([path]) => path.startsWith("/operations/")), false);
  assert.notEqual(storage.getItem(key), "[]", "another account's evidence is left untouched");
  h.dispose();
});

test("storage denial stops before POST and changing current authority invalidates all approvals", async () => {
  const denied = memory(); denied.setItem = () => { throw new Error("storage denied"); };
  const h = setup({ storage: denied }); h.renderQueue(); await settle(); let tree = approveAll(h);
  button(tree, "逐项处理已勾选的 1 项").props.onClick(); await settle(); tree = h.renderQueue();
  assert.equal(h.calls.some(([, method]) => method === "POST"), false);
  assert.match(text(tree), /storage denied/); assert.match(text(tree), /待确认 0 项/);
  h.props.session = { ...session, user: { ...session.user, role: "viewer" }, permissions: ["points.read"] };
  h.props.rows = [{ ...change(1), can_review: false }]; tree = h.renderQueue(); await settle(); tree = h.renderQueue();
  assert.equal(find(tree, node => node.type === "input").length, 0);
  h.dispose();
});

test("description-required review names the exact published alternate and rejects changed alternate before POST", async () => {
  let targetRevision = 7;
  const h = setup({ respond(path) {
    if (path === `/experiences/${id(1)}`) return { data: { ...draft(1), content: { ...draft(1).content, video_visual_information: "description_required", audio_description_video_id: id(70), audio_description_video_revision: 7 } }, meta: {} };
    if (path === `/experiences/${id(70)}`) return { data: { id: id(70), status: "published", published_revision: targetRevision,
      published_content: { ...draft(70).content, title: "独立审核口述描述夹具" } }, meta: {} };
  } });
  h.renderQueue(); await settle(); let tree = h.renderQueue();
  assert.match(text(tree), /口述描述版：独立审核口述描述夹具 · 正式版本 7/);
  tree = approveAll(h); targetRevision = 8;
  button(tree, "逐项处理已勾选的 1 项").props.onClick(); await settle(); tree = h.renderQueue();
  assert.match(text(tree), /口述描述关联的正式版本已变化/);
  assert.equal(h.calls.some(([, method]) => method === "POST"), false);
  h.dispose();
});
