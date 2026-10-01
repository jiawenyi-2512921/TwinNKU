import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, get, type RouteSegment } from "../shared/api/client";
import {
  availableSelection,
  loadCatalog,
  reconcileCatalog,
  type Catalog,
} from "../features/map/catalog";
import {
  createCatalogRefresh,
  watchCatalogChanges,
} from "../shared/catalogSync";
import { Icon } from "../shared/ui/Icon";
import {
  pointLocation,
  writeLocation,
  experienceLocation,
  readExperienceLocation,
  LOCATION_CHANGE_EVENT,
  type ExperienceSelection,
} from "../shared/navigation";
import { usePlaceMemory } from "../features/places/usePlaceMemory";
import { findPlaces, type PlaceScope } from "../features/places/search";
import { PlaceDirectory } from "../features/places/PlaceDirectory";
import { MapCanvas } from "../features/map/MapCanvas";
import { correctedDisplayName } from "../features/map/labelCorrections";
import { AgentDock, type AgentRequest } from "../features/agent/AgentDock";
import { useAgentConfig } from "../features/agent/useAgentConfig";
import {
  EMPTY_CONTEXT,
  safeContext,
  type AgentContext,
} from "../features/agent/protocol";
import { NativeAgentDock } from "../features/agent/NativeAgentDock";
import {
  actionLocation,
  type GuideAction,
  type GuideActionOptions,
  type GuideContext,
  type NavigationPath,
} from "../features/agent/native";
import {
  NavigationPanel,
  type RouteSelection,
  type RoutePickMode,
  type RoutePickedPoint,
  type RouteSelectionState,
} from "../features/map/NavigationPanel";
import { panoramaLocation } from "../features/points/panorama";
import { PanoramaOverlay } from "../features/points/PanoramaOverlay";
import { panoramaOnlyTransition } from "../shared/navigation";
import { PointDetails } from "../features/points/PointDetails";
import {
  ExperiencePanel,
  type VideoPlaybackRequest,
} from "../features/experiences/ExperiencePanel";
import type { Experience } from "../features/experiences/types";

const categories = [
  "all",
  "academic",
  "public_area",
  "landscape",
  "residence",
  "dining",
  "commerce",
  "history",
  "patriotic",
] as const;

const EMPTY_ROUTE_SEGMENTS: RouteSegment[] = [];

