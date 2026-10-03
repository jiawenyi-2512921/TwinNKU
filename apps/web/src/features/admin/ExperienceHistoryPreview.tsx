import { useEffect, useRef, useState } from "react";
import {
  MediaView,
  TourPlayer,
  type TourPreviewReference,
} from "../experiences/ExperiencePanel";
import {
  normalizeTourPosition,
  segmentsForStop,
  type TourPosition,
} from "../experiences/segments";
import { FloorViewer } from "../floors/FloorViewer";
import { VRPresentation } from "../points/VRPresentation";
import { acquireAudio, releaseAudio } from "../visit/audioOwner";
import AdminTourMapPreview from "./AdminTourMapPreview";
import { message, request } from "./api";
import { ErrorBox } from "./ui";
import {
  assertHistoryResponse,
  historyPrefix,
  safeHistoryFile,
  type ExperienceHistoryPreviewData,
  type HistoricalResource,
  type HistoryBinding,
  type HistorySnapshot,
} from "./experienceHistoryTypes";
import "./experience-history-preview.css";

export function ExperienceHistoryPreview({
  experienceId,
  versionId,
  snapshot,
  onClose,
}: {
  experienceId: string;
  versionId: string;
  snapshot: HistorySnapshot;
  onClose: () => void;
}) {
  const [data, setData] = useState<ExperienceHistoryPreviewData | null>(null);
  const [position, setPosition] = useState<TourPosition | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0),
    [phone, setPhone] = useState(false);
  const [mapRequested, setMapRequested] = useState(false);
  const source = useRef<{ key: string; sha: string } | null>(null);
  const sourceKey = `${experienceId}:${versionId}:${snapshot}`;
  const stopIndex = position?.stopIndex ?? 0;
  const binding = { experienceId, versionId, snapshot, stopIndex };
  useEffect(() => {
    const controller = new AbortController();
    const previousSource = source.current?.key === sourceKey;
    if (!previousSource) {
      source.current = null;
      setPosition(null);
      setData(null);
    }
    setLoading(true);
    setError("");
    const selected = {
      experienceId,
      versionId,
      snapshot,
      stopIndex: previousSource ? stopIndex : 0,
    };
    async function load() {
      const result = (
        await request<ExperienceHistoryPreviewData>(
          `${historyPrefix(selected)}/preview?${new URLSearchParams({ snapshot, stop_index: String(selected.stopIndex) })}`,
          "GET",
          undefined,
          controller.signal,
        )
      ).data;
      if (controller.signal.aborted) return;
      assertHistoryResponse(result, selected, source.current?.sha);
      source.current = { key: sourceKey, sha: result.snapshot_sha256 };
      setData(result);
      if (result.item.content.kind === "tour")
        setPosition((p) =>
          normalizeTourPosition(
            p,
            result.item.revision,
            result.item.content.kind === "tour"
              ? result.item.content.stops
              : [],
          ),
        );
    }
    void load()
      .catch((e) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(message(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [experienceId, versionId, snapshot, stopIndex, retry]);
  const ready =
    !loading &&
    data?.stop_index === stopIndex &&
    data.version_id === versionId &&
    data.snapshot === snapshot;
  const item =
    data?.version_id === versionId &&
    data.experience_id === experienceId &&
    data.snapshot === snapshot
      ? data.item
      : undefined;
  const stop =
    item?.content.kind === "tour" ? item.content.stops[stopIndex] : null;
  const segment = stop
    ? segmentsForStop(stop, stopIndex).find((s) => s.id === position?.segmentId)
    : null;
  const segmentIndex =
    stop?.segments?.findIndex((s) => s.id === segment?.id) ?? -1;
  const audio = ready
    ? data.resources.find(
        (row) =>
          row.path ===
            `stops.${stopIndex}.segments.${segmentIndex}.narration_asset_id` &&
          row.segment_id === segment?.id &&
          row.id === segment?.narration_asset_id,
      )
    : undefined;
  useEffect(
    () => setMapRequested(false),
    [sourceKey, stopIndex, position?.segmentId],
  );
  function renderResource(
    ref: TourPreviewReference,
    pointId: string,
    path: string,
  ) {
    if (!ready) return <p role="status">正在核验该站历史资源…</p>;
    const row = data.resources.find(
      (row) =>
        row.path === path &&
        row.id === ref.id &&
        row.type === (ref.type === "vr_entry" ? "vr" : ref.type) &&
        (row.revision ?? null) === (ref.revision ?? null) &&
        (!pointId || row.point_id === pointId),
    );
    return row ? (
      <HistoricalResourceView
        key={`${sourceKey}:${path}`}
        row={row}
        rows={data.resources}
        binding={binding}
        sectionId={ref.section_id}
      />
    ) : (
      <p role="alert">原资源引用无法确认，仍可阅读历史原文。</p>
    );
  }
  return (
    <section className="ad-history-preview" aria-label="历史版本私有预览">
      <header>
        <h3>历史{snapshot === "draft" ? "草稿" : "正式快照"}预览</h3>
        <button type="button" onClick={onClose}>
          关闭历史预览
        </button>
      </header>
      <p>
        只读展示原段落。没有保存旧版资源的引用会显示占位；不会使用最新资料替代、保存游客进度或生成收费音频。
      </p>
      <label>
        <input
          type="checkbox"
          checked={phone}
          onChange={(event) => setPhone(event.target.checked)}
        />
        手机宽度预览（布局参考，仍需真机验收）
      </label>
      <ErrorBox text={error} onRetry={() => setRetry((value) => value + 1)} />
      {loading && <p role="status">正在核验历史快照与该站引用…</p>}
      <div
        className={
          phone ? "ad-history-device ad-history-phone" : "ad-history-device"
        }
      >
        {item?.content.kind === "tour" ? (
          <>
            <TourPlayer
              item={item}
              items={[]}
              preview
              active
              position={position}
              onPositionChange={setPosition}
              onMainViewChange={() => {}}
              onNarrationStop={() => {}}
              onMediaActiveChange={() => {}}
              onSelectPoint={() => setMapRequested(true)}
              renderPreviewResource={renderResource}
            />
            {stop && (segment?.main_view.type === "map" || mapRequested) && (
              <section aria-label="历史地点的当前空间参考">
                <strong>
                  当前公开地图空间参考，不代表该历史版本的底图或几何。
                </strong>
                <AdminTourMapPreview
                  campusId={item.campus_id}
                  pointId={stop.point_id}
                />
              </section>
            )}
            {audio && data && (
              <HistoricalResourceView
                key={`${sourceKey}:${audio.path}`}
                row={audio}
                rows={data.resources}
                binding={binding}
              />
            )}
          </>
        ) : item &&
          ready &&
          data.resources.find((row) => row.path === "self") ? (
          <HistoricalResourceView
            row={data.resources.find((row) => row.path === "self")!}
            rows={data.resources}
            binding={binding}
          />
        ) : null}
      </div>
    </section>
  );
}

export function HistoricalResourceView({
  row,
  rows,
  binding,
  sectionId,
}: {
  row: HistoricalResource;
  rows: HistoricalResource[];
  binding: HistoryBinding;
  sectionId?: string | null;
}) {
  const [described, setDescribed] = useState(false),
    [section, setSection] = useState(sectionId ?? "");
  useEffect(() => {
    setDescribed(false);
    setSection(sectionId ?? "");
  }, [row.path, row.id, row.revision, sectionId]);
  if (row.state !== "ready")
    return (
      <div className="ad-history-placeholder" role="status">
        <strong>历史资源不可展示</strong>
        <p>{row.message || "原引用无法核验，保留历史原文。"}</p>
      </div>
    );
  if (row.narration && row.type === "narration")
    return (
      <HistoryAudio manifest={row.narration} row={row} binding={binding} />
    );
  if (
    row.type === "floor" &&
    row.floor &&
    row.floor.id === row.id &&
    row.floor.revision === row.revision &&
    row.floor.point_id === row.point_id
  ) {
    const images = (row.floor.images ?? []).filter(
        (image) => image.variant === "labeled",
      ),
      selected =
        images.find((image) => image.section === section) ??
        (!section ? images[0] : undefined);
    return (
      <section>
        <h4>
          {row.floor.label} · 原引用 v{row.revision}
        </h4>
        <p>{row.floor.description}</p>
        {images.length > 1 && (
          <label>
            楼层分区
            <select
              value={selected?.section ?? section}
              onChange={(event) => setSection(event.target.value)}
            >
              {images.map((image) => (
                <option key={image.section} value={image.section}>
                  {image.section_label ?? image.section}
                </option>
              ))}
            </select>
          </label>
        )}
        {selected ? (
          <>
            <p>{selected.description}</p>
            <FloorViewer
              asset={selected}
              title={`${row.floor.label} · ${selected.section_label ?? selected.section}`}
            />
          </>
        ) : (
          <p>原楼层分区无法确认。</p>
        )}
      </section>
    );
  }
  if (
    row.type === "vr" &&
    row.panorama &&
    row.panorama.id === row.id &&
    row.panorama.revision === row.revision &&
    row.panorama.point_id === row.point_id
  ) {
    let href: string | null = null;
    try {
      const url = new URL(row.panorama.url);
      if (url.protocol === "https:" && !url.username && !url.password)
        href = url.href;
    } catch {
      /* Invalid link remains text-only. */
    }
    return (
      <section>
        <h4>
          {row.panorama.title} · 原引用 v{row.revision}
        </h4>
        <VRPresentation item={row.panorama} />
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer">
            打开原引用的 VR 原站
          </a>
        )}
        <p>第三方画面不保存在本站；相同入口版本不保证外站画面与当时相同。</p>
      </section>
    );
  }
  const original = row.item;
  if (
    !original ||
    original.id !== row.id ||
    (row.revision != null && original.revision !== row.revision) ||
    (original.content.kind !== "tour" &&
      original.content.point_id !== row.point_id)
  )
    return <p role="alert">历史资源身份无法确认。</p>;
  if (original.content.kind === "checkin" && row.type === "checkin")
    return (
      <section>
        <h4>{original.content.title}</h4>
        <p>{original.content.description}</p>
        <p>打卡只读预览；不记录完成，不用未保存版本的图片替代原引用。</p>
      </section>
    );
  if (
    original.content.kind !== "media" ||
    original.content.media_type !== row.type
  )
    return <p role="alert">历史媒体类型无法确认。</p>;
  const originalContent = original.content;
  const description = rows.find(
    (child) =>
      child.path === `${row.path}.audio_description_video_id` &&
      child.id === originalContent.audio_description_video_id &&
      child.revision === originalContent.audio_description_video_revision &&
      child.type === "video" &&
      child.point_id === row.point_id,
  );
  const validDescription =
    description?.state === "ready" &&
    description.item?.id === description.id &&
    description.item?.revision === description.revision &&
    description.item?.content.kind === "media" &&
    description.item.content.media_type === "video" &&
    description.item.content.point_id === row.point_id &&
    description.item.content.video_visual_information === "audio_complete" &&
    !description.item.content.audio_description_video_id;
  const selected = described && validDescription ? description! : row;
  const media = selected.item!;
  const mediaUrl = safeHistoryFile(
    media.media_url,
    binding,
    "/media",
    selected.path,
  );
  const captionUrl = safeHistoryFile(
    media.caption_url,
    binding,
    "/captions",
    selected.path,
  );
  return (
    <section>
      {original.content.audio_description_video_id && (
        <div>
          {validDescription ? (
            <button
              type="button"
              aria-pressed={described}
              onClick={() => setDescribed((value) => !value)}
            >
              {described ? "返回历史原版" : "查看原引用的口述描述版"}
            </button>
          ) : (
            <p>
              {description?.message ||
                "历史口述描述版本无法确认，仍可阅读原文字稿。"}
            </p>
          )}
          <small>切换暂停原播放；再次手动播放，不自动发声。</small>
        </div>
      )}
      {mediaUrl ? (
        <MediaView
          key={`${selected.path}:${media.id}:${media.revision}`}
          item={{ ...media, media_url: mediaUrl, caption_url: null }}
          previewOnly
        />
      ) : (
        <p role="alert">历史媒体文件身份无法确认。</p>
      )}
      {captionUrl && (
        <a href={captionUrl} download>
          下载该历史版本的受控字幕
        </a>
      )}
      {media.content.kind === "media" &&
        !media.content.upload_id &&
        media.content.url && (
          <p>
            历史保留的是原链接；外站可能更新画面，本站未保存该版本的外站文件。
          </p>
        )}
    </section>
  );
}

export function HistoryAudio({
  manifest,
  row,
  binding,
}: {
  manifest: NonNullable<HistoricalResource["narration"]>;
  row: HistoricalResource;
  binding: HistoryBinding;
}) {
  const [index, setIndex] = useState(0),
    [error, setError] = useState("");
  const player = useRef<HTMLAudioElement>(null),
    played = useRef<HTMLAudioElement | null>(null),
    lease = useRef<number | null>(null);
  const segment = row.path.match(
    /^stops\.\d+\.segments\.(\d+)\.narration_asset_id$/,
  );
  // Bind to the original segment identifier; the API rechecks historical adoption.
  const chunk = manifest.chunks[index];
  const segmentId =
    row.segment_id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.segment_id)
      ? row.segment_id
      : null;
  const url =
    manifest.asset_id === row.id &&
    segment &&
    segmentId &&
    chunk &&
    /^[A-Za-z0-9_-]{1,80}$/.test(chunk.chunk_id)
      ? safeHistoryFile(
          chunk.url,
          binding,
          `/narration/${segmentId}/${row.id}/chunks/${chunk.chunk_id}`,
        )
      : null;
  function pause() {
    (player.current ?? played.current)?.pause();
    if (lease.current !== null) {
      releaseAudio("tour", lease.current);
      lease.current = null;
    }
  }
  useEffect(() => () => pause(), [manifest.asset_id, index]);
  return (
    <section aria-label="历史正式音频试听">
      <h4>原段落已采用的音频 · 私有只读试听</h4>
      <p>读取既有文件，不调用生成服务。关闭预览或切换段落会停止播放。</p>
      {manifest.chunks.length > 1 && (
        <label>
          讲解分片
          <select
            value={index}
            onChange={(event) => {
              pause();
              setError("");
              setIndex(Number(event.target.value));
            }}
          >
            {manifest.chunks.map((entry, n) => (
              <option key={entry.chunk_id} value={n}>
                第 {n + 1} 段
              </option>
            ))}
          </select>
        </label>
      )}
      <p>{chunk?.text}</p>
      {url ? (
        <audio
          ref={player}
          controls
          preload="none"
          src={url}
          onPlay={(event) => {
            played.current = event.currentTarget;
            lease.current = acquireAudio("tour", pause);
          }}
          onPause={pause}
          onEnded={pause}
          onError={() => {
            pause();
            setError("历史音频当前无法读取，仍可阅读原文。");
          }}
        />
      ) : (
        <p role="alert">历史音频文件身份无法确认。</p>
      )}
      <ErrorBox text={error} />
    </section>
  );
}
