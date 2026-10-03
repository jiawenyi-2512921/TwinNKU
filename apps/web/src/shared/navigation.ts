// Sharing uses the visible, validated selection. Unrelated URL parameters survive.
type NavigationPort = Pick<Window, "history" | "location">;
export const LOCATION_CHANGE_EVENT = "twinnku:location-change";
export type ExperienceSelection = {
  id?: string;
  kind?: "media" | "checkin" | "tour";
  pointId?: string;
};

export type PublicPage =
  | {
      kind: "home" | "tours" | "explore" | "panoramas" | "visits";
      mode?: "online" | "onsite";
    }
  | {
      kind: "overview" | "visit" | "recap";
      tourId: string;
      mode?: "online" | "onsite";
    };
const publicUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** One interpretation for new paths and the original public query links. */
export function readPublicPage(href: string): PublicPage {
  const url = new URL(href);
  const mode =
    url.searchParams.get("mode") === "onsite"
      ? { mode: "onsite" as const }
      : {};
  const path = url.pathname.replace(/\/$/, "") || "/";
  const route = path.match(/^\/(tours|visit)\/([^/]+)(\/recap)?$/);
  if (route && publicUuid.test(route[2]))
    return {
      kind: route[3] ? "recap" : route[1] === "tours" ? "overview" : "visit",
      tourId: route[2],
      ...mode,
    };
  const direct: Record<string, PublicPage["kind"]> = {
    "/tours": "tours",
    "/explore": "explore",
    "/panoramas": "panoramas",
    "/visits": "visits",
  };
  if (direct[path])
    return {
      kind: direct[path] as "tours" | "explore" | "panoramas" | "visits",
      ...mode,
    };
  const old = url.searchParams.get("experience");
  if (old && publicUuid.test(old))
    return { kind: "visit", tourId: old, ...mode };
  if (old === "tour" || old === "all") return { kind: "tours" };
  if (url.searchParams.has("point") || old || url.searchParams.has("panorama"))
    return { kind: "explore" };
  return { kind: "home" };
}

export function publicLocation(
  href: string,
  page: PublicPage,
  campusId?: string,
): string {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  url.pathname =
    page.kind === "home"
      ? "/"
      : page.kind === "overview"
        ? `/tours/${page.tourId}`
        : page.kind === "visit" || page.kind === "recap"
          ? `/visit/${page.tourId}${page.kind === "recap" ? "/recap" : ""}`
          : `/${page.kind}`;
  if ("tourId" in page) url.searchParams.set("experience", page.tourId);
  if (campusId) url.searchParams.set("campus", campusId);
  if (page.mode) url.searchParams.set("mode", page.mode);
  return url.href;
}

export function readExperienceLocation(
  href: string,
): ExperienceSelection | null {
  const params = new URL(href).searchParams;
  const value = params.get("experience");
  if (!value) {
    const path = new URL(href).pathname.match(
      /^\/(?:tours|visit)\/([^/]+)(?:\/recap)?$/,
    );
    return path && publicUuid.test(path[1])
      ? { id: path[1], kind: "tour" }
      : null;
  }
  const selection: ExperienceSelection = {};
  if (["media", "checkin", "tour"].includes(value))
    selection.kind = value as ExperienceSelection["kind"];
  else if (value !== "all") {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
      return null;
    selection.id = value;
  }
  const pointId = params.get("experience_point");
  if (pointId) selection.pointId = pointId;
  return selection;
}

export function experienceLocation(
  href: string,
  selection: ExperienceSelection | null,
): string {
  const url = new URL(href);
  url.searchParams.delete("experience");
  url.searchParams.delete("experience_point");
  if (
    !selection?.id ||
    selection.id !== new URL(href).searchParams.get("experience")
  ) {
    for (const key of ["revision", "stop", "segment", "mode"])
      url.searchParams.delete(key);
  }
  if (selection) {
    for (const key of ["floor", "floor_section", "panorama"])
      url.searchParams.delete(key);
    url.searchParams.set("experience", selection.id || selection.kind || "all");
    if (selection.pointId)
      url.searchParams.set("experience_point", selection.pointId);
  } else if (/^\/(?:visit|tours)\//.test(url.pathname)) {
    url.pathname = "/explore";
  }
  return url.href;
}

// User choices enter history; background reconciliation only replaces it.
export function writeLocation(
  href: string,
  mode: "push" | "replace" = "push",
  target: NavigationPort = window,
  floorReturnTo?: string,
): void {
  if (href === target.location.href) return;
  const before: unknown = target.history.state;
  const state: Record<string, unknown> =
    before && typeof before === "object" && !Array.isArray(before)
      ? { ...before }
      : {};
  if (mode === "push") {
    delete state.twinnkuFloorReturn;
    if (floorReturnTo) state.twinnkuFloorReturn = floorReturnTo;
    target.history.pushState(state, "", href);
  } else target.history.replaceState(state, "", href);
  // Browser history writes do not emit popstate. Notify view-context listeners
  // without treating a floor/section update as a browser Back operation.
  if (typeof window !== "undefined" && target === window)
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
}

