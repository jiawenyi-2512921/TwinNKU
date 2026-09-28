import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import type { components } from "../../shared/api/schema";
import type { MapInfo } from "../../shared/api/client";
import { fromMapPoint, imageBounds, toMapPoint } from "../map/coordinates";
import {
  addStroke,
  edgePath,
  invalidate,
  moveNode,
  simplify,
  snap,
  splitEdge,
  type Graph,
  type XY,
} from "./roadGeometry";
export type RoadMode =
  | "select"
  | "node"
  | "road"
  | "curve"
  | "freehand"
  | "split";
type Path = components["schemas"]["NavigationPath"];
export function RoadCanvas({
  info,
  graph,
  mode,
  editable,
  selected,
  setSelected,
  onChange,
  preview,
  onError,
  drawCommand,
  onSketch,
  snapping,
  showLabels,
  focus,
}: {
  info: MapInfo;
  graph: Graph;
  mode: RoadMode;
  editable: boolean;
  selected: string;
  setSelected: (id: string) => void;
  onChange: (g: Graph) => void;
  preview: Path | null;
  onError: (s: string) => void;
  drawCommand: { id: number; action: "finish" | "cancel" };
  onSketch: (n: number) => void;
  snapping: boolean;
  showLabels: boolean;
  focus: { id: number; position: XY } | null;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    sketch = useRef<XY[]>([]),
    sketchLayer = useRef<L.LayerGroup | null>(null);
  const [tileError, setTileError] = useState(false);
  const latest = useRef({
    graph,
    mode,
    editable,
    onChange,
    setSelected,
    onError,
    onSketch,
    snapping,
  });
  latest.current = {
    graph,
    mode,
    editable,
    onChange,
    setSelected,
    onError,
    onSketch,
    snapping,
  };
  const px = (p: XY) => toMapPoint(p, info.tiles!.max_native_zoom);
  const tolerance = () =>
    latest.current.snapping && map.current
      ? 12 * 2 ** (info.tiles!.max_native_zoom - map.current.getZoom())
      : 0;
  const clamp = (p: XY): XY => ({
    x: Math.max(0, Math.min(info.width_px, p.x)),
    y: Math.max(0, Math.min(info.height_px, p.y)),
  });
  function renderSketch() {
    const layer = sketchLayer.current;
    layer?.clearLayers();
    const points = sketch.current;
    if (layer && points.length) {
      L.polyline(points.map(px), {
        color: "#7841cf",
        weight: 5,
        dashArray: "7 5",
        interactive: false,
      }).addTo(layer);
      points.forEach((p) =>
        L.circleMarker(px(p), {
          radius: 5,
          color: "#7841cf",
          fillOpacity: 1,
          interactive: false,
        }).addTo(layer),
      );
    }
    latest.current.onSketch(points.length);
  }
  function clearSketch() {
    sketch.current = [];
    renderSketch();
  }
  function commit(path = sketch.current, curve: XY | null = null) {
    try {
      const next = addStroke(latest.current.graph, path, tolerance(), curve);
      latest.current.onChange(next);
      latest.current.setSelected(next.edges!.at(-1)!.id);
      clearSketch();
    } catch (e) {
      latest.current.onError(e instanceof Error ? e.message : "绘制失败");
    }
  }
  function click(p: XY, id?: string) {
    const s = latest.current;
    if (!s.editable) return;
    if (s.mode === "node") {
      if (id) {
        s.setSelected(id);
        return;
      }
      const hit = snap(s.graph, p, tolerance());
      if (hit.nodeId) {
        s.setSelected(hit.nodeId);
        return;
      }
      if (hit.edgeId) {
        const result = splitEdge(s.graph, hit.edgeId, hit.point);
        s.onChange(result.graph);
        s.setSelected(result.nodeId);
        return;
      }
      const nid = crypto.randomUUID();
      s.onChange({
        ...s.graph,
        nodes: [
          ...(s.graph.nodes ?? []),
          {
            id: nid,
            position: p,
            label: "新路口",
            kind: "junction",
            point_id: null,
            candidate: false,
            evidence: "",
          },
        ],
      });
      s.setSelected(nid);
    } else if (s.mode === "road" || s.mode === "curve") {
      const point =
        s.mode === "curve" && sketch.current.length === 1
          ? p
          : snap(s.graph, p, tolerance()).point;
      if (
        sketch.current.length &&
        Math.hypot(
          point.x - sketch.current.at(-1)!.x,
          point.y - sketch.current.at(-1)!.y,
        ) < 1
      )
        return;
      sketch.current = [...sketch.current, point];
      renderSketch();
      if (s.mode === "curve" && sketch.current.length === 3)
        commit([sketch.current[0], sketch.current[2]], sketch.current[1]);
      else if (s.mode === "road" && id && sketch.current.length > 1) commit();
    }
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
    const tiles = L.tileLayer(info.tiles.url_template, {
      tileSize: info.tiles.tile_size,
      noWrap: true,
      bounds: imageBounds(info),
      maxNativeZoom: info.tiles.max_native_zoom,
    }).addTo(m);
    tiles.on("tileerror", () => setTileError(true));
    m.fitBounds(imageBounds(info), { padding: [20, 20] });
    sketchLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) =>
      click(clamp(fromMapPoint(e.latlng, info.tiles!.max_native_zoom))),
    );
    const observer = new ResizeObserver(() => m.invalidateSize({ pan: false }));
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      sketchLayer.current = null;
    };
  }, [info]);
  useEffect(() => {
    clearSketch();
    if (mode === "freehand" && editable) {
      map.current?.dragging.disable();
      map.current?.touchZoom.disable();
    } else {
      map.current?.dragging.enable();
      map.current?.touchZoom.enable();
    }
  }, [mode, editable, info]);
  useEffect(() => {
    if (drawCommand.action === "cancel") clearSketch();
    else if (sketch.current.length > 1 && mode === "road") commit();
  }, [drawCommand]);
  useEffect(() => {
    const el = element.current,
      m = map.current;
    if (!el || !m || mode !== "freehand" || !editable) return;
    let active: number | null = null;
    const position = (e: PointerEvent) =>
      clamp(fromMapPoint(m.mouseEventToLatLng(e), info.tiles!.max_native_zoom));
    const down = (e: PointerEvent) => {
      if (
        e.button !== 0 ||
        active !== null ||
        (e.target as Element).closest(".leaflet-control")
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      active = e.pointerId;
      el.setPointerCapture(e.pointerId);
      sketch.current = [position(e)];
      renderSketch();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      e.preventDefault();
      const p = position(e);
      if (
        Math.hypot(
          p.x - sketch.current.at(-1)!.x,
          p.y - sketch.current.at(-1)!.y,
        ) > Math.max(1, tolerance() / 4)
      ) {
        sketch.current.push(p);
        if (sketch.current.length > 5000) {
          active = null;
          clearSketch();
          onError("笔画过长，请分段描绘");
          return;
        }
        renderSketch();
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      el.releasePointerCapture(e.pointerId);
      sketch.current.push(position(e));
      let tol = 3 * 2 ** (info.tiles!.max_native_zoom - m.getZoom());
      let path = simplify(sketch.current, tol);
      while (path.length > 102) {
        tol *= 1.4;
        path = simplify(sketch.current, tol);
      }
      commit(path);
    };
    const cancel = () => {
      active = null;
      clearSketch();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    el.addEventListener("pointerup", up, true);
    el.addEventListener("pointercancel", cancel, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      el.removeEventListener("pointerup", up, true);
      el.removeEventListener("pointercancel", cancel, true);
    };
  }, [mode, editable, info]);
  useEffect(() => {
    if (focus && map.current)
      map.current.setView(
        px(focus.position),
        Math.max(map.current.getZoom(), info.tiles!.max_native_zoom - 1),
      );
  }, [focus, info]);
  useEffect(() => {
    const m = map.current;
    if (!m || !info.tiles) return;
    const layer = L.layerGroup().addTo(m);
    const apply = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        latest.current.onError(e instanceof Error ? e.message : "编辑失败");
      }
    };
    const handle = (
      position: XY,
      className: string,
      onDrag: (p: XY) => void,
      title: string,
    ) => {
      const html = document.createElement("span");
      html.className = className;
      html.title = title;
      const marker = L.marker(px(position), {
        draggable: editable,
        bubblingMouseEvents: false,
        icon: L.divIcon({
          html,
          className: "road-shape-marker",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(layer);
      marker.bindTooltip(title);
      marker.on("dragend", () =>
        onDrag(
          clamp(fromMapPoint(marker.getLatLng(), info.tiles!.max_native_zoom)),
        ),
      );
      return marker;
    };
    for (const edge of graph.edges ?? []) {
      const path = edgePath(edge, graph);
      if (path.length < 2) continue;
      const chosen = edge.id === selected;
      const poly = L.polyline(path.map(px), {
        color: chosen
          ? "#7e42c6"
          : edge.closed
            ? "#d65555"
            : edge.verified
              ? "#168b7f"
              : "#c78a2b",
        weight: chosen ? 7 : 4,
        dashArray: edge.closed || !edge.verified ? "7 5" : undefined,
        bubblingMouseEvents: false,
      }).addTo(layer);
      const label = document.createElement("span");
      label.textContent = `${edge.label || "道路"} ${edge.bidirectional ? "↔" : "→"}${edge.closed ? " · 封闭" : ""}`;
      poly.bindTooltip(label);
      poly.on("click", (ev: L.LeafletMouseEvent) => {
        const s = latest.current,
          p = clamp(fromMapPoint(ev.latlng, info.tiles!.max_native_zoom));
        if (s.editable && s.mode === "split")
          apply(() => {
            const r = splitEdge(s.graph, edge.id, p);
            s.onChange(r.graph);
            s.setSelected(r.nodeId);
          });
        else if (["node", "road", "curve"].includes(s.mode)) click(p);
        else s.setSelected(edge.id);
      });
      if (chosen && editable && mode === "select") {
        const change = (values: Partial<typeof edge>) =>
          latest.current.onChange({
            ...latest.current.graph,
            edges: (latest.current.graph.edges ?? []).map((e) =>
              e.id === edge.id ? { ...invalidate(e), ...values } : e,
            ),
          });
        if (edge.curve_control) {
          L.polyline([path[0], edge.curve_control, path.at(-1)!].map(px), {
            color: "#ae93c6",
            weight: 1,
            dashArray: "3 5",
            interactive: false,
          }).addTo(layer);
          handle(
            edge.curve_control,
            "road-handle curve",
            (p) => change({ curve_control: p }),
            "拖动弧线控制点",
          );
        } else {
          (edge.via ?? []).forEach((p, i) => {
            const h = handle(
              p,
              "road-handle",
              (point) =>
                change({ via: edge.via!.map((v, j) => (j === i ? point : v)) }),
              "拖动调整形状；双击移除形状点",
            );
            h.on("dblclick", () =>
              change({ via: edge.via!.filter((_, j) => j !== i) }),
            );
          });
          if (path.length < 102)
            for (let i = 0; i < path.length - 1; i++) {
              const a = path[i],
                b = path[i + 1];
              handle(
                { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                "road-handle insert",
                (p) =>
                  change({
                    via: [
                      ...(edge.via ?? []).slice(0, i),
                      p,
                      ...(edge.via ?? []).slice(i),
                    ],
                  }),
                "拖动中点增加形状点",
              );
            }
        }
      }
    }
    for (const node of graph.nodes ?? []) {
      const html = document.createElement("span");
      html.className = `road-dot ${node.kind === "entrance" ? "entrance" : ""} ${node.candidate ? "candidate" : ""} ${node.id === selected ? "selected" : ""}`;
      const marker = L.marker(px(node.position), {
        draggable: editable && mode === "select",
        bubblingMouseEvents: false,
        icon: L.divIcon({
          html,
          className: "road-node-marker",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(layer);
      const label = document.createElement("span");
      label.textContent =
        (node.candidate ? "待确认·" : "") + (node.label || node.id.slice(0, 6));
      marker.bindTooltip(label, {
        permanent: showLabels || node.id === selected,
        direction: "top",
      });
      marker.on("click", () => {
        if (["node", "road", "curve"].includes(latest.current.mode))
          click(node.position, node.id);
        else latest.current.setSelected(node.id);
      });
      marker.on("dragend", () => {
        const position = marker.getLatLng();
        marker.setLatLng(px(node.position));
        apply(() =>
          latest.current.onChange(
            moveNode(
              latest.current.graph,
              node.id,
              clamp(fromMapPoint(position, info.tiles!.max_native_zoom)),
              tolerance(),
            ),
          ),
        );
      });
    }
    for (const segment of preview?.segments ?? [])
      L.polyline(segment.path.map(px), {
        color: "#177be7",
        weight: 8,
        opacity: 0.8,
        interactive: false,
      }).addTo(layer);
    sketchLayer.current?.remove();
    sketchLayer.current = L.layerGroup().addTo(m);
    renderSketch();
    return () => {
      layer.remove();
    };
  }, [graph, selected, editable, mode, info, preview, showLabels]);
  return (
    <>
      <div
        ref={element}
        className={`road-map road-mode-${mode}`}
        role="region"
        aria-label="道路与建筑入口编辑地图"
      />
      {tileError && (
        <p role="alert">部分底图加载失败，请重新加载后核对道路。</p>
      )}
    </>
  );
}
