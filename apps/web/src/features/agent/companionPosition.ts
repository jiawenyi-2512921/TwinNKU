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
export type CompanionSubtitleLayout = {
  x: number;
  y: number;
  width: number;
  maxHeight: number;
  side: "left" | "right" | "above" | "below";
  pointer: number;
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

/** A speech bubble stays beside its character, including in a keyboard viewport.
 * Coordinates are relative to the companion so its existing transform moves both.
 */
export function companionSubtitleLayout(
  viewport: CompanionViewport,
  position: CompanionPosition,
  companion: CompanionSize,
  subtitle: CompanionSize,
): CompanionSubtitleLayout {
  const visibleWidth = Math.max(0, finite(viewport.width, 0));
  const visibleHeight = Math.max(0, finite(viewport.height, 0));
  const insetX = Math.min(COMPANION_MARGIN, visibleWidth / 2);
  const insetY = Math.min(COMPANION_MARGIN, visibleHeight / 2);
  const left = finite(viewport.offsetLeft, 0) + insetX;
  const top = finite(viewport.offsetTop, 0) + insetY;
  const right = left + Math.max(0, visibleWidth - insetX * 2);
  const bottom = top + Math.max(0, visibleHeight - insetY * 2);
  const characterWidth = Math.max(0, finite(companion.width, 0));
  const characterHeight = Math.max(0, finite(companion.height, 0));
  const characterX = finite(position.x, left);
  const characterY = finite(position.y, top);
  const gap = 12;
  let width = Math.min(320, right - left);
  let maxHeight = Math.min(120, bottom - top, visibleHeight * 0.32);
  const height = Math.min(maxHeight, Math.max(0, finite(subtitle.height, 48)));
  const room = {
    left: Math.max(0, characterX - gap - left),
    right: Math.max(0, right - characterX - characterWidth - gap),
    above: Math.max(0, characterY - gap - top),
    below: Math.max(0, bottom - characterY - characterHeight - gap),
  };
  const horizontal = room.left >= room.right ? "left" : "right";
  const vertical = room.above >= room.below ? "above" : "below";
  let side: CompanionSubtitleLayout["side"];
  if (room[horizontal] >= width) side = horizontal;
  else if (room[vertical] >= height) side = vertical;
  else if (room[horizontal] >= Math.min(120, width)) {
    side = horizontal;
    width = Math.min(width, room[horizontal]);
  } else {
    side = vertical;
  }
  // Keep the chosen slot's constraint even if the last measured bubble was
  // shorter. Otherwise a capped caption could repeatedly expand and flip sides.
  if (side === "above" || side === "below")
    maxHeight = Math.min(maxHeight, room[side]);
  else width = Math.min(width, room[side]);
  const finalHeight = Math.min(height, maxHeight);
  const anchorX = characterX + characterWidth / 2;
  // Keep speech next to the upper half of the sprite, above its control buttons.
  const anchorY = characterY + characterHeight * 0.3;
  const x = clamp(
    side === "left"
      ? characterX - gap - width
      : side === "right"
        ? characterX + characterWidth + gap
        : anchorX - width / 2,
    left,
    Math.max(left, right - width),
  );
  const y = clamp(
    side === "above"
      ? characterY - gap - finalHeight
      : side === "below"
        ? characterY + characterHeight + gap
        : anchorY - finalHeight / 2,
    top,
    Math.max(top, bottom - finalHeight),
  );
  const pointerExtent =
    side === "left" || side === "right" ? finalHeight : width;
  const pointerInset = Math.min(14, pointerExtent / 2);
  return {
    x: x - characterX,
    y: y - characterY,
    width,
    maxHeight,
    side,
    pointer: clamp(
      side === "left" || side === "right" ? anchorY - y : anchorX - x,
      pointerInset,
      Math.max(pointerInset, pointerExtent - pointerInset),
    ),
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
