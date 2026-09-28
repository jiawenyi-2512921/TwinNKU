// Web Speech supplies browser recognition/TTS around the existing text API.
// It is deliberately turn-based: no microphone runs while a reply is spoken.
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";
type RecognitionResult = {
  isFinal: boolean;
  0: { transcript: string };
};
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};
type Utterance = Pick<SpeechSynthesisUtterance, "lang" | "onend" | "onerror">;
export type VoiceEnvironment = {
  recognize?: () => Recognition;
  utterance?: (text: string) => Utterance;
  speak?: (utterance: Utterance) => void;
  cancel?: () => void;
};
export function browserVoiceEnvironment(): VoiceEnvironment {
  const host = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  const Constructor = host.SpeechRecognition || host.webkitSpeechRecognition;
  return {
    recognize: Constructor ? () => new Constructor() : undefined,
    ...(host.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined"
      ? {
          utterance: (text: string) => new SpeechSynthesisUtterance(text),
          speak: (utterance: Utterance) =>
            host.speechSynthesis.speak(utterance as SpeechSynthesisUtterance),
          cancel: () => host.speechSynthesis.cancel(),
        }
      : {}),
  };
}

export function createVoiceConversation(
  environment: VoiceEnvironment,
  callbacks: {
    onQuestion: (question: string) => Promise<string | null>;
    onPhase: (phase: VoicePhase) => void;
    onTranscript: (text: string) => void;
    onNotice: (text: string) => void;
  },
) {
  let generation = 0;
  let active = false;
  let phase: VoicePhase = "idle";
  let recognition: Recognition | null = null;
  let utterance: Utterance | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const update = (value: VoicePhase) => {
    phase = value;
    callbacks.onPhase(value);
  };
  function cancelAudio() {
    if (recognition) {
      const previous = recognition;
      recognition = null;
      previous.onend = previous.onerror = previous.onresult = null;
      try {
        previous.abort();
      } catch {
        /* Already stopped by the browser. */
      }
    }
    if (utterance) {
      utterance.onend = utterance.onerror = null;
      utterance = null;
      environment.cancel?.();
    }
    clearTimeout(watchdog);
  }
  function stop(notice = "") {
    active = false;
    generation++;
    cancelAudio();
    callbacks.onTranscript("");
    update("idle");
    if (notice) callbacks.onNotice(notice);
  }
  function listen() {
    if (!active || !environment.recognize) return;
    const turn = ++generation;
    let submitted = false;
    try {
      recognition = environment.recognize();
      const current = recognition;
      current.lang = "zh-CN";
      current.continuous = false;
      current.interimResults = true;
      current.maxAlternatives = 1;
      current.onresult = (event) => {
        if (!active || turn !== generation || submitted) return;
        const results = Array.from(event.results);
        const transcript = results
          .map((result) => result[0].transcript)
          .join("")
          .trim();
        callbacks.onTranscript(transcript);
        if (!results.some((result) => result.isFinal)) return;
        const question = results
          .filter((result) => result.isFinal)
          .map((result) => result[0].transcript)
          .join("")
          .trim();
        if (!question) return;
        submitted = true;
        cancelAudio();
        callbacks.onTranscript("");
        update("thinking");
        void Promise.resolve()
          .then(() =>
            active && turn === generation
              ? callbacks.onQuestion(question)
              : null,
          )
          .then((answer) => {
            if (!active || turn !== generation) return;
            if (!answer) {
              stop();
              return;
            }
            if (!environment.utterance || !environment.speak) {
              callbacks.onNotice(
                "此浏览器不能朗读回答，请查看字幕；你可以继续说话。",
              );
              listen();
              return;
            }
            try {
              utterance = environment.utterance(answer);
              const spoken = utterance;
              spoken.lang = "zh-CN";
              spoken.onend = () => {
                if (!active || turn !== generation || utterance !== spoken)
                  return;
                clearTimeout(watchdog);
                spoken.onend = spoken.onerror = null;
                utterance = null;
                listen();
              };
              spoken.onerror = () => {
                if (active && turn === generation)
                  stop("朗读未能完成。可查看字幕，或点击麦克风继续。");
              };
              update("speaking");
              // Some mobile engines never dispatch onend after a system interruption.
              watchdog = setTimeout(
                () => {
                  if (active && turn === generation)
                    stop("朗读已暂停。点击麦克风继续对话。");
                },
                Math.max(15000, Math.min(180000, answer.length * 300 + 10000)),
              );
              environment.speak(spoken);
            } catch {
              stop("当前无法朗读，请查看字幕或使用文字交流。");
            }
          })
          .catch(() => {
            if (active && turn === generation)
              stop("本次语音问答未完成，请查看消息后手动重试。");
          });
      };
      current.onerror = (event) => {
        if (!active || turn !== generation) return;
        const notices: Record<string, string> = {
          "not-allowed": "麦克风未获授权。请允许麦克风后重试，也可以文字交流。",
          "service-not-allowed": "浏览器语音服务不可用，请使用文字交流。",
          "audio-capture": "未能读取麦克风，请检查设备后重试。",
          "no-speech": "暂未听到说话，语音已暂停。点击麦克风继续。",
          network: "语音识别网络不可用，请重试或使用文字交流。",
        };
        stop(notices[event.error] || "语音识别已暂停，请重试或使用文字交流。");
      };
      current.onend = () => {
        if (active && turn === generation && !submitted)
          stop("语音已暂停。点击麦克风继续说话。");
      };
      update("listening");
      current.start();
    } catch {
      stop("无法启动麦克风，请检查浏览器权限或使用文字交流。");
    }
  }
  return {
    supported: Boolean(environment.recognize),
    start() {
      stop();
      if (!environment.recognize) {
        callbacks.onNotice("当前浏览器不支持语音识别，请点击「文字交流」。");
        return;
      }
      callbacks.onNotice("");
      active = true;
      listen();
    },
    stop,
    interrupt() {
      if (!active || phase !== "speaking") return;
      generation++;
      cancelAudio();
      listen();
    },
  };
}