export function closeFloorLocation(
  pointId: string,
  target: NavigationPort = window,
): void {
  const current = target.location.href;
  const destination = floorLocation(current, pointId, null);
  if (destination === current) return;
  // Only go back for an entry opened by this viewer. A direct shared link must
  // never send the visitor back to an unrelated website.
  if (target.history.state?.twinnkuFloorReturn === destination)
    target.history.back();
  else writeLocation(destination, "replace", target);
}

export function pointLocation(
  href: string,
  pointId: string | null,
  preserveExperience = false,
): string {
  const url = new URL(href);
  if (!preserveExperience) {
    if (/^\/visit\//.test(url.pathname)) url.pathname = "/explore";
    url.searchParams.delete("experience");
    url.searchParams.delete("experience_point");
    for (const key of ["revision", "stop", "segment", "mode"])
      url.searchParams.delete(key);
  }
  if (!pointId || url.searchParams.get("point") !== pointId) {
    url.searchParams.delete("panorama");
    url.searchParams.delete("floor");
    url.searchParams.delete("floor_section");
  }
  if (pointId) url.searchParams.set("point", pointId);
  else url.searchParams.delete("point");
  return url.href;
}

export function floorLocation(
  href: string,
  pointId: string,
  floorId: string | null,
  section = "main",
): string {
  const url = new URL(href);
  // A response from a previously selected building cannot rewrite the new link.
  if (url.searchParams.get("point") !== pointId) return href;
  if (floorId) url.searchParams.set("floor", floorId);
  else url.searchParams.delete("floor");
  if (
    floorId &&
    section !== "main" &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/.test(section)
  ) {
    url.searchParams.set("floor_section", section);
  } else url.searchParams.delete("floor_section");
  return url.href;
}

export function resolveFloorImage<
  T extends { variant: string; section?: string },
>(images: readonly T[], requestedSection: string | null): T | undefined {
  const labeled = images.filter((image) => image.variant === "labeled");
  return (
    labeled.find((image) => (image.section ?? "main") === requestedSection) ??
    labeled[0]
  );
}

export function resolveFloor(
  floors: readonly { id: string; point_id: string }[],
  pointId: string,
  requestedId: string | null,
): string | null {
  const available = floors.filter((floor) => floor.point_id === pointId);
  return (
    available.find((floor) => floor.id === requestedId)?.id ??
    available[0]?.id ??
    null
  );
}

// A location snapshot is authoritative on initial load and browser Back/Forward.
// Polling passes null and preserves the current viewer state.
export function reconcileFloorView<
  T extends {
    id: string;
    point_id: string;
    images?: { variant: string; section?: string }[];
  },
>(
  rows: readonly T[],
  pointId: string,
  previous: { floorId: string; section: string; expanded: boolean },
  initialLink: URLSearchParams | null,
) {
  const floors = rows.filter(
    (floor) =>
      floor.point_id === pointId &&
      floor.images?.some((image) => image.variant === "labeled"),
  );
  const fromLink =
    initialLink?.get("point") === pointId && initialLink.has("floor");
  const requested = fromLink ? initialLink.get("floor") : previous.floorId;
  const floorId = resolveFloor(floors, pointId, requested) ?? "";
  const image = resolveFloorImage(
    floors.find((floor) => floor.id === floorId)?.images ?? [],
    floorId === requested
      ? fromLink
        ? initialLink.get("floor_section")
        : previous.section
      : null,
  );
  return {
    floors,
    floorId,
    section: image?.section ?? "main",
    expanded: Boolean(floorId && (initialLink ? fromLink : previous.expanded)),
    syncLocation: Boolean(
      initialLink
        ? fromLink ||
            (initialLink.get("point") === pointId &&
              initialLink.has("floor_section"))
        : previous.expanded || !floorId,
    ),
  };
}

// A VR layer may target a different building without discarding the active
// route or tour. Other query changes remain normal browser navigation.
export function panoramaOnlyTransition(before: string, after: string): boolean {
  const previous = new URL(before),
    next = new URL(after);
  if (
    !previous.searchParams.has("panorama") &&
    !next.searchParams.has("panorama")
  )
    return false;
  for (const url of [previous, next]) {
    url.searchParams.delete("panorama");
    url.searchParams.delete("point");
    url.searchParams.sort();
  }
  return previous.href === next.href;
}
