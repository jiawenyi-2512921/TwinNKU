import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { loadCatalog, reconcileCatalog, type Catalog } from "../map/catalog";

const MapCanvas = lazy(() =>
  import("../map/MapCanvas").then((module) => ({ default: module.MapCanvas })),
);

// This shows published locations, never an implied walkable route or private geometry.
export function RouteDistribution({
  campusId,
  pointIds,
  onSelect,
}: {
  campusId: string;
  pointIds: string[];
  onSelect: (pointId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const key = [...new Set(pointIds)].join("|");
  useEffect(() => {
    setCatalog(null);
    setSelectedId(null);
    if (!expanded) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const read = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      setState((previous) => (previous === "ready" ? previous : "loading"));
      try {
        const result = await loadCatalog(
          {
            ...api,
            campuses: async (s) => {
              const response = await api.campuses(s);
              return {
                ...response,
                data: response.data.filter((row) => row.id === campusId),
              };
            },
          },
          signal,
        );
        if (disposed || signal.aborted) return;
        const requested = new Set(key.split("|"));
        const points =
          result?.points.filter(
            (point) => requested.has(point.id) && point.campus_id === campusId,
          ) ?? [];
        if (
          !result?.map ||
          !result.features ||
          result.map.campus_id !== campusId ||
          !points.length
        ) {
          setCatalog(null);
          setState("empty");
          return;
        }
        const allowed = new Set(points.map((point) => point.id));
        const features = result.features;
        setCatalog((previous) =>
          reconcileCatalog(previous, {
            ...result,
            points,
            features: {
              ...features,
              points: features.points.filter((feature) =>
                allowed.has(feature.point_id),
              ),
            },
          }),
        );
        setSelectedId((before) =>
          before && allowed.has(before) ? before : null,
        );
        setState("ready");
      } catch {
        if (!disposed && !signal.aborted) {
          setCatalog(null);
          setState("error");
        }
      }
    };
    void read();
    const unsubscribe = watchCatalogChanges(read);
    return () => {
      disposed = true;
      controller?.abort();
      unsubscribe();
    };
  }, [campusId, key, expanded, retry]);
  return (
    <section className="overview-distribution" aria-label="路线地点分布">
      <h2>地点分布</h2>
      <p>
        查看本站已发布地图上的地点位置。站点顺序是讲解顺序；这里不绘制步行路线。
      </p>
      <button
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "收起地点地图" : "查看地点地图"}
      </button>
      {expanded && (
        <div className="overview-distribution-content">
          {state === "loading" && (
            <p role="status">正在读取已发布地图和地点…</p>
          )}
          {state === "error" && (
            <p role="alert">
              地点地图暂时无法读取，站点目录仍可使用。
              <button onClick={() => setRetry((value) => value + 1)}>
                重试地点地图
              </button>
            </p>
          )}
          {state === "empty" && (
            <p role="status">
              当前路线尚无可显示的已发布地图位置，请使用站点目录选择开始。
            </p>
          )}
          {state === "ready" && catalog?.map && catalog.features && (
            <>
              <div className="overview-distribution-map">
                <Suspense fallback={<p role="status">正在展开地点地图…</p>}>
                  <MapCanvas
                    info={catalog.map}
                    features={catalog.features}
                    points={catalog.points}
                    selectedId={selectedId}
                    highlightedPointIds={catalog.points.map(
                      (point) => point.id,
                    )}
                    previewOnly
                    showLabels={false}
                    onSelect={(id) => {
                      if (
                        id &&
                        catalog.points.some((point) => point.id === id)
                      ) {
                        setSelectedId(id);
                        onSelect(id);
                      }
                    }}
                  />
                </Suspense>
              </div>
              {new Set(pointIds).size > catalog.points.length && (
                <p>
                  部分站点尚无当前已发布的地图点击范围；仍可从下方目录开始。
                </p>
              )}
              {selectedId && (
                <p role="status">
                  已选择{" "}
                  {
                    catalog.points.find((point) => point.id === selectedId)
                      ?.name
                  }
                  ，可在上方“开始参观”进入。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
