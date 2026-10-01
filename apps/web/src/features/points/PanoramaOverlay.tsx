import { useEffect, useState } from "react";
import { api, type Panorama } from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { LOCATION_CHANGE_EVENT, writeLocation } from "../../shared/navigation";
import { panoramaLocation } from "./panorama";
import { PanoramaViewer } from "./PanoramaViewer";

type Selection = { pointId: string; panoramaId: string };
function readSelection(): Selection | null {
  const params = new URLSearchParams(window.location.search);
  const pointId = params.get("point"),
    panoramaId = params.get("panorama");
  return pointId && panoramaId ? { pointId, panoramaId } : null;
}

// Mounted once beside the map so navigation/tour panels never unmount a VR view.
export function PanoramaOverlay() {
  const [selection, setSelection] = useState(readSelection);
  const [item, setItem] = useState<Panorama | undefined>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const synchronize = () => {
      const next = readSelection();
      setSelection((current) =>
        current?.pointId === next?.pointId &&
        current?.panoramaId === next?.panoramaId
          ? current
          : next,
      );
    };
    window.addEventListener("popstate", synchronize);
    window.addEventListener(LOCATION_CHANGE_EVENT, synchronize);
    return () => {
      window.removeEventListener("popstate", synchronize);
      window.removeEventListener(LOCATION_CHANGE_EVENT, synchronize);
    };
  }, []);
  useEffect(() => {
    setItem(undefined);
    setStatus("loading");
    if (!selection) return;
    let controller: AbortController | null = null,
      disposed = false;
    const selected = selection;
    async function refresh() {
      controller?.abort();
      const pending = new AbortController();
      controller = pending;
      try {
        const { data } = await api.panoramas(selected.pointId, pending.signal);
        if (pending.signal.aborted || disposed) return;
        const next = data.find(
          (row) =>
            row.point_id === selected.pointId && row.id === selected.panoramaId,
        );
        setItem((old) =>
          JSON.stringify(old) === JSON.stringify(next) ? old : next,
        );
        setStatus("ready");
      } catch {
        if (!pending.signal.aborted && !disposed) {
          setItem(undefined);
          setStatus("error");
        }
      }
    }
    void refresh();
    const stop = watchCatalogChanges(() => void refresh());
    return () => {
      disposed = true;
      controller?.abort();
      stop();
    };
  }, [selection?.pointId, selection?.panoramaId, retry]);
  if (!selection) return null;
  const active =
    item?.point_id === selection.pointId && item.id === selection.panoramaId
      ? item
      : undefined;
  return (
    <PanoramaViewer
      item={active}
      notice={
        status === "error"
          ? "全景资料暂时无法读取"
          : status === "loading"
            ? "正在读取全景资料…"
            : "该全景未公开或已下架"
      }
      onRetry={
        status === "error" ? () => setRetry((value) => value + 1) : undefined
      }
      onClose={() => {
        // Close only this overlay. Tour selection, route state and unrelated filters survive.
        const href = panoramaLocation(
          window.location.href,
          selection.pointId,
          null,
        );
        writeLocation(href, "replace");
        setSelection(readSelection());
      }}
    />
  );
}
