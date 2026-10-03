import { useCallback, useEffect, useRef, useState } from "react";
import type { MapInfo } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { type ChangeItem, type StaffSession, stateNames } from "./api";
import { Empty, ErrorBox, Pager, timestamp, useResource } from "./ui";
import { PointWorkspace } from "./PointWorkspace";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { ExperienceWorkspace } from "./ExperienceWorkspace";
import { RoadWorkspace } from "./RoadWorkspace";
import { ConfigurationWorkspace } from "./ConfigurationWorkspace";
import { ReviewQueue } from "./ReviewQueue";

export const kindNames = {
  point: "地图点位",
  floor: "楼层原图",
  panorama: "VR 全景",
  media: "视频与图片",
  checkin: "打卡点",
  tour: "校园导览",
  navigation: "道路路网",
  configuration: "展示与服务配置",
};
export const kindIcons = {
  point: "pin",
  floor: "layers",
  panorama: "panorama",
  media: "play",
  checkin: "pin",
  tour: "route",
  navigation: "route",
  configuration: "layers",
};
export type ReviewStart = {
  state?: ChangeItem["state"];
  item?: ChangeItem;
  target?: { id: string; kind?: ChangeItem["kind"] };
};

export function ChangeRows({
  rows,
  onOpen,
}: {
  rows: ChangeItem[];
  onOpen: (item: ChangeItem) => void;
}) {
  return (
    <div className="ad-change-list">
      {rows.map((item) => (
        <button
          className="ad-change-row"
          key={`${item.kind}:${item.id}`}
          onClick={() => onOpen(item)}
        >
          <span className={`ad-kind-icon ${item.kind}`}>
            <Icon name={kindIcons[item.kind]} />
          </span>
          <span className="ad-change-title">
            <strong>{item.title}</strong>
            <small>
              {item.point_name} · {kindNames[item.kind]}
              {item.operation === "retire" ? " · 下架申请" : ""}
            </small>
          </span>
          <span className="ad-change-person">
            <strong>{item.submitted_by_name || item.editor_name}</strong>
            <small>{timestamp(item.submitted_at || item.updated_at)}</small>
          </span>
          <span className={`ad-badge ${item.state}`}>
            {stateNames[item.state]}
          </span>
          <span className="ad-change-action">
            {item.can_review ? "去审核" : "查看详情"}
            <Icon name="arrow" size={14} />
          </span>
        </button>
      ))}
    </div>
  );
}

