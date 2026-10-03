import { useEffect, useRef, useState } from "react";
import {
  message,
  rememberCsrf,
  rememberSession,
  request,
  type StaffSession,
} from "./api";
import { ErrorBox } from "./ui";
import {
  assertionOptions,
  creationOptions,
  serializeCredential,
  webauthnMessage,
} from "./webauthn";

export type MfaPending = {
  status: "mfa_required" | "enrollment_required" | "recovery_required";
  csrf_token: string;
  expires_at: string;
  must_change_password: boolean;
};
type MfaOptions = { public_key: Record<string, unknown> };
type MfaStatus = {
  enforced: boolean;
  enrolled: boolean;
  verified: boolean;
  credentials: {
    id: string;
    name: string;
    verified: boolean;
    created_at: string;
    last_used_at: string | null;
  }[];
  recovery_codes_remaining: number;
  enforcement_ready: boolean;
};

type SessionInventory = {
  server_time: string;
  sessions: {
    id: string;
    is_current: boolean;
    created_at: string;
    last_activity_at: string;
    expires_at: string;
    idle_expires_at: string;
    mfa_verified: boolean;
  }[];
};

export function OwnSessions({ session }: { session: StaffSession }) {
  const [inventoryState, setInventory] = useState<
    (SessionInventory & { owner: string; csrf: string }) | null
  >(null);
  const inventory =
    inventoryState?.owner === session.user.id &&
    inventoryState.csrf === session.csrf_token
      ? inventoryState
      : null;
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    mutation.current?.abort();
    mutation.current = null;
    setBusy(false);
    setInventory(null);
    setError("");
    request<SessionInventory>("/auth/sessions", "GET", undefined, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted)
          setInventory({
            ...result.data,
            owner: session.user.id,
            csrf: session.csrf_token,
          });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => {
      abort.abort();
      mutation.current?.abort();
    };
  }, [session.user.id, session.csrf_token, revision]);
  async function revoke(id?: string) {
    if (mutation.current) return;
    const abort = new AbortController();
    mutation.current = abort;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{ revoked_count: number }>(
        id
          ? `/auth/sessions/${encodeURIComponent(id)}`
          : "/auth/sessions/revoke-others",
        id ? "DELETE" : "POST",
        undefined,
        abort.signal,
      );
      if (!abort.signal.aborted) {
        setNotice(
          `已撤销 ${result.data.revoked_count} 个有效会话，本次登录保持有效。`,
        );
        setRevision((value) => value + 1);
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(message(e));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
      if (mutation.current === abort) mutation.current = null;
    }
  }
  const canRevoke = session.mfa_enrolled && session.mfa_verified;
  const date = (value: string) =>
    new Date(value).toLocaleString("zh-CN", { hour12: false });
  return (
    <section aria-labelledby="staff-sessions-title">
      <h3 id="staff-sessions-title">我的有效会话</h3>
      <p>
        仅显示本账号尚未过期的登录。时间来自服务器记录；撤销前需在五分钟内验证通行密钥。
      </p>
      {!canRevoke && (
        <p className="ad-hint">请先登记并验证通行密钥，再撤销会话。</p>
      )}
      <ErrorBox
        text={error}
        onRetry={() => setRevision((value) => value + 1)}
      />
      {notice && <p role="status">{notice}</p>}
      {!inventory ? (
        <p role="status">正在读取有效会话…</p>
      ) : (
        <>
          <p className="ad-hint">
            服务器核对时间：
            <time dateTime={inventory.server_time}>
              {date(inventory.server_time)}
            </time>
          </p>
          <div className="ad-table-wrap">
            <table className="ad-table">
              <thead>
                <tr>
                  <th scope="col">会话</th>
                  <th scope="col">登录时间</th>
                  <th scope="col">最近操作</th>
                  <th scope="col">闲置截止 / 登录截止</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {inventory.sessions.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>
                        {row.is_current ? "本次登录" : "其他登录"}
                      </strong>
                      <small>{row.id}</small>
                    </td>
                    <td>
                      <time dateTime={row.created_at}>
                        {date(row.created_at)}
                      </time>
                    </td>
                    <td>
                      <time dateTime={row.last_activity_at}>
                        {date(row.last_activity_at)}
                      </time>
                    </td>
                    <td>
                      <time dateTime={row.idle_expires_at}>
                        {date(row.idle_expires_at)}
                      </time>
                      <small>
                        <time dateTime={row.expires_at}>
                          {date(row.expires_at)}
                        </time>
                      </small>
                    </td>
                    <td>
                      <button
                        disabled={busy || !canRevoke || row.is_current}
                        aria-label={`撤销会话 ${row.id}`}
                        onClick={() => {
                          if (
                            window.confirm("撤销这个会话？对应设备须重新登录。")
                          )
                            void revoke(row.id);
                        }}
                      >
                        撤销
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            disabled={
              busy ||
              !canRevoke ||
              !inventory.sessions.some((row) => !row.is_current)
            }
            onClick={() => {
              if (window.confirm("撤销本次登录以外的所有会话？")) void revoke();
            }}
          >
            撤销其他会话，保留本次
          </button>
        </>
      )}
      <button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
        刷新会话列表
      </button>
    </section>
  );
}

