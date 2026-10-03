import { useEffect, useRef, useState } from "react";
import { api, get, ApiError, type Campus } from "../../shared/api/client";
import { watchCatalogChanges } from "../../shared/catalogSync";
import type { PublicPage } from "../../shared/navigation";
import type { Experience } from "../experiences/types";
import { safeMediaUrl } from "../experiences/progress";
import { segmentsForStop } from "../experiences/segments";
import {
  clearVisit,
  listVisits,
  loadVisit,
  saveVisit,
  type VisitMode,
  type VisitSession,
} from "./session";
import "./exhibition.css";
import { RouteDistribution } from "./RouteDistribution";
import type {
  MapDefaultView,
  MapFocusEffect,
  MapLayer,
} from "../map/mapDefaults";

export type ShowcaseCard = {
  id: string;
  campus_id: string;
  revision: number;
  title: string;
  description: string;
  media_url?: string | null;
  stop_count: number;
  benefits?: string[];
  sort_order?: number;
  resource_types?: string[];
};
export type ShowcaseModule = {
  id: string;
  type:
    | "hero"
    | "visit_modes"
    | "continue_visit"
    | "featured_routes"
    | "all_routes"
    | "introduction"
    | "resource_entries"
    | "announcement";
  enabled: boolean;
  title: string;
  body: string;
  layout: "default" | "wide" | "split";
  image?: { type: "image"; id: string; revision: number } | null;
  routes?: { type: "tour"; id: string; revision: number }[];
  target?: {
    type: "home" | "map" | "vr" | "routes" | "tour";
    id?: string;
    revision?: number;
  } | null;
  image_focus?: { x: number; y: number };
  alt?: string;
  start_at?: string | null;
  end_at?: string | null;
  button_label?: string;
  source_url?: string | null;
};
export type Showcase = {
  campus_id: string;
  presentation: {
    site_name: string;
    description: string;
    footer: string;
    contact_help: string;
    modules: ShowcaseModule[];
    appearance: { palette: string; density: string; radius: string };
  };
  visit_defaults: {
    layout: "balanced" | "scene_first" | "reading_first";
    assistant_collapsed: boolean;
    welcome_text: string;
    recommended_questions: string[];
    map_show_labels?: boolean;
    map_categories?: string[];
    map_default_view?: MapDefaultView | null;
    map_layers?: MapLayer[];
    map_focus_effect?: MapFocusEffect;
  };
  configuration_revisions?: Record<string, number>;
  visit_default_sources?: Record<string, "builtin" | "global" | "campus">;
  routes: ShowcaseCard[];
  resolved_resources: {
    type: string;
    id: string;
    revision: number;
    url?: string | null;
    title: string;
  }[];
  capabilities: {
    chat: boolean;
    voice: boolean;
    narration: boolean;
    navigation: boolean;
  };
};
export function usePublicShowcase(page: PublicPage) {
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campus, setCampus] = useState<Campus | null>(null);
  const [showcase, setShowcase] = useState<Showcase | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const routeId = "tourId" in page ? page.tourId : null;
  const selectedCampus = new URL(window.location.href).searchParams.get(
    "campus",
  );
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal,
        turn = ++epoch.current;
      try {
        const rows = (await api.campuses(signal)).data;
        let campusId = selectedCampus;
        if (routeId) {
          try {
            campusId = (
              await get<Experience>(`/experiences/${routeId}`, signal)
            ).data.campus_id;
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              ![404, 410].includes(error.status)
            )
              throw error;
          }
        }
        const chosen =
          rows.find((row) => row.id === campusId) ??
          rows.find((row) => row.id === "nku-jinnan") ??
          rows[0];
        if (!chosen) throw new Error("No public campus");
        const result = (
          await get<Showcase>(
            `/campuses/${encodeURIComponent(chosen.id)}/showcase`,
            signal,
          )
        ).data;
        if (
          result.campus_id !== chosen.id ||
          !Array.isArray(result.routes) ||
          !Array.isArray(result.presentation?.modules)
        )
          throw new Error("Invalid public showcase");
        if (disposed || signal.aborted || turn !== epoch.current) return;
        setCampuses(rows);
        setCampus(chosen);
        setShowcase(result);
        setState("ready");
      } catch {
        if (!disposed && !signal.aborted && turn === epoch.current)
          setState("error");
      }
    };
    setState("loading");
    setShowcase(null);
    setCampus(null);
    void load();
    const stop = watchCatalogChanges(load);
    return () => {
      disposed = true;
      controller?.abort();
      stop();
    };
  }, [routeId, selectedCampus, retry]);
  return {
    campuses,
    campus,
    showcase,
    state,
    retry: () => setRetry((v) => v + 1),
  };
}

