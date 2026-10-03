import { useEffect, useRef, useState } from "react";
import type { components } from "../../shared/api/schema";
import { request, message, type StaffSession } from "./api";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import { externalPanoramaUrl } from "../points/panorama";

type Check = components["schemas"]["StaffVRCheck"];
type Checks = components["schemas"]["StaffVRChecks"] & { latest?: Check[] };
type Save = components["schemas"]["VRCheckSave"];
const dimensions = [
  ["technical", null, "原站入口可访问"], ["scene", null, "场景与真实地点匹配"],
  ["device", "desktop", "桌面浏览器"], ["device", "android", "Android"],
  ["device", "ios", "iOS"], ["device", "wechat", "微信内置浏览器"],
] as const;
const results = { passed: "已通过人工核查", failed: "人工核查失败", uncertain: "结果不确定" };
const reasons = {
  none: "无需失败原因", authentication_required: "需要原站身份认证",
  network_unavailable: "当前网络不可访问", upstream_unavailable: "原站当前不可用",
  scene_not_matched: "场景与地点不匹配", visual_not_checked: "尚未确认实际画面",
  device_failure: "此设备未能正常使用", other_uncertain: "其他未确定情况",
};
const reasonKeys = {
  technical: ["authentication_required", "network_unavailable", "upstream_unavailable", "visual_not_checked", "other_uncertain"],
  scene: ["scene_not_matched", "visual_not_checked", "other_uncertain"],
  device: ["authentication_required", "network_unavailable", "upstream_unavailable", "device_failure", "other_uncertain"],
} satisfies Record<Save["dimension"], NonNullable<Save["reason"]>[]>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function savedIntent(key: string): string | null {
  try { const id = window.sessionStorage?.getItem(key); return id && uuid.test(id) ? id : null; }
  catch { return null; }
}
function rememberIntent(key: string, id: string | null) {
  try { if (id) window.sessionStorage?.setItem(key, id); else window.sessionStorage?.removeItem(key); }
  catch { /* Current component still retains the intent and prevents automatic retries. */ }
}

