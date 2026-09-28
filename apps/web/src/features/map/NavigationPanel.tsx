import { useEffect, useRef, useState } from "react";
import { get, type MapInfo, type Point } from "../../shared/api/client";
import {
  post,
  type NavigationAvailability,
  type NavigationPath,
} from "../agent/native";
import "./navigation.css";

export type RouteSelection = {
  sequence: number;
  end: string;
  start?: string | null;
};
export function NavigationPanel({
  map,
  points,
  initial,
  onRoute,
  onClose,
}: {
  map: MapInfo;
  points: Point[];
  initial: RouteSelection;
  onRoute: (route: NavigationPath | null) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(initial.start ?? ""),
    [end, setEnd] = useState(initial.end);
  const [stepFree, setStepFree] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [availability, setAvailability] =
    useState<NavigationAvailability | null>(null);
  const [route, setRoute] = useState<NavigationPath | null>(null);
  const pending = useRef<AbortController | null>(null),
    generation = useRef(0);
  const routeRef = useRef(route);
  routeRef.current = route;
  const onRouteRef = useRef(onRoute);
  onRouteRef.current = onRoute;
  function clear() {
    generation.current++;
    pending.current?.abort();
    setRoute(null);
    onRoute(null);
    setBusy(false);
  }
  async function calculate(from = start, to = end) {
    if (!from || !to) {
      setError("请选择起点和终点。");
      return;
    }
    clear();
    const version = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await post<NavigationPath>(
        "/navigation/route",
        {
          map_id: map.id,
          map_revision: map.revision,
          start_point_id: from,
          end_point_id: to,
          step_free: stepFree,
        },
        "",
        controller.signal,
      );
      if (version !== generation.current || controller.signal.aborted) return;
      setRoute(next);
      onRoute(next);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "暂时无法计算路线");
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setStart(initial.start ?? "");
    setEnd(initial.end);
    clear();
    setError("");
    if (initial.start && initial.end)
      void calculate(initial.start, initial.end);
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [initial.sequence, map.id, map.revision]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function refresh() {
      try {
        const result = await get<NavigationAvailability>(
          `/navigation/maps/${map.id}`,
          controller.signal,
        );
        if (disposed) return;
        setAvailability(result.data);
        const current = routeRef.current;
        if (
          current &&
          (result.data.graph_revision !== current.graph_revision ||
            !result.data.available_point_ids.includes(current.start_point_id) ||
            !result.data.available_point_ids.includes(current.end_point_id))
        ) {
          setRoute(null);
          onRouteRef.current(null);
          setError("道路或入口状态已更新，请重新计算路线。");
        }
      } catch (e) {
        if (!disposed) {
          setAvailability(null);
          setRoute(null);
          onRouteRef.current(null);
          setError(
            e instanceof Error ? e.message : "路网状态读取失败，请重试。",
          );
        }
      }
    }
    void refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [map.id, map.revision]);
  useEffect(() => {
    if (!route) return;
    const timer = setTimeout(
      () => {
        setRoute(null);
        onRouteRef.current(null);
        setError("路线已过期，请重新计算以核对道路状态。");
      },
      Math.max(0, Date.parse(route.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [route]);
  return (
    <section className="navigation-panel" aria-label="校园步行导航">
      <header>
        <div>
          <small>校园导览</small>
          <h2>选择起点，查看路线</h2>
        </div>
        <button aria-label="关闭导航" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="navigation-hint">
        请自行选择出发地点，当前浏览位置不代表你的位置。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void calculate();
        }}
      >
        <label>
          从哪里出发
          <select
            value={start}
            onChange={(e) => {
              clear();
              setStart(e.target.value);
            }}
            required
          >
            <option value="">请选择起点</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          前往
          <select
            value={end}
            onChange={(e) => {
              clear();
              setEnd(e.target.value);
            }}
            required
          >
            <option value="">请选择终点</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="navigation-check">
          <input
            type="checkbox"
            checked={stepFree}
            onChange={(e) => {
              clear();
              setStepFree(e.target.checked);
            }}
          />
          仅使用已确认无台阶道路
        </label>
        <button className="primary-button" disabled={busy || !start || !end}>
          {busy ? "正在计算…" : "在地图显示路线"}
        </button>
      </form>
      {availability && !availability.ready && (
        <p className="navigation-note">{availability.message}</p>
      )}
      {error && (
        <p className="navigation-note" role="alert">
          {error}
        </p>
      )}
      {route && (
        <div role="status" className="navigation-result">
          <strong>
            已在地图高亮显示路线
            {route.distance_m != null ? ` · ${route.distance_m} 米` : ""}
          </strong>
          {route.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
    </section>
  );
}
