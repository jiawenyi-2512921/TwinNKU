import type { ChangeItem } from "./api";

export const queueKinds = ["point", "floor", "panorama", "media", "checkin", "tour", "navigation", "configuration"] as const;
type Kind = ChangeItem["kind"];
export type QueueIntent = { kind: Kind; id: string; revision: number; publishedRevision: number; operationId: string };
export type QueueSnapshot = { revision: number; publishedRevision: number; state: string; operation: string; content: Record<string, unknown>; mediaUrl: string | null; captionUrl: string | null };
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const queueIdentity = (value: { kind: Kind; id: string }) => `${value.kind}:${value.id}`;
export const queueJournalKey = (userId: string) => `twinnku-review-queue-v1:${userId}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function readQueueJournal(storage: Pick<Storage, "getItem">, key: string): QueueIntent[] {
  const text = storage.getItem(key);
  if (!text) return [];
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 20) throw new Error("本机队列记录格式异常，请保留记录并联系维护人员。");
  const seen = new Set<string>();
  const targets = new Set<string>();
  for (const value of values) {
    const v = record(value), allowed = ["kind", "id", "revision", "publishedRevision", "operationId"];
    if (Object.keys(v).some(key => !allowed.includes(key)) || !queueKinds.includes(v.kind as Kind)
      || !uuid.test(String(v.id)) || !uuid.test(String(v.operationId))
      || !Number.isInteger(v.revision) || (v.revision as number) < 1
      || !Number.isInteger(v.publishedRevision) || (v.publishedRevision as number) < 0
      || seen.has(String(v.operationId)) || targets.has(`${v.kind}:${v.id}`)) throw new Error("本机队列记录无效，已停止写入；请保留记录并联系维护人员。");
    seen.add(String(v.operationId));
    targets.add(`${v.kind}:${v.id}`);
  }
  return values as QueueIntent[];
}
export function addQueueIntent(storage: Pick<Storage, "getItem" | "setItem">, key: string, intent: QueueIntent) {
  const items = readQueueJournal(storage, key);
  if (items.some(item => queueIdentity(item) === queueIdentity(intent))) throw new Error("此项仍有待确认操作，请先查询结果。");
  const next = [...items, intent];
  // Validate the exact prospective bytes before accepting an intent.
  readQueueJournal({ getItem: () => JSON.stringify(next) }, key);
  storage.setItem(key, JSON.stringify(next));
  if (storage.getItem(key) !== JSON.stringify(next)) throw new Error("无法保存本机操作标识，已停止发布；请检查浏览器存储。");
}
export function clearQueueIntent(storage: Pick<Storage, "getItem" | "setItem">, key: string, operationId: string) {
  storage.setItem(key, JSON.stringify(readQueueJournal(storage, key).filter(item => item.operationId !== operationId)));
}

export function queueDetailPath(item: { kind: Kind; id: string }) {
  const id = encodeURIComponent(item.id);
  return item.kind === "point" ? `/points/${id}` : ["floor", "panorama"].includes(item.kind) ? `/resources/${id}`
    : item.kind === "navigation" ? `/navigation/${id}` : item.kind === "configuration" ? `/configurations/${id}` : `/experiences/${id}`;
}
export function queueSnapshot(item: { kind: Kind; id: string }, value: unknown): QueueSnapshot {
  const v = record(value), draft = record(v.draft), point = record(v.point);
  const id = item.kind === "point" ? point.id : item.kind === "navigation" ? v.map_id : v.id;
  const nested = ["point", "floor", "panorama"].includes(item.kind);
  const revision = nested ? draft.revision : v.revision;
  const publishedRevision = item.kind === "point" ? point.revision : v.published_revision;
  if (id !== item.id || !Number.isInteger(revision) || (revision as number) < 1
    || !Number.isInteger(publishedRevision) || (publishedRevision as number) < 0)
    throw new Error("待审响应的身份或版本不一致，请重新读取。");
  const operation = String(nested ? draft.operation : v.operation ?? "upsert");
  const content = item.kind === "point" ? record(draft.payload)
    : ["floor", "panorama"].includes(item.kind) ? record(record(draft.payload).content ?? (operation === "retire" ? v.current : null))
      : ["media", "checkin", "tour"].includes(item.kind) ? record(v.content ?? (operation === "retire" ? v.published_content : null)) : draft;
  const kind = item.kind === "point" ? "point" : item.kind === "navigation" ? "navigation" : item.kind === "panorama" ? "panorama" : item.kind;
  if (item.kind !== "point" && item.kind !== "navigation" && item.kind !== "configuration" && content.kind !== kind)
    throw new Error("待审内容类型不一致，请重新读取。");
  const upload = typeof content.upload_id === "string" ? content.upload_id : "";
  const mediaPath = upload ? `/api/v1/admin/experience-media/${encodeURIComponent(upload)}` : "";
  const caption = typeof content.caption_upload_id === "string" ? content.caption_upload_id : "";
  const captionPath = caption ? `/api/v1/admin/experience-captions/${encodeURIComponent(caption)}` : "";
  return { revision: revision as number, publishedRevision: publishedRevision as number,
    state: String(nested ? draft.state : v.state), operation, content,
    mediaUrl: mediaPath && v.media_url === mediaPath ? mediaPath : null,
    captionUrl: captionPath && v.caption_url === captionPath ? captionPath : null };
}
export function verifyQueueReceipt(intent: QueueIntent, value: unknown): unknown {
  const v = record(value);
  const action = intent.kind === "panorama" ? "vr.publish" : ["media", "checkin", "tour"].includes(intent.kind)
    ? "experience.publish" : intent.kind === "configuration" ? "publish" : `${intent.kind}.publish`;
  if (v.id !== intent.operationId || v.target_id !== intent.id || v.action !== action)
    throw new Error("操作回执与本次逐项审核不一致，结果仍待确认。");
  return verifyQueueResult(intent, v.result);
}
export function verifyQueueResult(intent: QueueIntent, value: unknown): unknown {
  const result = queueSnapshot(intent, value);
  const expectedPublished = ["floor", "panorama"].includes(intent.kind) && result.operation === "retire"
    ? intent.publishedRevision : intent.publishedRevision + 1;
  if (result.revision !== intent.revision + 1 || result.publishedRevision !== expectedPublished || result.state !== "published")
    throw new Error("操作回执版本不一致，结果仍待确认。");
  return value;
}
export function queueVideo(content: Record<string, unknown>) { return content.kind === "media" && content.media_type === "video"; }
export function queueHasRecentMfa(value: string | null | undefined, now = Date.now()) {
  const until = value ? Date.parse(value) : NaN;
  return Number.isFinite(until) && until > now && until <= now + 5 * 60_000;
}
