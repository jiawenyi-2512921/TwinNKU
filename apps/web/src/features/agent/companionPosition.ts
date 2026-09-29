/** Only a normalized screen position is persisted; no conversation data lives here. */
export const COMPANION_POSITION_KEY = "twinnku:companion-position:v1";
export const COMPANION_MARGIN = 16;
export const COMPANION_DRAG_THRESHOLD = 7;

export type CompanionPosition = { x: number; y: number };
export type CompanionViewport = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};
export type CompanionSize = { width: number; height: number };
export type CompanionBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
type PositionStorage = Pick<Storage, "getItem" | "setItem">;
const finite = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, finite(value, min)));

export function companionBounds(
  viewport: CompanionViewport,
  size: CompanionSize,
  margin = COMPANION_MARGIN,
): CompanionBounds {
  const width = Math.max(0, finite(viewport.width, 0));
  const height = Math.max(0, finite(viewport.height, 0));
  const roomX = Math.max(0, width - Math.max(0, finite(size.width, 0)));
  const roomY = Math.max(0, height - Math.max(0, finite(size.height, 0)));
  const insetX = Math.min(Math.max(0, finite(margin, 0)), roomX / 2);
  const insetY = Math.min(Math.max(0, finite(margin, 0)), roomY / 2);
  const left = finite(viewport.offsetLeft, 0);
  const top = finite(viewport.offsetTop, 0);
  return {
    minX: left + insetX,
    maxX: left + roomX - insetX,
    minY: top + insetY,
    maxY: top + roomY - insetY,
  };
}
export function clampCompanionPosition(
  position: CompanionPosition,
  bounds: CompanionBounds,
): CompanionPosition {
  return {
    x: clamp(position.x, bounds.minX, bounds.maxX),
    y: clamp(position.y, bounds.minY, bounds.maxY),
  };
}
export function normalizeCompanionPosition(
  position: CompanionPosition,
  bounds: CompanionBounds,
): CompanionPosition {
  const safe = clampCompanionPosition(position, bounds);
  return {
    x:
      bounds.maxX > bounds.minX
        ? (safe.x - bounds.minX) / (bounds.maxX - bounds.minX)
        : 1,
    y:
      bounds.maxY > bounds.minY
        ? (safe.y - bounds.minY) / (bounds.maxY - bounds.minY)
        : 1,
  };
}
export function restoreCompanionPosition(
  normalized: CompanionPosition,
  bounds: CompanionBounds,
): CompanionPosition {
  return {
    x: bounds.minX + clamp(normalized.x, 0, 1) * (bounds.maxX - bounds.minX),
    y: bounds.minY + clamp(normalized.y, 0, 1) * (bounds.maxY - bounds.minY),
  };
}
export function parseCompanionPosition(
  raw: string | null,
): CompanionPosition | null {
  if (!raw || raw.length > 256) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.version !== 1 ||
      typeof candidate.x !== "number" ||
      typeof candidate.y !== "number" ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      candidate.x < 0 ||
      candidate.x > 1 ||
      candidate.y < 0 ||
      candidate.y > 1
    )
      return null;
    return { x: candidate.x, y: candidate.y };
  } catch {
    return null;
  }
}
export function readCompanionPosition(
  storage: PositionStorage | null,
): CompanionPosition | null {
  try {
    return parseCompanionPosition(
      storage?.getItem(COMPANION_POSITION_KEY) ?? null,
    );
  } catch {
    return null;
  }
}
export function saveCompanionPosition(
  storage: PositionStorage | null,
  normalized: CompanionPosition,
): void {
  try {
    storage?.setItem(
      COMPANION_POSITION_KEY,
      JSON.stringify({
        version: 1,
        x: clamp(normalized.x, 0, 1),
        y: clamp(normalized.y, 0, 1),
      }),
    );
  } catch {
    /* Private browsing, quota and disabled storage must not disable dragging. */
  }
}
export function keyboardCompanionPosition(
  key: string,
  shiftKey: boolean,
  position: CompanionPosition,
  bounds: CompanionBounds,
): CompanionPosition | null {
  const step = shiftKey ? 40 : 12;
  const delta: Record<string, CompanionPosition> = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  };
  const move = delta[key];
  return move
    ? clampCompanionPosition(
        { x: position.x + move.x, y: position.y + move.y },
        bounds,
      )
    : null;
}
export type CompanionPointer = {
  pointerId: number;
  clientX: number;
  clientY: number;
  button?: number;
  isPrimary?: boolean;
};

/** Gesture state is independent of React renders and browser click synthesis. */
export function createCompanionDrag() {
  let active: {
    pointer: CompanionPointer;
    origin: CompanionPosition;
    dragged: boolean;
  } | null = null;
  let suppressClick = false;
  const finish = () => {
    if (!active) return null;
    const result = {
      pointerId: active.pointer.pointerId,
      dragged: active.dragged,
    };
    if (active.dragged) suppressClick = true;
    active = null;
    return result;
  };
  return {
    start(pointer: CompanionPointer, origin: CompanionPosition) {
      if (
        active ||
        pointer.isPrimary === false ||
        (pointer.button ?? 0) !== 0 ||
        !Number.isFinite(pointer.clientX) ||
        !Number.isFinite(pointer.clientY)
      )
        return false;
      suppressClick = false;
      active = {
        pointer: {
          pointerId: pointer.pointerId,
          clientX: pointer.clientX,
          clientY: pointer.clientY,
        },
        origin: { ...origin },
        dragged: false,
      };
      return true;
    },
    move(pointer: CompanionPointer, bounds: CompanionBounds) {
      if (
        !active ||
        pointer.pointerId !== active.pointer.pointerId ||
        !Number.isFinite(pointer.clientX) ||
        !Number.isFinite(pointer.clientY)
      )
        return null;
      const dx = pointer.clientX - active.pointer.clientX;
      const dy = pointer.clientY - active.pointer.clientY;
      if (!active.dragged && dx * dx + dy * dy < COMPANION_DRAG_THRESHOLD ** 2)
        return null;
      active.dragged = true;
      return clampCompanionPosition(
        { x: active.origin.x + dx, y: active.origin.y + dy },
        bounds,
      );
    },
    end(pointerId: number) {
      return active?.pointer.pointerId === pointerId ? finish() : null;
    },
    cancel: finish,
    consumeClick(detail: number) {
      // Keyboard/programmatic activation has detail=0 and must remain usable.
      if (!suppressClick || detail === 0) return false;
      suppressClick = false;
      return true;
    },
    get activePointerId() {
      return active?.pointer.pointerId ?? null;
    },
  };
}
