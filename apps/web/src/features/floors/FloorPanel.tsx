import { useEffect, useRef, useState } from "react";
import { api, type Floor } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { watchCatalogChanges } from "../../shared/catalogSync";
import {
  floorLocation,
  closeFloorLocation,
  writeLocation,
  reconcileFloorView,
  resolveFloorImage,
} from "../../shared/navigation";
import { FloorViewer } from "./FloorViewer";
import "./floors.css";
import type { AgentContext } from "../agent/protocol";

export function FloorPanel({
  pointId,
  pointName,
  onAsk,
}: {
  pointId: string;
  pointName: string;
  onAsk?: (
    floor: Pick<AgentContext, "floor_id" | "floor_label" | "floor_section">,
  ) => void;
}) {
  const [floors, setFloors] = useState<Floor[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSection, setSelectedSection] = useState("main");
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const floorsRef = useRef<Floor[]>([]);
  const expandedRef = useRef(false);
  const selection = useRef({ floorId: "", section: "main" });
  const dialog = useRef<HTMLDialogElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let pending: AbortController | null = null;
    let disposed = false;
    setFloors([]);
    floorsRef.current = [];
    setSelectedId("");
    setSelectedSection("main");
    setStatus("loading");
    let needsLocation = true;
    async function refresh(fromLocation = false) {
      needsLocation ||= fromLocation;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const { data } = await api.floors(pointId, controller.signal);
        if (controller.signal.aborted || disposed) return;
        const next = reconcileFloorView(
          data,
          pointId,
          { ...selection.current, expanded: expandedRef.current },
          needsLocation ? new URLSearchParams(window.location.search) : null,
        );
        floorsRef.current = next.floors;
        // Unchanged polling data keeps image identity and the current zoom.
        setFloors((previous) =>
          JSON.stringify(previous) === JSON.stringify(next.floors)
            ? previous
            : next.floors,
        );
        setSelectedId(next.floorId);
        setSelectedSection(next.section);
        selection.current = { floorId: next.floorId, section: next.section };
        expandedRef.current = next.expanded;
        setExpanded(next.expanded);
        if (next.syncLocation) {
          writeLocation(
            floorLocation(
              window.location.href,
              pointId,
              next.expanded ? next.floorId : null,
              next.section,
            ),
            "replace",
          );
        }
        needsLocation = false;
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && !disposed) {
          // Retain the requested link so a successful retry restores its layer.
          needsLocation = true;
          expandedRef.current = false;
          setExpanded(false);
          setStatus("error");
        }
      }
    }
    function restoreLocation() {
      const link = new URLSearchParams(window.location.search);
      if (link.get("point") !== pointId) {
        pending?.abort();
        expandedRef.current = false;
        setExpanded(false);
        return;
      }
      const next = reconcileFloorView(
        floorsRef.current,
        pointId,
        { ...selection.current, expanded: expandedRef.current },
        link,
      );
      selection.current = { floorId: next.floorId, section: next.section };
      setSelectedId(next.floorId);
      setSelectedSection(next.section);
      expandedRef.current = next.expanded;
      setExpanded(next.expanded);
      void refresh(true);
    }
    void refresh();
    window.addEventListener("popstate", restoreLocation);
    // A publication refresh preserves the current view; only browser history
    // restoration should interpret the URL as a new floor selection.
    const stopWatching = watchCatalogChanges(() => void refresh());
    return () => {
      disposed = true;
      pending?.abort();
      stopWatching();
      window.clearTimeout(copyTimer.current);
      window.removeEventListener("popstate", restoreLocation);
    };
  }, [pointId, retry]);

  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [expanded, status]);

  const floor = floors.find((f) => f.id === selectedId);
  const labeled = floor?.images?.filter((a) => a.variant === "labeled") ?? [];
  const asset = resolveFloorImage(labeled, selectedSection);
  const title = `${pointName} · ${floor?.label ?? ""}${asset?.section_label ? ` · ${asset.section_label}` : ""} · 已标注图`;
  function selectFloor(id: string) {
    if (!floors.some((f) => f.id === id && f.point_id === pointId)) return;
    setSelectedId(id);
    const section =
      resolveFloorImage(
        floors.find((f) => f.id === id)?.images ?? [],
        id === selectedId ? selectedSection : null,
      )?.section ?? "main";
    setSelectedSection(section);
    selection.current = { floorId: id, section };
    writeLocation(
      floorLocation(window.location.href, pointId, id, section),
      "replace",
    );
    setCopyMessage("");
  }
  function selectSection(section: string) {
    if (!labeled.some((image) => (image.section ?? "main") === section)) return;
    setSelectedSection(section);
    selection.current = { floorId: selectedId, section };
    writeLocation(
      floorLocation(window.location.href, pointId, selectedId, section),
      "replace",
    );
    setCopyMessage("");
  }
  function close() {
    expandedRef.current = false;
    setExpanded(false);
    dialog.current?.close();
    closeFloorLocation(pointId);
    openButton.current?.focus();
  }
  async function copyFloorLink() {
    if (!floor || !asset) return;
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(
        floorLocation(
          window.location.href,
          pointId,
          floor.id,
          asset.section ?? "main",
        ),
      );
      setCopyMessage("本层链接已复制");
    } catch {
      setCopyMessage("可复制浏览器地址分享本层");
    }
    copyTimer.current = window.setTimeout(() => setCopyMessage(""), 2800);
  }
  function selectors(prefix: string) {
    return (
      <div className="floor-selectors">
        <label htmlFor={`${prefix}-floor`}>选择楼层</label>
        <select
          id={`${prefix}-floor`}
          value={selectedId}
          onChange={(e) => selectFloor(e.target.value)}
        >
          {floors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {labeled.length > 1 && (
          <>
            <label htmlFor={`${prefix}-section`}>选择分区</label>
            <select
              id={`${prefix}-section`}
              value={asset?.section ?? "main"}
              onChange={(e) => selectSection(e.target.value)}
            >
              {labeled.map((image) => (
                <option
                  key={image.section ?? "main"}
                  value={image.section ?? "main"}
                >
                  {image.section_label ?? "全层"}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    );
  }
  return (
    <section
      className="floor-panel"
      data-point-id={pointId}
      aria-label={`${pointName}楼层结构`}
    >
      {status === "loading" ? (
        <p role="status" className="floor-empty">
          <span className="spinner" /> 正在读取楼层…
        </p>
      ) : status === "error" ? (
        <div className="floor-empty" role="alert">
          <p>暂时无法读取楼层资料</p>
          <button
            className="primary-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            重试
          </button>
        </div>
      ) : !floor ? null : (
        <>
          <button
            className="floor-entry"
            ref={openButton}
            onClick={() => {
              const returnTo = floorLocation(
                window.location.href,
                pointId,
                null,
              );
              writeLocation(
                floorLocation(
                  window.location.href,
                  pointId,
                  selectedId,
                  selectedSection,
                ),
                "push",
                window,
                returnTo,
              );
              expandedRef.current = true;
              setExpanded(true);
            }}
          >
            <Icon name="layers" size={20} />
            <span>
              查看楼层图<small>{floors.length} 个已发布楼层</small>
            </span>
            <Icon name="arrow" size={18} />
          </button>
          <dialog
            className="floor-dialog"
            aria-labelledby="floor-dialog-title"
            ref={dialog}
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
            onClose={() => {
              expandedRef.current = false;
              setExpanded(false);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <header className="floor-dialog-header">
              <div>
                <span>楼层平面图</span>
                <h2 id="floor-dialog-title">{pointName}</h2>
              </div>
              <button className="floor-back" onClick={copyFloorLink}>
                <Icon name="link" />
                <span>复制本层链接</span>
              </button>
              {onAsk && (
                <button
                  className="floor-back"
                  onClick={() => {
                    close();
                    onAsk({
                      floor_id: floor.id,
                      floor_label: floor.label,
                      floor_section: asset?.section ?? "main",
                    });
                  }}
                >
                  <Icon name="chat" />
                  <span>问小开</span>
                </button>
              )}
              <button
                className="floor-back"
                aria-label="返回校园地图"
                onClick={close}
              >
                <Icon name="close" />
                <span>返回地图</span>
              </button>
            </header>
            {expanded && (
              <>
                {selectors("expanded")}
                {asset && (
                  <FloorViewer
                    key={`${floor.id}-${floor.revision}-${asset.section ?? "main"}`}
                    asset={asset}
                    title={title}
                  />
                )}
                <footer>
                  <span role="status">{copyMessage}</span>
                  <span>
                    {floor.label}
                    {asset?.section_label ? ` · ${asset.section_label}` : ""} ·
                    已标注图
                  </span>
                  <span>
                    {asset?.width_px} × {asset?.height_px} 像素
                  </span>
                </footer>
              </>
            )}
          </dialog>
        </>
      )}
    </section>
  );
}
