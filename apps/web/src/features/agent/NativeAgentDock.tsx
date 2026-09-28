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
import {
  browserVoiceEnvironment,
  createVoiceConversation,
  type VoicePhase,
} from "./voice";
import "./native.css";

type Turn = {
  id: string;
  question: string;
  reply?: GuideReply;
  error?: string;
};
type Props = {
  current: GuideContext | null;
  request: AgentRequest | null;
  autoActions: boolean;
  pointName: string;
  mediaActive?: boolean;
  onAction: (a: GuideAction) => void;
  onNavigate: () => void;
};
const phaseNames: Record<VoicePhase, string> = {
  idle: "点击麦克风，和小开说话",
  listening: "正在聆听，说完后自动发送",
  thinking: "小开正在查阅资料…",
  speaking: "小开正在回答，随后继续聆听",
};

export function NativeAgentDock({
  current,
  request,
  pointName,
  onAction,
  onNavigate,
  autoActions,
  mediaActive = false,
}: Props) {
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [csrf, setCsrf] = useState(""),
    [code, setCode] = useState("");
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState(""),
    [voiceNotice, setVoiceNotice] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);
  const latest = useRef(current),
    seen = useRef(0),
    end = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const applied = useRef(new Set<string>()),
    mounted = useRef(true);
  const processing = useRef(false),
    chatInFlight = useRef(false),
    authGeneration = useRef(0);
  const chatAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const panelOpen = useRef(open);
  const voice = useRef<ReturnType<typeof createVoiceConversation> | null>(null);
  const submit = useRef<(text: string) => Promise<string | null>>(
    async () => null,
  );
  latest.current = current;
  panelOpen.current = open;

  useEffect(() => {
    mounted.current = true;
    voice.current = createVoiceConversation(browserVoiceEnvironment(), {
      onQuestion: (text) => submit.current(text),
      onPhase: (phase) => {
        if (mounted.current) setVoicePhase(phase);
      },
      onTranscript: (text) => {
        if (mounted.current) setTranscript(text);
      },
      onNotice: (text) => {
        if (mounted.current) setVoiceNotice(text);
      },
    });
    setVoiceSupported(voice.current.supported);
    const visibility = () => {
      if (document.visibilityState === "hidden")
        voice.current?.stop("页面已切到后台，语音已暂停。");
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      voice.current?.stop();
      voice.current = null;
      chatAbort.current?.abort();
      actionAbort.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (mediaActive)
      voice.current?.stop("正在播放视频，语音已暂停。看完后可点击麦克风继续。");
  }, [mediaActive]);
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
    voice.current?.stop();
    setQuery(contextQuestion(request.context));
    setOpen(true);
    setExpanded(true);
  }, [request]);
  useEffect(() => {
    if (open) {
      if (expanded && csrf) input.current?.focus();
      else heading.current?.focus();
    }
  }, [open, expanded, Boolean(csrf)]);
  useEffect(() => {
    if (expanded) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy, expanded]);

  function close() {
    voice.current?.stop();
    panelOpen.current = false;
    setOpen(false);
    launcher.current?.focus();
  }
  function collapse() {
    setExpanded(false);
    setOpen(true);
  }
  function typeInstead() {
    voice.current?.stop();
    setExpanded(true);
  }
  async function login() {
    if (chatInFlight.current) return;
    authGeneration.current++;
    chatInFlight.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    chatAbort.current = controller;
    try {
      const result = await post<{ csrf_token: string }>(
        "/agent/login",
        { code },
        "",
        controller.signal,
      );
      if (!mounted.current) return;
      setCsrf(result.csrf_token);
      setCode("");
      setTurns([]);
      applied.current.clear();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      chatInFlight.current = false;
      if (mounted.current) setBusy(false);
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
      (!panelOpen.current ||
        !canAutoApply(action, sentRevision ?? -1, latest.current.revision))
    )
      return;
    processing.current = true;
    const controller = new AbortController();
    const generation = authGeneration.current;
    actionAbort.current = controller;
    try {
      const before = latest.current.revision;
      const checked = await post<GuideAction>(
        "/agent/actions/resolve",
        { action, context: latest.current },
        csrf,
        controller.signal,
      );
      if (
        !mounted.current ||
        generation !== authGeneration.current ||
        (automatic && !panelOpen.current)
      )
        return;
      if (latest.current?.revision !== before) {
        setError("你已切换地点，本次未打开旧回答中的资料。");
        return;
      }
      applied.current.add(action.action_id);
      if (["open_vr", "play_video"].includes(checked.type))
        voice.current?.stop("已打开观看入口。观看结束后可点击麦克风继续交流。");
      onAction(checked);
      if (panelOpen.current) collapse();
    } catch (e) {
      if (mounted.current && generation === authGeneration.current) {
        setError(e instanceof Error ? e.message : "资料暂不可用");
        if (e instanceof NativeError && e.status === 401) {
          setCsrf("");
          voice.current?.stop();
        }
      }
    } finally {
      processing.current = false;
    }
  }
  async function send(text: string): Promise<string | null> {
    text = text.trim();
    const context = latest.current;
    if (!text || !context || chatInFlight.current || !csrf) return null;
    if (text.length > 2000) {
      setQuery(text.slice(0, 2000));
      setError("问题过长，请精简到2000字以内再发送。");
      setExpanded(true);
      return null;
    }
    chatInFlight.current = true;
    setBusy(true);
    setError("");
    setQuery("");
    const id = crypto.randomUUID(),
      controller = new AbortController();
    chatAbort.current = controller;
    setTurns((v) => [...v, { id, question: text }]);
    try {
      const reply = await post<GuideReply>(
        "/agent/chat",
        { query: text, context, request_id: id },
        csrf,
        controller.signal,
      );
      if (!mounted.current) return null;
      setTurns((v) => v.map((t) => (t.id === id ? { ...t, reply } : t)));
      if (
        autoActions &&
        reply.actions.length === 1 &&
        canAutoApply(
          reply.actions[0],
          context.revision,
          latest.current?.revision ?? -1,
        )
      )
        await act(reply.actions[0], true, context.revision);
      return reply.answer;
    } catch (e) {
      if (!mounted.current) return null;
      const message = e instanceof Error ? e.message : "本次请求失败";
      setTurns((v) =>
        v.map((t) => (t.id === id ? { ...t, error: message } : t)),
      );
      setQuery(text);
      if (e instanceof NativeError && e.status === 401) setCsrf("");
      return null;
    } finally {
      chatInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  submit.current = send;
  const last = turns.at(-1);
  const activeVoice = voicePhase !== "idle";
  function actionButtons(reply?: GuideReply) {
    return (
      reply && (
        <div className="native-actions">
          {reply.actions.map((a) => (
            <button
              key={a.action_id}
              disabled={busy}
              onClick={() => {
                applied.current.delete(a.action_id);
                void act(a);
              }}
            >
              {a.type === "play_video"
                ? "观看视频："
                : a.type === "open_vr"
                  ? "打开全景："
                  : ""}
              {a.label} →
            </button>
          ))}
        </div>
      )
    );
  }
  return (
    <div className={`agent-dock native-dock${open ? " is-open" : ""}`}>
      <button
        ref={launcher}
        className="agent-launcher"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="native-agent-panel"
      >
        <span className="agent-avatar">
          <Icon name="chat" />
        </span>
        <span>
          问小开<small>语音导览 · 随行交流</small>
        </span>
      </button>
      {open && (
        <section
          id="native-agent-panel"
          role="dialog"
          aria-modal="false"
          aria-label="小开校园导览"
          className={`native-agent${expanded ? " is-expanded" : ""}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (expanded) collapse();
              else close();
            }
          }}
        >
          <header className="agent-heading">
            <span className="agent-avatar">
              <Icon name="chat" />
            </span>
            <div>
              <h2 ref={heading} tabIndex={-1}>
                小开 · 随行导览
              </h2>
              <p>
                {pointName
                  ? `正在浏览：${pointName}`
                  : "问地点 · 看楼层 · 逛校园"}
              </p>
            </div>
            {expanded && (
              <button
                className="icon-button"
                aria-label="缩小为语音浮窗"
                onClick={collapse}
              >
                −
              </button>
            )}
            <button
              className="icon-button"
              aria-label="关闭浮窗并暂停语音"
              onClick={close}
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
                  collapse();
                  onNavigate();
                }}
              >
                直接选择起终点导航
              </button>
            </form>
          ) : (
            <>
              <div className="native-voice-controls">
                <button
                  type="button"
                  className={`native-microphone${activeVoice ? " is-active" : ""}`}
                  aria-label={activeVoice ? "暂停语音交流" : "开启语音交流"}
                  aria-pressed={activeVoice}
                  disabled={
                    (!activeVoice && busy) ||
                    mediaActive ||
                    !current ||
                    !voiceSupported
                  }
                  onClick={() =>
                    activeVoice ? voice.current?.stop() : voice.current?.start()
                  }
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
                    {activeVoice && <path d="M3 3l18 18" />}
                  </svg>
                  {activeVoice ? "暂停语音" : "开始说话"}
                </button>
                <div>
                  <p role="status">
                    {mediaActive
                      ? "视频播放中，语音已暂停"
                      : !voiceSupported
                        ? "当前可使用文字交流"
                        : busy && voicePhase === "idle"
                          ? "小开正在查阅资料…"
                          : phaseNames[voicePhase]}
                  </p>
                  <small>说完一句，小开回答后继续听</small>
                </div>
                {voicePhase === "speaking" && (
                  <button
                    type="button"
                    className="native-interrupt"
                    onClick={() => voice.current?.interrupt()}
                  >
                    打断回答
                  </button>
                )}
              </div>
              {!voiceSupported && (
                <p className="native-notice">
                  当前浏览器不支持语音识别，可点击「文字交流」继续使用。
                </p>
              )}
              {voiceNotice && (
                <p className="native-notice" role="status">
                  {voiceNotice}
                </p>
              )}
              {!expanded && (
                <div
                  className="native-subtitles"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {transcript ? (
                    <p>
                      <b>你：</b>
                      {transcript}
                    </p>
                  ) : (
                    <>
                      {last && (
                        <p className="native-last-question">
                          <b>你：</b>
                          {last.question}
                        </p>
                      )}
                      <p>
                        {last?.reply?.answer ||
                          last?.error ||
                          (busy
                            ? "正在查阅校园资料…"
                            : "你好，我是小开。点击麦克风说出问题，或展开文字交流。")}
                      </p>
                    </>
                  )}
                  {last?.reply?.notices.map((notice) => (
                    <p className="native-notice" key={notice}>
                      {notice}
                    </p>
                  ))}
                  {actionButtons(last?.reply)}
                </div>
              )}
              {expanded && (
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
                    {turns.map((t) => (
                      <article className="native-turn" key={t.id}>
                        <p className="native-question">{t.question}</p>
                        {t.reply && (
                          <>
                            <p className="native-answer">{t.reply.answer}</p>
                            {actionButtons(t.reply)}
                            {t.reply.materials.length > 0 && (
                              <details>
                                <summary>本次提供给小开的地点资料</summary>
                                {t.reply.materials.map((m) => (
                                  <button
                                    type="button"
                                    key={m.point_id}
                                    disabled={busy}
                                    onClick={() =>
                                      void act({
                                        action_id: crypto.randomUUID(),
                                        type: "focus_point",
                                        point_id: m.point_id,
                                        point_revision: m.revision,
                                        context_revision:
                                          latest.current?.revision ?? -1,
                                        label: m.label,
                                      })
                                    }
                                  >
                                    {m.label}
                                  </button>
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
                    {transcript && <p>正在识别：{transcript}</p>}
                    {busy && <p role="status">小开正在查阅资料，请稍候…</p>}
                    <div ref={end} />
                  </div>
                  <form
                    className="native-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      voice.current?.stop();
                      void send(query);
                    }}
                  >
                    <label className="sr-only" htmlFor="native-question">
                      输入问题
                    </label>
                    <textarea
                      ref={input}
                      id="native-question"
                      value={query}
                      maxLength={2000}
                      rows={2}
                      disabled={busy}
                      placeholder="例如：从图书馆到周恩来雕像怎么走？"
                      onFocus={() => voice.current?.stop()}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !turns.length ||
                            window.confirm(
                              "新建对话后不再显示当前记录，是否继续？",
                            )
                          ) {
                            voice.current?.stop();
                            authGeneration.current++;
                            actionAbort.current?.abort();
                            setCsrf("");
                            setTurns([]);
                            setError("");
                            applied.current.clear();
                          }
                        }}
                      >
                        新对话
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
              <div className="native-toolbar">
                <button
                  type="button"
                  onClick={expanded ? collapse : typeInstead}
                >
                  {expanded ? "返回小浮窗" : "文字交流与记录"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    collapse();
                    onNavigate();
                  }}
                >
                  地图选点导航
                </button>
              </div>
              {!activeVoice && !turns.length && (
                <p className="native-voice-hint">
                  开启语音需允许麦克风，识别可能使用浏览器提供的在线服务。
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
