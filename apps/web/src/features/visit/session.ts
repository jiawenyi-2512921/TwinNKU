export type VisitMode = "online" | "onsite";
export type VisitPosition = {
  revision: number;
  stopIndex: number;
  segmentId?: string;
};
export type AudioBookmark = {
  chunkIndex: number;
  time: number;
  manifestId?: string;
  chunkId?: string;
  textSha256?: string;
};
export type VisitCollection = {
  segmentId: string;
  stopIndex: number;
  resourceId?: string;
};
export type VisitSession = {
  tourId: string;
  position: VisitPosition;
  mode: VisitMode;
  audio?: AudioBookmark;
  completed?: number[];
  skipped?: number[];
  arrived?: number[];
  collections?: VisitCollection[];
  notes?: Record<string, string>;
  updatedAt?: number;
  paused?: boolean;
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
  const indices = (value: unknown) =>
    Array.isArray(value)
      ? ([
          ...new Set(
            value.filter((i) => Number.isInteger(i) && i >= 0 && i < 50),
          ),
        ] as number[])
      : [];
  return {
    tourId: row.tourId,
    position: {
      revision: p.revision,
      stopIndex: p.stopIndex,
      ...(p.segmentId !== undefined ? { segmentId: p.segmentId } : {}),
    },
    mode: row.mode === "onsite" ? "onsite" : "online",
    ...(typeof row.paused === "boolean" ? { paused: row.paused } : {}),
    ...(Array.isArray(row.completed)
      ? { completed: indices(row.completed) }
      : {}),
    ...(Array.isArray(row.skipped) ? { skipped: indices(row.skipped) } : {}),
    ...(Array.isArray(row.arrived) ? { arrived: indices(row.arrived) } : {}),
    ...(Array.isArray(row.collections)
      ? {
          collections: row.collections
            .filter(
              (v) =>
                v &&
                Number.isInteger(v.stopIndex) &&
                v.stopIndex >= 0 &&
                v.stopIndex < 50 &&
                typeof v.segmentId === "string" &&
                segment.test(v.segmentId) &&
                (!v.resourceId ||
                  (typeof v.resourceId === "string" &&
                    uuid.test(v.resourceId))),
            )
            .slice(0, 2500)
            .map((v) => ({
              segmentId: v.segmentId,
              stopIndex: v.stopIndex,
              ...(v.resourceId ? { resourceId: v.resourceId } : {}),
            })),
        }
      : {}),
    ...(row.notes && typeof row.notes === "object"
      ? {
          notes: Object.fromEntries(
            Object.entries(row.notes)
              .filter(
                ([k, v]) =>
                  segment.test(k) && typeof v === "string" && v.length <= 2000,
              )
              .slice(0, 2500),
          ),
        }
      : {}),
    ...(Number.isFinite(row.updatedAt) && (row.updatedAt ?? 0) >= 0
      ? { updatedAt: row.updatedAt }
      : {}),
    ...(bookmark &&
    Number.isInteger(bookmark.chunkIndex) &&
    bookmark.chunkIndex >= 0 &&
    bookmark.chunkIndex < 100 &&
    Number.isFinite(bookmark.time) &&
    bookmark.time >= 0 &&
    bookmark.time < 180
      ? {
          audio: {
            chunkIndex: bookmark.chunkIndex,
            time: bookmark.time,
            ...(typeof bookmark.manifestId === "string" &&
            bookmark.manifestId.length <= 128 &&
            typeof bookmark.chunkId === "string" &&
            bookmark.chunkId.length <= 128 &&
            /^[0-9a-f]{64}$/.test(bookmark.textSha256 ?? "")
              ? {
                  manifestId: bookmark.manifestId,
                  chunkId: bookmark.chunkId,
                  textSha256: bookmark.textSha256,
                }
              : {}),
          },
        }
      : {}),
  };
}

export function readVisit(href: string): VisitSession | null {
  const params = new URL(href).searchParams;
  return normalizeVisit({
    tourId:
      params.get("experience") ||
      new URL(href).pathname.match(/^\/visit\/([^/]+)/)?.[1],
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
  url.pathname = `/visit/${valid.tourId}`;
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

export function visitStorageKey(tourId: string, revision: number) {
  return `twinnku:visit:v2:${tourId}:${revision}`;
}

export function loadVisit(
  tourId: string,
  revision?: number,
): VisitSession | null {
  if (!uuid.test(tourId)) return null;
  try {
    const latest =
      revision ??
      Number(localStorage.getItem(`twinnku:visit:latest:${tourId}`));
    const value = normalizeVisit(
      JSON.parse(
        localStorage.getItem(visitStorageKey(tourId, latest)) || "null",
      ),
    );
    if (
      value?.tourId === tourId &&
      value.position.revision === latest &&
      (!revision || value.position.revision === revision)
    )
      return value;
    const progress = JSON.parse(
      localStorage.getItem(`twinnku:tour:${tourId}`) || "null",
    );
    const old =
      normalizeVisit(
        JSON.parse(localStorage.getItem(`twinnku:visit:${tourId}`) || "null"),
      ) ??
      normalizeVisit({
        tourId,
        position: {
          revision: progress?.revision,
          stopIndex: progress?.index,
          segmentId: progress?.segmentId,
        },
        mode: "online",
        paused: true,
      });
    if (
      old?.tourId !== tourId ||
      (revision && old.position.revision !== revision)
    )
      return null;
    if (progress?.revision === old.position.revision)
      old.completed = Array.isArray(progress.completed)
        ? progress.completed.filter(
            (i: number) => Number.isInteger(i) && i >= 0 && i < 50,
          )
        : [];
    if (saveVisit(old)) {
      localStorage.removeItem(`twinnku:visit:${tourId}`);
      localStorage.removeItem(`twinnku:tour:${tourId}`);
    }
    return old;
  } catch {
    return null;
  }
}

export function saveVisit(session: VisitSession): boolean {
  const valid = normalizeVisit(session);
  if (!valid) return false;
  try {
    localStorage.setItem(
      visitStorageKey(valid.tourId, valid.position.revision),
      JSON.stringify({ ...valid, updatedAt: Date.now() }),
    );
    localStorage.setItem(
      `twinnku:visit:latest:${valid.tourId}`,
      String(valid.position.revision),
    );
    return true;
  } catch {
    return false;
  }
}

export function listVisits(): VisitSession[] {
  try {
    const rows: VisitSession[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("twinnku:visit:v2:")) continue;
      try {
        const value = normalizeVisit(
          JSON.parse(localStorage.getItem(key) || "null"),
        );
        if (
          value &&
          key === visitStorageKey(value.tourId, value.position.revision)
        )
          rows.push(value);
      } catch {
        // A corrupt record must not hide the visitor's other saved versions.
      }
    }
    return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

export function clearVisit(tourId: string, revision: number): boolean {
  if (!uuid.test(tourId) || !Number.isSafeInteger(revision) || revision < 1)
    return false;
  try {
    localStorage.removeItem(visitStorageKey(tourId, revision));
    if (
      Number(localStorage.getItem(`twinnku:visit:latest:${tourId}`)) ===
      revision
    )
      localStorage.removeItem(`twinnku:visit:latest:${tourId}`);
    return true;
  } catch {
    return false;
  }
}
