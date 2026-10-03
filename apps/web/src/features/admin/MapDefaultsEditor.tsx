import { useEffect, useState } from "react";
import {
  get,
  type MapInfo,
  type MapFeatures,
  type Point,
} from "../../shared/api/client";
import { MapCanvas } from "../map/MapCanvas";
import {
  mapCameraRange,
  validMapDefaultView,
  type MapDefaultView,
  type MapViewport,
} from "../map/mapDefaults";
import type { VisitDefaultsContent } from "./configurationTypes";
import { message, request } from "./api";
import { ErrorBox } from "./ui";
import "../map/map.css";

type Field =
  | "map_default_view"
  | "map_layers"
  | "map_show_labels"
  | "map_focus_effect";
type Props = {
  campusId: string;
  scope: string;
  value: VisitDefaultsContent;
  effective?: Partial<VisitDefaultsContent> | null;
  sources?: Record<string, "builtin" | "global" | "campus">;
  overrides: string[];
  disabled?: boolean;
  onChange: (patch: Partial<VisitDefaultsContent>) => void;
  onInherit: (field: Field) => void;
};

export function MapDefaultsEditor({
  campusId,
  scope,
  value,
  effective,
  sources,
  overrides,
  disabled = false,
  onChange,
  onInherit,
}: Props) {
  const current = <K extends Field>(field: K): VisitDefaultsContent[K] =>
    overrides.includes(field) || !effective || !(field in effective)
      ? value[field]
      : (effective[field] as VisitDefaultsContent[K]);
  const view = current("map_default_view");
  const [maps, setMaps] = useState<MapInfo[]>([]),
    [mapId, setMapId] = useState("");
  const [points, setPoints] = useState<Point[]>([]),
    [features, setFeatures] = useState<MapFeatures | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [loading, setLoading] = useState(false);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [minimum, setMinimum] = useState("-8"),
    [maximum, setMaximum] = useState("1");
  const [previewRequest, setPreviewRequest] = useState<{
    epoch: number;
    view: MapDefaultView | null;
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setMaps([]);
    setMapId("");
    setFeatures(null);
    setPoints([]);
    setViewport(null);
    setPreviewRequest(null);
    setError("");
    setLoading(true);
    void request<MapInfo[]>("/maps", "GET", undefined, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        const available = result.data.filter(
          (map) =>
            map.kind === "campus" && map.campus_id === campusId && !!map.tiles,
        );
        setMaps(available);
        setMapId(
          available.find((map) => map.id === view?.map_id)?.id ??
            available[0]?.id ??
            "",
        );
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // A draft edit does not reload the metadata or interrupt a manual preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusId, retry]);
  const info = maps.find((map) => map.id === mapId);
  useEffect(() => {
    const abort = new AbortController();
    setFeatures(null);
    setPoints([]);
    setViewport(null);
    setPreviewRequest(null);
    if (!info) return () => abort.abort();
    const range = mapCameraRange(info);
    const matching = validMapDefaultView(view, info) ? view : null;
    setMinimum(String(matching?.min_zoom ?? range.min));
    setMaximum(String(matching?.max_zoom ?? range.max));
    setLoading(true);
    setError("");
    async function load() {
      const geometry = (
        await get<MapFeatures>(
          `/maps/${encodeURIComponent(info!.id)}/features`,
          abort.signal,
        )
      ).data;
      if (abort.signal.aborted) return;
      if (
        geometry.map_id !== info!.id ||
        geometry.map_revision !== info!.revision
      )
        throw new Error("底图版本在读取期间改变，请重新读取地图后取景。");
      const all: Point[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await get<Point[]>(
          `/campuses/${encodeURIComponent(campusId)}/points?${new URLSearchParams({ page: String(page), page_size: "100" })}`,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        all.push(...result.data);
        const pagination = result.meta.pagination;
        if (!pagination || page * pagination.page_size >= pagination.total)
          break;
        if (page === 100)
          throw new Error("公开地点超出取景读取边界，请联系维护人员检查。");
      }
      if (abort.signal.aborted) return;
      setFeatures(geometry);
      setPoints(all);
    }
    void load()
      .catch((reason) => {
        if (!abort.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // View edits are explicit adoption; geometry is keyed by real map identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, campusId, retry]);
  const candidate =
    viewport && minimum.trim() && maximum.trim()
      ? {
          ...viewport,
          min_zoom: Number(minimum),
          max_zoom: Number(maximum),
        }
      : null;
  const capturable =
    !!info &&
    !!features &&
    !loading &&
    !error &&
    validMapDefaultView(candidate, info);
  const matching = !!info && validMapDefaultView(view, info);
  const source = (field: Field) => {
    if (overrides.includes(field))
      return scope === "global" ? "全站草稿覆盖" : "本校区草稿覆盖";
    const inherited = sources?.[field];
    return inherited === "global"
      ? "继承已审全站设置"
      : inherited === "builtin"
        ? "继承系统默认"
        : inherited === "campus"
          ? "本校区设置"
          : "正在核对继承来源";
  };
  const inheritButton = (field: Field) => (
    <button
      type="button"
      disabled={disabled || !overrides.includes(field)}
      onClick={() => onInherit(field)}
    >
      恢复继承
      {field === "map_default_view"
        ? "视角"
        : field === "map_layers"
          ? "图层"
          : field === "map_show_labels"
            ? "名称"
            : "定位效果"}
    </button>
  );
  function preview(next: MapDefaultView | null) {
    setViewport(null);
    setPreviewRequest((previous) => ({
      epoch: (previous?.epoch ?? 0) + 1,
      view: next,
    }));
  }
  return (
    <section className="ad-map-defaults" aria-label="地图默认设置">
      <h4>地图默认视角</h4>
      <p>
        先选择当前公开底图，拖动或缩放取景，再明确采用。这里只保存经审核的展示默认值，不代表
        GPS、实测距离或新的道路数据。
      </p>
      <p role="status">
        视角来源：{source("map_default_view")} ·{" "}
        {view ? "使用已保存视角" : "适合全图"}
      </p>
      {view && !matching && info && (
        <p role="alert">
          已保存视角不适用于当前底图或版本。公众会适合全图；请重新取景或恢复继承，提审前仍须通过底图校验。
        </p>
      )}
      {scope === "global" && (
        <small>
          全站视角仅用于绑定的底图，其他校区仍适合全图。切换上方预览校区可选择该校区底图。
        </small>
      )}
      <label>
        真实公开底图
        <select
          value={mapId}
          onChange={(event) => setMapId(event.target.value)}
          disabled={loading && !maps.length}
        >
          {!maps.length && <option value="">暂无可用底图</option>}
          {maps.map((map) => (
            <option key={map.id} value={map.id}>
              {map.title} · v{map.revision} · {map.width_px}×{map.height_px}{" "}
              像素
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => setRetry((n) => n + 1)}>
        重新读取底图
      </button>
      {view &&
        view.map_id !== mapId &&
        maps.some((map) => map.id === view.map_id) && (
          <button type="button" onClick={() => setMapId(view.map_id)}>
            查看已保存视角的底图
          </button>
        )}
      <ErrorBox text={error} onRetry={() => setRetry((n) => n + 1)} />
      {loading && <p role="status">正在读取授权底图和全部公开地点…</p>}
      {!loading && !error && !maps.length && (
        <p>
          该校区没有可采用的公开底图。可保留适合全图或继承设置，不能手填底图
          ID。
        </p>
      )}
      {info && features && !loading && !error && (
        <>
          <div className="ad-private-map-canvas">
            <MapCanvas
              key={`${info.id}:${info.revision}:${previewRequest?.epoch ?? 0}`}
              info={info}
              features={features}
              points={points}
              selectedId={null}
              previewOnly
              showLabels={current("map_show_labels")}
              showRegions={current("map_layers").includes("point_regions")}
              focusEffect={current("map_focus_effect")}
              defaultView={previewRequest ? previewRequest.view : view}
              defaultsReady={
                !!previewRequest ||
                overrides.includes("map_default_view") ||
                !!effective
              }
              onViewportChange={setViewport}
              onSelect={() => {}}
            />
          </div>
          <p>
            当前底图相机范围：{mapCameraRange(info).min} 至{" "}
            {mapCameraRange(info).max}。负值用于缩小整图，和源瓦片层级分别处理。
          </p>
          <div className="ad-map-range">
            <label>
              访客允许的最小缩放
              <input
                type="number"
                step="0.25"
                min={mapCameraRange(info).min}
                max={mapCameraRange(info).max}
                value={minimum}
                disabled={disabled}
                onChange={(e) => setMinimum(e.target.value)}
              />
            </label>
            <label>
              访客允许的最大缩放
              <input
                type="number"
                step="0.25"
                min={mapCameraRange(info).min}
                max={mapCameraRange(info).max}
                value={maximum}
                disabled={disabled}
                onChange={(e) => setMaximum(e.target.value)}
              />
            </label>
          </div>
          <p role="status">
            {viewport
              ? `取景中心：${viewport.center.x.toFixed(1)}, ${viewport.center.y.toFixed(1)} 像素；缩放 ${viewport.zoom.toFixed(2)}`
              : "等待地图报告当前取景。"}
            {viewport && !capturable
              ? " 当前中心或缩放范围不合法，请调整后采用。"
              : " 拖动仅供预览，采用才会保存草稿。"}
          </p>
          <button
            type="button"
            disabled={disabled || !capturable}
            onClick={() => {
              if (capturable && candidate)
                onChange({ map_default_view: candidate });
            }}
          >
            采用当前地图视角
          </button>
          <button
            type="button"
            disabled={!matching}
            onClick={() => preview(view)}
          >
            查看已配置默认视角
          </button>
          <button type="button" onClick={() => preview(null)}>
            查看全图（仅预览）
          </button>
        </>
      )}
      <div className="ad-map-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange({ map_default_view: null });
            preview(null);
          }}
        >
          设置为适合全图
        </button>
        {inheritButton("map_default_view")}
      </div>
      <h4>默认显示与定位</h4>
      <label className="ad-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={current("map_layers").includes("point_regions")}
          onChange={(e) =>
            onChange({ map_layers: e.target.checked ? ["point_regions"] : [] })
          }
        />
        显示地点区域覆盖层
      </label>
      <small>
        {source("map_layers")}。底图、选中地点、路线端点与必要导航始终保留。
      </small>
      {inheritButton("map_layers")}
      <label className="ad-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={current("map_show_labels")}
          onChange={(e) => onChange({ map_show_labels: e.target.checked })}
        />
        默认显示地图名称
      </label>
      <small>
        {source("map_show_labels")}
        。地点自身的隐藏名称设置仍有效，底图烧录文字不能擦除。
      </small>
      {inheritButton("map_show_labels")}
      <label>
        定位效果
        <select
          disabled={disabled}
          value={current("map_focus_effect")}
          onChange={(e) =>
            onChange({
              map_focus_effect:
                e.target.value === "instant" ? "instant" : "short",
            })
          }
        >
          <option value="instant">瞬时定位</option>
          <option value="short">短动画定位</option>
        </select>
      </label>
      <small>
        {source("map_focus_effect")}。访客开启减少动态效果时始终使用瞬时定位。
      </small>
      {inheritButton("map_focus_effect")}
    </section>
  );
}
