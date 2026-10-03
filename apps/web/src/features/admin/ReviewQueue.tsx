import { useEffect, useRef, useState } from "react";
import { message, request, type ChangeItem, type StaffSession } from "./api";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import { addQueueIntent, clearQueueIntent, queueDetailPath, queueHasRecentMfa, queueIdentity, queueJournalKey,
  queueSnapshot, queueVideo, readQueueJournal, verifyQueueReceipt, verifyQueueResult, type QueueIntent, type QueueSnapshot } from "./reviewQueueHelpers";
import { ErrorBox } from "./ui";
import "./reviewQueue.css";

type State = "reading" | "ready" | "failed" | "publishing" | "done" | "unknown";
type Entry = { change: ChangeItem; snapshot?: QueueSnapshot; state: State; approved: boolean; videoConfirmed: boolean;
  error: string; intent?: QueueIntent; descriptionTitle?: string; descriptionReady?: boolean };
const decisionNames: Record<string, string> = { unassessed: "尚未判断", audio_complete: "声音完整表达关键画面", description_required: "关键画面需要口述描述版", silent: "无声视频，以等价文字说明表达" };
const string = (value: unknown) => typeof value === "string" ? value : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Small public-neutral summaries; full review still uses the existing workspaces. */
function QueueContent({ content }: { content: Record<string, unknown> }) {
  const blocks = ["summary", "description", "lead", "narrative", "text", "observation_prompt", "transcript", "source_note"];
  return <div className="ad-queue-content">
    {blocks.map(key => string(content[key]) && <p key={key}>{string(content[key])}</p>)}
    {Array.isArray(content.stops) && content.stops.map((value, index) => {
      const stop = object(value);
      return <details key={index}><summary>第 {index + 1} 站{string(stop.title) ? `：${stop.title}` : ""}</summary>
        {string(stop.narrative) && <p>{string(stop.narrative)}</p>}
        {Array.isArray(stop.segments) && stop.segments.map((value, segmentIndex) => {
          const segment = object(value);
          return <section key={segmentIndex}><strong>{string(segment.title) || `第 ${segmentIndex + 1} 段`}</strong>
            <p>{string(segment.text)}</p><p>{string(segment.source_note)}</p></section>;
        })}
      </details>;
    })}
    {Array.isArray(content.images) && <p>此稿包含 {content.images.length} 个楼层分区，请在完整审核详情核对原图与分区说明。</p>}
    {Array.isArray(content.edges) && <p>此稿包含 {content.edges.length} 段道路，请在完整审核详情核对路径、入口和实测依据。</p>}
    {content.kind === "presentation" || content.kind === "runtime" || content.kind === "visit_defaults"
      ? <p>配置与运行策略需在完整审核详情核对覆盖范围、变化及依赖；本队列不会授予额外配置权限。</p> : null}
  </div>;
}

