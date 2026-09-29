// Only the verified school portal may be embedded. Other published HTTPS
// destinations remain explicit external links, even if their hostname is similar.
export const OFFICIAL_PANORAMA_ORIGIN = "https://stjgpt.nankai.edu.cn";
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
export function embeddedPanoramaUrl(value: string): string | null {
  const safe = externalPanoramaUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.origin === OFFICIAL_PANORAMA_ORIGIN &&
    url.pathname === "/index-jn.php"
    ? url.href
    : null;
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
