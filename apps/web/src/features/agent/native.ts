import type { components } from "../../shared/api/schema";
import { withRequestDeadline } from "../../shared/requestDeadline.ts";
export type GuideAction = components["schemas"]["GuideAction"];
export type GuideContext = components["schemas"]["GuideContext"];
export type GuideReply = components["schemas"]["GuideReply"];
export type NavigationPath = components["schemas"]["NavigationPath"];
export type NavigationAvailability =
  components["schemas"]["NavigationAvailability"];
export type GuideActionOptions = { requestedPlayback?: boolean };
export type ActionReceipt = {
  action_id: string;
  context_revision: number;
  resource_id?: string | null;
  resource_revision?: number | null;
  result:
    | "opened"
    | "playing"
    | "paused"
    | "ended"
    | "blocked"
    | "failed"
    | "cancelled"
    | "external_requested";
};

const ERROR_CODES = new Set([
  "AGENT_CONVERSATION_TIMEOUT",
  "AGENT_REPLY_TIMEOUT",
  "AGENT_UPSTREAM_CONNECTION_FAILED",
  "AGENT_UPSTREAM_UNAVAILABLE",
  "AGENT_PROXY_TIMEOUT",
  "AGENT_CLIENT_TIMEOUT",
  "REQUEST_CANCELLED",
  "INVALID_RESPONSE",
  "NETWORK_ERROR",
  "LOGIN_FAILED",
  "LOGIN_REQUIRED",
  "RATE_LIMITED",
  "REQUEST_IN_PROGRESS",
  "REQUEST_ID_REUSED",
  "RESULT_UNKNOWN",
  "SESSION_FULL",
  "SERVICE_BUSY",
  "AGENT_DISABLED",
  "CSRF_INVALID",
  "ORIGIN_DENIED",
  "MAP_UNAVAILABLE",
  "STALE_CONTEXT",
  "EMPTY_QUERY",
  "ACTION_AMBIGUOUS",
  "ACTION_DISABLED",
  "ACTION_UNAVAILABLE",
  "STALE_ACTION",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "HTTP_ERROR",
  "PUBLIC_AGENT_DISABLED",
  "PUBLIC_SESSION_UNAVAILABLE",
  "PUBLIC_BUDGET_REACHED",
  "PUBLIC_BUDGET_UNAVAILABLE",
  "CAPABILITY_INVALID",
  "ACTION_SCOPE_INVALID",
  "RECEIPT_INVALID",
  "CONTEXT_TOO_LARGE",
  "VOICE_SOURCE_STALE",
  "VOICE_SOURCE_DENIED",
]);
function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}
export class NativeError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  constructor(
    message: string,
    status: number,
    diagnostic: { code?: unknown; requestId?: unknown } = {},
  ) {
    super(message);
    this.status = status;
    this.code =
      typeof diagnostic.code === "string" && ERROR_CODES.has(diagnostic.code)
        ? diagnostic.code
        : undefined;
    this.requestId = safeRequestId(diagnostic.requestId);
  }
}
export async function post<T>(
  path: string,
  body: unknown,
  csrf = "",
  signal?: AbortSignal,
): Promise<T> {
  let requestId: string | undefined;
  try {
    return await withRequestDeadline(
      async (requestSignal) => {
        const response = await fetch(`/api/v1${path}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        requestId = safeRequestId(response.headers.get("X-Request-ID"));
        const result = await response.json().catch(() => null);
        requestId = safeRequestId(result?.meta?.request_id) || requestId;
        if (!response.ok) {
          const proxyTimeout = response.status === 504 && !result?.error;
          throw new NativeError(
            typeof result?.error?.message === "string" && result.error.message
              ? result.error.message
              : proxyTimeout
                ? "网站代理等待超时，处理结果未确认，请勿立即重复发送。"
                : `服务暂不可用（${response.status}）`,
            response.status,
            {
              code: proxyTimeout
                ? "AGENT_PROXY_TIMEOUT"
                : result?.error?.code || "HTTP_ERROR",
              requestId,
            },
          );
        }
        if (!result?.data || !safeRequestId(result.meta?.request_id))
          throw new NativeError("服务返回格式异常", response.status, {
            code: "INVALID_RESPONSE",
            requestId,
          });
        return result.data;
      },
      signal,
      105_000,
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new NativeError(
        "网页等待请求已超时，处理结果未确认，请勿立即重复发送。",
        408,
        { code: "AGENT_CLIENT_TIMEOUT", requestId },
      );
    if (e instanceof DOMException && e.name === "AbortError")
      throw new NativeError(
        "请求已在网页取消，后台可能仍在处理；结果未确认，请勿立即重复发送。",
        0,
        { code: "REQUEST_CANCELLED", requestId },
      );
    if (e instanceof TypeError)
      throw new NativeError(
        "网页未能连接本站服务，处理结果未确认，请检查网络后再试。",
        0,
        { code: "NETWORK_ERROR", requestId },
      );
    throw e;
  }
}

// Build internal destinations from verified IDs; never execute a model-provided URL.
export function actionLocation(href: string, a: GuideAction): string {
  const url = new URL(href);
  for (const key of ["floor", "floor_section", "panorama"])
    url.searchParams.delete(key);
  url.searchParams.set("point", a.point_id);
  if (a.type === "show_floor" && a.resource_id) {
    url.searchParams.set("floor", a.resource_id);
    if (a.section) url.searchParams.set("floor_section", a.section);
  }
  if (a.type === "open_vr" && a.resource_id)
    url.searchParams.set("panorama", a.resource_id);
  return url.href;
}

export function canAutoApply(
  a: GuideAction,
  sent: number,
  current: number,
  automaticActionId?: string | null,
): boolean {
  return (
    Boolean(automaticActionId) &&
    a.action_id === automaticActionId &&
    sent === current &&
    a.context_revision === sent &&
    [
      "focus_point",
      "show_floor",
      "show_route",
      "show_checkin",
      "show_tour",
      "open_vr",
      "play_video",
    ].includes(a.type)
  );
}
