import type {
  api,
  PanoramaDirectoryItem,
  Point,
} from "../../shared/api/client";
import { externalPanoramaUrl } from "../points/panorama";

export type PanoramaGroup = "all" | "outdoor" | "building" | "other";

export function panoramaGroup(
  category: Point["category"],
): Exclude<PanoramaGroup, "all"> {
  if (category === "landscape" || category === "public_area") return "outdoor";
  // Other categories describe uses or cultural themes, not physical buildings.
  return category === "academic" ? "building" : "other";
}

export function panoramaScene(url: string): string | null {
  try {
    return new URL(url).hash.match(/^#(scene_\d+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function findPanoramas(
  items: PanoramaDirectoryItem[],
  campusId: string,
  query: string,
  group: PanoramaGroup,
) {
  const term = query.normalize("NFKC").trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        item.campus_id === campusId &&
        externalPanoramaUrl(item.url) &&
        (group === "all" || panoramaGroup(item.point_category) === group) &&
        (!term ||
          [item.title, item.point_name, panoramaScene(item.url) ?? ""].some(
            (s) => s.normalize("NFKC").toLocaleLowerCase().includes(term),
          )),
    )
    .sort(
      (a, b) =>
        a.point_name.localeCompare(b.point_name, "zh-CN") ||
        a.title.localeCompare(b.title, "zh-CN") ||
        a.id.localeCompare(b.id),
    );
}

export async function loadPanoramaDirectory(
  source: Pick<typeof api, "campusPanoramas">,
  campusId: string,
  signal: AbortSignal,
): Promise<PanoramaDirectoryItem[]> {
  const rows: PanoramaDirectoryItem[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    const result = await source.campusPanoramas(campusId, signal, page);
    signal.throwIfAborted();
    const meta = result.meta.pagination;
    if (
      !meta ||
      meta.page !== page ||
      meta.page_size !== 100 ||
      !Number.isInteger(meta.total) ||
      meta.total < 0 ||
      meta.total > 10000 ||
      (total !== undefined && total !== meta.total) ||
      result.data.length > 100
    )
      throw new Error("VR目录分页已改变，请重新加载。");
    total = meta.total;
    for (const item of result.data) {
      if (ids.has(item.id) || item.campus_id !== campusId)
        throw new Error("VR目录资料已改变，请重新加载。");
      ids.add(item.id);
      rows.push(item);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || result.data.length < 100)
      throw new Error("VR目录尚未完整读取，请重新加载。");
  }
}
