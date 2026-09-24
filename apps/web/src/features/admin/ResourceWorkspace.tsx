import { useEffect, useState } from "react";
import type { components } from "../../shared/api/schema";
import { get, type FloorImage } from "../../shared/api/client";
import { FloorViewer } from "../floors/FloorViewer";
import {
  message,
  request,
  stateNames,
  type AdminPoint,
  type StaffSession,
} from "./api";
import { Empty, ErrorBox, Pager, useResource } from "./ui";
import "../floors/floors.css";

type Resource = components["schemas"]["AdminResource"];
type FloorContent = components["schemas"]["FloorContent"] & { kind: "floor" };
type PanoramaContent = components["schemas"]["PanoramaContent"] & {
  kind: "panorama";
};
type Content = FloorContent | PanoramaContent;
type Upload = components["schemas"]["FloorUpload"];
const active = (r: Resource) =>
  !!r.draft && ["draft", "rejected", "in_review"].includes(r.draft.state);
const title = (r: Resource) => {
  const c = active(r) ? (r.draft?.payload?.content ?? r.current) : r.current;
  return c && "label" in c ? c.label : c && "title" in c ? c.title : "资料草稿";
};

export function ResourceWorkspace({
  session,
  onDirty,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [pointId, setPointId] = useState("");
  const [pointName, setPointName] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [previews, setPreviews] = useState<Record<string, FloorImage>>({});
  const [previewSection, setPreviewSection] = useState("main");
  const [sourceNote, setSourceNote] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const points = useResource<AdminPoint[]>(
    `/points?${new URLSearchParams({ q: search, page_size: "50" })}`,
  );
  const resources = useResource<Resource[]>(
    reviewOnly || pointId
      ? `/resources?${new URLSearchParams({ ...(reviewOnly ? { state: "in_review" } : { point_id: pointId }), page: String(page), page_size: "50" })}`
      : null,
    revision,
  );
  const canEdit =
    session.permissions.includes("points.edit") &&
    selected?.draft?.state !== "in_review";
  const canReview = session.permissions.includes("points.review");
  const selfReview =
    !!selected?.draft &&
    (selected.draft.contributor_ids.includes(session.user.id) ||
      selected.draft.submitted_by === session.user.id);
  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || busy) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  function canLeave() {
    return (
      !busy && (!dirty || window.confirm("当前资料尚未保存，确定放弃修改吗？"))
    );
  }
  function clear() {
    setSelected(null);
    setContent(null);
    setPreviews({});
    setDirty(false);
    setError("");
    setNotice("");
    setReviewNote("");
  }
  function choosePoint(p: AdminPoint) {
    if (!canLeave()) return;
    clear();
    setPointId(p.point.id);
    setPointName(p.point.name);
    setReviewOnly(false);
    setPage(1);
  }
  function load(r: Resource) {
    setSelected(r);
    setContent(
      (active(r)
        ? (r.draft?.payload?.content ?? r.current)
        : r.current) as Content | null,
    );
    setPointId(r.point_id);
    setPointName(r.point_name);
    setSourceNote(active(r) ? (r.draft?.payload?.source_note ?? "") : "");
    setPreviews(
      Object.fromEntries((r.images ?? []).map((a) => [a.section ?? "main", a])),
    );
    setPreviewSection(r.images?.[0]?.section ?? "main");
    setDirty(false);
    setReviewNote("");
  }
  async function choose(r: Resource) {
    if (!canLeave()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      load((await request<Resource>(`/resources/${r.id}`)).data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function create(kind: "floor" | "panorama") {
    if (!canLeave() || !pointId) return;
    clear();
    setSourceNote("");
    setContent(
      kind === "floor"
        ? {
            kind,
            label: "1层",
            ordinal: 1,
            attribution: "",
            images: [{ section: "main", section_label: null, upload_id: null }],
          }
        : { kind, title: "", url: "", description: "" },
    );
    setDirty(true);
  }
  function edit(next: Content) {
    setContent(next);
    setDirty(true);
    setNotice("");
  }
  function removeSection(index: number) {
    if (!content || content.kind !== "floor") return;
    const removed = content.images[index].section ?? "main";
    const images = content.images.filter((_, i) => i !== index);
    edit({ ...content, images });
    setPreviews((previous) => {
      const next = { ...previous };
      delete next[removed];
      return next;
    });
    if (previewSection === removed)
      setPreviewSection(images[0]?.section ?? "main");
  }
  async function upload(file: File, index: number) {
    if (!content || content.kind !== "floor" || !canEdit) return;
    if (
      !["image/png", "image/jpeg"].includes(file.type) ||
      file.size > 32 * 1024 * 1024
    ) {
      setError("请选择不超过32 MiB的 PNG 或 JPEG 标注原图。");
      return;
    }
    const draft = content,
      section = draft.images[index].section ?? "main";
    setBusy(true);
    setError("");
    try {
      const r = await request<Upload>(
        `/points/${pointId}/floor-images`,
        "POST",
        file,
      );
      edit({
        ...draft,
        images: draft.images.map((a, i) =>
          i === index ? { ...a, upload_id: r.data.id } : a,
        ),
      });
      setPreviews((p) => ({ ...p, [section]: r.data.image }));
      setPreviewSection(section);
      setNotice("原图已上传。保存草稿并提交审核后才能公开展示。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!content) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<Resource>(
        selected ? `/resources/${selected.id}` : `/points/${pointId}/resources`,
        selected ? "PUT" : "POST",
        {
          content,
          source_note: sourceNote,
          expected_revision: selected?.draft?.revision ?? 0,
          expected_published_revision: selected?.published_revision ?? 0,
        },
      );
      load(result.data);
      setRevision((v) => v + 1);
      setNotice("草稿已保存，尚未公开。预览无误后提交审核。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function operate(
    action: "submit" | "publish" | "reject" | "discard" | "retire",
  ) {
    if (!selected || dirty) return;
    if (!reviewNote.trim()) {
      setError("请填写本次操作说明。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await request<Resource>(
        action === "retire"
          ? `/resources/${selected.id}/retire`
          : `/resources/${selected.id}/review/${action}`,
        "POST",
        {
          expected_revision: selected.draft?.revision ?? 0,
          note: reviewNote,
          ...(action === "retire"
            ? { expected_published_revision: selected.published_revision }
            : {}),
        },
      );
      load(r.data);
      setRevision((v) => v + 1);
      if (action === "publish") {
        const endpoint = `/points/${r.data.point_id}/${r.data.kind === "floor" ? "floors" : "panoramas"}`;
        try {
          const publicRows =
            await get<{ id: string; revision: number }[]>(endpoint);
          const found = publicRows.data.find((p) => p.id === r.data.id);
          if (
            r.data.status === "retired"
              ? !!found
              : found?.revision !== r.data.published_revision
          )
            throw new Error("公开端版本尚未匹配");
          setNotice(
            r.data.status === "retired"
              ? "已下架，公开端已确认隐藏。"
              : "已发布，公开端已确认显示新版本。",
          );
        } catch (e) {
          setNotice(
            "后台发布已完成。公开端核验未通过，请打开公开导览核对：" +
              message(e),
          );
        }
      } else
        setNotice(
          {
            submit: "已提交审核，请由另一名审核人员核对。",
            reject: "已退回，编辑人员可以继续修改。",
            discard: "草稿已撤回，公开版本保持原样。",
            retire: "已提交下架申请，审核通过后隐藏。",
          }[action],
        );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const shown = previews[previewSection];
  return (
    <section>
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">BUILDING CONTENT</div>
          <h1>楼层与 VR</h1>
          <p>管理标注原图与全景入口，让资料更新有据可查。</p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            if (canLeave()) {
              clear();
              setReviewOnly(true);
              setPage(1);
            }
          }}
        >
          查看待审核资料
        </button>
      </div>
      <div className="ad-resource-layout">
        <aside className="ad-card ad-resource-buildings">
          <h2>选择建筑</h2>
          <label>
            搜索建筑
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="输入名称或别名"
            />
          </label>
          <ErrorBox text={points.error} />
          {points.loading && <p role="status">正在查找建筑…</p>}
          {points.data?.data.map((p) => (
            <button
              key={p.point.id}
              className={pointId === p.point.id && !reviewOnly ? "active" : ""}
              disabled={busy}
              onClick={() => choosePoint(p)}
            >
              <strong>{p.point.name}</strong>
              <small>{stateNames[p.status] ?? p.status}</small>
            </button>
          ))}
          {points.data && points.data.data.length === 0 && (
            <Empty
              title="没有匹配建筑"
              detail="请换一个名称；这里只显示你获授权的点位。"
            />
          )}
          {(points.data?.meta.pagination?.total ?? 0) > 50 && (
            <p>请输入更完整的建筑名称缩小范围。</p>
          )}
        </aside>
        <div className="ad-resource-main">
          <div className="ad-card">
            <div className="ad-card-heading">
              <h2>
                {reviewOnly ? "待审核楼层与 VR" : pointName || "请选择建筑"}
              </h2>
              {pointId &&
                !reviewOnly &&
                session.permissions.includes("points.edit") && (
                  <div className="ad-action-wrap">
                    <button disabled={busy} onClick={() => create("floor")}>
                      ＋ 新增楼层
                    </button>
                    <button disabled={busy} onClick={() => create("panorama")}>
                      ＋ 添加 VR 链接
                    </button>
                  </div>
                )}
            </div>
            <ErrorBox
              text={resources.error}
              onRetry={() => setRevision((v) => v + 1)}
            />
            {resources.loading && <p role="status">正在读取资料…</p>}
            <div className="ad-resource-list">
              {resources.data?.data.map((r) => (
                <button
                  disabled={busy}
                  key={r.id}
                  onClick={() => choose(r)}
                  className={selected?.id === r.id ? "active" : ""}
                >
                  <span>
                    <strong>{title(r)}</strong>
                    <small>
                      {reviewOnly ? r.point_name + " · " : ""}
                      {r.kind === "floor" ? "楼层标注图" : "VR 全景链接"}
                    </small>
                  </span>
                  <span
                    className={`ad-badge ${active(r) ? r.draft!.state : r.status}`}
                  >
                    {active(r)
                      ? r.draft!.operation === "retire"
                        ? "待审下架"
                        : stateNames[r.draft!.state]
                      : stateNames[r.status]}
                  </span>
                </button>
              ))}
            </div>
            {resources.data?.data.length === 0 && (
              <Empty
                title={
                  reviewOnly ? "当前没有待审核资料" : "还没有楼层或 VR 资料"
                }
                detail={
                  reviewOnly
                    ? "编辑人员提交后会出现在这里。"
                    : "可添加楼层标注图或已有全景链接。"
                }
              />
            )}
            <Pager
              page={resources.data?.meta.pagination}
              onChange={(p) => {
                if (canLeave()) {
                  clear();
                  setPage(p);
                }
              }}
            />
          </div>
          {content && (
            <div className="ad-card ad-resource-editor" aria-busy={busy}>
              <div className="ad-card-heading">
                <div>
                  <h2>
                    {content.kind === "floor" ? "楼层资料" : "VR 全景资料"}
                  </h2>
                  <p>
                    {pointName}
                    {selected
                      ? ` · 正式版本 ${selected.published_revision}`
                      : " · 新资料"}
                  </p>
                </div>
                {dirty && <span className="ad-badge draft">未保存</span>}
              </div>
              <ErrorBox text={error} />
              {notice && (
                <p className="ad-resource-notice" role="status">
                  {notice}
                </p>
              )}
              {selected?.draft?.review_note && (
                <p className="ad-resource-review-note">
                  最近审核说明：{selected.draft.review_note}
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <fieldset disabled={busy || !canEdit}>
                  {content.kind === "floor" ? (
                    <>
                      <div className="ad-resource-fields">
                        <label>
                          楼层名称
                          <input
                            required
                            maxLength={64}
                            value={content.label}
                            onChange={(e) =>
                              edit({ ...content, label: e.target.value })
                            }
                            placeholder="例如：一层"
                          />
                        </label>
                        <label>
                          楼层序号
                          <input
                            type="number"
                            required
                            min={-20}
                            max={200}
                            disabled={!!selected?.published_revision}
                            value={content.ordinal}
                            onChange={(e) =>
                              edit({
                                ...content,
                                ordinal: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                      <label>
                        图片来源与说明
                        <textarea
                          required
                          maxLength={2000}
                          value={content.attribution}
                          onChange={(e) =>
                            edit({ ...content, attribution: e.target.value })
                          }
                          placeholder="说明这批图由谁整理、适用哪个建筑或区域"
                        />
                      </label>
                      <p>
                        只上传整理后的标注图。PNG / JPEG，每张不超过32
                        MiB；原文件不会缩放或重新压缩。
                      </p>
                      <div className="ad-resource-images">
                        {content.images.map((section, i) => (
                          <div
                            key={section.section ?? "main"}
                            className="ad-resource-image-row"
                          >
                            <label>
                              分区名称
                              <input
                                maxLength={64}
                                required={
                                  (section.section ?? "main") !== "main"
                                }
                                value={section.section_label ?? ""}
                                onChange={(e) =>
                                  edit({
                                    ...content,
                                    images: content.images.map((a, j) =>
                                      j === i
                                        ? {
                                            ...a,
                                            section_label:
                                              e.target.value || null,
                                          }
                                        : a,
                                    ),
                                  })
                                }
                                placeholder={
                                  i === 0 ? "整层 / A区" : "例如：B区"
                                }
                              />
                            </label>
                            <label className="ad-upload-control">
                              {previews[section.section ?? "main"]
                                ? "替换标注原图"
                                : "选择标注原图"}
                              <input
                                type="file"
                                accept="image/png,image/jpeg"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  e.target.value = "";
                                  if (file) upload(file, i);
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              disabled={!previews[section.section ?? "main"]}
                              onClick={() =>
                                setPreviewSection(section.section ?? "main")
                              }
                            >
                              预览
                            </button>
                            {content.images.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeSection(i)}
                              >
                                移除此分区
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        disabled={content.images.length >= 32}
                        onClick={() =>
                          edit({
                            ...content,
                            images: [
                              ...content.images,
                              {
                                section:
                                  "part-" + crypto.randomUUID().slice(0, 8),
                                section_label: "新分区",
                                upload_id: null,
                              },
                            ],
                          })
                        }
                      >
                        ＋ 同一楼层增加分区图
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        全景名称
                        <input
                          required
                          maxLength={120}
                          value={content.title}
                          onChange={(e) =>
                            edit({ ...content, title: e.target.value })
                          }
                          placeholder="例如：图书馆入口全景"
                        />
                      </label>
                      <label>
                        VR 链接
                        <input
                          type="url"
                          required
                          maxLength={2048}
                          value={content.url}
                          onChange={(e) =>
                            edit({ ...content, url: e.target.value })
                          }
                          placeholder="https://…"
                        />
                      </label>
                      <label>
                        介绍
                        <textarea
                          maxLength={2000}
                          value={content.description ?? ""}
                          onChange={(e) =>
                            edit({ ...content, description: e.target.value })
                          }
                        />
                      </label>
                      <p>
                        填写已有全景的 HTTPS
                        分享链接。发布后访客可从地点详情打开。
                      </p>
                    </>
                  )}
                  <label>
                    本次资料依据
                    <textarea
                      required
                      maxLength={2000}
                      value={sourceNote}
                      onChange={(e) => {
                        setSourceNote(e.target.value);
                        setDirty(true);
                      }}
                      placeholder="说明资料来源、本次改动与允许展示的范围"
                    />
                  </label>
                  {canEdit && (
                    <button
                      className="ad-primary"
                      type="submit"
                      disabled={!dirty}
                    >
                      {busy ? "正在保存…" : "保存草稿"}
                    </button>
                  )}
                </fieldset>
              </form>
              {content.kind === "floor" && (
                <section className="ad-resource-preview">
                  <div className="ad-card-heading">
                    <h3>原图预览</h3>
                    <select
                      aria-label="预览楼层分区"
                      value={previewSection}
                      onChange={(e) => setPreviewSection(e.target.value)}
                    >
                      {content.images
                        .filter((s) => previews[s.section ?? "main"])
                        .map((s) => (
                          <option
                            key={s.section ?? "main"}
                            value={s.section ?? "main"}
                          >
                            {s.section_label || "整层"}
                          </option>
                        ))}
                    </select>
                  </div>
                  {shown ? (
                    <>
                      <FloorViewer
                        key={shown.url}
                        asset={shown}
                        title={`${pointName} · ${content.label}`}
                      />
                      <p>
                        {shown.width_px} × {shown.height_px} px ·{" "}
                        {(shown.size_bytes / 1024 / 1024).toFixed(2)} MiB ·{" "}
                        <a href={shown.url} target="_blank" rel="noreferrer">
                          在新窗口查看原图 ↗
                        </a>
                      </p>
                    </>
                  ) : (
                    <Empty
                      title="上传标注图后可预览"
                      detail="可拖动、缩放和按原尺寸查看。"
                    />
                  )}
                </section>
              )}
              {content.kind === "panorama" &&
                !dirty &&
                /^https:\/\//.test(content.url) && (
                  <a
                    className="ad-resource-vr"
                    href={content.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    预览 VR 链接 ↗
                  </a>
                )}
              {selected && (
                <div className="ad-resource-review">
                  <h3>审核与发布</h3>
                  {dirty ? (
                    <p>请先保存当前修改，再提交或审核。</p>
                  ) : (
                    <>
                      <label>
                        操作说明
                        <textarea
                          disabled={busy}
                          value={reviewNote}
                          maxLength={1000}
                          onChange={(e) => setReviewNote(e.target.value)}
                          placeholder="填写核对结果、退回意见或下架原因"
                        />
                      </label>
                      <div className="ad-action-wrap">
                        {session.permissions.includes("points.edit") &&
                          selected.draft &&
                          ["draft", "rejected"].includes(
                            selected.draft.state,
                          ) && (
                            <button
                              className="ad-primary"
                              disabled={busy}
                              onClick={() => operate("submit")}
                            >
                              提交审核
                            </button>
                          )}
                        {session.permissions.includes("points.edit") &&
                          active(selected) &&
                          (session.user.role === "admin" ||
                            selected.draft!.contributor_ids.includes(
                              session.user.id,
                            )) && (
                            <button
                              disabled={busy}
                              onClick={() => operate("discard")}
                            >
                              撤回草稿
                            </button>
                          )}
                        {canReview && selected.draft?.state === "in_review" && (
                          <>
                            <button
                              className="ad-primary"
                              disabled={busy || selfReview}
                              onClick={() => operate("publish")}
                            >
                              {selected.draft.operation === "retire"
                                ? "通过并下架"
                                : "通过并发布"}
                            </button>
                            <button
                              disabled={busy || selfReview}
                              onClick={() => operate("reject")}
                            >
                              退回修改
                            </button>
                          </>
                        )}
                        {session.permissions.includes("points.edit") &&
                          selected.status === "published" &&
                          !active(selected) && (
                            <button
                              disabled={busy}
                              onClick={() => operate("retire")}
                            >
                              申请下架
                            </button>
                          )}
                        {selected.status === "published" && (
                          <a
                            href={`/?point=${selected.point_id}${selected.kind === "floor" ? `&floor=${selected.id}` : ""}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开公开导览 ↗
                          </a>
                        )}
                      </div>
                      {selfReview && selected.draft?.state === "in_review" && (
                        <p>
                          你参与了本次资料上传、编辑或提交，请由另一名审核人员审核。
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {!content && <ErrorBox text={error} />}
        </div>
      </div>
    </section>
  );
}
