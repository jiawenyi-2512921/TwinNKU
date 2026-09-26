import {
  FRAME_CHANNEL,
  SDK_ORIGIN,
  SDK_URL,
  safeContext,
  type FrameStatus,
} from "./protocol";
import "./embed.css";

type WebClientOptions = {
  appKey: string;
  baseUrl: string;
  hideSidebar: boolean;
  variables: Record<string, string>;
};
// Only embedFull.js / WebClient and these four fields were supplied by the
// platform. A differently named constructor is not a verified fallback.
type WebClientConstructor = new (options: WebClientOptions) => unknown;
declare global {
  interface Window {
    HiagentWebSDK?: { WebClient?: WebClientConstructor };
  }
}

const instance =
  new URLSearchParams(window.location.hash.slice(1)).get("instance") ?? "";
const standalone = window.parent === window;
let started = false;
const status = document.getElementById("agent-frame-status");

function report(type: FrameStatus, code?: string) {
  if (!standalone)
    window.parent.postMessage(
      { channel: FRAME_CHANNEL, instance, type, code },
      window.location.origin,
    );
}
function fail(code: string) {
  if (status) {
    status.hidden = false;
    status.textContent = "校园对话暂时无法加载，请使用上方的重新加载按钮。";
  }
  report("error", code);
}

async function initialize(context: unknown) {
  report("loading");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("/api/v1/agent/web-config", {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
    const { data } = await response.json();
    if (!data?.enabled) throw new Error("DISABLED");
    if (
      data.base_url !== SDK_ORIGIN ||
      data.sdk_url !== SDK_URL ||
      typeof data.app_key !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(data.app_key)
    )
      throw new Error("INVALID_CONFIG");
    window.clearTimeout(timeout);
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => {
        script.remove();
        reject(new Error("SDK_TIMEOUT"));
      }, 20000);
      script.src = SDK_URL;
      script.async = true;
      script.referrerPolicy = "strict-origin-when-cross-origin";
      script.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error("SDK_UNAVAILABLE"));
      };
      document.body.append(script);
    });
    const Client = window.HiagentWebSDK?.WebClient;
    if (typeof Client !== "function") throw new Error("SDK_INCOMPATIBLE");
    const appKey = data.app_key;
    const variables =
      data.context_enabled === true ? { ...safeContext(context) } : {};
    new Client({
      appKey,
      baseUrl: SDK_ORIGIN,
      hideSidebar: data.hide_sidebar === true,
      variables,
    });
    if (status) status.hidden = true;
    // Initialization is NOT proof of login, model availability or a successful answer.
    report("initialized");
  } catch (error) {
    const allowed = [
      "CONFIG_UNAVAILABLE",
      "DISABLED",
      "INVALID_CONFIG",
      "SDK_TIMEOUT",
      "SDK_UNAVAILABLE",
      "SDK_INCOMPATIBLE",
    ];
    fail(
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "CONNECTION_FAILED",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

window.addEventListener("message", (event) => {
  if (
    started ||
    event.source !== window.parent ||
    event.origin !== window.location.origin ||
    event.data?.channel !== FRAME_CHANNEL ||
    event.data?.instance !== instance ||
    event.data?.type !== "initialize"
  )
    return;
  started = true;
  void initialize(event.data.context);
});

if (standalone) {
  if (status)
    status.textContent = "请从 Twin NKU 校园地图的“小开”入口打开对话。";
} else {
  report("booted");
}