export function PendingMfa({
  pending,
  onPending,
  onSession,
  onCancel,
  stepUp = false,
}: {
  pending: MfaPending;
  onPending: (pending: MfaPending) => void;
  onSession: (session: StaffSession) => void;
  onCancel: () => void;
  stepUp?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState("主认证器"),
    [code, setCode] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      await action(abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) setError(webauthnMessage(e));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  function update(value: MfaPending) {
    rememberCsrf(value.csrf_token);
    onPending(value);
  }
  async function verify(signal: AbortSignal) {
    if (!window.PublicKeyCredential || !navigator.credentials)
      throw new Error(
        "当前浏览器不支持通行密钥，请使用更新的浏览器或其他设备。",
      );
    const options = await request<MfaOptions>(
      "/auth/mfa/authentication/options",
      "POST",
      undefined,
      signal,
    );
    const proof = await navigator.credentials.get({
      publicKey: assertionOptions(options.data.public_key),
      signal,
    });
    if (!proof || signal.aborted)
      throw new DOMException("Cancelled", "AbortError");
    const result = await request<StaffSession>(
      "/auth/mfa/authentication/verify",
      "POST",
      {
        credential: serializeCredential(proof as PublicKeyCredential),
      },
      signal,
    );
    rememberSession(result.data);
    onSession(result.data);
  }
  const enrollment = pending.status === "enrollment_required";
  return (
    <section className="ad-login-form" aria-labelledby="staff-mfa-title">
      <h2 id="staff-mfa-title">
        {stepUp ? "再次确认身份" : enrollment ? "登记通行密钥" : "双因素验证"}
      </h2>
      <p>
        {stepUp
          ? "验证完成后，请自行重试刚才的操作。原操作不会自动发送。"
          : "密码已验证。完成设备验证后，才能进入管理后台。"}
      </p>
      <p className="ad-hint">
        请在 5 分钟内完成；使用设备 PIN、指纹、面容或支持用户验证的安全钥匙。
      </p>
      <ErrorBox text={error} />
      <fieldset disabled={busy}>
        {pending.must_change_password && enrollment ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async (signal) => {
                const result = await request<MfaPending>(
                  "/auth/mfa/pending/password",
                  "POST",
                  {
                    current_password: currentPassword,
                    new_password: newPassword,
                  },
                  signal,
                );
                setCurrentPassword("");
                setNewPassword("");
                update(result.data);
              });
            }}
          >
            <p>先修改管理员分配的临时密码，再登记认证器。</p>
            <label>
              临时密码
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <button className="ad-primary" type="submit">
              修改密码并继续
            </button>
          </form>
        ) : enrollment ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async (signal) => {
                if (!window.PublicKeyCredential || !navigator.credentials)
                  throw new Error(
                    "当前浏览器不支持通行密钥，请使用更新的浏览器或其他设备。",
                  );
                const options = await request<MfaOptions>(
                  "/auth/mfa/registration/options",
                  "POST",
                  { name },
                  signal,
                );
                const proof = await navigator.credentials.create({
                  publicKey: creationOptions(options.data.public_key),
                  signal,
                });
                if (!proof || signal.aborted)
                  throw new DOMException("Cancelled", "AbortError");
                const result = await request<MfaPending>(
                  "/auth/mfa/registration/verify",
                  "POST",
                  {
                    credential: serializeCredential(
                      proof as PublicKeyCredential,
                    ),
                  },
                  signal,
                );
                update(result.data);
              });
            }}
          >
            <label>
              认证器名称
              <input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="ad-primary" type="submit">
              登记认证器
            </button>
            <p className="ad-hint">
              登记后还需验证一次，确认这个认证器可以用于登录。
            </p>
          </form>
        ) : pending.status !== "recovery_required" ? (
          <button className="ad-primary" onClick={() => void run(verify)}>
            验证通行密钥并继续
          </button>
        ) : (
          <p>
            没有可用认证器。使用已离线保存的恢复码，或通过项目运维的受控恢复流程重绑。
          </p>
        )}
        {!enrollment && !stepUp && (
          <>
            <button
              type="button"
              onClick={() => setRecoveryOpen((v) => !v)}
              aria-expanded={recoveryOpen}
            >
              认证器丢失？使用恢复码
            </button>
            {recoveryOpen && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async (signal) => {
                    const result = await request<MfaPending>(
                      "/auth/mfa/recovery",
                      "POST",
                      { code: code.trim() },
                      signal,
                    );
                    setCode("");
                    update(result.data);
                  });
                }}
              >
                <label>
                  一次性恢复码
                  <input
                    autoComplete="off"
                    required
                    minLength={20}
                    maxLength={128}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <p>
                  恢复码只允许重绑认证器，不会直接进入后台。原认证器会失效。
                </p>
                <button type="submit">验证恢复码</button>
              </form>
            )}
          </>
        )}
      </fieldset>
      {busy && <p role="status">请完成浏览器的身份验证…</p>}
      <button
        type="button"
        onClick={() => {
          controller.current?.abort();
          onCancel();
        }}
      >
        取消，返回
      </button>
    </section>
  );
}

