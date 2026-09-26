export type XY = { x: number; y: number };
// Translate the entire hit region; clamping individual vertices would deform it.
export function moveGeometry<T extends { anchor: XY; polygon: XY[] }>(
  value: T,
  target: XY,
  width: number,
  height: number,
): T {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y))
    throw new Error("定位坐标必须是有效数字");
  const dx = target.x - value.anchor.x,
    dy = target.y - value.anchor.y;
  const translate = (p: XY): XY => ({
    x: Math.round((p.x + dx) * 1000) / 1000,
    y: Math.round((p.y + dy) * 1000) / 1000,
  });
  const anchor = translate(value.anchor),
    polygon = value.polygon.map(translate);
  if (
    [anchor, ...polygon].some(
      (p) => p.x < 0 || p.y < 0 || p.x > width || p.y > height,
    )
  )
    throw new Error("移动后点击范围会超出图片，请选择更靠内的位置或先调整范围");
  return { ...value, anchor, polygon };
}
export function clampPoint(p: XY, width: number, height: number): XY {
  return {
    x: Math.round(Math.min(width, Math.max(0, p.x)) * 1000) / 1000,
    y: Math.round(Math.min(height, Math.max(0, p.y)) * 1000) / 1000,
  };
}
export function rectangle(a: XY, b: XY): XY[] {
  return [
    { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
    { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
  ];
}
export function validPolygon(
  points: XY[],
  width: number,
  height: number,
): string | null {
  if (points.length < 3 || points.length > 200)
    return "点击范围需要 3 至 200 个顶点";
  if (
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x > width ||
        p.y > height,
    )
  )
    return "点击范围超出图片边界";
  if (new Set(points.map((p) => `${p.x},${p.y}`)).size !== points.length)
    return "点击范围包含重复顶点";
  const cross = (a: XY, b: XY, c: XY) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const on = (a: XY, b: XY, c: XY) =>
    Math.abs(cross(a, b, c)) < 1e-8 &&
    c.x >= Math.min(a.x, b.x) &&
    c.x <= Math.max(a.x, b.x) &&
    c.y >= Math.min(a.y, b.y) &&
    c.y <= Math.max(a.y, b.y);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j],
        d = points[(j + 1) % points.length];
      if (
        (cross(a, b, c) * cross(a, b, d) < 0 &&
          cross(c, d, a) * cross(c, d, b) < 0) ||
        on(a, b, c) ||
        on(a, b, d) ||
        on(c, d, a) ||
        on(c, d, b)
      )
        return "点击范围不能交叉或自相接触";
    }
  }
  return Math.abs(area) < 2 ? "点击范围过小或顶点共线" : null;
}
