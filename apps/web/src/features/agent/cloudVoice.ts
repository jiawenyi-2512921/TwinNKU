// Same-origin cloud TTS with one persistent player and explicit playback recovery.
import { speechCaptionAt, splitSpeechCaptions } from "./captions.ts";
import type { VoiceEnvironment } from "./voice.ts";

export type CloudSpeechState = "idle" | "loading" | "speaking" | "blocked";
type Caption = (text: string) => void;
export type CloudSpeechDeps = {
  fetchImpl?: typeof fetch;
  createAudio?: () => HTMLAudioElement;
  fallbackSpeak?: (
    text: string,
    onDone: (success?: boolean) => void,
    onCaption?: Caption,
  ) => void | boolean;
  fallbackCancel?: () => void;
  onState?: (state: CloudSpeechState) => void;
  onFallback?: (reason: string) => void;
  onSilent?: (message: string) => void;
};

/** Completion/error events, rather than calling speak(), determine success. */
export function createBrowserSpeechFallback(environment: VoiceEnvironment) {
  let finish: ((success: boolean) => void) | null = null;
  function cancel() {
    finish?.(false);
    environment.cancel?.();
  }
  return {
    cancel,
    speak(
      text: string,
      done: (success?: boolean) => void,
      onCaption?: Caption,
    ) {
      cancel();
      const spoken = environment.utterance?.(text);
      if (!spoken || !environment.speak) {
        done(false);
        return;
      }
      const captions = splitSpeechCaptions(text);
      let boundaryIndex = -1;
      let settled = false;
      const timer = setTimeout(
        () => complete(false),
        Math.max(8000, Math.min(120000, text.length * 250 + 4000)),
      );
      function complete(success: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        spoken!.onend = spoken!.onerror = spoken!.onboundary = null;
        if (finish === complete) finish = null;
        done(success);
      }
      finish = complete;
      spoken.lang = "zh-CN";
      spoken.onend = () => complete(true);
      spoken.onerror = () => complete(false);
      spoken.onboundary = (event) => {
        if (settled || event.charIndex < boundaryIndex) return;
        const next = speechCaptionAt(captions, event.charIndex);
        if (!next) return;
        boundaryIndex = event.charIndex;
        onCaption?.(next.text);
      };
      onCaption?.(captions[0]?.text || "");
      try {
        environment.speak(spoken);
      } catch {
        complete(false);
      }
    },
  };
}

const MAX_CHARACTERS = 300;

/**
 * The API caps a single clip, so long answers are split on sentence
 * boundaries. Splitting also lets the first sentence start playing while
 * later ones are still being fetched.
 */
export function splitForSpeech(text: string, limit = MAX_CHARACTERS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const parts: string[] = [];
  let buffer = "";
  // Split after Chinese and Latin sentence enders, keeping the punctuation.
  const sentences = trimmed.split(/(?<=[。！？!?；;\n])/);

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (buffer) {
        parts.push(buffer);
        buffer = "";
      }
      // A single sentence longer than the cap: cut on commas, then hard-split.
      let rest = sentence;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = Math.max(
          window.lastIndexOf("，"),
          window.lastIndexOf(","),
          window.lastIndexOf(" "),
        );
        const take = cut > limit / 3 ? cut + 1 : limit;
        parts.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      if (rest) buffer = rest;
      continue;
    }
    if ((buffer + sentence).length > limit) {
      parts.push(buffer);
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer) parts.push(buffer);
  return parts.filter((part) => part.trim().length > 0);
}

