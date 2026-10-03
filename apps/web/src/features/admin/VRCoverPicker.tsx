import { useEffect, useState } from "react";
import { get } from "../../shared/api/client";
import type { Experience } from "../experiences/types";
import { safeMediaUrl } from "../experiences/progress";

/** Only the current point's public, independently published image versions are selectable. */
export function VRCoverPicker({ pointId, id, revision, disabled = false, onChange }: {
  pointId: string; id?: string | null; revision?: number | null;
  disabled?: boolean;
  onChange: (id: string | null, revision: number | null) => void;
}) {
  const [state, setState] = useState<{ point: string; loading: boolean; items: Experience[]; error: string }>({ point: "", loading: true, items: [], error: "" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ point: pointId, loading: true, items: [], error: "" });
    void get<Experience[]>(`/experiences?${new URLSearchParams({ kind: "media", point_id: pointId })}`, abort.signal)
      .then(({ data }) => {
        if (abort.signal.aborted) return;
        const items = data.filter((item) => item.content.kind === "media" && item.content.media_type === "image" && item.content.point_id === pointId && Number.isInteger(item.revision) && item.revision > 0);
        setState({ point: pointId, loading: false, items, error: "" });
      }).catch(() => { if (!abort.signal.aborted) setState({ point: pointId, loading: false, items: [], error: "暂时无法读取当前地点的正式图片。" }); });
    return () => abort.abort();
  }, [pointId, retry]);
  const current = state.point === pointId ? state : { loading: true, items: [], error: "" };
  const selected = current.items.find((item) => item.id === id && item.revision === revision);
  const selectedKey = id ? `${id}:${revision}` : "";
  const thumbnail = selected ? safeMediaUrl(selected.media_url) : null;
  return <section aria-label="VR 封面选择">
    <label>目录封面（选填）<select value={selectedKey} aria-busy={current.loading} disabled={disabled}
      onChange={(event) => {
        if (disabled) return;
        if (!event.target.value) { onChange(null, null); return; }
        if (current.loading || current.error) return;
        const item = current.items.find((candidate) => `${candidate.id}:${candidate.revision}` === event.target.value);
        if (item) onChange(item.id, item.revision);
      }}>
      <option value="">使用统一文字卡，不设置图片</option>
      {id && !selected && <option value={selectedKey}>{current.loading ? "正在核对原封面版本…" : current.error ? "原封面版本暂无法核对" : "原封面版本暂不可用，请核对或重新选择"}</option>}
      {current.items.map((item) => <option key={`${item.id}:${item.revision}`} value={`${item.id}:${item.revision}`}>{item.content.title} · 正式版本 {item.revision}</option>)}
    </select></label>
    <small>仅选择当前真实地点已经发布的图片，保存精确版本；不会默认挑选首图。图片更新或下架后，公开目录保留原 VR 链接并回退文字卡。</small>
    {current.loading && <p role="status">正在读取正式封面候选…</p>}
    {current.error && <p role="alert">{current.error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重读封面候选</button></p>}
    {!current.loading && !current.error && !current.items.length && <p>此地点暂无已发布图片，可先保存文字卡。</p>}
    {thumbnail && <img key={thumbnail} className="ad-vr-cover" src={thumbnail} alt={`已发布封面：${selected!.content.title}`} loading="lazy" referrerPolicy="no-referrer" />}
  </section>;
}
