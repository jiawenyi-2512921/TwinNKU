import { useEffect, useState } from "react";
import { api, type Point } from "../../shared/api/client";

export function PointBrowser({ campusId }: { campusId: string }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [points, setPoints] = useState<Point[]>([]);
  const [selected, setSelected] = useState<Point | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSelected(null);
    api
      .points(campusId, query, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPoints(result.data);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : "暂时无法加载");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [campusId, query, retry]);

  return (
    <section className="explore" id="explore" aria-labelledby="explore-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">EXPLORE THE CAMPUS</span>
          <h2 id="explore-title">从一个地方，走近南开。</h2>
        </div>
        <span className="small-note">津南校区</span>
      </div>
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
        <label className="sr-only" htmlFor="point-search">
          搜索校园点位
        </label>
        <input
          id="point-search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="搜索建筑、景观或校园故事"
          maxLength={120}
        />
        <button type="submit">
          搜索 <span aria-hidden="true">↗</span>
        </button>
      </form>
      <div className="catalog" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="empty">
            <div className="spinner" />
            <p>正在载入校园资料…</p>
          </div>
        ) : error ? (
          <div className="empty">
            <h3>暂时无法加载</h3>
            <p>{error}</p>
            <button
              className="text-button"
              onClick={() => setRetry((n) => n + 1)}
            >
              重新加载
            </button>
          </div>
        ) : points.length === 0 ? (
          <div className="empty">
            <div className="empty-symbol" aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <path d="M8 38V17l16-9 16 9v21M5 39h38M17 38V23h14v15M14 17h20M24 8V3" />
                <path d="M21 29h6" />
              </svg>
            </div>
            <span className="eyebrow">A NEW JOURNEY IS TAKING SHAPE</span>
            <h3>{query ? "还没有找到这个点位" : "校园的故事，正在整理中"}</h3>
            <p>
              {query
                ? "试试其他关键词，或查看全部已发布点位。"
                : "我们正在核对点位资料与讲解内容。审核完成后，你可以从这里开始参观。"}
            </p>
            {query && (
              <button
                className="text-button"
                onClick={() => {
                  setQuery("");
                  setDraft("");
                }}
              >
                查看全部点位
              </button>
            )}
          </div>
        ) : (
          <div className="point-grid">
            {points.map((point) => (
              <button
                className="point-card"
                key={point.id}
                onClick={() => setSelected(point)}
                aria-expanded={selected?.id === point.id}
              >
                <span className="point-dot" />
                <h3>{point.name}</h3>
                <p>{point.summary || "查看点位资料"}</p>
                <span className="card-link">了解这里 ↗</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <aside className="point-detail" aria-label="点位详情">
          <button
            className="close-detail"
            aria-label="关闭点位详情"
            onClick={() => setSelected(null)}
          >
            ×
          </button>
          <span className="eyebrow">CAMPUS STORY</span>
          <h3>{selected.name}</h3>
          <p>{selected.summary || "详细介绍正在整理。"}</p>
        </aside>
      )}
    </section>
  );
}
