import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import type { FloorImage } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { toMapPoint } from "../map/coordinates";

export function FloorViewer({
  asset,
  title,
}: {
  asset: FloorImage;
  title: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<L.Map | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState(0);
  const [retry, setRetry] = useState(0);
  const fit = useRef<() => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    setState("loading");
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
    const layer = L.imageOverlay(asset.url, bounds, {
      alt: title,
      interactive: false,
    });
    layer.on("load", () => setState("ready"));
    layer.on("error", () => setState("error"));
    layer.addTo(map);
    let initialSize = true;
    const resize = new ResizeObserver(() => {
      map.invalidateSize({ pan: false });
      if (initialSize) {
        fit.current();
        initialSize = false;
      }
    });
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      map.remove();
      instance.current = null;
    };
  }, [asset, title, retry]);

  return (
    <div className="floor-viewer">
      <div
        className="floor-canvas"
        ref={host}
        role="region"
        tabIndex={0}
        aria-label={`${title}，可拖动和缩放`}
      />
      <div className="floor-viewer-tools" aria-label="楼层图工具">
        <button
          aria-label="放大楼层图"
          disabled={zoom >= 2}
          onClick={() => instance.current?.zoomIn()}
        >
          <Icon name="plus" size={17} />
        </button>
        <button
          aria-label="缩小楼层图"
          disabled={zoom <= -7}
          onClick={() => instance.current?.zoomOut()}
        >
          <Icon name="minus" size={17} />
        </button>
        <button aria-label="适合窗口" onClick={() => fit.current()}>
          <Icon name="focus" size={17} />
        </button>
        <button
          aria-label="原尺寸查看"
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
      {state === "error" && (
        <div className="floor-image-status" role="alert">
          楼层图暂时无法显示
          <button onClick={() => setRetry((n) => n + 1)}>重新加载</button>
        </div>
      )}
    </div>
  );
}
