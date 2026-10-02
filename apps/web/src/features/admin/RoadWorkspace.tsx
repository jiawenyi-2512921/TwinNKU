import { useEffect, useRef, useState, type ReactNode } from "react";

import type { components } from "../../shared/api/schema";
import {
  api,
  type MapInfo,
  type Point,
  type XY,
} from "../../shared/api/client";
import { RoadCanvas, type RoadMode } from "./RoadCanvas";
import {
  connectCrossing,
  edgePath,
  invalidate,
  makeHistory,
} from "./roadGeometry";
import { request, message, type StaffSession } from "./api";
import { ErrorBox } from "./ui";
import "../map/navigation.css";
import "./road-workspace.css";

type Graph = components["schemas"]["RoadGraph"];
type Node = components["schemas"]["RoadNode"];
type Edge = components["schemas"]["RoadEdge"];
type Workspace = components["schemas"]["RoadWorkspace"];
type Path = components["schemas"]["NavigationPath"];
type Mode = RoadMode;
type Starter = components["schemas"]["RoadStarter"];
type Quality = components["schemas"]["RoadQuality"];
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

const modeLabels: Record<Mode, string> = {
  select: "选择 / 拖动",
  node: "添加路口或入口",
  road: "沿道路连续绘制",
  curve: "绘制弧线",
  freehand: "自由描线",
  split: "拆分路口",
};

/** Primary tools stay visible; occasional geometry/backup tools open on demand. */
export function RoadDrawingTools({
  mode,
  editable,
  busy,
  dirty,
  canUndo,
  canRedo,
  sketchCount,
  onMode,
  onSave,
  onUndo,
  onRedo,
  onFinish,
  onCancel,
  onCheck,
  children,
}: {
  mode: Mode;
  editable: boolean;
  busy: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  sketchCount: number;
  onMode: (mode: Mode) => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onCheck: () => void;
  children: ReactNode;
}) {
  const special = (["curve", "freehand", "split"] as const).find(
    (value) => value === mode,
  );
  const modes = (values: Mode[]) =>
    values.map((id) => (
      <button
        key={id}
        type="button"
        aria-pressed={mode === id}
        disabled={!editable && id !== "select"}
        onClick={() => onMode(id)}
      >
        {modeLabels[id]}
      </button>
    ));
  return (
    <div className="road-drawing-tools">
      <div className="road-command-bar">
        <div className="road-toolbar" role="group" aria-label="常用绘图工具">
          {modes(["select", "node", "road"])}
        </div>
        <div
          className="road-toolbar road-draft-actions"
          role="group"
          aria-label="草稿操作"
        >
          <button
            type="button"
            disabled={!editable || !canUndo}
            onClick={onUndo}
          >
            撤销
          </button>
          <button
            type="button"
            disabled={!editable || !canRedo}
            onClick={onRedo}
          >
            重做
          </button>
          <button
            type="button"
            disabled={busy || sketchCount > 0}
            onClick={onCheck}
          >
            检查连通与缺口
          </button>
          <button
            type="button"
            className="ad-primary"
            disabled={!editable || !dirty || sketchCount > 0}
            onClick={onSave}
          >
            保存草稿
          </button>
        </div>
      </div>
      {sketchCount > 0 && (
        <div
          className="road-sketch-actions road-toolbar"
          role="group"
          aria-label="当前绘制"
        >
          <span role="status">已绘制 {sketchCount} 个点</span>
          {mode === "road" && (
            <button
              type="button"
              disabled={!editable || sketchCount < 2}
              onClick={onFinish}
            >
              完成道路
            </button>
          )}
          <button type="button" onClick={onCancel}>
            取消绘制
          </button>
        </div>
      )}
      <details className="road-advanced-tools">
        <summary>
          更多绘图与备份{" "}
          <small>
            {special
              ? `当前：${modeLabels[special]}`
              : "弧线、描线、拆路与备份"}
          </small>
        </summary>
        <div className="road-toolbar" role="group" aria-label="特殊绘图工具">
          {modes(["curve", "freehand", "split"])}
        </div>
        {children}
      </details>
    </div>
  );
}

