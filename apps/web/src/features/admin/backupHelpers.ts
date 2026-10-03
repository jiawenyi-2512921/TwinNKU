import type { BackupJob, PendingBackup } from "./backupTypes";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = (owner: string) => `twinnku-backup-operation:${owner}`;

export function loadPendingBackup(owner: string): PendingBackup | null {
  try {
    const row = JSON.parse(sessionStorage.getItem(key(owner)) || "null");
    if (
      !row ||
      row.owner !== owner ||
      !uuid.test(row.operationId) ||
      typeof row.reason !== "string" ||
      row.reason.length < 5 ||
      row.reason.length > 500 ||
      (row.jobId && !uuid.test(row.jobId))
    )
      return null;
    return {
      owner,
      operationId: row.operationId,
      reason: row.reason,
      ...(row.jobId ? { jobId: row.jobId } : {}),
    };
  } catch {
    return null;
  }
}

export function storePendingBackup(owner: string, value: PendingBackup | null) {
  try {
    if (value) sessionStorage.setItem(key(owner), JSON.stringify(value));
    else sessionStorage.removeItem(key(owner));
  } catch {
    /* The mounted component still retains an unconfirmed operation. */
  }
}

export function backupOperationConfirmed(
  pending: PendingBackup,
  row: BackupJob,
) {
  return (
    row.user_id === pending.owner &&
    (pending.jobId
      ? row.id === pending.jobId &&
        row.cancel_requested &&
        row.cancel_operation_id === pending.operationId
      : row.operation_id === pending.operationId &&
        row.reason === pending.reason)
  );
}

export function backupCanCancel(row: BackupJob, owner: string) {
  return (
    row.user_id === owner &&
    !row.cancel_requested &&
    ["queued", "running", "unknown"].includes(row.state)
  );
}

export function backupBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "尚未核验";
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
