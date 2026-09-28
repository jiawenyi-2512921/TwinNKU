import { useEffect, useState } from "react";
import { get } from "../../shared/api/client";
import { notifyCatalogPublished } from "../../shared/catalogSync";
import {
  experienceNames,
  type AdminExperience,
  type ExperienceContent,
  type ExperienceKind,
  type ExperienceStop,
  type ExperienceUpload,
} from "../experiences/types";
import { inlineVideo, moveStop, safeMediaUrl } from "../experiences/progress";
import {
  request,
  message,
  stateNames,
  type AdminPoint,
  type StaffSession,
} from "./api";
import { Empty, ErrorBox, useResource } from "./ui";
import "../experiences/experiences.css";

const newStop = (point_id: string): ExperienceStop => ({
  point_id,
  narrative: "",
  video_id: null,
  prompt_timing: "on_arrival",
});
function newContent(kind: ExperienceKind, point_id: string): ExperienceContent {
  const base = { point_id, title: "", description: "", source_note: "" };
  if (kind === "media")
    return { ...base, kind, media_type: "video", upload_id: null, url: null };
  if (kind === "checkin") return { ...base, kind, image_id: null };
  return { ...base, kind, stops: [newStop(point_id)] };
}

export function ExperienceWorkspace({
  session,
  onDirty,
  onUpdate,
  initialId,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  initialId?: string;
}) {
  const [kind, setKind] = useState<ExperienceKind | "">("");
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [points, setPoints] = useState<AdminPoint[]>([]);
  const [pointsError, setPointsError] = useState("");
  const [selected, setSelected] = useState<AdminExperience | null>(null);
  const [content, setContent] = useState<ExperienceContent | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const rows = useResource<AdminExperience[]>(
    `/experiences?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(state ? { state } : {}), ...(query.trim() ? { q: query.trim() } : {}) })}`,
    revision,
  );
  const allMedia = useResource<AdminExperience[]>(
    "/experiences?kind=media",
    revision,
  );
  const editable =
    session.permissions.includes("points.edit") &&
    selected?.state !== "in_review";
  const canReview = session.permissions.includes("points.review");
  const selfReview =
    !!selected &&
    (selected.contributor_ids.includes(session.user.id) ||
      selected.submitted_by === session.user.id);
  useEffect(() => {
    onDirty(dirty || busy, busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || busy) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  useEffect(() => {
    const controller = new AbortController();
    setPointsError("");
    async function loadPoints() {
      const collected: AdminPoint[] = [];
      for (let page = 1; ; page++) {
        const result = await request<AdminPoint[]>(
          `/points?page_size=100&page=${page}`,
          "GET",
          undefined,
          controller.signal,
        );
        collected.push(...result.data);
        if (
          !result.data.length ||
          !result.meta.pagination ||
          collected.length >= result.meta.pagination.total
        )
          break;
      }
      if (!controller.signal.aborted) setPoints(collected);
    }
    void loadPoints().catch((e) => {
      if (!controller.signal.aborted) setPointsError(message(e));
    });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    request<AdminExperience>(
      `/experiences/${initialId}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) load(r.data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [initialId, detailRetry]);
  function load(item: AdminExperience) {
    setSelected(item);
    setContent(
      ["draft", "in_review", "rejected"].includes(item.state)
        ? (item.content ?? item.published_content)
        : (item.published_content ?? item.content),
    );
    setPreview(item.media_url ?? null);
    setDirty(false);
    setNote("");
  }
  function canLeave() {
    return (
      !busy &&
      (!dirty || window.confirm("当前体验内容尚未保存，确定放弃修改吗？"))
    );
  }
  function edit(next: ExperienceContent) {
    setContent(next);
    setDirty(true);
    setNotice("");
  }
  async function choose(item: AdminExperience) {
    if (!canLeave()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      load((await request<AdminExperience>(`/experiences/${item.id}`)).data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function create(value: ExperienceKind) {
    if (!canLeave()) return;
    setSelected(null);
    setContent(newContent(value, ""));
    setPreview(null);
    setDirty(true);
    setError("");
    setNotice("");
    setNote("");
  }
  async function save() {
    if (!content || !editable || busy) return;
    if (
      !content.point_id ||
      !content.title.trim() ||
      !content.source_note.trim()
    ) {
      setError("请选择归属地点，并填写标题与来源/公开依据。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<AdminExperience>(
        selected ? `/experiences/${selected.id}` : "/experiences",
        selected ? "PUT" : "POST",
        {
          expected_revision: selected?.revision ?? 0,
          expected_published_revision: selected?.published_revision ?? 0,
          content,
        },
      );
      load(result.data);
      setRevision((n) => n + 1);
      onUpdate?.();
      setNotice("草稿已保存，预览无误后提交独立审核。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function operate(
    action: "submit" | "publish" | "reject" | "discard" | "retire",
  ) {
    if (!selected || busy || dirty) return;
    if (!note.trim()) {
      setError("请填写本次操作说明。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<AdminExperience>(
        `/experiences/${selected.id}/${action === "retire" ? "retire" : `review/${action}`}`,
        "POST",
        {
          expected_revision: selected.revision,
          note,
          ...(action === "retire"
            ? { expected_published_revision: selected.published_revision }
            : {}),
        },
      );
      load(result.data);
      setRevision((n) => n + 1);
      onUpdate?.();
      if (action === "publish") {
        notifyCatalogPublished();
        try {
          const publicRows =
            await get<{ id: string; revision: number }[]>("/experiences");
          const found = publicRows.data.find((row) => row.id === selected.id);
          if (
            result.data.status === "retired"
              ? !!found
              : found?.revision !== result.data.published_revision
          )
            throw new Error("公开版本尚未匹配");
          setNotice(
            result.data.status === "retired"
              ? "已下架，公开端已确认隐藏。"
              : "已发布，公开端已确认新版本。",
          );
        } catch {
          setNotice("后台发布已完成，公开端核验暂未通过，请打开校园体验确认。");
        }
      } else
        setNotice(
          {
            submit: "已提交审核，请另一位审核人员核对。",
            reject: "已退回，可继续修改。",
            discard: "本次草稿已撤回。",
            retire: "已创建下架申请，等待另一位审核人员审核。",
          }[action],
        );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (
      !content ||
      content.kind !== "media" ||
      !content.point_id ||
      !editable ||
      busy
    )
      return;
    const accepted =
      content.media_type === "video"
        ? ["video/mp4", "video/webm"]
        : ["image/jpeg", "image/png"];
    if (!accepted.includes(file.type) || file.size > 100 * 1024 * 1024) {
      setError(
        "请选择对应格式的文件，最大 100 MiB。图片支持 JPG/PNG，视频支持 MP4/WebM。",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<ExperienceUpload>(
        `/points/${content.point_id}/experience-media`,
        "POST",
        file,
      );
      edit({ ...content, upload_id: result.data.id, url: null });
      setPreview(result.data.url);
      setNotice("文件已上传。保存并通过独立审核后才会公开。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const mediaRows = (allMedia.data?.data ?? []).filter(
    (row) =>
      row.status === "published" && row.published_content?.kind === "media",
  );
  const publicMediaTitle = (id: string) =>
    mediaRows.find((row) => row.id === id)?.published_content?.title ??
    "当前引用的媒体（请核实其公开状态）";
  const pointName = (id: string) =>
    points.find((point) => point.point.id === id)?.point.name ?? "所选地点";
  function pointOptions(current: string) {
    return (
      <>
        <option value="">请选择地点</option>
        {current && !points.some((p) => p.point.id === current) && (
          <option value={current}>{pointName(current)}</option>
        )}
        {points.map((point) => (
          <option key={point.point.id} value={point.point.id}>
            {point.point.name}
          </option>
        ))}
      </>
    );
  }
  function mediaOptions(
    mediaType: "image" | "video",
    value: string | null | undefined,
    pointId: string,
  ) {
    const available = mediaRows.filter(
      (row) =>
        row.published_content?.kind === "media" &&
        row.published_content.media_type === mediaType &&
        row.published_content.point_id === pointId,
    );
    return (
      <>
        <option value="">不关联</option>
        {value && !available.some((row) => row.id === value) && (
          <option value={value}>{publicMediaTitle(value)}</option>
        )}
        {available.map((row) => (
          <option key={row.id} value={row.id}>
            {row.published_content?.title} ·{" "}
            {pointName(row.published_content!.point_id)}
          </option>
        ))}
      </>
    );
  }
  function changeStop(index: number, patch: Partial<ExperienceStop>) {
    if (content?.kind === "tour")
      edit({
        ...content,
        stops: content.stops.map((stop, i) =>
          i === index ? { ...stop, ...patch } : stop,
        ),
      });
  }
  const previewUrl =
    content?.kind === "media" ? safeMediaUrl(content.url || preview) : null;
  return (
    <section className="ad-experience-workspace">
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">CAMPUS EXPERIENCE</div>
          <h1>媒体、打卡与路线</h1>
          <p>整理地点影像与打卡参考，安排路线讲解和视频展示时机。</p>
        </div>
      </div>
      <ErrorBox
        text={error}
        onRetry={
          initialId && !selected
            ? () => setDetailRetry((n) => n + 1)
            : undefined
        }
      />
      {notice && (
        <p className="ad-notice" role="status">
          {notice}
        </p>
      )}
      <ErrorBox text={pointsError} onRetry={() => setRevision((n) => n + 1)} />
      <div className="ad-experience-layout">
        <aside className="ad-card ad-experience-list">
          <label>
            搜索体验
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="标题、介绍或来源"
            />
          </label>
          <div className="ad-experience-filters">
            <label>
              类型
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ExperienceKind | "")}
              >
                <option value="">所有类型</option>
                {Object.entries(experienceNames).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              审核状态
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">全部状态</option>
                {[
                  "draft",
                  "in_review",
                  "rejected",
                  "published",
                  "discarded",
                ].map((value) => (
                  <option key={value} value={value}>
                    {stateNames[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {session.permissions.includes("points.edit") && (
            <div className="ad-experience-create">
              {(["media", "checkin", "tour"] as const).map((value) => (
                <button
                  key={value}
                  disabled={busy}
                  onClick={() => create(value)}
                >
                  ＋{experienceNames[value]}
                </button>
              ))}
            </div>
          )}
          <ErrorBox
            text={rows.error}
            onRetry={() => setRevision((n) => n + 1)}
          />
          {rows.loading && <p role="status">正在读取…</p>}
          {rows.data?.data.map((row) => (
            <button
              key={row.id}
              className={`ad-experience-row${selected?.id === row.id ? " is-active" : ""}`}
              aria-pressed={selected?.id === row.id}
              disabled={busy}
              onClick={() => void choose(row)}
            >
              <strong>
                {row.content?.title ??
                  row.published_content?.title ??
                  "体验草稿"}
              </strong>
              <span>
                {experienceNames[(row.content ?? row.published_content)!.kind]}{" "}
                · {stateNames[row.state]}
                {row.status === "retired" ? " · 已下架" : ""}
              </span>
              <small>
                {pointName((row.content ?? row.published_content)!.point_id)}
              </small>
            </button>
          ))}
          {rows.data && !rows.data.data.length && (
            <p className="ad-muted">暂无符合筛选的体验。</p>
          )}
        </aside>
        <div className="ad-card ad-experience-editor">
          {!content ? (
            <Empty
              title="选择一项体验，或新建内容"
              detail="先整理图片/视频并发布，再在打卡点和路线中关联它们。"
            />
          ) : (
            <>
              <header>
                <span className="ad-eyebrow">
                  {experienceNames[content.kind]}
                </span>
                <h2>{selected ? content.title : "新建体验"}</h2>
                {selected && (
                  <p>
                    {selected.operation === "retire" ? "下架申请 · " : ""}
                    {stateNames[selected.state]} · 已发布版本{" "}
                    {selected.published_revision}
                  </p>
                )}
              </header>
              <fieldset
                disabled={!editable || busy}
                className="ad-experience-fields"
              >
                <legend className="sr-only">体验内容</legend>
                <label>
                  归属地点
                  <select
                    value={content.point_id}
                    disabled={!!selected}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (content.kind === "media") {
                        edit({ ...content, point_id: id, upload_id: null });
                        setPreview(null);
                      } else if (content.kind === "tour")
                        edit({
                          ...content,
                          point_id: id,
                          stops: content.stops.map((stop, i) =>
                            i === 0 && !stop.point_id
                              ? { ...stop, point_id: id }
                              : stop,
                          ),
                        });
                      else edit({ ...content, point_id: id, image_id: null });
                    }}
                  >
                    {pointOptions(content.point_id)}
                  </select>
                </label>
                <label>
                  标题
                  <input
                    maxLength={120}
                    value={content.title}
                    onChange={(e) =>
                      edit({ ...content, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  {content.kind === "tour" ? "路线介绍" : "介绍与观看提示"}
                  <textarea
                    rows={4}
                    maxLength={8000}
                    value={content.description}
                    onChange={(e) =>
                      edit({ ...content, description: e.target.value })
                    }
                  />
                </label>
                {content.kind === "media" && (
                  <>
                    <label>
                      媒体类型
                      <select
                        value={content.media_type}
                        onChange={(e) => {
                          edit({
                            ...content,
                            media_type: e.target.value as "image" | "video",
                            upload_id: null,
                            url: null,
                          });
                          setPreview(null);
                        }}
                      >
                        <option value="video">视频</option>
                        <option value="image">图片</option>
                      </select>
                    </label>
                    <label>
                      公开 HTTPS 链接
                      <input
                        type="url"
                        value={content.url ?? ""}
                        placeholder="https://…"
                        onChange={(e) => {
                          edit({
                            ...content,
                            url: e.target.value || null,
                            upload_id: null,
                          });
                          setPreview(null);
                        }}
                      />
                    </label>
                    <span className="ad-muted">
                      或上传本地
                      {content.media_type === "video"
                        ? "视频（MP4/WebM）"
                        : "图片（JPG/PNG）"}
                      ，最大 100
                      MiB。外部视频页面以链接打开；直链和上传视频可在站内播放。
                    </span>
                    <label>
                      上传文件
                      <input
                        type="file"
                        disabled={!content.point_id}
                        accept={
                          content.media_type === "video"
                            ? "video/mp4,video/webm"
                            : "image/jpeg,image/png"
                        }
                        onChange={(e) => {
                          const file = e.currentTarget.files?.[0];
                          if (file) void upload(file);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                    {content.upload_id && (
                      <p role="status">已关联上传文件，保存草稿后仍需审核。</p>
                    )}
                  </>
                )}
                {content.kind === "checkin" && (
                  <>
                    <label>
                      打卡样图
                      <select
                        value={content.image_id ?? ""}
                        onChange={(e) =>
                          edit({ ...content, image_id: e.target.value || null })
                        }
                      >
                        {mediaOptions(
                          "image",
                          content.image_id,
                          content.point_id,
                        )}
                      </select>
                    </label>
                    <p className="ad-muted">
                      样图先在“图片与视频”发布。访客的打卡记录由本人确认，仅存于其浏览器，不作为定位证明。
                    </p>
                  </>
                )}
                {content.kind === "tour" && (
                  <div className="ad-tour-builder">
                    <h3>路线站点</h3>
                    <p className="ad-muted">
                      依次安排地点、讲解文案和视频。真实步行路径由已审核路网计算，站点之间不会用直线替代。
                    </p>
                    {content.stops.map((stop, index) => (
                      <fieldset className="ad-tour-stop" key={index}>
                        <legend>第 {index + 1} 站</legend>
                        <div className="ad-tour-order">
                          <button
                            type="button"
                            aria-label={`第 ${index + 1} 站上移`}
                            disabled={index === 0}
                            onClick={() =>
                              edit({
                                ...content,
                                stops: moveStop(content.stops, index, -1),
                              })
                            }
                          >
                            ↑ 上移
                          </button>
                          <button
                            type="button"
                            aria-label={`第 ${index + 1} 站下移`}
                            disabled={index === content.stops.length - 1}
                            onClick={() =>
                              edit({
                                ...content,
                                stops: moveStop(content.stops, index, 1),
                              })
                            }
                          >
                            ↓ 下移
                          </button>
                          <button
                            type="button"
                            disabled={content.stops.length <= 1}
                            onClick={() =>
                              edit({
                                ...content,
                                stops: content.stops.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            移除此站
                          </button>
                        </div>
                        <label>
                          地点
                          <select
                            value={stop.point_id}
                            onChange={(e) =>
                              changeStop(index, {
                                point_id: e.target.value,
                                video_id: null,
                              })
                            }
                          >
                            {pointOptions(stop.point_id)}
                          </select>
                        </label>
                        <label>
                          本站讲解
                          <textarea
                            rows={4}
                            value={stop.narrative}
                            maxLength={8000}
                            onChange={(e) =>
                              changeStop(index, { narrative: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          关联视频
                          <select
                            value={stop.video_id ?? ""}
                            onChange={(e) =>
                              changeStop(index, {
                                video_id: e.target.value || null,
                              })
                            }
                          >
                            {mediaOptions(
                              "video",
                              stop.video_id,
                              stop.point_id,
                            )}
                          </select>
                        </label>
                        <label>
                          何时询问观看
                          <select
                            value={stop.prompt_timing}
                            onChange={(e) =>
                              changeStop(index, {
                                prompt_timing: e.target
                                  .value as ExperienceStop["prompt_timing"],
                              })
                            }
                          >
                            <option value="on_arrival">打开本站时</option>
                            <option value="after_intro">
                              访客确认读完介绍后
                            </option>
                            <option value="manual">访客主动选择视频时</option>
                          </select>
                        </label>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      disabled={content.stops.length >= 50}
                      onClick={() =>
                        edit({
                          ...content,
                          stops: [...content.stops, newStop("")],
                        })
                      }
                    >
                      ＋ 添加一站
                    </button>
                  </div>
                )}
                <label>
                  来源与公开依据
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={content.source_note}
                    onChange={(e) =>
                      edit({ ...content, source_note: e.target.value })
                    }
                    placeholder="注明资料来源、使用授权以及需要审核的事实"
                  />
                </label>
              </fieldset>
              {previewUrl && content.kind === "media" && (
                <section
                  className="ad-experience-preview"
                  aria-label="媒体预览"
                >
                  <h3>预览</h3>
                  {content.media_type === "image" ? (
                    <img
                      src={previewUrl}
                      alt={content.title || "待审核图片"}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                    />
                  ) : inlineVideo(previewUrl, !!content.upload_id) ? (
                    <video
                      src={previewUrl}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={content.title || "待审核视频"}
                    />
                  ) : (
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      在新窗口预览链接
                    </a>
                  )}
                </section>
              )}
              <ErrorBox
                text={allMedia.error}
                onRetry={() => setRevision((n) => n + 1)}
              />
              {editable && (
                <button
                  className="ad-primary"
                  disabled={busy || !dirty}
                  onClick={() => void save()}
                >
                  {busy ? "正在处理…" : "保存草稿"}
                </button>
              )}
              {selected?.published_content && (
                <details className="ad-experience-published">
                  <summary>对照当前公开版本</summary>
                  <PublishedContent
                    content={selected.published_content}
                    pointName={pointName}
                    mediaTitle={publicMediaTitle}
                  />
                </details>
              )}
              {selected && (
                <section className="ad-experience-review">
                  <h3>审核与发布</h3>
                  {selected.review_note && (
                    <p className="experience-prose">
                      上次说明：{selected.review_note}
                    </p>
                  )}
                  <label>
                    本次操作说明
                    <textarea
                      rows={2}
                      value={note}
                      disabled={busy}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  {dirty && <p>请先保存修改，再进行审核操作。</p>}
                  {selected.state === "in_review" && selfReview && (
                    <p>你参与了本次修改，请由另一位审核人员审核。</p>
                  )}
                  <div className="ad-experience-actions">
                    {editable &&
                      ["draft", "rejected"].includes(selected.state) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("submit")}
                        >
                          提交审核
                        </button>
                      )}
                    {session.permissions.includes("points.edit") &&
                      (selfReview || session.user.role === "admin") &&
                      ["draft", "rejected", "in_review"].includes(
                        selected.state,
                      ) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("discard")}
                        >
                          撤回草稿
                        </button>
                      )}
                    {canReview && selected.state === "in_review" && (
                      <>
                        <button
                          disabled={busy || dirty || selfReview}
                          className="ad-primary"
                          onClick={() => void operate("publish")}
                        >
                          {selected.operation === "retire"
                            ? "审核通过并下架"
                            : "审核通过并发布"}
                        </button>
                        <button
                          disabled={busy || dirty || selfReview}
                          onClick={() => void operate("reject")}
                        >
                          退回修改
                        </button>
                      </>
                    )}
                    {editable &&
                      selected.status === "published" &&
                      ["published", "discarded"].includes(selected.state) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("retire")}
                        >
                          申请下架
                        </button>
                      )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function PublishedContent({
  content,
  pointName,
  mediaTitle,
}: {
  content: ExperienceContent;
  pointName: (id: string) => string;
  mediaTitle: (id: string) => string;
}) {
  return (
    <div>
      <h3>{content.title}</h3>
      <p>地点：{pointName(content.point_id)}</p>
      <p className="experience-prose">{content.description}</p>
      {content.kind === "media" && (
        <p>
          {content.media_type === "image" ? "图片" : "视频"}：
          {content.url || "已上传文件"}
        </p>
      )}
      {content.kind === "checkin" && (
        <p>参考图：{content.image_id ? mediaTitle(content.image_id) : "无"}</p>
      )}
      {content.kind === "tour" && (
        <ol>
          {content.stops.map((stop, index) => (
            <li key={index}>
              <strong>{pointName(stop.point_id)}</strong>
              <p className="experience-prose">{stop.narrative}</p>
              <p>
                视频：{stop.video_id ? mediaTitle(stop.video_id) : "无"}；展示：
                {
                  {
                    on_arrival: "打开本站时",
                    after_intro: "读完介绍后",
                    manual: "主动选择时",
                  }[stop.prompt_timing]
                }
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="experience-prose">来源：{content.source_note}</p>
    </div>
  );
}
