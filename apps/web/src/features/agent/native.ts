import type { components } from "../../shared/api/schema";
export type GuideAction = components["schemas"]["GuideAction"];
export type GuideContext = components["schemas"]["GuideContext"];
export type GuideReply = components["schemas"]["GuideReply"];
export type NavigationPath = components["schemas"]["NavigationPath"];
export type NavigationAvailability =
  components["schemas"]["NavigationAvailability"];
export type GuideActionOptions = { requestedPlayback?: boolean };

export class NativeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function post<T>(
  path: string,
  body: unknown,
  csrf = "",
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 105_000);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new NativeError(
        result?.error?.message || `服务暂不可用（${response.status}）`,
        response.status,
      );
    if (!result?.data || !result.meta?.request_id)
      throw new Error("服务返回格式异常");
    return result.data;
  } catch (e) {
    if (controller.signal.aborted)
      throw new Error("请求等待已结束，未能确认回答结果，请勿立即重复发送。");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
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
