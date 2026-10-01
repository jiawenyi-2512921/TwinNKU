import type { components } from "../../shared/api/schema";
export type Graph = components["schemas"]["RoadGraph"];
export type RoadNode = components["schemas"]["RoadNode"];
export type Edge = components["schemas"]["RoadEdge"];
export type XY = components["schemas"]["XY"];
export const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const mix = (a: XY, b: XY, t: number): XY => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
const uuid = () => crypto.randomUUID();
export function curvePoint(a: XY, c: XY, b: XY, t: number): XY {
  return mix(mix(a, c, t), mix(c, b, t), t);
}
export function edgePath(edge: Edge, graph: Graph): XY[] {
  const a = graph.nodes?.find((n) => n.id === edge.start)?.position;
  const b = graph.nodes?.find((n) => n.id === edge.end)?.position;
  if (!a || !b) return [];
  return edge.curve_control
    ? Array.from({ length: 33 }, (_, i) =>
        curvePoint(a, edge.curve_control!, b, i / 32),
      )
    : [a, ...(edge.via ?? []), b];
}
export function project(p: XY, path: XY[]) {
  let best = { point: path[0] ?? p, distance: Infinity, index: 0, t: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1],
      dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    const point = mix(a, b, t),
      d = distance(p, point);
    if (d < best.distance) best = { point, distance: d, index: i, t };
  }
  return best;
}
export function invalidate(e: Edge): Edge {
  return { ...e, verified: false, distance_m: null };
}
export function splitEdge(
  graph: Graph,
  edgeId: string,
  p: XY,
  nodeId?: string,
): { graph: Graph; nodeId: string } {
  const edge = graph.edges?.find((e) => e.id === edgeId);
  if (!edge) throw new Error("道路已变化，请重新选择");
  const path = edgePath(edge, graph),
    hit = project(p, path);
  if (distance(hit.point, path[0]) < 0.01) return { graph, nodeId: edge.start };
  if (distance(hit.point, path.at(-1)!) < 0.01)
    return { graph, nodeId: edge.end };
  const id = nodeId ?? uuid();
  let point = hit.point;
  const left: Edge = { ...invalidate(edge), end: id };
  const right: Edge = { ...invalidate(edge), id: uuid(), start: id };
  if (edge.curve_control) {
    const t = (hit.index + hit.t) / 32,
      a = path[0],
      b = path.at(-1)!;
    point = curvePoint(a, edge.curve_control, b, t);
    left.curve_control = mix(a, edge.curve_control, t);
    right.curve_control = mix(edge.curve_control, b, t);
    left.via = right.via = [];
  } else {
    left.via = path.slice(1, hit.index + 1);
    right.via = path.slice(hit.index + 1, -1);
  }
  const existing = graph.nodes?.some((n) => n.id === id);
  return {
    graph: {
      ...graph,
      nodes: existing
        ? (graph.nodes ?? []).map((n) =>
            n.id === id ? { ...n, position: point } : n,
          )
        : [
            ...(graph.nodes ?? []),
            {
              id,
              position: point,
              kind: "junction",
              label: "连接路口",
              point_id: null,
              candidate: false,
              evidence: "",
            },
          ],
      edges: (graph.edges ?? []).flatMap((e) =>
        e.id === edgeId ? [left, right] : [e],
      ),
    },
    nodeId: id,
  };
}
export function snap(
  graph: Graph,
  p: XY,
  tolerance: number,
  excludeNode?: string,
) {
  const nodes = (graph.nodes ?? [])
    .filter((n) => n.id !== excludeNode)
    .map((n) => ({ node: n, d: distance(n.position, p) }))
    .sort((a, b) => a.d - b.d);
  if (nodes[0]?.d <= tolerance)
    return {
      point: nodes[0].node.position,
      nodeId: nodes[0].node.id,
      edgeId: null,
    };
  let best: { point: XY; nodeId: null; edgeId: string | null; d: number } = {
    point: p,
    nodeId: null,
    edgeId: null,
    d: tolerance,
  };
  for (const edge of graph.edges ?? []) {
    if (excludeNode && (edge.start === excludeNode || edge.end === excludeNode))
      continue;
    const h = project(p, edgePath(edge, graph));
    if (h.distance < best.d)
      best = { point: h.point, nodeId: null, edgeId: edge.id, d: h.distance };
  }
  return best;
}
function attach(graph: Graph, p: XY, tolerance: number) {
  const hit = snap(graph, p, tolerance);
  if (hit.nodeId) return { graph, nodeId: hit.nodeId };
  if (hit.edgeId) return splitEdge(graph, hit.edgeId, hit.point);
  const id = uuid();
  return {
    graph: {
      ...graph,
      nodes: [
        ...(graph.nodes ?? []),
        {
          id,
          position: p,
          kind: "junction" as const,
          label: "新路口",
          point_id: null,
          candidate: false,
          evidence: "",
        },
      ],
    },
    nodeId: id,
  };
}
export function addStroke(
  graph: Graph,
  path: XY[],
  tolerance: number,
  curveControl: XY | null = null,
): Graph {
  if (path.length < 2 || distance(path[0], path.at(-1)!) < 1)
    throw new Error("道路起终点过近，请延长绘制");
  if (path.length > 102) throw new Error("形状点超过100个，请分段绘制");
  const a = attach(graph, path[0], tolerance),
    b = attach(a.graph, path.at(-1)!, tolerance);
  if (a.nodeId === b.nodeId)
    throw new Error("环形道路请分为两段，并使用两个不同路口");
  if (
    b.graph.edges?.some(
      (e) =>
        (e.start === a.nodeId && e.end === b.nodeId) ||
        (e.start === b.nodeId && e.end === a.nodeId),
    )
  )
    throw new Error("这两个路口已有道路，可选择原道路修改形状");
  const edge: Edge = {
    id: uuid(),
    label: curveControl ? "新弧形道路" : "新道路",
    start: a.nodeId,
    end: b.nodeId,
    via: curveControl ? [] : path.slice(1, -1),
    curve_control: curveControl,
    bidirectional: true,
    verified: false,
    evidence: "",
    closed: false,
    step_free: null,
    distance_m: null,
  };
  return { ...b.graph, edges: [...(b.graph.edges ?? []), edge] };
}
export function moveNode(
  graph: Graph,
  id: string,
  p: XY,
  tolerance: number,
): Graph {
  const node = graph.nodes?.find((n) => n.id === id);
  if (!node) return graph;
  const moved = {
    ...graph,
    nodes: (graph.nodes ?? []).map((n) =>
      n.id === id
        ? {
            ...n,
            position: p,
            candidate: n.kind === "entrance" ? true : n.candidate,
          }
        : n,
    ),
    edges: (graph.edges ?? []).map((e) =>
      e.start === id || e.end === id ? invalidate(e) : e,
    ),
  };
  const hit = snap(graph, p, tolerance, id);
  if (hit.nodeId) {
    const target = graph.nodes!.find((n) => n.id === hit.nodeId)!;
    if (node.point_id && target.point_id && node.point_id !== target.point_id)
      throw new Error("不同建筑入口不可合并，请保留独立入口和连接道路");
    const nextEdges = moved.edges
      .map((e) => ({
        ...e,
        start: e.start === id ? target.id : e.start,
        end: e.end === id ? target.id : e.end,
      }))
      .filter((e) => e.start !== e.end);
    const pairs = new Set<string>();
    for (const e of nextEdges) {
      for (const key of [
        e.start + ":" + e.end,
        ...(e.bidirectional ? [e.end + ":" + e.start] : []),
      ]) {
        if (pairs.has(key))
          throw new Error("合并会产生重复道路，请先整理相邻道路");
        pairs.add(key);
      }
    }
    return {
      ...moved,
      nodes: moved.nodes
        .filter((n) => n.id !== id)
        .map((n) =>
          n.id === target.id && node.point_id
            ? {
                ...n,
                kind: "entrance",
                point_id: node.point_id,
                candidate: true,
                label: node.label,
              }
            : n,
        ),
      edges: nextEdges,
    };
  }
  if (hit.edgeId) return splitEdge(moved, hit.edgeId, hit.point, id).graph;
  return moved;
}
export function connectCrossing(graph: Graph, edgeIds: string[], p: XY): Graph {
  if (edgeIds.length !== 2) throw new Error("请选择两条相交道路");
  const a = splitEdge(graph, edgeIds[0], p);
  const b = splitEdge(a.graph, edgeIds[1], p, a.nodeId);
  if (b.nodeId !== a.nodeId) {
    const point = b.graph.nodes!.find((n) => n.id === b.nodeId)!.position;
    return moveNode(b.graph, a.nodeId, point, 0.01);
  }
  return b.graph;
}
export function simplify(path: XY[], tolerance: number): XY[] {
  if (path.length < 3) return path;
  let max = 0,
    index = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const d = project(path[i], [path[0], path.at(-1)!]).distance;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [path[0], path.at(-1)!];
  return [
    ...simplify(path.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(path.slice(index), tolerance),
  ];
}
export function makeHistory(initial: Graph) {
  let past: Graph[] = [],
    future: Graph[] = [],
    current = initial;
  return {
    get current() {
      return current;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    reset(value: Graph) {
      past = [];
      future = [];
      current = value;
    },
    change(value: Graph) {
      past = [...past.slice(-39), current];
      future = [];
      current = value;
      return current;
    },
    undo() {
      if (past.length) {
        future = [current, ...future];
        current = past.pop()!;
      }
      return current;
    },
    redo() {
      if (future.length) {
        past.push(current);
        current = future.shift()!;
      }
      return current;
    },
  };
}
