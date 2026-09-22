import type { components } from "./schema";

export type Campus = components["schemas"]["Campus"];
export type Point = components["schemas"]["Point"];
export type SystemStatus = components["schemas"]["SystemStatus"];
type Meta = components["schemas"]["Meta"];

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

export async function get<T>(
  path: string,
  signal?: AbortSignal,
): Promise<{ data: T; meta: Meta }> {
  const response = await fetch(`/api/v1${path}`, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, "暂时无法读取导览内容，请稍后重试。");
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.message || "服务暂不可用，请稍后重试。",
      payload?.meta?.request_id,
    );
  }
  if (!payload || !("data" in payload) || !payload.meta?.request_id) {
    throw new ApiError(response.status, "导览内容暂时无法显示，请稍后重试。");
  }
  return payload;
}

export const api = {
  status: (signal?: AbortSignal) => get<SystemStatus>("/system/status", signal),
  campuses: (signal?: AbortSignal) => get<Campus[]>("/campuses", signal),
  points: (campus: string, query: string, signal?: AbortSignal) =>
    get<Point[]>(
      `/campuses/${encodeURIComponent(campus)}/points?${new URLSearchParams({ q: query, page_size: "100" })}`,
      signal,
    ),
};
