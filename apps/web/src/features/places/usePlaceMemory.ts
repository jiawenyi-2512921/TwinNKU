import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPlaceMemory } from "./memory";

export function usePlaceMemory(campusId: string) {
  const store = useMemo(
    () => createPlaceMemory(() => window.localStorage, campusId),
    [campusId],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === store.key || event.key === null) store.refresh();
    }
    window.addEventListener("storage", onStorage);
    store.refresh();
    return () => window.removeEventListener("storage", onStorage);
  }, [store]);
  return { ...snapshot, dispatch: store.dispatch };
}
