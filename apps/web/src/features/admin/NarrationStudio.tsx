import { useEffect, useRef, useState } from "react";
import { acquireAudio, releaseAudio } from "../visit/audioOwner";
import type { ExperienceContent, TourSegment } from "../experiences/types";
import { normalizeSegment } from "../experiences/segments";
import { message, request } from "./api";
import { ErrorBox, useResource } from "./ui";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
export type NarrationJob = {
  id: string;
  tour_id: string;
  segment_id: string;
  source_revision: number;
  state:
    | "queued"
    | "running"
    | "ready"
    | "failed"
    | "unknown"
    | "cancelled"
    | "paused";
  total_chunks: number;
  completed_chunks: number;
  characters: number;
  attempts: number;
  last_error: string;
  asset_id: string | null;
};
type Profile = {
  id: "standard" | "demo";
  title: string;
  available: boolean;
  staff_requests_per_hour: number;
  staff_requests_per_day: number;
  max_characters_per_chunk: number;
};
type Manifest = {
  asset_id: string;
  manifest_id: string;
  text_sha256: string;
  chunks: {
    chunk_id: string;
    text: string;
    duration_seconds: number;
    byte_size: number;
    sha256: string;
    url: string;
  }[];
};
type Tour = Extract<ExperienceContent, { kind: "tour" }>;
const jobNames: Record<NarrationJob["state"], string> = {
  queued: "排队中",
  running: "生成中",
  ready: "待试听采用",
  failed: "生成失败",
  unknown: "供应商结果未知",
  cancelled: "已取消",
  paused: "已暂停",
};
export async function textSha256(text: string) {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buffer), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function safeAuditionManifest(
  manifest: Manifest,
  assetId: string,
): boolean {
  return (
    manifest.asset_id === assetId &&
    !!manifest.manifest_id &&
    manifest.chunks.length > 0 &&
    new Set(manifest.chunks.map((c) => c.chunk_id)).size ===
      manifest.chunks.length &&
    manifest.chunks.every(
      (c) =>
        /^[A-Za-z0-9_-]+$/.test(c.chunk_id) &&
        c.url ===
          `/api/v1/admin/narration-assets/${assetId}/chunks/${c.chunk_id}` &&
        c.duration_seconds > 0 &&
        /^[a-f0-9]{64}$/.test(c.sha256),
    )
  );
}
export function NarrationStudio({
  content,
  tourId,
  revision,
  dirty,
  editable,
  onSave,
  onChange,
  onPendingChange,
  focusSegmentId,
}: {
  content: Tour;
  tourId?: string;
  revision?: number;
  dirty: boolean;
  editable: boolean;
  onSave: () => Promise<boolean>;
  onChange: (tour: Tour) => void;
  onPendingChange?: (pending: boolean) => void;
  focusSegmentId?: string;
}) {
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [pendingGeneration, setPendingGeneration] = useState<{
    id: string;
    tourId: string;
    revision: number;
    segments: string[];
  } | null>(null);
  const [audition, setAudition] = useState<{
    job: NarrationJob;
    manifest: Manifest;
    sourceText: string;
  } | null>(null);
  const [pendingControl, setPendingControl] = useState<{
    job: NarrationJob;
    action: "cancel" | "retry";
  } | null>(null);
  const [chunkIndex, setChunkIndex] = useState(0),
    [heard, setHeard] = useState<string[]>([]);
  const profiles = useResource<Profile[]>("/narration-profiles", refresh);
  useEffect(() => {
    onPendingChange?.(busy || !!pendingGeneration || !!pendingControl);
  }, [busy, pendingGeneration, pendingControl, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  const jobs = useResource<NarrationJob[]>(
    tourId ? `/narration-jobs?tour_id=${tourId}` : null,
    refresh,
  );
  const segments = content.stops.flatMap((stop, stopIndex) =>
    (stop.segments ?? [])
      .map(normalizeSegment)
      .map((segment) => ({ segment, stopIndex, pointId: stop.point_id })),
  );
  const audio = useRef<HTMLAudioElement>(null),
    lease = useRef<number | undefined>(undefined),
    epoch = useRef(0);
  const currentAudition = useRef(audition),
    currentChunk = useRef(chunkIndex);
  currentAudition.current = audition;
  currentChunk.current = chunkIndex;
  useEffect(() => {
    const active = jobs.data?.data.some((j) =>
      ["queued", "running"].includes(j.state),
    );
    if (!active) return;
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") setRefresh((v) => v + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [jobs.data, refresh]);
  useEffect(() => {
    ++epoch.current;
    audio.current?.pause();
    releaseAudio("tour", lease.current);
    lease.current = undefined;
    setAudition(null);
    setHeard([]);
    setSelection([]);
    return () => {
      ++epoch.current;
      audio.current?.pause();
      releaseAudio("tour", lease.current);
    };
  }, [tourId]);
  useEffect(() => {
    if (
      audition &&
      !segments.some(
        (s) =>
          s.segment.id === audition.job.segment_id &&
          s.segment.text === audition.sourceText,
      )
    ) {
      audio.current?.pause();
      setAudition(null);
      setHeard([]);
      setNotice("该段讲稿已修改，旧试听不能采用。请保存并重新生成该段。");
    }
  }, [content, audition]);
  const standard = profiles.data?.data.find((p) => p.id === "standard");
  const chosen = segments.filter(
    (s) => selection.includes(s.segment.id) && s.segment.text.trim(),
  );
  const characters = chosen.reduce((n, s) => n + s.segment.text.length, 0);
  const estimatedChunks = chosen.reduce(
    (n, s) =>
      n +
      Math.ceil(
        s.segment.text.length / (standard?.max_characters_per_chunk || 200),
      ),
    0,
  );
  async function generate() {
    if (
      busy ||
      pendingControl ||
      pendingGeneration ||
      !standard?.available ||
      !chosen.length ||
      !editable
    )
      return;
    if (
      !window.confirm(
        `生成 ${chosen.length} 段、约 ${estimatedChunks} 个分片、${characters} 字符的正式讲解？可能产生供应商费用，需近期通行密钥验证。生成后仍须试听并明确采用。`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (!(await onSave()))
        throw new Error("请先确认当前版本保存成功，再生成讲解。");
      if (!tourId || !revision || dirty)
        throw new Error("草稿保存状态已变化，请等保存确认后再次选择生成。");
      const operation = {
        tour_id: tourId,
        expected_revision: revision,
        segment_ids: chosen.map((s) => s.segment.id),
        profile_id: "standard",
        operation_id: crypto.randomUUID(),
      };
      try {
        await confirmedOperation(
          operation.operation_id,
          async () => {
            const result = (
              await request<NarrationJob[]>(
                "/narration-jobs",
                "POST",
                operation,
              )
            ).data;
            if (
              !validGeneration(result, {
                tourId,
                revision,
                segments: operation.segment_ids,
              })
            )
              throw new Error("生成响应身份不符，请查询原操作。");
            return result;
          },
          async (id) =>
            recoverGeneration({
              id,
              tourId,
              revision,
              segments: operation.segment_ids,
            }),
        );
      } catch (e) {
        if (e instanceof UnconfirmedOperation)
          setPendingGeneration({
            id: e.operationId,
            tourId,
            revision,
            segments: operation.segment_ids,
          });
        throw e;
      }
      setNotice("任务已创建，后台按顺序生成。不会自动采用或公开。");
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(
        `${message(e)}。未确认结果时请查询本次生成结果；不会自动重复生成。`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function recoverGeneration(operation: {
    id: string;
    tourId: string;
    revision: number;
    segments: string[];
  }): Promise<NarrationJob[] | null> {
    const rows = (
      await request<NarrationJob[]>(
        `/narration-jobs?${new URLSearchParams({ tour_id: operation.tourId, operation_id: operation.id })}`,
      )
    ).data;
    return validGeneration(rows, operation) ? rows : null;
  }
  function validGeneration(
    rows: NarrationJob[],
    operation: { tourId: string; revision: number; segments: string[] },
  ) {
    return (
      Array.isArray(rows) &&
      rows.length === operation.segments.length &&
      rows.every(
        (j) =>
          j.tour_id === operation.tourId &&
          j.source_revision === operation.revision &&
          operation.segments.includes(j.segment_id),
      ) &&
      new Set(rows.map((j) => j.segment_id)).size === rows.length
    );
  }
  async function queryGeneration() {
    if (!pendingGeneration || busy) return;
    setBusy(true);
    try {
      const result = await recoverGeneration(pendingGeneration);
      if (!result)
        throw new Error(
          "本次生成任务尚未确认，请保留页面并稍后查询；不会再次发起生成。",
        );
      setPendingGeneration(null);
      setError("");
      setNotice("原生成请求已确认，请查看任务并试听。没有重复生成。");
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function control(job: NarrationJob, action: "cancel" | "retry") {
    if (
      busy ||
      !editable ||
      pendingGeneration ||
      pendingControl ||
      (action === "retry" && job.last_error === "NARRATION_RETIRED")
    )
      return;
    if (
      action === "retry" &&
      !window.confirm(
        job.state === "unknown"
          ? "原请求是否计费尚不明确，重试可能再次计费。明确重试？"
          : "重新生成可能产生供应商费用，明确重试？",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = (
        await request<NarrationJob>(
          `/narration-jobs/${job.id}/${action}`,
          "POST",
        )
      ).data;
      if (!sameJob(result, job))
        throw new Error("任务操作响应身份不符，请读取原任务。");
      setRefresh((v) => v + 1);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (typeof status !== "number" || status >= 500 || status === 408)
        setPendingControl({ job, action });
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function sameJob(result: NarrationJob, job: NarrationJob) {
    return (
      result?.id === job.id &&
      result.tour_id === job.tour_id &&
      result.segment_id === job.segment_id &&
      result.source_revision === job.source_revision
    );
  }
  async function queryControl() {
    if (!pendingControl || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = (
        await request<NarrationJob>(`/narration-jobs/${pendingControl.job.id}`)
      ).data;
      if (!sameJob(result, pendingControl.job))
        throw new Error("原任务身份不符，操作仍未确认。");
      const confirmed =
        pendingControl.action === "cancel"
          ? ["cancelled", "ready", "failed", "unknown"].includes(result.state)
          : ["queued", "running", "ready"].includes(result.state) ||
            result.attempts > pendingControl.job.attempts;
      if (!confirmed)
        throw new Error(
          "原任务仍未确认变化，请稍后再次读取，不要重复取消或收费重试。",
        );
      setPendingControl(null);
      setRefresh((value) => value + 1);
      setNotice(
        `已读取原任务当前状态：${jobNames[result.state]}。没有重复发起操作；任务状态不代表供应商已经收到的请求停止计费。`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function listen(job: NarrationJob) {
    if (!job.asset_id || busy) return;
    const source = segments.find((s) => s.segment.id === job.segment_id);
    if (!source) {
      setError("该段落已移除，不能采用这份音频。");
      return;
    }
    const turn = ++epoch.current;
    setBusy(true);
    setError("");
    audio.current?.pause();
    setAudition(null);
    setHeard([]);
    try {
      const manifest = (
        await request<Manifest>(`/narration-assets/${job.asset_id}/manifest`)
      ).data;
      if (turn !== epoch.current) return;
      if (!safeAuditionManifest(manifest, job.asset_id))
        throw new Error("音频清单不完整或路径不合法，已停止试听。");
      if (manifest.text_sha256 !== (await textSha256(source.segment.text)))
        throw new Error("音频与当前讲稿不一致，请重新生成该段。");
      if (turn !== epoch.current) return;
      setAudition({ job, manifest, sourceText: source.segment.text });
      setChunkIndex(0);
    } catch (e) {
      if (turn === epoch.current) setError(message(e));
    } finally {
      if (turn === epoch.current) setBusy(false);
    }
  }
  function adopt() {
    if (
      !audition ||
      !editable ||
      !audition.manifest.chunks.every((c) => heard.includes(c.chunk_id))
    )
      return;
    const current = segments.find(
      (s) => s.segment.id === audition.job.segment_id,
    );
    if (!current || current.segment.text !== audition.sourceText) {
      setError("讲稿已变化，请重新生成。");
      return;
    }
    onChange({
      ...content,
      stops: content.stops.map((stop, i) =>
        i === current.stopIndex
          ? {
              ...stop,
              segments: stop.segments?.map((s) =>
                s.id === current.segment.id
                  ? { ...s, narration_asset_id: audition.manifest.asset_id }
                  : s,
              ),
            }
          : stop,
      ),
    });
    setNotice("已明确采用到当前草稿；保存并独立审核发布后才用于公众导览。");
  }
  return (
    <section className="ad-narration-studio">
      <h3>正式讲解音频</h3>
      <p>
        保存、预览、检查不调用收费服务。只有明确点击生成／重试才创建任务；供应商连接、设备实听仍需单独验收。
      </p>
      <ErrorBox
        text={error || profiles.error || jobs.error}
        onRetry={() => setRefresh((v) => v + 1)}
      />
      {notice && <p role="status">{notice}</p>}
      <p>
        {standard?.available
          ? `${standard.title}可用 · 员工每小时 ${standard.staff_requests_per_hour} 次 / 每日 ${standard.staff_requests_per_day} 次`
          : "正式生成尚未启用或已暂停；可以继续整理讲稿。"}
      </p>
      {!segments.length && (
        <p>
          本站仍为旧单段模式。先明确转换成分段，保留原文与媒体时机，再选择生成。
        </p>
      )}
      <div className="ad-narration-list">
        {segments.map(({ segment: s, stopIndex }) => (
          <label
            className="ad-check"
            key={s.id}
            data-issue-focus={s.id === focusSegmentId || undefined}
          >
            <input
              type="checkbox"
              checked={selection.includes(s.id)}
              disabled={!editable || !s.text.trim()}
              onChange={(e) =>
                setSelection(
                  e.target.checked
                    ? [...selection, s.id]
                    : selection.filter((id) => id !== s.id),
                )
              }
            />
            第 {stopIndex + 1} 站 ·{" "}
            {s.title ||
              `讲解段落 ${content.stops[stopIndex].segments?.findIndex((v) => v.id === s.id)! + 1}`}{" "}
            · {s.text.length} 字 ·{" "}
            {s.narration_asset_id ? "已采用正式音频" : "待采用"}
            {s.id === focusSegmentId && (
              <strong> · 检查结果指向此段（未自动勾选或生成）</strong>
            )}
          </label>
        ))}
      </div>
      <p>
        已选 {chosen.length} 段 · {characters} 字符 · 约 {estimatedChunks}{" "}
        个请求分片（最终以服务端分片与供应商计费为准）。
      </p>
      <button
        disabled={
          busy ||
          dirty ||
          !tourId ||
          pendingGeneration !== null ||
          pendingControl !== null ||
          !chosen.length ||
          !standard?.available ||
          !editable
        }
        onClick={() => void generate()}
      >
        明确生成所选讲解
      </button>
      {pendingGeneration && (
        <button disabled={busy} onClick={() => void queryGeneration()}>
          查询本次生成结果（不重复收费）
        </button>
      )}
      {pendingControl && (
        <div role="alert">
          <p>
            这次任务操作结果尚未确认；新的生成／收费重试已经暂停，请读取原任务状态。
          </p>
          <button disabled={busy} onClick={() => void queryControl()}>
            读取原任务操作结果
          </button>
        </div>
      )}
      <button disabled={busy} onClick={() => setRefresh((v) => v + 1)}>
        刷新任务状态
      </button>
      <div className="ad-narration-list">
        {jobs.data?.data.map((job) => (
          <article key={job.id} className="ad-narration-job">
            <strong>
              {segments.find((s) => s.segment.id === job.segment_id)?.segment
                .title || "讲解段落"}{" "}
              · {jobNames[job.state]}
            </strong>
            <p>
              源草稿 v{job.source_revision} · {job.completed_chunks} /{" "}
              {job.total_chunks} 分片 · {job.characters} 字符
            </p>
            {job.last_error && (
              <p>
                {job.last_error === "NARRATION_RETIRED"
                  ? "未采用的试听资产已经到期回收；原任务记录保留。请明确选择当前讲稿并创建新任务，旧任务无法重试。"
                  : job.last_error}
              </p>
            )}
            {job.state === "ready" && (
              <button disabled={busy} onClick={() => void listen(job)}>
                工作人员试听
              </button>
            )}
            {["queued", "running", "paused"].includes(job.state) &&
              editable && (
                <button
                  disabled={busy || !!pendingGeneration || !!pendingControl}
                  onClick={() => void control(job, "cancel")}
                >
                  取消后续任务
                </button>
              )}
            {["failed", "unknown", "cancelled", "paused"].includes(job.state) &&
              job.last_error !== "NARRATION_RETIRED" &&
              editable && (
                <button
                  disabled={
                    busy ||
                    !!pendingGeneration ||
                    !!pendingControl ||
                    !standard?.available
                  }
                  onClick={() => void control(job, "retry")}
                >
                  明确重试
                </button>
              )}
          </article>
        ))}
      </div>
      {audition && (
        <section className="ad-narration-audition" aria-label="员工私有试听">
          <h4>
            试听 · 第 {chunkIndex + 1} / {audition.manifest.chunks.length} 段
          </h4>
          <p>{audition.manifest.chunks[chunkIndex].text}</p>
          <audio
            key={`${audition.manifest.manifest_id}:${chunkIndex}`}
            ref={audio}
            src={audition.manifest.chunks[chunkIndex].url}
            controls
            preload="none"
            onPlay={() => {
              if (
                currentAudition.current?.manifest.manifest_id !==
                  audition.manifest.manifest_id ||
                currentAudition.current?.manifest.asset_id !==
                  audition.manifest.asset_id ||
                currentChunk.current !== chunkIndex
              )
                return;
              lease.current = acquireAudio("tour", () =>
                audio.current?.pause(),
              );
            }}
            onPause={() => {
              if (
                currentAudition.current?.manifest.manifest_id ===
                  audition.manifest.manifest_id &&
                currentAudition.current?.manifest.asset_id ===
                  audition.manifest.asset_id &&
                currentChunk.current === chunkIndex
              )
                releaseAudio("tour", lease.current);
            }}
            onEnded={() => {
              if (
                currentAudition.current?.manifest.manifest_id !==
                  audition.manifest.manifest_id ||
                currentAudition.current?.manifest.asset_id !==
                  audition.manifest.asset_id ||
                currentChunk.current !== chunkIndex
              )
                return;
              releaseAudio("tour", lease.current);
              const id = audition.manifest.chunks[chunkIndex].chunk_id;
              setHeard((v) => [...new Set([...v, id])]);
            }}
            onError={() => {
              if (
                currentAudition.current?.manifest.manifest_id ===
                  audition.manifest.manifest_id &&
                currentAudition.current?.manifest.asset_id ===
                  audition.manifest.asset_id &&
                currentChunk.current === chunkIndex
              )
                setError(
                  "该音频分片读取失败，请刷新清单后重试；讲稿和任务保留。",
                );
            }}
          />
          <div>
            <button
              disabled={chunkIndex === 0}
              onClick={() => setChunkIndex((i) => i - 1)}
            >
              上一段
            </button>
            <button
              disabled={chunkIndex === audition.manifest.chunks.length - 1}
              onClick={() => setChunkIndex((i) => i + 1)}
            >
              下一段
            </button>
          </div>
          <p>
            已结束播放 {heard.length} / {audition.manifest.chunks.length}{" "}
            段。请确认读音、停顿和讲稿一致。
          </p>
          <button
            disabled={
              !editable ||
              !audition.manifest.chunks.every((c) => heard.includes(c.chunk_id))
            }
            onClick={adopt}
          >
            听完并明确采用到草稿
          </button>
          <button
            onClick={() => {
              ++epoch.current;
              audio.current?.pause();
              setAudition(null);
            }}
          >
            关闭试听
          </button>
        </section>
      )}
    </section>
  );
}
