import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Panorama } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { embeddedPanoramaUrl, externalPanoramaUrl } from "./panorama";
import "./panorama.css";

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
  const embed = item ? embeddedPanoramaUrl(item.url) : null,
    external = item ? externalPanoramaUrl(item.url) : null;
  const [attempt, setAttempt] = useState(0),
    [waiting, setWaiting] = useState(true);
  const [insets, setInsets] = useState<{
    top: number;
    right: number;
    bottom: number;
  }>();
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
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".app-header");
    const native = document.querySelector<HTMLElement>(".native-dock");
    let observed: HTMLElement | null = null;
    const measure = () => {
      const dock = document.querySelector<HTMLElement>(".native-agent");
      const bounds = dock?.getBoundingClientRect();
      const side =
        window.innerWidth >= 900 ||
        (window.innerWidth >= 640 && window.innerWidth > window.innerHeight);
      const next = {
        top: Math.max(8, (header?.getBoundingClientRect().bottom ?? 68) + 8),
        right:
          bounds && side
            ? window.innerWidth - bounds.left + 12
            : window.innerWidth <= 760
              ? 8
              : 20,
        bottom: bounds && !side ? window.innerHeight - bounds.top + 10 : 12,
      };
      setInsets((current) =>
        current?.top === next.top &&
        current.right === next.right &&
        current.bottom === next.bottom
          ? current
          : next,
      );
      if (dock !== observed) {
        if (observed) size?.unobserve(observed);
        observed = dock;
        if (observed) size?.observe(observed);
      }
    };
    const size =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (header) size?.observe(header);
    const changes =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(measure)
        : null;
    if (native) changes?.observe(native, { childList: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      size?.disconnect();
      changes?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    setWaiting(true);
    // Cross-origin iframe load/error cannot prove the panorama actually rendered.
    const timer = window.setTimeout(() => setWaiting(false), 12000);
    return () => window.clearTimeout(timer);
  }, [item?.id, item?.revision, item?.url, attempt]);
  return createPortal(
    <section
      className="panorama-viewer"
      style={insets}
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
          <small>
            {embed ? "学校官方全景 · Twin NKU 内浏览" : "校园全景 · 原网站入口"}
          </small>
          <h2 id="panorama-viewer-title" ref={title} tabIndex={-1}>
            {item?.title || "校园全景"}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭全景，返回地图"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {embed && item ? (
        <div className="panorama-frame-wrap">
          <iframe
            key={`${item.id}:${item.revision}:${attempt}`}
            src={embed}
            title={`${item?.title || "校园全景"}（学校官方全景）`}
            className="panorama-frame"
            allow="fullscreen"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-pointer-lock"
            referrerPolicy="no-referrer"
            onLoad={() => setWaiting(false)}
            onError={() => setWaiting(false)}
          />
        </div>
      ) : (
        <div className="panorama-unavailable">
          <Icon name="arrow" size={26} />
          <h3>
            {notice ||
              (external ? "此全景需要在原网站浏览" : "全景链接暂不可用")}
          </h3>
          <p>
            {external
              ? "此来源尚未配置站内嵌入，可以通过下方链接访问已发布的全景。"
              : "可以返回地图继续导览，小开的对话会保留。"}
          </p>
        </div>
      )}
      <footer className="panorama-viewer-footer">
        <p role="status">
          {embed && waiting
            ? "正在连接学校全景…"
            : embed
              ? "若画面空白或无法操作，可重新载入或打开学校原网站。"
              : "关闭后即可继续地图导览，小开的对话会保留。"}
        </p>
        <div>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              重新读取资料
            </button>
          )}
          {embed && (
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重新载入
            </button>
          )}
          {external && (
            <a href={external} target="_blank" rel="noopener noreferrer">
              {embed ? "打开学校原网站" : "打开全景原网站"}
              <span className="sr-only">（新窗口）</span>
            </a>
          )}
          <button type="button" onClick={onClose}>
            返回地图
          </button>
        </div>
      </footer>
    </section>,
    document.body,
  );
}
