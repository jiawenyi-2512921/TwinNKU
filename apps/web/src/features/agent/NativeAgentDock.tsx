import { useEffect, useRef, useState } from "react";
import { get } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import type { AgentRequest } from "./AgentDock";
import { contextQuestion } from "./protocol";
import {
  canAutoApply,
  NativeError,
  post,
  type GuideAction,
  type GuideContext,
  type GuideReply,
} from "./native";
import "./native.css";

type Turn = { question: string; reply?: GuideReply; error?: string };
type Props = {
  current: GuideContext | null;
  request: AgentRequest | null;
  autoActions: boolean;
  pointName: string;
  onAction: (a: GuideAction) => void;
  onNavigate: () => void;
};

export function NativeAgentDock({
  current,
  request,
  pointName,
  onAction,
  onNavigate,
  autoActions,
}: Props) {
  const [open, setOpen] = useState(false),
    [csrf, setCsrf] = useState(""),
    [code, setCode] = useState("");
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const dialog = useRef<HTMLDialogElement>(null),
    latest = useRef(current),
    seen = useRef(0);
  const end = useRef<HTMLDivElement>(null),
    applied = useRef(new Set<string>()),
    mounted = useRef(true);
  const processing = useRef(false),
    authGeneration = useRef(0);
  latest.current = current;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(),
      generation = authGeneration.current;
    get<{ csrf_token: string }>("/agent/session", controller.signal)
      .then((r) => {
        if (!controller.signal.aborted && generation === authGeneration.current)
          setCsrf(r.data.csrf_token);
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          generation === authGeneration.current &&
          e.status === 401
        )
          setCsrf("");
      });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!request || seen.current === request.sequence) return;
    seen.current = request.sequence;
    setQuery(contextQuestion(request.context));
    setOpen(true);
  }, [request]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const media = matchMedia("(max-width: 760px)");
    const sync = () => {
      if (d.open) d.close();
      if (open) {
        if (media.matches) d.showModal();
        else d.show();
      }
    };
    sync();
    media.addEventListener("change", sync);
    return () => {
      media.removeEventListener("change", sync);
      if (d.open) d.close();
    };
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);
  async function login() {
    authGeneration.current++;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ csrf_token: string }>("/agent/login", {
        code,
      });
      setCsrf(result.csrf_token);
      setCode("");
      setTurns([]);
      applied.current.clear();
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }
  async function act(
    action: GuideAction,
    automatic = false,
    sentRevision = current?.revision,
  ) {
    if (
      !latest.current ||
      processing.current ||
      applied.current.has(action.action_id)
    )
      return;
    if (
      automatic &&
      !canAutoApply(action, sentRevision ?? -1, latest.current.revision)
    )
      return;
    processing.current = true;
    try {
      const before = latest.current.revision;
      const checked = await post<GuideAction>(
        "/agent/actions/resolve",
        { action, context: latest.current },
        csrf,
      );
      if (!mounted.current || latest.current?.revision !== before) {
        setError("你已切换地点，本次未自动打开旧回答中的资料。");
        return;
      }
      applied.current.add(action.action_id);
      onAction(checked);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "资料暂不可用");
    } finally {
      processing.current = false;
    }
  }
  async function send() {
    const text = query.trim(),
      context = latest.current;
    if (!text || !context || busy) return;
    setBusy(true);
    setError("");
    setQuery("");
    const index = turns.length;
    setTurns((v) => [...v, { question: text }]);
    try {
      const reply = await post<GuideReply>(
        "/agent/chat",
        { query: text, context, request_id: crypto.randomUUID() },
        csrf,
      );
      if (!mounted.current) return;
      setTurns((v) => v.map((t, i) => (i === index ? { ...t, reply } : t)));
      if (
        autoActions &&
        reply.actions.length === 1 &&
        canAutoApply(
          reply.actions[0],
          context.revision,
          latest.current?.revision ?? -1,
        )
      ) {
        await act(reply.actions[0], true, context.revision);
      }
    } catch (e) {
      if (!mounted.current) return;
      const message = e instanceof Error ? e.message : "本次请求失败";
      setTurns((v) =>
        v.map((t, i) => (i === index ? { ...t, error: message } : t)),
      );
      setQuery(text);
      if (e instanceof NativeError && e.status === 401) setCsrf("");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className={`agent-dock${open ? " is-open" : ""}`}>
      <button
        className="agent-launcher"
        onClick={() => setOpen(true)}
        aria-expanded={open}
      >
        <span className="agent-avatar">
          <Icon name="chat" />
        </span>
        <span>
          问小开<small>问地点 · 看实景 · 查路线</small>
        </span>
      </button>
      <dialog
        ref={dialog}
        className="agent-panel native-agent"
        aria-label="小开校园导览"
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
      >
        <header className="agent-heading">
          <span className="agent-avatar">
            <Icon name="chat" />
          </span>
          <div>
            <h2>小开</h2>
            <p>
              {pointName ? `正在浏览：${pointName}` : "从一个问题，走近南开"}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="收起小开"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" />
          </button>
        </header>
        {error && (
          <p className="native-notice" role="alert">
            {error}
          </p>
        )}
        {!csrf ? (
          <form
            className="native-login"
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <h3>开始校园导览</h3>
            <p>输入访问口令，建立独立对话。</p>
            <label>
              访问口令
              <input
                type="password"
                value={code}
                minLength={16}
                maxLength={128}
                required
                autoComplete="off"
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy}>
              {busy ? "正在连接…" : "开始对话"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              直接选择起终点导航
            </button>
          </form>
        ) : (
          <>
            <div
              className="native-messages"
              aria-live="polite"
              aria-busy={busy}
            >
              {!turns.length && (
                <div className="native-welcome">
                  <h3>你想去哪里？</h3>
                  <p>可以询问地点、楼层、全景，或说明从哪里出发。</p>
                  {["帮我定位图书馆", "我想去周恩来雕像"].map((q) => (
                    <button key={q} onClick={() => setQuery(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((t, i) => (
                <article className="native-turn" key={i}>
                  <p className="native-question">{t.question}</p>
                  {t.reply && (
                    <>
                      <p className="native-answer">{t.reply.answer}</p>
                      <div className="native-actions">
                        {t.reply.actions.map((a) => (
                          <button
                            key={a.action_id}
                            disabled={busy}
                            onClick={() => {
                              applied.current.delete(a.action_id);
                              void act(a);
                            }}
                          >
                            {a.label} →
                          </button>
                        ))}
                      </div>
                      {t.reply.materials.length > 0 && (
                        <details>
                          <summary>本次提供给小开的地点资料</summary>
                          {t.reply.materials.map((m) => (
                            <a
                              key={m.point_id}
                              href={`/?point=${encodeURIComponent(m.point_id)}`}
                            >
                              {m.label}
                            </a>
                          ))}
                        </details>
                      )}
                      {t.reply.notices.map((n) => (
                        <p className="native-notice" key={n}>
                          {n}
                        </p>
                      ))}
                    </>
                  )}
                  {t.error && (
                    <p className="native-notice" role="alert">
                      {t.error}
                    </p>
                  )}
                </article>
              ))}
              {busy && <p role="status">小开正在查阅资料，请稍候…</p>}
              <div ref={end} />
            </div>
            <form
              className="native-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="native-question">
                输入问题
              </label>
              <textarea
                id="native-question"
                value={query}
                maxLength={2000}
                rows={3}
                disabled={busy}
                placeholder="例如：从图书馆到周恩来雕像怎么走？"
                onChange={(e) => setQuery(e.target.value)}
              />
              <div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !turns.length ||
                      window.confirm("新建对话后不再显示当前记录，是否继续？")
                    ) {
                      setCsrf("");
                      setTurns([]);
                      setError("");
                    }
                  }}
                >
                  新对话
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onNavigate();
                  }}
                >
                  地图导航
                </button>
                <button
                  className="primary-button"
                  disabled={busy || !current || !query.trim()}
                >
                  发送
                </button>
              </div>
            </form>
          </>
        )}
        <footer className="agent-footer">开放与入校安排以学校公告为准。</footer>
      </dialog>
    </div>
  );
}
