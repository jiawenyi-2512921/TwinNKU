export type VisitMode = "online" | "onsite";
export type VisitPosition = {
  revision: number;
  stopIndex: number;
  segmentId?: string;
};
export type AudioBookmark = { chunkIndex: number; time: number };
export type VisitSession = {
  tourId: string;
  position: VisitPosition;
  mode: VisitMode;
  audio?: AudioBookmark;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function normalizeVisit(value: unknown): VisitSession | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<VisitSession>,
    p = row.position;
  if (
    typeof row.tourId !== "string" ||
    !uuid.test(row.tourId) ||
    !p ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 1 ||
    !Number.isInteger(p.stopIndex) ||
    p.stopIndex < 0 ||
    p.stopIndex >= 50 ||
    (p.segmentId !== undefined &&
      (typeof p.segmentId !== "string" || !segment.test(p.segmentId)))
  )
    return null;
  const bookmark = row.audio;
  return {
    tourId: row.tourId,
    position: {
      revision: p.revision,
      stopIndex: p.stopIndex,
      ...(p.segmentId !== undefined ? { segmentId: p.segmentId } : {}),
    },
    mode: row.mode === "onsite" ? "onsite" : "online",
    ...(bookmark &&
    Number.isInteger(bookmark.chunkIndex) &&
    bookmark.chunkIndex >= 0 &&
    bookmark.chunkIndex < 100 &&
    Number.isFinite(bookmark.time) &&
    bookmark.time >= 0 &&
    bookmark.time < 180
      ? { audio: { chunkIndex: bookmark.chunkIndex, time: bookmark.time } }
      : {}),
  };
}

export function readVisit(href: string): VisitSession | null {
  const params = new URL(href).searchParams;
  return normalizeVisit({
    tourId: params.get("experience"),
    position: {
      revision: Number(params.get("revision")),
      stopIndex: Number(params.get("stop")),
      segmentId: params.get("segment") || undefined,
    },
    mode: params.get("mode"),
  });
}

export function visitLink(href: string, session: VisitSession): string {
  const valid = normalizeVisit(session);
  if (!valid) throw new Error("Invalid visit position");
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Invalid visit origin");
  url.username = "";
  url.password = "";
  url.pathname = "/";
  url.hash = "";
  url.search = "";
  url.searchParams.set("experience", valid.tourId);
  url.searchParams.set("revision", String(valid.position.revision));
  url.searchParams.set("stop", String(valid.position.stopIndex));
  if (valid.position.segmentId)
    url.searchParams.set("segment", valid.position.segmentId);
  url.searchParams.set("mode", valid.mode);
  return url.href;
}

export function loadVisit(tourId: string): VisitSession | null {
  if (!uuid.test(tourId)) return null;
  try {
    const value = normalizeVisit(
      JSON.parse(localStorage.getItem(`twinnku:visit:${tourId}`) || "null"),
    );
    return value?.tourId === tourId ? value : null;
  } catch {
    return null;
  }
}

export function saveVisit(session: VisitSession): boolean {
  const valid = normalizeVisit(session);
  if (!valid) return false;
  try {
    localStorage.setItem(
      `twinnku:visit:${valid.tourId}`,
      JSON.stringify(valid),
    );
    return true;
  } catch {
    return false;
  }
}
