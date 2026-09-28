import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import type { components } from "../../shared/api/schema";
import {
  api,
  type MapInfo,
  type Point,
  type XY,
} from "../../shared/api/client";
import { fromMapPoint, imageBounds, toMapPoint } from "../map/coordinates";
import { request, message, type StaffSession } from "./api";
import { ErrorBox } from "./ui";
import "../map/navigation.css";

type Graph = components["schemas"]["RoadGraph"];
type Node = components["schemas"]["RoadNode"];
type Edge = components["schemas"]["RoadEdge"];
type Workspace = components["schemas"]["RoadWorkspace"];
type Path = components["schemas"]["NavigationPath"];
type Mode = "select" | "node" | "road";
const blank = (revision: number): Graph => ({
  map_revision: revision,
  nodes: [],
  edges: [],
  note: "",
});
const states: Record<string, string> = {
  empty: "尚无路网",
  draft: "草稿",
  in_review: "待审核",
  rejected: "已退回",
  published: "已发布",
};

function RoadCanvas({
  info,
  graph,
  mode,
  editable,
  selected,
  setSelected,
  onChange,
  preview,
}: {
  info: MapInfo;
  graph: Graph;
  mode: Mode;
  editable: boolean;
  selected: string;
  setSelected: (id: string) => void;
  onChange: (g: Graph) => void;
  preview: Path | null;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null);
  const chain = useRef<string | null>(null);
  const [tileError, setTileError] = useState(false);
  const latest = useRef({ graph, mode, editable, onChange, setSelected });
  latest.current = { graph, mode, editable, onChange, setSelected };
  useEffect(() => {
    chain.current = null;
  }, [mode, editable, info.id]);
  function choose(id: string | null, position?: XY) {
    const s = latest.current;
    if (!s.editable || s.mode === "select") {
      if (id) s.setSelected(id);
      return;
    }
    let nodes = [...(s.graph.nodes ?? [])],
      edges = [...(s.graph.edges ?? [])];
    const next = id ?? crypto.randomUUID();
    if (!id && position)
      nodes.push({
        id: next,
        position,
        kind: "junction",
        label: "新路口",
        point_id: null,
      });
    if (s.mode === "road" && chain.current && chain.current !== next) {
      const start = chain.current;
      if (
        !edges.some(
          (e) =>
            (e.start === start && e.end === next) ||
            (e.bidirectional && e.start === next && e.end === start),
        )
      ) {
        edges.push({
          id: crypto.randomUUID(),
          label: "新路段",
          start,
          end: next,
          via: [],
          bidirectional: true,
          closed: false,
          verified: false,
          evidence: "",
          distance_m: null,
          step_free: null,
        });
      }
    }
    chain.current = s.mode === "road" ? next : null;
    s.onChange({ ...s.graph, nodes, edges });
    s.setSelected(next);
  }
  useEffect(() => {
    if (!element.current || !info.tiles) return;
    const m = L.map(element.current, {
      crs: L.CRS.Simple,
      attributionControl: false,
      minZoom: info.tiles.min_zoom,
      maxZoom: info.tiles.max_native_zoom + 1,
      zoomSnap: 0.25,
      doubleClickZoom: false,
    });
    map.current = m;
    const layer = L.tileLayer(info.tiles.url_template, {
      tileSize: info.tiles.tile_size,
      noWrap: true,
      bounds: imageBounds(info),
      maxNativeZoom: info.tiles.max_native_zoom,
    }).addTo(m);
    layer.on("tileerror", () => setTileError(true));
    m.fitBounds(imageBounds(info), { padding: [20, 20] });
    m.on("click", (e: L.LeafletMouseEvent) => {
      const p = fromMapPoint(e.latlng, info.tiles!.max_native_zoom);
      if (p.x >= 0 && p.y >= 0 && p.x <= info.width_px && p.y <= info.height_px)
        choose(null, p);
    });
    const observer = new ResizeObserver(() => m.invalidateSize({ pan: false }));
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
  }, [info]);
  useEffect(() => {
    const m = map.current;
    if (!m || !info.tiles) return;
    const layer = L.layerGroup().addTo(m),
      nodes = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
    for (const edge of graph.edges ?? []) {
      const a = nodes.get(edge.start),
        b = nodes.get(edge.end);
      if (!a || !b) continue;
      const line = [a.position, ...(edge.via ?? []), b.position].map((p) =>
        toMapPoint(p, info.tiles!.max_native_zoom),
      );
      const poly = L.polyline(line, {
        color:
          edge.id === selected
            ? "#9e3a9e"
            : edge.closed
              ? "#b74040"
              : edge.verified
                ? "#308779"
                : "#b28029",
        weight: edge.id === selected ? 7 : 4,
        dashArray: edge.closed || !edge.verified ? "7 5" : undefined,
        bubblingMouseEvents: false,
      }).addTo(layer);
      const label = document.createElement("span");
      label.textContent = `${edge.label || "道路"}${edge.bidirectional ? " ↔" : " →"}${edge.closed ? "（关闭）" : ""}`;
      poly.bindTooltip(label);
      poly.on("click", () => latest.current.setSelected(edge.id));
    }
    for (const node of graph.nodes ?? []) {
      const label = document.createElement("span");
      label.className = "road-node-label";
      label.textContent = `${node.kind === "entrance" ? "入口·" : ""}${node.label || node.id.slice(0, 6)}`;
      const marker = L.marker(
        toMapPoint(node.position, info.tiles.max_native_zoom),
        {
          draggable: editable && mode === "select",
          bubblingMouseEvents: false,
          icon: L.divIcon({
            html: label,
            className: "road-node",
            iconSize: [80, 22],
            iconAnchor: [8, 10],
          }),
        },
      ).addTo(layer);
      marker.on("click", () => choose(node.id));
      marker.on("dragend", () => {
        const s = latest.current,
          p = fromMapPoint(marker.getLatLng(), info.tiles!.max_native_zoom);
        const position = {
          x: Math.max(0, Math.min(info.width_px, p.x)),
          y: Math.max(0, Math.min(info.height_px, p.y)),
        };
        s.onChange({
          ...s.graph,
          nodes: (s.graph.nodes ?? []).map((n) =>
            n.id === node.id ? { ...n, position } : n,
          ),
          edges: (s.graph.edges ?? []).map((e) =>
            e.start === node.id || e.end === node.id
              ? { ...e, verified: false }
              : e,
          ),
        });
      });
    }
    for (const segment of preview?.segments ?? [])
      L.polyline(
        segment.path.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
        { color: "#147ae0", weight: 8, opacity: 0.75, interactive: false },
      ).addTo(layer);
    return () => {
      layer.remove();
    };
  }, [graph, selected, editable, mode, info, preview]);
  return (
    <>
      <div
        ref={element}
        className="road-map"
        role="region"
        aria-label="道路与建筑入口编辑地图"
      />
      {tileError && (
        <p role="alert">部分底图加载失败，请重新加载后核对道路。</p>
      )}
    </>
  );
}

