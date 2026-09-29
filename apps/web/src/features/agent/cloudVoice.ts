// Cloud speech playback with automatic browser fallback.
//
// The backend returns a WAV clip for a given sentence. When the cloud is
// unavailable for any reason (disabled, quota exhausted, network trouble)
// this module falls back to the browser voice so the guide never goes
// silent. Callers only ever deal with "speak this text".

export type CloudSpeechState = "idle" | "loading" | "speaking";

export type CloudSpeechDeps = {
  /** Same-origin fetch, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Creates an audio element, injectable for tests. */
  createAudio?: () => HTMLAudioElement;
  /** Browser speech, used when the cloud path is unavailable. */
  fallbackSpeak?: (text: string, onDone: () => void) => void;
  fallbackCancel?: () => void;
  onState?: (state: CloudSpeechState) => void;
  onFallback?: (reason: string) => void;
};

type Playback = {
  audio?: HTMLAudioElement;
  url?: string;
  done: () => void;
};

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

export function createCloudSpeaker(deps: CloudSpeechDeps = {}) {
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const makeAudio = deps.createAudio ?? (() => new Audio());

  let generation = 0;
  let playback: Playback | null = null;
  let state: CloudSpeechState = "idle";
  /** Set once the cloud proves unavailable, to avoid retrying on every reply. */
  let cloudDisabled = false;

  function setState(next: CloudSpeechState) {
    if (state === next) return;
    state = next;
    deps.onState?.(next);
  }

  function release(current: Playback | null) {
    if (!current) return;
    if (current.audio) {
      current.audio.onended = null;
      current.audio.onerror = null;
      try {
        current.audio.pause();
      } catch {
        /* Already stopped. */
      }
    }
    if (current.url) URL.revokeObjectURL(current.url);
  }

  function cancel() {
    generation++;
    deps.fallbackCancel?.();
    release(playback);
    playback = null;
    setState("idle");
  }

  function speakWithBrowser(text: string): Promise<void> {
    if (!deps.fallbackSpeak) {
      setState("idle");
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      setState("speaking");
      deps.fallbackSpeak?.(text, finish);
      // Guard against engines that never fire their completion callback.
      setTimeout(finish, Math.max(8000, Math.min(120000, text.length * 250 + 4000)));
    });
  }

  /** Fetch and play one clip. Resolves when playback finishes. */
  async function playClip(text: string, token: number): Promise<boolean> {
    let response: Response;
    try {
      response = await doFetch("/api/v1/voice/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      return false;
    }
    if (token !== generation) return true;
    if (!response.ok) return false;

    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      return false;
    }
    if (token !== generation) return true;
    if (!blob.size) return false;

    const url = URL.createObjectURL(blob);
    const current: Playback = { url, done: () => undefined };
    let settle: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const audio = makeAudio();
    current.audio = audio;
    current.done = settle;
    audio.src = url;
    audio.onended = () => settle();
    // A decode failure must not hang the queue; fall back for the remainder.
    audio.onerror = () => {
      audio.dataset.failed = "1";
      settle();
    };

    playback = current;
    setState("speaking");
    try {
      await audio.play();
    } catch {
      // Autoplay blocked (no user gesture yet). Treat as a fallback trigger.
      release(current);
      playback = null;
      return false;
    }

    // Watchdog: a stalled element must not block the conversation forever.
    const watchdog = setTimeout(
      settle,
      Math.max(15000, Math.min(180000, text.length * 300 + 10000)),
    );
    await finished;
    clearTimeout(watchdog);

    const failed = audio.dataset.failed === "1";
    release(current);
    if (playback === current) playback = null;
    return !failed;
  }

  return {
    get state() {
      return state;
    },
    get supported() {
      return !cloudDisabled;
    },
    /** Speak `text`, falling back to the browser voice if the cloud fails. */
    async speak(text: string): Promise<void> {
      const clean = speakableText(text);
      if (!clean) return;

      const token = ++generation;
      release(playback);
      playback = null;

      if (!cloudDisabled) {
        const segments = splitForSpeech(clean);
        let ok = true;
        for (let index = 0; index < segments.length; index++) {
          if (token !== generation) return;
          // Only the first clip shows a loading state; the rest stream on.
          if (index === 0) setState("loading");
          const played = await playClip(segments[index], token);
          if (!played) {
            ok = false;
            break;
          }
        }
        if (token !== generation) return;
        if (ok) {
          setState("idle");
          return;
        }
        // Cloud failed mid-flight: remember it and finish with the browser.
        cloudDisabled = true;
        deps.onFallback?.("云端语音暂不可用，已切换浏览器朗读。");
      }

      if (token !== generation) return;
      await speakWithBrowser(clean);
      if (token === generation) setState("idle");
    },
    cancel,
  };
}
