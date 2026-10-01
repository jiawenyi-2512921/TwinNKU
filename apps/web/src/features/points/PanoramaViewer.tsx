import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Panorama } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { externalPanoramaUrl } from "./panorama";
import "./panorama.css";

// Compatibility for existing ?panorama= shared links. Browsers require an
// explicit click to open the original site; never redirect from a model reply.
export function PanoramaViewer({
  item,
  onClose,
  notice,
  onRetry,
}: {
  item?: Panorama;
  notice?: string;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const external = item ? externalPanoramaUrl(item.url) : null;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const stages = Array.from(
      document.querySelectorAll<HTMLElement>(".map-stage"),
    );
    const before = stages.map((stage) => stage.inert);
    stages.forEach((stage) => {
      stage.inert = true;
    });
    title.current?.focus({ preventScroll: true });
    return () => {
      stages.forEach((stage, index) => {
        stage.inert = before[index];
      });
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <section
      className="panorama-viewer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="panorama-viewer-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="panorama-viewer-header">
        <div>
          <small>校园 VR</small>
          <h2 id="panorama-viewer-title" ref={title} tabIndex={-1}>
            {item?.title || "校园全景"}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭全景入口，返回地图"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="panorama-unavailable">
        <p role="status">
          {external
            ? "VR将在新标签页打开。本站地图、导览进度和小开对话会保留。"
            : notice || "全景链接暂不可用"}
        </p>
      </div>
      <footer className="panorama-viewer-footer">
        {onRetry && (
          <button type="button" onClick={onRetry}>
            重新读取资料
          </button>
        )}
        {external && (
          <a href={external} target="_blank" rel="noopener noreferrer">
            打开 VR<span className="sr-only">（新标签页）</span>
          </a>
        )}
        <button type="button" onClick={onClose}>
          返回地图
        </button>
      </footer>
    </section>,
    document.body,
  );
}