type PageProps = {
  showcase: Showcase;
  campusName: string;
  onNavigate: (page: PublicPage) => void;
  onBegin: (
    tour: Experience,
    mode: VisitMode,
    start?: number,
    restart?: boolean,
  ) => void;
};
const resourceNames: Record<string, string> = {
  image: "图片",
  video: "视频",
  floor: "楼层",
  vr: "VR 全景",
  checkin: "打卡资料",
};
function Cards({
  rows,
  onNavigate,
}: {
  rows: ShowcaseCard[];
  onNavigate: PageProps["onNavigate"];
}) {
  return (
    <div className="exhibition-cards">
      {rows.map((row) => {
        const cover = safeMediaUrl(row.media_url);
        return (
          <button
            className="exhibition-card"
            key={row.id}
            onClick={() => onNavigate({ kind: "overview", tourId: row.id })}
          >
            {cover ? (
              <img src={cover} alt="" loading="lazy" />
            ) : (
              <div className="exhibition-card-blank" aria-hidden="true">
                南开 · 校园故事
              </div>
            )}
            <div>
              <small>{row.stop_count} 个地点 · 主题导览</small>
              <h3>{row.title}</h3>
              <p>{row.description}</p>
              {!!row.resource_types?.length && (
                <p className="route-resource-tags">
                  {row.resource_types.map((type) => (
                    <small key={type}>
                      {resourceNames[type] ?? "公开资料"}
                    </small>
                  ))}
                </p>
              )}
              <span>
                了解这条路线 <span aria-hidden="true">↗</span>
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
export function ExhibitionHome({
  showcase,
  campusName,
  onNavigate,
  previewOnly = false,
}: Omit<PageProps, "onBegin"> & { previewOnly?: boolean }) {
  const resume = previewOnly
    ? null
    : listVisits().find((v) => showcase.routes.some((r) => r.id === v.tourId));
  const resumeCurrent =
    resume &&
    showcase.routes.some(
      (r) => r.id === resume.tourId && r.revision === resume.position.revision,
    );
  const target = (module: ShowcaseModule): PublicPage =>
    module.target?.type === "tour" &&
    module.target.id &&
    showcase.routes.some(
      (r) =>
        r.id === module.target?.id && r.revision === module.target?.revision,
    )
      ? { kind: "overview", tourId: module.target.id }
      : {
          kind:
            module.target?.type === "map"
              ? "explore"
              : module.target?.type === "vr"
                ? "panoramas"
                : module.target?.type === "home"
                  ? "home"
                  : "tours",
        };
  return (
    <div
      className={`exhibition-page exhibition-home palette-${showcase.presentation.appearance.palette} density-${showcase.presentation.appearance.density} radius-${showcase.presentation.appearance.radius}`}
    >
      <div className="exhibition-campus">
        {campusName} · {showcase.presentation.site_name}
      </div>
      {!showcase.presentation.modules.some(
        (m) => m.enabled && m.type === "hero",
      ) && (
        <h1 className="sr-only">
          {showcase.presentation.site_name || "校园文化展馆"}
        </h1>
      )}
      {showcase.presentation.modules
        .filter((m) => m.enabled)
        .map((module) => {
          const asset =
            module.image &&
            showcase.resolved_resources.find(
              (r) =>
                r.type === "image" &&
                r.id === module.image?.id &&
                r.revision === module.image?.revision,
            );
          const image = safeMediaUrl(asset?.url);
          const chosen =
            module.type === "featured_routes"
              ? (module.routes ?? []).flatMap((ref) =>
                  showcase.routes.filter(
                    (r) => r.id === ref.id && r.revision === ref.revision,
                  ),
                )
              : showcase.routes;
          if (module.type === "hero")
            return (
              <section
                className={`exhibition-hero module-layout-${module.layout} ${image ? "with-image" : ""}`}
                key={module.id}
              >
                {image && (
                  <img
                    src={image}
                    alt={module.alt || asset?.title || ""}
                    fetchPriority="high"
                    style={{
                      objectPosition: `${(module.image_focus?.x ?? 0.5) * 100}% ${(module.image_focus?.y ?? 0.5) * 100}%`,
                    }}
                  />
                )}
                <div>
                  <small>南开 · 校园数字文化展馆</small>
                  <h1>{module.title || "走近南开，读懂校园故事"}</h1>
                  <p>{module.body || showcase.presentation.description}</p>
                  <button onClick={() => onNavigate(target(module))}>
                    {module.button_label || "开始发现"}
                  </button>
                </div>
              </section>
            );
          if (module.type === "visit_modes")
            return (
              <section
                className={`exhibition-modes module-layout-${module.layout}`}
                key={module.id}
              >
                {(module.title || module.body) && (
                  <div className="exhibition-module-heading">
                    <h2>{module.title}</h2>
                    <p>{module.body}</p>
                  </div>
                )}
                <button
                  onClick={() => onNavigate({ kind: "tours", mode: "online" })}
                >
                  <small>ONLINE</small>
                  <h2>在线云游</h2>
                  <p>沿主题看画面、听讲解，按自己的节奏认识南开。</p>
                </button>
                <button
                  onClick={() => onNavigate({ kind: "tours", mode: "onsite" })}
                >
                  <small>ON CAMPUS</small>
                  <h2>到校参观</h2>
                  <p>选择路线后切换到校模式，人工确认起点和到达。</p>
                </button>
                <button onClick={() => onNavigate({ kind: "explore" })}>
                  <small>EXPLORE</small>
                  <h2>自由探索</h2>
                  <p>从校园地图、真实地点和公开资料开始。</p>
                </button>
              </section>
            );
          if (module.type === "continue_visit")
            return resume ? (
              <section
                className={`exhibition-resume module-layout-${module.layout}`}
                key={module.id}
              >
                <div>
                  <small>本设备上次参观</small>
                  {module.title && <p>{module.title}</p>}
                  <h2>
                    {showcase.routes.find((r) => r.id === resume.tourId)?.title}
                  </h2>
                  <p>
                    {resumeCurrent
                      ? `第 ${resume.position.stopIndex + 1} 站 · 声音由你继续`
                      : "旧版进度仍保留；路线已更新，请在新版重新选择起点。"}
                  </p>
                  {module.body && <p>{module.body}</p>}
                </div>
                <button
                  onClick={() =>
                    onNavigate({ kind: "overview", tourId: resume.tourId })
                  }
                >
                  {resumeCurrent ? "继续上次参观" : "查看新版路线"}
                </button>
              </section>
            ) : null;
          if (module.type === "featured_routes" || module.type === "all_routes")
            return (
              <section
                className={`module-layout-${module.layout}`}
                key={module.id}
              >
                <div className="exhibition-section-title">
                  <h2>
                    {module.title ||
                      (module.type === "featured_routes"
                        ? "推荐路线"
                        : "主题导览")}
                  </h2>
                  <button onClick={() => onNavigate({ kind: "tours" })}>
                    查看全部路线
                  </button>
                </div>
                {module.body && <p>{module.body}</p>}
                {chosen.length ? (
                  <Cards rows={chosen} onNavigate={onNavigate} />
                ) : (
                  <p className="exhibition-empty">
                    当前没有已发布路线，可以先自由探索校园。
                  </p>
                )}
              </section>
            );
          if (module.type === "resource_entries")
            return (
              <section
                className={`exhibition-resources module-layout-${module.layout}`}
                key={module.id}
              >
                <h2>{module.title || "从真实空间继续发现"}</h2>
                {module.body && (
                  <p className="exhibition-module-heading">{module.body}</p>
                )}
                <button onClick={() => onNavigate({ kind: "explore" })}>
                  校园地图与楼层资料 ↗
                </button>
                <button onClick={() => onNavigate({ kind: "panoramas" })}>
                  VR 全景目录 ↗
                </button>
              </section>
            );
          return (
            <section
              className={`exhibition-copy module-layout-${module.layout}`}
              key={module.id}
            >
              <h2>{module.title}</h2>
              <p>{module.body}</p>
              {safeMediaUrl(module.source_url) && (
                <a
                  href={safeMediaUrl(module.source_url)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看原始来源 ↗
                </a>
              )}
              {image && (
                <img
                  src={image}
                  alt={module.alt || asset?.title || ""}
                  loading="lazy"
                />
              )}
            </section>
          );
        })}
      <footer>
        <p>{showcase.presentation.footer}</p>
        <p>{showcase.presentation.contact_help}</p>
      </footer>
    </div>
  );
}
export function TourCatalog({
  showcase,
  onNavigate,
  initialMode = "online",
}: Pick<PageProps, "showcase" | "onNavigate"> & { initialMode?: VisitMode }) {
  const [query, setQuery] = useState("");
  const [resource, setResource] = useState("");
  const available = [
    ...new Set(showcase.routes.flatMap((r) => r.resource_types ?? [])),
  ];
  const rows = showcase.routes.filter(
    (r) =>
      `${r.title} ${r.description}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()) &&
      (!resource || r.resource_types?.includes(resource)),
  );
  return (
    <div className="exhibition-page">
      <small>沿主题认识校园</small>
      <h1>主题导览</h1>
      <p>路线与素材由团队独立审核发布。选择一条，了解它的故事与地点。</p>
      <label className="exhibition-search">
        搜索路线
        <input
          value={query}
          maxLength={120}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="主题或路线名称"
        />
      </label>
      {!!available.length && (
        <label className="exhibition-search">
          实际资源
          <select
            value={resource}
            onChange={(event) => setResource(event.target.value)}
          >
            <option value="">全部资料类型</option>
            {available.map((type) => (
              <option key={type} value={type}>
                {resourceNames[type] ?? "公开资料"}
              </option>
            ))}
          </select>
        </label>
      )}
      {rows.length ? (
        <Cards
          rows={rows}
          onNavigate={(page) => onNavigate({ ...page, mode: initialMode })}
        />
      ) : (
        <p role="status">
          {query ? "没有匹配的已发布路线。" : "当前没有已发布路线。"}
        </p>
      )}
    </div>
  );
}
export function TourOverview({
  tour,
  showcase,
  onBegin,
  onNavigate,
  initialMode = "online",
}: PageProps & { tour: Experience; initialMode?: VisitMode }) {
  const [mode, setMode] = useState<VisitMode>(initialMode);
  const [start, setStart] = useState(0);
  const [pointNames, setPointNames] = useState<Record<string, string>>({});
  useEffect(() => {
    setMode(initialMode);
    setStart(0);
  }, [tour.id, tour.revision, initialMode]);
  useEffect(() => {
    const controller = new AbortController();
    setPointNames({});
    if (tour.content.kind !== "tour") return;
    void Promise.allSettled(
      [...new Set(tour.content.stops.map((s) => s.point_id))].map(
        async (id) => {
          const { data } = await api.point(id, controller.signal);
          if (data.id !== id || data.campus_id !== tour.campus_id)
            throw new Error("Invalid public point");
          return [id, data.name] as const;
        },
      ),
    ).then((results) => {
      if (!controller.signal.aborted)
        setPointNames(
          Object.fromEntries(
            results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
          ),
        );
    });
    return () => controller.abort();
  }, [tour.id, tour.revision, tour.campus_id]);
  if (tour.content.kind !== "tour") return null;
  const content = tour.content;
  const resume = loadVisit(tour.id);
  const card = showcase.routes.find((r) => r.id === tour.id);
  const cover = safeMediaUrl(card?.media_url);
  const extended = content as typeof content & {
    lead?: string;
    outcomes?: string[];
    narration_mode?: "text" | "recorded";
    cover_focus?: { x: number; y: number };
  };
  return (
    <div className="exhibition-page exhibition-overview">
      <button
        className="exhibition-back"
        onClick={() => onNavigate({ kind: "tours" })}
      >
        ← 全部主题路线
      </button>
      {cover && (
        <img
          className="overview-cover"
          src={cover}
          alt=""
          style={{
            objectPosition: `${(extended.cover_focus?.x ?? 0.5) * 100}% ${(extended.cover_focus?.y ?? 0.5) * 100}%`,
          }}
        />
      )}
      <small>
        {content.stops.length} 个地点 ·{" "}
        {extended.narration_mode === "recorded" ? "正式音频导览" : "图文导览"}
      </small>
      <h1>{content.title}</h1>
      <p className="exhibition-lead">{extended.lead || content.description}</p>
      {extended.outcomes?.length ? (
        <ul className="overview-outcomes">
          {extended.outcomes.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : null}
      <div className="overview-actions">
        <fieldset>
          <legend>参观方式</legend>
          <label>
            <input
              type="radio"
              checked={mode === "online"}
              onChange={() => setMode("online")}
            />{" "}
            在线云游
          </label>
          <label>
            <input
              type="radio"
              checked={mode === "onsite"}
              onChange={() => setMode("onsite")}
            />{" "}
            到校参观
          </label>
        </fieldset>
        <label>
          从哪里开始
          <select
            value={start}
            onChange={(e) => setStart(Number(e.target.value))}
          >
            {content.stops.map((stop, i) => (
              <option key={`${i}:${stop.point_id}`} value={i}>
                第 {i + 1} 站 ·{" "}
                {stop.title || pointNames[stop.point_id] || `地点 ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <button
          className="exhibition-primary"
          onClick={() => onBegin(tour, mode, start, true)}
        >
          {resume?.position.revision === tour.revision
            ? "重新从所选地点开始"
            : "开始参观"}
        </button>
        {resume?.position.revision === tour.revision && (
          <button
            onClick={() =>
              onBegin(tour, resume.mode, resume.position.stopIndex)
            }
          >
            继续第 {resume.position.stopIndex + 1} 站
          </button>
        )}
        {resume && resume.position.revision !== tour.revision && (
          <p role="status">
            路线已更新。旧版记录保留，请从新版目录明确选择开始位置。
          </p>
        )}
      </div>
      {card?.resource_types?.length ? (
        <div className="route-resource-tags" aria-label="路线实际可用资源">
          {card.resource_types
            .filter((type) => resourceNames[type])
            .map((type) => (
              <small key={type}>{resourceNames[type]}</small>
            ))}
        </div>
      ) : null}
      <RouteDistribution
        campusId={tour.campus_id}
        pointIds={content.stops.map((stop) => stop.point_id)}
        onSelect={(pointId) => {
          const index = content.stops.findIndex(
            (stop) => stop.point_id === pointId,
          );
          if (index >= 0) setStart(index);
        }}
      />
      <section>
        <h2>路线里的地点</h2>
        <ol className="overview-stops">
          {content.stops.map((stop, i) => (
            <li key={`${i}:${stop.point_id}`}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>
                  {stop.title || pointNames[stop.point_id] || `第 ${i + 1} 站`}
                </h3>
                <p>
                  {segmentsForStop(stop, i).length} 段讲解 ·{" "}
                  {segmentsForStop(stop, i).flatMap((s) => s.resources).length}{" "}
                  项附属资料
                </p>
              </div>
              <button
                onClick={() => {
                  setStart(i);
                  onBegin(tour, mode, i, true);
                }}
              >
                从本站开始
              </button>
            </li>
          ))}
        </ol>
      </section>
      {mode === "onsite" && (
        <p className="exhibition-disclaimer">
          起点和到达由你人工确认。站点顺序表示叙事安排，不代表实测步行距离或通行保证。
        </p>
      )}
    </div>
  );
}
export function VisitRecap({
  tour,
  record,
  onNavigate,
}: {
  tour: Experience;
  record: VisitSession | null;
  onNavigate: PageProps["onNavigate"];
}) {
  if (tour.content.kind !== "tour") return null;
  const same =
    record?.tourId === tour.id && record.position.revision === tour.revision;
  const savedCollections = same
    ? (record.collections ?? []).flatMap((collection) => {
        const stop =
          tour.content.kind === "tour"
            ? tour.content.stops[collection.stopIndex]
            : null;
        const segment = stop
          ? segmentsForStop(stop, collection.stopIndex).find(
              (s) => s.id === collection.segmentId,
            )
          : null;
        if (
          !segment ||
          (collection.resourceId &&
            ![
              ...segment.resources,
              ...(segment.main_view.type === "map" ? [] : [segment.main_view]),
            ].some((ref) => ref.id === collection.resourceId))
        )
          return [];
        return [
          {
            ...collection,
            title: segment.title || `第 ${collection.stopIndex + 1} 站讲解`,
            resource: Boolean(collection.resourceId),
          },
        ];
      })
    : [];
  return (
    <div className="exhibition-page">
      <small>属于你的参观回顾</small>
      <h1>{tour.content.title}</h1>
      <p>
        本设备记录，不代表官方签到或学习测评。未完成的地点不会因打开回顾而变为完成。
      </p>
      <p>
        {same
          ? `${record?.completed?.length ?? 0} 站完成阅读 · ${record?.skipped?.length ?? 0} 站跳过 · ${record?.arrived?.length ?? 0} 站人工确认到达`
          : "本版尚无参观记录。旧版记录保存在“我的参观”。"}
      </p>
      <ol className="recap-stops">
        {tour.content.stops.map((stop, index) => (
          <li key={`${index}:${stop.point_id}`}>
            <h2>{stop.title || `第 ${index + 1} 站`}</h2>
            <small>
              {same && record?.completed?.includes(index)
                ? "已完成阅读"
                : same && record?.skipped?.includes(index)
                  ? "已跳过"
                  : "尚未完成"}
            </small>
            {segmentsForStop(stop, index).map((s) => {
              const richer = s as typeof s & { takeaway?: string };
              return (
                <div key={s.id}>
                  {richer.takeaway && <p>{richer.takeaway}</p>}
                  {same && record?.notes?.[s.id] && (
                    <p className="visit-note">我的笔记：{record.notes[s.id]}</p>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ol>
      <section aria-labelledby="recap-collections">
        <h2 id="recap-collections">我的收藏</h2>
        {savedCollections.length ? (
          <ul>
            {savedCollections.map((c) => (
              <li
                key={`${c.stopIndex}:${c.segmentId}:${c.resourceId ?? "segment"}`}
              >
                {c.title}
                {c.resource ? " · 本段资料" : " · 讲解段落"}
              </li>
            ))}
          </ul>
        ) : (
          <p>这一版路线尚无有效收藏。</p>
        )}
      </section>
      <button onClick={() => onNavigate({ kind: "overview", tourId: tour.id })}>
        回到路线介绍
      </button>
      <button onClick={() => onNavigate({ kind: "visits" })}>
        查看本设备收藏与笔记
      </button>
    </div>
  );
}
export function MyVisits({
  showcase,
  onNavigate,
  items = [],
  onResume,
}: Pick<PageProps, "showcase" | "onNavigate"> & {
  items?: Experience[];
  onResume?: (record: VisitSession) => void;
}) {
  const [rows, setRows] = useState(listVisits);
  const [notice, setNotice] = useState("");
  const update = (record: VisitSession) => {
    if (saveVisit(record)) {
      setRows(listVisits());
      setNotice("本设备记录已更新。");
    } else setNotice("浏览器暂不允许保存，请重试。");
  };
  return (
    <div className="exhibition-page">
      <small>只在本设备</small>
      <h1>我的参观</h1>
      <p>
        进度、收藏和笔记保留至你清除或浏览器清理；不上传私人记录，二维码只接续公开参观位置。
      </p>
      {notice && <p role="status">{notice}</p>}
      {!!rows.length && (
        <button
          onClick={() => {
            if (!window.confirm("清除本设备的全部参观进度、收藏和笔记？"))
              return;
            const done = rows
              .map((r) => clearVisit(r.tourId, r.position.revision))
              .every(Boolean);
            setRows(listVisits());
            setNotice(
              done
                ? "本设备参观记录已全部清除。"
                : "部分记录未能清除，请重试。",
            );
          }}
        >
          清除全部参观记录
        </button>
      )}
      {!rows.length && <p>还没有保存的参观记录。选择一条主题路线开始吧。</p>}
      {rows.map((v) => {
        const route = showcase.routes.find((r) => r.id === v.tourId);
        const current = items.find(
          (r) =>
            r.id === v.tourId &&
            r.revision === v.position.revision &&
            r.content.kind === "tour",
        );
        return (
          <section
            className="my-visit-card"
            key={`${v.tourId}:${v.position.revision}`}
          >
            <h2>{route?.title || "历史路线记录"}</h2>
            <p>
              版本 {v.position.revision} · 第 {v.position.stopIndex + 1} 站 ·{" "}
              {v.collections?.length ?? 0} 项收藏
            </p>
            {route && (
              <button
                onClick={() =>
                  onNavigate({ kind: "overview", tourId: v.tourId })
                }
              >
                查看当前路线
              </button>
            )}
            {route?.revision === v.position.revision && current && onResume && (
              <button onClick={() => onResume(v)}>接续这个版本的进度</button>
            )}
            {(v.collections ?? []).map((c, index) => {
              const stop =
                current?.content.kind === "tour"
                  ? current.content.stops[c.stopIndex]
                  : null;
              const segment = stop
                ? segmentsForStop(stop, c.stopIndex).find(
                    (s) => s.id === c.segmentId,
                  )
                : null;
              const ref =
                c.resourceId && segment
                  ? [
                      ...segment.resources,
                      ...(segment.main_view.type === "map"
                        ? []
                        : [segment.main_view]),
                    ].find((r) => r.id === c.resourceId)
                  : null;
              const media =
                ref &&
                items.find(
                  (r) => r.id === ref.id && r.revision === ref.revision,
                );
              const title = c.resourceId
                ? media?.content.title ||
                  (ref ? "本站已发布资料" : "历史资料收藏")
                : segment?.title || `第 ${c.stopIndex + 1} 站的讲解段落`;
              return (
                <div
                  className="visit-collection"
                  key={`${c.stopIndex}:${c.segmentId}:${c.resourceId ?? "segment"}`}
                >
                  <span>{title}</span>
                  {segment && (!c.resourceId || ref) && onResume && (
                    <button
                      onClick={() => {
                        const record = {
                          ...v,
                          position: {
                            revision: v.position.revision,
                            stopIndex: c.stopIndex,
                            segmentId: c.segmentId,
                          },
                        };
                        delete record.audio;
                        onResume(record);
                      }}
                    >
                      回到所属讲解
                    </button>
                  )}
                  <button
                    aria-label={`取消收藏：${title}`}
                    onClick={() =>
                      update({
                        ...v,
                        collections: v.collections?.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    取消收藏
                  </button>
                </div>
              );
            })}
            {Object.entries(v.notes ?? {}).map(([key, note]) => {
              const notePosition =
                current?.content.kind === "tour"
                  ? current.content.stops.flatMap((stop, index) =>
                      segmentsForStop(stop, index)
                        .filter((segment) => segment.id === key)
                        .map((segment) => ({
                          stopIndex: index,
                          segmentId: segment.id,
                          title: segment.title || `第 ${index + 1} 站讲解`,
                        })),
                    )[0]
                  : null;
              return (
                <div className="visit-note" key={key}>
                  <strong>{notePosition?.title || "历史讲解笔记"}</strong>
                  <p>{note}</p>
                  {notePosition && onResume && (
                    <button
                      aria-label={`回到笔记所属讲解：${notePosition.title}`}
                      onClick={() => {
                        const next = {
                          ...v,
                          position: {
                            revision: v.position.revision,
                            stopIndex: notePosition.stopIndex,
                            segmentId: notePosition.segmentId,
                          },
                        };
                        delete next.audio;
                        onResume(next);
                      }}
                    >
                      回到笔记所属讲解
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const notes = { ...v.notes };
                      delete notes[key];
                      update({ ...v, notes });
                    }}
                  >
                    删除这条笔记
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => {
                if (clearVisit(v.tourId, v.position.revision)) {
                  setRows(listVisits());
                  setNotice("这条记录已从本设备清除。");
                } else setNotice("浏览器暂不允许清除，请重试。");
              }}
            >
              清除此版本记录
            </button>
          </section>
        );
      })}
    </div>
  );
}
