import { createContext, useContext, useEffect, useRef, useState } from "react";
import { get, type Floor, type Panorama } from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import {
  experienceNames,
  type Experience,
  type ExperienceKind,
  type TourMainView,
  type TourResource,
} from "./types";
import {
  normalizeTourPosition,
  segmentsForStop,
  type TourPosition,
} from "./segments";
export type { TourPosition } from "./segments";
import {
  advanceProgress,
  inlineVideo,
  normalizeProgress,
  readLocal,
  safeMediaUrl,
  writeLocal,
  type TourProgress,
} from "./progress";
import "./experiences.css";
import { acquireAudio, releaseAudio } from "../visit/audioOwner";

export type TourNarration = {
  tourId: string;
  tourRevision: number;
  stopIndex: number;
  segmentId?: string;
  text: string;
  sourceNote: string;
  draftRevision?: number;
};
export type TourCallbacks = {
  position?: TourPosition | null;
  onPositionChange?: (position: TourPosition) => void;
  onBookmark?: (position: TourPosition) => void;
  onResourceOpen?: (resource: TourResource, pointId: string) => void;
  onMainViewChange?: (view: TourMainView, pointId: string) => void;
  onNarrate?: (narration: TourNarration) => void;
  onNarrationStop?: () => void;
};
const ExperienceActions = createContext<
  TourCallbacks & {
    active: boolean;
    onMediaActiveChange?: (active: boolean) => void;
    onNavigateStop?: (from: string, to: string) => void;
    pointNames?: Record<string, string>;
  }
>({ active: true });

// Created only by a resolved explicit assistant action, never by a shared URL.
export type VideoPlaybackRequest = {
  id: number;
  resourceId: string;
  revision: number;
  pointId: string;
  pointRevision: number;
  signal: AbortSignal;
};

export type ExperiencePanelProps = TourCallbacks & {
  playbackRequest?: VideoPlaybackRequest | null;
  pointNames?: Record<string, string>;
  active?: boolean;
  onMediaActiveChange?: (active: boolean) => void;
  onNavigateStop?: (from: string, to: string) => void;
  onExperienceChange?: (id: string) => void;
  campusId?: string;
  campusName?: string;
  pointId?: string;
  initialExperienceId?: string;
  initialKind?: ExperienceKind;
  onSelectPoint: (pointId: string) => void;
  onClose?: () => void;
};