export function MfaStepUp({
  session,
  onSession,
}: {
  session: StaffSession;
  onSession: (s: StaffSession) => void;
}) {
  const [pending, setPending] = useState<MfaPending | null>(null),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    active = useRef(false);
  useEffect(() => {
    async function open() {
      if (active.current) return;
      active.current = true;
      try {
        const result = await request<MfaPending>("/auth/mfa/step-up", "POST");
        rememberCsrf(result.data.csrf_token);
        setPending(result.data);
        setError("");
      } catch (e) {
        setError(message(e));
        active.current = false;
      }
    }
    window.addEventListener("staff-mfa-required", open);
    return () => window.removeEventListener("staff-mfa-required", open);
  }, []);
  useEffect(() => {
    if (pending && !dialog.current?.open) dialog.current?.showModal();
    if (!pending && dialog.current?.open) dialog.current.close();
  }, [pending]);
  function close() {
    rememberSession(session);
    setPending(null);
    active.current = false;
  }
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <dialog
        className="ad-mfa-dialog"
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        {pending && (
          <PendingMfa
            stepUp
            pending={pending}
            onPending={setPending}
            onSession={(s) => {
              setPending(null);
              active.current = false;
              onSession(s);
            }}
            onCancel={close}
          />
        )}
      </dialog>
    </>
  );
}