/** Strip markup that should never be read aloud. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A valid 10 ms silent PCM WAV, served as blob: (allowed by the site's CSP).
function silentWav(): Blob {
  const bytes = new Uint8Array(204);
  const view = new DataView(bytes.buffer);
  for (const [offset, word] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    for (let index = 0; index < word.length; index++)
      bytes[offset + index] = word.charCodeAt(index);
  view.setUint32(4, 196, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 160, true);
  return new Blob([bytes], { type: "audio/wav" });
}

type ClipOutcome = "ended" | "failed" | "cancelled";
type Playback = {
  audio: HTMLAudioElement;
  url: string;
  settle: (outcome: ClipOutcome) => void;
  retry: () => void;
};

export function createCloudSpeaker(deps: CloudSpeechDeps = {}) {
  const doFetch =
    deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const makeAudio = deps.createAudio ?? (() => new Audio());
  let generation = 0;
  let audio: HTMLAudioElement | null = null;
  let playback: Playback | null = null;
  let request: AbortController | null = null;
  let finishFallback: ((success: boolean) => void) | null = null;
  let priming: { done: () => void; promise: Promise<void> } | null = null;
  let primed = false;
  let state: CloudSpeechState = "idle";
  let cloudUnavailableUntil = 0;

  function setState(next: CloudSpeechState) {
    if (state === next) return;
    state = next;
    deps.onState?.(next);
  }
  function player() {
    audio ??= makeAudio();
    return audio;
  }
  function cancel() {
    generation++;
    request?.abort();
    request = null;
    priming?.done();
    playback?.settle("cancelled");
    finishFallback?.(false);
    deps.fallbackCancel?.();
    setState("idle");
  }

  function speakWithBrowser(
    text: string,
    token: number,
    onCaption?: Caption,
  ): Promise<boolean> {
    if (!deps.fallbackSpeak) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(false),
        Math.max(8000, Math.min(120000, text.length * 250 + 4000)),
      );
      function finish(success = true) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (finishFallback === finish) finishFallback = null;
        resolve(success && token === generation);
      }
      finishFallback = finish;
      setState("speaking");
      try {
        const result = deps.fallbackSpeak!(text, finish, (caption) => {
          if (token === generation) onCaption?.(caption);
        });
        if (result === false) finish(false);
      } catch {
        finish(false);
      }
    });
  }

  async function fetchClip(text: string, token: number): Promise<Blob | null> {
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await doFetch("/api/v1/voice/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (token !== generation || !response.ok) return null;
      const blob = await response.blob();
      return token === generation && blob.size ? blob : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      if (request === controller) request = null;
    }
  }

  async function playClip(
    text: string,
    blob: Blob,
    token: number,
    onCaption?: Caption,
  ): Promise<ClipOutcome> {
    if (priming) await priming.promise;
    if (token !== generation) return "cancelled";
    const element = player();
    const url = URL.createObjectURL(blob);
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      let watchdog = setTimeout(
        () => current.settle("failed"),
        Math.max(15000, Math.min(180000, text.length * 300 + 10000)),
      );
      const current: Playback = {
        audio: element,
        url,
        settle(outcome) {
          if (settled) return;
          settled = true;
          clearTimeout(startTimer);
          clearTimeout(watchdog);
          if (playback === current) {
            playback = null;
            element.onended = element.onerror = element.onplaying = null;
            element.pause();
            element.removeAttribute("src");
            element.load();
          }
          URL.revokeObjectURL(url);
          resolve(outcome);
        },
        retry() {
          if (settled || token !== generation) return;
          clearTimeout(startTimer);
          // Call play synchronously here: unlock() is invoked in the click handler.
          let attempt: Promise<void>;
          try {
            attempt = element.play();
          } catch {
            current.settle("failed");
            return;
          }
          Promise.resolve(attempt).then(
            () => {
              if (settled || token !== generation) return;
              if (!element.paused || element.currentTime > 0) markStarted();
            },
            (error: unknown) => {
              if (settled || token !== generation) return;
              if (
                error &&
                typeof error === "object" &&
                "name" in error &&
                error.name === "NotAllowedError"
              )
                block();
              else current.settle("failed");
            },
          );
          startTimer = setTimeout(() => {
            if (!settled && !started && token === generation) block();
          }, 1500);
        },
      };
      function markStarted() {
        if (settled || token !== generation || started) return;
        started = true;
        clearTimeout(startTimer);
        clearTimeout(watchdog);
        watchdog = setTimeout(
          () => current.settle("failed"),
          Math.max(15000, Math.min(180000, text.length * 300 + 10000)),
        );
        setState("speaking");
        // File TTS has no word timestamps. Show the real clip's caption only.
        onCaption?.(splitSpeechCaptions(text)[0]?.text || text);
      }
      function block() {
        if (settled || token !== generation) return;
        clearTimeout(startTimer);
        clearTimeout(watchdog);
        watchdog = setTimeout(() => current.settle("failed"), 120000);
        setState("blocked");
        deps.onSilent?.("浏览器已拦截回答播放，点播放图标即可继续听。");
      }
      element.src = url;
      element.muted = false;
      element.onplaying = markStarted;
      element.onended = () => current.settle("ended");
      element.onerror = () => current.settle("failed");
      playback = current;
      current.retry();
    });
  }

  return {
    get state() {
      return state;
    },
    get supported() {
      return Date.now() >= cloudUnavailableUntil;
    },
    /** Prime THIS player on the first meaningful interaction, or resume its blocked clip. */
    unlock(): boolean {
      if (playback) {
        if (state === "blocked") playback.retry();
        return true;
      }
      if (Date.now() < cloudUnavailableUntil) return false;
      if (primed || priming) return true;
      const element = player();
      const url = URL.createObjectURL(silentWav());
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      let settled = false;
      const timer = setTimeout(done, 1500);
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (priming?.promise === promise) priming = null;
        element.onended = element.onerror = null;
        element.pause();
        element.removeAttribute("src");
        element.load();
        URL.revokeObjectURL(url);
        resolve();
      }
      priming = { done, promise };
      element.src = url;
      element.muted = false;
      element.onended = () => {
        primed = true;
        done();
      };
      element.onerror = done;
      try {
        // A muted disposable element does not grant playback to later players.
        const attempt = element.play();
        Promise.resolve(attempt).then(() => {
          if (!settled) {
            primed = true;
            done();
          }
        }, done);
      } catch {
        done();
      }
      return true;
    },
    async speak(text: string, onCaption?: Caption): Promise<boolean> {
      cancel();
      const clean = speakableText(text);
      if (!clean) return false;
      const token = generation;
      const segments = splitForSpeech(clean);
      let remaining = 0;
      if (Date.now() >= cloudUnavailableUntil) {
        for (; remaining < segments.length; remaining++) {
          if (token !== generation) return false;
          setState("loading");
          const blob = await fetchClip(segments[remaining], token);
          if (token !== generation) return false;
          const outcome = blob
            ? await playClip(segments[remaining], blob, token, onCaption)
            : "failed";
          if (token !== generation || outcome === "cancelled") return false;
          if (outcome === "failed") {
            cloudUnavailableUntil = Date.now() + 60000;
            deps.onFallback?.("云端语音暂不可用，本轮尝试系统朗读。");
            break;
          }
        }
        if (remaining === segments.length) {
          setState("idle");
          return true;
        }
      }
      if (token !== generation) return false;
      // Never repeat cloud clips that already finished successfully.
      const success = await speakWithBrowser(
        segments.slice(remaining).join(""),
        token,
        onCaption,
      );
      if (token !== generation) return false;
      setState("idle");
      if (!success)
        deps.onSilent?.("回答未能播放，可点播放图标重试；也请检查设备音量。");
      return success;
    },
    cancel,
  };
}
