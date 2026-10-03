import { useCallback, useEffect, useRef, useState } from "react";
import type { Campus, MapInfo } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { EnvironmentBanner } from "../../shared/ui/EnvironmentBanner";
import { GuideSettings } from "./GuideSettings";
import { ConfigurationWorkspace } from "./ConfigurationWorkspace";
import { ImportWorkspace } from "./ImportWorkspace";
import { BackupWorkspace } from "./BackupWorkspace";
import { HelpPanel, canOpenHelpPage } from "./HelpPanel";
import type { IssueTarget } from "./WorkspaceIssues";
import { RoadWorkspace } from "./RoadWorkspace";
import { Accounts } from "./Accounts";
import { Audit } from "./Audit";
import { PointWorkspace } from "./PointWorkspace";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { ExperienceWorkspace } from "./ExperienceWorkspace";
import { Overview } from "./Overview";
import { ReviewCenter, type ReviewStart } from "./ReviewCenter";
import { MfaSecurity, MfaStepUp, PendingMfa, type MfaPending } from "./MfaAuth";
import {
  message,
  rememberSession,
  rememberCsrf,
  request,
  roleNames,
  type Workbench,
  type StaffSession,
} from "./api";
import { ErrorBox, useResource } from "./ui";
import "./admin.css";
import "./workbench.css";
type Tab =
  | "backups"
  | "imports"
  | "experiences"
  | "tours"
  | "configurations"
  | "guide-settings"
  | "roads"
  | "overview"
  | "points"
  | "review"
  | "resources"
  | "audit"
  | "accounts";
