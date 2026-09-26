// Browser-only preferences contain public point IDs, never copied campus content.
export const MAX_FAVORITES = 200;
export const MAX_RECENT = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlaceMemory = { version: 1; favorites: string[]; recent: string[] };
type StoragePort = Pick<Storage, "getItem" | "setItem">;
type Action =
  | { type: "favorite"; id: string }
  | { type: "visit"; id: string }
  | { type: "clear-recent" };
export type MemorySnapshot = { places: PlaceMemory; memoryOnly: boolean };

function empty(): PlaceMemory {
  return { version: 1, favorites: [], recent: [] };
}

function ids(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === "string" && uuid.test(id),
      ),
    ),
  ].slice(0, limit);
}

export function parsePlaceMemory(raw: string | null): PlaceMemory {
  if (!raw || raw.length > 32768) return empty();
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1) return empty();
    return {
      version: 1,
      favorites: ids(data.favorites, MAX_FAVORITES),
      recent: ids(data.recent, MAX_RECENT),
    };
  } catch {
    return empty();
  }
}

export function placeMemoryKey(campusId: string): string {
  return `twinnku:places:v1:${encodeURIComponent(campusId)}`;
}

export function createPlaceMemory(
  storage: () => StoragePort,
  campusId: string,
) {
  const key = placeMemoryKey(campusId);
  const listeners = new Set<() => void>();
  let snapshot: MemorySnapshot = { places: empty(), memoryOnly: false };

  function publish(next: MemorySnapshot) {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function refresh() {
    try {
      publish({
        places: parsePlaceMemory(storage().getItem(key)),
        memoryOnly: false,
      });
    } catch {
      publish({ ...snapshot, memoryOnly: true });
    }
  }
  refresh();

  return {
    key,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    dispatch(action: Action): "updated" | "limit" | "ignored" {
      if (action.type !== "clear-recent" && !uuid.test(action.id))
        return "ignored";
      // Read before writing so another tab's completed edits are retained.
      // If storage is denied, keep working with this page's in-memory state.
      if (!snapshot.memoryOnly) refresh();
      const places = snapshot.places;
      let next = places;
      if (action.type === "favorite") {
        const saved = places.favorites.includes(action.id);
        if (!saved && places.favorites.length >= MAX_FAVORITES) return "limit";
        next = {
          ...places,
          favorites: saved
            ? places.favorites.filter((id) => id !== action.id)
            : [action.id, ...places.favorites],
        };
      } else if (action.type === "visit") {
        next = {
          ...places,
          recent: [
            action.id,
            ...places.recent.filter((id) => id !== action.id),
          ].slice(0, MAX_RECENT),
        };
      } else next = { ...places, recent: [] };
      if (JSON.stringify(next) === JSON.stringify(places)) return "ignored";
      let memoryOnly = snapshot.memoryOnly;
      try {
        storage().setItem(key, JSON.stringify(next));
        memoryOnly = false;
      } catch {
        memoryOnly = true;
      }
      publish({ places: next, memoryOnly });
      return "updated";
    },
  };
}
