import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  MapFeatures,
  MapInfo,
  Point,
  RouteSegment,
} from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { imageBounds, toMapPoint } from "./coordinates";
import {
  labelPriority,
  placeLabels,
  shouldLabel,
  type LabelCandidate,
} from "./labels";

type Props = {
  info: MapInfo;
  features: MapFeatures;
  points: Point[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  routeSegments?: RouteSegment[];
};

export function MapCanvas({
  info,
  features,
  points,
  selectedId,
  onSelect,
  routeSegments = [],
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map | null>(null);
  const tileLayer = useRef<L.TileLayer | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [tileError, setTileError] = useState(false);
  const [zoom, setZoom] = useState(0);

  useEffect(() => {
    if (!element.current || !info.tiles) return;
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
    map.on("zoomend", () => setZoom(map.getZoom()));
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
    const labels = L.layerGroup().addTo(map);
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
      const base = {
        color: "#713573",
        weight: selected ? 2.5 : 1.5,
        opacity: selected ? 1 : 0,
        fillColor: "#9251a1",
        fillOpacity: selected ? 0.2 : 0,
      };
      const polygon = L.polygon(
        feature.polygon.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
        { ...base, bubblingMouseEvents: false },
      ).addTo(outlines);
      const tooltip = document.createElement("span");
      tooltip.textContent = point.name;
      polygon.bindTooltip(tooltip, {
        direction: "top",
        className: "point-tooltip",
        sticky: true,
      });
      polygon.on("click", () => select.current(point.id));
      polygon.on("mouseover", () =>
        polygon.setStyle({ fillOpacity: 0.24, opacity: 1 }),
      );
      polygon.on("mouseout", () => polygon.setStyle(base));
      const path = polygon.getElement();
      if (path) {
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "button");
        path.setAttribute("aria-label", `查看${point.name}`);
        path.setAttribute("aria-pressed", String(selected));
        path.addEventListener("keydown", (event) => {
          const key = (event as KeyboardEvent).key;
          if (key === "Enter" || key === " ") {
            event.preventDefault();
            select.current(point.id);
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
    const context = document.createElement("canvas").getContext("2d");
    if (context)
      context.font = `600 14px ${getComputedStyle(element.current!).fontFamily}`;
    const redrawLabels = () => {
      labels.clearLayers();
      const size = map.getSize();
      const candidates: LabelCandidate[] = [];
      for (const feature of valid) {
        const point = byId.get(feature.point_id)!;
        const selected = selectedId === point.id;
        if (!labelsVisible && !selected) continue;
        const priority = labelPriority(point.name, point.category);
        const corners = feature.polygon.map((p) =>
          map.latLngToContainerPoint(
            toMapPoint(p, info.tiles!.max_native_zoom),
          ),
        );
        const footprint = Math.max(
          Math.max(...corners.map((p) => p.x)) -
            Math.min(...corners.map((p) => p.x)),
          Math.max(...corners.map((p) => p.y)) -
            Math.min(...corners.map((p) => p.y)),
        );
        if (!shouldLabel(priority, footprint, selected)) continue;
        const anchor = map.latLngToContainerPoint(
          toMapPoint(feature.anchor, info.tiles!.max_native_zoom),
        );
        const textWidth =
          context?.measureText(point.name).width ?? point.name.length * 14;
        const width = Math.min(174, Math.ceil(textWidth) + 22);
        const height = Math.ceil(textWidth / (width - 20)) * 20 + 12;
        candidates.push({
          id: point.id,
          x: anchor.x,
          y: anchor.y,
          width,
          height,
          priority,
          selected,
        });
      }
      const narrow = window.matchMedia("(max-width: 760px)").matches;
      const excluded = [
        { left: 8, top: 8, right: Math.min(290, size.x - 8), bottom: 56 },
      ];
      if (selectedId && !narrow)
        excluded.push({
          left: size.x - 355,
          top: 12,
          right: size.x,
          bottom: size.y,
        });
      for (const label of placeLabels(
        candidates,
        { width: size.x, height: size.y },
        excluded,
      )) {
        const point = byId.get(label.id)!;
        const node = document.createElement("span");
        node.className = `map-name${label.selected ? " is-selected" : ""}`;
        node.textContent = point.name;
        node.style.width = `${label.width}px`;
        const icon = L.divIcon({
          html: node,
          className: "map-name-holder",
          iconSize: [label.width, label.height],
          iconAnchor: [0, 0],
        });
        const marker = L.marker(
          map.containerPointToLatLng([label.box.left, label.box.top]),
          {
            icon,
            title: point.name,
            alt: point.name,
            keyboard: true,
            zIndexOffset: label.selected ? 1000 : 0,
          },
        ).addTo(labels);
        marker.on("click", () => select.current(point.id));
        marker.getElement()?.setAttribute("aria-label", `查看${point.name}`);
      }
    };
    redrawLabels();
    map.on("moveend zoomend resize", redrawLabels);
    return () => {
      map.off("moveend zoomend resize", redrawLabels);
      outlines.remove();
      labels.remove();
    };
  }, [info, features, points, selectedId, labelsVisible]);

  useEffect(() => {
    const map = instance.current;
    const feature = features.points.find((p) => p.point_id === selectedId);
    if (
      !map ||
      !feature ||
      !info.tiles ||
      feature.map_id !== info.id ||
      feature.map_revision !== info.revision
    )
      return;
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
          : [370, 50],
        maxZoom: info.tiles!.max_native_zoom,
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
    const timer = window.setTimeout(fit, 30);
    return () => window.clearTimeout(timer);
  }, [selectedId, info, features]);

  useEffect(() => {
    const map = instance.current;
    if (!map || !info.tiles) return;
    const layer = L.layerGroup().addTo(map);
    for (const segment of routeSegments) {
      if (
        segment.map_id === info.id &&
        segment.map_revision === info.revision
      ) {
        L.polyline(
          segment.path.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
          { color: "#713573", weight: 5, opacity: 0.9 },
        ).addTo(layer);
      }
    }
    return () => {
      layer.remove();
    };
  }, [routeSegments, info]);

  return (
    <>
      <div
        className="map-canvas"
        ref={element}
        role="region"
        aria-label="津南校区交互地图，可拖动和缩放"
        tabIndex={0}
      />
      <div className="map-context">
        <span className="live-dot" /> 津南校区{" "}
        <span className="context-divider" /> {points.length}个可探索地点
      </div>
      <div
        className={`map-controls${selectedId ? " has-selection" : ""}`}
        aria-label="地图工具"
      >
        <button
          title="放大地图"
          aria-label="放大地图"
          disabled={zoom >= (info.tiles?.max_native_zoom ?? 0) + 1}
          onClick={() => instance.current?.zoomIn()}
        >
          <Icon name="plus" />
        </button>
        <button
          title="缩小地图"
          aria-label="缩小地图"
          disabled={zoom <= (info.tiles?.min_zoom ?? 0)}
          onClick={() => instance.current?.zoomOut()}
        >
          <Icon name="minus" />
        </button>
        <span className="control-separator" />
        <button
          title="回到全图"
          aria-label="回到全图"
          onClick={() => {
            select.current(null);
            instance.current?.fitBounds(imageBounds(info), {
              padding: [18, 18],
            });
          }}
        >
          <Icon name="focus" />
        </button>
        <button
          title="显示地点名称"
          aria-label="显示地点名称"
          aria-pressed={labelsVisible}
          onClick={() => setLabelsVisible((v) => !v)}
        >
          <Icon name="pin" />
        </button>
      </div>
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
