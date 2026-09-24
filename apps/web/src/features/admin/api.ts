import type { components } from "../../shared/api/schema";
import { ApiError } from "../../shared/api/client";
export type StaffSession = components["schemas"]["StaffSession"];
export type StaffUser = components["schemas"]["StaffUser"];
export type AdminPoint = components["schemas"]["AdminPoint"];
export type AdminMapPoint = components["schemas"]["AdminMapPoint"];
export type PointInput = components["schemas"]["PointDraftInput"];
export type GeometryInput = components["schemas"]["PointLocationInput"];
export type AuditEvent = components["schemas"]["AuditEvent"];
export type Page = { page: number; page_size: number; total: number };
export type Result<T> = {
  data: T;
  meta: { request_id: string; pagination?: Page | null };
};
let csrf = "";
export function rememberSession(session: StaffSession | null) {
  csrf = session?.csrf_token ?? "";
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Result<T>> {
  const binary = body instanceof Blob;
  const response = await fetch(`/api/v1/admin${path}`, {
    method,
    signal,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body === undefined
        ? {}
        : { "Content-Type": binary ? body.type : "application/json" }),
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("staff-session-expired"));
    throw new ApiError(
      response.status,
      result?.error?.message || "暂时无法连接后台，请稍后重试",
      result?.meta?.request_id,
    );
  }
  if (!result || !("data" in result))
    throw new Error("后台响应格式异常，请刷新重试");
  return result;
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
export const roleNames: Record<StaffUser["role"], string> = {
  admin: "管理员",
  reviewer: "审核员",
  editor: "编辑员",
  viewer: "只读成员",
};
export const stateNames: Record<string, string> = {
  draft: "草稿",
  in_review: "待审核",
  rejected: "已退回",
  published: "已发布",
  discarded: "已撤回",
  retired: "已下架",
};
export const categories: Record<PointInput["category"], string> = {
  public_area: "公共区域",
  patriotic: "爱国主义点位",
  academic: "教学科研",
  residence: "宿舍",
  dining: "食堂",
  commerce: "商区",
  landscape: "自然景观",
  history: "校史文化",
};
export function activeDraft(point: AdminPoint) {
  return (
    !!point.draft &&
    ["draft", "in_review", "rejected"].includes(point.draft.state)
  );
}
