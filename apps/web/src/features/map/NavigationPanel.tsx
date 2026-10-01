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
export type RoutePickMode = "start" | "end" | null;
export type RoutePickedPoint = { sequence: number; id: string };
export type RouteSelectionState = {
  start: string;
  end: string;
  availablePointIds: string[];
};
export function NavigationPanel({
  map,
  points,
  initial,
  onRoute,
  onClose,
  pickMode = null,
  pickedPoint = null,
  onPickMode,
  onSelectionChange,
}: {
  map: MapInfo;
  points: Point[];
  initial: RouteSelection;
  onRoute: (route: NavigationPath | null) => void;
  onClose: () => void;
  pickMode?: RoutePickMode;
  pickedPoint?: RoutePickedPoint | null;
  onPickMode?: (mode: RoutePickMode) => void;
  onSelectionChange?: (selection: RouteSelectionState) => void;
}) {
  const [start, setStart] = useState(initial.start ?? ""),
    [end, setEnd] = useState(initial.end);
  const [stepFree, setStepFree] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [availability, setAvailability] =
    useState<NavigationAvailability | null>(null);
  const [route, setRoute] = useState<NavigationPath | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const pending = useRef<AbortController | null>(null),
    generation = useRef(0);
  const availabilityRef = useRef(availability);
  const routeRef = useRef(route);
  routeRef.current = route;
  const callbacks = useRef({ onRoute, onPickMode, onSelectionChange });
  callbacks.current = { onRoute, onPickMode, onSelectionChange };
  const autoStart = useRef<RouteSelection | null>(null);
  const handledPick = useRef<number | null>(null);
  const availablePointIds = availability?.ready
    ? points
        .filter((point) => availability.available_point_ids.includes(point.id))
        .map((point) => point.id)
    : [];
  const canRoute =
    availablePointIds.includes(start) &&
    availablePointIds.includes(end) &&
    start !== end;

  function cancelRequest() {
    generation.current++;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }
  function clear() {
    cancelRequest();
    setRoute(null);
    routeRef.current = null;
    callbacks.current.onRoute(null);
  }
  async function calculate(from = start, to = end) {
    const graph = availabilityRef.current;
    if (!from || !to || from === to) {
      setError(
        from === to && from ? "起点和终点不能相同。" : "请选择起点和终点。",
      );
      return;
    }
    if (
      !graph?.ready ||
      graph.map_id !== map.id ||
      graph.map_revision !== map.revision ||
      !graph.available_point_ids.includes(from) ||
      !graph.available_point_ids.includes(to) ||
      !points.some((point) => point.id === from) ||
      !points.some((point) => point.id === to)
    ) {
      setError("所选地点暂无可用入口，请选择地图中高亮的地点。");
      return;
    }
    callbacks.current.onPickMode?.(null);
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
          graph_revision: graph.graph_revision,
          start_point_id: from,
          end_point_id: to,
          step_free: stepFree,
        },
        "",
        controller.signal,
      );
      if (version !== generation.current || controller.signal.aborted) return;
      if (
        next.map_id !== map.id ||
        next.graph_revision !== availabilityRef.current?.graph_revision
      ) {
        setError("道路或入口状态已更新，请重新计算路线。");
        return;
      }
      setRoute(next);
      routeRef.current = next;
      callbacks.current.onRoute(next);
    } catch (e) {
      if (version === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "暂时无法计算路线，请重试。");
    } finally {
      if (version === generation.current) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    setStart(initial.start ?? "");
    setEnd(initial.end);
    clear();
    setError("");
    callbacks.current.onPickMode?.(null);
    autoStart.current = initial.start && initial.end ? initial : null;
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [initial.sequence, map.id, map.revision]);
  useEffect(() => {
    let disposed = false;
    let activeRead: AbortController | null = null;
    availabilityRef.current = null;
    setAvailability(null);
    async function refresh() {
      activeRead?.abort();
      const controller = new AbortController();
      activeRead = controller;
      try {
        const result = await get<NavigationAvailability>(
          `/navigation/maps/${map.id}`,
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return;
        const next = result.data;
        if (next.map_id !== map.id || next.map_revision !== map.revision)
          throw new Error("地图版本已更新，请刷新页面后再试。");
        const previous = availabilityRef.current;
        availabilityRef.current = next;
        setAvailability(next);
        if (!previous) setError("");
        const current = routeRef.current;
        if (
          (previous &&
            (previous.graph_revision !== next.graph_revision ||
              !next.ready ||
              previous.available_point_ids.some(
                (id) => !next.available_point_ids.includes(id),
              ))) ||
          (current &&
            (next.graph_revision !== current.graph_revision ||
              !next.available_point_ids.includes(current.start_point_id) ||
              !next.available_point_ids.includes(current.end_point_id)))
        ) {
          clear();
          setError("道路或入口状态已更新，请重新计算路线。");
        }
      } catch (e) {
        if (!disposed && !controller.signal.aborted) {
          availabilityRef.current = null;
          setAvailability(null);
          clear();
          callbacks.current.onPickMode?.(null);
          setError(
            e instanceof Error ? e.message : "路网状态读取失败，请重试。",
          );
        }
      }
    }
    void refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      disposed = true;
      activeRead?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [map.id, map.revision, refreshRevision]);
  useEffect(() => {
    const next = autoStart.current;
    if (
      !next ||
      !availability?.ready ||
      availabilityRef.current !== availability
    )
      return;
    autoStart.current = null;
    void calculate(next.start!, next.end);
  }, [initial.sequence, availability]);
  useEffect(() => {
    callbacks.current.onSelectionChange?.({ start, end, availablePointIds });
  }, [start, end, availability, points]);
  useEffect(() => {
    if (
      !pickMode ||
      !pickedPoint ||
      handledPick.current === pickedPoint.sequence
    )
      return;
    handledPick.current = pickedPoint.sequence;
    if (!availablePointIds.includes(pickedPoint.id)) {
      setError("该地点暂无可用入口，请选择高亮的地点或取消选点。");
      return;
    }
    clear();
    setError("");
    if (pickMode === "start") setStart(pickedPoint.id);
    else setEnd(pickedPoint.id);
    callbacks.current.onPickMode?.(null);
  }, [pickedPoint?.sequence]);
  useEffect(() => {
    if (!pickMode) return;
    function cancelPick(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      callbacks.current.onPickMode?.(null);
      setError("");
    }
    window.addEventListener("keydown", cancelPick);
    return () => window.removeEventListener("keydown", cancelPick);
  }, [pickMode]);
  useEffect(() => {
    if (!route) return;
    const timer = setTimeout(
      () => {
        clear();
        setError("路线已过期，请重新计算以核对道路状态。");
      },
      Math.max(0, Date.parse(route.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [route]);

  function beginPick(mode: Exclude<RoutePickMode, null>) {
    autoStart.current = null;
    cancelRequest();
    setError("");
    callbacks.current.onPickMode?.(mode);
  }
  function selectEndpoint(mode: Exclude<RoutePickMode, null>, value: string) {
    autoStart.current = null;
    clear();
    setError("");
    callbacks.current.onPickMode?.(null);
    if (mode === "start") setStart(value);
    else setEnd(value);
  }
  return (
    <section
      className={`navigation-panel${pickMode ? " is-picking" : ""}`}
      aria-label="校园步行导航"
    >
      <header>
        <div>
          <small>校园导览</small>
          <h2>
            {pickMode
              ? `在地图选择${pickMode === "start" ? "起点" : "终点"}`
              : "选择地点，查看路线"}
          </h2>
        </div>
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => {
            callbacks.current.onPickMode?.(null);
            onClose();
          }}
        >
          ×
        </button>
      </header>
      {pickMode ? (
        <div className="navigation-pick-prompt">
          <p role="status">
            点击地图中有高亮轮廓的地点。可拖动、双指缩放；按 Esc 取消。
          </p>
          <button
            type="button"
            className="navigation-secondary"
            onClick={() => {
              setError("");
              callbacks.current.onPickMode?.(null);
            }}
          >
            取消选点
          </button>
        </div>
      ) : (
        <>
          <p className="navigation-hint">
            请自行选择出发地点，当前浏览位置不代表你的位置。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void calculate();
            }}
          >
            <div className="navigation-endpoint">
              <label>
                从哪里出发
                <select
                  aria-label="导航起点"
                  value={start}
                  onChange={(e) => selectEndpoint("start", e.target.value)}
                  required
                >
                  <option value="">请选择起点</option>
                  {points.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={!availablePointIds.includes(p.id)}
                    >
                      {p.name}
                      {availability && !availablePointIds.includes(p.id)
                        ? "（暂无可用入口）"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              {onPickMode && (
                <button
                  type="button"
                  className="navigation-secondary"
                  disabled={!availablePointIds.length}
                  onClick={() => beginPick("start")}
                >
                  地图选起点
                </button>
              )}
            </div>
            <button
              type="button"
              className="navigation-swap"
              disabled={start === end}
              onClick={() => {
                autoStart.current = null;
                clear();
                setError("");
                setStart(end);
                setEnd(start);
              }}
            >
              交换起终点
            </button>
            <div className="navigation-endpoint">
              <label>
                前往
                <select
                  aria-label="导航终点"
                  value={end}
                  onChange={(e) => selectEndpoint("end", e.target.value)}
                  required
                >
                  <option value="">请选择终点</option>
                  {points.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={!availablePointIds.includes(p.id)}
                    >
                      {p.name}
                      {availability && !availablePointIds.includes(p.id)
                        ? "（暂无可用入口）"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              {onPickMode && (
                <button
                  type="button"
                  className="navigation-secondary"
                  disabled={!availablePointIds.length}
                  onClick={() => beginPick("end")}
                >
                  地图选终点
                </button>
              )}
            </div>
            <label className="navigation-check">
              <input
                type="checkbox"
                checked={stepFree}
                onChange={(e) => {
                  autoStart.current = null;
                  clear();
                  setStepFree(e.target.checked);
                }}
              />
              仅使用已确认无台阶道路
            </label>
            <button className="primary-button" disabled={busy || !canRoute}>
              {busy ? "正在计算…" : "在地图显示路线"}
            </button>
          </form>
        </>
      )}
      {availability && !availability.ready && (
        <p className="navigation-note">{availability.message}</p>
      )}
      {error && (
        <p className="navigation-note" role="alert">
          {error}
        </p>
      )}
      {!availability && (
        <button
          type="button"
          className="navigation-secondary navigation-retry"
          onClick={() => setRefreshRevision((n) => n + 1)}
        >
          {error ? "重新读取可选地点" : "正在读取可选地点…点击重试"}
        </button>
      )}
      {!pickMode && route && (
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
