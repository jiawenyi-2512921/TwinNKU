import type { MapInfo } from "../../shared/api/client";

/** CRS.Simple image pixels, never geographic latitude or longitude. */
export type MapDefaultView = {
  map_id: string;
  map_revision: number;
  center: { x: number; y: number };
  zoom: number;
  min_zoom: number;
  max_zoom: number;
};
export type MapViewport = Pick<
  MapDefaultView,
  "map_id" | "map_revision" | "center" | "zoom"
>;
export type MapFocusEffect = "instant" | "short";
export type MapLayer = "point_regions";
export const MIN_CAMERA_ZOOM = -8;

export function mapCameraRange(info: MapInfo) {
  return { min: MIN_CAMERA_ZOOM, max: (info.tiles?.max_native_zoom ?? 0) + 1 };
}
export function validMapDefaultView(
  value: MapDefaultView | null | undefined,
  info: MapInfo,
): value is MapDefaultView {
  const bounds = mapCameraRange(info);
  return (
    !!value &&
    !!info.tiles &&
    value.map_id === info.id &&
    value.map_revision === info.revision &&
    !!value.center &&
    Number.isFinite(value.center.x) &&
    value.center.x >= 0 &&
    value.center.x <= info.width_px &&
    Number.isFinite(value.center.y) &&
    value.center.y >= 0 &&
    value.center.y <= info.height_px &&
    Number.isFinite(value.zoom) &&
    Number.isFinite(value.min_zoom) &&
    Number.isFinite(value.max_zoom) &&
    bounds.min <= value.min_zoom &&
    value.min_zoom <= value.zoom &&
    value.zoom <= value.max_zoom &&
    value.max_zoom <= bounds.max
  );
}
