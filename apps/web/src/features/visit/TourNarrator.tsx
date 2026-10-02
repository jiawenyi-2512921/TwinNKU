import { useEffect, useRef, useState } from "react";
import type { TourNarration } from "../experiences/ExperiencePanel";
import {
  createBrowserSpeechFallback,
  createCloudSpeaker,
  type CloudSpeechState,
} from "../agent/cloudVoice";
import { browserVoiceEnvironment } from "../agent/voice";
import {
  prepareDraftVoice,
  prepareTourVoice,
} from "../../shared/visitorSession";
import { acquireAudio, releaseAudio } from "./audioOwner";
import type { AudioBookmark } from "./session";
import "./visit.css";

function narrationKey(source: TourNarration | null): string {
  return source
    ? `${source.tourId}:${source.tourRevision}:${source.stopIndex}:${source.segmentId ?? "legacy"}:${source.draftRevision ?? "public"}`
    : "";
}

export function TourNarrator({
  narration,
  staffCsrf,
  initialBookmark,
  onBookmark,
  onStop,
}: {
  narration: TourNarration | null;
  staffCsrf?: string;
  initialBookmark?: AudioBookmark;
  onBookmark?: (position: AudioBookmark) => void;
  onStop?: () => void;
}) {
  const speaker = useRef<ReturnType<typeof createCloudSpeaker> | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0),
    lease = useRef<number | undefined>(undefined);
  const playback = useRef<{ key: string; epoch: number } | null>(null);
  const bookmark = useRef<AudioBookmark>({ chunkIndex: 0, time: 0 });
  const latest = useRef(narration),
    callback = useRef(onBookmark);
  latest.current = narration;
  callback.current = onBookmark;
  const [state, setState] = useState<CloudSpeechState>("idle");
  const [paused, setPaused] = useState(false),
    [caption, setCaption] = useState("");
  const [notice, setNotice] = useState("");
  const key = narrationKey(narration);
  const mounted = useRef(true);

  function pause() {
    const active = playback.current;
    const activeEpoch = generation.current;
    playback.current = null;
    generation.current++;
    pending.current?.abort();
    const saved = speaker.current?.pause();
    // A permit may still be loading, or the player may belong to the previous
    // segment. Neither may replace this segment's persisted resume position.
    if (
      saved &&
      mounted.current &&
      active?.epoch === activeEpoch &&
      active?.key === narrationKey(latest.current)
    ) {
      bookmark.current = saved;
      callback.current?.(saved);
    }
    releaseAudio("tour", lease.current);
    if (mounted.current && latest.current) setPaused(true);
  }

  useEffect(() => {
    mounted.current = true;
    const fallback = createBrowserSpeechFallback(browserVoiceEnvironment());
    speaker.current = createCloudSpeaker({
      fallbackSpeak: fallback.speak,
      fallbackCancel: fallback.cancel,
      onState: (value) => {
        if (mounted.current) setState(value);
      },
      onSilent: (message) => {
        if (mounted.current) setNotice(message);
      },
      onFallback: (message) => {
        if (mounted.current) setNotice(message);
      },
    });
    const prime = () => speaker.current?.unlock();
    window.addEventListener("twinnku:tour-prime", prime);
    window.addEventListener("twinnku:tour-pause", pause);
    const visibility = () => {
      if (document.visibilityState === "hidden") pause();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      pause();
      speaker.current?.cancel();
      speaker.current = null;
      window.removeEventListener("twinnku:tour-prime", prime);
      window.removeEventListener("twinnku:tour-pause", pause);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  async function start(resume = false) {
    const source = latest.current;
    if (!source || !speaker.current) return;
    if (document.visibilityState === "hidden") {
      pause();
      return;
    }
    pending.current?.abort();
    lease.current = acquireAudio("tour", pause);
    const controller = new AbortController();
    generation.current++;
    pending.current = controller;
    setNotice("");
    setPaused(false);
    setState("loading");
    const activeEpoch = generation.current;
    const sourceKey = narrationKey(source);
    const activeLease = lease.current;
    const current = () =>
      !controller.signal.aborted &&
      generation.current === activeEpoch &&
      mounted.current &&
      narrationKey(latest.current) === sourceKey;
    const offset = resume
      ? { ...bookmark.current }
      : { chunkIndex: 0, time: 0 };
    try {
      if (source.draftRevision && !staffCsrf)
        throw new Error("请重新登录后台后试听草稿讲解。");
      const manifest =
        source.draftRevision && staffCsrf
          ? await prepareDraftVoice(
              {
                kind: "draft_segment",
                tour_id: source.tourId,
                draft_revision: source.draftRevision,
                stop_index: source.stopIndex,
                segment_id: source.segmentId,
              },
              staffCsrf,
              controller.signal,
            )
          : await prepareTourVoice(
              {
                kind: "tour_segment",
                tour_id: source.tourId,
                tour_revision: source.tourRevision,
                stop_index: source.stopIndex,
                segment_id: source.segmentId,
              },
              controller.signal,
            );
      if (!current()) return;
      playback.current = { key: sourceKey, epoch: activeEpoch };
      const complete = await speaker.current.speak(
        source.text,
        (value) => {
          if (current()) setCaption(value);
        },
        {
          ...manifest,
          startChunk: offset.chunkIndex,
          startTime: offset.time,
          onProgress: (value) => {
            if (!current()) return;
            bookmark.current = value;
            callback.current?.(value);
          },
        },
      );
      if (!current()) return;
      playback.current = null;
      pending.current = null;
      releaseAudio("tour", activeLease);
      if (complete) {
        bookmark.current = { chunkIndex: 0, time: 0 };
        callback.current?.(bookmark.current);
        setCaption("");
      }
    } catch (error) {
      if (!current()) return;
      playback.current = null;
      pending.current = null;
      releaseAudio("tour", activeLease);
      setPaused(true);
      setNotice(
        error instanceof Error
          ? error.message
          : "讲解声音暂不可用，可以继续阅读本段文字。",
      );
    }
  }

  useEffect(() => {
    generation.current++;
    pending.current?.abort();
    playback.current = null;
    speaker.current?.cancel();
    releaseAudio("tour", lease.current);
    bookmark.current = initialBookmark ?? { chunkIndex: 0, time: 0 };
    setCaption("");
    setPaused(false);
    if (narration)
      void start(Boolean(initialBookmark?.time || initialBookmark?.chunkIndex));
    return () => {
      generation.current++;
      pending.current?.abort();
      playback.current = null;
      speaker.current?.cancel();
      releaseAudio("tour", lease.current);
    };
  }, [key]);

  if (!narration) return null;
  return (
    <section className="tour-narrator" aria-label="小开本站讲解">
      <div>
        <strong>小开 · 本站讲解</strong>
        <p aria-live="polite">
          {caption ||
            (paused
              ? "讲解已暂停，随时可以继续。"
              : state === "loading"
                ? "正在准备声音…"
                : "按自己的节奏，听见校园故事。")}
        </p>
      </div>
      {paused ? (
        <button
          onClick={() => {
            speaker.current?.unlock();
            void start(true);
          }}
        >
          继续本站讲解
        </button>
      ) : state === "blocked" ? (
        <button onClick={() => speaker.current?.unlock()}>点击继续播放</button>
      ) : state === "speaking" || state === "loading" ? (
        <button onClick={pause}>暂停讲解</button>
      ) : (
        <button
          onClick={() => {
            speaker.current?.unlock();
            void start();
          }}
        >
          重新听本段
        </button>
      )}
      {notice && <small role="status">{notice}</small>}
      {onStop && (
        <button
          onClick={() => {
            pause();
            onStop();
          }}
        >
          结束讲解
        </button>
      )}
    </section>
  );
}
