import { useEffect, useState } from "react";
import {
  get,
  type MapInfo,
  type MapFeatures,
  type Point,
} from "../../shared/api/client";
import { MapCanvas } from "../map/MapCanvas";
import { message } from "./api";
import { ErrorBox } from "./ui";
import "../map/map.css";

/** This preview reads published geometry, never serializes staff drafts into public navigation. */
export default function AdminTourMapPreview({
  campusId,
  pointId,
}: {
  campusId: string;
  pointId: string;
}) {
  const [maps, setMaps] = useState<MapInfo[]>([]),
    [mapId, setMapId] = useState("");
  const [points, setPoints] = useState<Point[]>([]),
    [features, setFeatures] = useState<MapFeatures | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setMaps([]);
    setMapId("");
    setPoints([]);
    setFeatures(null);
    setError("");
    setLoading(true);
    async function load() {
      const mapRows = (
        await get<MapInfo[]>(
          `/campuses/${encodeURIComponent(campusId)}/maps?kind=campus`,
          abort.signal,
        )
      ).data;
      const all: Point[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await get<Point[]>(
          `/campuses/${encodeURIComponent(campusId)}/points?${new URLSearchParams({ page: String(page), page_size: "100" })}`,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        all.push(...result.data);
        if (
          !result.meta.pagination ||
          page * result.meta.pagination.page_size >=
            result.meta.pagination.total
        )
          break;
        if (page === 100)
          throw new Error("校区公开地点超出预览读取边界，请联系维护人员检查。");
      }
      if (abort.signal.aborted) return;
      setMaps(mapRows);
      setMapId(mapRows[0]?.id ?? "");
      setPoints(all);
    }
    void load()
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [campusId, retry]);
  useEffect(() => {
    const abort = new AbortController();
    setFeatures(null);
    if (!mapId) return () => abort.abort();
    setLoading(true);
    setError("");
    void get<MapFeatures>(
      `/maps/${encodeURIComponent(mapId)}/features`,
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) setFeatures(result.data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [mapId, retry]);
  const info = maps.find((map) => map.id === mapId);
  const missing =
    features && !features.points.some((point) => point.point_id === pointId);
  return (
    <section className="ad-private-map-scene" aria-label="真实地图的员工预览">
      <h4>本站真实地图</h4>
      <p>
        使用公众当前有效的地点与几何，与员工草稿隔离。地图可缩放查看；不计算未实测距离，不写游客参观进度或公开视角。
      </p>
      <ErrorBox text={error} onRetry={() => setRetry((value) => value + 1)} />
      {maps.length > 1 && (
        <label>
          预览底图
          <select
            value={mapId}
            onChange={(event) => setMapId(event.target.value)}
          >
            {maps.map((map) => (
              <option key={map.id} value={map.id}>
                {map.title} · v{map.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      {loading && <p role="status">正在读取当前公开地图…</p>}
      {!loading && !error && !maps.length && (
        <p>
          该校区暂无当前可用的公开底图。讲稿和其他资料仍可预览，请先完成地点与底图维护。
        </p>
      )}
      {missing && (
        <p role="alert">
          本站地点没有当前底图上的公开几何。请在地点工作台核对和审核，不能用本次草稿预览证明定位已公开可用。
        </p>
      )}
      {info && features && (
        <div className="ad-private-map-canvas">
          <MapCanvas
            info={info}
            features={features}
            points={points}
            selectedId={pointId || null}
            previewOnly
            onSelect={() => {}}
          />
        </div>
      )}
    </section>
  );
}
