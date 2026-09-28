export type TourProgress = {
  revision: number;
  index: number;
  completed: number[];
  paused: boolean;
};
export function normalizeProgress(
  raw: unknown,
  revision: number,
  stopCount: number,
): TourProgress {
  const fresh = { revision, index: 0, completed: [], paused: true };
  if (!raw || typeof raw !== "object" || stopCount < 1) return fresh;
  const value = raw as Partial<TourProgress>;
  if (value.revision !== revision || !Number.isInteger(value.index))
    return fresh;
  return {
    revision,
    index: Math.max(0, Math.min(stopCount - 1, value.index!)),
    completed: Array.isArray(value.completed)
      ? [
          ...new Set(
            value.completed.filter(
              (i) => Number.isInteger(i) && i >= 0 && i < stopCount,
            ),
          ),
        ]
      : [],
    paused: true,
  };
}
export function advanceProgress(
  progress: TourProgress,
  count: number,
): TourProgress {
  if (count < 1) return progress;
  const completed = [...new Set([...progress.completed, progress.index])];
  const finished = progress.index >= count - 1;
  return {
    ...progress,
    completed,
    index: Math.min(progress.index + 1, count - 1),
    paused: finished,
  };
}
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value || /[\s\\\u0000-\u001f]/u.test(value)) return null;
  if (
    /^\/api\/v1\/(?:admin\/)?(?:experiences|experience-media)\//.test(value) &&
    !value.includes("..")
  )
    return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
export function inlineVideo(url: string, uploaded: boolean) {
  return uploaded || /\.(mp4|webm)(?:[?#]|$)/i.test(url);
}
export function readLocal(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function moveStop<T>(stops: T[], from: number, direction: -1 | 1): T[] {
  const to = from + direction;
  if (from < 0 || from >= stops.length || to < 0 || to >= stops.length)
    return stops;
  const result = [...stops];
  [result[from], result[to]] = [result[to], result[from]];
  return result;
}
