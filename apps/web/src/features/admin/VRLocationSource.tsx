import { useEffect, useState } from "react";
import { request, message, type AdminPoint } from "./api";
import { get, type Campus } from "../../shared/api/client";
import { categoryLabels } from "../points/PointDetails";

export function VRLocationSource({ pointId, onPoint }: { pointId: string; onPoint?: (id: string) => void }) {
  const [data, setData] = useState<{ id: string; point: AdminPoint } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  useEffect(() => {
    const abort = new AbortController(); setData(null); setError("");
    void get<Campus[]>("/campuses", abort.signal).then(({data}) => {
      if (!abort.signal.aborted) setCampuses(data);
    }).catch(() => { if (!abort.signal.aborted) setCampuses([]); });
    void request<AdminPoint>(`/points/${pointId}`, "GET", undefined, abort.signal).then(({data}) => {
      if (!abort.signal.aborted && data.point.id === pointId) setData({ id: pointId, point: data });
    }).catch((e) => { if (!abort.signal.aborted) setError(message(e)); });
    return () => abort.abort();
  }, [pointId, retry]);
  const point = data?.id === pointId ? data.point : null;
  return <section className="ad-vr-location" aria-label="VR 地点与地图名称来源">
    <h3>真实地点与名称显示</h3>
    <p>归属、分类和常驻地图名称均由地点管理维护，VR 不保存另一份开关，也不修改底图烧录名称。</p>
    {point && <><p>{point.point.name} · {point.status === "published" && point.visibility === "public" ? "公开正式地点" : "尚未公开的地点"}</p>
      <p>所属校区：{campuses.find((campus) => campus.id === point.point.campus_id)?.name ?? "名称暂不可读取"} · 地点分类：{categoryLabels[point.point.category]}。</p>
      <p>已登记地图区域的常驻名称：{!point.geometries.length ? "尚无已登记交互区域" : point.geometries.every((geometry) => !geometry.label_on_map) ? "全部隐藏" : point.geometries.every((geometry) => geometry.label_on_map) ? "全部显示" : "由各地图区域分别设置"}。</p>
      <details><summary>地点与地图引用详情</summary><p>校区引用：{point.point.campus_id}</p>{point.geometries.map((geometry) => <p key={`${geometry.map_id}:${geometry.map_revision}`}>地图 {geometry.map_id} · 版本 {geometry.map_revision} · 常驻名称{geometry.label_on_map ? "显示" : "隐藏"}</p>)}</details>
      {point.draft && ["draft", "rejected", "in_review"].includes(point.draft.state) && <p>地点另有待处理草稿，上述来源为当前正式地点设置；草稿须独立审核。</p>}</>}
    {!point && !error && <p role="status">正在读取地点来源…</p>}
    {error && <p role="alert">{error}<button type="button" onClick={() => setRetry((value) => value + 1)}>重读地点来源</button></p>}
    {onPoint && <button type="button" onClick={() => onPoint(pointId)}>前往地点管理</button>}
  </section>;
}