export function App() {
  const agentConfig = useAgentConfig();
  const [route, setRoute] = useState<NavigationPath | null>(null);
  const [navigation, setNavigation] = useState<RouteSelection | null>(null);
  const [pickMode, setPickMode] = useState<RoutePickMode>(null);
  const [pickedPoint, setPickedPoint] = useState<RoutePickedPoint | null>(null);
  const [routeSelection, setRouteSelection] = useState<RouteSelectionState>({
    start: "",
    end: "",
    availablePointIds: [],
  });
  const [experience, setExperience] = useState<ExperienceSelection | null>(() =>
    readExperienceLocation(window.location.href),
  );
  const [locationSearch, setLocationSearch] = useState(
    () => window.location.search,
  );
  const [experienceCatalog, setExperienceCatalog] = useState<Experience[]>([]);
  const experienceCatalogRef = useRef(experienceCatalog);
  experienceCatalogRef.current = experienceCatalog;
  const [playbackRequest, setPlaybackRequest] =
    useState<VideoPlaybackRequest | null>(null);
  const playbackController = useRef<AbortController | null>(null);
  const playbackSequence = useRef(0);
  const cancelPlayback = useCallback(() => {
    playbackController.current?.abort();
    playbackController.current = null;
    setPlaybackRequest(null);
  }, []);
  const [mediaActive, setMediaActive] = useState(false);
  const contextState = useRef({ key: "", revision: 0 });
  const [agentRequest, setAgentRequest] = useState<AgentRequest | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const refresh = useRef<() => void>(() => {});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [scope, setScope] = useState<PlaceScope>("all");
  const [placeMessage, setPlaceMessage] = useState("");
  const memory = usePlaceMemory(catalog?.campus.id ?? "nku-jinnan");
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("point"),
  );
  const selectedRef = useRef(selectedId);
  const [showList, setShowList] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const selectPoint = useCallback(
    (
      id: string | null,
      preserveExperience = false,
      mode: "push" | "replace" = "push",
    ) => {
      cancelPlayback();
      selectedRef.current = id;
      setSelectedId(id);
      setShowList(false);
      setShowHelp(false);
      writeLocation(
        pointLocation(window.location.href, id, preserveExperience),
        mode,
      );
    },
    [cancelPlayback],
  );
  const selectExperiencePoint = useCallback(
    (id: string) => {
      // A tour owns its step progress. Moving its map highlight does not create
      // a second, contradictory browser history of tour steps.
      selectPoint(id, true, "replace");
    },
    [selectPoint],
  );
  const closeExperience = useCallback(() => {
    cancelPlayback();
    setExperience(null);
    writeLocation(experienceLocation(window.location.href, null), "replace");
  }, [cancelPlayback]);
  const explorePoint = useCallback(
    (id: string | null) => {
      setExperience(null);
      selectPoint(id);
    },
    [selectPoint],
  );
  const closeDetails = useCallback(() => {
    selectPoint(null);
    browseButton.current?.focus();
  }, [selectPoint]);
  function closeList() {
    setShowList(false);
    browseButton.current?.focus();
  }

  useEffect(() => {
    const sync = createCatalogRefresh({
      load: (signal) => loadCatalog(api, signal),
      apply: (next) => {
        setCatalog((previous) => reconcileCatalog(previous, next));
        const retained = availableSelection(next, selectedRef.current);
        if (retained !== selectedRef.current) {
          cancelPlayback();
          selectedRef.current = retained;
          setSelectedId(retained);
          setExperience(null);
          writeLocation(
            pointLocation(window.location.href, retained),
            "replace",
          );
        }
        setStatus(next?.map ? "ready" : "empty");
        setLastChecked(new Date());
      },
      failed: () => setStatus("error"),
      busy: setRefreshing,
    });
    refresh.current = () => {
      void sync.refresh(true);
    };
    const unwatch = watchCatalogChanges(sync.refresh);
    void sync.refresh();
    return () => {
      playbackController.current?.abort();
      unwatch();
      sync.dispose();
    };
  }, []);

  useEffect(() => {
    if (!catalog?.campus.id) return;
    let disposed = false;
    let pending: AbortController | null = null;
    let generation = 0;
    const refreshExperiences = async () => {
      pending?.abort();
      const current = ++generation;
      const controller = new AbortController();
      pending = controller;
      try {
        const result = await get<Experience[]>(
          `/experiences?campus_id=${encodeURIComponent(catalog.campus.id)}`,
          controller.signal,
        );
        if (!disposed && current === generation && !controller.signal.aborted)
          setExperienceCatalog(result.data);
      } catch {
        if (!disposed && current === generation && !controller.signal.aborted)
          setExperienceCatalog([]);
      }
    };
    const stop = watchCatalogChanges(refreshExperiences);
    void refreshExperiences();
    return () => {
      disposed = true;
      pending?.abort();
      stop();
    };
  }, [catalog?.campus.id]);

  useEffect(() => {
    let previousHref = window.location.href;
    function restoreLocation() {
      cancelPlayback();
      const overlayOnly = panoramaOnlyTransition(
        previousHref,
        window.location.href,
      );
      previousHref = window.location.href;
      const requested = new URLSearchParams(window.location.search).get(
        "point",
      );
      const current = catalogRef.current;
      const id = current ? availableSelection(current, requested) : requested;
      selectedRef.current = id;
      setSelectedId(id);
      setLocationSearch(window.location.search);
      if (overlayOnly) return;
      setExperience(readExperienceLocation(window.location.href));
      setNavigation(null);
      setRoute(null);
      setPickMode(null);
      setPickedPoint(null);
      setShowList(false);
      setShowHelp(false);
      if (current && requested !== id) {
        setExperience(null);
        writeLocation(pointLocation(window.location.href, id), "replace");
      }
    }
    const syncLocationContext = () => {
      previousHref = window.location.href;
      setLocationSearch(window.location.search);
    };
    window.addEventListener("popstate", restoreLocation);
    window.addEventListener(LOCATION_CHANGE_EVENT, syncLocationContext);
    return () => {
      window.removeEventListener("popstate", restoreLocation);
      window.removeEventListener(LOCATION_CHANGE_EVENT, syncLocationContext);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector("dialog[open]"))
        return;
      if (event.key === "Escape") {
        const vr = new URL(window.location.href);
        if (vr.searchParams.has("panorama")) {
          event.preventDefault();
          writeLocation(
            panoramaLocation(vr.href, vr.searchParams.get("point") ?? "", null),
            "replace",
          );
          return;
        }
        if (pickMode) {
          event.preventDefault();
          setPickMode(null);
          return;
        }
        if (navigation) {
          setNavigation(null);
          setRoute(null);
          return;
        }
        if (experience) {
          closeExperience();
          return;
        }
        if (showHelp) {
          setShowHelp(false);
          helpButton.current?.focus();
        } else if (showList) {
          setShowList(false);
          browseButton.current?.focus();
        } else if (selectedRef.current) closeDetails();
      }
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (
        event.key === "/" &&
        !editing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showHelp,
    showList,
    closeDetails,
    closeExperience,
    pickMode,
    experience,
    navigation,
  ]);

  const points = useMemo(
    () =>
      (catalog?.points ?? []).map((point) => {
        const name = correctedDisplayName(point.id, point.name);
        return name === point.name
          ? point
          : {
              ...point,
              name,
              summary: point.summary.startsWith(point.name)
                ? name + point.summary.slice(point.name.length)
                : point.summary,
            };
      }),
    [catalog?.points],
  );
  const filtered = useMemo(
    () =>
      findPlaces(
        points,
        query,
        category,
        scope === "all" ? undefined : memory.places[scope],
      ),
    [points, query, category, scope, memory.places],
  );
  const selected = points.find((p) => p.id === selectedId);
  const recordPlace = memory.dispatch;
  useEffect(() => {
    if (selected?.id) recordPlace({ type: "visit", id: selected.id });
  }, [selected?.id, recordPlace]);
  function toggleFavorite(id: string) {
    if (!points.some((point) => point.id === id)) return;
    const result = memory.dispatch({ type: "favorite", id });
    setPlaceMessage(result === "limit" ? "收藏已满，请先取消部分收藏。" : "");
  }
  const agentContext = safeContext({
    ...EMPTY_CONTEXT,
    campus_id: catalog?.campus.id ?? "",
    campus_name: catalog?.campus.name ?? "",
    point_id: selected?.id ?? "",
    point_name: selected?.name ?? "",
    point_revision: selected ? String(selected.revision) : "",
    map_id: catalog?.map?.id ?? "",
    map_revision: catalog?.map ? String(catalog.map.revision) : "",
  });
  const locationParams = new URLSearchParams(locationSearch);
  const requestedFloor =
    !navigation && !experience && locationParams.get("point") === selectedId
      ? locationParams.get("floor")
      : null;
  const nativeKey = JSON.stringify([
    agentContext,
    requestedFloor,
    navigation?.sequence,
    routeSelection.start,
    routeSelection.end,
    experience?.id,
    experience?.kind,
    locationParams.get("panorama"),
  ]);
  if (contextState.current.key !== nativeKey)
    contextState.current = {
      key: nativeKey,
      revision: contextState.current.revision + 1,
    };
  const nativeContext: GuideContext | null = catalog?.map
    ? {
        campus_id: catalog.campus.id,
        map_id: catalog.map.id,
        map_revision: catalog.map.revision,
        point_id: selected?.id ?? null,
        floor_id: requestedFloor,
        start_point_id: navigation ? routeSelection.start || null : null,
        revision: contextState.current.revision,
      }
    : null;
  function openNavigation(end = selectedId ?? "", start?: string | null) {
    cancelPlayback();
    setShowList(false);
    setShowHelp(false);
    setRoute(null);
    setPickMode(null);
    setRouteSelection({ start: start ?? "", end, availablePointIds: [] });
    setNavigation((v) => ({ sequence: (v?.sequence ?? 0) + 1, end, start }));
  }
  function openExperience(
    kind?: "media" | "checkin" | "tour",
    pointId?: string,
    id?: string,
  ) {
    cancelPlayback();
    const next = { kind, pointId, id };
    setExperience(next);
    writeLocation(experienceLocation(window.location.href, next));
    setNavigation(null);
    setRoute(null);
    setPickMode(null);
    setShowList(false);
    setShowHelp(false);
  }
  function applyGuideAction(
    action: GuideAction,
    options?: GuideActionOptions,
  ): boolean {
    if (
      !catalogRef.current?.points.some(
        (p) => p.id === action.point_id && p.revision === action.point_revision,
      )
    )
      return false;
    if (action.type === "play_video") {
      const video = experienceCatalogRef.current.find(
        (item) => item.id === action.resource_id,
      );
      if (
        !video ||
        video.revision !== action.resource_revision ||
        video.content.kind !== "media" ||
        video.content.media_type !== "video" ||
        video.content.point_id !== action.point_id
      )
        return false;
    }
    cancelPlayback();
    if (action.type === "open_vr") {
      // VR is a layer above the current visit. Keep the navigation panel and
      // tour progress mounted; closing the viewer returns to the same visit.
      setShowHelp(false);
      selectedRef.current = action.point_id;
      setSelectedId(action.point_id);
      writeLocation(actionLocation(window.location.href, action));
      return true;
    }
    if (action.type === "show_route") {
      selectPoint(action.point_id, Boolean(experience));
      openNavigation(action.point_id, action.start_point_id);
      return true;
    }
    if (["show_checkin", "play_video", "show_tour"].includes(action.type)) {
      selectPoint(action.point_id);
      openExperience(
        action.type === "show_tour"
          ? "tour"
          : action.type === "show_checkin"
            ? "checkin"
            : "media",
        action.type === "show_tour" ? undefined : action.point_id,
        action.resource_id ?? undefined,
      );
      if (action.type === "play_video" && options?.requestedPlayback) {
        const controller = new AbortController();
        playbackController.current = controller;
        setPlaybackRequest({
          id: ++playbackSequence.current,
          resourceId: action.resource_id!,
          revision: action.resource_revision!,
          pointId: action.point_id,
          pointRevision: action.point_revision,
          signal: controller.signal,
        });
      }
      return true;
    }
    setExperience(null);
    setPickMode(null);
    setNavigation(null);
    setRoute(null);
    selectedRef.current = action.point_id;
    setSelectedId(action.point_id);
    setShowList(false);
    writeLocation(
      actionLocation(experienceLocation(window.location.href, null), action),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  }
  const playbackVideo =
    playbackRequest &&
    experienceCatalog.find((item) => item.id === playbackRequest.resourceId);
  // Gate the child during rendering too: its playback effect may run before
  // this parent's invalidation effect after a publication refresh.
  const currentPlaybackRequest =
    playbackRequest &&
    !playbackRequest.signal.aborted &&
    playbackVideo?.revision === playbackRequest.revision &&
    playbackVideo.content.kind === "media" &&
    catalog?.points.some(
      (point) =>
        point.id === playbackRequest.pointId &&
        point.revision === playbackRequest.pointRevision,
    )
      ? playbackRequest
      : null;
  useEffect(() => {
    if (playbackRequest && !currentPlaybackRequest) cancelPlayback();
  }, [playbackRequest, currentPlaybackRequest, cancelPlayback]);
  useEffect(() => {
    if (
      route &&
      (!catalog?.map ||
        route.segments.some(
          (s) =>
            s.map_revision !== catalog.map!.revision ||
            s.map_id !== catalog.map!.id,
        ))
    )
      setRoute(null);
  }, [catalog?.map, route]);
  function askAgent(
    floor?: Pick<AgentContext, "floor_id" | "floor_label" | "floor_section">,
  ) {
    setAgentRequest((before) => ({
      sequence: (before?.sequence ?? 0) + 1,
      context: safeContext({ ...agentContext, ...floor }),
    }));
  }
  const groups = categories.filter(
    (c) => c === "all" || points.some((p) => p.category === c),
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#map-main">
        跳到地图
      </a>
      <header className="app-header">
        <a className="brand" href="/" aria-label="Twin NKU 首页">
          <span className="brand-mark">
            N<span>·</span>
          </span>
          <span className="brand-name">
            Twin NKU<small>校园文化导览</small>
          </span>
        </a>
        <span className="header-campus">
          {catalog?.campus.name ?? "南开大学"}
        </span>
        {catalog?.map && (
          <nav className="campus-modes" aria-label="校园探索方式">
            <button
              className="navigation-entry"
              aria-pressed={!!navigation}
              onClick={() => openNavigation()}
            >
              <Icon name="pin" size={17} />
              路线导航
            </button>
            <button
              className="navigation-entry"
              aria-pressed={!!experience && !experience.pointId && !navigation}
              onClick={() => openExperience("tour")}
            >
              <Icon name="bookmark" size={17} />
              校园导览
            </button>
          </nav>
        )}
        <div className="explore-tools">
          <form
            className="place-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (filtered[0]) explorePoint(filtered[0].id);
            }}
          >
            <Icon name="search" size={20} />
            <label htmlFor="place-search" className="sr-only">
              搜索校园地点
            </label>
            <input
              id="place-search"
              ref={search}
              value={query}
              maxLength={120}
              placeholder="搜索地点，如图书馆"
              autoComplete="off"
              aria-controls="place-directory"
              aria-expanded={showList}
              onFocus={() => {
                setShowList(true);
                setShowHelp(false);
              }}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowList(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  document
                    .querySelector<HTMLButtonElement>("[data-place-result]")
                    ?.focus();
                }
                if (e.key === "Enter" && e.nativeEvent.isComposing)
                  e.preventDefault();
              }}
            />
            {query ? (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              >
                <Icon name="close" size={18} />
              </button>
            ) : (
              <kbd className="search-shortcut">/</kbd>
            )}
          </form>
          <button
            ref={browseButton}
            className="browse-button"
            aria-expanded={showList}
            aria-controls="place-directory"
            onClick={() => {
              setShowList((v) => !v);
              setShowHelp(false);
            }}
          >
            <Icon name="list" size={19} />
            <span>地点目录</span>
          </button>
        </div>
        <button
          ref={helpButton}
          className="icon-button help-button"
          aria-label="使用帮助与刷新"
          aria-expanded={showHelp}
          aria-controls="map-help"
          onClick={() => {
            setShowHelp((v) => !v);
            setShowList(false);
          }}
        >
          <Icon name="help" />
        </button>
        {showHelp && (
          <section className="help-popover" id="map-help" aria-label="使用帮助">
            <strong>从地图开始探索</strong>
            <p>
              拖动或双指缩放，点击图上已命名的地点。也可以搜索名称或展开目录。
            </p>
            <p>按 / 搜索，按 Esc 返回。楼层图可放大到原尺寸查看。</p>
            <p>
              在地点目录切换“我的收藏”或“最近浏览”，快速回到看过的地点。浏览器后退可恢复上一个地点或楼层。
            </p>
            <button
              className="refresh-button"
              onClick={() => refresh.current()}
              disabled={refreshing}
            >
              <Icon name="refresh" size={17} />
              {refreshing ? "正在刷新…" : "刷新已发布资料"}
            </button>
            {lastChecked && (
              <small>上次同步 {lastChecked.toLocaleTimeString("zh-CN")}</small>
            )}
          </section>
        )}
      </header>
      <main className="explorer">
        <h1 className="sr-only">南开大学津南校区文化导览</h1>
        <section
          className="map-stage"
          id="map-main"
          tabIndex={-1}
          aria-label="校园地图"
        >
          {catalog?.map && catalog.features ? (
            <MapCanvas
              info={catalog.map}
              features={catalog.features}
              points={points}
              selectedId={selectedId}
              onSelect={explorePoint}
              routeSegments={route?.segments ?? EMPTY_ROUTE_SEGMENTS}
              routePickMode={pickMode}
              routeStartId={navigation ? routeSelection.start : null}
              routeEndId={navigation ? routeSelection.end : null}
              routeAvailablePointIds={routeSelection.availablePointIds}
              onRoutePick={(id) =>
                setPickedPoint((value) => ({
                  sequence: (value?.sequence ?? 0) + 1,
                  id,
                }))
              }
              onRoutePickCancel={() => setPickMode(null)}
            />
          ) : (
            <div className="map-empty" role="status">
              <Icon name="pin" size={34} />
              <h2>
                {status === "loading"
                  ? "正在展开校园地图"
                  : status === "empty"
                    ? "校园地图正在准备"
                    : "暂时无法加载地图"}
              </h2>
              <p>
                {status === "empty"
                  ? "地图资料发布后，你可以在这里探索校园。"
                  : status === "loading"
                    ? "正在读取已发布资料…"
                    : "请检查网络连接后重试。"}
              </p>
              {status !== "loading" && (
                <button
                  className="primary-button"
                  onClick={() => refresh.current()}
                >
                  重新加载
                </button>
              )}
            </div>
          )}
          {showList && (
            <PlaceDirectory
              points={filtered}
              selectedId={selectedId}
              favorites={memory.places.favorites}
              recentCount={memory.places.recent.length}
              memoryOnly={memory.memoryOnly}
              query={query}
              category={category}
              groups={groups}
              scope={scope}
              status={status}
              onScope={setScope}
              onCategory={setCategory}
              onSelect={explorePoint}
              onFavorite={toggleFavorite}
              onClearRecent={() => memory.dispatch({ type: "clear-recent" })}
              onReset={() => {
                setQuery("");
                setCategory("all");
                setScope("all");
                search.current?.focus();
              }}
              onRetry={() => refresh.current()}
              onClose={closeList}
            />
          )}
          {placeMessage && (
            <div className="place-message" role="status">
              {placeMessage}
            </div>
          )}
          {selected && !showList && !navigation && !experience && (
            <PointDetails
              key={selected.id}
              point={selected}
              onClose={closeDetails}
              saved={memory.places.favorites.includes(selected.id)}
              onFavorite={() => toggleFavorite(selected.id)}
              onAsk={agentConfig?.enabled ? askAgent : undefined}
              onExperiences={
                experienceCatalog.some(
                  (item) =>
                    item.content.kind !== "tour" &&
                    item.content.point_id === selected.id,
                )
                  ? () => openExperience(undefined, selected.id)
                  : undefined
              }
            />
          )}
          {status === "error" && catalog && (
            <div className="tile-warning" role="status">
              更新暂不可用，正在显示上次读取的地图。
              <button onClick={() => refresh.current()}>重试</button>
            </div>
          )}
          {navigation && catalog?.map && (
            <NavigationPanel
              map={catalog.map}
              points={points}
              initial={navigation}
              onRoute={setRoute}
              pickMode={pickMode}
              pickedPoint={pickedPoint}
              onPickMode={setPickMode}
              onSelectionChange={setRouteSelection}
              onClose={() => {
                setNavigation(null);
                setRoute(null);
                setPickMode(null);
              }}
            />
          )}
          {experience && (
            <aside
              className="experience-sheet"
              hidden={!!navigation || showList}
              aria-label="校园影像与主题导览"
            >
              <ExperiencePanel
                campusId={catalog?.campus.id}
                campusName={catalog?.campus.name}
                pointId={experience.pointId}
                initialKind={experience.kind}
                initialExperienceId={experience.id}
                playbackRequest={currentPlaybackRequest}
                active={
                  !navigation &&
                  !showList &&
                  !new URLSearchParams(locationSearch).has("panorama")
                }
                onSelectPoint={selectExperiencePoint}
                pointNames={Object.fromEntries(
                  points.map((point) => [point.id, point.name]),
                )}
                onExperienceChange={(id) => {
                  cancelPlayback();
                  if (!experience || experience.id === id) return;
                  const next = { ...experience, id };
                  setExperience(next);
                  writeLocation(
                    experienceLocation(window.location.href, next),
                    id ? "push" : "replace",
                  );
                }}
                onMediaActiveChange={setMediaActive}
                onNavigateStop={(from, to) => openNavigation(to, from)}
                onClose={closeExperience}
              />
            </aside>
          )}
          {!selected &&
            !showList &&
            !navigation &&
            !experience &&
            catalog?.map && (
              <div className="map-hint">
                <Icon name="pin" size={17} />
                <span>点击图上地点，探索校园故事</span>
              </div>
            )}
        </section>
        <PanoramaOverlay />
        {agentConfig?.enabled && agentConfig.provider === "nk-genios-api" ? (
          <NativeAgentDock
            autoActions={agentConfig.auto_actions ?? true}
            current={nativeContext}
            request={agentRequest}
            pointName={selected?.name ?? ""}
            onAction={applyGuideAction}
            onCancelAction={cancelPlayback}
            onNavigate={() => openNavigation()}
            mediaActive={mediaActive}
          />
        ) : (
          <AgentDock
            config={agentConfig}
            current={agentContext}
            request={agentRequest}
          />
        )}
      </main>
    </div>
  );
}
