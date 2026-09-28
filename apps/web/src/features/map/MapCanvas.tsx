import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  MapFeatures,
  MapInfo,
  Point,
  RouteSegment,
} from "../../shared/api/client";
import type { RoutePickMode } from "./NavigationPanel";
import { imageBounds, toMapPoint } from "./coordinates";
import { appendMapLabelCorrections } from "./labelCorrections";

type Props = {
  info: MapInfo;
  features: MapFeatures;
  points: Point[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  routeSegments?: RouteSegment[];
  routePickMode?: RoutePickMode;
  routeStartId?: string | null;
  routeEndId?: string | null;
  routeAvailablePointIds?: string[];
  onRoutePick?: (id: string) => void;
  onRoutePickCancel?: () => void;
};

export function MapCanvas({
  info,
  features,
  points,
  selectedId,
  onSelect,
  routeSegments = [],
  routePickMode = null,
  routeStartId = null,
  routeEndId = null,
  routeAvailablePointIds = [],
  onRoutePick,
  onRoutePickCancel,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map | null>(null);
  const tileLayer = useRef<L.TileLayer | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [tileError, setTileError] = useState(false);
  const routePick = useRef({
    mode: routePickMode,
    onRoutePick,
    onRoutePickCancel,
  });
  routePick.current = { mode: routePickMode, onRoutePick, onRoutePickCancel };

  useEffect(() => {
    if (!element.current || !info.tiles) return;
    setTileError(false);
    const map = L.map(element.current, {
      crs: L.CRS.Simple,
      zoomControl: false,
      attributionControl: false,
      minZoom: info.tiles.min_zoom,
      maxZoom: info.tiles.max_native_zoom + 1,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      maxBoundsViscosity: 0.9,
      preferCanvas: false,
    });
    instance.current = map;
    map.setMaxBounds(imageBounds(info).pad(0.14));
    const layer = L.tileLayer(info.tiles.url_template, {
      tileSize: info.tiles.tile_size,
      noWrap: true,
      bounds: imageBounds(info),
      minZoom: info.tiles.min_zoom,
      maxNativeZoom: info.tiles.max_native_zoom,
      maxZoom: info.tiles.max_native_zoom + 1,
      keepBuffer: 1,
      updateWhenIdle: true,
    }).addTo(map);
    tileLayer.current = layer;
    layer.on("tileerror", () => setTileError(true));
    const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resize.observe(element.current);
    map.fitBounds(imageBounds(info), { padding: [18, 18], animate: false });
    return () => {
      resize.disconnect();
      map.remove();
      instance.current = null;
      tileLayer.current = null;
    };
  }, [info]);

  useEffect(() => {
    const map = instance.current;
    if (
      !map ||
      !info.tiles ||
      features.map_id !== info.id ||
      features.map_revision !== info.revision
    )
      return;
    const outlines = L.layerGroup().addTo(map);
    const byId = new Map(points.map((p) => [p.id, p]));
    const valid = features.points.filter(
      (feature) =>
        feature.map_id === info.id &&
        feature.map_revision === info.revision &&
        byId.has(feature.point_id),
    );
    const area = (polygon: (typeof valid)[number]["polygon"]) =>
      Math.abs(
        polygon.reduce((sum, a, i) => {
          const b = polygon[(i + 1) % polygon.length];
          return sum + a.x * b.y - b.x * a.y;
        }, 0),
      );
    // Parent groups draw first; smaller building sections retain click priority.
    for (const feature of [...valid].sort(
      (a, b) => area(b.polygon) - area(a.polygon),
    )) {
      const point = byId.get(feature.point_id)!;
      const selected = selectedId === point.id;
      const eligible = routeAvailablePointIds.includes(point.id);
      const endpoint = routeStartId === point.id || routeEndId === point.id;
      const showCandidate = Boolean(routePickMode && eligible);
      const color = routeStartId === point.id ? "#18785f" : "#713573";
      const base = {
        color,
        weight: selected || endpoint ? 2.5 : 1.5,
        opacity: selected || endpoint || showCandidate ? 1 : 0,
        fillColor: color,
        fillOpacity: selected || endpoint ? 0.2 : showCandidate ? 0.12 : 0,
      };
      const polygon = L.polygon(
        feature.polygon.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
        { ...base, bubblingMouseEvents: false },
      ).addTo(outlines);
      const tooltip = document.createElement("span");
      tooltip.textContent = routePickMode
        ? `${point.name}${eligible ? ` · 设为${routePickMode === "start" ? "起点" : "终点"}` : " · 暂无可用入口"}`
        : point.name;
      polygon.bindTooltip(tooltip, {
        direction: "top",
        className: "point-tooltip",
        sticky: true,
      });
      const activate = () => {
        if (routePick.current.mode) {
          // Never open details while choosing an endpoint. The panel validates
          // availability again before accepting the clicked public point.
          routePick.current.onRoutePick?.(point.id);
        } else select.current(point.id);
      };
      polygon.on("click", activate);
      polygon.on("mouseover", () =>
        polygon.setStyle({ fillOpacity: 0.24, opacity: 1 }),
      );
      polygon.on("mouseout", () => polygon.setStyle(base));
      const path = polygon.getElement();
      if (path) {
        path.setAttribute("tabindex", routePickMode && !eligible ? "-1" : "0");
        path.setAttribute("role", "button");
        path.setAttribute(
          "aria-label",
          routePickMode
            ? `${point.name}，${eligible ? `设为${routePickMode === "start" ? "起点" : "终点"}` : "暂无可用入口"}`
            : `查看${point.name}`,
        );
        if (routePickMode && !eligible)
          path.setAttribute("aria-disabled", "true");
        path.setAttribute("aria-pressed", String(selected || endpoint));
        path.addEventListener("keydown", (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === "Enter" || key === " ") {
            event.preventDefault();
            activate();
          }
        });
        path.addEventListener("focus", () => {
          polygon.setStyle({ fillOpacity: 0.24, opacity: 1 });
          polygon.openTooltip();
        });
        path.addEventListener("blur", () => {
          polygon.setStyle(base);
          polygon.closeTooltip();
        });
      }
    }
    return () => {
      outlines.remove();
    };
  }, [
    info,
    features,
    points,
    selectedId,
    routePickMode,
    routeStartId,
    routeEndId,
    routeAvailablePointIds,
  ]);

  useEffect(() => {
    const map = instance.current;
    if (
      !map ||
      !info.tiles ||
      features.map_id !== info.id ||
      features.map_revision !== info.revision
    )
      return;
    const markers = L.layerGroup().addTo(map);
    for (const [id, label, kind] of [
      [routeStartId, "起点", "start"],
      [routeEndId, "终点", "end"],
    ]) {
      const feature = features.points.find(
        (item) =>
          item.point_id === id &&
          item.map_id === info.id &&
          item.map_revision === info.revision,
      );
      const point = points.find((item) => item.id === id);
      if (!feature || !point) continue;
      const badge = document.createElement("span");
      badge.className = `map-route-badge ${kind}`;
      badge.textContent = label!;
      const marker = L.marker(
        toMapPoint(feature.anchor, info.tiles.max_native_zoom),
        {
          icon: L.divIcon({
            html: badge,
            className: "map-route-marker",
            iconSize: [36, 28],
            iconAnchor: [18, 28],
          }),
          interactive: false,
          keyboard: false,
          zIndexOffset: 500,
        },
      ).addTo(markers);
      const text = document.createElement("span");
      text.textContent = `${label}：${point.name}`;
      marker.bindTooltip(text);
    }
    return () => {
      markers.remove();
    };
  }, [info, features, points, routeStartId, routeEndId]);

  useEffect(() => {
    const map = instance.current;
    if (
      !map ||
      !info.tiles ||
      features.map_id !== info.id ||
      features.map_revision !== info.revision
    )
      return;
    const byId = new Map(points.map((point) => [point.id, point]));
    const labels = features.points.filter(
      (feature) =>
        feature.label_on_map &&
        feature.map_id === info.id &&
        feature.map_revision === info.revision &&
        byId.has(feature.point_id),
    );
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${info.width_px} ${info.height_px}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("map-image-annotation");
    const correctionCount = appendMapLabelCorrections(
      svg,
      info,
      features,
      points,
    );
    if (!labels.length && !correctionCount) return;
    for (const feature of labels) {
      const text = document.createElementNS(ns, "text");
      const referenceScale = info.width_px / 1536;
      text.setAttribute("x", String(feature.anchor.x));
      text.setAttribute("y", String(feature.anchor.y));
      text.setAttribute("dy", ".37em");
      text.setAttribute("font-size", String(11.3 * referenceScale));
      text.setAttribute("stroke-width", String(2.4 * referenceScale));
      text.textContent = byId.get(feature.point_id)!.name;
      svg.appendChild(text);
    }
    const annotation = L.svgOverlay(svg, imageBounds(info), {
      interactive: false,
    }).addTo(map);
    return () => {
      annotation.remove();
    };
  }, [info, features, points]);

  const selectedFeature = features.points.find(
    (p) => p.point_id === selectedId,
  );
  const selectedRegion = JSON.stringify(selectedFeature?.polygon ?? null);
  useEffect(() => {
    const map = instance.current;
    const feature = selectedFeature;
    if (
      !map ||
      !feature ||
      !info.tiles ||
      feature.map_id !== info.id ||
      feature.map_revision !== info.revision
    )
      return;
    if (routeSegments.length || routePickMode) return;
    const bounds = L.latLngBounds(
      feature.polygon.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
    );
    const narrow = window.matchMedia("(max-width: 760px)").matches;
    const height = map.getSize().y;
    const fit = () =>
      map.fitBounds(bounds.pad(0.65), {
        paddingTopLeft: [40, 48],
        paddingBottomRight: narrow
          ? [40, Math.min(260, height * 0.5)]
          : [410, 50],
        maxZoom: info.tiles!.max_native_zoom,
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    const timer = window.setTimeout(fit, 30);
    return () => window.clearTimeout(timer);
  }, [selectedId, info, selectedRegion, routeSegments, routePickMode]);

  useEffect(() => {
    const map = instance.current;
    if (!map || !info.tiles) return;
    const layer = L.layerGroup().addTo(map);
    const routeBounds = L.latLngBounds([]);
    for (const segment of routeSegments) {
      if (
        segment.map_id === info.id &&
        segment.map_revision === info.revision
      ) {
        const coordinates = segment.path.map((p) =>
          toMapPoint(p, info.tiles!.max_native_zoom),
        );
        coordinates.forEach((p) => routeBounds.extend(p));
        L.polyline(coordinates, {
          color: "#fff",
          weight: 10,
          opacity: 0.95,
        }).addTo(layer);
        for (const [index, p] of [
          coordinates[0],
          coordinates[coordinates.length - 1],
        ].entries()) {
          const label = document.createElement("span");
          label.textContent = index === 0 ? "起点入口" : "终点入口";
          L.circleMarker(p, {
            radius: 7,
            color: "#fff",
            weight: 3,
            fillColor: index === 0 ? "#267c6b" : "#74417f",
            fillOpacity: 1,
          })
            .bindTooltip(label)
            .addTo(layer);
        }
        L.polyline(
          segment.path.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
          { color: "#713573", weight: 5, opacity: 0.9 },
        ).addTo(layer);
      }
    }
    if (routeBounds.isValid())
      map.fitBounds(routeBounds, {
        paddingTopLeft: [35, 50],
        paddingBottomRight: window.matchMedia("(max-width: 760px)").matches
          ? [35, Math.min(380, map.getSize().y * 0.62)]
          : [410, 70],
        maxZoom: info.tiles.max_native_zoom,
        animate: false,
      });
    return () => {
      layer.remove();
    };
  }, [routeSegments, info]);

  return (
    <>
      <div
        className={`map-canvas${routePickMode ? " is-route-picking" : ""}`}
        ref={element}
        role="region"
        aria-label={
          routePickMode
            ? `津南校区地图，选择${routePickMode === "start" ? "起点" : "终点"}。可拖动，滚轮或双指缩放；Tab 切换地点，回车确认，Esc 取消。`
            : "津南校区交互地图，可拖动，滚轮或双指缩放；方向键移动，加减键缩放。"
        }
        onKeyDown={(event) => {
          if (event.key === "Escape" && routePick.current.mode) {
            event.preventDefault();
            event.stopPropagation();
            routePick.current.onRoutePickCancel?.();
          }
        }}
        tabIndex={0}
      />
      {tileError && (
        <div className="tile-warning" role="status">
          部分地图未加载{" "}
          <button
            onClick={() => {
              setTileError(false);
              tileLayer.current?.redraw();
            }}
          >
            重新加载
          </button>
        </div>
      )}
      <div className="map-attribution">
        规划图导览 ·{" "}
        <a href="https://leafletjs.com" target="_blank" rel="noreferrer">
          Leaflet
        </a>
      </div>
    </>
  );
}
