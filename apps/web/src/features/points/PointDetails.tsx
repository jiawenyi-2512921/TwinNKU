import { useEffect, useRef, useState } from "react";
import type { Point } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { floorLocation } from "../../shared/navigation";
import { FloorPanel } from "../floors/FloorPanel";

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
  return point.category === "landscape"
    ? "leaf"
    : point.name.endsWith("门")
      ? "gate"
      : "building";
}

export function PointDetails({
  point,
  index,
  onClose,
}: {
  point: Point;
  index: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"about" | "floor">("about");
  const [copyMessage, setCopyMessage] = useState("");
  const [copyTimer, setCopyTimer] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canHaveFloors =
    point.category === "academic" ||
    point.category === "residence" ||
    point.category === "dining" ||
    (point.category === "public_area" && !point.name.endsWith("门"));
  useEffect(() => {
    setTab(
      canHaveFloors && new URLSearchParams(window.location.search).has("floor")
        ? "floor"
        : "about",
    );
    if (!canHaveFloors) {
      window.history.replaceState(
        window.history.state,
        "",
        floorLocation(window.location.href, point.id, null),
      );
    }
    setCopyMessage("");
    heading.current?.focus({ preventScroll: true });
  }, [point.id, canHaveFloors]);
  useEffect(
    () => () => {
      if (copyTimer !== null) window.clearTimeout(copyTimer);
    },
    [copyTimer],
  );
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopyMessage("地点链接已复制");
    } catch {
      setCopyMessage("可复制浏览器地址来分享这个地点");
    }
    setCopyTimer(window.setTimeout(() => setCopyMessage(""), 2800));
  }
  function showAbout() {
    setTab("about");
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, point.id, null),
    );
  }
  return (
    <aside className="point-details" aria-label="地点详情">
      <button
        className="icon-button mobile-detail-close"
        aria-label="关闭地点详情"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <div className={`detail-banner tone-${point.category}`}>
        <span className="detail-number">
          {String(index + 1).padStart(2, "0")}
        </span>
        <Icon name={pointIcon(point)} size={58} />
        <span className="detail-campus">NANKAI · JINNAN</span>
        <button
          className="icon-button detail-close"
          aria-label="关闭地点详情"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="detail-body">
        <span className="category-tag">{categoryLabels[point.category]}</span>
        <h2 ref={heading} tabIndex={-1}>
          {point.name}
        </h2>
        <p className="detail-location">
          <Icon name="pin" size={14} />
          南开大学 · 津南校区
        </p>
        <div className="detail-tabs" role="tablist" aria-label="地点内容">
          <button
            role="tab"
            id="tab-about"
            aria-controls="detail-content"
            aria-selected={tab === "about"}
            onClick={showAbout}
          >
            地点概览
          </button>
          {canHaveFloors && (
            <button
              role="tab"
              id="tab-floor"
              aria-controls="detail-content"
              aria-selected={tab === "floor"}
              onClick={() => setTab("floor")}
            >
              楼层结构
            </button>
          )}
        </div>
        <div
          id="detail-content"
          role="tabpanel"
          aria-labelledby={
            tab === "floor" && canHaveFloors ? "tab-floor" : "tab-about"
          }
        >
          {tab === "floor" && canHaveFloors ? (
            <FloorPanel
              key={point.id}
              pointId={point.id}
              pointName={point.name}
            />
          ) : (
            <>
              <p className="point-summary">
                {point.summary ||
                  "已在地图上为你标出这个地点。详细介绍将随校园资料逐步补充。"}
              </p>
              <div className="content-status">
                <span /> 全景与讲解资料待补充
              </div>
              {canHaveFloors && (
                <button className="floor-entry" onClick={() => setTab("floor")}>
                  <span className="floor-entry-icon">
                    <Icon name="layers" />
                  </span>
                  <span>
                    查看楼层结构<small>平面图与公共设施</small>
                  </span>
                  <Icon name="arrow" size={17} />
                </button>
              )}
            </>
          )}
        </div>
        <button className="share-point" onClick={copyLink}>
          <Icon name="link" size={16} />
          复制地点链接
        </button>
        <span className="copy-message" role="status">
          {copyMessage}
        </span>
      </div>
    </aside>
  );
}
