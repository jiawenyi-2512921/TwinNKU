// Sharing uses the visible, validated selection. Unrelated URL parameters survive.
type NavigationPort = Pick<Window, "history" | "location">;

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

export function pointLocation(href: string, pointId: string | null): string {
  const url = new URL(href);
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
