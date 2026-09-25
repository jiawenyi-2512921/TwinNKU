import { useEffect, useState } from "react";
import { api, type AgentWebConfig } from "../../shared/api/client";

export function useAgentConfig() {
  const [config, setConfig] = useState<AgentWebConfig | null>(null);
  useEffect(() => {
    let pending: AbortController | null = null;
    let disposed = false;
    async function refresh() {
      if (document.visibilityState === "hidden") return;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const timer = window.setTimeout(() => controller.abort(), 10000);
      try {
        const result = await api.agentConfig(controller.signal);
        if (!disposed && !controller.signal.aborted)
          setConfig((before) =>
            JSON.stringify(before) === JSON.stringify(result.data)
              ? before
              : result.data,
          );
      } catch {
        // An unavailable optional feature must not prevent the map from loading.
        // Once configured, an existing conversation survives a transient read failure.
      } finally {
        window.clearTimeout(timer);
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return config;
}
