import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import type { FloorImage } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { toMapPoint } from "../map/coordinates";
import { mountFloorImage, type FloorImageState } from "./imageLoad";

export function FloorViewer({
  asset,
  title,
}: {
  asset: FloorImage;
  title: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map | null>(null);
  const [state, setState] = useState<FloorImageState>("loading");
  const [zoom, setZoom] = useState(0);
  const [retry, setRetry] = useState(0);
  const fit = useRef<() => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const bounds = L.latLngBounds(
      toMapPoint({ x: 0, y: asset.height_px }, 0),
      toMapPoint({ x: asset.width_px, y: 0 }, 0),
    );
    const map = L.map(host.current, {
      crs: L.CRS.Simple,
      minZoom: -7,
      maxZoom: 2,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      zoomControl: false,
      attributionControl: false,
      maxBoundsViscosity: 0.8,
    });
    instance.current = map;
    map.setMaxBounds(bounds.pad(0.5));
    map.on("zoomend", () => setZoom(map.getZoom()));
    fit.current = () =>
      map.fitBounds(bounds, { padding: [20, 20], animate: false });
    fit.current();
    let initialSize = true;
    const resize = new ResizeObserver(() => {
      if (disposed) return;
      map.invalidateSize({ pan: false });
      if (initialSize) {
        fit.current();
        initialSize = false;
      }
    });
    resize.observe(host.current);
    return () => {
      disposed = true;
      resize.disconnect();
      map.remove();
      instance.current = null;
      fit.current = () => {};
    };
  }, [asset.width_px, asset.height_px]);

  useEffect(() => {
    const map = instance.current;
    if (!map) return;
    const bounds = L.latLngBounds(
      toMapPoint({ x: 0, y: asset.height_px }, 0),
      toMapPoint({ x: asset.width_px, y: 0 }, 0),
    );
    const layer = L.imageOverlay(asset.url, bounds, {
      alt: title,
      interactive: false,
    });
    return mountFloorImage(layer, map, setState);
  }, [asset.url, asset.width_px, asset.height_px, title, retry]);

  return (
    <div className="floor-viewer">
      <div
        className="floor-canvas"
        ref={host}
        role="region"
        tabIndex={state === "ready" ? 0 : -1}
        aria-busy={state === "loading"}
        aria-label={`${title}，可拖动和缩放`}
      />
      <div className="floor-viewer-tools" aria-label="楼层图工具">
        <button
          aria-label="放大楼层图"
          disabled={state !== "ready" || zoom >= 2}
          onClick={() => instance.current?.zoomIn()}
        >
          <Icon name="plus" size={17} />
        </button>
        <button
          aria-label="缩小楼层图"
          disabled={state !== "ready" || zoom <= -7}
          onClick={() => instance.current?.zoomOut()}
        >
          <Icon name="minus" size={17} />
        </button>
        <button
          aria-label="适合窗口"
          disabled={state !== "ready"}
          onClick={() => fit.current()}
        >
          <Icon name="focus" size={17} />
        </button>
        <button
          aria-label="原尺寸查看"
          disabled={state !== "ready"}
          onClick={() => instance.current?.setZoom(0)}
        >
          1:1
        </button>
      </div>
      <span className="floor-zoom">{Math.round(2 ** zoom * 100)}%</span>
      {state === "loading" && (
        <div className="floor-image-status" role="status">
          <span className="spinner" /> 正在读取楼层图…
        </div>
      )}
      {(state === "error" || state === "timeout") && (
        <div className="floor-image-status" role="alert">
          {state === "timeout"
            ? "楼层图加载超时，请检查网络后重试"
            : "楼层图暂时无法显示，请重试"}
          <button onClick={() => setRetry((n) => n + 1)}>重新加载</button>
        </div>
      )}
    </div>
  );
}
