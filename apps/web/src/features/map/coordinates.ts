import * as L from "leaflet";
import type { MapInfo, XY } from "../../shared/api/client";

// Canonical coordinates: native image pixels, top-left origin, y points down.
// Leaflet coordinates stay private to the adapter and are never persisted as GPS.
export function toMapPoint(point: XY, nativeZoom: number): L.LatLng {
  const scale = 2 ** nativeZoom;
  return L.latLng(-point.y / scale, point.x / scale);
}

export function fromMapPoint(point: L.LatLng, nativeZoom: number): XY {
  const scale = 2 ** nativeZoom;
  return { x: point.lng * scale, y: -point.lat * scale };
}

export function imageBounds(map: MapInfo): L.LatLngBounds {
  const zoom = map.tiles?.max_native_zoom ?? 0;
  return L.latLngBounds(
    toMapPoint({ x: 0, y: map.height_px }, zoom),
    toMapPoint({ x: map.width_px, y: 0 }, zoom),
  );
}
