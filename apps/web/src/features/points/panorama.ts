import type { Panorama } from "../../shared/api/client";
// VR is opened on its original website, never inside an iframe.
export function externalPanoramaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function requestedPanorama(
  href: string,
  pointId: string,
): string | null {
  const url = new URL(href);
  return url.searchParams.get("point") === pointId
    ? url.searchParams.get("panorama")
    : null;
}
/** The cover is a point-bound, exact VR/image revision GET, never a submitted image URL. */
export function safePanoramaCover(item: Panorama): string | null {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(item.id) || !uuid.test(item.point_id) || !item.cover_image_id || !uuid.test(item.cover_image_id)
      || !Number.isInteger(item.revision) || item.revision < 1
      || !Number.isInteger(item.cover_image_revision) || (item.cover_image_revision ?? 0) < 1) return null;
  const path = `/api/v1/points/${item.point_id}/panoramas/${item.id}/cover/${item.revision}/${item.cover_image_id}/${item.cover_image_revision}`;
  return item.cover_image_url === path ? path : null;
}
export function panoramaLocation(
  href: string,
  pointId: string,
  panoramaId: string | null,
): string {
  const url = new URL(href);
  // Late callbacks for a previous building must not change the new selection.
  if (url.searchParams.get("point") !== pointId) return href;
  if (panoramaId) {
    url.searchParams.set("panorama", panoramaId);
    for (const key of ["floor", "floor_section"]) url.searchParams.delete(key);
  } else url.searchParams.delete("panorama");
  return url.href;
}
