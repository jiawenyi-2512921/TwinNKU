import { useEffect, useRef, useState } from "react";
import type { Point } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { PanoramaPanel } from "./PanoramaPanel";
import { FloorPanel } from "../floors/FloorPanel";
import { PointIntroduction } from "./PointIntroduction";

export const categoryLabels: Record<Point["category"], string> = {
  public_area: "公共空间",
  academic: "教学建筑",
  landscape: "自然景观",
  patriotic: "红色文化",
  residence: "生活区域",
  dining: "校园餐饮",
  commerce: "校园服务",
  history: "校史文化",
};
export function pointIcon(point: Point) {
  if (point.category === "patriotic") return "pin";
  return point.category === "landscape"
    ? "leaf"
    : point.name.endsWith("门")
      ? "gate"
      : "building";
}

export function PointDetails({
  point,
  onClose,
}: {
  point: Point;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    return () => window.clearTimeout(copyTimer.current);
  }, []);
  async function copyLink() {
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyMessage("地点链接已复制");
    } catch {
      setCopyMessage("可复制浏览器地址来分享这个地点");
    }
    copyTimer.current = window.setTimeout(() => setCopyMessage(""), 2800);
  }
  return (
    <aside
      className={`point-details${expanded ? " expanded" : ""}`}
      aria-label="地点详情"
    >
      <header className="detail-heading">
        <div>
          <span className="category-tag">{categoryLabels[point.category]}</span>
          <h2 ref={heading} tabIndex={-1}>
            {point.name}
          </h2>
        </div>
        <div className="detail-heading-actions">
          <button
            className="icon-button detail-expand"
            aria-label={expanded ? "收起详情" : "展开详情"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? "minus" : "plus"} />
          </button>
          <button
            className="icon-button"
            aria-label="关闭地点详情"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="detail-body">
        <FloorPanel pointId={point.id} pointName={point.name} />
        <PointIntroduction summary={point.summary} />
        <PanoramaPanel pointId={point.id} />
      </div>
      <footer className="detail-footer">
        <button className="share-point" onClick={copyLink}>
          <Icon name="link" size={16} />
          复制地点链接
        </button>
        <span className="copy-message" role="status">
          {copyMessage}
        </span>
      </footer>
    </aside>
  );
}
