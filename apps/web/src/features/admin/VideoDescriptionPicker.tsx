import { useEffect, useState } from "react";
import { get } from "../../shared/api/client";
import type { Experience } from "../experiences/types";

export function VideoDescriptionPicker({ pointId, sourceId, value, revision, disabled, onChange }: {
  pointId: string; sourceId?: string; value?: string | null; revision?: number | null;
  disabled: boolean; onChange: (id: string | null, revision: number | null) => void;
}) {
  const [items, setItems] = useState<Experience[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setState("loading");
    if (!pointId) { setState("ready"); return () => controller.abort(); }
    void get<Experience[]>(`/experiences?${new URLSearchParams({ point_id: pointId, kind: "media" })}`, controller.signal)
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setItems(data.filter((item) => item.id !== sourceId && item.revision > 0 && Number.isInteger(item.revision)
          && item.content.kind === "media" && item.content.media_type === "video"
          && item.content.point_id === pointId && item.content.video_visual_information === "audio_complete"
          && !item.content.audio_description_video_id && !!item.content.video_accessibility_note?.trim()));
        setState("ready");
      }).catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [pointId, sourceId, retry]);
  const selected = items.find((item) => item.id === value && item.revision === revision);
  return <section className="ad-caption-editor" aria-label="口述描述版视频选择">
    <h4>口述描述版视频</h4>
    <p>选择同地点已发布且独立审核为“声音完整表达关键画面”的视频。不会自动选择或升级版本；关联仍须本稿独立审核。</p>
    <label>同地点正式视频
      <select disabled={disabled || !pointId} value={value ? `${value}:${revision}` : ""} onChange={(event) => {
        if (disabled) return;
        if (!event.target.value) { onChange(null, null); return; }
        if (state !== "ready") return;
        const row = items.find((item) => `${item.id}:${item.revision}` === event.target.value);
        if (row) onChange(row.id, row.revision);
      }}>
        <option value="">尚未关联</option>
        {value && !selected && <option value={`${value}:${revision}`}>当前关联版本{state === "ready" ? "暂不可用，请核对" : "尚待核对"}</option>}
        {items.map((item) => <option key={`${item.id}:${item.revision}`} value={`${item.id}:${item.revision}`}>{item.content.title} · 正式版本 {item.revision}</option>)}
      </select>
    </label>
    {state === "loading" && <p role="status">正在核对可关联视频…</p>}
    {state === "error" && <p role="alert">暂时无法读取候选。<button type="button" onClick={() => setRetry((value) => value + 1)}>重试视频候选</button></p>}
    {state === "ready" && !items.length && <p>当前地点没有符合条件的正式视频。请先制作并独立审核口述描述版，保留本稿待办。</p>}
  </section>;
}
