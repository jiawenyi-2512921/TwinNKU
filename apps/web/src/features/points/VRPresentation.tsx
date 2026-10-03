import { useEffect, useState } from "react";
import type { Panorama } from "../../shared/api/client";
import { safePanoramaCover } from "./panorama";
import "./vr-presentation.css";

export function VRCover({ item }: { item: Panorama }) {
  const url = safePanoramaCover(item), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [url]);
  return url && failed !== url ? <figure className="vr-cover"><img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} /><figcaption>已发布图片封面 · 全景在原站打开</figcaption></figure> : null;
}
export function VRCheckSummary({ checks }: { checks?: Panorama["checks"] }) {
  const dimensions = [["原站入口", checks?.technical], ["场景匹配", checks?.scene],
    ["桌面浏览器", checks?.devices?.desktop], ["Android", checks?.devices?.android],
    ["iOS", checks?.devices?.ios], ["微信内置浏览器", checks?.devices?.wechat]] as const;
  return <details className="vr-safe-checks"><summary>人工核查记录</summary>
    <p>入口可访问不代表全景画面或设备可用。以下为人工登记的结果；记录时间不代表实际测试时刻，也不保证现在仍可访问。</p>
    <dl>{dimensions.map(([label, value]) => {
      const status = value?.method === "manual" ? value.result : "unchecked";
      const time = value?.method === "manual" && value.recorded_at && Number.isFinite(Date.parse(value.recorded_at)) ? value.recorded_at : null;
      const result = status === "passed" ? "人工记录：已通过该项核查" : status === "failed" ? "人工记录：该项核查未通过" : status === "uncertain" ? "人工记录：结果不确定" : "尚无人工核查记录";
      return <div key={label}><dt>{label}</dt><dd>{result}</dd>{time && <dd>记录时间：<time dateTime={time}>{new Date(time).toLocaleString("zh-CN")}</time></dd>}</div>;
    })}</dl>
  </details>;
}
export function VRPresentation({ item, showDescription = true }: { item: Panorama; showDescription?: boolean }) {
  return <div className="vr-presentation"><VRCover item={item} />
    {showDescription && item.description && <p className="vr-description">{item.description}</p>}
    {item.observation_prompt && <section className="vr-observation"><strong>可以留意</strong><p>{item.observation_prompt}</p></section>}
    <VRCheckSummary checks={item.checks} />
  </div>;
}
