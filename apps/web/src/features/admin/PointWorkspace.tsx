import { useEffect, useRef, useState } from "react";
import { api, type MapInfo } from "../../shared/api/client";
import {
  activeDraft,
  categories,
  message,
  request,
  stateNames,
  type AdminMapPoint,
  type AdminPoint,
  type GeometryInput,
  type PointInput,
  type StaffSession,
} from "./api";
import { ErrorBox, Empty, Pager, timestamp, useResource } from "./ui";
import { MapEditor } from "./MapEditor";
import { notifyCatalogPublished } from "../../shared/catalogSync";
import { verifyPublication, type PublicationCheck } from "./publication";
import { moveGeometry, rectangle, validPolygon } from "./geometry";
import { ChangeDiff } from "./ChangeDiff";
import { useManagedDraft } from "./useManagedDraft";
import { DraftStatusBar } from "./DraftStatus";
import { ContentHistory } from "./ContentHistory";
import "./point-workspace.css";
type Props = {
  session: StaffSession;
  maps: MapInfo[];
  review?: boolean;
  initialId?: string;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate: () => void;
  onReview?: (id: string) => void;
};
export function PointWorkspace({
  session,
  maps,
  review = false,
  initialId,
  onDirty,
  onUpdate,
  onReview,
}: Props) {
  const [mapId, setMapId] = useState(maps[0]?.id ?? ""),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<AdminPoint | null>(null),
    [input, setInput] = useState<PointInput | null>(null),
    [newPoint, setNewPoint] = useState(false),
    [dirty, setDirty] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [publicationCheck, setPublicationCheck] = useState<PublicationCheck | null>(
      null,
    ),
    [reason, setReason] = useState(""),
    [history, setHistory] = useState<GeometryInput[]>([]);
  const loadId = useRef(0);
  const operationLock = useRef(false);
  const [historyPending, setHistoryPending] = useState(false);
  function pointInput(point: AdminPoint): PointInput | null {
    const pending =
      activeDraft(point) || !point.geometries.length
        ? point.draft?.payload
        : null;
    if (pending) return pending;
    const g =
      point.geometries.find((g) => g.map_id === map?.id) ??
      point.geometries.find((g) => maps.some((m) => m.id === g.map_id));
    return g
      ? {
          campus_id: point.point.campus_id,
          name: point.point.name,
          aliases: point.point.aliases,
          category: point.point.category,
          summary: point.point.summary,
          visibility: point.visibility,
          source_note: point.draft?.payload?.source_note ?? "",
          geometry: {
            map_id: g.map_id,
            map_revision: g.map_revision,
            anchor: g.anchor,
            polygon: g.polygon,
            label_on_map: g.label_on_map ?? false,
          },
        }
      : null;
  }
  const managed = useManagedDraft<PointInput, AdminPoint>({
    snapshot: (row, value) => ({
      id: row.point.id,
      revision: row.draft?.revision ?? 0,
      published_revision: row.point.revision,
      content: value ?? pointInput(row)!,
    }),
    save: async (row, value, version) => {
      const baseMap = maps.find((m) => m.id === value.geometry.map_id);
      if (!baseMap)
        throw Object.assign(new Error("请核对当前底图。"), { status: 422 });
      const invalid = validPolygon(
        value.geometry.polygon,
        baseMap.width_px,
        baseMap.height_px,
      );
      if (invalid) throw Object.assign(new Error(invalid), { status: 422 });
      return (
        await request<AdminPoint>(
          row ? `/points/${row.point.id}` : "/points",
          row ? "PUT" : "POST",
          {
            ...value,
            aliases: (value.aliases ?? []).map((v) => v.trim()).filter(Boolean),
            operation_id: version.operation_id,
            ...(row
              ? {
                  expected_revision: version.expected_revision,
                  expected_point_revision: version.expected_published_revision,
                }
              : {}),
          },
        )
      ).data;
    },
    latest: async (row) =>
      (await request<AdminPoint>(`/points/${row.point.id}`)).data,
    onRecord: (row) => {
      setSelected(row);
      setNewPoint(false);
      refresh();
    },
    onValue: (value, changed) => {
      setInput(value);
      setDirty(changed);
    },
    onAction: accept,
  });
  const [showList, setShowList] = useState(review && !initialId);
  const map = maps.find((m) => m.id === mapId) ?? maps[0];
  const allowedEdit = session.permissions.includes("points.edit"),
    allowedReview = review && session.permissions.includes("points.review");
  const writable =
    allowedEdit &&
    !review &&
    !loading &&
    !busy &&
    !managed.uncertain &&
    !historyPending &&
    selected?.draft?.state !== "in_review";
  const canCreate =
    allowedEdit &&
    !review &&
    (session.user.role === "admin" || !session.user.point_ids.length);
  const params = new URLSearchParams({
    page: String(page),
    page_size: "20",
    ...(map ? { campus_id: map.campus_id } : {}),
    ...(search ? { q: search } : {}),
    ...(status ? { status } : {}),
    ...(review ? { draft_state: "in_review" } : {}),
  });
  const list = useResource<AdminPoint[]>(
    map ? `/points?${params}` : null,
    revision,
  );
  const geometries = useResource<AdminMapPoint[]>(
    map ? `/maps/${map.id}/points` : null,
    revision,
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    onDirty(
      dirty || busy,
      busy || managed.saving || managed.uncertain || historyPending,
    );
    const before = (event: BeforeUnloadEvent) => {
      if (dirty || busy || managed.uncertain || historyPending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      onDirty(false);
    };
  }, [dirty, busy, managed.saving, managed.uncertain, historyPending, onDirty]);
  useEffect(() => {
    if (initialId) void open(initialId, true);
  }, [initialId]);
  useEffect(
    () => () => {
      loadId.current++;
    },
    [],
  );
  const guard = () =>
    !managed.saving &&
    !managed.uncertain &&
    !historyPending &&
    (!dirty || window.confirm("当前修改尚未保存，确定放弃并离开吗？"));
  function accept(point: AdminPoint) {
    setPublicationCheck(null);
    setSelected(point);
    setNewPoint(false);
    setDirty(false);
    setHistory([]);
    setReason("");
    const value = pointInput(point);
    setInput(value);
    if (value) {
      setMapId(value.geometry.map_id);
      managed.install(point, value);
    } else managed.clear();
  }
  async function open(id: string, force = false) {
    if (busy || operationLock.current || (!force && !guard())) return;
    const seq = ++loadId.current;
    setLoading(true);
    setError("");
    setNotice("");
    setPublicationCheck(null);
    setDirty(false);
    setInput(null);
    managed.clear();
    setSelected(null);
    setNewPoint(false);
    try {
      const response = await request<AdminPoint>(`/points/${id}`);
      if (loadId.current === seq) accept(response.data);
    } catch (e) {
      if (loadId.current === seq) setError(message(e));
    } finally {
      if (loadId.current === seq) setLoading(false);
    }
  }
  function startNew() {
    if (!map || busy || operationLock.current || !guard()) return;
    loadId.current++;
    setLoading(false);
    setSelected(null);
    setNewPoint(true);
    setError("");
    setNotice("");
    setPublicationCheck(null);
    setHistory([]);
    setReason("");
    const anchor = { x: map.width_px / 2, y: map.height_px / 2 },
      radius = Math.min(map.width_px, map.height_px) * 0.01;
    const initial: PointInput = {
      campus_id: map.campus_id,
      name: "",
      aliases: [],
      category: "academic",
      summary: "",
      visibility: "public",
      source_note: "",
      geometry: {
        map_id: map.id,
        map_revision: map.revision,
        anchor,
        polygon: rectangle(
          { x: anchor.x - radius, y: anchor.y - radius },
          { x: anchor.x + radius, y: anchor.y + radius },
        ),
        label_on_map: true,
      },
    };
    setInput(initial);
    managed.install(null, initial, true);
    setDirty(true);
  }
  function edit(value: Partial<PointInput>) {
    if (!input || !writable) return;
    managed.edit({ ...input, ...value });
    setNotice("");
    setPublicationCheck(null);
  }
  function geometry(value: GeometryInput) {
    if (!input) return;
    setHistory((h) => [...h.slice(-39), input.geometry]);
    edit({
      geometry: { ...value, map_revision: map?.revision ?? value.map_revision },
    });
  }
  function moveAnchor(target: { x: number; y: number }) {
    if (!input || !map) return;
    try {
      geometry(
        moveGeometry(input.geometry, target, map.width_px, map.height_px),
      );
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }
  async function checkPublic(point: AdminPoint) {
    setPublicationCheck(null);
    const check = await verifyPublication(
      point,
      map.id,
      api,
      AbortSignal.timeout(12_000),
    );
    setPublicationCheck(check);
  }
  function refresh() {
    setRevision((v) => v + 1);
    onUpdate();
  }
  async function save(submitAfter = false): Promise<boolean> {
    if (
      !input ||
      !map ||
      !writable ||
      operationLock.current ||
      managed.uncertain ||
      historyPending
    )
      return false;
    operationLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPublicationCheck(null);
    try {
      if (!(await managed.flush()))
        throw new Error("草稿尚未确认保存，请处理保存状态后再继续。");
      const current = managed.record.current;
      if (!current) throw new Error("请先保存草稿。");
      if (submitAfter) {
        const submissionNote = (
          reason.trim() || input.source_note.trim()
        ).slice(0, 1000);
        if (!submissionNote) throw new Error("请填写提交说明或来源。");
        const result = await managed.action(
          `/points/${current.point.id}/submit`,
          {
            expected_revision: current.draft?.revision ?? 0,
            expected_published_revision: current.point.revision,
            note: submissionNote,
          },
        );
        accept(result);
        refresh();
        setNotice("已保存并提交审核。另一位审核人员通过后，公开地图才会更新。");
      } else setNotice("草稿已保存，尚未提交或公开。");
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }
  async function resumeEditing() {
    if (
      !selected ||
      busy ||
      operationLock.current ||
      !canWithdraw ||
      managed.uncertain
    )
      return;
    operationLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await managed.action(
        `/content/point/${selected.point.id}/withdraw`,
        {
          expected_revision: selected.draft?.revision ?? 0,
          expected_published_revision: selected.point.revision,
          note: "撤回待审版本，保留内容继续修改",
        },
      );
      accept(result);
      refresh();
      setNotice("已撤回，当前内容保留为私有草稿，可继续修改。");
    } catch (e) {
      setError(message(e));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }
  async function operate(action: string) {
    if (
      !selected ||
      busy ||
      operationLock.current ||
      managed.saving ||
      managed.uncertain ||
      historyPending
    )
      return;
    if (dirty) {
      setError("请先保存或放弃当前修改，再进行审核操作。");
      return;
    }
    if (!reason.trim()) {
      setError("请填写本次操作说明。");
      return;
    }
    if (
      action === "retire" &&
      !window.confirm(
        "申请下架此点位？审核通过后将关闭公开点击入口和所属楼层入口；底图内原有文字不会自动消除。",
      )
    )
      return;
    if (
      action === "discard" &&
      !window.confirm(
        "撤回此次修改？已发布内容不受影响，草稿会保留在操作记录中。",
      )
    )
      return;
    operationLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPublicationCheck(null);
    try {
      const row = await managed.action(
        `/points/${selected.point.id}/${action}`,
        {
          expected_revision: selected.draft?.revision ?? 0,
          expected_published_revision: selected.point.revision,
          note: reason,
          ...(action === "retire"
            ? { expected_point_revision: selected.point.revision }
            : {}),
        },
      );
      const result = { data: row };
      accept(result.data);
      refresh();
      if (action === "publish") {
        notifyCatalogPublished();
        setNotice(
          `审核已通过，正式 v${result.data.point.revision} 已保存。正在核对公开接口…`,
        );
        await checkPublic(result.data);
      }
      setNotice(
        action === "publish"
          ? `审核已通过，正式 v${result.data.point.revision} 已保存。`
          : action === "submit"
            ? "已提交，等待另一位审核人员处理。"
            : action === "retire"
              ? "下架申请已提交，审核通过后生效。"
              : action === "reject"
                ? "已退回，并记录修改意见。"
                : "已撤回此次修改。",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }
  const selfReview =
    !!selected?.draft &&
    (selected.draft.contributor_ids.includes(session.user.id) ||
      selected.draft.submitted_by === session.user.id);
  const pending = !!selected && activeDraft(selected);
  const canWithdraw =
    allowedEdit &&
    !!selected?.draft &&
    (session.user.role === "admin" ||
      selected.draft.contributor_ids.includes(session.user.id));
  const publishedGeometry = selected?.geometries.find(
    (g) => g.map_id === input?.geometry.map_id,
  );
  if (!map)
    return (
      <Empty
        title="还没有可编辑的校园底图"
        detail="请先发布校园地图，并为当前账号分配相应校区。"
      />
    );
  return (
    <div
      className={`ad-workspace ad-point-studio${showList ? " is-list-open" : ""}${initialId ? " ad-focused-point" : ""}`}
    >
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">
            {review ? "REVIEW & PUBLISH" : "CAMPUS MAP STUDIO"}
          </div>
          <h1>{review ? "审核与发布" : "地图点位"}</h1>
          <p>
            {review
              ? "核对地点、位置和资料，再决定是否公开。"
              : "点选地图上的地点 → 修改资料或位置 → 保存并提交审核。"}
          </p>
        </div>
        <div className="ad-heading-actions">
          {!initialId && (
            <button
              type="button"
              aria-expanded={showList}
              onClick={() => setShowList((value) => !value)}
            >
              {showList ? "收起地点列表" : "搜索 / 地点列表"}
            </button>
          )}
          <select
            aria-label="校园底图"
            value={map.id}
            disabled={busy}
            onChange={(e) => {
              if (guard()) {
                loadId.current++;
                setLoading(false);
                setMapId(e.target.value);
                setSelected(null);
                setNotice("");
                setPublicationCheck(null);
                setInput(null);
                setNewPoint(false);
                setDirty(false);
                setPage(1);
              }
            }}
          >
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          {canCreate && (
            <button className="ad-primary" disabled={busy} onClick={startNew}>
              ＋ 新增点位
            </button>
          )}
        </div>
      </div>
      <div className="ad-editor-layout">
        <aside className="ad-point-list">
          <div className="ad-list-filter">
            <label className="ad-search">
              <span>⌕</span>
              <input
                aria-label="搜索地点名称"
                placeholder="搜索地点名称"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {!review && (
              <select
                aria-label="筛选发布状态"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部发布状态</option>
                <option value="published">已发布</option>
                <option value="draft">未发布</option>
                <option value="retired">已下架 / 可恢复</option>
              </select>
            )}
          </div>
          <ErrorBox text={list.error} onRetry={refresh} />
          {list.loading && (
            <p className="ad-hint" role="status">
              正在加载点位…
            </p>
          )}
          <div className="ad-point-scroll">
            {list.data?.data.map((p) => (
              <button
                className={`ad-point-row${selected?.point.id === p.point.id ? " selected" : ""}`}
                key={p.point.id}
                onClick={() => open(p.point.id)}
                disabled={busy}
              >
                <span className="ad-point-symbol">
                  {p.point.category === "patriotic" ? "◇" : "▤"}
                </span>
                <span>
                  <strong>
                    {activeDraft(p)
                      ? (p.draft?.payload?.name ?? p.point.name)
                      : p.point.name}
                  </strong>
                  <small>
                    {categories[p.point.category]} · {stateNames[p.status]}
                  </small>
                </span>
                {activeDraft(p) && (
                  <span className={`ad-badge ${p.draft!.state}`}>
                    {p.draft!.operation === "retire"
                      ? "下架申请"
                      : stateNames[p.draft!.state]}
                  </span>
                )}
              </button>
            ))}
            {list.data && !list.data.data.length && (
              <Empty
                title={review ? "暂时没有待审内容" : "没有找到点位"}
                detail="可调整筛选条件后重试。"
              />
            )}
          </div>
          <Pager page={list.data?.meta.pagination} onChange={setPage} />
        </aside>
        <div className="ad-map-column">
          <MapEditor
            info={map}
            points={geometries.data?.data ?? []}
            selectedId={selected?.point.id ?? (newPoint ? "new" : null)}
            value={input?.geometry ?? null}
            name={input?.name ?? ""}
            editable={writable}
            onSelect={initialId ? () => {} : open}
            onChange={geometry}
            canUndo={!!history.length}
            onUndo={() => {
              if (!history.length) return;
              edit({ geometry: history[history.length - 1] });
              setHistory((h) => h.slice(0, -1));
            }}
          />
          <ErrorBox text={geometries.error} onRetry={refresh} />
          <div className="ad-map-footer">
            <span>
              原图 {map.width_px} × {map.height_px} px
            </span>
            <span>
              <i /> 正式范围 <i className="draft" /> 草稿范围{" "}
              <i className="selected" /> 当前选中
            </span>
            <span>底图 v{map.revision}</span>
          </div>
        </div>
        <aside className="ad-detail-panel" aria-label="点位资料">
          <div className="ad-detail-head">
            <h2>
              {newPoint ? "新增点位" : (selected?.point.name ?? "点位详情")}
            </h2>
            {dirty && <span className="ad-badge draft">未保存</span>}
          </div>
          <ErrorBox
            text={error}
            onRetry={
              selected || initialId
                ? () => {
                    if (guard()) open(selected?.point.id ?? initialId!, true);
                  }
                : undefined
            }
          />
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
              查询原点位操作结果
            </button>
          )}
          {selected && (
            <ContentHistory<AdminPoint>
              key={selected.point.id}
              entity="point"
              id={selected.point.id}
              revision={selected.draft?.revision ?? 0}
              publishedRevision={selected.point.revision}
              state={selected.draft?.state ?? "published"}
              editable={allowedEdit && !review}
              dirty={dirty}
              onSave={() => save(false)}
              onLoad={accept}
              onPendingChange={setHistoryPending}
            />
          )}
          {notice && (
            <div className="ad-success" role="status">
              {notice}
            </div>
          )}
          {publicationCheck && (
            <div
              className={publicationCheck.ok ? "ad-success" : "ad-callout"}
              role="status"
            >
              {publicationCheck.message}
              {publicationCheck.ok &&
                selected?.status === "published" &&
                selected.visibility === "public" && (
                  <p>
                    <a
                      href={`/?point=${encodeURIComponent(selected.point.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开公开地图核对 ↗
                    </a>
                  </p>
                )}
            </div>
          )}
          {loading ? (
            <p className="ad-hint" role="status">
              正在读取资料…
            </p>
          ) : !input ? (
            <Empty
              title="从地图或列表中选择地点"
              detail="选中后可查看资料、定位及点击范围。"
            />
          ) : (
            <>
              {selected && (
                <div className="ad-detail-meta">
                  <span className={`ad-badge ${selected.status}`}>
                    {stateNames[selected.status]}
                  </span>
                  <span>
                    正式 v{selected.point.revision}
                    {selected.draft
                      ? ` / 草稿 v${selected.draft.revision}`
                      : ""}
                  </span>
                  <small>
                    更新于{" "}
                    {timestamp(
                      selected.draft?.updated_at ?? selected.point.updated_at,
                    )}
                  </small>
                </div>
              )}
              {selected && !dirty && selected.status !== "draft" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await checkPublic(selected);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "正在处理…" : "核对公开端"}
                </button>
              )}
              {selected?.draft?.state === "in_review" && !review && (
                <div className="ad-point-review-status" role="status">
                  {onReview && (
                    <button
                      disabled={busy || dirty}
                      onClick={() => onReview(selected.point.id)}
                    >
                      去审核中心
                    </button>
                  )}
                  <strong>已提交，等待审核</strong>
                  <p>
                    {canWithdraw
                      ? "还要修改？撤回后会保留当前内容，修改完成再提交。"
                      : "当前版本正在审核，由原编辑人员或管理员撤回后可继续修改。"}
                  </p>
                  {canWithdraw && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={resumeEditing}
                    >
                      撤回并继续修改
                    </button>
                  )}
                </div>
              )}
              {selected?.status === "retired" && (
                <p className="ad-callout">
                  此点位已下架。保存新草稿并通过审核后，可恢复公开展示。
                </p>
              )}
              {selected?.draft?.operation === "retire" &&
                selected.draft.state === "in_review" && (
                  <p className="ad-callout">
                    正在申请下架：{selected.draft.review_note}
                  </p>
                )}
              {selected?.draft?.state === "rejected" && (
                <p className="ad-callout">
                  退回意见：{selected.draft.review_note}
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(true);
                }}
              >
                <fieldset disabled={!writable}>
                  <label>
                    地点名称 <em>*</em>
                    <input
                      required
                      maxLength={120}
                      value={input.name}
                      onChange={(e) => edit({ name: e.target.value })}
                      placeholder="填写已确认的名称"
                    />
                  </label>
                  <details className="ad-point-extra">
                    <summary>类别、别名与可见范围</summary>
                    <div className="ad-form-pair">
                      <label>
                        地点类别
                        <select
                          value={input.category}
                          onChange={(e) =>
                            edit({
                              category: e.target
                                .value as PointInput["category"],
                            })
                          }
                        >
                          {Object.entries(categories).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        可见范围
                        <select
                          value={input.visibility}
                          onChange={(e) =>
                            edit({
                              visibility: e.target
                                .value as PointInput["visibility"],
                            })
                          }
                        >
                          <option value="public">公开</option>
                          <option value="internal">内部</option>
                          <option value="restricted">受限</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      别名
                      <input
                        value={(input.aliases ?? []).join("，")}
                        onChange={(e) =>
                          edit({
                            aliases: e.target.value.split(/[，,]/).slice(0, 20),
                          })
                        }
                        onBlur={() =>
                          edit({
                            aliases: (input.aliases ?? [])
                              .map((v) => v.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="多个别名用逗号分隔"
                      />
                    </label>
                  </details>
                  <label>
                    地点介绍
                    <textarea
                      rows={4}
                      maxLength={2000}
                      value={input.summary}
                      onChange={(e) => edit({ summary: e.target.value })}
                      placeholder="填写经确认的导览说明"
                    />
                  </label>
                  <label>
                    资料依据 / 修改说明 <em>*</em>
                    <textarea
                      required
                      rows={3}
                      maxLength={2000}
                      value={input.source_note}
                      onChange={(e) => edit({ source_note: e.target.value })}
                      placeholder="例如：依据某版校区地图校准入口位置"
                    />
                  </label>
                  <p className="ad-hint">
                    位置和点击范围可直接在左侧地图调整。地图中已经印上的文字不随定位点移动。
                  </p>
                  <details className="ad-point-extra">
                    <summary>精确坐标（高级调整）</summary>
                    <div className="ad-form-pair">
                      <label>
                        定位坐标 X
                        <input
                          type="number"
                          required
                          step=".001"
                          min={0}
                          max={map.width_px}
                          value={input.geometry.anchor.x}
                          onChange={(e) => {
                            if (e.target.value)
                              moveAnchor({
                                ...input.geometry.anchor,
                                x: Number(e.target.value),
                              });
                          }}
                        />
                      </label>
                      <label>
                        定位坐标 Y
                        <input
                          type="number"
                          required
                          step=".001"
                          min={0}
                          max={map.height_px}
                          value={input.geometry.anchor.y}
                          onChange={(e) => {
                            if (e.target.value)
                              moveAnchor({
                                ...input.geometry.anchor,
                                y: Number(e.target.value),
                              });
                          }}
                        />
                      </label>
                    </div>
                  </details>
                  <label className="ad-check">
                    <input
                      type="checkbox"
                      checked={input.geometry.label_on_map ?? true}
                      onChange={(e) =>
                        edit({
                          geometry: {
                            ...input.geometry,
                            label_on_map: e.target.checked,
                          },
                        })
                      }
                    />
                    在地图上显示名称
                  </label>
                  <p className="ad-hint">
                    底图已经印有的名称无需重复显示。关闭此项只影响新增文字，不能擦除底图原有文字。
                  </p>
                </fieldset>
                {allowedEdit &&
                  !review &&
                  selected?.draft?.state !== "in_review" && (
                    <div className="ad-sticky-actions ad-point-savebar">
                      <p className="ad-point-save-state" role="status">
                        {busy
                          ? "正在处理，请稍候…"
                          : dirty
                            ? "有未保存修改"
                            : pending
                              ? "草稿已保存，可直接提交"
                              : "修改后保存或提交审核"}
                      </p>
                      <button
                        type="button"
                        disabled={!dirty || busy}
                        onClick={() => void save(false)}
                      >
                        保存草稿
                      </button>
                      <button
                        type="submit"
                        className="ad-primary"
                        disabled={busy || (!dirty && !pending)}
                      >
                        保存并提交审核
                      </button>
                      {selected && dirty && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (guard()) accept(selected);
                          }}
                        >
                          放弃修改
                        </button>
                      )}
                    </div>
                  )}
              </form>
              {selected && (
                <details
                  className="ad-review-box ad-point-extra"
                  open={review || selected.draft?.state === "in_review"}
                >
                  <summary>
                    {review ? "审核与发布" : "变更对比与其他操作"}
                  </summary>
                  {pending && selected.draft?.payload && (
                    <ChangeDiff
                      rows={[
                        {
                          label: "地点名称",
                          before: selected.point.name,
                          after: input.name,
                        },
                        {
                          label: "地点介绍",
                          before: selected.point.summary,
                          after: input.summary,
                        },
                        {
                          label: "别名",
                          before: selected.point.aliases.join("、"),
                          after: (input.aliases ?? []).join("、"),
                        },
                        {
                          label: "类别",
                          before: categories[selected.point.category],
                          after: categories[input.category],
                        },
                        {
                          label: "可见范围",
                          before: selected.visibility,
                          after: input.visibility,
                        },
                        {
                          label: "定位坐标",
                          before: publishedGeometry
                            ? `${publishedGeometry.anchor.x}, ${publishedGeometry.anchor.y}`
                            : "",
                          after: `${input.geometry.anchor.x}, ${input.geometry.anchor.y}`,
                        },
                        {
                          label: "点击边界",
                          before: JSON.stringify(
                            publishedGeometry?.polygon ?? [],
                          ),
                          after: JSON.stringify(input.geometry.polygon),
                        },
                      ]}
                    />
                  )}
                  {(allowedEdit || allowedReview) && (
                    <>
                      <label>
                        操作说明
                        <textarea
                          rows={2}
                          maxLength={1000}
                          value={reason}
                          disabled={busy}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="填写提交、审核或下架的理由"
                        />
                      </label>
                      <div className="ad-action-wrap">
                        {review &&
                          allowedEdit &&
                          pending &&
                          selected.draft?.state !== "in_review" && (
                            <button
                              disabled={busy || dirty}
                              onClick={() => operate("submit")}
                            >
                              提交审核
                            </button>
                          )}
                        {allowedEdit &&
                          pending &&
                          (session.user.role === "admin" ||
                            selected.draft?.contributor_ids.includes(
                              session.user.id,
                            )) && (
                            <button
                              disabled={busy || dirty}
                              onClick={() => operate("discard")}
                            >
                              撤回修改
                            </button>
                          )}
                        {allowedReview &&
                          selected.draft?.state === "in_review" && (
                            <>
                              <button
                                className="ad-primary"
                                disabled={busy || dirty || selfReview}
                                onClick={() => operate("publish")}
                              >
                                {selected.draft.operation === "retire"
                                  ? "批准下架"
                                  : "审核并发布"}
                              </button>
                              <button
                                disabled={busy || dirty || selfReview}
                                onClick={() => operate("reject")}
                              >
                                退回修改
                              </button>
                            </>
                          )}
                        {allowedEdit &&
                          selected.status === "published" &&
                          !pending && (
                            <button
                              className="ad-danger"
                              disabled={busy || dirty}
                              onClick={() => operate("retire")}
                            >
                              申请下架
                            </button>
                          )}
                      </div>
                      {selfReview && selected.draft?.state === "in_review" && (
                        <p className="ad-hint">
                          你参与了此次编辑或提交，需要另一位审核人员处理。
                        </p>
                      )}
                    </>
                  )}
                  {!allowedEdit && !allowedReview && (
                    <p className="ad-hint">当前账号拥有查看权限。</p>
                  )}
                </details>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