export function RoadWorkspace({
  maps,
  session,
  onDirty,
  onUpdate,
}: {
  maps: MapInfo[];
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate: () => void;
}) {
  const eligible = maps.filter((m) => m.kind === "campus");
  const [mapId, setMapId] = useState(eligible[0]?.id ?? ""),
    [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [graph, setGraph] = useState<Graph>(blank(1)),
    [points, setPoints] = useState<Point[]>([]);
  const [mode, setMode] = useState<Mode>("select"),
    [selected, setSelected] = useState("");
  const [kind, setKind] = useState("all"),
    [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const [note, setNote] = useState(""),
    [refresh, setRefresh] = useState(0),
    [preview, setPreview] = useState<Path | null>(null);
  const [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const info = eligible.find((m) => m.id === mapId);
  useEffect(() => {
    if (!mapId && eligible[0]) setMapId(eligible[0].id);
  }, [maps, mapId]);
  const editable =
    !!workspace &&
    !busy &&
    workspace.state !== "in_review" &&
    ["admin", "editor"].includes(session.user.role);
  const nodes = graph.nodes ?? [],
    edges = graph.edges ?? [];
  const node = nodes.find((n) => n.id === selected),
    edge = edges.find((e) => e.id === selected);
  useEffect(() => {
    onDirty(dirty, busy);
  }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!info) return;
    const controller = new AbortController();
    setWorkspace(null);
    setError("");
    setSelected("");
    setPreview(null);
    setDirty(false);
    async function load() {
      try {
        const w = await request<Workspace>(
          `/navigation/${info!.id}`,
          "GET",
          undefined,
          controller.signal,
        );
        const all: Point[] = [];
        let page = 1;
        while (true) {
          const response = await api.points(
            info!.campus_id,
            "",
            controller.signal,
            page++,
          );
          all.push(...response.data);
          if (
            all.length >= (response.meta.pagination?.total ?? all.length) ||
            !response.data.length
          )
            break;
        }
        if (controller.signal.aborted) return;
        setWorkspace(w.data);
        setGraph(w.data.draft ?? w.data.published ?? blank(info!.revision));
        setPoints(all);
      } catch (e) {
        if (!controller.signal.aborted) setError(message(e));
      }
    }
    void load();
    return () => controller.abort();
  }, [info, refresh]);
  function change(next: Graph) {
    if (!editable) return;
    setGraph(next);
    setDirty(true);
    setPreview(null);
  }
  function updateNode(values: Partial<Node>) {
    if (!node) return;
    change({
      ...graph,
      nodes: nodes.map((n) => (n.id === node.id ? { ...n, ...values } : n)),
      edges: edges.map((e) =>
        e.start === node.id || e.end === node.id
          ? { ...e, verified: false }
          : e,
      ),
    });
  }
  function updateEdge(values: Partial<Edge>) {
    if (edge)
      change({
        ...graph,
        edges: edges.map((e) => (e.id === edge.id ? { ...e, ...values } : e)),
      });
  }
  async function save() {
    if (!info || !workspace) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<Workspace>(`/navigation/${info.id}`, "PUT", {
        expected_revision: workspace.revision,
        graph,
      });
      setWorkspace(result.data);
      onUpdate();
      setGraph(result.data.draft!);
      setDirty(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function review(action: string) {
    if (!info || !workspace || !note.trim()) {
      setError("请填写提交或审核说明。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<Workspace>(
        `/navigation/${info.id}/review`,
        "POST",
        { expected_revision: workspace.revision, action, note },
      );
      setWorkspace(result.data);
      onUpdate();
      setNote("");
      setMode("select");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function trial() {
    if (!info || !start || !end) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<Path>(
        `/navigation/${info.id}/preview`,
        "POST",
        {
          map_id: info.id,
          map_revision: info.revision,
          start_point_id: start,
          end_point_id: end,
          step_free: false,
        },
      );
      setPreview(result.data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const list = [
    ...nodes.filter(
      (n) => kind !== "road" && (kind === "all" || n.kind === kind),
    ),
    ...(kind === "all" || kind === "road" ? edges : []),
  ].filter((item) =>
    `${item.label ?? ""} ${"point_id" in item ? (points.find((p) => p.id === item.point_id)?.name ?? "") : ""}`.includes(
      query,
    ),
  );
  return (
    <section>
      <div className="ad-eyebrow">CAMPUS NETWORK</div>
      <h1>道路与导航</h1>
      <p className="road-info">
        维护真实路口、转折点与建筑入口。沿道路逐段绘制，核对现场通行情况，由独立审核员发布后供小开和地图使用。
      </p>
      <div className="road-toolbar">
        <label>
          校园地图{" "}
          <select
            value={mapId}
            disabled={busy}
            onChange={(e) => {
              if (!dirty || window.confirm("放弃未保存的路网修改？"))
                setMapId(e.target.value);
            }}
          >
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
        <span>
          {workspace ? states[workspace.state] : "正在加载"} · 已发布版本{" "}
          {workspace?.published_revision ?? 0}
        </span>
        <button
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("放弃未保存的修改并重新加载？"))
              setRefresh((v) => v + 1);
          }}
        >
          重新加载
        </button>
      </div>
      <ErrorBox text={error} />
      {info && workspace && (
        <>
          {graph.map_revision !== info.revision && (
            <p className="navigation-note">
              底图版本已变化。请重新核对位置。
              <button
                disabled={!editable}
                onClick={() =>
                  change({
                    ...graph,
                    map_revision: info.revision,
                    edges: edges.map((e) => ({ ...e, verified: false })),
                  })
                }
              >
                使用当前底图，全部路段重新核验
              </button>
            </p>
          )}
          <div className="road-toolbar">
            {(
              [
                ["select", "选择 / 拖动"],
                ["node", "添加路口或入口"],
                ["road", "沿道路连续绘制"],
              ] as const
            ).map(([id, title]) => (
              <button
                key={id}
                aria-pressed={mode === id}
                disabled={!editable && id !== "select"}
                onClick={() => setMode(id)}
              >
                {title}
              </button>
            ))}
            <button disabled={!editable || !dirty} onClick={() => void save()}>
              保存草稿
            </button>
            <span>
              {nodes.length} 个节点 · {edges.length} 条道路 ·{" "}
              {nodes.filter((n) => n.kind === "entrance").length} 个入口
            </span>
          </div>
          <p className="road-info">
            {mode === "road"
              ? "依次点击道路转折处；点击已有节点可接入路网。切回“选择”结束一条道路。"
              : "点击节点或路段编辑。建筑入口应标在实际门口，不要用建筑中心替代。拖动节点后，相邻道路需要重新核验。"}
          </p>
          <div className="road-layout">
            <div>
              <RoadCanvas
                info={info}
                graph={graph}
                mode={mode}
                editable={editable}
                selected={selected}
                setSelected={setSelected}
                onChange={change}
                preview={preview}
              />
              <div className="road-toolbar">
                <select
                  aria-label="试算起点"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                >
                  <option value="">试算起点</option>
                  {points.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="试算终点"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                >
                  <option value="">试算终点</option>
                  {points.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  disabled={busy || dirty || !workspace.draft || !start || !end}
                  onClick={() => void trial()}
                >
                  试算已保存草稿
                </button>
              </div>
              {preview && (
                <p className="navigation-note">
                  蓝线为草稿试算，不对公众生效。{preview.warnings.join(" ")}
                </p>
              )}
            </div>
            <aside className="road-controls">
              <label>
                查找节点 / 道路
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="名称或建筑"
                />
              </label>
              <select
                aria-label="对象类型"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="all">全部对象</option>
                <option value="junction">路口</option>
                <option value="waypoint">道路转折点</option>
                <option value="entrance">建筑入口</option>
                <option value="road">道路</option>
              </select>
              <div className="road-list">
                {list.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={item.id === selected}
                    onClick={() => setSelected(item.id)}
                  >
                    {item.label || item.id.slice(0, 8)}
                    {"kind" in item && item.kind === "entrance"
                      ? " · 建筑入口"
                      : ""}
                  </button>
                ))}
              </div>
              {node && (
                <fieldset disabled={!editable}>
                  <legend>节点 / 入口</legend>
                  <label>
                    名称
                    <input
                      value={node.label ?? ""}
                      maxLength={100}
                      onChange={(e) => updateNode({ label: e.target.value })}
                    />
                  </label>
                  <label>
                    类型
                    <select
                      value={node.kind ?? "junction"}
                      onChange={(e) =>
                        updateNode({
                          kind: e.target.value as Node["kind"],
                          point_id: null,
                        })
                      }
                    >
                      <option value="junction">路口</option>
                      <option value="waypoint">转折点</option>
                      <option value="entrance">建筑入口</option>
                    </select>
                  </label>
                  {node.kind === "entrance" && (
                    <label>
                      所属建筑
                      <select
                        value={node.point_id ?? ""}
                        onChange={(e) =>
                          updateNode({ point_id: e.target.value || null })
                        }
                      >
                        <option value="">选择建筑</option>
                        {points.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <small>
                    原图坐标 {Math.round(node.position.x)},{" "}
                    {Math.round(node.position.y)}
                  </small>
                  <button
                    onClick={() => {
                      if (window.confirm("删除此节点及所有相连道路？")) {
                        change({
                          ...graph,
                          nodes: nodes.filter((n) => n.id !== node.id),
                          edges: edges.filter(
                            (e) => e.start !== node.id && e.end !== node.id,
                          ),
                        });
                        setSelected("");
                      }
                    }}
                  >
                    从草稿移除节点
                  </button>
                </fieldset>
              )}
              {edge && (
                <fieldset disabled={!editable}>
                  <legend>道路与通行</legend>
                  <label>
                    道路名称
                    <input
                      value={edge.label ?? ""}
                      maxLength={100}
                      onChange={(e) => updateEdge({ label: e.target.value })}
                    />
                  </label>
                  <p>
                    {nodes.find((n) => n.id === edge.start)?.label} →{" "}
                    {nodes.find((n) => n.id === edge.end)?.label}
                  </p>
                  <label className="road-check">
                    <input
                      type="checkbox"
                      checked={edge.bidirectional ?? true}
                      onChange={(e) =>
                        updateEdge({
                          bidirectional: e.target.checked,
                          verified: false,
                        })
                      }
                    />
                    双向通行
                  </label>
                  <label className="road-check">
                    <input
                      type="checkbox"
                      checked={edge.closed ?? false}
                      onChange={(e) =>
                        updateEdge({
                          closed: e.target.checked,
                          verified: false,
                        })
                      }
                    />
                    道路关闭
                  </label>
                  <label>
                    无台阶情况
                    <select
                      value={
                        edge.step_free == null
                          ? "unknown"
                          : String(edge.step_free)
                      }
                      onChange={(e) =>
                        updateEdge({
                          step_free:
                            e.target.value === "unknown"
                              ? null
                              : e.target.value === "true",
                          verified: false,
                        })
                      }
                    >
                      <option value="unknown">尚未核实</option>
                      <option value="true">已确认无台阶</option>
                      <option value="false">存在台阶</option>
                    </select>
                  </label>
                  <label>
                    实测长度（米，可留空）
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={edge.distance_m ?? ""}
                      onChange={(e) =>
                        updateEdge({
                          distance_m: e.target.value
                            ? Number(e.target.value)
                            : null,
                          verified: false,
                        })
                      }
                    />
                  </label>
                  <label>
                    核实依据 / 封闭说明
                    <textarea
                      value={edge.evidence ?? ""}
                      maxLength={500}
                      onChange={(e) => updateEdge({ evidence: e.target.value })}
                    />
                  </label>
                  <label className="road-check">
                    <input
                      type="checkbox"
                      checked={edge.verified ?? false}
                      onChange={(e) =>
                        updateEdge({ verified: e.target.checked })
                      }
                    />
                    已核实实际道路与通行情况
                  </label>
                  <button
                    onClick={() => {
                      if (window.confirm("从草稿移除此路段？")) {
                        change({
                          ...graph,
                          edges: edges.filter((e) => e.id !== edge.id),
                        });
                        setSelected("");
                      }
                    }}
                  >
                    从草稿移除道路
                  </button>
                </fieldset>
              )}
            </aside>
          </div>
          <label className="road-controls">
            路网来源、建筑入口核对与适用范围
            <textarea
              value={graph.note ?? ""}
              maxLength={2000}
              disabled={!editable}
              onChange={(e) => change({ ...graph, note: e.target.value })}
            />
          </label>
          <div className="road-summary">
            {workspace.review_note || "当前草稿尚无审核说明。"}
          </div>
          <div className="road-toolbar">
            <input
              aria-label="提交或审核说明"
              placeholder="填写提交、审核或退回说明"
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {workspace.state !== "in_review" && (
              <button
                disabled={!editable || dirty || !workspace.draft}
                onClick={() => void review("submit")}
              >
                提交审核
              </button>
            )}
            {workspace.state === "in_review" && (
              <>
                {["admin", "editor"].includes(session.user.role) && (
                  <button
                    disabled={busy}
                    onClick={() => void review("withdraw")}
                  >
                    撤回修改
                  </button>
                )}
                {["admin", "reviewer"].includes(session.user.role) &&
                  !workspace.contributor_ids.includes(session.user.id) && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void review("publish")}
                      >
                        审核通过并发布
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void review("reject")}
                      >
                        退回
                      </button>
                    </>
                  )}
              </>
            )}
          </div>
          <p className="road-info">
            草稿不会改变当前导航。发布后客户端在30秒内或回到页面时核对版本；已打开的旧路线会失效。所有保存、提交和审核进入操作记录。
          </p>
        </>
      )}
    </section>
  );
}
