import { useEffect, useState } from "react";
import { message, request, type Page, type Result } from "./api";
export function useResource<T>(path: string | null, revision = 0) {
  const [data, setData] = useState<Result<T> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null);
    setError("");
    if (!path) return;
    const abort = new AbortController();
    setLoading(true);
    request<T>(path, "GET", undefined, abort.signal)
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, revision]);
  return { data, error, loading };
}
export function ErrorBox({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  return text ? (
    <div className="ad-error" role="alert">
      {text}
      {onRetry && <button onClick={onRetry}>重新加载</button>}
    </div>
  ) : null;
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="ad-empty">
      <span aria-hidden="true">◇</span>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
    </div>
  );
}
export function Pager({
  page,
  onChange,
}: {
  page: Page | null | undefined;
  onChange: (page: number) => void;
}) {
  if (!page) return null;
  return (
    <div className="ad-pager">
      <span>
        共 {page.total} 项 · 第 {page.page} /{" "}
        {Math.max(1, Math.ceil(page.total / page.page_size))} 页
      </span>
      <button disabled={page.page <= 1} onClick={() => onChange(page.page - 1)}>
        上一页
      </button>
      <button
        disabled={page.page * page.page_size >= page.total}
        onClick={() => onChange(page.page + 1)}
      >
        下一页
      </button>
    </div>
  );
}
export function timestamp(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
