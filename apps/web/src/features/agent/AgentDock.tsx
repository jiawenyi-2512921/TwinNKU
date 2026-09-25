import { useEffect, useRef, useState } from "react";
import type { AgentWebConfig } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import {
  FRAME_CHANNEL,
  contextKey,
  contextQuestion,
  isFrameMessage,
  safeContext,
  type AgentContext,
  type FrameStatus,
} from "./protocol";
import "./agent.css";

export type AgentRequest = { sequence: number; context: AgentContext };
type FrameSession = { instance: string; context: AgentContext };
function makeSession(context: AgentContext): FrameSession {
  return { instance: crypto.randomUUID(), context: safeContext(context) };
}

export function AgentDock({
  config,
  current,
  request,
}: {
  config: AgentWebConfig | null;
  current: AgentContext;
  request: AgentRequest | null;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<FrameSession | null>(null);
  const [proposed, setProposed] = useState<AgentContext | null>(null);
  const [state, setState] = useState<FrameStatus>("loading");
  const [errorCode, setErrorCode] = useState("");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [copyStatus, setCopyStatus] = useState("");
  const [showReload, setShowReload] = useState(false);
  const [showQuestion, setShowQuestion] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const seenRequest = useRef(0);
  const configKey = JSON.stringify([
    config?.enabled,
    config?.app_key,
    config?.context_enabled,
    config?.hide_sidebar,
  ]);

  useEffect(() => {
    // Recreate the frame only when deployment config changes, never on ordinary polling.
    setSession(null);
    setOpen(false);
    setProposed(null);
  }, [configKey]);

  useEffect(() => {
    if (
      !config?.enabled ||
      !request ||
      request.sequence === seenRequest.current
    )
      return;
    seenRequest.current = request.sequence;
    setOpen(true);
    setShowQuestion(true);
    setProposed(request.context);
    setSession((before) => before ?? makeSession(request.context));
  }, [request, config?.enabled]);

  useEffect(() => {
    const element = panel.current;
    if (!element || !config?.enabled) return;
    const media = window.matchMedia("(max-width: 760px)");
    function sync() {
      if (!element) return;
      if (element.open) element.close();
      if (open) {
        if (media.matches) element.showModal();
        else element.show();
      }
    }
    sync();
    media.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      if (element.open) element.close();
    };
  }, [open, config?.enabled]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    setState("loading");
    setErrorCode("");
    setCopyStatus("");
    setShowReload(false);
    const timer = window.setTimeout(() => {
      setState("error");
      setErrorCode("FRAME_TIMEOUT");
    }, 45000);
    function receive(event: MessageEvent) {
      if (
        !session ||
        !isFrameMessage(
          event,
          frame.current?.contentWindow ?? null,
          window.location.origin,
          session.instance,
        )
      )
        return;
      if (event.data.type === "booted") {
        frame.current?.contentWindow?.postMessage(
          {
            channel: FRAME_CHANNEL,
            instance: session.instance,
            type: "initialize",
            context: session.context,
          },
          window.location.origin,
        );
      } else {
        setState(event.data.type);
        if (event.data.type === "initialized" || event.data.type === "error")
          window.clearTimeout(timer);
        if (event.data.type === "error")
          setErrorCode(event.data.code ?? "CONNECTION_FAILED");
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [session]);

  if (!config?.enabled) return null;
  // A floor request may add floor context, but must never pin an old point/map
  // revision after the published catalog has refreshed.
  const desired =
    proposed?.point_id === current.point_id
      ? {
          ...current,
          floor_id: proposed.floor_id,
          floor_label: proposed.floor_label,
          floor_section: proposed.floor_section,
        }
      : current;
  const changed = Boolean(
    session && contextKey(session.context) !== contextKey(desired),
  );
  const question = contextQuestion(desired);
  function close() {
    setOpen(false);
    window.requestAnimationFrame(() => launcher.current?.focus());
  }
  function restart(context: AgentContext) {
    setSession(makeSession(context));
    setProposed(context);
    setShowReload(false);
  }
  async function copyQuestion() {
    try {
      await navigator.clipboard.writeText(question);
      setCopyStatus("已复制，请在下方对话框粘贴发送。");
    } catch {
      setCopyStatus("请选中下方问题文字，手动复制后发送。");
    }
  }
  return (
    <div className={`agent-dock${open ? " is-open" : ""}`}>
      <button
        ref={launcher}
        className="agent-launcher"
        aria-expanded={open}
        aria-controls="agent-panel"
        onClick={() => {
          setSession((before) => before ?? makeSession(current));
          setOpen((value) => !value);
        }}
      >
        <span className="agent-avatar">
          <Icon name="chat" size={23} />
        </span>
        <span>
          问小开<small>校园 AI 导览</small>
        </span>
      </button>
      <dialog
        id="agent-panel"
        ref={panel}
        className="agent-panel"
        aria-labelledby="agent-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          event.stopPropagation();
        }}
      >
        <header className="agent-heading">
          <span className="agent-avatar">
            <Icon name="chat" size={23} />
          </span>
          <div>
            <h2 id="agent-title">小开</h2>
            <p>陪你了解南开的空间与故事</p>
          </div>
          <button
            className="icon-button"
            aria-label="重新加载对话"
            onClick={() => setShowReload((value) => !value)}
          >
            <Icon name="refresh" size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="收起小开，返回地图"
            onClick={close}
            autoFocus
          >
            <Icon name="close" />
          </button>
        </header>
        {offline && (
          <p className="agent-notice" role="status">
            网络已断开。恢复连接后可以继续尝试。
          </p>
        )}
        {showReload && (
          <div className="agent-notice" role="status">
            <p>
              重新加载会重建聊天窗口，未发送的文字可能丢失。历史会话由平台管理。
            </p>
            <button onClick={() => restart(desired)}>确认重新加载</button>
            <button onClick={() => setShowReload(false)}>取消</button>
          </div>
        )}
        <div className="agent-context">
          <Icon name="pin" size={16} />
          <span>
            {config.context_enabled ? "对话地点：" : "当前浏览："}
            {(config.context_enabled
              ? session?.context.point_name
              : desired.point_name) || "津南校区"}
            {config.context_enabled && session?.context.floor_label
              ? ` · ${session.context.floor_label}`
              : ""}
          </span>
          <button
            onClick={() => setShowQuestion((value) => !value)}
            aria-expanded={showQuestion}
          >
            提问建议
          </button>
        </div>
        {changed && config.context_enabled && (
          <div className="agent-notice">
            <p>
              你正在查看{desired.point_name || "校园地图"}
              {desired.floor_label}。当前对话仍沿用上方地点。
            </p>
            <button onClick={() => restart(desired)}>切换讲解地点并重载</button>
            <small>未发送的文字可能丢失，也可以直接在对话中说出新地点。</small>
          </div>
        )}
        {showQuestion && (
          <div className="agent-suggestion">
            <p>{question}</p>
            <button onClick={copyQuestion}>复制这段问题</button>
            <span role="status">
              {copyStatus || "复制后，在下方对话框粘贴发送。"}
            </span>
          </div>
        )}
        <div className="agent-content" aria-busy={state === "loading"}>
          {session && (
            <iframe
              key={session.instance}
              ref={frame}
              className="agent-frame"
              title="小开的校园对话"
              src={`/agent/embed.html#instance=${encodeURIComponent(session.instance)}`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() =>
                frame.current?.contentWindow?.postMessage(
                  {
                    channel: FRAME_CHANNEL,
                    instance: session.instance,
                    type: "initialize",
                    context: session.context,
                  },
                  window.location.origin,
                )
              }
            />
          )}
          {state === "loading" && (
            <div className="agent-loading" role="status">
              <span className="spinner" />
              正在连接小开…
            </div>
          )}
          {state === "error" && (
            <div className="agent-error" role="alert">
              <Icon name="chat" size={32} />
              <h3>暂时无法连接小开</h3>
              <p>
                校园对话服务可能暂不可达。你仍可以查看地图、地点介绍和楼层图。
              </p>
              <button
                className="primary-button"
                onClick={() => restart(desired)}
                disabled={offline}
              >
                重新加载
              </button>
              <button className="text-button" onClick={close}>
                返回地图
              </button>
              <details>
                <summary>连接帮助</summary>
                <p>
                  若窗口提示登录，请按平台指引登录后再试。持续失败时可向维护者反馈此代码：
                  {errorCode}。
                </p>
                <a
                  href="https://coze.nankai.edu.cn"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开 NK-GeniOS 平台
                </a>
              </details>
            </div>
          )}
        </div>
        <footer className="agent-footer">
          AI 回答请结合资料来源核对，开放与入校信息以学校最新公告为准。
        </footer>
      </dialog>
    </div>
  );
}
