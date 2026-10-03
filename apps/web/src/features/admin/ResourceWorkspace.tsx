import { useEffect, useRef, useState } from "react";
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
import { ChangeDiff } from "./ChangeDiff";
import { Icon } from "../../shared/ui/Icon";
import { notifyCatalogPublished } from "../../shared/catalogSync";
import { useManagedDraft } from "./useManagedDraft";
import { DraftStatusBar } from "./DraftStatus";
import { ContentHistory } from "./ContentHistory";
import { VRCoverPicker } from "./VRCoverPicker";
import { VRLocationSource } from "./VRLocationSource";
import { VRChecks } from "./VRChecks";
import "../floors/floors.css";
import "../points/vr-presentation.css";

type Resource = components["schemas"]["AdminResource"];
type FloorContent = components["schemas"]["FloorContent"] & { kind: "floor" };
type PanoramaContent = components["schemas"]["PanoramaContent"] & {
  kind: "panorama";
};
type Content = FloorContent | PanoramaContent;
type Draft = { content: Content; source_note: string };
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
  onUpdate,
  initialId,
  focused = false,
  review = false,
  onReview,
  onPoint,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  initialId?: string;
  focused?: boolean;
  review?: boolean;
  onReview?: (id: string) => void;
  onPoint?: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [pointPage, setPointPage] = useState(1);
  const [pointRevision, setPointRevision] = useState(0);
  const [pointId, setPointId] = useState("");
  const [pointName, setPointName] = useState("");
  const [globalView, setGlobalView] = useState(true);
  const [resourceState, setResourceState] = useState("");
  const [resourceSearch, setResourceSearch] = useState("");
  const [resourceKind, setResourceKind] = useState("");
  const reviewOnly = resourceState === "in_review";
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
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
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkPending, setCheckPending] = useState(false);
  const writing = useRef(false);
  const [historyPending, setHistoryPending] = useState(false);
  const managed = useManagedDraft<Draft, Resource>({
    snapshot: (row, value) => ({
      id: row.id,
      revision: row.draft?.revision ?? 0,
      published_revision: row.published_revision,
      content: value ?? {
        content: ((active(row) ? row.draft?.payload?.content : row.current) ??
          row.current ??
          row.draft?.payload?.content) as Content,
        source_note:
          active(row) || !row.current
            ? (row.draft?.payload?.source_note ?? "")
            : "",
      },
    }),
    save: async (row, value, version) =>
      (
        await request<Resource>(
          row ? `/resources/${row.id}` : `/points/${pointId}/resources`,
          row ? "PUT" : "POST",
          { ...value, ...version },
        )
      ).data,
    latest: async (row) =>
      (await request<Resource>(`/resources/${row.id}`)).data,
    onRecord: (row) => {
      setSelected(row);
      setRevision((v) => v + 1);
      onUpdate?.();
    },
    onValue: (value, changed) => {
      setContent(value.content);
      setSourceNote(value.source_note);
      setDirty(changed);
    },
    onAction: load,
  });
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState<{
    target: "editor" | "list";
    sequence: number;
  } | null>(null);
  function focusSection(target: "editor" | "list") {
    setFocusRequest((previous) => ({
      target,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
  }
  useEffect(() => {
    if (!focusRequest) return;
    const heading =
      focusRequest.target === "editor"
        ? editorHeading.current
        : listHeading.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusRequest]);
  const points = useResource<AdminPoint[]>(
    focused
      ? null
      : `/points?${new URLSearchParams({ q: search, page: String(pointPage), page_size: "20" })}`,
    pointRevision,
  );
  const resources = useResource<Resource[]>(
    !focused && (globalView || pointId)
      ? `/resources?${new URLSearchParams({ ...(!globalView && pointId ? { point_id: pointId } : {}), ...(resourceState ? { state: resourceState } : {}), ...(resourceSearch.trim() ? { q: resourceSearch.trim() } : {}), ...(resourceKind ? { kind: resourceKind } : {}), page: String(page), page_size: "20" })}`
      : null,
    revision,
  );
  useEffect(() => {
    const pagination = resources.data?.meta.pagination;
    if (!pagination) return;
    const lastPage = Math.max(
      1,
      Math.ceil(pagination.total / pagination.page_size),
    );
    if (page > lastPage) setPage(lastPage);
  }, [resources.data, page]);
  const canEdit =
    !review &&
    !checkBusy && !checkPending &&
    session.permissions.includes("points.edit") &&
    !managed.uncertain &&
    !historyPending &&
    selected?.draft?.state !== "in_review";
  const canReview = review && session.permissions.includes("points.review") && !checkBusy && !checkPending;
  const selfReview =
    !!selected?.draft &&
    (selected.draft.contributor_ids.includes(session.user.id) ||
      selected.draft.submitted_by === session.user.id);
  useEffect(() => {
    if (!initialId) return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    request<Resource>(`/resources/${initialId}`, "GET", undefined, abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) {
          load(r.data);
          focusSection("editor");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [initialId, detailRevision]);
  useEffect(() => {
    onDirty(
      dirty || busy || checkBusy || checkPending,
      busy || checkBusy || managed.saving || managed.uncertain || historyPending,
    );
    return () => onDirty(false);
  }, [dirty, busy, checkBusy, checkPending, managed.saving, managed.uncertain, historyPending, onDirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || busy || checkBusy || checkPending || managed.uncertain || historyPending) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, checkBusy, checkPending, managed.uncertain, historyPending]);
  function canLeave() {
    return (
      !busy &&
      !checkBusy &&
      !managed.saving &&
      !managed.uncertain &&
      !historyPending &&
      !writing.current &&
      ((!dirty && !checkPending) || window.confirm(checkPending ? "核查登记结果尚未确认，确定离开？原操作编号会保留，可回来查询；不要重复登记。" : "当前资料尚未保存，确定放弃修改吗？"))
    );
  }
  function clear() {
    managed.clear();
    setSelected(null);
    setContent(null);
    setPreviews({});
    setDirty(false);
    setError("");
    setNotice("");
    setReviewNote("");
  }
  function returnToList() {
    if (!canLeave()) return;
    clear();
    focusSection("list");
  }
  function choosePoint(p: AdminPoint) {
    if (!canLeave()) return;
    clear();
    setPointId(p.point.id);
    setPointName(p.point.name);
    setGlobalView(false);
    setResourceState("");
    setPage(1);
  }
  function load(r: Resource) {
    const initial: Draft = {
      content: ((active(r) ? r.draft?.payload?.content : r.current) ??
        r.current ??
        r.draft?.payload?.content) as Content,
      source_note:
        active(r) || !r.current ? (r.draft?.payload?.source_note ?? "") : "",
    };
    managed.install(r, initial);
    setSelected(r);
    setContent(
      (active(r)
        ? (r.draft?.payload?.content ?? r.current)
        : (r.current ?? r.draft?.payload?.content ?? null)) as Content | null,
    );
    setPointId(r.point_id);
    setPointName(r.point_name);
    setSourceNote(
      active(r) || !r.current ? (r.draft?.payload?.source_note ?? "") : "",
    );
    setPreviews(
      Object.fromEntries((r.images ?? []).map((a) => [a.section ?? "main", a])),
    );
    setPreviewSection(r.images?.[0]?.section ?? "main");
    setDirty(false);
    setReviewNote("");
  }
  async function choose(r: Resource) {
    if (!canLeave()) return;
    clear();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      load((await request<Resource>(`/resources/${r.id}`)).data);
      focusSection("editor");
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
    const initial: Content =
      kind === "floor"
        ? {
            kind,
            label: "1层",
            ordinal: 1,
            attribution: "",
            description: "",
            images: [
              {
                section: "main",
                section_label: null,
                upload_id: null,
                description: "",
              },
            ],
          }
        : { kind, title: "", url: "", description: "", observation_prompt: "", cover_image_id: null, cover_image_revision: null, sort_order: 0 };
    setContent(initial);
    managed.install(null, { content: initial, source_note: "" }, true);
    setDirty(true);
    focusSection("editor");
  }
  function edit(next: Content) {
    if (!canEdit) return;
    managed.edit({ content: next, source_note: sourceNote });
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
  const canSubmitSaved =
    !!selected?.draft &&
    selected.draft.operation !== "retire" &&
    ["draft", "rejected"].includes(selected.draft.state);
  async function save(submit = true): Promise<boolean> {
    if (
      !content ||
      !canEdit ||
      busy ||
      writing.current ||
      managed.uncertain ||
      historyPending
    )
      return false;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!(await managed.flush()))
        throw new Error("请先解决草稿保存状态，再提交或检查。");
      const current = managed.record.current;
      if (!current) throw new Error("请先保存草稿。");
      if (submit) {
        if (
          !current.draft ||
          !["draft", "rejected"].includes(current.draft.state)
        )
          throw new Error("草稿状态已经改变，请核对后再提交。");
        const note = sourceNote.trim().slice(0, 1000);
        if (!note) throw new Error("请填写来源或提交说明。");
        const result = await managed.action(
          `/resources/${current.id}/review/submit`,
          {
            expected_revision: current.draft.revision,
            expected_published_revision: current.published_revision,
            note,
          },
        );
        load(result);
        setRevision((v) => v + 1);
        onUpdate?.();
        setNotice("已提交审核，请另一位成员核对后发布。");
      } else setNotice("草稿已保存，尚未提交审核或公开。");
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function operate(
    action: "submit" | "publish" | "reject" | "discard" | "retire",
  ) {
    if (
      !selected ||
      dirty ||
      busy ||
      checkBusy ||
      checkPending ||
      writing.current ||
      managed.saving ||
      managed.uncertain ||
      historyPending
    )
      return;
    if (!reviewNote.trim()) {
      setError("请填写本次操作说明。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const row = await managed.action(
        action === "retire"
          ? `/resources/${selected.id}/retire`
          : `/resources/${selected.id}/review/${action}`,
        {
          expected_revision: selected.draft?.revision ?? 0,
          expected_published_revision: selected.published_revision,
          note: reviewNote,
          ...(action === "retire"
            ? { expected_published_revision: selected.published_revision }
            : {}),
        },
      );
      const r = { data: row };
      load(r.data);
      setRevision((v) => v + 1);
      onUpdate?.();
      if (action === "publish") {
        notifyCatalogPublished();
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
    <section className={focused ? "ad-focused-resource" : ""}>
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">RESOURCE LIBRARY</div>
          <h1>资料中心</h1>
          <p>跨地点查找楼层原图与全景，或选择地点添加资料。</p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            if (canLeave()) {
              clear();
              setGlobalView(true);
              setResourceState("in_review");
              setPage(1);
            }
          }}
        >
          查看待审核资料
        </button>
      </div>
      <div className="ad-resource-layout">
        {!focused && (
          <aside className="ad-card ad-resource-buildings">
            <button
              className={`ad-all-resources${globalView ? " active" : ""}`}
              disabled={busy}
              onClick={() => {
                if (canLeave()) {
                  clear();
                  setGlobalView(true);
                  setPointId("");
                  setPointName("");
                  setPage(1);
                }
              }}
            >
              <Icon name="layers" />
              <strong>全部地点资料</strong>
            </button>
            <h2>按地点管理</h2>
            <label>
              搜索地点
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPointPage(1);
                }}
                placeholder="输入地点名称"
              />
            </label>
            <ErrorBox
              text={points.error}
              onRetry={() => setPointRevision((v) => v + 1)}
            />
            {points.loading && <p role="status">正在查找地点…</p>}
            {points.data?.data.map((p) => (
              <button
                key={p.point.id}
                className={
                  pointId === p.point.id && !globalView ? "active" : ""
                }
                disabled={busy}
                onClick={() => choosePoint(p)}
              >
                <strong>{p.point.name}</strong>
                <small>{stateNames[p.status] ?? p.status}</small>
              </button>
            ))}
            {points.data && points.data.data.length === 0 && (
              <Empty
                title="没有匹配地点"
                detail="请换一个名称；这里只显示你获授权的点位。"
              />
            )}
            <nav aria-label="地点列表分页">
              <Pager
                page={points.data?.meta.pagination}
                onChange={setPointPage}
              />
            </nav>
          </aside>
        )}
        <div className="ad-resource-main">
          {!focused && (
            <div className="ad-card">
              <div className="ad-card-heading">
                <h2 ref={listHeading} tabIndex={-1}>
                  {globalView ? "全部地点资料" : pointName || "请选择地点"}
                </h2>
                {pointId &&
                  !globalView &&
                  session.permissions.includes("points.edit") && (
                    <div className="ad-action-wrap">
                      <button disabled={busy} onClick={() => create("floor")}>
                        ＋ 新增楼层
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => create("panorama")}
                      >
                        ＋ 添加 VR 链接
                      </button>
                    </div>
                  )}
              </div>
              <div className="ad-resource-filters">
                <input
                  aria-label="搜索资料名称或所属地点"
                  maxLength={120}
                  placeholder="搜索资料名称或所属地点"
                  value={resourceSearch}
                  onChange={(e) => {
                    setResourceSearch(e.target.value);
                    setPage(1);
                  }}
                />
                <select
                  aria-label="筛选资源类型"
                  value={resourceKind}
                  onChange={(e) => {
                    setResourceKind(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">全部类型</option>
                  <option value="floor">楼层原图</option>
                  <option value="panorama">VR 全景</option>
                </select>
                <select
                  aria-label="筛选资源草稿状态"
                  value={resourceState}
                  onChange={(e) => {
                    setResourceState(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">全部状态</option>
                  <option value="in_review">待审核</option>
                  <option value="draft">草稿</option>
                  <option value="rejected">已退回</option>
                </select>
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
                        {globalView ? r.point_name + " · " : ""}
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
          )}
          {!content && busy && <p role="status">正在读取资料详情…</p>}
          {!content && (
            <ErrorBox
              text={error}
              onRetry={
                initialId ? () => setDetailRevision((v) => v + 1) : undefined
              }
            />
          )}
          {content && (
            <div className="ad-card ad-resource-editor" aria-busy={busy}>
              <div className="ad-card-heading">
                <div>
                  <h2 ref={editorHeading} tabIndex={-1}>
                    {content.kind === "floor" ? "楼层资料" : "VR 全景资料"}
                  </h2>
                  <p>
                    {pointName}
                    {selected
                      ? ` · 正式版本 ${selected.published_revision}`
                      : " · 新资料"}
                  </p>
                </div>
                {!focused && (
                  <button
                    type="button"
                    className="ad-back-to-list"
                    disabled={busy}
                    onClick={returnToList}
                  >
                    返回资料列表
                  </button>
                )}
                {dirty && <span className="ad-badge draft">未保存</span>}
                {!dirty && selected && (
                  <span
                    className={`ad-badge ${active(selected) || !selected.current ? selected.draft?.state : selected.status}`}
                  >
                    {
                      stateNames[
                        active(selected) || !selected.current
                          ? (selected.draft?.state ?? selected.status)
                          : selected.status
                      ]
                    }
                  </span>
                )}
              </div>
              <ErrorBox text={error} />
              {managed.status && managed.coordinator.current && !review && (
                <DraftStatusBar
                  state={managed.status}
                  coordinator={managed.coordinator.current}
                />
              )}
              {managed.pendingAction && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void managed
                      .queryAction()
                      .catch((e) => setError(message(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  查询原资料操作结果
                </button>
              )}
              {selected && (
                <ContentHistory<Resource>
                  key={selected.id}
                  entity={selected.kind === "panorama" ? "vr" : "floor"}
                  id={selected.id}
                  revision={selected.draft?.revision ?? 0}
                  publishedRevision={selected.published_revision}
                  state={selected.draft?.state ?? "published"}
                  editable={
                    !review && session.permissions.includes("points.edit")
                  }
                  dirty={dirty}
                  onSave={() => save(false)}
                  onLoad={load}
                  onPendingChange={setHistoryPending}
                />
              )}
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
              {selected?.draft?.payload && active(selected) && (
                <ChangeDiff
                  rows={
                    content.kind === "panorama"
                      ? [
                          {
                            label: "全景名称",
                            before:
                              selected.current?.kind === "panorama"
                                ? selected.current.title
                                : "",
                            after: content.title,
                          },
                          {
                            label: "全景地址",
                            before:
                              selected.current?.kind === "panorama"
                                ? selected.current.url
                                : "",
                            after: content.url,
                          },
                          {
                            label: "场景说明",
                            before:
                              selected.current?.kind === "panorama"
                                ? (selected.current.description ?? "")
                                : "",
                            after: content.description ?? "",
                          },
                          {
                            label: "观察提示",
                            before: selected.current?.kind === "panorama" ? selected.current.observation_prompt ?? "" : "",
                            after: content.observation_prompt ?? "",
                          },
                          {
                            label: "目录顺序",
                            before: selected.current?.kind === "panorama" ? String(selected.current.sort_order ?? 0) : "",
                            after: String(content.sort_order ?? 0),
                          },
                          {
                            label: "封面引用（ID / 正式版本）",
                            before: selected.current?.kind === "panorama" && selected.current.cover_image_id ? `${selected.current.cover_image_id} / ${selected.current.cover_image_revision}` : "统一文字卡",
                            after: content.cover_image_id ? `${content.cover_image_id} / ${content.cover_image_revision}` : "统一文字卡",
                          },
                        ]
                      : [
                          {
                            label: "楼层名称",
                            before:
                              selected.current?.kind === "floor"
                                ? selected.current.label
                                : "",
                            after: content.label,
                          },
                          {
                            label: "资料来源",
                            before:
                              selected.current?.kind === "floor"
                                ? selected.current.attribution
                                : "",
                            after: content.attribution,
                          },
                          {
                            label: "楼层分区",
                            before:
                              selected.current?.kind === "floor"
                                ? selected.current.images
                                    .map(
                                      (i) =>
                                        i.section_label || i.section || "main",
                                    )
                                    .join("、")
                                : "",
                            after: content.images
                              .map(
                                (i) =>
                                  `${i.section_label || i.section || "main"}${i.upload_id ? "（新上传原图）" : ""}`,
                              )
                              .join("、"),
                          },
                        ]
                  }
                />
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(true);
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
                      <label>
                        楼层整体文字说明
                        <textarea
                          maxLength={4000}
                          rows={3}
                          value={content.description ?? ""}
                          onChange={(e) =>
                            edit({ ...content, description: e.target.value })
                          }
                        />
                        <small>
                          为不能查看图像或需要阅读的访客描述真实区域、标注和入口。不要把尚未实测的道路、台阶或电梯写成已确认无障碍通行。
                        </small>
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
                            <label>
                              本分区文字说明
                              <textarea
                                maxLength={4000}
                                rows={3}
                                value={section.description ?? ""}
                                onChange={(e) =>
                                  edit({
                                    ...content,
                                    images: content.images.map((image, j) =>
                                      i === j
                                        ? {
                                            ...image,
                                            description: e.target.value,
                                          }
                                        : image,
                                    ),
                                  })
                                }
                              />
                              <small>
                                对应这张真实分区图，描述重要标注；留空不会自动生成。
                              </small>
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
                                description: "",
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
                        介绍与文字替代
                        <textarea
                          maxLength={2000}
                          value={content.description ?? ""}
                          onChange={(e) =>
                            edit({ ...content, description: e.target.value })
                          }
                        />
                        <small>
                          描述真实视点和主要观察对象。无法访问 VR
                          或使用屏幕阅读器的访客仍能读到这些内容，不把入口加载当作场景已验证。
                        </small>
                      </label>
                      <label>观察提示（选填）
                        <textarea rows={3} maxLength={1000} value={content.observation_prompt ?? ""}
                          onChange={(event) => edit({ ...content, observation_prompt: event.target.value })} />
                        <small>告诉访客可留意的真实对象，随 VR 内容独立审核；不编造未核实的场景资料。</small>
                      </label>
                      <label>目录顺序
                        <input type="number" min={0} max={10000} required value={content.sort_order ?? 0}
                          onChange={(event) => edit({ ...content, sort_order: Number(event.target.value) })} />
                        <small>数字较小的先显示；同序号按正式标题排序，保留同名不同视点。</small>
                      </label>
                      <p>
                        填写已有全景的 HTTPS 分享链接。发布后进入地点详情和 VR
                        目录；室外独立景点无需虚构建筑。默认地图名称由所属点位的“常驻名称”开关决定。原站在新标签页打开，本站无法控制第三方画面。
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
                        if (content)
                          managed.edit({
                            content,
                            source_note: e.target.value,
                          });
                      }}
                      placeholder="说明资料来源、本次改动与允许展示的范围"
                    />
                  </label>
                  {canEdit && (
                    <div className="ad-action-wrap ad-editor-actions">
                      <button
                        className="ad-primary"
                        type="submit"
                        disabled={!dirty && !canSubmitSaved}
                      >
                        {busy
                          ? "正在处理…"
                          : dirty
                            ? "保存并提交审核"
                            : "提交审核"}
                      </button>
                      <button
                        type="button"
                        disabled={!dirty}
                        onClick={() => void save(false)}
                      >
                        仅保存草稿
                      </button>
                      <small>
                        沿用上方资料依据提交，由另一名审核人员确认后公开。
                      </small>
                    </div>
                  )}
                </fieldset>
              </form>
              {content.kind === "panorama" && <VRCoverPicker key={`${pointId}:${selected?.draft?.revision ?? 0}:${selected?.published_revision ?? 0}`}
                pointId={pointId} id={content.cover_image_id} revision={content.cover_image_revision} disabled={!canEdit || busy}
                onChange={(id, revision) => edit({ ...content, cover_image_id: id, cover_image_revision: revision })} />}
              {content.kind === "panorama" && <VRLocationSource pointId={pointId}
                onPoint={onPoint && session.permissions.includes("points.edit") && !busy && !checkBusy ? onPoint : undefined} />}
              {content.kind === "panorama" && selected && <VRChecks key={`${session.user.id}:${selected.id}`}
                id={selected.id} revision={selected.draft?.revision ?? 0} publishedRevision={selected.published_revision}
                url={content.url} session={session} blocked={dirty || busy || historyPending || managed.uncertain}
                onActivity={(busy, pending) => { setCheckBusy(busy); setCheckPending(pending); }}
                onRefreshResource={() => void choose(selected)} />}
              {content.kind === "panorama" && !selected && <p>先保存草稿，再针对该保存的链接登记人工核查。</p>}
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
                <details
                  className="ad-resource-review"
                  open={selected.draft?.state === "in_review"}
                >
                  <summary>
                    {selected.draft?.state === "in_review"
                      ? review
                        ? "审核与发布"
                        : "已提交，等待审核"
                      : "其他操作：撤回或申请下架"}
                  </summary>
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
                          selected.draft?.operation === "retire" &&
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
                        {!review &&
                          onReview &&
                          selected.draft?.state === "in_review" && (
                            <button
                              disabled={busy || dirty}
                              onClick={() => onReview(selected.id)}
                            >
                              去审核中心
                            </button>
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
                </details>
              )}
            </div>
          )}
          {!content && <ErrorBox text={error} />}
        </div>
      </div>
    </section>
  );
}