export function ReviewCenter({
  session,
  maps,
  mapsError,
  onRetryMaps,
  onDirty,
  onUpdate,
  initial,
  revision: externalRevision,
}: {
  session: StaffSession;
  maps: MapInfo[];
  mapsError: string;
  onRetryMaps: () => void;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate: () => void;
  initial?: ReviewStart;
  revision: number;
}) {
  const [state, setState] = useState<ChangeItem["state"]>(
    initial?.state ?? "in_review",
  );
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [order, setOrder] = useState("oldest");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [queue, setQueue] = useState<ChangeItem[] | null>(null);
  const [selected, setSelected] = useState<ChangeItem | null>(
    initial?.item ?? null,
  );
  const dirty = useRef(false);
  const processing = useRef(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const targetOpened = useRef(false);
  const detailDirty = useCallback(
    (value: boolean, busy = false) => {
      dirty.current = value;
      processing.current = busy;
      setDetailBusy(busy);
      onDirty(value, busy);
    },
    [onDirty],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({
    state,
    order,
    page: String(page),
    page_size: "20",
    ...(kind ? { kind } : {}),
    ...(search ? { q: search } : {}),
    ...(mine ? { mine: "true" } : {}),
  });
  const list = useResource<ChangeItem[]>(
    `/changes?${params}`,
    revision + externalRevision,
  );
  const target = useResource<ChangeItem[]>(
    initial?.target
      ? `/changes?${new URLSearchParams({ ...(initial.target.kind ? { kind: initial.target.kind } : {}), item_id: initial.target.id })}`
      : null,
    revision + externalRevision,
  );
  useEffect(() => {
    if (!targetOpened.current && target.data?.data[0]) {
      targetOpened.current = true;
      setSelected(target.data.data[0]);
    }
  }, [target.data]);
  useEffect(() => {
    const pagination = list.data?.meta.pagination;
    if (!pagination) return;
    const lastPage = Math.max(
      1,
      Math.ceil(pagination.total / pagination.page_size),
    );
    if (page > lastPage) setPage(lastPage);
  }, [list.data, page]);
  function refresh() {
    setRevision((v) => v + 1);
    onUpdate();
  }
  function back() {
    if (processing.current) return;
    if (dirty.current && !window.confirm("当前修改尚未保存，确定返回列表吗？"))
      return;
    dirty.current = false;
    onDirty(false);
    setSelected(null);
    refresh();
  }
  if (selected)
    return (
      <section className="ad-review-detail">
        <div className="ad-detail-breadcrumb">
          <button onClick={back} disabled={detailBusy}>
            ← 返回审核中心
          </button>
          <span>
            {kindNames[selected.kind]} / {selected.point_name}
          </span>
        </div>
        <div className="ad-review-context">
          <span className={`ad-kind-icon ${selected.kind}`}>
            <Icon name={kindIcons[selected.kind]} />
          </span>
          <div>
            <h1>{selected.title}</h1>
            <p>
              提交人：{selected.submitted_by_name || selected.editor_name} ·{" "}
              {timestamp(selected.submitted_at || selected.updated_at)}
            </p>
          </div>
        </div>
        {selected.kind === "point" ? (
          <>
            <ErrorBox text={mapsError} onRetry={onRetryMaps} />
            {maps.length ? (
              <PointWorkspace
                key={selected.id}
                session={session}
                maps={maps}
                initialId={selected.id}
                review
                onDirty={detailDirty}
                onUpdate={refresh}
              />
            ) : (
              !mapsError && (
                <Empty
                  title="正在准备点位地图"
                  detail="请稍候；如果没有底图，请先核对账号的校区范围。"
                />
              )
            )}
          </>
        ) : selected.kind === "navigation" ? (
          <>
            <ErrorBox text={mapsError} onRetry={onRetryMaps} />
            <RoadWorkspace
              key={selected.id}
              session={session}
              maps={maps}
              initialMapId={selected.id}
              reviewMode
              onDirty={detailDirty}
              onUpdate={refresh}
            />
          </>
        ) : selected.kind === "configuration" ? (
          <ConfigurationWorkspace
            key={selected.id}
            session={session}
            initialId={selected.id}
            review
            onDirty={detailDirty}
            onUpdate={refresh}
          />
        ) : ["media", "checkin", "tour"].includes(selected.kind) ? (
          <ExperienceWorkspace
            key={selected.id}
            session={session}
            initialId={selected.id}
            kindScope={selected.kind === "tour" ? "tours" : "places"}
            review
            focused
            onDirty={detailDirty}
            onUpdate={refresh}
          />
        ) : (
          <ResourceWorkspace
            key={selected.id}
            session={session}
            initialId={selected.id}
            focused
            review
            onDirty={detailDirty}
            onUpdate={refresh}
          />
        )}
      </section>
    );
  if (queue) return <ReviewQueue rows={queue} session={session} onOpen={setSelected} onClose={() => { setQueue(null); refresh(); }}
    onDirty={detailDirty} onUpdate={onUpdate} />;
  return (
    <section className="ad-inbox">
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">CONTENT REVIEW</div>
          <h1>审核中心</h1>
          <p>
            点位、楼层、VR、视频、打卡、路线、路网及展示和服务配置统一审核。参与本次编辑的成员不能自审。
          </p>
        </div>
        <button onClick={refresh} disabled={list.loading}>
          <Icon name="refresh" size={16} /> 刷新列表
        </button>
      </div>
      <div className="ad-card ad-inbox-card">
        <nav className="ad-state-tabs" aria-label="变更状态">
          {(
            [
              "in_review",
              "draft",
              "rejected",
              "published",
              "discarded",
            ] as const
          ).map((s) => (
            <button
              key={s}
              aria-pressed={state === s}
              className={state === s ? "active" : ""}
              onClick={() => {
                setState(s);
                setPage(1);
              }}
            >
              {s === "published" ? "已处理" : stateNames[s]}
            </button>
          ))}
        </nav>
        <div className="ad-inbox-filters">
          <label className="ad-filter-search">
            <Icon name="search" size={18} />
            <input
              aria-label="搜索待办地点或资料名称"
              placeholder="搜索地点、资料、导览或路网名称"
              maxLength={120}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="资料类型"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部类型</option>
            {Object.entries(kindNames).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="待办排序"
            value={order}
            onChange={(e) => {
              setOrder(e.target.value);
              setPage(1);
            }}
          >
            <option value="oldest">较早提交优先</option>
            <option value="newest">最近更新优先</option>
          </select>
          <label className="ad-check">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
                setPage(1);
              }}
            />
            我参与的
          </label>
        </div>
        <div className="ad-list-caption">
          <span>
            {list.data
              ? `${list.data.meta.pagination?.total ?? 0} 项${stateNames[state]}`
              : "正在读取"}
          </span>
          <span>包含当前账号授权范围内的所有地点</span>
        </div>
        <ErrorBox text={list.error || target.error} onRetry={refresh} />
        {initial?.target && target.data && !target.data.data.length && (
          <p role="status">
            该内容已处理或不在待审队列中，请查看下方最新记录。
          </p>
        )}
        {list.loading && (
          <div className="ad-list-loading" role="status">
            <span className="ad-loading-dot" />
            正在整理变更列表…
          </div>
        )}
        {list.data && <ChangeRows rows={list.data.data} onOpen={setSelected} />}
        {state === "in_review" && list.data?.data.some(item => item.can_review) && <button disabled={list.loading}
          onClick={() => setQueue(list.data!.data.filter(item => item.can_review && item.state === "in_review"))}>逐项审阅本页待审内容</button>}
        {list.data && !list.data.data.length && (
          <Empty
            title={
              query || kind || mine
                ? "没有符合条件的内容"
                : state === "in_review"
                  ? "待审核事项已处理完"
                  : "这里暂时没有记录"
            }
            detail={
              query || kind || mine
                ? "可以清空搜索、切换类型或取消“我参与的”。"
                : "所有资料、校园导览与道路路网的提交会自动出现在这里。"
            }
          />
        )}
        <Pager page={list.data?.meta.pagination} onChange={setPage} />
      </div>
      <p className="ad-inbox-note">
        <Icon name="shield" size={16} />
        审核前请核对来源与预览。参与本次修改的成员需由另一位审核人员审核。
      </p>
    </section>
  );
}