export function MfaSecurity({
  session,
  onSession,
}: {
  session: StaffSession;
  onSession: (s: StaffSession) => void;
}) {
  const [status, setStatus] = useState<MfaStatus | null>(null),
    [error, setError] = useState("");
  const [password, setPassword] = useState(""),
    [pending, setPending] = useState<MfaPending | null>(null);
  const [codes, setCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    request<MfaStatus>("/auth/mfa", "GET", undefined, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) setStatus(r.data);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [session.user.id, session.csrf_token, revision]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (pending)
    return (
      <PendingMfa
        pending={pending}
        onPending={setPending}
        onSession={(s) => {
          setPending(null);
          onSession(s);
          setRevision((v) => v + 1);
        }}
        onCancel={() => {
          rememberSession(session);
          setPending(null);
        }}
      />
    );
  return (
    <section className="ad-form" aria-labelledby="staff-security-title">
      <h2 id="staff-security-title">账号安全</h2>
      <p>
        通行密钥绑定本站域名。每个成员使用自己的认证器，审核分工和权限保持独立。
      </p>
      <ErrorBox text={error} onRetry={() => setRevision((v) => v + 1)} />
      <OwnSessions session={session} />
      {!status ? (
        <p role="status">正在读取认证器…</p>
      ) : (
        <>
          <p role="status">
            {status.enforcement_ready
              ? "主、备用认证器均已验证，恢复码已生成。请确认离线保存后，再由运维启用全站强制双因素。"
              : "启用全站强制双因素前，请分别验证至少两个认证器，并生成、离线保存恢复码。"}
          </p>
          {!status.enforced && !status.enrolled && (
            <p role="status">
              当前为登记阶段。先验证主、备用认证器和恢复流程，再由运维启用强制双因素。
            </p>
          )}
          <p>
            {status.enrolled
              ? "此账号已启用双因素验证。"
              : "此账号尚未完成认证器登记。"}
          </p>
          <ul>
            {status.credentials.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> · {c.verified ? "已验证" : "尚未验证"}
                <button
                  disabled={
                    busy ||
                    (c.verified &&
                      status.credentials.filter((v) => v.verified).length <= 1)
                  }
                  onClick={() => {
                    if (
                      window.confirm(`撤销“${c.name}”？其他已登录会话将失效。`)
                    )
                      void perform(async () => {
                        const result = await request<StaffSession>(
                          `/auth/mfa/credentials/${encodeURIComponent(c.id)}`,
                          "DELETE",
                        );
                        rememberSession(result.data);
                        onSession(result.data);
                        setRevision((v) => v + 1);
                      });
                  }}
                >
                  撤销认证器
                </button>
              </li>
            ))}
          </ul>
          <p>
            至少保留一个已验证认证器。建议另登记一个独立备用设备，并离线保存恢复码。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const result = await request<MfaPending>(
                  "/auth/mfa/enrollment",
                  "POST",
                  { password },
                );
                setPassword("");
                rememberCsrf(result.data.csrf_token);
                setPending(result.data);
              });
            }}
          >
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button type="submit" disabled={busy}>
              登记主或备用认证器
            </button>
          </form>
          {status.enrolled && (
            <>
              <p>
                剩余恢复码：{status.recovery_codes_remaining}
                。重新生成将使之前的恢复码失效。
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm("生成新的10个恢复码并使旧码和其他会话失效？")
                  )
                    void perform(async () => {
                      const result = await request<{
                        codes: string[];
                        session: StaffSession;
                      }>("/auth/mfa/recovery-codes", "POST");
                      setCodes(result.data.codes);
                      rememberSession(result.data.session);
                      onSession(result.data.session);
                      setRevision((v) => v + 1);
                    });
                }}
              >
                生成新的恢复码
              </button>
            </>
          )}
        </>
      )}
      {!!codes.length && (
        <section aria-labelledby="recovery-codes-title">
          <h3 id="recovery-codes-title">请立即离线保存这10个恢复码</h3>
          <p>
            只显示这一次，每个码仅可用一次。不要发到聊天、工单、共享文档或代码仓库。
          </p>
          <ol>
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ol>
          <button onClick={() => setCodes([])}>我已安全保存，隐藏恢复码</button>
        </section>
      )}
    </section>
  );
}