export function ReviewQueue({ rows, session, onOpen, onClose, onDirty, onUpdate }: {
  rows: ChangeItem[]; session: StaffSession; onOpen: (item: ChangeItem) => void;
  onClose: () => void; onDirty: (dirty: boolean, busy?: boolean) => void; onUpdate: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const epoch = useRef(0), inFlight = useRef(false);
  const journalKey = queueJournalKey(session.user.id);
  const identity = JSON.stringify([session.user.id, session.user.role, session.user.campus_ids, session.user.point_ids, session.permissions,
    rows.map(row => [row.kind, row.id, row.revision, row.can_review, row.state])]);
  function patch(key: string, values: Partial<Entry>) {
    setEntries(old => old.map(entry => queueIdentity(entry.change) === key ? { ...entry, ...values } : entry));
  }
  async function readItem(change: ChangeItem, signal?: AbortSignal): Promise<Partial<Entry>> {
    const current = (await request<ChangeItem[]>(`/changes?${new URLSearchParams({ state: "in_review", kind: change.kind, item_id: change.id })}`, "GET", undefined, signal)).data
      .find(item => item.id === change.id && item.kind === change.kind);
    if (!current || !current.can_review || current.revision !== change.revision) throw new Error("待审版本或审核权限已变化，请回到最新列表重新选择。");
    const raw = (await request<unknown>(queueDetailPath(change), "GET", undefined, signal)).data;
    const snapshot = queueSnapshot(change, raw);
    if (snapshot.state !== "in_review" || snapshot.revision !== change.revision) throw new Error("内容已不在本版本的待审状态。");
    let descriptionTitle = "", descriptionReady = true;
    const content = snapshot.content;
    if (queueVideo(content) && snapshot.operation !== "retire" && content.video_visual_information === "description_required") {
      descriptionReady = false;
      const id = string(content.audio_description_video_id), revision = content.audio_description_video_revision;
      if (id && Number.isInteger(revision)) {
        const target = object((await request<unknown>(`/experiences/${encodeURIComponent(id)}`, "GET", undefined, signal)).data);
        const published = object(target.published_content);
        if (target.id === id && target.status === "published" && target.published_revision === revision && published.kind === "media"
          && published.point_id === content.point_id && published.media_type === "video" && published.video_visual_information === "audio_complete"
          && string(published.video_accessibility_note).trim() && !published.audio_description_video_id) {
          descriptionTitle = string(published.title); descriptionReady = true;
        }
      }
      if (!descriptionReady) throw new Error("口述描述关联的正式版本已变化或不可用，请在完整详情核对并退回修改。");
    }
    return { change: current, snapshot, descriptionTitle, descriptionReady, state: "ready", approved: false, videoConfirmed: false, error: "" };
  }
  async function query(intent: QueueIntent) {
    try {
      const receipt = (await request<unknown>(`/operations/${encodeURIComponent(intent.operationId)}`)).data;
      return verifyQueueReceipt(intent, receipt);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    setPreview(null); setError("");
    const allowed = rows.filter(row => row.can_review && row.state === "in_review").slice(0, 20);
    let pending: QueueIntent[];
    try { pending = readQueueJournal(window.localStorage, journalKey); }
    catch (e) { setEntries([]); setError(message(e)); return () => { controller.abort(); ++epoch.current; }; }
    const initial: Entry[] = allowed.map(change => ({ change, state: "reading", approved: false, videoConfirmed: false, error: "" }));
    for (const intent of pending) {
      const existing = initial.find(entry => queueIdentity(entry.change) === queueIdentity(intent));
      const values: Partial<Entry> = { intent, state: "unknown", error: "恢复了待确认操作；只查询原结果，不重新发送发布。" };
      if (existing) Object.assign(existing, values);
      else initial.unshift({ ...values, change: { id: intent.id, kind: intent.kind, revision: intent.revision,
        title: "待确认审核操作", state: "in_review", can_review: false } as ChangeItem, approved: false, videoConfirmed: false } as Entry);
    }
    setEntries(initial);
    void (async () => {
      for (const entry of initial) {
        if (controller.signal.aborted) break;
        if (entry.intent) continue; // Restored unknown results are queried only by an explicit button.
        try { const values = await readItem(entry.change, controller.signal); if (epoch.current === generation) patch(queueIdentity(entry.change), values); }
        catch (e) { if (epoch.current === generation) patch(queueIdentity(entry.change), { state: "failed", error: message(e) }); }
      }
    })();
    return () => { controller.abort(); ++epoch.current; };
  }, [identity]);
  useEffect(() => { onDirty(entries.some(entry => entry.state === "unknown"), busy); }, [entries, busy, onDirty]);

  async function reload(entry: Entry) {
    if (inFlight.current || entry.state === "unknown" || entry.state === "done") return;
    const generation = epoch.current, key = queueIdentity(entry.change);
    patch(key, { state: "reading", approved: false, videoConfirmed: false, error: "" });
    try { const value = await readItem(entry.change); if (epoch.current === generation) patch(key, value); }
    catch (e) { if (epoch.current === generation) patch(key, { state: "failed", error: message(e) }); }
  }
  async function resolve(entry: Entry) {
    if (inFlight.current || !entry.intent || entry.state !== "unknown") return;
    inFlight.current = true; setBusy(true);
    const generation = epoch.current, key = queueIdentity(entry.change);
    try {
      const result = await query(entry.intent);
      if (!result) { if (epoch.current === generation) patch(key, { error: "服务器暂未返回该操作记录。仍是未知结果，请稍后继续查询；不会重发。" }); }
      else {
        clearQueueIntent(window.localStorage, journalKey, entry.intent.operationId);
        if (epoch.current === generation) patch(key, { state: "done", approved: false, videoConfirmed: false, error: "已由原操作回执确认完成。" });
        onUpdate();
      }
    } catch (e) { if (epoch.current === generation) patch(key, { error: `结果仍未确认：${message(e)}` }); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function requireMfa() {
    if (queueHasRecentMfa(session.recent_mfa_until)) return true;
    setError("请先验证通行密钥，再明确点击继续审核。未登记认证器的成员请先在账号安全登记并验证。");
    window.dispatchEvent(new Event("staff-mfa-required")); return false;
  }
  async function publish() {
    if (inFlight.current || entries.some(entry => entry.state === "unknown") || !requireMfa()) return;
    const selected = entries.filter(entry => entry.state === "ready" && entry.approved && entry.snapshot
      && (!queueVideo(entry.snapshot.content) || entry.snapshot.operation === "retire" || entry.videoConfirmed));
    if (!selected.length) return;
    inFlight.current = true; setBusy(true); setPreview(null); setError("");
    const generation = epoch.current;
    try {
      for (const entry of selected) {
        if (epoch.current !== generation || !queueHasRecentMfa(session.recent_mfa_until)) break;
        const key = queueIdentity(entry.change), expected = entry.snapshot!;
        let intent: QueueIntent | undefined;
        try {
          const live = await readItem(entry.change);
          if (epoch.current !== generation) break;
          if (!live.snapshot || live.snapshot.publishedRevision !== expected.publishedRevision) throw new Error("正式版本已变化，请重新逐项审阅。");
          const candidate: QueueIntent = { kind: entry.change.kind, id: entry.change.id, revision: expected.revision, publishedRevision: expected.publishedRevision, operationId: crypto.randomUUID() };
          addQueueIntent(window.localStorage, journalKey, candidate); // Must persist before the write can leave this browser.
          intent = candidate;
          patch(key, { state: "publishing", intent, error: "" });
          const values = { kind: intent.kind, id: intent.id, expected_revision: intent.revision, expected_published_revision: intent.publishedRevision,
            operation_id: intent.operationId, note: "逐项核对本版本内容、来源、预览与公开权限后独立审核", video_accessibility_confirmed: entry.videoConfirmed };
          await confirmedOperation(intent.operationId, async () => {
            const result = (await request<unknown>("/review-queue/publish", "POST", values)).data;
            verifyQueueResult(intent!, result);
            return result;
          }, () => query(intent!));
          clearQueueIntent(window.localStorage, journalKey, intent.operationId);
          if (epoch.current === generation) patch(key, { state: "done", approved: false, videoConfirmed: false, error: "此项已完成。其他项分别处理。" });
        } catch (e) {
          const unknown = e instanceof UnconfirmedOperation || (intent && !(typeof (e as { status?: number }).status === "number" && (e as { status: number }).status >= 400 && (e as { status: number }).status < 500 && (e as { status: number }).status !== 408));
          if (intent && !unknown) clearQueueIntent(window.localStorage, journalKey, intent.operationId);
          if (epoch.current === generation) patch(key, { state: unknown ? "unknown" : "failed", intent: unknown ? intent : undefined,
            approved: false, videoConfirmed: false, error: message(e) });
          // Stop at the first failure or uncertain result. Successful predecessors
          // remain committed; untouched successors require a new explicit click.
          break;
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      if (epoch.current === generation) onUpdate();
    }
  }
  const unknown = entries.some(entry => entry.state === "unknown"), count = entries.filter(entry => entry.approved && entry.state === "ready"
    && (!entry.snapshot || !queueVideo(entry.snapshot.content) || entry.snapshot.operation === "retire" || entry.videoConfirmed)).length;
  return <section className="ad-card ad-review-queue" aria-label="逐项审核队列">
    <h2>逐项审核队列</h2><p>只加入当前页有审核权限的待审内容，最多20项。请分别查看、分别勾选；视频还需确认本版本的画面信息判断。每项独立提交，已成功项不会因后项失败而回滚。</p>
    <p>发布或下架每项都需要最近5分钟的实际通行密钥验证。关闭队列不会发布任何未处理内容。</p>
    <ErrorBox text={error} />
    <div role="status" aria-live="polite">已完成 {entries.filter(entry => entry.state === "done").length} 项 · 待确认 {entries.filter(entry => entry.state === "unknown").length} 项 · 已明确勾选 {count} 项</div>
    {entries.map(entry => {
      const key = queueIdentity(entry.change), snapshot = entry.snapshot, content = snapshot?.content ?? {}, video = queueVideo(content);
      return <article key={key} className="ad-queue-item">
        <h3>{entry.change.title}</h3><p>{entry.change.point_name} · 待审版本 {entry.change.revision}{snapshot ? ` · 正式版本 ${snapshot.publishedRevision}` : ""}{snapshot?.operation === "retire" ? " · 下架申请" : ""}</p>
        {entry.state === "reading" && <p role="status">正在核对本项权限和精确版本…</p>}
        {snapshot && entry.state !== "done" && entry.state !== "unknown" && <>
          <QueueContent content={content} />
          {video && snapshot.operation !== "retire" && <section className="ad-queue-video" aria-label={`${entry.change.title}视频画面信息审阅`}>
            <p><strong>本稿画面信息判断：</strong>{decisionNames[string(content.video_visual_information)] || "判断未知，请单项核对"}</p>
            <p><strong>公开核对说明：</strong>{string(content.video_accessibility_note) || "尚未填写"}</p>
            {content.video_visual_information === "description_required" && <p>口述描述版：{entry.descriptionTitle || "未核验"} · 正式版本 {String(content.audio_description_video_revision ?? "未绑定")}</p>}
            {snapshot.mediaUrl && <button disabled={busy || entry.state !== "ready"} onClick={() => setPreview(preview === key ? null : key)}>{preview === key ? "关闭本项视频预览" : "查看本项待审视频"}</button>}
            {preview === key && snapshot.mediaUrl && <video src={snapshot.mediaUrl} controls muted preload="none" playsInline aria-label={`${entry.change.title}待审视频预览`}>
              {snapshot.captionUrl && <track kind="captions" src={snapshot.captionUrl} srcLang={string(content.caption_language) || "zh-CN"} label={string(content.caption_label) || "字幕"} default />}
            </video>}
            <label><input type="checkbox" disabled={busy || entry.state !== "ready"} checked={entry.videoConfirmed} onChange={event => patch(key, { videoConfirmed: event.target.checked, approved: false })} />我已核对本版本画面、声音、等价说明及所关联口述描述版，确认上述判断</label>
          </section>}
          <button disabled={busy} onClick={() => onOpen(entry.change)}>查看完整审核详情与预览</button>
          <label className="ad-check"><input type="checkbox" disabled={busy || entry.state !== "ready" || (video && snapshot.operation !== "retire" && !entry.videoConfirmed)} checked={entry.approved}
            onChange={event => patch(key, { approved: event.target.checked })} />我已审阅本项完整稿件、来源与预览，独立同意{snapshot.operation === "retire" ? "下架此版本" : "发布此版本"}</label>
        </>}
        {entry.error && <p role={entry.state === "unknown" || entry.state === "failed" ? "alert" : "status"}>{entry.error}</p>}
        {entry.state === "unknown" && <button disabled={busy} onClick={() => void resolve(entry)}>查询本项原操作结果</button>}
        {entry.state === "failed" && <button disabled={busy} onClick={() => void reload(entry)}>重新读取本项，重新审阅</button>}
      </article>;
    })}
    {!entries.length && !error && <p>本页没有可由当前成员独立审核的待审项。</p>}
    <div className="ad-actions"><button className="ad-primary" disabled={busy || unknown || !count} onClick={() => void publish()}>{busy ? "正在逐项处理…" : `逐项处理已勾选的 ${count} 项`}</button>
      <button disabled={busy} onClick={() => { onDirty(false); onClose(); }}>返回审核列表</button></div>
    {unknown && <p>有结果待确认时停止新的发布请求。刷新或重新登录后只恢复原操作标识，必须重新查询；查不到记录不能当作失败重发。</p>}
  </section>;
}

