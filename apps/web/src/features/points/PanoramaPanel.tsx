import { useEffect, useState } from "react";
import { api, type Panorama } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";

export function PanoramaPanel({ pointId }: { pointId: string }) {
  const requested = new URLSearchParams(window.location.search).get("panorama");
  const [items, setItems] = useState<Panorama[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (
      status === "ready" &&
      requested &&
      items.some((item) => item.id === requested)
    )
      document
        .getElementById(`panorama-${requested}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [status, requested, items]);
  useEffect(() => {
    let pending: AbortController | null = null;
    let disposed = false;
    setItems([]);
    setStatus("loading");
    async function refresh() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const { data } = await api.panoramas(pointId, controller.signal);
        if (controller.signal.aborted || disposed) return;
        setItems(data.filter((item) => item.point_id === pointId));
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && !disposed) {
          setItems([]);
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
  if (status === "loading")
    return (
      <p className="content-status" role="status">
        正在读取全景资料…
      </p>
    );
  if (status === "error")
    return (
      <div className="panorama-error" role="alert">
        全景资料暂时无法读取。
        <button onClick={() => setRetry((n) => n + 1)}>重试</button>
      </div>
    );
  if (!items.length)
    return requested ? (
      <p className="content-status">
        该全景目前未公开或已下架，可以继续查看地点介绍。
      </p>
    ) : null;
  return (
    <section className="panorama-panel" aria-label="VR 全景">
      <h3>VR 全景</h3>
      {requested && !items.some((item) => item.id === requested) && (
        <p className="content-status">
          指定的全景目前不可用，以下是该地点现有的公开全景。
        </p>
      )}
      {items.map((item) => (
        <article
          id={`panorama-${item.id}`}
          className={`panorama-card${item.id === requested ? " is-target" : ""}`}
          key={item.id}
        >
          <strong>{item.title}</strong>
          {item.description && <p>{item.description}</p>}
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <Icon name="arrow" size={17} />
            进入全景
            <small>新窗口打开 · {new URL(item.url).hostname}</small>
          </a>
        </article>
      ))}
    </section>
  );
}