export function RoadWorkspace({
  maps,
  session,
  onDirty,
  onUpdate,
  reviewMode = false,
  initialMapId,
  onReview,
}: {
  maps: MapInfo[];
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate: () => void;
  reviewMode?: boolean;
  initialMapId?: string;
  onReview?: (id: string) => void;
}) {
  const eligible = maps.filter((m) => m.kind === "campus");
  const [mapId, setMapId] = useState(initialMapId ?? eligible[0]?.id ?? ""),
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
  const history = useRef(makeHistory(blank(1)));
  const [starter, setStarter] = useState<Starter | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [snapping, setSnapping] = useState(true),
    [showLabels, setShowLabels] = useState(false);
  const [drawCommand, setDrawCommand] = useState<{
    id: number;
    action: "finish" | "cancel";
  }>({ id: 0, action: "cancel" });
  const [sketchCount, setSketchCount] = useState(0);
  const [focus, setFocus] = useState<{ id: number; position: XY } | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [batchNote, setBatchNote] = useState("");
  const [onlyUnverified, setOnlyUnverified] = useState(false);
  const info = eligible.find((m) => m.id === mapId);
  useEffect(() => {
    if (!mapId && eligible[0]) setMapId(eligible[0].id);
  }, [maps, mapId]);
  const editable =
    !reviewMode &&
    !!workspace &&
    !busy &&
    workspace.state !== "in_review" &&
    ["admin", "editor"].includes(session.user.role);
  const nodes = graph.nodes ?? [],
    edges = graph.edges ?? [];
  const node = nodes.find((n) => n.id === selected),
    edge = edges.find((e) => e.id === selected);
  useEffect(() => {
    onDirty(dirty || sketchCount > 0, busy);
  }, [dirty, busy, sketchCount, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!info) return;
    const controller = new AbortController();
    setWorkspace(null);
    setError("");
    setSelected("");
    setPreview(null);
    setQuality(null);
    setStarter(null);
    setMarked(new Set());
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
        const initial =
          w.data.draft ?? w.data.published ?? blank(info!.revision);
        history.current.reset(initial);
        setGraph(initial);
        setPoints(all);
        // Starter availability cannot turn a successfully loaded workspace into an error.
        try {
          const prepared = await request<Starter>(
            `/navigation/${info!.id}/starter`,
            "GET",
            undefined,
            controller.signal,
          );
          if (!controller.signal.aborted) setStarter(prepared.data);
        } catch (e) {
          if (!controller.signal.aborted)
            setError(`路网已加载，初稿暂不可用：${message(e)}`);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(message(e));
      }
    }
    void load();
    return () => controller.abort();
  }, [info, refresh]);
  function change(next: Graph) {
    if (!editable) return;
    history.current.change(next);
    setGraph(next);
    setDirty(true);
    setPreview(null);
    setQuality(null);
  }
  function travel(direction: "undo" | "redo") {
    if (!editable) return;
    setGraph(history.current[direction]());
    setDirty(true);
    setPreview(null);
    setQuality(null);
    setDrawCommand((v) => ({ id: v.id + 1, action: "cancel" }));
  }
  function locate(id: string, position?: XY) {
    setSelected(id);
    const n = nodes.find((n) => n.id === id),
      e = edges.find((e) => e.id === id);
    const p =
      position ?? n?.position ?? (e ? edgePath(e, graph)[0] : undefined);
    if (p) setFocus((v) => ({ id: (v?.id ?? 0) + 1, position: p }));
  }
  async function checkGraph(next = graph) {
    if (!info) return;
    setBusy(true);
    setError("");
    try {
      const r = await request<Quality>(
        `/navigation/${info.id}/quality`,
        "POST",
        next,
      );
      setQuality(r.data);
      return r.data;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  function useStarter() {
    if (!starter?.graph || nodes.length || edges.length || !editable) return;
    change(structuredClone(starter.graph));
    setMode("select");
  }
  async function importGraph(file: File) {
    if (!editable || !info) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 2_000_000)
        throw new Error("文件超过2MB，请使用路网JSON备份");
      const value = JSON.parse(await file.text());
      if (
        value.map_id !== info.id ||
        value.source_sha256 !== info.source_sha256
      )
        throw new Error("备份底图不匹配，不能覆盖当前坐标");
      const next = value.graph as Graph;
      if (!next || next.map_revision !== info.revision)
        throw new Error("备份底图版本已过期");
      if (
        (nodes.length || edges.length) &&
        !window.confirm(
          "用备份替换当前编辑草稿？已发布路网不变，可撤销此操作。",
        )
      )
        return;
      const unverified = {
        ...next,
        nodes: (next.nodes ?? []).map((n) => ({
          ...n,
          candidate: n.kind === "entrance" ? true : n.candidate,
        })),
        edges: (next.edges ?? []).map((e) => ({ ...e, verified: false })),
      };
      // Validate at the same permission-checked API before changing local state.
      const r = await request<Quality>(
        `/navigation/${info.id}/quality`,
        "POST",
        unverified,
      );
      history.current.change(unverified);
      setGraph(unverified);
      setDirty(true);
      setPreview(null);
      setQuality(r.data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function exportGraph() {
    if (!info) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              schema_version: 1,
              map_id: info.id,
              source_sha256: info.source_sha256,
              graph,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `TwinNKU-road-draft-${info.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function batch(action: "verify" | "close" | "open") {
    if (!batchNote.trim()) {
      setError("请填写本次所选道路共同适用的核验依据或维护原因");
      return;
    }
    change({
      ...graph,
      edges: edges.map((e) =>
        marked.has(e.id)
          ? {
              ...e,
              evidence: batchNote,
              ...(action === "verify"
                ? { verified: true }
                : { closed: action === "close", verified: false }),
            }
          : e,
      ),
    });
    setMarked(new Set());
    setBatchNote("");
  }
  function updateNode(values: Partial<Node>) {
    if (!node) return;
    change({
      ...graph,
      nodes: nodes.map((n) => (n.id === node.id ? { ...n, ...values } : n)),
      edges: edges.map((e) =>
        (values.position || values.kind || "point_id" in values) &&
        (e.start === node.id || e.end === node.id)
          ? invalidate(e)
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
      history.current.reset(result.data.draft!);
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
  ]
    .filter(
      (item) =>
        !onlyUnverified || ("start" in item ? !item.verified : item.candidate),
    )
    .filter((item) =>
      `${item.label ?? ""} ${"point_id" in item ? (points.find((p) => p.id === item.point_id)?.name ?? "") : ""}`.includes(
        query,
      ),
    );
  return (
    <section
      className="road-workspace"
      onKeyDown={(event) => {
        const tag = (event.target as HTMLElement).tagName;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
        if (event.key === "Escape")
          setDrawCommand((v) => ({ id: v.id + 1, action: "cancel" }));
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          travel(event.shiftKey ? "redo" : "undo");
        }
      }}
    >
      <div className="ad-eyebrow">CAMPUS NETWORK</div>
      <h1>{reviewMode ? "路网审核与发布" : "道路与导航"}</h1>
      <p className="road-info">
        从已经整理的规划图路网开始，精修道路形状与建筑入口。系统辅助连接与检查，人工确认通行后发布，小开与前台导航同步使用。
      </p>
      <div className="road-toolbar">
        <label>
          校园地图{" "}
          <select
            value={mapId}
            disabled={busy || reviewMode}
            onChange={(e) => {
              if (
                (!dirty && !sketchCount) ||
                window.confirm("放弃未保存的路网修改？")
              )
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
            if (
              (!dirty && !sketchCount) ||
              window.confirm("放弃未保存的修改并重新加载？")
            )
              setRefresh((v) => v + 1);
          }}
        >
          重新加载
        </button>
      </div>
      <ErrorBox text={error} />
      {info && workspace && (
        <>
          {starter && !nodes.length && !edges.length && (
            <div className="road-starter">
              <div>
                <span className="ad-eyebrow">PREPARED NETWORK</span>
                <h2>{starter.title}</h2>
                <p>{starter.message}</p>
                {starter.graph && (
                  <p>
                    {starter.graph.edges?.length} 段道路 ·{" "}
                    {starter.graph.nodes?.filter((n) => n.point_id).length}{" "}
                    个入口候选。载入后即可编辑与草稿试算，无需从零描图。
                  </p>
                )}
              </div>
              <button
                disabled={!editable || !starter.available}
                onClick={useStarter}
              >
                载入已整理路网初稿
              </button>
            </div>
          )}
          <div className="road-metrics">
            <div>
              <strong>{edges.length}</strong>
              <span>道路</span>
            </div>
            <div>
              <strong>
                {nodes.filter((n) => n.kind === "junction").length}
              </strong>
              <span>路口</span>
            </div>
            <div>
              <strong>{nodes.filter((n) => n.point_id).length}</strong>
              <span>入口 / 候选</span>
            </div>
            <div>
              <strong>
                {edges.filter((e) => !e.verified && !e.closed).length}
              </strong>
              <span>待核验道路</span>
            </div>
          </div>
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
          <RoadDrawingTools
            mode={mode}
            editable={editable}
            busy={busy}
            dirty={dirty}
            canUndo={history.current.canUndo}
            canRedo={history.current.canRedo}
            sketchCount={sketchCount}
            onMode={setMode}
            onSave={() => void save()}
            onUndo={() => travel("undo")}
            onRedo={() => travel("redo")}
            onFinish={() =>
              setDrawCommand((v) => ({ id: v.id + 1, action: "finish" }))
            }
            onCancel={() =>
              setDrawCommand((v) => ({ id: v.id + 1, action: "cancel" }))
            }
            onCheck={() => void checkGraph()}
          >
            <div className="road-toolbar road-secondary">
              <label>
                <input
                  type="checkbox"
                  checked={snapping}
                  onChange={(e) => setSnapping(e.target.checked)}
                />{" "}
                吸附路口与道路
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showLabels}
                  onChange={(e) => setShowLabels(e.target.checked)}
                />{" "}
                显示节点名称
              </label>
              <button disabled={busy} onClick={exportGraph}>
                导出草稿备份
              </button>
              <label className="road-file">
                导入草稿备份
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={!editable}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importGraph(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </RoadDrawingTools>
          <p className="road-info">
            {mode === "road"
              ? "逐点描出弯道，点击已有路口或“完成道路”结束。中间点仅控制形状；端点会吸附并接入道路。"
              : mode === "curve"
                ? "依次点击起点、弧线控制点、终点。完成后可拖动控制点调整弯曲程度，路线计算沿同一条弧线。"
                : mode === "freehand"
                  ? "按住鼠标或单指沿道路描绘，松开完成；系统压缩多余形状点并吸附两端。可用缩放按钮调整地图。"
                  : mode === "split"
                    ? "点击道路，在准确位置拆成共用路口。保持原有形状与方向，长度和核验状态重新确认。"
                    : "选择道路可拖动实心形状点；拖动半透明中点可增加形状点，双击实心形状点删除。拖动路口到道路或另一节点可连接。"}
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
                onError={setError}
                drawCommand={drawCommand}
                onSketch={setSketchCount}
                snapping={snapping}
                showLabels={showLabels}
                focus={focus}
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
              {quality && (
                <div className="road-quality">
                  <h2>路网检查</h2>
                  <p>
                    {quality.component_count} 个连通区域 ·{" "}
                    {quality.covered_points} 个地点已有入口连接 ·{" "}
                    {quality.candidate_entrances} 个入口待确认
                  </p>
                  <p>
                    此检查识别图上连接关系，不判断道路是否实际开放。尚未覆盖{" "}
                    {quality.missing_point_ids.length} 个公开地点。
                  </p>
                  {!!quality.missing_point_ids.length && (
                    <details>
                      <summary>查看尚无入口连接的地点</summary>
                      <p>
                        {quality.missing_point_ids
                          .map(
                            (id) => points.find((p) => p.id === id)?.name ?? id,
                          )
                          .join("、")}
                      </p>
                    </details>
                  )}
                  <div className="road-issue-list">
                    {quality.issues.map((issue, index) => (
                      <div key={`${issue.code}-${index}`}>
                        <span>{issue.message}</span>
                        <button
                          onClick={() =>
                            locate(
                              issue.node_ids?.[0] ?? issue.edge_ids?.[0] ?? "",
                              issue.position ?? undefined,
                            )
                          }
                        >
                          定位
                        </button>
                        {issue.code === "CROSSING" && issue.position && (
                          <button
                            disabled={!editable}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  "确认此处为同层、可连通的道路？桥上桥下或围墙两侧不可连接。",
                                )
                              )
                                return;
                              try {
                                change(
                                  connectCrossing(
                                    graph,
                                    issue.edge_ids ?? [],
                                    issue.position!,
                                  ),
                                );
                              } catch (e) {
                                setError(message(e));
                              }
                            }}
                          >
                            连接为路口
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {quality.truncated && (
                    <p>检查结果已截取；请先处理当前问题，再检查剩余路段。</p>
                  )}
                </div>
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
              <label className="road-check">
                <input
                  type="checkbox"
                  checked={onlyUnverified}
                  onChange={(e) => setOnlyUnverified(e.target.checked)}
                />{" "}
                只看待核验 / 待确认
              </label>
              <button
                disabled={!editable || !list.some((item) => "start" in item)}
                onClick={() =>
                  setMarked(
                    new Set(
                      list
                        .filter((item) => "start" in item)
                        .map((item) => item.id),
                    ),
                  )
                }
              >
                选择当前筛选道路
              </button>
              <div className="road-list">
                {list.map((item) => (
                  <div className="road-list-row" key={item.id}>
                    {"start" in item && (
                      <input
                        type="checkbox"
                        aria-label={`批量选择 ${item.label || item.id}`}
                        checked={marked.has(item.id)}
                        disabled={!editable}
                        onChange={(e) =>
                          setMarked((old) => {
                            const next = new Set(old);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <button
                      aria-pressed={item.id === selected}
                      onClick={() => locate(item.id)}
                    >
                      {item.label || item.id.slice(0, 8)}
                      {"kind" in item && item.kind === "entrance"
                        ? " · 建筑入口"
                        : ""}
                    </button>
                  </div>
                ))}
              </div>
              {!!marked.size && (
                <fieldset disabled={!editable} className="road-batch">
                  <legend>所选 {marked.size} 条道路</legend>
                  <textarea
                    maxLength={500}
                    value={batchNote}
                    onChange={(e) => setBatchNote(e.target.value)}
                    placeholder="共同适用的核验日期、人员、资料依据或维护原因"
                  />
                  <button onClick={() => batch("verify")}>
                    确认所选道路已核验
                  </button>
                  <button onClick={() => batch("close")}>批量封闭</button>
                  <button onClick={() => batch("open")}>
                    恢复通行，待核验
                  </button>
                  <button onClick={() => setMarked(new Set())}>取消选择</button>
                </fieldset>
              )}
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
                    <>
                      <label>
                        所属建筑
                        <select
                          value={node.point_id ?? ""}
                          onChange={(e) =>
                            updateNode({
                              point_id: e.target.value || null,
                              candidate: true,
                            })
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
                      <label>
                        入口核对依据
                        <textarea
                          maxLength={500}
                          value={node.evidence ?? ""}
                          onChange={(e) =>
                            updateNode({ evidence: e.target.value })
                          }
                        />
                      </label>
                      <label className="road-check">
                        <input
                          type="checkbox"
                          checked={!node.candidate}
                          disabled={!node.point_id || !node.evidence?.trim()}
                          onChange={(e) =>
                            updateNode({ candidate: !e.target.checked })
                          }
                        />{" "}
                        已确认入口位置与可通行情况
                      </label>
                      {node.candidate && (
                        <small>
                          橙色候选入口不会直接用于公开导航。请精修位置并确认。
                        </small>
                      )}
                    </>
                  )}
                  <div className="road-coordinate">
                    <label>
                      X
                      <input
                        type="number"
                        min={0}
                        max={info.width_px}
                        step={1}
                        value={Math.round(node.position.x)}
                        onChange={(e) =>
                          updateNode({
                            position: {
                              ...node.position,
                              x: Math.max(
                                0,
                                Math.min(info.width_px, Number(e.target.value)),
                              ),
                            },
                            candidate:
                              node.kind === "entrance" ? true : node.candidate,
                          })
                        }
                      />
                    </label>
                    <label>
                      Y
                      <input
                        type="number"
                        min={0}
                        max={info.height_px}
                        step={1}
                        value={Math.round(node.position.y)}
                        onChange={(e) =>
                          updateNode({
                            position: {
                              ...node.position,
                              y: Math.max(
                                0,
                                Math.min(
                                  info.height_px,
                                  Number(e.target.value),
                                ),
                              ),
                            },
                            candidate:
                              node.kind === "entrance" ? true : node.candidate,
                          })
                        }
                      />
                    </label>
                  </div>
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
                  <div className="road-toolbar">
                    <button
                      onClick={() => {
                        const path = edgePath(edge, graph),
                          a = path[0],
                          b = path.at(-1)!;
                        if (edge.curve_control)
                          updateEdge({
                            ...invalidate(edge),
                            via: path.slice(1, -1),
                            curve_control: null,
                          });
                        else {
                          if (
                            (edge.via?.length ?? 0) > 0 &&
                            !window.confirm(
                              "将折线改为单段弧线会重建形状，可撤销。继续？",
                            )
                          )
                            return;
                          updateEdge({
                            ...invalidate(edge),
                            via: [],
                            curve_control: {
                              x: (a.x + b.x) / 2,
                              y: (a.y + b.y) / 2,
                            },
                          });
                        }
                      }}
                    >
                      {edge.curve_control ? "弧线转为形状点" : "转为可调弧线"}
                    </button>
                    <button
                      onClick={() =>
                        updateEdge({
                          ...invalidate(edge),
                          start: edge.end,
                          end: edge.start,
                          via: [...(edge.via ?? [])].reverse(),
                        })
                      }
                    >
                      反转起终点
                    </button>
                  </div>
                  <small>
                    {edge.curve_control
                      ? "弧线：拖动紫色控制点调整"
                      : "折线 / 描线：" + (edge.via?.length ?? 0) + "个形状点"}
                  </small>
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
            {!reviewMode && workspace.state !== "in_review" && (
              <button
                disabled={!editable || dirty || !workspace.draft}
                onClick={() => void review("submit")}
              >
                提交审核
              </button>
            )}
            {workspace.state === "in_review" && (
              <>
                {!reviewMode &&
                  ["admin", "editor"].includes(session.user.role) && (
                    <button
                      disabled={busy}
                      onClick={() => void review("withdraw")}
                    >
                      撤回修改
                    </button>
                  )}
                {reviewMode &&
                  ["admin", "reviewer"].includes(session.user.role) &&
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
                {!reviewMode && onReview && (
                  <button
                    disabled={busy || dirty}
                    onClick={() => onReview(mapId)}
                  >
                    去审核中心
                  </button>
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
