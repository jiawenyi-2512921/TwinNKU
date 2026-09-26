import type { ImageOverlay, Map } from "leaflet";

export const FLOOR_IMAGE_TIMEOUT_MS = 30_000;
export type FloorImageState = "loading" | "ready" | "error" | "timeout";

/** One image attempt; retries replace only the overlay, never the map viewport. */
export function mountFloorImage(
  layer: Pick<ImageOverlay, "on" | "off" | "addTo" | "remove">,
  map: Map,
  onState: (state: FloorImageState) => void,
  timeoutMs = FLOOR_IMAGE_TIMEOUT_MS,
) {
  let pending = true;
  const detach = () => {
    clearTimeout(timer);
    layer.off("load", loaded);
    layer.off("error", failed);
  };
  const settle = (state: "ready" | "error" | "timeout") => {
    if (!pending) return;
    pending = false;
    detach();
    // Removing the overlay does not promise to abort the browser's image fetch.
    // It does ensure a late load cannot display an expired attempt.
    if (state !== "ready") layer.remove();
    onState(state);
  };
  const loaded = () => settle("ready");
  const failed = () => settle("error");
  const timer = setTimeout(() => settle("timeout"), timeoutMs);
  layer.on("load", loaded);
  layer.on("error", failed);
  onState("loading");
  try {
    layer.addTo(map);
  } catch {
    failed();
  }
  return () => {
    pending = false;
    detach();
    layer.remove();
  };
}
