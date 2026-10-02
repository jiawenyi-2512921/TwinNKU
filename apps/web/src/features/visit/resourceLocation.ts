import type { Experience, TourResource } from "../experiences/types";
import { segmentsForStop } from "../experiences/segments";
import type { VisitSession } from "./session";

export type ResourceLocation = { resource: TourResource; pointId: string };
const fields = [
  "resource",
  "resource_id",
  "resource_revision",
  "resource_point",
];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function hasResourceLocation(href: string): boolean {
  const params = new URL(href).searchParams;
  return fields.some((key) => params.has(key));
}

export function sameResource(
  a: ResourceLocation | null | undefined,
  b: ResourceLocation | null | undefined,
): boolean {
  return Boolean(
    a &&
      b &&
      a.pointId === b.pointId &&
      a.resource?.type === b.resource?.type &&
      a.resource?.id === b.resource?.id &&
      a.resource?.revision === b.resource?.revision,
  );
}

// These are public identifiers only. Neither draft identifiers nor media URLs
// are serialized; every restored identifier must be resolved again publicly.
export function readResourceLocation(href: string): ResourceLocation | null {
  const p = new URL(href).searchParams;
  const type = p.get("resource"),
    id = p.get("resource_id"),
    pointId = p.get("resource_point");
  const revision = Number(p.get("resource_revision"));
  if (
    !type ||
    !["image", "video", "checkin", "floor", "vr"].includes(type) ||
    !id ||
    !uuid.test(id) ||
    !pointId ||
    !uuid.test(pointId) ||
    p.get("point") !== pointId ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    fields.some((key) => p.getAll(key).length !== 1)
  )
    return null;
  return {
    resource: { type: type as TourResource["type"], id, revision },
    pointId,
  };
}

export function resourceLocation(
  href: string,
  layer: ResourceLocation | null,
  pointId?: string,
): string {
  const url = new URL(href);
  fields.forEach((key) => url.searchParams.delete(key));
  if (pointId) url.searchParams.set("point", pointId);
  if (layer || pointId) {
    for (const key of ["floor", "floor_section", "panorama"])
      url.searchParams.delete(key);
  }
  if (layer) {
    url.searchParams.set("point", layer.pointId);
    url.searchParams.set("resource", layer.resource.type);
    url.searchParams.set("resource_id", layer.resource.id);
    url.searchParams.set("resource_revision", String(layer.resource.revision));
    url.searchParams.set("resource_point", layer.pointId);
  }
  return url.href;
}

export function sameVisit(
  a: VisitSession | null | undefined,
  b: VisitSession | null | undefined,
): boolean {
  return Boolean(
    a?.position &&
      b?.position &&
      a.tourId === b.tourId &&
      a.mode === b.mode &&
      a.position.revision === b.position.revision &&
      a.position.stopIndex === b.position.stopIndex &&
      a.position.segmentId === b.position.segmentId,
  );
}

export function resourceOnlyTransition(before: string, after: string): boolean {
  const urls = [new URL(before), new URL(after)];
  if (!urls.some((url) => fields.some((key) => url.searchParams.has(key))))
    return false;
  for (const url of urls) {
    fields.forEach((key) => url.searchParams.delete(key));
    url.searchParams.delete("point");
    url.searchParams.sort();
  }
  return urls[0].href === urls[1].href;
}

export function currentTourStop(
  items: Experience[],
  visit: VisitSession | null,
) {
  const tour = items.find(
    (row) =>
      row.id === visit?.tourId && row.revision === visit.position.revision,
  );
  if (!visit || tour?.content.kind !== "tour") return null;
  const stop = tour.content.stops[visit.position.stopIndex];
  if (!stop) return null;
  const segment = segmentsForStop(stop, visit.position.stopIndex).find(
    (row) => row.id === visit.position.segmentId,
  );
  return segment ? { tour, stop, segment } : null;
}

export function isStopResource(
  layer: ResourceLocation,
  items: Experience[],
  visit: VisitSession | null,
): boolean {
  const current = currentTourStop(items, visit);
  if (!current || current.stop.point_id !== layer.pointId) return false;
  const refs = [...current.segment.resources];
  if (current.segment.main_view.type !== "map")
    refs.push(current.segment.main_view);
  if (!current.stop.segments?.length) {
    for (const [type, id] of [
      ["video", current.stop.video_id],
      ["checkin", current.stop.checkin_id],
    ] as const) {
      const row = items.find(
        (row) =>
          row.id === id &&
          row.content.kind !== "tour" &&
          row.content.point_id === layer.pointId,
      );
      if (row && id) refs.push({ type, id, revision: row.revision });
    }
  }
  return refs.some(
    (ref) =>
      ref.type === layer.resource.type &&
      ref.id === layer.resource.id &&
      ref.revision === layer.resource.revision,
  );
}

export function isPublicMedia(
  layer: ResourceLocation,
  items: Experience[],
  campusId: string,
): boolean {
  return items.some(
    (row) =>
      row.id === layer.resource.id &&
      row.revision === layer.resource.revision &&
      row.campus_id === campusId &&
      row.content.kind !== "tour" &&
      row.content.point_id === layer.pointId &&
      (layer.resource.type === "checkin"
        ? row.content.kind === "checkin"
        : row.content.kind === "media" &&
          row.content.media_type === layer.resource.type),
  );
}