/** Evidence is independent of approval. Unknown writes recover by GET, never by POST replay. */
export function VRChecks({ id, revision, publishedRevision, url, session, blocked, onActivity, onRefreshResource }: {
  id: string; revision: number; publishedRevision: number; url: string; session: StaffSession;
  blocked: boolean; onActivity: (busy: boolean, pending: boolean) => void; onRefreshResource: () => void;
}) {
  const path = `/resources/${id}/vr-checks`;
  const intentKey = `twinnku:staff:vr-check:${session.user.id}:${id}`;
  const [data, setData] = useState<Checks | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(() => savedIntent(intentKey));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dimension, setDimension] = useState(0);
  const [result, setResult] = useState<Save["result"]>("uncertain");
  const [reason, setReason] = useState<NonNullable<Save["reason"]>>("other_uncertain");
  const [environment, setEnvironment] = useState("");
  const [notes, setNotes] = useState("");
  const generation = useRef(0), writing = useRef(false), activity = useRef(onActivity);
  activity.current = onActivity;
  useEffect(() => { activity.current(busy, !!pending); }, [busy, pending]);
  useEffect(() => {
    const current = ++generation.current, abort = new AbortController();
    setLoading(true); setData(null); setError("");
    void request<Checks>(path, "GET", undefined, abort.signal).then(({data}) => {
      if (!abort.signal.aborted && current === generation.current) setData(data);
    }).catch((e) => { if (!abort.signal.aborted && current === generation.current) setError(message(e)); })
      .finally(() => { if (!abort.signal.aborted && current === generation.current) setLoading(false); });
    return () => { abort.abort(); ++generation.current; };
  }, [path, session.user.id, revision, publishedRevision, refresh]);
  useEffect(() => () => { activity.current(false, false); }, []);
  const canRecord = session.permissions.some((permission) => permission === "points.edit" || permission === "points.review");
  const stale = !!data && (data.expected_revision !== revision || data.expected_published_revision !== publishedRevision);
  const [kind, platform] = dimensions[dimension];
  const checkedReceipt = (check: Check | null, operationId: string) => {
    if (check && (check.operation_id !== operationId || check.method !== "manual")) throw new Error("原核查回执身份不匹配，请保留操作编号并重新查询。");
    return check;
  };
  const recover = async (operationId: string) => checkedReceipt((await request<Check | null>(`${path}/operations/${operationId}`)).data, operationId);
  function confirmed(check: Check) {
    rememberIntent(intentKey, null); setPending(null);
    setNotice(check.stale ? "原登记已确认，链接已变化，此记录不适用于当前链接。" : "人工核查记录已登记。内容发布状态保持不变。");
    setRefresh((value) => value + 1);
  }
  async function record() {
    if (!data || blocked || busy || pending || stale || !canRecord || writing.current) return;
    writing.current = true; setBusy(true); setError(""); setNotice("");
    const operationId = crypto.randomUUID(), current = generation.current;
    rememberIntent(intentKey, operationId); setPending(operationId);
    const body: Save = { operation_id: operationId, expected_revision: data.expected_revision,
      expected_published_revision: data.expected_published_revision, dimension: kind, platform,
      result, reason: result === "passed" ? "none" : reason, environment: environment.trim(), notes: notes.trim() };
    try {
      const check = await confirmedOperation(operationId,
        async () => {
          const value = checkedReceipt((await request<Check>(path, "POST", body)).data, operationId);
          if (!value) throw new Error("原核查回执缺失。");
          return value;
        }, recover);
      if (current === generation.current) confirmed(check);
      else rememberIntent(intentKey, null);
    } catch (e) {
      if (current !== generation.current) return;
      if (!(e instanceof UnconfirmedOperation)) { rememberIntent(intentKey, null); setPending(null); }
      setError(message(e));
    } finally { writing.current = false; if (current === generation.current) setBusy(false); }
  }
  async function query() {
    if (!pending || busy || writing.current) return;
    const operationId = pending, current = generation.current;
    writing.current = true; setBusy(true); setError("");
    try {
      const check = await recover(operationId);
      if (current !== generation.current) return;
      if (check) confirmed(check);
      else setNotice("暂未查到原登记；这不能证明原请求失败。请稍后再次查询，不要重复提交。");
    } catch(e) { if (current === generation.current) setError(message(e)); }
    finally { writing.current = false; if (current === generation.current) setBusy(false); }
  }
  return <section className="ad-vr-checks" aria-label="VR 人工核查记录" aria-busy={loading || busy}>
    <h3>人工核查记录</h3>
    <p>分别记录入口、场景和实际设备结果。入口可访问不代表全景画面可见，也不代表手机可用。登记不提审、不批准或发布内容。</p>
    <p>下方时间为服务端<strong>记录时间</strong>，不是实际测试时刻。设备环境、人员及备注只供有范围权限的成员查看。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在读取核查记录…</p>}
    {!loading && !data && <button onClick={() => setRefresh((value) => value + 1)}>重读核查记录</button>}
    {data && !stale && <dl className="ad-vr-check-grid">{dimensions.map(([kind, platform, title]) => {
      const item = (data.latest ?? []).find((check) => check.dimension === kind && check.platform === platform && !check.stale);
      return <div key={`${kind}:${platform}`}><dt>{title}</dt><dd>{item ? results[item.result] : "当前链接尚无记录"}</dd>
        {item && <dd>记录时间：<time dateTime={item.recorded_at}>{new Date(item.recorded_at).toLocaleString("zh-CN")}</time></dd>}</div>;
    })}</dl>}
    {blocked && <p>请先完成并保存当前资料操作，再针对保存的链接登记核查。</p>}
    {stale && <p role="alert">资料版本已改变，请重新打开当前资料后登记。<button disabled={busy || !!pending} onClick={onRefreshResource}>重新读取 VR 资料</button></p>}
    {pending && <div role="status"><p>原登记结果待确认。查询不会重新执行登记。</p><button disabled={busy} onClick={() => void query()}>查询原核查登记结果</button></div>}
    {!pending && canRecord && <form onSubmit={(event) => { event.preventDefault(); void record(); }}>
      <fieldset disabled={blocked || busy || loading || !data || stale}>
        <label>核查维度<select value={dimension} onChange={(event) => { setDimension(Number(event.target.value)); setResult("uncertain"); setReason("other_uncertain"); }}>{dimensions.map(([, ,title],index) => <option key={index} value={index}>{title}</option>)}</select></label>
        <label>实际结果<select value={result} onChange={(event) => { const value = event.target.value as Save["result"]; setResult(value); setReason(value === "passed" ? "none" : "other_uncertain"); }}><option value="uncertain">结果不确定</option><option value="passed">实际人工核查通过</option><option value="failed">实际人工核查失败</option></select></label>
        {result !== "passed" && <label>受控原因<select value={reason} onChange={(event) => setReason(event.target.value as NonNullable<Save["reason"]>)}>{reasonKeys[kind].map((key) => <option key={key} value={key}>{reasons[key]}</option>)}</select></label>}
        <label>设备与浏览器环境{platform && "（必填）"}<input value={environment} required={!!platform} maxLength={200} onChange={(event) => setEnvironment(event.target.value)} placeholder="记录实际使用的设备、系统和浏览器，不填写账号或凭据" /></label>
        <label>内部核查备注<textarea value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} /></label>
        <button type="submit">登记本次人工核查</button>
      </fieldset>
    </form>}
    {!blocked && !stale && externalPanoramaUrl(url) && <a href={externalPanoramaUrl(url)!} target="_blank" rel="noopener noreferrer">在原站人工查看（新标签页）</a>}
    {data && <details><summary>最近核查历史{data.has_more ? "（仅显示最近 50 条）" : ""}</summary>
      {!data.items.length && <p>暂无核查记录。</p>}
      <ul>{data.items.map((item) => <li key={item.id}>
        <strong>{dimensions.find(([kind, platform]) => kind === item.dimension && platform === item.platform)?.[2]}</strong> · {results[item.result]}{item.stale && " · 不适用于当前链接"}
        <p>记录时间：<time dateTime={item.recorded_at}>{new Date(item.recorded_at).toLocaleString("zh-CN")}</time> · 人工登记</p>
        {item.reason !== "none" && <p>{reasons[item.reason]}</p>}{item.environment && <p>环境：{item.environment}</p>}{item.notes && <p>内部备注：{item.notes}</p>}
        <details><summary>归因详情</summary><p>登记人员 ID：{item.recorded_by}</p><p>操作编号：{item.operation_id}</p></details>
      </li>)}</ul>
    </details>}
  </section>;
}
