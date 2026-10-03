import type { Experience } from "../experiences/types";
import { segmentsForStop, type TourPosition } from "../experiences/segments";

export function adjacentVisitPosition(
  tour: Experience,
  position: TourPosition,
  direction: 1 | -1,
): TourPosition | null {
  if (tour.content.kind !== "tour" || position.revision !== tour.revision)
    return null;
  const stop = tour.content.stops[position.stopIndex];
  if (!stop) return null;
  const segments = segmentsForStop(stop, position.stopIndex),
    index = segments.findIndex((s) => s.id === position.segmentId);
  if (index < 0) return null;
  if (segments[index + direction])
    return { ...position, segmentId: segments[index + direction].id };
  const station = position.stopIndex + direction,
    next = tour.content.stops[station];
  if (!next) return null;
  const rows = segmentsForStop(next, station);
  return {
    revision: tour.revision,
    stopIndex: station,
    segmentId: rows[direction === 1 ? 0 : rows.length - 1].id,
  };
}

export function VisitTransport({
  tour,
  position,
  hasNarration,
  onListen,
  onMove,
  onComplete,
  onSkip,
}: {
  tour: Experience;
  position: TourPosition;
  hasNarration: boolean;
  onListen: () => void;
  onMove: (position: TourPosition) => void;
  onComplete: (next: TourPosition | null) => void;
  onSkip?: (next: TourPosition | null) => void;
}) {
  if (tour.content.kind !== "tour") return null;
  const stop = tour.content.stops[position.stopIndex];
  if (!stop) return null;
  const previous = adjacentVisitPosition(tour, position, -1),
    next = adjacentVisitPosition(tour, position, 1);
  const segments = segmentsForStop(stop, position.stopIndex),
    index = segments.findIndex((s) => s.id === position.segmentId),
    last = index === segments.length - 1;
  if (index < 0) return null;
  const following = tour.content.stops[position.stopIndex + 1],
    afterSkip = following
      ? {
          revision: tour.revision,
          stopIndex: position.stopIndex + 1,
          segmentId: segmentsForStop(following, position.stopIndex + 1)[0].id,
        }
      : null;
  return (
    <nav className="visit-transport" aria-label="参观推进控制">
      <button disabled={!previous} onClick={() => previous && onMove(previous)}>
        上一段
      </button>
      {!hasNarration && (
        <button
          className="visit-listen"
          disabled={!segments[index].text.trim()}
          onClick={onListen}
        >
          {tour.content.narration_mode === "recorded"
            ? "播放本站讲解"
            : "浏览器朗读本段"}
        </button>
      )}
      <button
        className="visit-forward"
        onClick={() => (last ? onComplete(next) : next && onMove(next))}
      >
        {!last ? "下一段" : next ? "完成阅读，下一站" : "完成阅读，查看回顾"}
      </button>
      {onSkip && (
        <button className="visit-skip" onClick={() => onSkip(afterSkip)}>
          跳过本站
        </button>
      )}
    </nav>
  );
}
