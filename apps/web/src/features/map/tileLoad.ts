import type { Map as LeafletMap, TileEvent, TileLayer } from "leaflet";

export type TileLoadState = { failed: number; retrying: boolean };
export type TileLoadController = { retry: () => void; dispose: () => void };

type TrackedTile = {
  image: HTMLImageElement;
  coords: TileEvent["coords"];
  url: string;
  phase: "loading" | "failed" | "ready";
  failed: boolean;
  retries: number;
  deadline?: ReturnType<typeof setTimeout>;
  backoff?: ReturnType<typeof setTimeout>;
};

/** Track public Leaflet tile events; never redraw successful tiles or read its cache. */
export function watchMapTiles(
  layer: TileLayer,
  map: LeafletMap,
  onChange: (state: TileLoadState) => void,
  {
    timeoutMs = 15_000,
    retryDelays = [700, 2_000],
    network = window,
  }: {
    timeoutMs?: number;
    retryDelays?: readonly number[];
    network?: Pick<Window, "addEventListener" | "removeEventListener"> & {
      navigator?: Pick<Navigator, "onLine">;
    };
  } = {},
): TileLoadController {
  const tiles = new Map<HTMLElement, TrackedTile>();
  let disposed = false;
  let offline = network.navigator?.onLine === false;
  let lastState: TileLoadState = { failed: 0, retrying: false };

  const visible = (tile: TrackedTile) => {
    // Leaflet rounds grid zooms and overzooms maxNativeZoom. Old zoom levels
    // retained during transitions must not produce errors for the current view.
    const zoom = Math.min(
      layer.options.maxNativeZoom ?? Infinity,
      Math.max(
        layer.options.minNativeZoom ?? -Infinity,
        Math.round(map.getZoom()),
      ),
    );
    if (tile.coords.z !== zoom) return false;
    const bounds = map.getBounds();
    const topLeft = map.project(bounds.getNorthWest(), tile.coords.z);
    const bottomRight = map.project(bounds.getSouthEast(), tile.coords.z);
    const size = layer.getTileSize();
    return (
      tile.coords.x * size.x < bottomRight.x &&
      (tile.coords.x + 1) * size.x > topLeft.x &&
      tile.coords.y * size.y < bottomRight.y &&
      (tile.coords.y + 1) * size.y > topLeft.y
    );
  };
  const clearTimers = (tile: TrackedTile) => {
    clearTimeout(tile.deadline);
    clearTimeout(tile.backoff);
    tile.deadline = undefined;
    tile.backoff = undefined;
  };
  const notify = () => {
    if (disposed) return;
    const failed = [...tiles.values()].filter(
      (tile) => tile.failed && visible(tile),
    );
    const state = {
      failed: failed.length,
      retrying:
        failed.length > 0 &&
        failed.every(
          (tile) => tile.phase === "loading" || tile.backoff !== undefined,
        ),
    };
    if (
      state.failed !== lastState.failed ||
      state.retrying !== lastState.retrying
    ) {
      lastState = state;
      onChange(state);
    }
  };
  const current = (tile: TrackedTile) =>
    !disposed && tiles.get(tile.image) === tile;

  const scheduleRetry = (tile: TrackedTile) => {
    if (
      offline ||
      tile.backoff !== undefined ||
      tile.retries >= retryDelays.length ||
      !visible(tile)
    )
      return;
    tile.backoff = setTimeout(() => {
      tile.backoff = undefined;
      if (!current(tile) || !visible(tile) || tile.phase !== "failed") return;
      tile.retries++;
      restart(tile);
    }, retryDelays[tile.retries]);
  };
  const fail = (tile: TrackedTile) => {
    if (!current(tile) || tile.phase === "ready") return;
    clearTimers(tile);
    tile.phase = "failed";
    tile.failed = visible(tile);
    if (tile.failed) scheduleRetry(tile);
    notify();
  };
  const startDeadline = (tile: TrackedTile) => {
    if (!offline && tile.deadline === undefined && visible(tile)) {
      tile.deadline = setTimeout(() => fail(tile), timeoutMs);
    }
  };
  const restart = (tile: TrackedTile) => {
    clearTimers(tile);
    tile.phase = "loading";
    startDeadline(tile);
    // Keep the exact original URL and Leaflet's existing image event handlers.
    // Removing src first also interrupts a stalled image request. No cache busting.
    tile.image.removeAttribute("src");
    tile.image.src = tile.url;
    notify();
  };
  const started = (event: TileEvent) => {
    if (disposed) return;
    const image = event.tile as HTMLImageElement;
    const url = image.getAttribute("src");
    if (!url) return;
    const previous = tiles.get(image);
    if (previous) clearTimers(previous);
    const tile: TrackedTile = {
      image,
      coords: event.coords,
      url,
      phase: "loading",
      failed: false,
      retries: 0,
    };
    tiles.set(image, tile);
    if (offline) fail(tile);
    else startDeadline(tile);
    notify();
  };
  const loaded = (event: TileEvent) => {
    const tile = tiles.get(event.tile);
    if (!tile || disposed) return;
    clearTimers(tile);
    tile.phase = "ready";
    tile.failed = false;
    notify();
  };
  const failed = (event: TileEvent) => {
    const tile = tiles.get(event.tile);
    if (tile) fail(tile);
  };
  const unloaded = (event: TileEvent) => {
    const tile = tiles.get(event.tile);
    if (!tile || disposed) return;
    clearTimers(tile);
    tiles.delete(event.tile);
    notify();
  };
  const refresh = () => {
    if (disposed) return;
    for (const tile of tiles.values()) {
      if (!visible(tile)) {
        clearTimers(tile);
        tile.failed = false;
      } else if (tile.phase === "failed") {
        tile.failed = true;
        scheduleRetry(tile);
      } else if (tile.phase === "loading") startDeadline(tile);
    }
    notify();
  };
  const retry = () => {
    if (disposed || offline) return;
    for (const tile of tiles.values()) {
      if (tile.phase === "failed" && visible(tile)) {
        tile.retries = 0;
        restart(tile);
      }
    }
  };
  const wentOffline = () => {
    if (disposed) return;
    offline = true;
    for (const tile of tiles.values()) {
      if (tile.phase !== "ready") fail(tile);
    }
  };
  const wentOnline = () => {
    if (disposed) return;
    const wasOffline = offline;
    offline = false;
    // A real reconnect gets one fresh bounded cycle. Repeated online/viewport
    // notifications alone cannot continually reset an exhausted retry budget.
    if (wasOffline) retry();
    else refresh();
  };

  // Attach before addTo/fitBounds so even cached initial images are observed.
  layer.on("tileloadstart", started);
  layer.on("tileload", loaded);
  layer.on("tileerror", failed);
  layer.on("tileunload", unloaded);
  layer.on("tileabort", unloaded);
  map.on("moveend zoomend resize", refresh);
  network.addEventListener("offline", wentOffline);
  network.addEventListener("online", wentOnline);
  return {
    retry,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const tile of tiles.values()) clearTimers(tile);
      tiles.clear();
      layer.off("tileloadstart", started);
      layer.off("tileload", loaded);
      layer.off("tileerror", failed);
      layer.off("tileunload", unloaded);
      layer.off("tileabort", unloaded);
      map.off("moveend zoomend resize", refresh);
      network.removeEventListener("offline", wentOffline);
      network.removeEventListener("online", wentOnline);
    },
  };
}
