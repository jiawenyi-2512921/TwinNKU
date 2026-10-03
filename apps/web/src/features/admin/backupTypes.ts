import type { components } from "../../shared/api/schema";

export type BackupJob = components["schemas"]["BackupJob"];
export type BackupJobPage = components["schemas"]["BackupJobPage"];
export type BackupStatus = components["schemas"]["BackupStatus"];
export type BackupCapabilities = components["schemas"]["BackupCapabilities"];
export type BackupGrants = components["schemas"]["BackupGrants"];
export type BackupPermission = "backup.read" | "backup.request";
export type PendingBackup = {
  owner: string;
  operationId: string;
  reason: string;
  jobId?: string;
};

export const backupStateNames: Record<BackupJob["state"], string> = {
  queued: "待维护执行器核验",
  running: "正在备份",
  succeeded: "备份与完整性检查通过",
  failed: "本次备份失败",
  unknown: "执行结果未知，须维护人员核对",
  cancelled: "已取消",
  expired: "授权过期或被撤销，请重新申请",
};
export const backupPhaseNames: Record<BackupJob["phase"], string> = {
  queued: "等待执行",
  preflight: "容量与配置预检",
  dump: "导出数据库与核对原件",
  encrypt: "加密备份",
  retention: "整理保留版本",
  integrity: "检查仓库完整性",
  complete: "完成",
};

export const backupFailureNames: Record<string, string> = {
  RESTORED_REQUIRES_REVIEW:
    "本任务随隔离恢复被停止，原授权已失效；不会重放。需本人重新验证并在额度许可后申请。",
  AUTHORIZATION_EXPIRED: "排队期间近期验证过期，请重新验证并在额度许可后申请。",
  AUTHORIZATION_REVOKED: "账号、权限或会话授权已失效，本次执行已停止。",
  HOST_RATE_LIMITED: "主机维护额度已达到上限，请稍后申请。",
  EXECUTION_RESULT_UNKNOWN:
    "执行结果不能确认，不会自动重试；请维护人员核对真实回执。",
};
