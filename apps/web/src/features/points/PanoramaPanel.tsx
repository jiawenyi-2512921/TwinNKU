import { useEffect, useState } from "react";
import { api, type Panorama } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { LOCATION_CHANGE_EVENT } from "../../shared/navigation";
import { externalPanoramaUrl, requestedPanorama } from "./panorama";
import "./panorama.css";

export function PanoramaPanel({ pointId }: { pointId: string }) {
  const [items, setItems] = useState<Panorama[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const [requested, setRequested] = useState(() =>
    requestedPanorama(window.location.href, pointId),
  );
  useEffect(() => {
    const synchronize = () =>
      setRequested(requestedPanorama(window.location.href, pointId));
    synchronize();
    window.addEventListener("popstate", synchronize);
    window.addEventListener(LOCATION_CHANGE_EVENT, synchronize);
    return () => {
      window.removeEventListener("popstate", synchronize);
      window.removeEventListener(LOCATION_CHANGE_EVENT, synchronize);
    };
  }, [pointId]);
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
        const next = data.filter((item) => item.point_id === pointId);
        setItems((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted && !disposed) {
          setItems([]);
          setStatus("error");
        }
      }
    }
    void refresh();
    const stopWatching = watchCatalogChanges(() => void refresh());
    return () => {
      disposed = true;
      pending?.abort();
      stopWatching();
    };
  }, [pointId, retry]);
  const active =
    status === "ready"
      ? items.find((item) => item.id === requested && item.point_id === pointId)
      : undefined;
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
      {requested && !active && (
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
          {externalPanoramaUrl(item.url) ? (
            <a
              className="panorama-open"
              href={externalPanoramaUrl(item.url)!}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="arrow" size={17} />
              在原网站打开 VR
              <small>新标签页打开，返回后继续校园导览</small>
            </a>
          ) : (
            <p className="content-status">全景链接暂不可用。</p>
          )}
        </article>
      ))}
    </section>
  );
}
