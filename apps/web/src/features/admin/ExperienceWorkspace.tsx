import { useEffect, useState } from "react";
import { get, type Campus } from "../../shared/api/client";
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
function newContent(kind: ExperienceKind, campus_id = ""): ExperienceContent {
  const base = { title: "", description: "", source_note: "" };
  const point_id = "";
  if (kind === "media")
    return {
      ...base,
      point_id,
      kind,
      media_type: "video",
      upload_id: null,
      url: null,
    };
  if (kind === "checkin") return { ...base, point_id, kind, image_id: null };
  return { ...base, campus_id, kind, stops: [newStop("")] };
}

export function ExperienceWorkspace({
  session,
  onDirty,
  onUpdate,
  initialId,
  kindScope = "all",
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  initialId?: string;
  kindScope?: "all" | "places" | "tours";
}) {
  const [kind, setKind] = useState<ExperienceKind | "">(
    kindScope === "tours" ? "tour" : "",
  );
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [points, setPoints] = useState<AdminPoint[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [activeStop, setActiveStop] = useState(0);
  const [stationQuery, setStationQuery] = useState("");
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
    `/experiences?${new URLSearchParams({ ...((kindScope === "tours" ? "tour" : kind) ? { kind: kindScope === "tours" ? "tour" : kind } : {}), ...(state ? { state } : {}), ...(query.trim() ? { q: query.trim() } : {}) })}`,
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
    void Promise.all([
      loadPoints(),
      get<Campus[]>("/campuses", controller.signal).then((result) => {
        if (!controller.signal.aborted) setCampuses(result.data);
      }),
    ]).catch((e) => {
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
    setActiveStop(0);
    setStationQuery("");
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
    const available = campuses.filter((campus) =>
      points.some((point) => point.point.campus_id === campus.id),
    );
    setContent(
      newContent(value, available.length === 1 ? available[0].id : ""),
    );
    setActiveStop(0);
    setStationQuery("");
    setPreview(null);
    setDirty(true);
    setError("");
    setNotice("");
    setNote("");
  }
  async function save(submit = false) {
    if (!content || !editable || busy) return;
    if (!content.title.trim() || !content.source_note.trim()) {
      setError("请填写标题与来源/公开依据。");
      return;
    }
    if (content.kind === "tour") {
      const authorized = new Set(
        points
          .filter((point) => point.point.campus_id === content.campus_id)
          .map((point) => point.point.id),
      );
      if (
        !content.campus_id ||
        !content.stops.length ||
        content.stops.some((stop) => !authorized.has(stop.point_id))
      ) {
        setError("请选择校区，并为每一站选择该校区内有权限管理的地点。");
        return;
      }
    } else if (!content.point_id) {
      setError("请选择归属地点。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let saved = selected;
    let draftSaved = false;
    const submissionNote =
      note.trim() || `提交${experienceNames[content.kind]}审核`;
    try {
      if (dirty || !selected) {
        const result = await request<AdminExperience>(
          selected ? `/experiences/${selected.id}` : "/experiences",
          selected ? "PUT" : "POST",
          {
            expected_revision: selected?.revision ?? 0,
            expected_published_revision: selected?.published_revision ?? 0,
            content,
          },
        );
        saved = result.data;
        draftSaved = true;
        load(saved);
        setRevision((n) => n + 1);
        onUpdate?.();
      }
      if (submit && saved) {
        const result = await request<AdminExperience>(
          `/experiences/${saved.id}/review/submit`,
          "POST",
          { expected_revision: saved.revision, note: submissionNote },
        );
        load(result.data);
        setRevision((n) => n + 1);
        onUpdate?.();
        setNotice("草稿已保存并提交审核，请另一位审核人员核对后发布。");
      } else setNotice("草稿已保存，可以继续编排或提交审核。");
    } catch (e) {
      setError(
        (submit && draftSaved
          ? "草稿已保存，但提交审核未完成。可稍后重试提交："
          : "") + message(e),
      );
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
  const campusName = (id: string) =>
    campuses.find((campus) => campus.id === id)?.name ?? "校区资料待加载";
  const availableCampuses = campuses.filter((campus) =>
    points.some((point) => point.point.campus_id === campus.id),
  );
  const allowedKinds: ExperienceKind[] =
    kindScope === "tours"
      ? ["tour"]
      : kindScope === "places"
        ? ["media", "checkin"]
        : ["media", "checkin", "tour"];
  const visibleRows = (rows.data?.data ?? []).filter((row) =>
    allowedKinds.includes((row.content ?? row.published_content)!.kind),
  );
  const routePoints =
    content?.kind === "tour"
      ? points.filter((point) => point.point.campus_id === content.campus_id)
      : points;
  const stationMatches = routePoints.filter(
    (point) =>
      !stationQuery.trim() ||
      [point.point.name, ...(point.point.aliases ?? [])].some((name) =>
        name
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(stationQuery.trim().normalize("NFKC").toLocaleLowerCase()),
      ),
  );
  function pointOptions(current: string, options = points) {
    return (
      <>
        <option value="">请选择地点</option>
        {current && !options.some((p) => p.point.id === current) && (
          <option value={current}>{pointName(current)}</option>
        )}
        {options.map((point) => (
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
            {row.published_content?.kind === "media"
              ? pointName(row.published_content.point_id)
              : ""}
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
          <h1>
            {kindScope === "tours"
              ? "校园导览路线"
              : kindScope === "places"
                ? "地点影像与打卡"
                : "校园内容工作台"}
          </h1>
          <p>
            {kindScope === "tours"
              ? "从校区出发，串联多个地点，统一安排讲解、视频和参观顺序。"
              : "整理地点影像与打卡参考，保存后交由另一位成员审核。"}
          </p>
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
            {kindScope === "tours" ? "搜索校园路线" : "搜索体验"}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="标题、介绍或来源"
            />
          </label>
          <div className="ad-experience-filters">
            {kindScope !== "tours" && (
              <label>
                类型
                <select
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as ExperienceKind | "")
                  }
                >
                  <option value="">所有类型</option>
                  {allowedKinds.map((value) => (
                    <option key={value} value={value}>
                      {experienceNames[value]}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
              {allowedKinds.map((value) => (
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
          {visibleRows.map((row) => (
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
                {(row.content ?? row.published_content)?.kind === "tour"
                  ? `${campusName(row.campus_id)} · ${((row.content ?? row.published_content) as Extract<ExperienceContent, { kind: "tour" }>).stops.length} 站`
                  : pointName(
                      (
                        (row.content ?? row.published_content) as Exclude<
                          ExperienceContent,
                          { kind: "tour" }
                        >
                      ).point_id,
                    )}
              </small>
            </button>
          ))}
          {rows.data && !visibleRows.length && (
            <p className="ad-muted">暂无符合筛选的体验。</p>
          )}
        </aside>
        <div className="ad-card ad-experience-editor">
          {!content ? (
            <Empty
              title={
                kindScope === "tours"
                  ? "开始编排一条校园路线"
                  : "选择一项体验，或新建内容"
              }
              detail={
                kindScope === "tours"
                  ? "选择校区 → 添加校园站点 → 配置讲解与视频 → 保存并提交审核。"
                  : "先整理图片/视频并发布，再将它们关联到打卡点。"
              }
            />
          ) : (
            <>
              <header>
                <span className="ad-eyebrow">
                  {experienceNames[content.kind]}
                </span>
                <h2>
                  {selected
                    ? content.title
                    : content.kind === "tour"
                      ? "新建校园导览路线"
                      : "新建体验"}
                </h2>
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
                {content.kind === "tour" ? (
                  <label>
                    路线所属校区
                    <select
                      value={content.campus_id}
                      disabled={!!selected}
                      onChange={(e) => {
                        if (
                          content.stops.some((stop) => stop.point_id) &&
                          !window.confirm(
                            "切换校区将清空当前站点编排，确定继续吗？",
                          )
                        )
                          return;
                        edit({
                          ...content,
                          campus_id: e.target.value,
                          stops: [newStop("")],
                        });
                        setActiveStop(0);
                        setStationQuery("");
                      }}
                    >
                      <option value="">请选择校区</option>
                      {content.campus_id &&
                        !availableCampuses.some(
                          (campus) => campus.id === content.campus_id,
                        ) && (
                          <option value={content.campus_id}>
                            {campusName(content.campus_id)}
                          </option>
                        )}
                      {availableCampuses.map((campus) => (
                        <option key={campus.id} value={campus.id}>
                          {campus.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      路线属于整个校区，可以串联校门、建筑、景观和文化点位。
                    </small>
                  </label>
                ) : (
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
                        } else
                          edit({ ...content, point_id: id, image_id: null });
                      }}
                    >
                      {pointOptions(content.point_id)}
                    </select>
                  </label>
                )}
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
                    <header className="ad-tour-builder-heading">
                      <div>
                        <h3>校园站点编排</h3>
                        <p>
                          {content.stops.filter((stop) => stop.point_id).length}{" "}
                          个已选站点 ·{" "}
                          {content.stops.filter((stop) => stop.video_id).length}{" "}
                          段关联视频
                        </p>
                      </div>
                      <span>最多 50 站</span>
                    </header>
                    <p className="ad-muted">
                      路线连接校区内多个地点。步行路径由已审核路网计算；此处安排参观顺序和各站内容。
                    </p>
                    <div className="ad-tour-canvas">
                      <section
                        className="ad-tour-picker"
                        aria-label="添加校园站点"
                      >
                        <label>
                          搜索校园地点
                          <input
                            value={stationQuery}
                            onChange={(e) => setStationQuery(e.target.value)}
                            placeholder="建筑、校门、景观名称"
                            disabled={!content.campus_id}
                          />
                        </label>
                        {!content.campus_id ? (
                          <p>先选择路线所属校区。</p>
                        ) : (
                          <div className="ad-tour-candidates">
                            {stationMatches.map((point) => (
                              <button
                                type="button"
                                key={point.point.id}
                                disabled={
                                  content.stops.filter((stop) => stop.point_id)
                                    .length >= 50
                                }
                                onClick={() => {
                                  const blank = content.stops.findIndex(
                                    (stop) => !stop.point_id,
                                  );
                                  const next =
                                    blank >= 0
                                      ? content.stops.map((stop, index) =>
                                          index === blank
                                            ? newStop(point.point.id)
                                            : stop,
                                        )
                                      : [
                                          ...content.stops,
                                          newStop(point.point.id),
                                        ];
                                  edit({ ...content, stops: next });
                                  setActiveStop(
                                    blank >= 0 ? blank : next.length - 1,
                                  );
                                }}
                              >
                                <span>{point.point.name}</span>
                                <small>
                                  {content.stops.some(
                                    (stop) => stop.point_id === point.point.id,
                                  )
                                    ? "再次加入"
                                    : "＋ 加入路线"}
                                </small>
                              </button>
                            ))}
                            {!stationMatches.length && (
                              <p>没有匹配的可管理地点。</p>
                            )}
                          </div>
                        )}
                      </section>
                      <section
                        className="ad-tour-itinerary"
                        aria-label="校园路线顺序"
                      >
                        <ol>
                          {content.stops.map((stop, index) => (
                            <li key={index}>
                              <button
                                type="button"
                                aria-current={
                                  activeStop === index ? "step" : undefined
                                }
                                onClick={() => setActiveStop(index)}
                              >
                                <span>{index + 1}</span>
                                <div>
                                  <strong>
                                    {stop.point_id
                                      ? pointName(stop.point_id)
                                      : "待添加站点"}
                                  </strong>
                                  <small>
                                    {stop.video_id ? "含视频" : "未关联视频"} ·{" "}
                                    {stop.narrative.trim()
                                      ? "已填写讲解"
                                      : "待填写讲解"}
                                  </small>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </section>
                    </div>
                    {content.stops.map((stop, index) =>
                      index !== activeStop ? null : (
                        <fieldset className="ad-tour-stop" key={index}>
                          <legend>
                            第 {index + 1} 站 ·{" "}
                            {stop.point_id
                              ? pointName(stop.point_id)
                              : "待添加"}
                          </legend>
                          <div className="ad-tour-order">
                            <button
                              type="button"
                              aria-label={`第 ${index + 1} 站上移`}
                              disabled={index === 0}
                              onClick={() => {
                                edit({
                                  ...content,
                                  stops: moveStop(content.stops, index, -1),
                                });
                                setActiveStop(index - 1);
                              }}
                            >
                              ↑ 上移
                            </button>
                            <button
                              type="button"
                              aria-label={`第 ${index + 1} 站下移`}
                              disabled={index === content.stops.length - 1}
                              onClick={() => {
                                edit({
                                  ...content,
                                  stops: moveStop(content.stops, index, 1),
                                });
                                setActiveStop(index + 1);
                              }}
                            >
                              ↓ 下移
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const next = content.stops.filter(
                                  (_, i) => i !== index,
                                );
                                edit({
                                  ...content,
                                  stops: next.length ? next : [newStop("")],
                                });
                                setActiveStop(Math.max(0, index - 1));
                              }}
                            >
                              移除此站
                            </button>
                          </div>
                          <label>
                            本站地点
                            <select
                              value={stop.point_id}
                              disabled={!content.campus_id}
                              onChange={(e) =>
                                changeStop(index, {
                                  point_id: e.target.value,
                                  video_id: null,
                                })
                              }
                            >
                              {pointOptions(stop.point_id, routePoints)}
                            </select>
                          </label>
                          <label>
                            本站讲解
                            <textarea
                              rows={5}
                              value={stop.narrative}
                              maxLength={8000}
                              onChange={(e) =>
                                changeStop(index, { narrative: e.target.value })
                              }
                              placeholder="访客在本站看到的讲解；请依据已核实资料填写"
                            />
                          </label>
                          <div className="ad-tour-media-settings">
                            <label>
                              本站视频
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
                              <small>
                                这里只显示本站已发布视频，可先在地点影像中上传并审核。
                              </small>
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
                                <option value="manual">
                                  访客主动选择视频时
                                </option>
                              </select>
                            </label>
                          </div>
                        </fieldset>
                      ),
                    )}
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
                <div className="ad-experience-savebar">
                  <span>
                    {dirty
                      ? "有未保存修改"
                      : selected?.state === "published"
                        ? "当前为公开版本"
                        : selected?.state === "discarded"
                          ? "草稿已撤回"
                          : "草稿已保存"}
                  </span>
                  <button disabled={busy || !dirty} onClick={() => void save()}>
                    {busy ? "正在处理…" : "保存草稿"}
                  </button>
                  <button
                    className="ad-primary"
                    disabled={
                      busy ||
                      (!dirty &&
                        !["draft", "rejected"].includes(selected?.state ?? ""))
                    }
                    onClick={() => void save(true)}
                  >
                    保存并提交审核
                  </button>
                  <small>提交后由另一位成员审核，不会自动公开。</small>
                </div>
              )}
              {selected?.published_content && (
                <details className="ad-experience-published">
                  <summary>对照当前公开版本</summary>
                  <PublishedContent
                    content={selected.published_content}
                    pointName={pointName}
                    campusName={campusName}
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
  campusName,
  mediaTitle,
}: {
  content: ExperienceContent;
  pointName: (id: string) => string;
  campusName: (id: string) => string;
  mediaTitle: (id: string) => string;
}) {
  return (
    <div>
      <h3>{content.title}</h3>
      <p>
        {content.kind === "tour"
          ? `校区：${campusName(content.campus_id)} · ${content.stops.length} 站校园导览`
          : `地点：${pointName(content.point_id)}`}
      </p>
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
