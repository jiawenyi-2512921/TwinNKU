import { useEffect, useState } from "react";
import { api } from "../api/client";
import { watchCatalogChanges } from "../catalogSync";
import "./environment.css";

export function EnvironmentBanner() {
  const [environment, setEnvironment] = useState<
    "standard" | "practice" | "unknown"
  >("unknown");
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let pending: AbortController | null = null;
    const read = async () => {
      pending?.abort();
      pending = new AbortController();
      const signal = pending.signal;
      try {
        const result = (await api.status(signal)).data;
        if (!["standard", "practice"].includes(result.environment))
          throw new Error("Unknown environment");
        if (!disposed && !signal.aborted) {
          setEnvironment(result.environment);
          setFailed(false);
        }
      } catch {
        if (!disposed && !signal.aborted) {
          setEnvironment((previous) =>
            previous === "practice" ? previous : "unknown",
          );
          setFailed(true);
        }
      }
    };
    void read();
    const unsubscribe = watchCatalogChanges(read);
    return () => {
      disposed = true;
      pending?.abort();
      unsubscribe();
    };
  }, [retry]);
  if (environment === "standard" && !failed) return null;
  return (
    <aside
      className={`environment-banner ${environment === "practice" ? "is-practice" : "is-unknown"}`}
      role="status"
      aria-label="网站环境"
    >
      <span>
        {environment === "practice"
          ? "独立练习环境 · 练习内容不会发布到正式网站，真实供应商调用已关闭。"
          : failed
            ? "暂时无法确认网站环境，请重新确认。"
            : "正在确认网站环境…"}
      </span>
      {failed && (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetry((value) => value + 1);
          }}
        >
          重新确认环境
        </button>
      )}
    </aside>
  );
}
