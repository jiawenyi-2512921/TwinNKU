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
