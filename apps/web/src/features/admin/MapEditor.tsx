import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapInfo } from "../../shared/api/client";
import { fromMapPoint, imageBounds, toMapPoint } from "../map/coordinates";
import type { AdminMapPoint, GeometryInput } from "./api";
import {
  clampPoint,
  moveGeometry,
  rectangle,
  validPolygon,
  type XY,
} from "./geometry";
import { ErrorBox } from "./ui";
type Props = {
  info: MapInfo;
  points: AdminMapPoint[];
  selectedId: string | null;
  value: GeometryInput | null;
  name: string;
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (value: GeometryInput) => void;
  onUndo: () => void;
  canUndo: boolean;
};
type Mode = "pan" | "move" | "label" | "reshape" | "polygon" | "rectangle";
export function MapEditor(props: Props) {
  const { info, points, selectedId, value, name, editable } = props;
  const node = useRef<HTMLDivElement>(null),
    mapRef = useRef<L.Map | null>(null),
    latest = useRef(props),
    tiles = useRef<L.TileLayer | null>(null);
  latest.current = props;
  const [mode, setMode] = useState<Mode>("pan"),
    [drawing, setDrawing] = useState<XY[]>([]),
    [error, setError] = useState(""),
    [tileError, setTileError] = useState(false),
    [vertex, setVertex] = useState<number | null>(null);
  const drawingRef = useRef(drawing),
    modeRef = useRef(mode);
  drawingRef.current = drawing;
  modeRef.current = mode;
  useEffect(() => {
    setMode("pan");
    setDrawing([]);
    setError("");
    setVertex(null);
  }, [selectedId, editable]);
  useEffect(() => {
    if (!node.current || !info.tiles) return;
    setTileError(false);
    const m = L.map(node.current, {
      crs: L.CRS.Simple,
      attributionControl: false,
      zoomControl: false,
      minZoom: 0,
      maxZoom: info.tiles.max_native_zoom + 1,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      doubleClickZoom: false,
      maxBoundsViscosity: 0.8,
    });
    mapRef.current = m;
    m.setMaxBounds(imageBounds(info).pad(0.15));
    tiles.current = L.tileLayer(info.tiles.url_template, {
      tileSize: info.tiles.tile_size,
      noWrap: true,
      bounds: imageBounds(info),
      maxNativeZoom: info.tiles.max_native_zoom,
      maxZoom: info.tiles.max_native_zoom + 1,
    })
      .addTo(m)
      .on("tileerror", () => setTileError(true));
    m.fitBounds(imageBounds(info), { padding: [24, 24], animate: false });
    const observer = new ResizeObserver(() => m.invalidateSize({ pan: false }));
    observer.observe(node.current);
    const finish = (polygon: XY[]) => {
      const state = latest.current;
      if (!state.value) return;
      const invalid = validPolygon(polygon, info.width_px, info.height_px);
      if (invalid) {
        setError(invalid);
        return;
      }
      state.onChange({ ...state.value, polygon });
      setDrawing([]);
      setMode("pan");
      setError("");
    };
    m.on("click", (event: L.LeafletMouseEvent) => {
      const state = latest.current;
      if (!state.editable || !state.value) return;
      const p = clampPoint(
        fromMapPoint(event.latlng, info.tiles!.max_native_zoom),
        info.width_px,
        info.height_px,
      );
      if (modeRef.current === "move" || modeRef.current === "label") {
        try {
          state.onChange(
            modeRef.current === "move"
              ? moveGeometry(state.value, p, info.width_px, info.height_px)
              : { ...state.value, anchor: p },
          );
          setMode("pan");
          setError("");
        } catch (e) {
          setError((e as Error).message);
        }
      }
      if (modeRef.current === "polygon") {
        if (drawingRef.current.length >= 200) {
          setError("最多支持 200 个顶点");
          return;
        }
        setDrawing((prev) => [...prev, p]);
        setError("");
      }
      if (modeRef.current === "rectangle") {
        if (drawingRef.current.length)
          finish(rectangle(drawingRef.current[0], p));
        else setDrawing([p]);
      }
    });
    return () => {
      observer.disconnect();
      m.remove();
      mapRef.current = null;
      tiles.current = null;
    };
  }, [info]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !info.tiles) return;
    const z = info.tiles.max_native_zoom,
      group = L.layerGroup().addTo(m);
    for (const p of points) {
      if (p.id === selectedId) continue;
      const g = p.draft_geometry ?? p.geometry;
      if (!g) continue;
      const shape = L.polygon(
        g.polygon.map((p) => toMapPoint(p, z)),
        {
          color: p.draft_geometry ? "#b57922" : "#747283",
          weight: 1,
          fillOpacity: 0.04,
          opacity: 0.65,
          interactive: mode === "pan",
          bubblingMouseEvents: false,
        },
      ).addTo(group);
      const title = document.createElement("span");
      title.textContent = p.name;
      shape.bindTooltip(title, { sticky: true });
      shape.on("click", () => latest.current.onSelect(p.id));
      const path = shape.getElement();
      if (path && mode === "pan") {
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "button");
        path.setAttribute("aria-label", `编辑${p.name}`);
        path.addEventListener("keydown", (event) => {
          if (!["Enter", " "].includes((event as KeyboardEvent).key)) return;
          event.preventDefault();
          latest.current.onSelect(p.id);
        });
      }
    }
    if (value) {
      const published = points.find((p) => p.id === selectedId)?.geometry;
      if (
        published &&
        JSON.stringify(published.polygon) !== JSON.stringify(value.polygon)
      ) {
        L.polygon(
          published.polygon.map((p) => toMapPoint(p, z)),
          {
            color: "#6e7180",
            weight: 2,
            dashArray: "6 5",
            fillOpacity: 0,
            interactive: false,
          },
        ).addTo(group);
      }
      L.polygon(
        value.polygon.map((p) => toMapPoint(p, z)),
        {
          color: "#682d70",
          weight: 2.5,
          fillOpacity: 0.17,
          interactive: false,
        },
      ).addTo(group);
      const anchor = L.marker(toMapPoint(value.anchor, z), {
        icon: L.divIcon({
          className: "ad-anchor",
          html: "",
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        draggable: editable && mode === "move",
        title:
          mode === "move" ? "拖动定位点，同时移动点击范围" : "当前地点定位点",
        keyboard: true,
      }).addTo(group);
      anchor.on("dragend", () => {
        const current = latest.current.value;
        if (!current || !latest.current.editable) return;
        try {
          latest.current.onChange(
            moveGeometry(
              current,
              fromMapPoint(anchor.getLatLng(), z),
              info.width_px,
              info.height_px,
            ),
          );
          setError("");
        } catch (e) {
          anchor.setLatLng(toMapPoint(current.anchor, z));
          setError((e as Error).message);
        }
      });
      if (editable && mode === "reshape")
        value.polygon.forEach((p, i) => {
          const marker = L.marker(toMapPoint(p, z), {
            icon: L.divIcon({
              className: `ad-vertex${vertex === i ? " selected" : ""}`,
              html: "",
              iconSize: [12, 12],
              iconAnchor: [6, 6],
            }),
            draggable: true,
            title: `点击范围顶点 ${i + 1}`,
          }).addTo(group);
          marker.on("click", () => setVertex(i));
          marker.on("dragend", () => {
            const v = latest.current.value;
            if (!v || !latest.current.editable) return;
            const polygon = v.polygon.map((p, j) =>
              j === i
                ? clampPoint(
                    fromMapPoint(marker.getLatLng(), z),
                    info.width_px,
                    info.height_px,
                  )
                : p,
            );
            const invalid = validPolygon(
              polygon,
              info.width_px,
              info.height_px,
            );
            if (invalid) {
              setError(invalid);
              marker.setLatLng(toMapPoint(p, z));
              return;
            }
            setError("");
            latest.current.onChange({ ...v, polygon });
          });
        });
      if (value.label_on_map && name) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", `0 0 ${info.width_px} ${info.height_px}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.classList.add("map-image-annotation");
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", String(value.anchor.x));
        t.setAttribute("y", String(value.anchor.y));
        t.setAttribute("dy", ".37em");
        t.setAttribute("font-size", String((11.3 * info.width_px) / 1536));
        t.setAttribute("stroke-width", String((2.4 * info.width_px) / 1536));
        t.textContent = name;
        svg.appendChild(t);
        L.svgOverlay(svg, imageBounds(info), { interactive: false }).addTo(
          group,
        );
      }
    }
    if (drawing.length) {
      L.polyline(
        drawing.map((p) => toMapPoint(p, z)),
        { color: "#bd8227", weight: 3, dashArray: "7 5", interactive: false },
      ).addTo(group);
      drawing.forEach((p) =>
        L.circleMarker(toMapPoint(p, z), {
          radius: 4,
          color: "#bd8227",
          interactive: false,
        }).addTo(group),
      );
    }
    return () => {
      group.remove();
    };
  }, [info, points, selectedId, value, name, editable, mode, drawing, vertex]);
  const focus = () => {
    const m = mapRef.current;
    if (!m || !info.tiles) return;
    if (value)
      m.fitBounds(
        L.latLngBounds(
          value.polygon.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
        ).pad(1),
        { maxZoom: info.tiles.max_native_zoom, padding: [50, 50] },
      );
    else m.fitBounds(imageBounds(info), { padding: [24, 24] });
  };
  useEffect(() => {
    if (selectedId && value) focus();
  }, [selectedId, info]);
  useEffect(() => {
    if (mode === "pan") return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMode("pan");
      setDrawing([]);
      setVertex(null);
      setError("");
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [mode]);
  const choose = (next: Mode) => {
    setMode(next);
    setDrawing([]);
    setVertex(null);
    setError("");
  };
  const complete = () => {
    if (!value || !editable) return;
    const invalid = validPolygon(drawing, info.width_px, info.height_px);
    if (invalid) {
      setError(invalid);
      return;
    }
    props.onChange({ ...value, polygon: drawing });
    choose("pan");
  };
  const removeVertex = () => {
    if (!value || !editable || vertex === null) return;
    const p = value.polygon.filter((_, i) => i !== vertex);
    const invalid = validPolygon(p, info.width_px, info.height_px);
    if (invalid) {
      setError(invalid);
      return;
    }
    props.onChange({ ...value, polygon: p });
    setVertex(null);
  };
  return (
    <div className="ad-map-editor">
      <div className="ad-map-toolbar" aria-label="地图编辑工具">
        <button
          className={mode === "pan" ? "active" : ""}
          aria-pressed={mode === "pan"}
          onClick={() => choose("pan")}
        >
          选择地点
        </button>
        {editable && value && (
          <>
            <button
              className={mode === "move" ? "active" : ""}
              aria-pressed={mode === "move"}
              onClick={() => choose("move")}
            >
              移动位置
            </button>
            {value.label_on_map && (
              <button
                className={mode === "label" ? "active" : ""}
                onClick={() => choose("label")}
              >
                移动新增文字
              </button>
            )}
            <button
              className={
                ["reshape", "rectangle", "polygon"].includes(mode)
                  ? "active"
                  : ""
              }
              onClick={() => choose("reshape")}
            >
              调整点击范围
            </button>
            <button
              disabled={!props.canUndo}
              onClick={() => {
                choose("pan");
                props.onUndo();
              }}
            >
              撤销位置调整
            </button>
          </>
        )}
        <button onClick={focus} disabled={!value}>
          查看选中地点
        </button>
        <button
          onClick={() =>
            mapRef.current?.fitBounds(imageBounds(info), { padding: [24, 24] })
          }
        >
          全图
        </button>
      </div>
      {editable &&
        value &&
        ["reshape", "rectangle", "polygon"].includes(mode) && (
          <div className="ad-point-shape-tools" aria-label="点击范围工具">
            <strong>调整点击范围</strong>
            <button
              className={mode === "reshape" ? "active" : ""}
              onClick={() => choose("reshape")}
            >
              拖动边界角点
            </button>
            <button
              className={mode === "rectangle" ? "active" : ""}
              onClick={() => choose("rectangle")}
            >
              重新画矩形
            </button>
            <button
              className={mode === "polygon" ? "active" : ""}
              onClick={() => choose("polygon")}
            >
              重新画多边形
            </button>
          </div>
        )}
      <div
        className={`ad-map-surface ${mode !== "pan" ? "is-drawing" : ""}`}
        ref={node}
        role="region"
        aria-label="原图地图编辑器，可拖动缩放，或使用表单坐标调整"
        tabIndex={0}
      />
      <div className="ad-zoom">
        <button aria-label="放大" onClick={() => mapRef.current?.zoomIn()}>
          ＋
        </button>
        <button aria-label="缩小" onClick={() => mapRef.current?.zoomOut()}>
          −
        </button>
      </div>
      <div className="ad-map-note">
        <span className="ad-dot" />{" "}
        {mode === "move"
          ? "点击新位置：定位点和整个点击范围一起移动"
          : mode === "label"
            ? "点击新的文字位置；点击范围保持原位，底图内的字不变"
            : mode === "reshape"
              ? "拖动白色角点调整边界；选中角点后可删除。灰色虚线是原有范围。"
              : mode === "rectangle"
                ? `点击矩形的${drawing.length ? "另一个" : "第一个"}对角`
                : mode === "polygon"
                  ? `依次点击边界 · 已选 ${drawing.length} 个顶点`
                  : editable && value
                    ? "已选中地点。可直接修改右侧资料；需要改位置或范围时，点击上方对应按钮。"
                    : "点击轮廓选中地点；滚轮或双指缩放"}
        {mode === "polygon" && (
          <>
            <button disabled={drawing.length < 3} onClick={complete}>
              完成范围
            </button>
            <button
              disabled={!drawing.length}
              onClick={() => setDrawing((p) => p.slice(0, -1))}
            >
              撤销顶点
            </button>
          </>
        )}
        {mode !== "pan" && (
          <button onClick={() => choose("pan")}>
            {mode === "reshape" ? "完成范围调整" : "取消调整"}
          </button>
        )}
        {editable && mode === "reshape" && vertex !== null && (
          <button
            onClick={removeVertex}
            disabled={(value?.polygon.length ?? 0) <= 3}
          >
            删除第 {vertex + 1} 个顶点
          </button>
        )}
      </div>
      {tileError && (
        <div className="ad-map-notice">
          <ErrorBox
            text="部分地图未加载"
            onRetry={() => {
              setTileError(false);
              tiles.current?.redraw();
            }}
          />
        </div>
      )}
      {error && (
        <div className="ad-map-notice">
          <ErrorBox text={error} />
        </div>
      )}
    </div>
  );
}
