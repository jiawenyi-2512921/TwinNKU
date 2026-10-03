import { useEffect, useRef, useState } from "react";
import type { TourNarration } from "../experiences/ExperiencePanel";
import {
  createBrowserSpeechFallback,
  createCloudSpeaker,
  type CloudSpeechState,
} from "../agent/cloudVoice";
import { browserVoiceEnvironment } from "../agent/voice";
import { get } from "../../shared/api/client";
import {
  createRecordedPlayer,
  recordedOffset,
  sha256,
  validateRecordedManifest,
} from "./recordedAudio";
import { acquireAudio, releaseAudio } from "./audioOwner";
import type { AudioBookmark } from "./session";
import { Companion } from "../agent/Companion";
import "./visit.css";

function narrationKey(source: TourNarration | null): string {
  return source
    ? `${source.tourId}:${source.tourRevision}:${source.stopIndex}:${source.segmentId ?? "legacy"}:${source.draftRevision ?? "public"}:${source.assetId ?? "text"}:${source.text}:${source.requestId ?? 0}`
    : "";
}

export function TourNarrator({
  narration,
  staffCsrf,
  initialBookmark,
  onBookmark,
  onStop,
  recordedAllowed = true,
}: {
  narration: TourNarration | null;
  staffCsrf?: string;
  initialBookmark?: AudioBookmark;
  onBookmark?: (position: AudioBookmark) => void;
  onStop?: () => void;
  recordedAllowed?: boolean;
}) {
  const speaker = useRef<ReturnType<typeof createCloudSpeaker> | null>(null);
  const recorded = useRef<ReturnType<typeof createRecordedPlayer> | null>(null);
  const playbackMode = useRef<"recorded" | "browser" | "draft">("browser");
  const browserChoice = useRef(false);
  const recordedAllowedRef = useRef(recordedAllowed);
  recordedAllowedRef.current = recordedAllowed;
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
    const saved =
      playbackMode.current === "recorded"
        ? recorded.current?.pause()
        : speaker.current?.pause();
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
    recorded.current = createRecordedPlayer((value) => {
      if (mounted.current) setState(value);
    });
    const prime = () => {
      speaker.current?.unlock();
      recorded.current?.unlock();
    };
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
      recorded.current?.cancel();
      speaker.current = null;
      window.removeEventListener("twinnku:tour-prime", prime);
      window.removeEventListener("twinnku:tour-pause", pause);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  async function start(resume = false, browserOnly = false) {
    const source = latest.current;
    if (!source || !speaker.current) return;
    const useBrowser = browserOnly || (resume && browserChoice.current);
    browserChoice.current = useBrowser;
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
      if (
        (source.draftRevision || source.narrationMode === "recorded") &&
        !useBrowser
      ) {
        if (!recordedAllowedRef.current)
          throw new Error(
            "正式音频已暂停开放，可继续阅读文字或明确选择浏览器朗读。",
          );
        if (source.draftRevision && !source.assetId)
          throw new Error(
            "此段尚未采用正式音频，可以查看文字或明确选择浏览器朗读。",
          );
        playbackMode.current = "recorded";
        const query = new URLSearchParams({
          revision: String(source.tourRevision),
          stop_index: String(source.stopIndex),
          segment_id: source.segmentId ?? "",
        });
        const result = await get<unknown>(
          source.draftRevision
            ? `/admin/narration-assets/${source.assetId}/manifest`
            : `/experiences/${source.tourId}/narration?${query}`,
          controller.signal,
        );
        if (!current()) return;
        const manifest = validateRecordedManifest(
          result.data,
          source.tourId,
          source.tourRevision,
          source.stopIndex,
          source.segmentId ?? "",
          source.draftRevision ? source.assetId : undefined,
        );
        if (
          (await sha256(new TextEncoder().encode(source.text))) !==
          manifest.text_sha256
        )
          throw new Error("讲解正文与声音已不匹配，请重新核对路线。");
        if (!current()) return;
        if (
          recordedOffset(manifest, resume ? bookmark.current : undefined).reset
        )
          setNotice("声音版本已变化，将从本段起点播放。");
        playback.current = { key: sourceKey, epoch: activeEpoch };
        const complete = await recorded.current?.play(
          manifest,
          resume ? bookmark.current : undefined,
          (value) => {
            if (current()) setCaption(value);
          },
          (value) => {
            if (current()) {
              bookmark.current = value;
              callback.current?.(value);
            }
          },
          controller.signal,
          Boolean(source.draftRevision),
        );
        if (!current()) return;
        playback.current = null;
        pending.current = null;
        releaseAudio("tour", activeLease);
        if (complete) {
          bookmark.current = { chunkIndex: 0, time: 0 };
          callback.current?.(bookmark.current);
          setCaption("");
        } else {
          setPaused(true);
          setNotice("正式声音未能播放，可重试或选择浏览器朗读。");
        }
        return;
      }
      playbackMode.current = "browser";
      if (resume && (offset.time > 0 || offset.chunkIndex > 0))
        setNotice("浏览器朗读将从本段正文起点重新开始。");
      const manifest = { permit: null, chunks: [], csrf: "" };
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
    recorded.current?.cancel();
    releaseAudio("tour", lease.current);
    bookmark.current = initialBookmark ?? { chunkIndex: 0, time: 0 };
    browserChoice.current = false;
    setCaption("");
    setPaused(false);
    if (narration)
      void start(Boolean(initialBookmark?.time || initialBookmark?.chunkIndex));
    return () => {
      generation.current++;
      pending.current?.abort();
      playback.current = null;
      speaker.current?.cancel();
      recorded.current?.cancel();
      releaseAudio("tour", lease.current);
    };
  }, [key]);

  useEffect(() => {
    if (!recordedAllowed && playbackMode.current === "recorded") {
      pause();
      setNotice("正式音频已暂停开放，播放已暂停；文字与浏览器朗读仍可使用。");
    }
  }, [recordedAllowed]);

  if (!narration) return null;
  return (
    <section className="tour-narrator" aria-label="小开本站讲解">
      <Companion
        className="tour-character"
        phase={
          state === "speaking"
            ? "speaking"
            : state === "loading"
              ? "thinking"
              : "idle"
        }
        label={paused ? "小开：继续本段讲解" : "小开：暂停本段讲解"}
        quiet={paused || state !== "speaking"}
        onClick={() => {
          if (paused) {
            speaker.current?.unlock();
            void start(true);
          } else pause();
        }}
      />
      <div>
        <strong>小开 · 本站讲解</strong>
        <p aria-live={state === "speaking" ? "off" : "polite"}>
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
        <button
          onClick={() => {
            speaker.current?.unlock();
            recorded.current?.unlock();
          }}
        >
          点击继续播放
        </button>
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
      {(narration.draftRevision || narration.narrationMode === "recorded") &&
        paused && (
          <button
            onClick={() => {
              speaker.current?.unlock();
              void start(false, true);
            }}
          >
            使用浏览器朗读本段
          </button>
        )}
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
