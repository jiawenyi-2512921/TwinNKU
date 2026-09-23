// Screen-space labels: source pixels and building hit areas never change.
export type LabelCandidate = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  selected: boolean;
};
export type LabelBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type PlacedLabel = LabelCandidate & { box: LabelBox };

export function intersects(a: LabelBox, b: LabelBox, gap = 6): boolean {
  return (
    a.left < b.right + gap &&
    a.right + gap > b.left &&
    a.top < b.bottom + gap &&
    a.bottom + gap > b.top
  );
}

export function placeLabels(
  candidates: LabelCandidate[],
  viewport: { width: number; height: number },
  excluded: LabelBox[] = [],
): PlacedLabel[] {
  const accepted: PlacedLabel[] = [];
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );
  for (const candidate of ranked) {
    if (
      candidate.x < 0 ||
      candidate.y < 0 ||
      candidate.x > viewport.width ||
      candidate.y > viewport.height
    )
      continue;
    const width = Math.min(candidate.width, viewport.width - 16);
    const height = candidate.height;
    // Center on the building; only move at the viewport edge, never to another building.
    const left = Math.max(
      8,
      Math.min(candidate.x - width / 2, viewport.width - width - 8),
    );
    const top = Math.max(
      8,
      Math.min(candidate.y - height / 2, viewport.height - height - 8),
    );
    const box = { left, top, right: left + width, bottom: top + height };
    if (excluded.some((other) => intersects(box, other, 2))) continue;
    if (accepted.some((other) => intersects(box, other.box))) continue;
    accepted.push({ ...candidate, width, box });
  }
  return accepted;
}

export function labelPriority(name: string, category: string): number {
  if (name === "未命名建筑") return -1;
  if (
    [
      "图书馆",
      "体育馆",
      "南门",
      "公共教学楼",
      "综合实验楼",
      "大通学生活动中心",
      "马蹄湖",
    ].includes(name)
  )
    return 100;
  if (name.endsWith("门") || category === "landscape") return 80;
  if (/[ABCD]区$/.test(name) || category === "residence") return 20;
  return 50;
}

export function shouldLabel(
  priority: number,
  footprintSize: number,
  selected: boolean,
): boolean {
  if (selected) return true;
  if (priority < 0) return false;
  return priority >= 80 || footprintSize >= (priority >= 50 ? 34 : 68);
}
