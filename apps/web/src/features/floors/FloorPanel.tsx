import { useEffect, useRef, useState } from "react";
import { api, type Floor } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import {
  floorLocation,
  reconcileFloorView,
  resolveFloorImage,
} from "../../shared/navigation";
import { FloorViewer } from "./FloorViewer";
import "./floors.css";

export function FloorPanel({
  pointId,
  pointName,
}: {
  pointId: string;
  pointName: string;
}) {
  const [floors, setFloors] = useState<Floor[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSection, setSelectedSection] = useState("main");
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const selection = useRef({ floorId: "", section: "main" });
  const dialog = useRef<HTMLDialogElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let pending: AbortController | null = null;
    let disposed = false;
    setFloors([]);
    setSelectedId("");
    setSelectedSection("main");
    setStatus("loading");
    let initial = true;
    async function refresh() {
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
          initial ? new URLSearchParams(window.location.search) : null,
        );
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
          window.history.replaceState(
            window.history.state,
            "",
            floorLocation(
              window.location.href,
              pointId,
              next.floorId || null,
              next.section,
            ),
          );
        }
        initial = false;
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && !disposed) {
          expandedRef.current = false;
          setExpanded(false);
          window.history.replaceState(
            window.history.state,
            "",
            floorLocation(window.location.href, pointId, null),
          );
          setStatus("error");
        }
      }
    }
    function whenVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    void refresh();
    const timer = window.setInterval(whenVisible, 30000);
    window.addEventListener("focus", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      disposed = true;
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
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
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, pointId, id, section),
    );
  }
  function selectSection(section: string) {
    if (!labeled.some((image) => (image.section ?? "main") === section)) return;
    setSelectedSection(section);
    selection.current = { floorId: selectedId, section };
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, pointId, selectedId, section),
    );
  }
  function close() {
    expandedRef.current = false;
    setExpanded(false);
    dialog.current?.close();
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, pointId, null),
    );
    openButton.current?.focus();
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
              selectFloor(selectedId);
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
