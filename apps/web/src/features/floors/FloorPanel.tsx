import { useEffect, useRef, useState } from "react";
import { api, type Floor } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import {
  floorLocation,
  resolveFloor,
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
  const dialog = useRef<HTMLDialogElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let pending: AbortController | null = null;
    let disposed = false;
    setFloors([]);
    setSelectedId("");
    setSelectedSection("main");
    setStatus("loading");
    async function refresh() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const { data } = await api.floors(pointId, controller.signal);
        if (controller.signal.aborted || disposed) return;
        const available = data.filter((f) => f.point_id === pointId);
        // Keep image object identity when unchanged so polling does not reset zoom.
        setFloors((previous) =>
          JSON.stringify(previous) === JSON.stringify(available)
            ? previous
            : available,
        );
        const params = new URLSearchParams(window.location.search);
        const requested = params.get("floor");
        const selected = resolveFloor(available, pointId, requested);
        setSelectedId(selected ?? "");
        const image = resolveFloorImage(
          available.find((f) => f.id === selected)?.images ?? [],
          selected === requested ? params.get("floor_section") : null,
        );
        const section = image?.section ?? "main";
        setSelectedSection(section);
        if (!selected) setExpanded(false);
        window.history.replaceState(
          window.history.state,
          "",
          floorLocation(window.location.href, pointId, selected, section),
        );
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && !disposed) setStatus("error");
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
  }, [expanded]);

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
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, pointId, id, section),
    );
  }
  function selectSection(section: string) {
    if (!labeled.some((image) => (image.section ?? "main") === section)) return;
    setSelectedSection(section);
    window.history.replaceState(
      window.history.state,
      "",
      floorLocation(window.location.href, pointId, selectedId, section),
    );
  }
  function close() {
    setExpanded(false);
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
      ) : !floor ? (
        <div className="floor-placeholder">
          <span className="floor-icon">
            <Icon name="layers" size={26} />
          </span>
          <h3>暂无已发布楼层</h3>
          <p>{pointName}的楼层资料补充后会显示在这里。</p>
        </div>
      ) : (
        <>
          <div className="floor-panel-heading">
            <strong>楼层平面图</strong>
            <span>{floors.length}个楼层</span>
          </div>
          {selectors("preview")}
          {asset ? (
            <FloorViewer
              key={`${floor.id}-${floor.revision}-${asset.section ?? "main"}`}
              asset={asset}
              title={title}
            />
          ) : (
            <p>这张图暂未提供</p>
          )}
          <button
            className="floor-expand"
            ref={openButton}
            onClick={() => {
              selectFloor(selectedId);
              setExpanded(true);
            }}
          >
            <Icon name="focus" size={17} />
            展开查看
          </button>
          <p className="floor-note">可拖动、双指缩放查看。图中标注供查阅。</p>
          <dialog
            className="floor-dialog"
            aria-labelledby="floor-dialog-title"
            ref={dialog}
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
            onClose={() => setExpanded(false)}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <header className="floor-dialog-header">
              <div>
                <span>FLOOR PLAN</span>
                <h2 id="floor-dialog-title">{pointName}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭楼层大图"
                onClick={close}
              >
                <Icon name="close" />
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
