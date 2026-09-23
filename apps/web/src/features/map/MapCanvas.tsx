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
  const [markersVisible, setMarkersVisible] = useState(true);
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
    const layer = L.layerGroup().addTo(map);
    const byId = new Map(points.map((p) => [p.id, p]));
    for (const feature of features.points) {
      if (feature.map_revision !== info.revision || feature.map_id !== info.id)
        continue;
      const point = byId.get(feature.point_id);
      if (!point) continue;
      const selected = selectedId === point.id;
      const base = {
        color: selected ? "#713573" : "#715781",
        weight: selected ? 2.5 : 1.2,
        opacity: selected ? 1 : 0.45,
        fillColor: "#9251a1",
        fillOpacity: selected ? 0.25 : 0.035,
      };
      const polygon = L.polygon(
        feature.polygon.map((p) => toMapPoint(p, info.tiles!.max_native_zoom)),
        base,
      ).addTo(layer);
      const tooltip = document.createElement("span");
      tooltip.textContent = point.name;
      polygon.bindTooltip(tooltip, {
        direction: "top",
        className: "point-tooltip",
      });
      polygon.on("click", () => select.current(point.id));
      polygon.on("mouseover", () =>
        polygon.setStyle({ fillOpacity: 0.3, opacity: 1 }),
      );
      polygon.on("mouseout", () => polygon.setStyle(base));
      if (markersVisible) {
        const markerNode = document.createElement("span");
        markerNode.className = `map-pin${selected ? " is-selected" : ""}`;
        markerNode.textContent = String(
          points.findIndex((p) => p.id === point.id) + 1,
        ).padStart(2, "0");
        const icon = L.divIcon({
          html: markerNode,
          className: "map-pin-holder",
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
        const marker = L.marker(
          toMapPoint(feature.anchor, info.tiles.max_native_zoom),
          { icon, title: point.name, alt: point.name, keyboard: true },
        ).addTo(layer);
        marker.on("click", () => select.current(point.id));
        const label = document.createElement("span");
        label.textContent = point.name;
        marker.bindTooltip(label, {
          direction: "top",
          offset: [0, -16],
          className: "point-tooltip",
        });
        marker
          .getElement()
          ?.setAttribute("aria-label", `在地图上选择${point.name}`);
      }
    }
    return () => {
      layer.remove();
    };
  }, [info, features, points, selectedId, markersVisible]);

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
          title="地点标记"
          aria-label="地点标记"
          aria-pressed={markersVisible}
          onClick={() => setMarkersVisible((v) => !v)}
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
