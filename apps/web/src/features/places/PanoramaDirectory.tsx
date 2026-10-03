import { useEffect, useState } from "react";
import {
  api,
  type Campus,
  type PanoramaDirectoryItem,
} from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { Icon } from "../../shared/ui/Icon";
import { externalPanoramaUrl } from "../points/panorama";
import { categoryLabels } from "../points/PointDetails";
import { VRPresentation } from "../points/VRPresentation";
import { pauseTour } from "../visit/audioOwner";
import {
  findPanoramas,
  loadPanoramaDirectory,
  panoramaScene,
  type PanoramaGroup,
} from "./panoramas";
import "./panoramas.css";

export function PanoramaDirectory({
  campus,
  campusStatus = "loading",
  onRetryCampus,
  query,
  locatedPointIds,
  onLocate,
}: {
  campus: Campus | null;
  campusStatus?: "loading" | "ready" | "empty" | "error";
  onRetryCampus?: () => void;
  query: string;
  locatedPointIds: readonly string[];
  onLocate: (pointId: string) => void;
}) {
  const [state, setState] = useState<{
    campusId: string;
    status: "loading" | "ready" | "error";
    items: PanoramaDirectoryItem[];
  }>({ campusId: "", status: "loading", items: [] });
  const [retry, setRetry] = useState(0);
  const [group, setGroup] = useState<PanoramaGroup>("all");
  useEffect(() => setGroup("all"), [campus?.id]);
  useEffect(() => {
    if (!campus) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let generation = 0;
    const load = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const current = ++generation;
      setState((previous) => ({
        campusId: campus.id,
        status: "loading",
        items: previous.campusId === campus.id ? previous.items : [],
      }));
      try {
        const items = await loadPanoramaDirectory(
          api,
          campus.id,
          request.signal,
        );
        if (!disposed && current === generation && !request.signal.aborted)
          setState({ campusId: campus.id, status: "ready", items });
      } catch {
        if (!disposed && current === generation && !request.signal.aborted)
          setState((previous) => ({
            campusId: campus.id,
            status: "error",
            items: previous.campusId === campus.id ? previous.items : [],
          }));
      }
    };
    const stop = watchCatalogChanges(load);
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      stop();
    };
  }, [campus?.id, retry]);
  // Remove previous-campus links during rendering, before effect cleanup runs.
  const current =
    state.campusId === campus?.id ? state : { status: "loading", items: [] };
  const allItems = findPanoramas(current.items, campus?.id ?? "", "", "all");
  const items = findPanoramas(current.items, campus?.id ?? "", query, group);
  const detailFor = (item: PanoramaDirectoryItem) => {
    const scene = panoramaScene(item.url);
    const same = allItems.filter(
      (other) =>
        other.title === item.title &&
        other.point_name === item.point_name &&
        panoramaScene(other.url) === scene,
    );
    return `${scene ?? "全景"}${same.length > 1 ? ` · 入口 ${same.findIndex((other) => other.id === item.id) + 1}` : ""}`;
  };
  const ready = current.status === "ready";
  if (!campus)
    return (
      <section
        className="vr-directory"
        aria-label="VR 全景目录"
        aria-busy={campusStatus === "loading"}
      >
        <div className="point-list-scroll">
          {campusStatus === "loading" ? (
            <p className="list-loading" role="status">
              <span className="spinner" /> 正在读取校区…
            </p>
          ) : (
            <div
              className="no-results"
              role={campusStatus === "error" ? "alert" : "status"}
            >
              <p>
                {campusStatus === "error"
                  ? "暂时无法读取校区资料，请检查网络后重试。"
                  : "暂无公开校区资料。"}
              </p>
              {onRetryCampus && (
                <button className="text-button" onClick={onRetryCampus}>
                  重新加载校区
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    );
  return (
    <section
      className="vr-directory"
      aria-label="VR 全景目录"
      aria-busy={current.status === "loading"}
    >
      <div className="vr-campus-heading">
        <strong>{campus?.name ?? "正在读取校区"}</strong>
        <span role="status">
          {allItems.length || ready ? `${items.length} 个全景` : ""}
        </span>
      </div>
      <div
        className="category-filters"
        role="group"
        aria-label="按全景地点类型筛选"
      >
        {(
          [
            ["all", "全部"],
            ["outdoor", "室外景点"],
            ["building", "教学建筑"],
            ["other", "其他地点"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={group === id}
            onClick={() => setGroup(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="point-list-scroll">
        {current.status === "loading" && (
          <p className="list-loading" role="status">
            <span className="spinner" />
            {allItems.length ? "正在核验全景目录…" : "正在读取已发布全景…"}
          </p>
        )}
        {current.status === "error" && (
          <div className="no-results" role="alert">
            <p>暂时无法读取全景目录，请检查网络后重试。</p>
            <button
              className="text-button"
              onClick={() => setRetry((v) => v + 1)}
            >
              重新加载全景
            </button>
          </div>
        )}
        {ready && !items.length && (
          <div className="no-results" role="status">
            <strong>
              {query.trim() || group !== "all"
                ? "没有匹配的全景"
                : "本校区暂无已发布全景"}
            </strong>
            <p>
              {query.trim() || group !== "all"
                ? "试试其他地点名称或场景编号。"
                : "全景资料发布后会在这里显示。"}
            </p>
            {group !== "all" && (
              <button className="text-button" onClick={() => setGroup("all")}>
                查看全部类型
              </button>
            )}
          </div>
        )}
        {!!items.length && (
          <ul className="vr-list">
            {items.map((item) => {
              const located = locatedPointIds.includes(item.point_id);
              const detail = detailFor(item);
              return (
                <li key={item.id} className="vr-card">
                  <div className="vr-card-heading">
                    <Icon name="panorama" size={21} />
                    <div>
                      <h3>{item.title}</h3>
                      <p>
                        {item.point_name} ·{" "}
                        {categoryLabels[item.point_category]}
                      </p>
                      <small>{detail}</small>
                    </div>
                  </div>
                  <VRPresentation item={item} />
                  <div className="vr-card-actions">
                    <button
                      data-place-result
                      disabled={!ready || !located}
                      aria-label={`地图定位 ${item.title} ${detail}`}
                      onClick={() => onLocate(item.point_id)}
                    >
                      <Icon name="pin" size={16} /> 地图定位
                    </button>
                    <a
                      href={ready ? externalPanoramaUrl(item.url)! : undefined}
                      aria-disabled={!ready || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={pauseTour}
                      aria-label={`打开 VR ${item.title} ${detail}（新标签页）`}
                    >
                      <Icon name="link" size={16} /> 打开 VR{" "}
                      <span className="sr-only">（新标签页）</span>
                    </a>
                  </div>
                  {!located && (
                    <small className="vr-unlocated">
                      此地点暂无当前底图定位
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer className="directory-footer">
        <small>地图定位留在本站；打开 VR 在原网站新标签页浏览。</small>
      </footer>
    </section>
  );
}
