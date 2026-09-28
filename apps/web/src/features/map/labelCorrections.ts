import type { MapFeatures, MapInfo, Point } from "../../shared/api/client";

export const MEDIA_COLLEGE_ID = "b041e7c6-3481-51c1-b06f-9a33197ea0db";
export const SOUTHWEST_GATE_ID = "22536d5e-0204-5c0c-a304-b591a58e107b";
const MAP_ID = "eee88cf5-87a0-592e-b1cc-a70674941bbf";
const MAP_SHA256 =
  "aa5f84fc993dca7371e1d1bf6a5e190925ec2ce5f0d2d4dc968093346028218f";

/** User-requested display correction only. A later distinct editor name wins. */
export function correctedDisplayName(id: string, name: string): string {
  return id === MEDIA_COLLEGE_ID &&
    ["新闻与传播学院", "新闻与传媒学院"].includes(name)
    ? "信息与传媒学院"
    : name;
}

export type LabelCorrection = {
  pointId: string;
  name: string;
  anchor: { x: number; y: number };
  patch: { href: string; x: number; y: number; width: number; height: number };
  label: { vertical: boolean; fontSize: number; rotation: number } | null;
};

/** Restore only added lettering using source pixels; never apply to a new map. */
export function getMapLabelCorrections(
  info: MapInfo,
  features: MapFeatures,
  points: Point[],
): LabelCorrection[] {
  if (
    info.id !== MAP_ID ||
    info.revision !== 3 ||
    info.source_sha256 !== MAP_SHA256 ||
    info.width_px !== 8279 ||
    info.height_px !== 5604 ||
    features.map_id !== info.id ||
    features.map_revision !== info.revision
  )
    return [];
  const byId = new Map(points.map((point) => [point.id, point]));
  const corrections: LabelCorrection[] = [];
  for (const [pointId, file, box] of [
    [SOUTHWEST_GATE_ID, "southwest-gate", [1748, 5027, 253, 117]],
    [MEDIA_COLLEGE_ID, "media-college", [2194, 3122, 442, 111]],
  ] as const) {
    const point = byId.get(pointId);
    const feature = features.points.find(
      (item) =>
        item.point_id === pointId &&
        item.map_id === info.id &&
        item.map_revision === info.revision,
    );
    if (!point || !feature || !feature.polygon.length) continue;
    const name = correctedDisplayName(point.id, point.name);
    const edges = feature.polygon
      .map((a, index) => {
        const b = feature.polygon[(index + 1) % feature.polygon.length];
        return {
          dx: b.x - a.x,
          dy: b.y - a.y,
          size: Math.hypot(b.x - a.x, b.y - a.y),
        };
      })
      .sort((a, b) => b.size - a.size);
    const longest = edges[0];
    const shortest = edges[edges.length - 1];
    // The reviewed gate area is a narrow tilted strip: keep its text inside it.
    const vertical =
      pointId === SOUTHWEST_GATE_ID && longest.size > shortest.size * 1.7;
    let rotation = vertical
      ? (Math.atan2(-longest.dx, longest.dy) * 180) / Math.PI
      : 0;
    if (rotation > 90) rotation -= 180;
    if (rotation < -90) rotation += 180;
    const fontSize = vertical
      ? Math.max(
          12,
          Math.min(
            38,
            shortest.size * 0.67,
            longest.size / (name.length * 1.2),
          ),
        )
      : Math.max(
          12,
          Math.min(42, (longest.size * 0.86) / Math.max(name.length, 1)),
        );
    corrections.push({
      pointId,
      name,
      anchor: { ...feature.anchor },
      patch: {
        href: `/assets/map-labels/${file}.png`,
        x: box[0],
        y: box[1],
        width: box[2],
        height: box[3],
      },
      // Existing label_on_map text is already rendered by the common layer.
      label: feature.label_on_map ? null : { vertical, fontSize, rotation },
    });
  }
  return corrections;
}

/** Append to the existing image-coordinate SVG. Does not intercept map clicks. */
export function appendMapLabelCorrections(
  svg: SVGSVGElement,
  info: MapInfo,
  features: MapFeatures,
  points: Point[],
): number {
  const ns = "http://www.w3.org/2000/svg";
  const corrections = getMapLabelCorrections(info, features, points);
  for (const { patch, label, anchor, name } of corrections) {
    const image = document.createElementNS(ns, "image");
    for (const [key, value] of Object.entries(patch))
      image.setAttribute(key, String(value));
    image.setAttribute("preserveAspectRatio", "none");
    image.setAttribute("pointer-events", "none");
    svg.appendChild(image);
    if (!label) continue;
    const group = document.createElementNS(ns, "g");
    group.setAttribute(
      "transform",
      `translate(${anchor.x} ${anchor.y}) rotate(${label.rotation})`,
    );
    const lines = label.vertical ? Array.from(name) : [name];
    lines.forEach((line, index) => {
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", "0");
      text.setAttribute(
        "y",
        String((index - (lines.length - 1) / 2) * label.fontSize * 1.12),
      );
      text.setAttribute("dy", ".37em");
      text.setAttribute("font-size", String(label.fontSize));
      text.setAttribute(
        "stroke-width",
        String(Math.max(3, label.fontSize * 0.16)),
      );
      text.style.fill = "#204d41";
      text.textContent = line;
      group.appendChild(text);
    });
    svg.appendChild(group);
  }
  return corrections.length;
}
