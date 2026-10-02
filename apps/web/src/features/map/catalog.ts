import type {
  api,
  Campus,
  MapFeatures,
  MapInfo,
  Point,
} from "../../shared/api/client";

export type Catalog = {
  campus: Campus;
  map: MapInfo | null;
  features: MapFeatures | null;
  points: Point[];
};

export async function loadCatalog(
  source: typeof api,
  signal: AbortSignal,
): Promise<Catalog | null> {
  // The public map endpoint already enforces capability/publication checks.
  // An unrelated status request must not block an otherwise readable map.
  const campuses = await source.campuses(signal);
  signal.throwIfAborted();
  const campus =
    campuses.data.find((c) => c.id === "nku-jinnan") ?? campuses.data[0];
  if (!campus) return null;
  // Read points alongside map metadata, and start geometry as soon as its map
  // is known. Do not download every floor's metadata to display the campus.
  const [{ map, features }, first] = await Promise.all([
    (async () => {
      const maps = await source.maps(campus.id, signal, "campus");
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const map = maps.data.find((m) => m.kind === "campus" && m.tiles) ?? null;
      const features = map
        ? await source.mapFeatures(map.id, signal)
        : { data: null };
      return { map, features };
    })(),
    source.points(campus.id, "", signal),
  ]);
  signal.throwIfAborted();
  if (
    map &&
    features.data &&
    (features.data.map_id !== map.id ||
      features.data.map_revision !== map.revision)
  )
    throw new Error("Map revision mismatch");
  const all = [...first.data];
  const total = first.meta.pagination?.total ?? first.data.length;
  for (let page = 2; all.length < total; page++) {
    const next = await source.points(campus.id, "", signal, page);
    signal.throwIfAborted();
    // Never replace a complete catalog with a truncated response.
    if (
      !next.data.length ||
      (next.meta.pagination && next.meta.pagination.total !== total)
    )
      throw new Error("Incomplete point catalog");
    all.push(...next.data);
  }
  if (
    all.length !== total ||
    new Set(all.map((point) => point.id)).size !== all.length
  )
    throw new Error("Point catalog changed during read");
  const mapped = new Set(features.data?.points.map((p) => p.point_id) ?? []);
  const points = all
    .filter((p) => !map || mapped.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { campus, map, features: features.data, points };
}

// Keep the Leaflet instance and unchanged layers alive during background reads.
export function reconcileCatalog(
  previous: Catalog | null,
  next: Catalog | null,
): Catalog | null {
  if (!previous || !next) return next;
  const reuse = <T>(before: T, after: T): T =>
    JSON.stringify(before) === JSON.stringify(after) ? before : after;
  const result = {
    campus: reuse(previous.campus, next.campus),
    map: reuse(previous.map, next.map),
    features: reuse(previous.features, next.features),
    points: reuse(previous.points, next.points),
  };
  return Object.entries(result).every(
    ([key, value]) => previous[key as keyof Catalog] === value,
  )
    ? previous
    : result;
}

export function availableSelection(
  catalog: Catalog | null,
  id: string | null,
): string | null {
  return catalog?.points.some((point) => point.id === id) ? id : null;
}
