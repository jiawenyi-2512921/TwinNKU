import { useEffect, useRef, useState } from "react";
import { api, get } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import type { AgentRequest } from "./AgentDock";
import { contextQuestion } from "./protocol";
import { externalPanoramaUrl } from "../points/panorama";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { Companion } from "./Companion";
import { useCompanionPosition } from "./useCompanionPosition";
import {
  canAutoApply,
  NativeError,
  post,
  type GuideAction,
  type GuideContext,
  type GuideReply,
  type GuideActionOptions,
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
  onAction: (a: GuideAction, options?: GuideActionOptions) => boolean;
  onCancelAction?: () => void;
  onNavigate: () => void;
};
export function NativeAgentDock({
  current,
  request,
  pointName,
  onAction,
  onNavigate,
  onCancelAction,
  autoActions,
  mediaActive = false,
}: Props) {
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [checkingSession, setCheckingSession] = useState(false);
  const [csrf, setCsrf] = useState(""),
    [code, setCode] = useState("");
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState(""),
    [voiceNotice, setVoiceNotice] = useState("");
  const [voiceCaption, setVoiceCaption] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [verifiedVr, setVerifiedVr] = useState<{
    url: string;
    label: string;
    contextRevision: number;
  } | null>(null);
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
  const actionGeneration = useRef(0);
  const chatAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const pendingVr = useRef<{ tab: Window | null } | null>(null);
  const automaticPending = useRef(false);
  const panelOpen = useRef(open);
  const voice = useRef<ReturnType<typeof createVoiceConversation> | null>(null);
  const authIntent = useRef<"voice" | "text" | null>(null);
  const mediaPlaying = useRef(mediaActive);
  const position = useCompanionPosition();
  const submit = useRef<(text: string) => Promise<string | null>>(
    async () => null,
  );
  latest.current = current;
  panelOpen.current = open;
  mediaPlaying.current = mediaActive;

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
      onCaption: (text) => {
        if (mounted.current) setVoiceCaption(text);
      },
      onNotice: (text) => {
        if (mounted.current) {
          setVoiceNotice(text);
          if (text) setActionStatus("");
        }
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
      closePendingVr();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (mediaActive)
      voice.current?.stop("正在播放视频，语音已暂停。看完后可点击麦克风继续。");
  }, [mediaActive]);
  useEffect(() => {
    if (!verifiedVr) return;
    // A blocked-popup fallback is a short-lived verified link, not a permanent
    // copy of a resource URL. Publication/resume/visible polling expires it.
    return watchCatalogChanges(() => {
      setVerifiedVr(null);
      setActionStatus("");
      setVoiceNotice("资料可能已更新，请再次点击「打开全景」核验后打开。");
    });
  }, [verifiedVr]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(),
      generation = authGeneration.current;
    get<{ csrf_token: string }>("/agent/session", controller.signal)
      .then((r) => {
        if (
          !controller.signal.aborted &&
          generation === authGeneration.current
        ) {
          setCsrf(r.data.csrf_token);
          setCheckingSession(false);
          if (authIntent.current === "voice") {
            authIntent.current = null;
            setExpanded(false);
            beginVoice();
          }
        }
      })
      .catch((e) => {
        if (
          !controller.signal.aborted &&
          generation === authGeneration.current
        ) {
          setCheckingSession(false);
          if (e.status === 401) {
            voice.current?.stop();
            setCsrf("");
            setExpanded(true);
          } else {
            setError("暂时无法连接小开，请稍后重试。");
          }
        }
      });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!request || seen.current === request.sequence) return;
    seen.current = request.sequence;
    voice.current?.stop();
    authIntent.current = "text";
    setMinimized(false);
    setQuery(contextQuestion(request.context));
    setOpen(true);
    setExpanded(true);
  }, [request]);
  useEffect(() => {
    if (open) {
      if (expanded && csrf) input.current?.focus();
      else if (!csrf) heading.current?.focus();
    }
  }, [open, expanded, Boolean(csrf)]);
  useEffect(() => {
    if (expanded) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy, expanded]);

  function close() {
    voice.current?.stop();
    authIntent.current = null;
    actionGeneration.current++;
    setActionStatus("");
    onCancelAction?.();
    if (pendingVr.current || automaticPending.current) {
      actionAbort.current?.abort();
      closePendingVr();
    }
    panelOpen.current = false;
    setOpen(false);
    setExpanded(false);
    setMinimized(true);
    setCheckingSession(false);
    launcher.current?.focus();
  }
  function collapse() {
    setExpanded(false);
    setOpen(true);
    launcher.current?.focus();
  }
  function typeInstead() {
    voice.current?.stop();
    authIntent.current = "text";
    setMinimized(false);
    if (!open && !csrf) setCheckingSession(true);
    setOpen(true);
    setExpanded(true);
  }
  function beginVoice() {
    setError("");
    setActionStatus("");
    if (document.visibilityState !== "visible") {
      setVoiceNotice("页面已切到后台，语音已暂停。");
      return;
    }
    if (mediaPlaying.current) {
      setVoiceNotice("视频播放中，语音已暂停。");
      return;
    }
    if (!latest.current) {
      setVoiceNotice("请先等待校园地图加载完成。");
      return;
    }
    if (!voice.current?.supported) {
      setVoiceNotice("当前浏览器不支持语音识别，可点对话图标使用文字交流。");
      return;
    }
    setVoiceNotice("");
    voice.current.start();
  }
  function toggleVoice() {
    if (minimized) {
      setMinimized(false);
      return;
    }
    if (voicePhase !== "idle") {
      voice.current?.stop();
      return;
    }
    if (busy || checkingSession) return;
    setOpen(true);
    if (!csrf) {
      authIntent.current = "voice";
      setExpanded(true);
      if (!open) setCheckingSession(true);
      return;
    }
    setExpanded(false);
    beginVoice();
  }
  function closePendingVr() {
    const tab = pendingVr.current?.tab;
    pendingVr.current = null;
    try {
      if (tab && !tab.closed) tab.close();
    } catch {
      /* Detached window. */
    }
  }
  function reserveVrTab(): { tab: Window | null } {
    let tab: Window | null = null;
    try {
      tab = window.open("about:blank", "_blank");
      if (tab) {
        tab.opener = null;
        if (tab.opener !== null) throw new Error("无法隔离新窗口");
        tab.document.title = "正在核验全景";
        tab.document.body.textContent = "正在打开已发布的全景资料，请稍候…";
      }
    } catch {
      try {
        tab?.close();
      } catch {
        /* No controllable popup. */
      }
      tab = null;
    }
    const reservation = { tab };
    pendingVr.current = reservation;
    return reservation;
  }
  async function login() {
    if (chatInFlight.current) return;
    authGeneration.current++;
    actionGeneration.current++;
    onCancelAction?.();
    closePendingVr();
    setVerifiedVr(null);
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
      if (authIntent.current === "voice") {
        authIntent.current = null;
        setExpanded(false);
        beginVoice();
      }
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
    automaticActionId?: string | null,
  ): Promise<string | null> {
    if (
      !latest.current ||
      processing.current ||
      applied.current.has(action.action_id)
    )
      return null;
    if (
      automatic &&
      (!panelOpen.current ||
        !canAutoApply(
          action,
          sentRevision ?? -1,
          latest.current.revision,
          automaticActionId,
        ))
    )
      return null;
    processing.current = true;
    automaticPending.current = automatic;
    setActing(true);
    setActionStatus("正在核验并打开资料…");
    setError("");
    const controller = new AbortController();
    const generation = authGeneration.current;
    actionAbort.current = controller;
    let reservation: { tab: Window | null } | null = null;
    let navigated = false;
    if (action.type === "open_vr") {
      // A manual click can reserve a tab before awaiting validation. An explicit
      // voice/text command tries only after verification and may be popup-blocked.
      voice.current?.stop("正在核验全景，语音已暂停。");
      setVerifiedVr(null);
      if (!automatic) reservation = reserveVrTab();
    }
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
        controller.signal.aborted ||
        generation !== authGeneration.current ||
        (automatic && !panelOpen.current)
      )
        return null;
      if (latest.current?.revision !== before) {
        setActionStatus("");
        const message = "你已切换地点，本次未打开旧回答中的资料。";
        setError(message);
        return message;
      }
      if (
        checked.type !== action.type ||
        checked.action_id !== action.action_id
      )
        throw new Error("核验结果与请求不符，本次未执行，请重新提问。");
      if (action.type === "open_vr") {
        if (checked.type !== "open_vr" || !checked.resource_id)
          throw new Error("未能核验指定全景，请重新提问。");
        const { data } = await api.panoramas(
          checked.point_id,
          controller.signal,
        );
        if (
          !mounted.current ||
          controller.signal.aborted ||
          generation !== authGeneration.current
        )
          return null;
        if (latest.current?.revision !== before) {
          setActionStatus("");
          const message = "你已切换地点，本次未打开旧回答中的全景。";
          setError(message);
          return message;
        }
        const resource = data.find(
          (item) =>
            item.id === checked.resource_id &&
            item.point_id === checked.point_id &&
            item.revision === checked.resource_revision,
        );
        const url = resource && externalPanoramaUrl(resource.url);
        if (!url)
          throw new Error("全景资料已更新、下架或链接不可用，请重新提问。");
        if (automatic) reservation = reserveVrTab();
        applied.current.add(action.action_id);
        if (reservation?.tab && !reservation.tab.closed) {
          try {
            reservation.tab.location.replace(url);
            navigated = true;
          } catch {
            /* Offer the verified link below. */
          }
        }
        if (!navigated)
          setVerifiedVr({
            url,
            label: resource.title,
            contextRevision: before,
          });
        const outcome = navigated
          ? "已请求在新标签页打开全景；返回这里可继续导览。"
          : "全景未在新窗口打开，可能被浏览器拦截。请点击小开旁的全景图标。";
        setActionStatus(outcome);
        setVoiceNotice("");
        if (panelOpen.current) collapse();
        return outcome;
      }
      if (checked.type === "play_video")
        voice.current?.stop(
          "视频入口已打开，语音已暂停。观看结束后可点击麦克风继续交流。",
        );
      const accepted = onAction(checked, {
        requestedPlayback: automatic && checked.type === "play_video",
      });
      if (!accepted)
        throw new Error("地点资料已变化，本次未执行。请重新选择地点或提问。");
      applied.current.add(action.action_id);
      const status: Record<string, string> = {
        focus_point: "已切换到对应地点。",
        show_floor: "已转到楼层资料。",
        show_route: "已打开路线规划；路线结果以地图显示为准。",
        show_checkin: "已转到打卡资料。",
        show_tour: "已转到校园导览。",
        play_video: automatic
          ? "已打开视频入口；浏览器可能仍需你点击播放或原站链接。"
          : "已打开视频资料，请选择是否观看。",
      };
      const outcome = status[checked.type] || "已提交查看请求。";
      setActionStatus(outcome);
      if (panelOpen.current) collapse();
      return outcome;
    } catch (e) {
      if (controller.signal.aborted) return null;
      if (mounted.current && generation === authGeneration.current) {
        setActionStatus("");
        const message = e instanceof Error ? e.message : "资料暂不可用";
        setError(message);
        if (e instanceof NativeError && e.status === 401) {
          setCsrf("");
          voice.current?.stop();
        }
        return `本次未能完成操作：${message}`;
      }
      return null;
    } finally {
      if (reservation && !navigated) {
        try {
          if (reservation.tab && !reservation.tab.closed)
            reservation.tab.close();
        } catch {
          /* Detached window. */
        }
      }
      if (pendingVr.current === reservation) pendingVr.current = null;
      processing.current = false;
      automaticPending.current = false;
      if (mounted.current) setActing(false);
    }
  }
  async function send(text: string): Promise<string | null> {
    text = text.trim();
    const context = latest.current;
    const sentActionGeneration = actionGeneration.current;
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
    setActionStatus("");
    setVoiceNotice("");
    setVoiceCaption("");
    setVerifiedVr(null);
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
        sentActionGeneration === actionGeneration.current &&
        reply.actions.length === 1 &&
        canAutoApply(
          reply.actions[0],
          context.revision,
          latest.current?.revision ?? -1,
          reply.automatic_action_id,
        )
      ) {
        const outcome = await act(
          reply.actions[0],
          true,
          context.revision,
          reply.automatic_action_id,
        );
        return outcome ? `${reply.answer}\n${outcome}` : null;
      }
      return reply.answer;
    } catch (e) {
      if (!mounted.current) return null;
      const message = e instanceof Error ? e.message : "本次请求失败";
      setTurns((v) =>
        v.map((t) => (t.id === id ? { ...t, error: message } : t)),
      );
      setQuery(text);
      setError(message);
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
  // Captions are the only visible copy in the companion surface. Detailed
  // sources and action suggestions remain in the explicitly opened drawer.
  const caption =
    error ||
    transcript ||
    (voicePhase === "speaking" ? voiceCaption : "") ||
    actionStatus ||
    voiceNotice ||
    (busy ? "正在查阅校园资料…" : "") ||
    voiceCaption ||
    last?.reply?.answer?.match(
      /^[\s\S]{1,150}?[。！？!?](?:\s|$)?|^[\s\S]{1,150}/,
    )?.[0] ||
    last?.error ||
    "";
  const verifiedLink =
    csrf && verifiedVr && verifiedVr.contextRevision === current?.revision
      ? verifiedVr
      : null;
  const hasSuggestions = Boolean(
    last?.reply?.actions.length || last?.reply?.materials.length,
  );
  const voiceLabel = activeVoice ? "暂停语音交流" : "开启语音交流";
  function escape(e: React.KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (expanded) collapse();
    else close();
  }
  return (
    <div className="agent-dock native-dock">
      <div
        ref={position.containerRef}
        style={position.style}
        className={`native-companion-cluster${minimized ? " is-minimized" : ""}`}
        onKeyDown={escape}
      >
        <Companion
          buttonRef={launcher}
          buttonProps={{
            ...position.buttonProps,
            "aria-describedby": "native-companion-help",
          }}
          className="native-companion"
          phase={
            minimized
              ? "idle"
              : error
                ? "error"
                : acting
                  ? "acting"
                  : busy || checkingSession
                    ? "thinking"
                    : voicePhase
          }
          quiet={minimized}
          label={minimized ? "展开小开" : `小开：${voiceLabel}；可拖动调整位置`}
          onClick={toggleVoice}
          expanded={expanded}
          controls="native-agent-panel"
        />
        <span id="native-companion-help" className="sr-only">
          点击角色开始或暂停语音；拖动调整位置，也可用方向键移动，按住 Shift
          加快。
        </span>
        {!minimized && (
          <div
            className="native-orbit-controls"
            role="group"
            aria-label="小开交互"
          >
            <button
              type="button"
              className={`native-orbit-button native-microphone${activeVoice ? " is-active" : ""}`}
              aria-label={voiceLabel}
              aria-pressed={activeVoice}
              disabled={
                (!activeVoice && busy) ||
                checkingSession ||
                mediaActive ||
                !current
              }
              onClick={toggleVoice}
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
            </button>
            <button
              type="button"
              className={`native-orbit-button${hasSuggestions ? " has-results" : ""}`}
              aria-label="文字交流与记录"
              aria-expanded={expanded}
              aria-controls="native-agent-panel"
              onClick={expanded ? collapse : typeInstead}
            >
              <Icon name="chat" />
              {hasSuggestions && (
                <span className="native-result-dot" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="native-orbit-button"
              aria-label="收起小开并暂停语音"
              onClick={close}
            >
              <Icon name="minus" />
            </button>
          </div>
        )}
        {!minimized && voicePhase === "speaking" && (
          <button
            type="button"
            className="native-orbit-button native-interrupt"
            aria-label="打断回答并继续聆听"
            onClick={() => voice.current?.interrupt()}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M7 5h4v14H7zm6 0h4v14h-4z" />
            </svg>
          </button>
        )}
        {!minimized && verifiedLink && (
          <a
            className="native-orbit-button native-verified-vr"
            href={verifiedLink.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`打开${verifiedLink.label}（新窗口）`}
            onClick={() => voice.current?.stop()}
          >
            <Icon name="panorama" />
          </a>
        )}
      </div>
      {open && !expanded && !minimized && caption && (
        <div
          id="native-agent-captions"
          className={`native-subtitles${error ? " is-error" : ""}`}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <p>{caption}</p>
        </div>
      )}
      {open && expanded && !minimized && (
        <section
          id="native-agent-panel"
          role="dialog"
          aria-modal="false"
          aria-label="小开校园导览"
          className={`native-agent is-expanded${!csrf ? " needs-auth" : ""}`}
          onKeyDown={escape}
        >
          <header className="agent-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                小开
              </h2>
              <p>{pointName ? `正在浏览：${pointName}` : "校园导览"}</p>
            </div>
            <button
              className="icon-button"
              aria-label="收起文字抽屉"
              onClick={collapse}
            >
              <Icon name="minus" />
            </button>
            <button
              className="icon-button"
              aria-label="收起小开并暂停语音"
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
          {actionStatus && (
            <p className="native-notice native-action-status" role="status">
              {actionStatus}
            </p>
          )}
          {voiceNotice && (
            <p className="native-notice" role="status">
              {voiceNotice}
            </p>
          )}
          {!csrf ? (
            checkingSession ? (
              <p className="native-notice" role="status">
                正在连接小开…
              </p>
            ) : (
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
            )
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
                        window.confirm("新建对话后不再显示当前记录，是否继续？")
                      ) {
                        voice.current?.stop();
                        onCancelAction?.();
                        authGeneration.current++;
                        actionGeneration.current++;
                        actionAbort.current?.abort();
                        closePendingVr();
                        setVerifiedVr(null);
                        setCsrf("");
                        setTurns([]);
                        setError("");
                        setActionStatus("");
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
              <div className="native-toolbar">
                <button
                  type="button"
                  onClick={() => {
                    collapse();
                    onNavigate();
                  }}
                >
                  地图选点导航
                </button>
                <button
                  type="button"
                  onClick={() => {
                    position.resetPosition();
                    collapse();
                  }}
                >
                  重置角色位置
                </button>
              </div>
              <p className="native-voice-hint">
                {voiceSupported
                  ? "开启语音需允许麦克风，识别可能使用浏览器提供的在线服务。"
                  : "当前浏览器不支持语音识别，可在这里继续文字交流。"}
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
