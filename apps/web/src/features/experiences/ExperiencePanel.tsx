import { createContext, useContext, useEffect, useRef, useState } from "react";
import { get } from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import { experienceNames, type Experience, type ExperienceKind } from "./types";
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

const ExperienceActions = createContext<{
  active: boolean;
  onMediaActiveChange?: (active: boolean) => void;
  onNavigateStop?: (from: string, to: string) => void;
  pointNames?: Record<string, string>;
}>({ active: true });

export type ExperiencePanelProps = {
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
}: ExperiencePanelProps) {
  const [items, setItems] = useState<Experience[]>([]);
  const [kind, setKind] = useState<ExperienceKind | "">(
    initialKind ?? (pointId ? "" : "tour"),
  );
  const [selectedId, setSelectedId] = useState(initialExperienceId ?? "");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
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
      value={{ active, onMediaActiveChange, onNavigateStop, pointNames }}
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
}: {
  item: Experience;
  items: Experience[];
  onSelectPoint: (id: string) => void;
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
        <MediaView item={item} />
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

export function MediaView({ item }: { item: Experience }) {
  const { active, onMediaActiveChange } = useContext(ExperienceActions);
  const callback = useRef(onMediaActiveChange);
  callback.current = onMediaActiveChange;
  const [consented, setConsented] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = safeMediaUrl(item.media_url);
  useEffect(() => {
    setConsented(false);
    setFailed(false);
  }, [item.id, item.revision, item.media_url]);
  useEffect(() => {
    if (!active) {
      setConsented(false);
      callback.current?.(false);
    }
    return () => callback.current?.(false);
  }, [active, item.id, item.revision, item.media_url]);
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
        <p>想观看《{item.content.title}》吗？</p>
        <a href={url} target="_blank" rel="noopener noreferrer">
          在新窗口观看视频
        </a>
        <small>将在提供方网站打开，当前导览保留。</small>
      </div>
    );
  if (!consented || !active)
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
          src={url}
          controls
          playsInline
          preload="metadata"
          onPlay={() => callback.current?.(true)}
          onPause={() => callback.current?.(false)}
          onEnded={() => callback.current?.(false)}
          onError={() => {
            setFailed(true);
            callback.current?.(false);
          }}
          aria-label={item.content.title}
        />
      )}
      <button
        onClick={() => {
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
  const image = items.find(
    (row) =>
      row.id === imageId &&
      row.content.kind === "media" &&
      row.content.media_type === "image",
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

export function TourPlayer({
  item,
  items,
  onSelectPoint,
}: {
  item: Experience;
  items: Experience[];
  onSelectPoint: (id: string) => void;
}) {
  const { onNavigateStop, pointNames } = useContext(ExperienceActions);
  const count = item.content.kind === "tour" ? item.content.stops.length : 0;
  const key = `twinnku:tour:${item.id}`;
  const [progress, setProgress] = useState<TourProgress>(() =>
    normalizeProgress(readLocal(key), item.revision, count),
  );
  const [introRead, setIntroRead] = useState(false);
  const [manualVideo, setManualVideo] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  if (item.content.kind !== "tour" || count === 0)
    return <p>这条路线暂时没有可浏览的站点。</p>;
  const stop = item.content.stops[progress.index];
  const video = items.find(
    (row) =>
      row.id === stop.video_id &&
      row.content.kind === "media" &&
      row.content.media_type === "video",
  );
  const videoPrompt =
    !progress.paused &&
    (stop.prompt_timing === "on_arrival" ||
      (stop.prompt_timing === "after_intro" && introRead) ||
      manualVideo);
  function change(next: TourProgress, locate = false) {
    setProgress(next);
    setIntroRead(false);
    setManualVideo(false);
    setStorageOk(writeLocal(key, next));
    if (locate && item.content.kind === "tour")
      onSelectPoint(item.content.stops[next.index].point_id);
  }
  return (
    <article className="experience-tour">
      <div className="experience-tour-hero">
        <span className="experience-eyebrow">CAMPUS ITINERARY</span>
        <h3>{item.content.title}</h3>
        <p>
          {count} 站 ·{" "}
          {new Set(item.content.stops.map((entry) => entry.point_id)).size}{" "}
          个校园地点
        </p>
      </div>
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
          <button onClick={() => change({ ...progress, paused: false }, true)}>
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
                {pointNames?.[entry.point_id] || `第 ${index + 1} 站`}
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
          {pointNames?.[stop.point_id] ? ` · ${pointNames[stop.point_id]}` : ""}
        </h4>
        <p className="experience-prose">
          {stop.narrative || "查看该地点的公开介绍，按自己的节奏参观。"}
        </p>
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
        {!progress.paused &&
          stop.prompt_timing === "after_intro" &&
          !introRead && (
            <button onClick={() => setIntroRead(true)}>我已阅读本站介绍</button>
          )}
        {!progress.paused &&
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
        {!progress.paused && stop.video_id && !video && (
          <p>本站视频暂时不可用，仍可继续浏览。</p>
        )}
      </section>
      <div className="experience-step-controls">
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
            change(advanceProgress(progress, count), progress.index < count - 1)
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
      <small>进度仅保存在此浏览器。路线内容更新后会重新开始。</small>
      {!storageOk && <p role="status">浏览器未允许保存，请保持此页面打开。</p>}
      <details>
        <summary>资料来源</summary>
        <p className="experience-prose">{item.content.source_note}</p>
      </details>
    </article>
  );
}