function Login({
  onLogin,
  initialError,
}: {
  onLogin: (s: StaffSession) => void;
  initialError: string;
}) {
  const [pending, setPending] = useState<MfaPending | null>(null);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await request<StaffSession | MfaPending>(
        "/auth/login",
        "POST",
        {
          username,
          password,
        },
      );
      setPassword("");
      if ("status" in result.data) {
        rememberCsrf(result.data.csrf_token);
        setPending(result.data);
      } else onLogin(result.data);
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
        onSession={onLogin}
        onCancel={() => {
          rememberSession(null);
          setPending(null);
        }}
      />
    );
  return (
    <div className="ad-login">
      <div className="ad-login-story">
        <a href="/" className="ad-brand">
          <span className="ad-brand-symbol">N</span>
          <span>
            TwinNKU<small>南开校园导览</small>
          </span>
        </a>
        <div>
          <div className="ad-eyebrow">CAMPUS CONTENT STUDIO</div>
          <h1>
            每一个地点，
            <br />
            都值得被准确讲述。
          </h1>
          <p>
            维护校园地图，核对文化资料，
            <br />
            让每次发布都清晰、可靠。
          </p>
        </div>
        <span className="ad-login-caption">地图管理 · 分工协作 · 审核发布</span>
      </div>
      <main className="ad-login-form">
        <div className="ad-eyebrow">STAFF ACCESS</div>
        <h2>登录管理后台</h2>
        <p>使用管理员分配的成员账号。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              账号
              <input
                autoFocus
                autoComplete="username"
                required
                maxLength={64}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="输入登录账号"
              />
            </label>
            <label>
              密码
              <input
                autoComplete="current-password"
                required
                type="password"
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码"
              />
            </label>
            <ErrorBox text={error} />
            <button className="ad-primary" type="submit">
              {busy ? "正在验证…" : "登录后台 →"}
            </button>
          </fieldset>
        </form>
        <p className="ad-hint">账号未开通或忘记密码，请联系项目管理员。</p>
        <a href="/" className="ad-back-link">
          ← 返回校园导览
        </a>
      </main>
    </div>
  );
}
function PasswordForm({
  forced,
  onDone,
  onCancel,
}: {
  forced: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit() {
    if (next !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await request("/auth/password", "POST", {
        current_password: current,
        new_password: next,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ad-password-page">
      <form
        className="ad-card ad-password-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="ad-eyebrow">ACCOUNT SECURITY</div>
        <h1>{forced ? "先设置你的个人密码" : "修改密码"}</h1>
        <p>
          {forced
            ? "首次登录需要更换管理员分配的临时密码。"
            : "修改成功后，所有设备都需要重新登录。"}
        </p>
        <fieldset disabled={busy}>
          <label>
            {forced ? "临时密码" : "当前密码"}
            <input
              autoFocus
              type="password"
              required
              maxLength={128}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            新密码
            <input
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <small>12 至 128 个字符，建议使用不重复的长密码。</small>
          </label>
          <label>
            再次输入新密码
            <input
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <ErrorBox text={error} />
          <div className="ad-action-wrap">
            <button className="ad-primary" type="submit">
              {busy ? "正在保存…" : "更新密码并重新登录"}
            </button>
            <button type="button" onClick={onCancel}>
              {forced ? "退出登录" : "取消"}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
export default function AdminApp() {
  const [session, setSession] = useState<StaffSession | null>(null),
    [checking, setChecking] = useState(true),
    [authError, setAuthError] = useState(""),
    [tab, setTab] = useState<Tab | "security">("overview"),
    [passwordOpen, setPasswordOpen] = useState(false),
    [revision, setRevision] = useState(0),
    [navError, setNavError] = useState(""),
    [catalogRevision, setCatalogRevision] = useState(0),
    [locked, setLocked] = useState(false),
    [reviewStart, setReviewStart] = useState<ReviewStart>({}),
    [reviewKey, setReviewKey] = useState(0),
    [helpOpen, setHelpOpen] = useState(false);
  const helpButton = useRef<HTMLButtonElement | null>(null);
  const dirty = useRef(false);
  const [importedDraft, setImportedDraft] = useState<{
    tab: Tab;
    id: string;
  } | null>(null);
  const [issueTarget, setIssueTarget] = useState<IssueTarget | null>(null);
  const processing = useRef(false);
  const onDirty = useCallback((value: boolean, busy = false) => {
    processing.current = busy;
    dirty.current = value;
  }, []);
  const applySession = useCallback((value: StaffSession | null) => {
    rememberSession(value);
    setLocked(false);
    setSession(value);
    setHelpOpen(false);
    setIssueTarget(null);
    setTab("overview");
    dirty.current = false;
    processing.current = false;
  }, []);
  useEffect(() => {
    if (!session || locked || session.user.must_change_password) return;
    let last = 0;
    const activity = (event: Event) => {
      if (
        !event.isTrusted ||
        document.visibilityState !== "visible" ||
        Date.now() - last < 60_000
      )
        return;
      last = Date.now();
      void request("/auth/mfa/activity", "POST").catch(() => {});
    };
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity);
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [session, locked]);
  useEffect(() => {
    const abort = new AbortController();
    request<StaffSession>("/session", "GET", undefined, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) applySession(r.data);
      })
      .catch((e) => {
        if (!abort.signal.aborted && e.status !== 401) setAuthError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false);
      });
    const expired = () => {
      rememberSession(null);
      setLocked(true);
      setAuthError(
        "登录已过期或权限已变更。同一账号重新登录后，可以继续处理本页未保存的点位修改。",
      );
      setPasswordOpen(false);
      setHelpOpen(false);
    };
    window.addEventListener("staff-session-expired", expired);
    return () => {
      abort.abort();
      window.removeEventListener("staff-session-expired", expired);
    };
  }, [applySession]);
  useEffect(() => {
    if (!session || locked) return;
    const controller = new AbortController();
    const refreshPermissions = () => {
      void request<StaffSession>(
        "/session",
        "GET",
        undefined,
        controller.signal,
      )
        .then((r) => {
          if (controller.signal.aborted || r.data.user.id !== session.user.id)
            return;
          rememberSession(r.data);
          setSession(r.data);
          setRevision((v) => v + 1);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setNavError(message(e));
        });
    };
    window.addEventListener("staff-permissions-changed", refreshPermissions);
    return () => {
      controller.abort();
      window.removeEventListener(
        "staff-permissions-changed",
        refreshPermissions,
      );
    };
  }, [session?.user.id, locked]);
  const maps = useResource<MapInfo[]>(
      session && !session.user.must_change_password ? "/maps" : null,
      catalogRevision,
    ),
    campuses = useResource<Campus[]>(
      session && !session.user.must_change_password ? "/campuses" : null,
      catalogRevision,
    );
  const workbench = useResource<Workbench>(
    session && !locked && !session.user.must_change_password
      ? "/workbench"
      : null,
    revision,
  );
  useEffect(() => {
    if (!session || locked || session.user.must_change_password) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setRevision((v) => v + 1);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [session, locked]);
  const navigate = (next: Tab | "security") => {
    if (processing.current) {
      setNavError("正在处理当前操作，请完成后再切换页面。");
      return false;
    }
    if (
      dirty.current &&
      !window.confirm("当前修改尚未保存，确定放弃并切换页面吗？")
    )
      return false;
    dirty.current = false;
    setImportedDraft(null);
    setIssueTarget(null);
    setTab(next);
    setNavError("");
    return true;
  };
  const openReview = (start: ReviewStart = {}) => {
    if (navigate("review")) {
      setReviewStart(start);
      setReviewKey((v) => v + 1);
    }
  };
  async function logout() {
    if (processing.current) {
      setNavError("当前操作尚未完成，请稍后退出。");
      return;
    }
    if (dirty.current && !window.confirm("当前修改尚未保存，确定退出吗？"))
      return;
    try {
      await request("/auth/logout", "POST");
      applySession(null);
      setPasswordOpen(false);
      setAuthError("已退出登录。");
    } catch (e) {
      setNavError(message(e));
    }
  }
  if (checking)
    return (
      <div className="ad-root ad-loading" role="status">
        <EnvironmentBanner />
        正在验证管理会话…
      </div>
    );
  if (!session)
    return (
      <div className="ad-root">
        <EnvironmentBanner />
        <Login
          initialError={authError}
          onLogin={(s) => {
            applySession(s);
            setAuthError("");
          }}
        />
      </div>
    );
  const relogin = (s: StaffSession) => {
    const scope = (v: StaffSession) =>
      JSON.stringify([
        v.user.id,
        v.user.role,
        v.user.campus_ids,
        v.user.point_ids,
        v.user.must_change_password,
      ]);
    if (scope(s) === scope(session)) {
      rememberSession(s);
      setSession(s);
      setLocked(false);
    } else {
      applySession(s);
      setCatalogRevision((v) => v + 1);
    }
    setAuthError("");
    setRevision((v) => v + 1);
    if (maps.error || campuses.error) setCatalogRevision((v) => v + 1);
  };
  if (session.user.must_change_password || passwordOpen)
    return (
      <div className="ad-root">
        <EnvironmentBanner />
        <ErrorBox text={navError} />
        {locked ? (
          <Login initialError={authError} onLogin={relogin} />
        ) : (
          <PasswordForm
            forced={session.user.must_change_password}
            onDone={() => {
              applySession(null);
              setPasswordOpen(false);
              setAuthError("密码已更新，请使用新密码登录。");
            }}
            onCancel={() =>
              session.user.must_change_password
                ? logout()
                : setPasswordOpen(false)
            }
          />
        )}
      </div>
    );
  const navs: {
    id: Tab | "security";
    title: string;
    icon: string;
    permission?: string;
    anyPermissions?: string[];
    group?: string;
  }[] = [
    { id: "security", title: "账号安全", icon: "users" },
    { id: "overview", title: "工作台", icon: "focus" },
    { id: "points", title: "地图点位", icon: "pin", group: "编辑校园内容" },
    { id: "resources", title: "资料中心", icon: "layers" },
    {
      id: "imports",
      title: "表格导入",
      icon: "layers",
      permission: "points.edit",
    },
    { id: "experiences", title: "视频与打卡", icon: "panorama" },
    { id: "tours", title: "校园导览路线", icon: "bookmark" },
    { id: "roads", title: "道路与导航", icon: "pin" },
    {
      id: "configurations",
      title: "首页与参观编排",
      icon: "layers",
      anyPermissions: ["configurations.edit", "configurations.review"],
    },
    { id: "review", title: "审核中心", icon: "check", group: "审核与协作" },
    {
      id: "guide-settings",
      title: "服务与费用设置",
      group: "设置与记录",
      icon: "chat",
      anyPermissions: ["runtime.edit", "runtime.review"],
    },
    {
      id: "backups",
      title: "备份与恢复记录",
      icon: "clock",
      anyPermissions: ["backup.read", "backup.request", "users.manage"],
    },
    {
      id: "audit",
      title: "操作记录",
      icon: "clock",
      permission: "audit.read",
    },
    {
      id: "accounts",
      title: "账号权限",
      icon: "users",
      permission: "users.manage",
    },
  ];
  return (
    <div className="ad-root ad-shell">
      <EnvironmentBanner />
      <MfaStepUp session={session} onSession={relogin} />
      {locked && (
        <div className="ad-relogin">
          <Login initialError={authError} onLogin={relogin} />
        </div>
      )}
      <aside
        className="ad-sidebar"
        inert={locked}
        aria-hidden={locked || undefined}
      >
        <a
          className="ad-brand"
          href="/"
          onClick={(e) => {
            if (
              processing.current ||
              (dirty.current &&
                !window.confirm("修改尚未保存，确定返回导览吗？"))
            )
              e.preventDefault();
          }}
        >
          <span className="ad-brand-symbol">N</span>
          <span>
            TwinNKU<small>校园导览管理后台</small>
          </span>
        </a>
        <div className="ad-sidebar-label">工作空间</div>
        <nav aria-label="后台导航">
          {navs
            .filter(
              (n) =>
                (!n.permission || session.permissions.includes(n.permission)) &&
                (!n.anyPermissions ||
                  n.anyPermissions.some((p) =>
                    session.permissions.includes(p),
                  )),
            )
            .map((n) => (
              <div className="ad-nav-item" key={n.id}>
                {n.group && <div className="ad-sidebar-label">{n.group}</div>}
                <button
                  aria-current={tab === n.id ? "page" : undefined}
                  className={tab === n.id ? "active" : ""}
                  onClick={() => {
                    if (n.id === "review") openReview();
                    else navigate(n.id);
                  }}
                >
                  <Icon name={n.icon} />
                  {n.title}
                  <span>
                    {n.id === "review" && workbench.data?.data.pending_count ? (
                      <b className="ad-nav-count">
                        {workbench.data.data.pending_count}
                      </b>
                    ) : (
                      "›"
                    )}
                  </span>
                </button>
              </div>
            ))}
        </nav>
        <div className="ad-sidebar-bottom">
          <a href="/" target="_blank" rel="noreferrer">
            打开公开导览 ↗
          </a>
          <div className="ad-profile">
            <span>{session.user.display_name.slice(0, 1)}</span>
            <div>
              <strong>{session.user.display_name}</strong>
              <small>{roleNames[session.user.role]}</small>
            </div>
          </div>
          <div className="ad-profile-actions">
            <button
              onClick={() => {
                if (
                  !processing.current &&
                  (!dirty.current ||
                    window.confirm("修改尚未保存，确定放弃并修改密码吗？"))
                ) {
                  dirty.current = false;
                  setPasswordOpen(true);
                }
              }}
            >
              修改密码
            </button>
            <button onClick={logout}>退出</button>
          </div>
        </div>
      </aside>
      <div className="ad-main" inert={locked} aria-hidden={locked || undefined}>
        <header className="ad-topbar">
          <span>
            校园内容管理 <span>/</span> {navs.find((n) => n.id === tab)?.title}
          </span>
          <button
            type="button"
            ref={helpButton}
            className="ad-help-toggle"
            aria-expanded={helpOpen}
            aria-controls="admin-task-help"
            onClick={() => setHelpOpen((value) => !value)}
          >
            当前页面帮助
          </button>
          <span className="ad-session-indicator">
            <i />
            会话有效至{" "}
            {new Date(session.expires_at).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </header>
        <main className="ad-content">
          {tab === "security" && (
            <MfaSecurity session={session} onSession={relogin} />
          )}
          <ErrorBox text={navError} />
          {tab === "overview" && (
            <Overview
              session={session}
              revision={revision}
              stats={workbench.data}
              error={workbench.error}
              loading={workbench.loading}
              onRefresh={() => setRevision((v) => v + 1)}
              onNavigate={navigate}
              onReview={openReview}
              campuses={campuses.data?.data}
              onOpenIssue={(target) => {
                if (!canOpenHelpPage(target.page, session.permissions)) {
                  setNavError(
                    "当前账号没有此编辑器权限，请有对应权限的成员处理。",
                  );
                  return;
                }
                if (navigate(target.page)) {
                  setImportedDraft({
                    tab: target.page as Tab,
                    id: target.issue.entity_id,
                  });
                  setIssueTarget(target);
                }
              }}
              onReviewIssue={(target) => {
                const kind =
                  target.issue.entity_type === "vr"
                    ? "panorama"
                    : target.issue.entity_type;
                if (!target.issue.actions.includes("review")) return;
                openReview({ target: { id: target.issue.entity_id, kind } });
                if (!processing.current && !dirty.current)
                  setIssueTarget(target);
              }}
            />
          )}
          {issueTarget && tab !== "overview" && (
            <section
              className="ad-card ad-issue-context"
              aria-label="当前检查定位"
            >
              <strong>
                {issueTarget.issue.title} · {issueTarget.issue.message}
              </strong>
              <p>
                {issueTarget.changed
                  ? "对象已更新，已打开服务端当前版本。旧报告的位置不自动套到新内容，请运行完整检查后重新定位。"
                  : `已重新核对当前权限与版本，打开此项内容。${issueTarget.issue.stop_index != null ? `对应第 ${issueTarget.issue.stop_index + 1} 站。` : ""}`}
              </p>
              <p>
                报告草稿 v{issueTarget.issue.revision} / 正式 v
                {issueTarget.issue.published_revision}；打开时草稿 v
                {issueTarget.revision} / 正式 v{issueTarget.publishedRevision}
              </p>
              <details>
                <summary>具体检查位置</summary>
                <p>{issueTarget.issue.path || "内容"}</p>
              </details>
              <button onClick={() => setIssueTarget(null)}>收起本项提示</button>
            </section>
          )}
          {tab === "points" && (
            <>
              <ErrorBox
                text={maps.error}
                onRetry={() => setCatalogRevision((v) => v + 1)}
              />
              {maps.loading ? (
                <p role="status">正在读取底图…</p>
              ) : (
                maps.data && (
                  <PointWorkspace
                    key={tab}
                    initialId={
                      importedDraft?.tab === "points"
                        ? importedDraft.id
                        : undefined
                    }
                    session={session}
                    maps={maps.data.data}
                    onDirty={onDirty}
                    onUpdate={() => setRevision((v) => v + 1)}
                    onReview={(id) =>
                      openReview({ target: { id, kind: "point" } })
                    }
                  />
                )
              )}
            </>
          )}
          {tab === "review" && (
            <ReviewCenter
              key={reviewKey}
              session={session}
              maps={maps.data?.data ?? []}
              mapsError={maps.error}
              onRetryMaps={() => setCatalogRevision((v) => v + 1)}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              initial={reviewStart}
              revision={revision}
            />
          )}
          {tab === "resources" && (
            <ResourceWorkspace
              initialId={
                importedDraft?.tab === "resources"
                  ? importedDraft.id
                  : undefined
              }
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={(id) => openReview({ target: { id } })}
              onPoint={(pointId) => {
                if (navigate("points"))
                  setImportedDraft({ tab: "points", id: pointId });
              }}
            />
          )}
          {tab === "imports" && (
            <ImportWorkspace
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={() => openReview()}
              onOpenDraft={(kind, id, isTour) => {
                const target: Tab =
                  kind === "point"
                    ? "points"
                    : kind === "vr"
                      ? "resources"
                      : isTour
                        ? "tours"
                        : "experiences";
                if (navigate(target)) setImportedDraft({ tab: target, id });
              }}
            />
          )}
          {tab === "configurations" && (
            <ConfigurationWorkspace
              initialId={
                importedDraft?.tab === "configurations"
                  ? importedDraft.id
                  : undefined
              }
              initialIssue={
                issueTarget?.page === tab && !issueTarget.changed
                  ? issueTarget.issue
                  : undefined
              }
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={(id) => openReview({ target: { id } })}
            />
          )}
          {tab === "guide-settings" && (
            <GuideSettings
              initialId={
                importedDraft?.tab === "guide-settings"
                  ? importedDraft.id
                  : undefined
              }
              initialIssue={
                issueTarget?.page === tab && !issueTarget.changed
                  ? issueTarget.issue
                  : undefined
              }
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={(id) => openReview({ target: { id } })}
            />
          )}
          {(tab === "experiences" || tab === "tours") && (
            <ExperienceWorkspace
              key={tab}
              initialId={
                importedDraft?.tab === tab ? importedDraft.id : undefined
              }
              initialIssue={
                issueTarget?.page === tab && !issueTarget.changed
                  ? issueTarget.issue
                  : undefined
              }
              kindScope={tab === "tours" ? "tours" : "places"}
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={(id) => openReview({ target: { id } })}
            />
          )}
          {tab === "roads" && (
            <RoadWorkspace
              initialMapId={
                importedDraft?.tab === "roads" ? importedDraft.id : undefined
              }
              maps={maps.data?.data ?? []}
              session={session}
              onDirty={onDirty}
              onUpdate={() => setRevision((v) => v + 1)}
              onReview={(id) =>
                openReview({ target: { id, kind: "navigation" } })
              }
            />
          )}
          {tab === "backups" && <BackupWorkspace key={session.user.id} session={session} />}
          {tab === "audit" && <Audit />}
          {tab === "accounts" && (
            <>
              <ErrorBox
                text={campuses.error}
                onRetry={() => setCatalogRevision((v) => v + 1)}
              />
              {campuses.data && (
                <Accounts
                  campuses={campuses.data.data}
                  currentUser={session.user}
                  onDirty={onDirty}
                />
              )}
            </>
          )}
        </main>
        <footer className="ad-app-footer">
          TwinNKU · 校园导览内容管理<span>以经确认的资料为依据</span>
        </footer>
      </div>
      {helpOpen && !locked && (
        <HelpPanel
          page={tab}
          permissions={session.permissions}
          onClose={() => {
            setHelpOpen(false);
            helpButton.current?.focus();
          }}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
