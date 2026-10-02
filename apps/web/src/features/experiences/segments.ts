import type { ExperienceStop, TourSegment } from "./types";

export type TourPosition = {
  revision: number;
  stopIndex: number;
  segmentId: string;
};

export function normalizeSegment(
  segment: NonNullable<ExperienceStop["segments"]>[number],
): TourSegment {
  return {
    ...segment,
    main_view: segment.main_view ?? { type: "map" },
    resources: segment.resources ?? [],
  };
}

export function segmentsForStop(
  stop: ExperienceStop,
  index: number,
): TourSegment[] {
  return stop.segments?.length
    ? stop.segments.map(normalizeSegment)
    : [
        {
          id: `legacy-stop-${index + 1}`,
          text: stop.narrative,
          source_note: "",
          main_view: { type: "map" },
          resources: [],
        },
      ];
}

export function normalizeTourPosition(
  raw: Partial<TourPosition> | null | undefined,
  revision: number,
  stops: ExperienceStop[],
): TourPosition {
  const stopIndex =
    raw?.revision === revision && Number.isInteger(raw.stopIndex)
      ? Math.max(0, Math.min(stops.length - 1, raw.stopIndex!))
      : 0;
  const segments = stops[stopIndex]
    ? segmentsForStop(stops[stopIndex], stopIndex)
    : [];
  const segmentId =
    raw?.revision === revision && segments.some((s) => s.id === raw.segmentId)
      ? raw.segmentId!
      : (segments[0]?.id ?? "");
  return { revision, stopIndex, segmentId };
}

export function moveSegment<T>(
  segments: T[],
  from: number,
  direction: -1 | 1,
): T[] {
  const to = from + direction;
  if (from < 0 || to < 0 || from >= segments.length || to >= segments.length)
    return segments;
  const next = [...segments];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function newSegment(): TourSegment {
  return {
    id: crypto.randomUUID(),
    text: "",
    source_note: "",
    main_view: { type: "map" },
    resources: [],
  };
}