export function ExperiencePanel({
  campusId,
  campusName,
  pointId,
  initialExperienceId,
  initialKind,
  onSelectPoint,
  onClose,
  active = true,
  onMediaActiveChange,
  onNavigateStop,
  onExperienceChange,
  pointNames,
  playbackRequest,
  position,
  onPositionChange,
  onBookmark,
  onResourceOpen,
  onMainViewChange,
  onNarrate,
  onNarrationStop,
}: ExperiencePanelProps) {
  const [items, setItems] = useState<Experience[]>([]);
  const [kind, setKind] = useState<ExperienceKind | "">(
    initialKind ?? (pointId ? "" : "tour"),
  );
  const [selectedId, setSelectedId] = useState(initialExperienceId ?? "");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const rejectedPlayback = useRef<number | null>(null);
  useEffect(() => {
    if (
      playbackRequest &&
      (state === "error" ||
        (state === "ready" &&
          !items.some(
            (item) =>
              item.id === playbackRequest.resourceId &&
              item.revision === playbackRequest.revision,
          )))
    )
      rejectedPlayback.current = playbackRequest.id;
  }, [playbackRequest, items, state]);
  useEffect(() => {
    setSelectedId(initialExperienceId ?? "");
  }, [initialExperienceId, pointId]);
  useEffect(() => {
    setKind(initialKind ?? (pointId ? "" : "tour"));
  }, [initialKind, pointId]);
  useEffect(() => {
    let pending: AbortController | undefined;
    let disposed = false;
    setItems([]);
    setState("loading");
    async function refresh() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const result = await get<Experience[]>(
          `/experiences${campusId ? `?${new URLSearchParams({ campus_id: campusId })}` : ""}`,
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return;
        setItems((previous) =>
          JSON.stringify(previous) === JSON.stringify(result.data)
            ? previous
            : result.data,
        );
        setState("ready");
      } catch {
        if (!disposed && !controller.signal.aborted) {
          setItems([]);
          setState("error");
        }
      }
    }
    void refresh();
    const stop = watchCatalogChanges(() => void refresh());
    return () => {
      disposed = true;
      pending?.abort();
      stop();
    };
  }, [campusId, retry]);
  const selected = items.find((item) => item.id === selectedId);
  const rows = items.filter(
    (item) =>
      (!kind || item.content.kind === kind) &&
      (!pointId ||
        (item.content.kind === "tour"
          ? item.content.stops.some((stop) => stop.point_id === pointId)
          : item.content.point_id === pointId)),
  );
  return (
    <ExperienceActions.Provider
      value={{
        active,
        onMediaActiveChange,
        onNavigateStop,
        pointNames,
        position,
        onPositionChange,
        onBookmark,
        onResourceOpen,
        onMainViewChange,
        onNarrate,
        onNarrationStop,
      }}
    >
      <section
        hidden={!active}
        className="experience-panel"
        aria-label="校园体验"
      >
        <header className="experience-heading">
          <div>
            <span className="experience-eyebrow">CAMPUS STORIES</span>
            <h2>
              {kind === "tour"
                ? "校园导览路线"
                : pointId
                  ? "在这里发现更多"
                  : "校园体验"}
            </h2>
            {kind === "tour" && (
              <p className="experience-campus-caption">
                {campusName || "当前校区"} · 多地点主题参观
              </p>
            )}
          </div>
          {onClose && (
            <button
              className="experience-close"
              onClick={onClose}
              aria-label="关闭校园体验"
            >
              ×
            </button>
          )}
        </header>
        {state === "loading" && <p role="status">正在读取已发布的校园体验…</p>}
        {state === "error" && (
          <div role="alert">
            <p>暂时无法读取校园体验。</p>
            <button onClick={() => setRetry((n) => n + 1)}>重试</button>
          </div>
        )}
        {state === "ready" && (
          <>
            <div className="experience-tabs" aria-label="体验类型">
              {(["", "tour", "checkin", "media"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={kind === value}
                  onClick={() => {
                    setKind(value);
                    setSelectedId("");
                    onExperienceChange?.("");
                  }}
                >
                  {value ? experienceNames[value] : "全部"}
                </button>
              ))}
            </div>
            {selectedId && !selected && (
              <p role="status">这项体验尚未公开或已下架，请选择其他体验。</p>
            )}
            {selected ? (
              <>
                <button
                  className="experience-back"
                  onClick={() => {
                    setSelectedId("");
                    onExperienceChange?.("");
                  }}
                >
                  返回体验列表
                </button>
                <ExperienceDetail
                  key={`${selected.id}:${selected.revision}`}
                  item={selected}
                  items={items}
                  onSelectPoint={onSelectPoint}
                  playbackRequest={
                    playbackRequest?.id === rejectedPlayback.current
                      ? null
                      : playbackRequest
                  }
                />
              </>
            ) : (
              <div className="experience-catalog">
                {!rows.length && (
                  <p className="experience-empty">
                    这里还没有已发布的
                    {kind ? experienceNames[kind] : "体验内容"}。
                  </p>
                )}
                {rows.map((item) => (
                  <button
                    className="experience-tile"
                    key={item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      onExperienceChange?.(item.id);
                    }}
                  >
                    <span>{experienceNames[item.content.kind]}</span>
                    <strong>{item.content.title}</strong>
                    <p>
                      {item.content.description ||
                        (item.content.kind === "tour"
                          ? `${item.content.stops.length} 站校园导览`
                          : "查看详情")}
                    </p>
                    {item.content.kind === "tour" && (
                      <div className="experience-route-preview">
                        <b>{item.content.stops.length} 站</b>
                        <span>
                          {item.content.stops
                            .slice(0, 4)
                            .map(
                              (stop, index) =>
                                pointNames?.[stop.point_id] ||
                                `第 ${index + 1} 站`,
                            )
                            .join(" → ")}
                          {item.content.stops.length > 4 ? " …" : ""}
                        </span>
                      </div>
                    )}
                    <span aria-hidden="true">
                      {item.content.kind === "tour"
                        ? "查看完整校园路线 →"
                        : "查看 →"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </ExperienceActions.Provider>
  );
}

function ExperienceDetail({
  item,
  items,
  onSelectPoint,
  playbackRequest,
}: {
  item: Experience;
  items: Experience[];
  onSelectPoint: (id: string) => void;
  playbackRequest?: VideoPlaybackRequest | null;
}) {
  if (item.content.kind === "tour")
    return (
      <TourPlayer item={item} items={items} onSelectPoint={onSelectPoint} />
    );
  const pointId = item.content.point_id;
  return (
    <article className="experience-detail">
      <h3>{item.content.title}</h3>
      <p className="experience-prose">{item.content.description}</p>
      {item.content.kind === "media" ? (
        <MediaView item={item} playbackRequest={playbackRequest} />
      ) : (
        <CheckinCard item={item} items={items} />
      )}
      <button onClick={() => onSelectPoint(pointId)}>在地图查看此地点</button>
      <details>
        <summary>资料来源</summary>
        <p className="experience-prose">{item.content.source_note}</p>
      </details>
    </article>
  );
}

export function MediaView({
  item,
  playbackRequest,
}: {
  item: Experience;
  playbackRequest?: VideoPlaybackRequest | null;
}) {
  const { active, onMediaActiveChange } = useContext(ExperienceActions);
  const callback = useRef(onMediaActiveChange);
  callback.current = onMediaActiveChange;
  const [consented, setConsented] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playbackMessage, setPlaybackMessage] = useState("");
  const [dismissedRequest, setDismissedRequest] = useState<number | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const playGeneration = useRef(0);
  const audioLease = useRef<number | null>(null);
  function releaseVideoLease() {
    if (audioLease.current !== null) {
      releaseAudio("video", audioLease.current);
      audioLease.current = null;
    }
  }
  const url = safeMediaUrl(item.media_url);
  const directPlayback =
    active &&
    playbackRequest?.resourceId === item.id &&
    playbackRequest.revision === item.revision &&
    playbackRequest.id !== dismissedRequest &&
    !playbackRequest.signal.aborted;
  async function playVideo(video: HTMLVideoElement) {
    const generation = ++playGeneration.current;
    setPlaybackMessage("");
    try {
      await video.play();
    } catch (error) {
      if (generation !== playGeneration.current || player.current !== video)
        return;
      callback.current?.(false);
      setPlaybackMessage(
        error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "NotAllowedError"
          ? "浏览器阻止了自动播放，请点击下方按钮播放。"
          : "视频尚未开始播放，请点击重试；若仍失败，请检查网络或打开原视频。",
      );
    }
  }
  useEffect(() => {
    setConsented(false);
    setFailed(false);
    setPlaybackMessage("");
  }, [item.id, item.revision, item.media_url]);
  useEffect(() => {
    if (!active) {
      setConsented(false);
      if (playbackRequest) setDismissedRequest(playbackRequest.id);
      callback.current?.(false);
    }
    return () => callback.current?.(false);
  }, [active, item.id, item.revision, item.media_url, playbackRequest]);
  useEffect(() => {
    const video = player.current;
    if (!directPlayback || !video || !playbackRequest || failed) return;
    const cancel = () => {
      playGeneration.current++;
      video.pause();
      setDismissedRequest(playbackRequest.id);
      callback.current?.(false);
    };
    playbackRequest.signal.addEventListener("abort", cancel, { once: true });
    void playVideo(video);
    return () => {
      playbackRequest.signal.removeEventListener("abort", cancel);
      playGeneration.current++;
      video.pause();
      callback.current?.(false);
    };
  }, [directPlayback, playbackRequest, item.id, item.revision, url, failed]);
  useEffect(() => {
    const video = player.current;
    if (!video) return;
    return () => {
      playGeneration.current++;
      video.pause();
      releaseVideoLease();
      callback.current?.(false);
    };
  }, [consented, directPlayback, active, item.id, item.revision, url, failed]);
  if (item.content.kind !== "media" || !url) return <p>该媒体目前不可播放。</p>;
  if (item.content.media_type === "image")
    return failed ? (
      <p role="status">
        图片暂时加载失败。
        <button onClick={() => setFailed(false)}>重试图片</button>
      </p>
    ) : (
      <img
        className="experience-image"
        src={url}
        alt={item.content.title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  if (!inlineVideo(url, !!item.content.upload_id))
    return (
      <div className="experience-video-consent">
        <p>
          {directPlayback
            ? `《${item.content.title}》的视频链接已准备好。`
            : `想观看《${item.content.title}》吗？`}
        </p>
        <a href={url} target="_blank" rel="noopener noreferrer">
          在新窗口观看视频
        </a>
        <small>将在提供方网站打开，当前导览保留。</small>
      </div>
    );
  if ((!consented && !directPlayback) || !active)
    return (
      <div className="experience-video-consent">
        <p>想观看《{item.content.title}》吗？</p>
        <button
          onClick={() => {
            setConsented(true);
            setFailed(false);
          }}
        >
          打开视频播放器
        </button>
        <small>由你点击播放，不自动开始。</small>
      </div>
    );
  return (
    <div className="experience-video">
      {playbackMessage && !failed && (
        <div role="status">
          <p>{playbackMessage}</p>
          <button
            onClick={() => {
              if (player.current) void playVideo(player.current);
            }}
          >
            点击播放
          </button>
        </div>
      )}
      {failed ? (
        <div role="alert">
          <p>视频未能播放，可能是文件格式或网络问题。</p>
          <button
            onClick={() => {
              setFailed(false);
              setConsented(false);
            }}
          >
            重新尝试
          </button>
          <a href={url} target="_blank" rel="noopener noreferrer">
            打开原视频
          </a>
        </div>
      ) : (
        <video
          key={`${item.id}:${item.revision}`}
          ref={player}
          src={url}
          controls
          playsInline
          preload="metadata"
          onPlay={() => {
            if (directPlayback && playbackRequest?.signal.aborted) {
              player.current?.pause();
              return;
            }
            setPlaybackMessage("");
            if (audioLease.current === null)
              audioLease.current = acquireAudio("video", () => {
                playGeneration.current++;
                player.current?.pause();
                releaseVideoLease();
              });
            callback.current?.(true);
          }}
          onPause={() => {
            releaseVideoLease();
            callback.current?.(false);
          }}
          onEnded={() => {
            releaseVideoLease();
            callback.current?.(false);
          }}
          onError={() => {
            releaseVideoLease();
            setFailed(true);
            callback.current?.(false);
          }}
          aria-label={item.content.title}
        />
      )}
      <button
        onClick={() => {
          playGeneration.current++;
          player.current?.pause();
          releaseVideoLease();
          if (playbackRequest) setDismissedRequest(playbackRequest.id);
          setConsented(false);
          callback.current?.(false);
        }}
      >
        收起视频
      </button>
    </div>
  );
}

export function CheckinCard({
  item,
  items,
}: {
  item: Experience;
  items: Experience[];
}) {
  const key = `twinnku:checkin:${item.id}`;
  const [recordedAt, setRecordedAt] = useState<string>(() => {
    const value = readLocal(key);
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
      ? value
      : "";
  });
  const [saved, setSaved] = useState(true);
  if (item.content.kind !== "checkin") return null;
  const imageId = item.content.image_id;
  const pointId = item.content.point_id;
  const image = items.find(
    (row) =>
      row.id === imageId &&
      row.content.kind === "media" &&
      row.content.media_type === "image" &&
      row.content.point_id === pointId,
  );
  return (
    <div className="experience-checkin">
      {image && (
        <figure>
          <MediaView key={`${image.id}:${image.revision}`} item={image} />
          <figcaption>打卡参考图 · {image.content.title}</figcaption>
        </figure>
      )}
      {item.content.image_id && !image && <p>参考图目前不可用。</p>}
      <p>
        {recordedAt
          ? `你于 ${new Date(recordedAt).toLocaleString("zh-CN")} 确认完成打卡。`
          : "参观后，可以在这里记录自己的打卡。"}
      </p>
      <button
        onClick={() => {
          const next = recordedAt ? "" : new Date().toISOString();
          setRecordedAt(next);
          setSaved(writeLocal(key, next));
        }}
      >
        {recordedAt ? "撤销我的打卡" : "我已完成本次打卡"}
      </button>
      <small>由你自行确认，仅保存在此浏览器；不代表定位核验或官方签到。</small>
      {!saved && (
        <p role="status">浏览器未允许保存，本次记录只在当前页面保留。</p>
      )}
    </div>
  );
}

export function TourResourceView({
  resource,
  pointId,
  items,
  onOpen,
  playbackRequest,
}: {
  resource: TourResource | Exclude<TourMainView, { type: "map" }>;
  pointId: string;
  items: Experience[];
  onOpen?: (resource: TourResource, pointId: string) => void;
  playbackRequest?: VideoPlaybackRequest | null;
}) {
  const [floor, setFloor] = useState<Floor | null>(null);
  const [panorama, setPanorama] = useState<Panorama | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (resource.type !== "floor" && resource.type !== "vr") return;
    const controller = new AbortController();
    setFloor(null);
    setPanorama(null);
    setState("loading");
    const load =
      resource.type === "floor"
        ? get<Floor>(`/floors/${resource.id}`, controller.signal).then(
            ({ data }) => {
              if (
                data.point_id !== pointId ||
                data.revision !== resource.revision
              )
                throw new Error("stale floor");
              if (!controller.signal.aborted) setFloor(data);
            },
          )
        : get<Panorama[]>(
            `/points/${pointId}/panoramas`,
            controller.signal,
          ).then(({ data }) => {
            const found = data.find(
              (row) =>
                row.id === resource.id &&
                row.revision === resource.revision &&
                row.point_id === pointId,
            );
            if (!found) throw new Error("stale panorama");
            if (!controller.signal.aborted) setPanorama(found);
          });
    void load
      .then(() => {
        if (!controller.signal.aborted) setState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, [resource.type, resource.id, resource.revision, pointId]);
  if (resource.type === "floor" || resource.type === "vr") {
    if (state === "loading") return <p role="status">正在读取本段资料…</p>;
    if (state === "error")
      return <p role="status">本段资料已变更或暂不可用，请刷新路线。</p>;
    if (floor)
      return (
        <section className="experience-floor" aria-label={floor.label}>
          <h5>{floor.label}</h5>
          {(floor.images ?? []).map((image) => (
            <figure key={image.section ?? "main"}>
              <img
                src={image.url}
                alt={`${floor.label}${image.section_label ? ` · ${image.section_label}` : ""}`}
                loading="lazy"
              />
              <figcaption>
                {image.section_label || floor.attribution}
              </figcaption>
            </figure>
          ))}
          {onOpen && (
            <button onClick={() => onOpen(resource, pointId)}>
              查看楼层详情
            </button>
          )}
        </section>
      );
    const url = panorama ? safeMediaUrl(panorama.url) : null;
    return url ? (
      <section className="experience-vr">
        <h5>{panorama!.title}</h5>
        <a href={url} target="_blank" rel="noopener noreferrer">
          打开 VR 全景原站
        </a>
        {onOpen && (
          <button onClick={() => onOpen(resource, pointId)}>
            查看全景资料
          </button>
        )}
      </section>
    ) : (
      <p>全景入口暂不可用。</p>
    );
  }
  const item = items.find(
    (row) =>
      row.id === resource.id &&
      row.revision === resource.revision &&
      row.content.kind !== "tour" &&
      row.content.point_id === pointId &&
      (resource.type === "checkin"
        ? row.content.kind === "checkin"
        : row.content.kind === "media" &&
          row.content.media_type === resource.type),
  );
  if (!item) return <p role="status">本段资料已变更或暂不可用，请刷新路线。</p>;
  return (
    <section
      className="experience-resource-card"
      aria-label={item.content.title}
    >
      <h5>{item.content.title}</h5>
      {onOpen ? (
        <button onClick={() => onOpen(resource, pointId)}>
          查看
          {resource.type === "image"
            ? "图片"
            : resource.type === "video"
              ? "视频"
              : "打卡"}
        </button>
      ) : resource.type === "checkin" ? (
        <CheckinCard item={item} items={items} />
      ) : (
        <MediaView item={item} playbackRequest={playbackRequest} />
      )}
    </section>
  );
}

export type TourPlayerProps = TourCallbacks & {
  item: Experience;
  items: Experience[];
  onSelectPoint: (id: string) => void;
  pointNames?: Record<string, string>;
  active?: boolean;
  preview?: boolean;
  draftRevision?: number;
  onNavigateStop?: (from: string, to: string) => void;
  onMediaActiveChange?: (active: boolean) => void;
};

export function TourPlayer({
  item,
  items,
  onSelectPoint,
  pointNames: suppliedNames,
  onNavigateStop: suppliedNavigate,
  onMediaActiveChange: suppliedMediaActiveChange,
  active: suppliedActive,
  preview = false,
  draftRevision,
  ...callbacks
}: TourPlayerProps) {
  const context = useContext(ExperienceActions);
  const pointNames = suppliedNames ?? context.pointNames;
  const onNavigateStop = suppliedNavigate ?? context.onNavigateStop;
  const active = suppliedActive ?? context.active;
  const actions = { ...context, ...callbacks };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const count = item.content.kind === "tour" ? item.content.stops.length : 0;
  const stops = item.content.kind === "tour" ? item.content.stops : [];
  const key = `twinnku:tour:${item.id}`;
  const [storedProgress, setProgress] = useState<TourProgress>(() =>
    normalizeProgress(preview ? null : readLocal(key), item.revision, count),
  );
  const current = normalizeTourPosition(
    actions.position ?? {
      revision: storedProgress.revision,
      stopIndex: storedProgress.index,
      segmentId: storedProgress.segmentId,
    },
    item.revision,
    stops,
  );
  const progress = {
    ...(storedProgress.revision === item.revision
      ? storedProgress
      : normalizeProgress(null, item.revision, count)),
    index: current.stopIndex,
  };
  const [introRead, setIntroRead] = useState(false);
  const [manualVideo, setManualVideo] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const stop = stops[current.stopIndex];
  const segments = stop ? segmentsForStop(stop, current.stopIndex) : [];
  const segmentIndex = Math.max(
    0,
    segments.findIndex((s) => s.id === current.segmentId),
  );
  const segment = segments[segmentIndex];
  useEffect(() => {
    setProgress(
      normalizeProgress(preview ? null : readLocal(key), item.revision, count),
    );
  }, [key, item.revision, count, preview]);
  useEffect(() => {
    setIntroRead(false);
    setManualVideo(false);
  }, [item.id, item.revision, current.stopIndex, current.segmentId]);
  useEffect(() => {
    if (!stop || !segment || !active) return;
    actionsRef.current.onPositionChange?.(current);
    actionsRef.current.onMainViewChange?.(segment.main_view, stop.point_id);
    return () => actionsRef.current.onNarrationStop?.();
  }, [item.id, item.revision, current.stopIndex, current.segmentId, active]);
  if (item.content.kind !== "tour" || count === 0)
    return <p>这条路线暂时没有可浏览的站点。</p>;
  const tour = item.content;
  const video = items.find(
    (row) =>
      row.id === stop.video_id &&
      row.content.kind === "media" &&
      row.content.media_type === "video" &&
      row.content.point_id === stop.point_id,
  );
  const checkin = items.find(
    (row) =>
      row.id === stop.checkin_id &&
      row.content.kind === "checkin" &&
      row.content.point_id === stop.point_id,
  );
  const videoPrompt =
    !stop.segments &&
    !progress.paused &&
    (stop.prompt_timing === "on_arrival" ||
      (stop.prompt_timing === "after_intro" && introRead) ||
      manualVideo);
  function change(next: TourProgress, locate = false) {
    const nextPosition = normalizeTourPosition(
      {
        revision: item.revision,
        stopIndex: next.index,
        segmentId:
          next.index === progress.index
            ? (next.segmentId ?? current.segmentId)
            : undefined,
      },
      item.revision,
      stops,
    );
    const saved = { ...next, segmentId: nextPosition.segmentId };
    if (
      next.paused ||
      nextPosition.stopIndex !== current.stopIndex ||
      nextPosition.segmentId !== current.segmentId
    )
      actions.onNarrationStop?.();
    setProgress(saved);
    setIntroRead(false);
    setManualVideo(false);
    if (!preview) setStorageOk(writeLocal(key, saved));
    actions.onPositionChange?.(nextPosition);
    if (locate && item.content.kind === "tour")
      onSelectPoint(item.content.stops[next.index].point_id);
  }
  const cover = tour.cover_image_id
    ? items.find(
        (row) =>
          row.id === tour.cover_image_id &&
          row.revision === tour.cover_image_revision &&
          row.content.kind === "media" &&
          row.content.media_type === "image",
      )
    : undefined;
  return (
    <ExperienceActions.Provider
      value={{
        ...context,
        ...callbacks,
        active,
        pointNames,
        onNavigateStop,
        onMediaActiveChange:
          suppliedMediaActiveChange ?? context.onMediaActiveChange,
      }}
    >
      <article className="experience-tour" hidden={!active}>
        <div className="experience-tour-hero">
          <span className="experience-eyebrow">CAMPUS ITINERARY</span>
          <h3>{item.content.title}</h3>
          <p>
            {count} 站 ·{" "}
            {new Set(item.content.stops.map((entry) => entry.point_id)).size}{" "}
            个校园地点
          </p>
        </div>
        {cover && (
          <div className="experience-tour-cover">
            <MediaView item={cover} />
          </div>
        )}
        <p className="experience-prose">{item.content.description}</p>
        <p className="experience-note">
          按站点顺序浏览校园。站点进度由你确认；切换站点不会自动判定到达。
        </p>
        <div className="experience-progress">
          <progress
            value={progress.completed.length}
            max={count}
            aria-label="已完成站点"
          />
          <span>
            已确认 {progress.completed.length} / {count} 站
          </span>
        </div>
        {progress.paused ? (
          <div className="experience-resume">
            <p>
              {progress.completed.length === count
                ? "本次导览的所有站点均已确认完成。"
                : "进度已保留，随时继续。"}
            </p>
            <button
              onClick={() => change({ ...progress, paused: false }, true)}
            >
              {progress.completed.length ? "继续浏览" : "开始导览"}
            </button>
          </div>
        ) : (
          <button onClick={() => change({ ...progress, paused: true })}>
            暂停导览并保存进度
          </button>
        )}
        <ol className="experience-stops" aria-label="路线站点">
          {item.content.stops.map((entry, index) => (
            <li key={`${entry.point_id}:${index}`}>
              <button
                aria-current={progress.index === index ? "step" : undefined}
                onClick={() =>
                  change({ ...progress, index, paused: false }, true)
                }
              >
                <span>
                  {progress.completed.includes(index) ? "✓" : index + 1}
                </span>
                <span>
                  {entry.title ||
                    pointNames?.[entry.point_id] ||
                    `第 ${index + 1} 站`}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <section
          className="experience-current"
          aria-label={`第 ${progress.index + 1} 站`}
        >
          <h4>
            第 {progress.index + 1} 站
            {stop.title || pointNames?.[stop.point_id]
              ? ` · ${stop.title || pointNames?.[stop.point_id]}`
              : ""}
          </h4>
          {stop.segments && segments.length > 1 && (
            <nav className="experience-segment-tabs" aria-label="本站讲解段落">
              {segments.map((entry, index) => (
                <button
                  key={entry.id}
                  aria-current={
                    entry.id === current.segmentId ? "step" : undefined
                  }
                  onClick={() =>
                    change({ ...progress, segmentId: entry.id, paused: false })
                  }
                >
                  第 {index + 1} 段
                </button>
              ))}
            </nav>
          )}
          {segment.main_view.type !== "map" && (
            <TourResourceView
              key={`${segment.main_view.type}:${segment.main_view.id}:${segment.main_view.revision}`}
              resource={segment.main_view}
              pointId={stop.point_id}
              items={items}
            />
          )}
          <p className="experience-prose">
            {segment.text || "查看该地点的公开介绍，按自己的节奏参观。"}
          </p>
          {actions.onNarrate && segment.text.trim() && (
            <button
              onClick={() =>
                actions.onNarrate?.({
                  tourId: item.id,
                  tourRevision: item.revision,
                  stopIndex: current.stopIndex,
                  segmentId: stop.segments ? segment.id : undefined,
                  text: segment.text,
                  sourceNote: segment.source_note || item.content.source_note,
                  ...(draftRevision ? { draftRevision } : {}),
                })
              }
            >
              听小开讲解
            </button>
          )}
          {!preview && actions.onBookmark && (
            <button onClick={() => actions.onBookmark?.(current)}>
              收藏当前段落
            </button>
          )}
          {stop.segments && !progress.paused && (
            <div className="experience-segment-resources" aria-label="本段资料">
              {segment.resources.map((resource) => (
                <TourResourceView
                  key={`${current.stopIndex}:${segment.id}:${resource.type}:${resource.id}:${resource.revision}`}
                  resource={resource}
                  pointId={stop.point_id}
                  items={items}
                  onOpen={actions.onResourceOpen}
                />
              ))}
            </div>
          )}
          {segment.source_note && (
            <details>
              <summary>本段资料来源</summary>
              <p className="experience-prose">{segment.source_note}</p>
            </details>
          )}
          <button onClick={() => onSelectPoint(stop.point_id)}>
            在地图查看本站
          </button>
          {onNavigateStop && progress.index > 0 && (
            <button
              onClick={() => {
                if (item.content.kind === "tour")
                  onNavigateStop(
                    item.content.stops[progress.index - 1].point_id,
                    stop.point_id,
                  );
              }}
            >
              从上一站导航到本站
            </button>
          )}
          {!stop.segments &&
            !progress.paused &&
            stop.prompt_timing === "after_intro" &&
            !introRead && (
              <button onClick={() => setIntroRead(true)}>
                我已阅读本站介绍
              </button>
            )}
          {!stop.segments &&
            !progress.paused &&
            video &&
            !videoPrompt &&
            stop.prompt_timing === "manual" && (
              <button onClick={() => setManualVideo(true)}>查看本站视频</button>
            )}
          {videoPrompt && video && (
            <MediaView
              key={`${video.id}:${video.revision}:${progress.index}`}
              item={video}
            />
          )}
          {!stop.segments && !progress.paused && stop.video_id && !video && (
            <p>本站视频暂时不可用，仍可继续浏览。</p>
          )}
          {!stop.segments && !progress.paused && checkin && (
            <section aria-label="本站打卡">
              <h4>{checkin.content.title}</h4>
              <p className="experience-prose">{checkin.content.description}</p>
              <CheckinCard
                key={`${checkin.id}:${checkin.revision}:${progress.index}`}
                item={checkin}
                items={items}
              />
            </section>
          )}
          {!stop.segments &&
            !progress.paused &&
            stop.checkin_id &&
            !checkin && <p>本站打卡暂时不可用，请刷新路线资料后继续。</p>}
        </section>
        <div className="experience-step-controls">
          {segmentIndex > 0 && (
            <button
              onClick={() =>
                change({
                  ...progress,
                  segmentId: segments[segmentIndex - 1].id,
                  paused: false,
                })
              }
            >
              上一段
            </button>
          )}
          {segmentIndex < segments.length - 1 && (
            <button
              onClick={() =>
                change({
                  ...progress,
                  segmentId: segments[segmentIndex + 1].id,
                  paused: false,
                })
              }
            >
              下一段
            </button>
          )}
          <button
            disabled={progress.index === 0}
            onClick={() =>
              change(
                { ...progress, index: progress.index - 1, paused: false },
                true,
              )
            }
          >
            上一站
          </button>
          <button
            disabled={progress.paused}
            onClick={() =>
              change(
                advanceProgress(progress, count),
                progress.index < count - 1,
              )
            }
          >
            {progress.index === count - 1 ? "确认完成本站" : "完成本站，下一站"}
          </button>
          {progress.index < count - 1 && (
            <button
              onClick={() =>
                change(
                  { ...progress, index: progress.index + 1, paused: false },
                  true,
                )
              }
            >
              跳过本站
            </button>
          )}
        </div>
        <small>
          {preview
            ? "预览仅供已登录工作人员查看，未发布内容不会生成公众链接。"
            : "进度仅保存在此浏览器。路线内容更新后会重新开始。"}
        </small>
        {!storageOk && (
          <p role="status">浏览器未允许保存，请保持此页面打开。</p>
        )}
        <details>
          <summary>资料来源</summary>
          <p className="experience-prose">{item.content.source_note}</p>
        </details>
      </article>
    </ExperienceActions.Provider>
  );
}
