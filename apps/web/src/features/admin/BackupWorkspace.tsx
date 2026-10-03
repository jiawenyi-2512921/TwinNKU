import { useEffect, useRef, useState } from "react";
import { message, request, type StaffSession, type StaffUser } from "./api";
import { ErrorBox } from "./ui";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import {
  backupBytes,
  backupCanCancel,
  backupOperationConfirmed,
  loadPendingBackup,
  storePendingBackup,
} from "./backupHelpers";
import {
  backupFailureNames,
  backupPhaseNames,
  backupStateNames,
  type BackupCapabilities,
  type BackupGrants,
  type BackupJob,
  type BackupJobPage,
  type BackupPermission,
  type BackupStatus,
  type PendingBackup,
} from "./backupTypes";
import "./configuration.css";

const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚未核验";
const terminal = (row: BackupJob) =>
  ["succeeded", "failed", "cancelled", "expired"].includes(row.state);

export function BackupWorkspace({ session }: { session: StaffSession }) {
  const owner = session.user.id;
  const canRead = session.permissions.includes("backup.read");
  const canRequest = session.permissions.includes("backup.request");
  const canManage = session.permissions.includes("users.manage");
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [capabilities, setCapabilities] = useState<BackupCapabilities | null>(
    null,
  );
  const [jobs, setJobs] = useState<BackupJobPage | null>(null);
  const [page, setPage] = useState(1);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<PendingBackup | null>(() =>
    loadPendingBackup(owner),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [polling, setPolling] = useState(true);
  const epoch = useRef(0);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;

  useEffect(() => {
    epoch.current++;
    setStatus(null);
    setCapabilities(null);
    setJobs(null);
    setPage(1);
    setPending(loadPendingBackup(owner));
    setReason("");
    setError("");
    setNotice("");
    setBusy(false);
    setPolling(true);
    return () => {
      epoch.current++;
    };
  }, [owner]);

  useEffect(() => {
    if (!(canRead || canRequest)) return;
    const controller = new AbortController();
    const token = epoch.current;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const caps = await request<BackupCapabilities>(
          "/backup-capabilities",
          "GET",
          undefined,
          controller.signal,
        );
        const list = await request<BackupJobPage>(
          `/backup-jobs?page=${page}&page_size=20`,
          "GET",
          undefined,
          controller.signal,
        );
        const state = canRead
          ? await request<BackupStatus>(
              "/backup-status",
              "GET",
              undefined,
              controller.signal,
            )
          : null;
        if (
          controller.signal.aborted ||
          token !== epoch.current ||
          currentOwner.current !== owner
        )
          return;
        setCapabilities(caps.data);
        setJobs(list.data);
        setStatus(state?.data ?? null);
        setError("");
        const active = list.data.items.some((row) => !terminal(row));
        if (polling && active && polls++ < 80) timer = setTimeout(load, 15_000);
        else if (polls >= 80) setPolling(false);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          token === epoch.current &&
          currentOwner.current === owner
        )
          setError(message(error));
      }
    }
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [owner, canRead, canRequest, page, revision, polling]);

  function remember(value: PendingBackup | null) {
    setPending(value);
    storePendingBackup(owner, value);
  }
  async function recover(value: PendingBackup) {
    const result = await request<BackupJob>(
      value.jobId
        ? `/backup-jobs/${value.jobId}`
        : `/backup-jobs/operations/${value.operationId}`,
    );
    return backupOperationConfirmed(value, result.data) ? result.data : null;
  }
  async function perform(value: PendingBackup, queryOnly = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const token = epoch.current;
    const stillCurrent = () =>
      token === epoch.current && currentOwner.current === value.owner;
    try {
      const result = queryOnly
        ? await recover(value)
        : await confirmedOperation(
            value.operationId,
            async () => {
              const response = value.jobId
                ? await request<BackupJob>(
                    `/backup-jobs/${value.jobId}/cancel`,
                    "POST",
                    { operation_id: value.operationId },
                  )
                : await request<BackupJob>("/backup-jobs", "POST", {
                    operation_id: value.operationId,
                    reason: value.reason,
                  });
              if (!backupOperationConfirmed(value, response.data))
                throw new UnconfirmedOperation(value.operationId);
              return response.data;
            },
            () => recover(value),
          );
      if (!stillCurrent()) return;
      if (!result) throw new UnconfirmedOperation(value.operationId);
      remember(null);
      setReason("");
      setPage(1);
      setPolling(true);
      setRevision((v) => v + 1);
      setNotice(
        value.jobId
          ? "取消申请已记录。请以执行器确认后的任务状态为准。"
          : "申请已记录；执行器会再次核验授权和容量，再开始备份。",
      );
    } catch (error) {
      if (!stillCurrent()) return;
      if (
        !(error instanceof UnconfirmedOperation) &&
        !queryOnly &&
        (error as { status?: number }).status &&
        (error as { status: number }).status >= 400 &&
        (error as { status: number }).status < 500 &&
        (error as { status: number }).status !== 408
      )
        remember(null);
      setError(
        queryOnly
          ? "本次结果尚未确认，请保留原编号继续查询；不要新建重复申请。"
          : message(error),
      );
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  function submit() {
    if (
      !canRequest ||
      pending ||
      !capabilities?.requests_enabled ||
      !capabilities.executor_available
    )
      return;
    const text = reason.trim();
    if (text.length < 5) {
      setError("请填写至少5字的备份原因。");
      return;
    }
    const value = { owner, reason: text, operationId: crypto.randomUUID() };
    remember(value);
    void perform(value);
  }
  function cancel(row: BackupJob) {
    if (!canRequest || pending || !backupCanCancel(row, owner)) return;
    const value = {
      owner,
      reason: row.reason,
      jobId: row.id,
      operationId: crypto.randomUUID(),
    };
    remember(value);
    void perform(value);
  }

  return (
    <section className="ad-config-workspace">
      <header>
        <div className="ad-eyebrow">BACKUP & RECOVERY EVIDENCE</div>
        <h2>备份与恢复记录</h2>
        <p>
          将数据库、地图、上传原件和部署配置一并加密保存在服务器。备份成功与恢复演练通过分别记录；同机损毁仍需要另外保留可恢复副本。
        </p>
      </header>
      <ErrorBox text={error} />
      <p role="status">{notice}</p>
      {(canRead || canRequest) && (
        <button
          disabled={busy}
          onClick={() => {
            setPolling(true);
            setRevision((v) => v + 1);
          }}
        >
          刷新状态
        </button>
      )}
      {canRead && status && (
        <div className="ad-card">
          <h3>最近核验结果</h3>
          <dl>
            <dt>最近成功备份</dt>
            <dd>{when(status.summary.last_success_at)}</dd>
            <dt>仓库大小</dt>
            <dd>{backupBytes(status.summary.repository_bytes)}</dd>
            <dt>可用空间 / 预留空间</dt>
            <dd>
              {backupBytes(status.summary.free_bytes)} /{" "}
              {backupBytes(status.summary.reserve_bytes)}
            </dd>
            <dt>恢复演练</dt>
            <dd>
              {status.summary.restore_status === "passed"
                ? `已核验 ${when(status.summary.restore_verified_at)}`
                : status.summary.restore_status === "failed"
                  ? "未通过，请联系维护人员"
                  : "未知，尚无可核验的固定恢复回执"}
            </dd>
            <dt>执行器</dt>
            <dd>
              {status.executor_available ? "最近在线" : "离线或状态过期"} ·
              观察时间 {when(status.observed_at)}
            </dd>
          </dl>
          <p>
            当前备份状态：
            {status.summary.status === "success"
              ? "最近备份通过"
              : status.summary.status === "failed"
                ? "最近尝试失败，先前成功版本仍保留"
                : "尚未核验"}
          </p>
          <details>
            <summary>可恢复版本（最多20条）</summary>
            {(status.summary.snapshots ?? []).length ? (
              <ul>
                {status.summary.snapshots?.map((row) => (
                  <li key={row.id}>
                    {when(row.created_at)} · {row.id.slice(0, 12)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>尚未读取到可核验的版本。</p>
            )}
          </details>
        </div>
      )}
      {canRequest && (
        <div className="ad-card">
          <h3>申请完整备份</h3>
          <p>
            需要已绑定认证器和5分钟内验证。每人每天最多{" "}
            {capabilities?.staff_requests_per_day ?? 2} 次，全站每天最多{" "}
            {capabilities?.global_requests_per_day ?? 6} 次，相隔至少{" "}
            {Math.ceil((capabilities?.min_interval_seconds ?? 3600) / 3600)}{" "}
            小时。权限或容量不足时不会执行。
          </p>
          {!session.mfa_enrolled && (
            <p>请先在“账号安全”完成认证器绑定；后台申请不会绕过近期验证。</p>
          )}
          {capabilities && !capabilities.requests_enabled && (
            <p>
              维护人员尚未开启后台申请。定时备份的实际状态请查看上述核验结果。
            </p>
          )}
          {capabilities && !capabilities.executor_available && (
            <p>执行器暂时不可用，请联系维护人员。</p>
          )}
          <label>
            备份原因
            <textarea
              maxLength={500}
              value={reason}
              disabled={busy || !!pending}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：内容批量调整前保留可恢复版本"
            />
          </label>
          <button
            className="ad-primary"
            disabled={
              busy ||
              !!pending ||
              !session.mfa_enrolled ||
              !capabilities?.requests_enabled ||
              !capabilities.executor_available
            }
            onClick={submit}
          >
            申请备份
          </button>
        </div>
      )}
      {pending && (
        <div className="ad-card" role="status">
          <h3>本次结果待核对</h3>
          <p>操作编号：{pending.operationId}</p>
          <p>保留原申请内容和编号；查询不会再次执行备份。</p>
          <button disabled={busy} onClick={() => void perform(pending, true)}>
            核对本次结果
          </button>
          <button disabled={busy} onClick={() => void perform(pending)}>
            用原编号重新申请{pending.jobId ? "取消" : ""}
          </button>
        </div>
      )}
      {jobs && (
        <div className="ad-card">
          <h3>{canRead ? "备份申请记录" : "我的备份申请"}</h3>
          {!polling && (
            <p>自动查询已停止，点击刷新继续。查询不会延长登录会话。</p>
          )}
          {jobs.items.length ? (
            <ul>
              {jobs.items.map((row) => (
                <li key={row.id}>
                  <strong>{backupStateNames[row.state]}</strong> ·{" "}
                  {backupPhaseNames[row.phase]}
                  <p>{row.reason}</p>
                  <p>
                    申请 {when(row.created_at)} · 开始 {when(row.started_at)} ·
                    结束 {when(row.finished_at)}
                  </p>
                  {row.failure_code && (
                    <p>
                      {backupFailureNames[row.failure_code] ||
                        "请联系维护人员核对。"}{" "}
                      诊断代码：{row.failure_code}
                    </p>
                  )}
                  {row.cancel_requested && !terminal(row) && (
                    <p>已申请取消，等待执行器核对。</p>
                  )}
                  {row.state === "unknown" && (
                    <p>不会自动重试。请维护人员核对执行结果后再处理。</p>
                  )}
                  {row.state === "queued" && (
                    <p>
                      授权有效至 {when(row.authorized_until)}
                      ；过期须重新验证并申请。
                    </p>
                  )}
                  {canRequest && backupCanCancel(row, owner) && (
                    <button
                      disabled={busy || !!pending}
                      onClick={() => cancel(row)}
                    >
                      申请取消本任务
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无申请记录。</p>
          )}
          <button
            disabled={page === 1 || busy}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页
          </button>
          <span> 第{page}页 </span>
          <button
            disabled={!jobs.has_more || busy}
            onClick={() => setPage((v) => v + 1)}
          >
            下一页
          </button>
        </div>
      )}
      {canManage && <BackupPermissions session={session} />}
    </section>
  );
}

function BackupPermissions({ session }: { session: StaffSession }) {
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [target, setTarget] = useState("");
  const [permissions, setPermissions] = useState<BackupPermission[]>([]);
  const [note, setNote] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadedTarget, setLoadedTarget] = useState("");
  const current = useRef({ owner: session.user.id, target });
  current.current = { owner: session.user.id, target };
  useEffect(() => {
    const controller = new AbortController();
    setUsers([]);
    setTarget("");
    setNotice("");
    setError("");
    void request<StaffUser[]>(
      `/users?page=${page}&page_size=20`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setUsers(result.data.filter((user) => user.is_active));
        setHasMore(page * 20 < (result.meta.pagination?.total ?? 0));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error));
      });
    return () => controller.abort();
  }, [session.user.id, page]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadedTarget("");
    setPermissions([]);
    setNote("");
    if (target)
      void request<BackupGrants>(
        `/backup-grants/${target}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted && current.current.target === target) {
            setPermissions(result.data.permissions);
            setLoadedTarget(target);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(message(error));
        });
    return () => controller.abort();
  }, [session.user.id, target, revision]);
  async function save() {
    if (busy || !target || loadedTarget !== target || note.trim().length < 5)
      return;
    const identity = { owner: session.user.id, target };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request<BackupGrants>(`/backup-grants/${target}`, "PUT", {
        permissions,
        note: note.trim(),
      });
      if (
        current.current.owner === identity.owner &&
        current.current.target === identity.target
      ) {
        setNotice(
          "权限已保存。成员重新读取会话后更新入口；服务端授权立即生效。",
        );
        setRevision((v) => v + 1);
      }
    } catch (error) {
      if (
        current.current.owner === identity.owner &&
        current.current.target === identity.target
      ) {
        setError(`${message(error)} 请读取当前权限核对后再操作。`);
        setLoadedTarget("");
      }
    } finally {
      if (current.current.owner === identity.owner) setBusy(false);
    }
  }
  return (
    <section className="ad-card">
      <h3>备份独立授权</h3>
      <p>
        账号角色不自动获得备份权限。授权需要近期通行密钥验证；不会赋予主机访问、恢复覆盖或读取密钥的能力。
      </p>
      <ErrorBox text={error} />
      <p role="status">{notice}</p>
      <label>
        成员
        <select
          value={target}
          disabled={busy}
          onChange={(e) => {
            setTarget(e.target.value);
            setNotice("");
          }}
        >
          <option value="">选择本页有效成员</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.display_name}（{user.username}）
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={page === 1 || busy}
        onClick={() => setPage((v) => v - 1)}
      >
        上一页成员
      </button>
      <button disabled={!hasMore || busy} onClick={() => setPage((v) => v + 1)}>
        下一页成员
      </button>
      {target && (
        <>
          <fieldset disabled={busy || loadedTarget !== target}>
            {(["backup.read", "backup.request"] as BackupPermission[]).map(
              (permission) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    checked={permissions.includes(permission)}
                    onChange={(e) =>
                      setPermissions((values) =>
                        e.target.checked
                          ? [...values, permission]
                          : values.filter((value) => value !== permission),
                      )
                    }
                  />
                  {permission === "backup.read"
                    ? "查看全站备份和恢复记录"
                    : "申请和取消本人备份任务"}
                </label>
              ),
            )}
            <label>
              授权变更原因
              <input
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              disabled={note.trim().length < 5 || !session.mfa_enrolled}
              onClick={() => void save()}
            >
              保存独立授权
            </button>
          </fieldset>
          <button disabled={busy} onClick={() => setRevision((v) => v + 1)}>
            读取当前权限
          </button>
        </>
      )}
    </section>
  );
}
