import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
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
import { EnvironmentBanner } from "../shared/ui/EnvironmentBanner";
import {
  pointLocation,
  writeLocation,
  experienceLocation,
  readExperienceLocation,
  LOCATION_CHANGE_EVENT,
  type ExperienceSelection,
  readPublicPage,
  publicLocation,
  type PublicPage,
} from "../shared/navigation";
import { usePlaceMemory } from "../features/places/usePlaceMemory";
import { findPlaces, type PlaceScope } from "../features/places/search";
import { PlaceDirectory } from "../features/places/PlaceDirectory";
import { PanoramaDirectory } from "../features/places/PanoramaDirectory";
import { correctedDisplayName } from "../features/map/labelCorrections";
import type { AgentRequest } from "../features/agent/AgentDock";
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
  TourPlayer,
  TourResourceView,
  type TourNarration,
  type TourPosition,
  type VideoPlaybackRequest,
} from "../features/experiences/ExperiencePanel";
import type {
  Experience,
  TourMainView,
  TourResource,
} from "../features/experiences/types";
import {
  normalizeTourPosition,
  segmentsForStop,
} from "../features/experiences/segments";
import {
  ExhibitionHome,
  TourCatalog,
  TourOverview,
  VisitRecap,
  MyVisits,
  usePublicShowcase,
} from "../features/visit/Exhibition";
import { SceneStage } from "../features/visit/SceneStage";
import { VisitTransport } from "../features/visit/VisitTransport";
import { ShareVisit } from "../features/visit/ShareVisit";
import { TourNarrator } from "../features/visit/TourNarrator";
import { pauseTour } from "../features/visit/audioOwner";
import {
  currentTourStop,
  hasResourceLocation,
  isPublicMedia,
  isStopResource,
  readResourceLocation,
  resourceLocation,
  resourceOnlyTransition,
  sameVisit,
  sameResource,
  type ResourceLocation,
} from "../features/visit/resourceLocation";
import {
  readVisit,
  loadVisit,
  saveVisit,
  visitLink,
  type VisitSession,
  type VisitMode,
} from "../features/visit/session";

const MapCanvas = lazy(() =>
  import("../features/map/MapCanvas").then((module) => ({
    default: module.MapCanvas,
  })),
);
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
  const [publicPage, setPublicPage] = useState<PublicPage>(() =>
    readPublicPage(window.location.href),
  );
  const publicData = usePublicShowcase(publicPage);
  const agentConfig = useAgentConfig();
  const [showHome, setShowHome] = useState(
    () =>
      !new URLSearchParams(window.location.search).has("point") &&
      !readExperienceLocation(window.location.href),
  );
  const [visit, setVisit] = useState<VisitSession | null>(() =>
    readVisit(window.location.href),
  );
  const [visitMode, setVisitMode] = useState<VisitMode>(
    () =>
      readVisit(window.location.href)?.mode ??
      (new URLSearchParams(window.location.search).get("mode") === "onsite"
        ? "onsite"
        : "online"),
  );
  const [handoff, setHandoff] = useState(() =>
    Boolean(readVisit(window.location.href)),
  );
  const [visitNotice, setVisitNotice] = useState("");
  const [narration, setNarration] = useState<TourNarration | null>(null);
  const [resourceLayer, setResourceLayer] = useState<ResourceLocation | null>(
    null,
  );
  const visitRef = useRef(visit);
  visitRef.current = visit;
  const [viewResource, setViewResource] =
    useState<GuideContext["resource"]>(null);
  const actionObservation = useRef<GuideAction | null>(null);
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
  const [experiencesLoaded, setExperiencesLoaded] = useState(false);
  const [experiencesError, setExperiencesError] = useState(false);
  const [experiencesRetry, setExperiencesRetry] = useState(0);
  const narrationSequence = useRef(0);
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
  const resourceReturn = useRef<HTMLButtonElement>(null),
    visitReading = useRef<HTMLElement>(null),
    wasResourceOpen = useRef(false);
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
  const [directoryMode, setDirectoryMode] = useState<"places" | "vr">("places");
  const [showHelp, setShowHelp] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const needsMap =
    publicPage.kind === "explore" ||
    publicPage.kind === "visit" ||
    publicPage.kind === "panoramas";
  const needsExperiences =
    needsMap ||
    publicPage.kind === "overview" ||
    publicPage.kind === "recap" ||
    publicPage.kind === "visits";
  const navigationAvailable =
    publicData.state === "ready" &&
    publicData.showcase?.capabilities.navigation === true;
  const navigationAvailableRef = useRef(navigationAvailable);
  navigationAvailableRef.current = navigationAvailable;
  useEffect(() => {
    if (!navigationAvailable) {
      if (navigation || route || pickMode)
        setPlaceMessage(
          publicData.state === "ready"
            ? "参考路径功能已暂停，旧路径与地图选点已清除。校园资料和主题导览仍可查看。"
            : "暂时无法确认导航配置，旧路径已清除。重新读取配置后可再次计算。",
        );
      setNavigation(null);
      setRoute(null);
      setPickMode(null);
      setPickedPoint(null);
    }
  }, [navigationAvailable]);
  const [stageView, setStageView] = useState<TourMainView>({ type: "map" });
  const [mapFocus, setMapFocus] = useState(0);
  const [sceneExpanded, setSceneExpanded] = useState(false);
  const visitControls = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(104);
  useEffect(() => {
    const element = visitControls.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight > 0) setControlsHeight(element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(visit), publicPage.kind]);
  const [visitLayout, setVisitLayout] = useState<
    "balanced" | "scene_first" | "reading_first" | null
  >(null);
  const pageHeading = useRef<HTMLDivElement>(null);
  const handoffDialog = useRef<HTMLDialogElement>(null);
  function navigatePublic(page: PublicPage, campusId?: string) {
    pauseTour();
    cancelPlayback();
    setNarration(null);
    setResourceLayer(null);
    setViewResource(null);
    setHandoff(false);
    setNavigation(null);
    setRoute(null);
    setPickMode(null);
    setShowList(false);
    setShowHelp(false);
    setShowHome(page.kind === "home");
    setPublicPage(page);
    if ("tourId" in page) setExperience({ kind: "tour", id: page.tourId });
    else {
      setExperience(null);
      setVisit(null);
    }
    writeLocation(
      publicLocation(
        window.location.href,
        page,
        campusId ?? publicData.campus?.id,
      ),
    );
    requestAnimationFrame(() => pageHeading.current?.focus());
  }
  function beginTour(
    tour: Experience,
    mode: VisitMode,
    start?: number,
    restart = false,
    requestedRecord?: VisitSession,
  ) {
    if (tour.content.kind !== "tour") return;
    const linked = requestedRecord ?? visitRef.current;
    const old = restart
      ? null
      : linked?.tourId === tour.id && linked.position.revision === tour.revision
        ? linked
        : loadVisit(tour.id, tour.revision);
    const index = Math.max(
      0,
      Math.min(
        tour.content.stops.length - 1,
        start ?? old?.position.stopIndex ?? 0,
      ),
    );
    const position = normalizeTourPosition(
      old?.position ?? {
        revision: tour.revision,
        stopIndex: index,
        segmentId: segmentsForStop(tour.content.stops[index], index)[0]?.id,
      },
      tour.revision,
      tour.content.stops,
    );
    const next: VisitSession = {
      ...old,
      ...(restart
        ? (() => {
            const saved = loadVisit(tour.id, tour.revision);
            return { notes: saved?.notes, collections: saved?.collections };
          })()
        : {}),
      tourId: tour.id,
      mode,
      position,
      paused: false,
    };
    pauseTour();
    cancelPlayback();
    setNarration(null);
    setResourceLayer(null);
    setViewResource(null);
    setVisit(next);
    visitRef.current = next;
    setVisitMode(mode);
    setHandoff(false);
    setVisitNotice("");
    if (!saveVisit(next))
      setVisitNotice("浏览器未允许保存进度，当前参观仍可继续。");
    setExperience({ kind: "tour", id: tour.id });
    setPublicPage({ kind: "visit", tourId: tour.id });
    setShowHome(false);
    setStageView(
      segmentsForStop(
        tour.content.stops[position.stopIndex],
        position.stopIndex,
      ).find((segment) => segment.id === position.segmentId)?.main_view ?? {
        type: "map",
      },
    );
    setSelectedId(tour.content.stops[position.stopIndex].point_id);
    selectedRef.current = tour.content.stops[position.stopIndex].point_id;
    const requestedResource =
      !restart && handoff ? readResourceLocation(window.location.href) : null;
    writeLocation(
      resourceLocation(
        visitLink(window.location.href, next),
        requestedResource,
        tour.content.stops[position.stopIndex].point_id,
      ),
      handoff ? "replace" : "push",
    );
  }
  function changeVisitRecord(change: (current: VisitSession) => VisitSession) {
    setVisit((current) => {
      if (!current) return current;
      const next = change(current);
      if (!saveVisit(next))
        setVisitNotice("当前记录无法保存在本设备，请保持页面打开。");
      return next;
    });
  }
  const selectPoint = useCallback(
    (
      id: string | null,
      preserveExperience = false,
      mode: "push" | "replace" = "push",
    ) => {
      setShowHome(false);
      cancelPlayback();
      selectedRef.current = id;
      setSelectedId(id);
      setShowList(false);
      setShowHelp(false);
      writeLocation(
        pointLocation(
          resourceLocation(window.location.href, null),
          id,
          preserveExperience,
        ),
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
    setHandoff(false);
    setNarration(null);
    setResourceLayer(null);
    setVisit(null);
    setViewResource(null);
    writeLocation(
      experienceLocation(resourceLocation(window.location.href, null), null),
      "replace",
    );
  }, [cancelPlayback]);
  const explorePoint = useCallback(
    (id: string | null) => {
      setNarration(null);
      setResourceLayer(null);
      setVisit(null);
      setViewResource(null);
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
    if (!needsMap || !publicData.campus) return;
    const chosenCampus = publicData.campus;
    const sync = createCatalogRefresh({
      load: (signal) =>
        loadCatalog(
          {
            ...api,
            campuses: async (s) => {
              const result = await api.campuses(s);
              return {
                ...result,
                data: result.data.filter((row) => row.id === chosenCampus.id),
              };
            },
          },
          signal,
        ),
      apply: (next) => {
        setCatalog((previous) => reconcileCatalog(previous, next));
        const retained = availableSelection(next, selectedRef.current);
        if (retained !== selectedRef.current) {
          cancelPlayback();
          pauseTour();
          setNarration(null);
          setResourceLayer(null);
          setViewResource(null);
          setVisit(null);
          setHandoff(false);
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
  }, [needsMap, publicData.campus?.id]);

  useEffect(() => {
    if (!needsExperiences || !publicData.campus?.id) return;
    const campusId = publicData.campus.id;
    setExperiencesLoaded(false);
    setExperiencesError(false);
    setExperienceCatalog([]);
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
          `/experiences?campus_id=${encodeURIComponent(campusId)}`,
          controller.signal,
        );
        if (!disposed && current === generation && !controller.signal.aborted) {
          setExperienceCatalog(result.data);
          setExperiencesLoaded(true);
          setExperiencesError(false);
        }
      } catch {
        if (!disposed && current === generation && !controller.signal.aborted)
          setExperiencesError(true);
      }
    };
    const stop = watchCatalogChanges(refreshExperiences);
    void refreshExperiences();
    return () => {
      disposed = true;
      pending?.abort();
      stop();
    };
  }, [publicData.campus?.id, needsExperiences, experiencesRetry]);

  useEffect(() => {
    let previousHref = window.location.href;
    function restoreLocation() {
      const page = readPublicPage(window.location.href);
      setPublicPage(page);
      setShowHome(page.kind === "home");
      cancelPlayback();
      pauseTour();
      const restoredVisit = readVisit(window.location.href);
      const resourceOnly =
        (resourceOnlyTransition(previousHref, window.location.href) ||
          previousHref === window.location.href) &&
        sameVisit(visitRef.current, restoredVisit);
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
      if (resourceOnly) {
        // Keep the live visit (including its audio bookmark) and mounted
        // narrator. The resource effect revalidates the public destination.
        setResourceLayer(null);
        setMediaActive(false);
        setShowList(false);
        setShowHelp(false);
        return;
      }
      if (overlayOnly) return;
      setExperience(readExperienceLocation(window.location.href));
      setVisit(restoredVisit);
      setResourceLayer(null);
      setNarration(null);
      setHandoff(Boolean(restoredVisit));
      if (restoredVisit) {
        setVisitMode(restoredVisit.mode);
        setShowHome(false);
      }
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
      const page = readPublicPage(window.location.href);
      setPublicPage(page);
      setShowHome(page.kind === "home");
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
        if (
          resourceLayer ||
          (visit && hasResourceLocation(window.location.href))
        ) {
          event.preventDefault();
          closeTourResource();
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
    resourceLayer,
  ]);

  const activeTour = experienceCatalog.find(
    (item) => item.id === experience?.id && item.content.kind === "tour",
  );
  const awaitingVersion = Boolean(
    visit && activeTour && visit.position.revision !== activeTour.revision,
  );
  useEffect(() => {
    const node = handoffDialog.current;
    if (
      publicPage.kind === "visit" &&
      (handoff || awaitingVersion) &&
      experience
    ) {
      if (node && !node.open) node.showModal();
    } else node?.close();
    return () => node?.close();
  }, [handoff, awaitingVersion, experience?.id, publicPage.kind]);
  useEffect(() => {
    if (publicPage.kind === "panoramas") {
      setDirectoryMode("vr");
      setShowList(true);
    }
  }, [publicPage.kind]);
  useEffect(() => {
    if (
      experiencesLoaded &&
      visit &&
      experience?.id === visit.tourId &&
      !activeTour
    ) {
      pauseTour();
      cancelPlayback();
      setNarration(null);
      setResourceLayer(null);
      setViewResource(null);
      setHandoff(true);
      writeLocation(resourceLocation(window.location.href, null), "replace");
      return;
    }
    if (
      !visit ||
      experience?.id !== visit.tourId ||
      !activeTour ||
      activeTour.content.kind !== "tour"
    )
      return;
    const position = normalizeTourPosition(
      visit.position,
      activeTour.revision,
      activeTour.content.stops,
    );
    if (
      position.revision === visit.position.revision &&
      position.stopIndex === visit.position.stopIndex &&
      position.segmentId === visit.position.segmentId
    )
      return;
    setNarration(null);
    setResourceLayer(null);
    setViewResource(null);
    setHandoff(true);
    setVisitNotice(
      "路线内容或参观位置已变化。旧版记录仍保留，请从当前路线目录明确选择开始位置。",
    );
  }, [activeTour, visit, experience?.id, experiencesLoaded]);

  useEffect(() => {
    if (!catalog || !experiencesLoaded) return;
    const href = window.location.href;
    const requested = readResourceLocation(href);
    const current = currentTourStop(experienceCatalog, visit);
    const restoreMain = () => {
      setResourceLayer(null);
      if (resourceLayer) setMediaActive(false);
      changeMainView(current?.segment.main_view ?? { type: "map" });
    };
    const reject = () => {
      cancelPlayback();
      restoreMain();
      if (hasResourceLocation(href)) {
        writeLocation(
          resourceLocation(href, null, current?.stop.point_id),
          "replace",
        );
        if (current) {
          selectedRef.current = current.stop.point_id;
          setSelectedId(current.stop.point_id);
        }
      }
    };
    if (!requested) {
      if (hasResourceLocation(href)) reject();
      else if (resourceLayer || current) restoreMain();
      return;
    }
    if (
      !current ||
      experience?.id !== visit?.tourId ||
      current.tour.campus_id !== catalog.campus.id ||
      !catalog.points.some((point) => point.id === requested.pointId)
    ) {
      reject();
      return;
    }
    const state = window.history.state;
    const publicAction =
      sameVisit(state?.twinnkuTourResourceReturn, visit) &&
      sameResource(state?.twinnkuTourResourcePublic, requested);
    if (!isStopResource(requested, experienceCatalog, visit) && !publicAction) {
      reject();
      return;
    }
    if (handoff) {
      restoreMain();
      return;
    }
    const controller = new AbortController();
    const accept = () => {
      if (controller.signal.aborted || window.location.href !== href) return;
      setResourceLayer((previous) =>
        previous &&
        previous.pointId === requested.pointId &&
        previous.resource.type === requested.resource.type &&
        previous.resource.id === requested.resource.id &&
        previous.resource.revision === requested.resource.revision
          ? previous
          : requested,
      );
      selectedRef.current = requested.pointId;
      setSelectedId(requested.pointId);
      setViewResource({
        kind: requested.resource.type,
        id: requested.resource.id,
        revision: requested.resource.revision,
      });
    };
    if (["image", "video", "checkin"].includes(requested.resource.type)) {
      // Public catalog verification also covers an AI resource belonging to
      // another point. Ordinary route clicks additionally require a stop ref.
      if (isPublicMedia(requested, experienceCatalog, catalog.campus.id))
        accept();
      else reject();
    } else {
      // Both route refs and AI floor/VR actions resolve via public endpoints;
      // never trust a history entry as proof that a resource remains published.
      setResourceLayer(null);
      const load =
        requested.resource.type === "floor"
          ? get<{ id: string; point_id: string; revision: number }>(
              `/floors/${requested.resource.id}`,
              controller.signal,
            ).then(
              ({ data }) =>
                data.id === requested.resource.id &&
                data.point_id === requested.pointId &&
                data.revision === requested.resource.revision,
            )
          : get<{ id: string; point_id: string; revision: number }[]>(
              `/points/${requested.pointId}/panoramas`,
              controller.signal,
            ).then(({ data }) =>
              data.some(
                (row) =>
                  row.id === requested.resource.id &&
                  row.point_id === requested.pointId &&
                  row.revision === requested.resource.revision,
              ),
            );
      void load
        .then((valid) => {
          if (controller.signal.aborted || window.location.href !== href)
            return;
          if (valid) accept();
          else reject();
        })
        .catch(() => {
          if (!controller.signal.aborted && window.location.href === href)
            reject();
        });
    }
    return () => controller.abort();
  }, [
    locationSearch,
    experienceCatalog,
    experiencesLoaded,
    catalog,
    experience?.id,
    visit?.tourId,
    visit?.position.revision,
    visit?.position.stopIndex,
    visit?.position.segmentId,
    handoff,
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
  const locatedPointIds =
    catalog?.map &&
    catalog.features?.map_id === catalog.map.id &&
    catalog.features.map_revision === catalog.map.revision
      ? catalog.features.points
          .filter(
            (feature) =>
              feature.map_id === catalog.map!.id &&
              feature.map_revision === catalog.map!.revision &&
              points.some((point) => point.id === feature.point_id),
          )
          .map((feature) => feature.point_id)
      : [];
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
  const resourcePending = Boolean(
    visit &&
      !handoff &&
      !resourceLayer &&
      readResourceLocation(window.location.href),
  );
  useEffect(() => {
    if (resourceLayer || resourcePending) {
      wasResourceOpen.current = true;
      requestAnimationFrame(() => resourceReturn.current?.focus());
    } else if (wasResourceOpen.current) {
      wasResourceOpen.current = false;
      requestAnimationFrame(() => visitReading.current?.focus());
    }
  }, [resourceLayer?.resource.id, resourcePending]);
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
    visit?.tourId,
    visit?.position,
    viewResource,
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
        visit:
          visit && experience?.id === visit.tourId
            ? {
                tour_id: visit.tourId,
                tour_revision: visit.position.revision,
                stop_index: visit.position.stopIndex,
                segment_id: visit.position.segmentId,
              }
            : null,
        resource: viewResource,
      }
    : null;
  function observeAction(
    result: "opened" | "playing" | "paused" | "ended" | "failed",
    resourceId?: string,
  ) {
    const action = actionObservation.current;
    if (!action || (resourceId && action.resource_id !== resourceId)) return;
    window.dispatchEvent(
      new CustomEvent("twinnku:action-receipt", {
        detail: {
          action_id: action.action_id,
          context_revision: action.context_revision,
          resource_id: action.resource_id,
          resource_revision: action.resource_revision,
          result,
        },
      }),
    );
  }
  function updateVisitPosition(position: TourPosition) {
    const id = experience?.id;
    if (!id) return;
    const same =
      visit?.tourId === id &&
      visit.position.revision === position.revision &&
      visit.position.stopIndex === position.stopIndex &&
      visit.position.segmentId === position.segmentId;
    if (same) return;
    if (visit?.tourId === id && visit.position.revision !== position.revision)
      setVisitNotice("路线已更新，将从新版第一站开始。请确认后继续参观。");
    setNarration(null);
    setResourceLayer(null);
    setViewResource(null);
    const next: VisitSession = {
      ...(visit?.tourId === id && visit.position.revision === position.revision
        ? visit
        : {}),
      tourId: id,
      position,
      mode: visitMode,
    };
    delete next.audio;
    setVisit(next);
    saveVisit(next);
    const url = new URL(resourceLocation(window.location.href, null));
    url.searchParams.set("revision", String(position.revision));
    url.searchParams.set("stop", String(position.stopIndex));
    url.searchParams.set("segment", position.segmentId);
    url.searchParams.set("mode", visitMode);
    const current = currentTourStop(experienceCatalogRef.current, next);
    if (current) {
      url.searchParams.set("point", current.stop.point_id);
      selectedRef.current = current.stop.point_id;
      setSelectedId(current.stop.point_id);
    }
    writeLocation(
      url.href,
      visit &&
        visit.tourId === id &&
        visit.position.revision === position.revision
        ? "push"
        : "replace",
    );
  }
  function changeMainView(view: TourMainView) {
    setStageView(view);
    setViewResource(
      view.type === "map"
        ? null
        : {
            kind: view.type === "vr_entry" ? "vr" : view.type,
            id: view.id,
            revision: view.revision,
          },
    );
  }
  function openTourResource(
    resource: TourResource,
    pointId: string,
    source: "route" | "public" = "route",
  ): boolean {
    const currentVisit = visitRef.current;
    const current = currentTourStop(experienceCatalogRef.current, currentVisit);
    const currentCatalog = catalogRef.current;
    const layer: ResourceLocation = {
      resource: {
        type: resource.type,
        id: resource.id,
        revision: resource.revision,
      },
      pointId,
    };
    if (
      !currentVisit ||
      !current ||
      handoff ||
      experience?.id !== currentVisit?.tourId ||
      !currentCatalog ||
      current.tour.campus_id !== currentCatalog.campus.id ||
      !currentCatalog.points.some((point) => point.id === pointId) ||
      (source === "route" &&
        !isStopResource(layer, experienceCatalogRef.current, currentVisit)) ||
      (["image", "video", "checkin"].includes(resource.type) &&
        !isPublicMedia(
          layer,
          experienceCatalogRef.current,
          currentCatalog.campus.id,
        ))
    )
      return false;
    const destination = resourceLocation(window.location.href, layer);
    if (!readResourceLocation(destination)) return false;
    pauseTour();
    const alreadyOpen = Boolean(readResourceLocation(window.location.href));
    if (!alreadyOpen)
      writeLocation(
        resourceLocation(window.location.href, null, current.stop.point_id),
        "replace",
      );
    writeLocation(destination, alreadyOpen ? "replace" : "push");
    const state = window.history.state;
    window.history.replaceState(
      {
        ...(state && typeof state === "object" ? state : {}),
        twinnkuTourResourceReturn: {
          tourId: currentVisit.tourId,
          position: {
            revision: currentVisit.position.revision,
            stopIndex: currentVisit.position.stopIndex,
            ...(currentVisit.position.segmentId
              ? { segmentId: currentVisit.position.segmentId }
              : {}),
          },
          mode: currentVisit.mode,
        },
        twinnkuTourResourcePublic: source === "public" ? layer : null,
      },
      "",
      window.location.href,
    );
    return true;
  }
  function closeTourResource() {
    cancelPlayback();
    setMediaActive(false);
    pauseTour();
    const current = currentTourStop(
      experienceCatalogRef.current,
      visitRef.current,
    );
    if (
      readResourceLocation(window.location.href) &&
      sameVisit(
        window.history.state?.twinnkuTourResourceReturn,
        visitRef.current,
      )
    ) {
      window.history.back();
    } else
      writeLocation(
        resourceLocation(window.location.href, null, current?.stop.point_id),
        "replace",
      );
  }
  function narrateTour(source: TourNarration) {
    window.dispatchEvent(new Event("twinnku:tour-prime"));
    setNarration({ ...source, requestId: ++narrationSequence.current });
  }
  function openNavigation(end = selectedId ?? "", start?: string | null) {
    if (!navigationAvailableRef.current) return;
    setPlaceMessage("");
    setShowHome(false);
    pauseTour();
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
    if (kind === "tour" && !pointId) {
      navigatePublic(id ? { kind: "overview", tourId: id } : { kind: "tours" });
      return;
    }
    setShowHome(false);
    pauseTour();
    cancelPlayback();
    const next = { kind, pointId, id };
    if (id !== experience?.id) {
      setNarration(null);
      setResourceLayer(null);
      setViewResource(null);
      setVisit(id ? loadVisit(id) : null);
    }
    setExperience(next);
    writeLocation(
      experienceLocation(resourceLocation(window.location.href, null), next),
    );
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
    if (action.type === "show_route" && !navigationAvailableRef.current)
      return false;
    if (
      !catalogRef.current?.points.some(
        (p) => p.id === action.point_id && p.revision === action.point_revision,
      )
    )
      return false;
    actionObservation.current = action;
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
      if (
        experience?.id &&
        visit?.tourId === experience.id &&
        action.type !== "show_tour"
      ) {
        const type = action.type === "play_video" ? "video" : "checkin";
        const opened = openTourResource(
          {
            type,
            id: action.resource_id!,
            revision: action.resource_revision!,
          },
          action.point_id,
          "public",
        );
        if (!opened) return false;
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
    if (experience?.id && visit?.tourId === experience.id) {
      if (
        action.type === "show_floor" &&
        action.resource_id &&
        action.resource_revision
      ) {
        return openTourResource(
          {
            type: "floor",
            id: action.resource_id,
            revision: action.resource_revision,
          },
          action.point_id,
          "public",
        );
      } else selectPoint(action.point_id, true);
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
      actionLocation(
        experienceLocation(resourceLocation(window.location.href, null), null),
        action,
      ),
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
  const orderedCategories = [
    ...new Set([
      "all",
      ...(publicData.showcase?.visit_defaults.map_categories ?? []),
      ...categories,
    ]),
  ];
  const groups = orderedCategories.filter(
    (c) => c === "all" || points.some((p) => p.category === c),
  );

  return (
    <div
      className={`app-shell public-${publicPage.kind} visit-layout-${visitLayout ?? publicData.showcase?.visit_defaults.layout ?? "balanced"}`}
      style={
        { "--visit-controls-height": `${controlsHeight}px` } as CSSProperties
      }
    >
      <a className="skip-link" href="#exhibition-main">
        跳到主要内容
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="/"
          aria-label="Twin NKU 首页"
          onClick={(event) => {
            event.preventDefault();
            navigatePublic({ kind: "home" });
          }}
        >
          <span className="brand-mark">
            N<span>·</span>
          </span>
          <span className="brand-name">
            {publicData.showcase?.presentation.site_name || "Twin NKU"}
            <small>校园文化展馆</small>
          </span>
        </a>
        <span className="header-campus">
          {publicData.campus?.name ?? "南开大学"}
        </span>
        {publicData.campuses.length > 1 && (
          <label className="campus-picker">
            <span className="sr-only">选择校区</span>
            <select
              value={publicData.campus?.id ?? ""}
              onChange={(event) =>
                navigatePublic(
                  { kind: needsMap ? "explore" : "tours" },
                  event.target.value,
                )
              }
            >
              {publicData.campuses.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {
          <nav className="campus-modes" aria-label="校园探索方式">
            <button
              className="navigation-entry"
              aria-pressed={publicPage.kind === "explore"}
              onClick={() => navigatePublic({ kind: "explore" })}
            >
              <Icon name="pin" size={17} />
              校园地图
            </button>
            <button
              className="navigation-entry"
              aria-pressed={publicPage.kind === "panoramas"}
              onClick={() => {
                navigatePublic({ kind: "panoramas" });
                setDirectoryMode("vr");
                setShowList(true);
              }}
            >
              <Icon name="pin" size={17} />
              VR 全景
            </button>
            <button
              className="navigation-entry"
              aria-pressed={["tours", "overview", "visit", "recap"].includes(
                publicPage.kind,
              )}
              onClick={() => navigatePublic({ kind: "tours" })}
            >
              <Icon name="bookmark" size={17} />
              主题导览
            </button>
            <button
              className="navigation-entry"
              aria-pressed={publicPage.kind === "visits"}
              onClick={() => navigatePublic({ kind: "visits" })}
            >
              我的参观
            </button>
          </nav>
        }
        <div className="explore-tools" hidden={!needsMap}>
          <form
            className="place-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (directoryMode === "places" && filtered[0])
                explorePoint(filtered[0].id);
              else
                document
                  .querySelector<HTMLButtonElement>(
                    "[data-place-result]:not(:disabled)",
                  )
                  ?.focus();
            }}
          >
            <Icon name="search" size={20} />
            <label htmlFor="place-search" className="sr-only">
              {directoryMode === "vr" ? "搜索 VR 全景" : "搜索校园地点"}
            </label>
            <input
              id="place-search"
              ref={search}
              value={query}
              maxLength={120}
              placeholder={
                directoryMode === "vr"
                  ? "搜索景点或场景编号"
                  : "搜索地点，如图书馆"
              }
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
                    .querySelector<HTMLButtonElement>(
                      "[data-place-result]:not(:disabled)",
                    )
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
      <EnvironmentBanner />
      <main className="explorer" id="exhibition-main" tabIndex={-1}>
        <div
          className="sr-only"
          ref={pageHeading}
          tabIndex={-1}
          role={needsMap ? "heading" : undefined}
          aria-level={needsMap ? 1 : undefined}
        >
          {publicPage.kind === "home"
            ? "校园文化展馆首页"
            : publicPage.kind === "tours"
              ? "主题路线目录"
              : publicPage.kind === "overview"
                ? "路线介绍"
                : publicPage.kind === "recap"
                  ? "参观回顾"
                  : publicPage.kind === "visits"
                    ? "我的参观"
                    : publicPage.kind === "visit"
                      ? "校园主题导览"
                      : publicPage.kind === "panoramas"
                        ? "校园VR全景目录"
                        : "校园地图探索"}
        </div>
        {!needsMap &&
          (publicData.state !== "ready" || !publicData.showcase ? (
            <section
              className="exhibition-status"
              role={publicData.state === "error" ? "alert" : "status"}
            >
              <h2>
                {publicData.state === "error"
                  ? "暂时无法读取校园展馆"
                  : "正在展开校园故事"}
              </h2>
              <p>
                {publicData.state === "error"
                  ? "请检查网络后重试，已保存的本设备记录不会被清除。"
                  : "正在核对已发布内容…"}
              </p>
              {publicData.state === "error" && (
                <button onClick={publicData.retry}>重新加载</button>
              )}
            </section>
          ) : (
            <>
              {publicPage.kind === "home" && (
                <ExhibitionHome
                  showcase={publicData.showcase}
                  campusName={publicData.campus?.name ?? "南开大学"}
                  onNavigate={navigatePublic}
                />
              )}
              {publicPage.kind === "tours" && (
                <TourCatalog
                  showcase={publicData.showcase}
                  onNavigate={navigatePublic}
                  initialMode={publicPage.mode ?? "online"}
                />
              )}
              {publicPage.kind === "visits" && (
                <MyVisits
                  showcase={publicData.showcase}
                  onNavigate={navigatePublic}
                  items={experienceCatalog}
                  onResume={(record) => {
                    const route = experienceCatalog.find(
                      (r) =>
                        r.id === record.tourId &&
                        r.revision === record.position.revision &&
                        r.content.kind === "tour",
                    );
                    if (route)
                      beginTour(
                        route,
                        record.mode,
                        record.position.stopIndex,
                        false,
                        record,
                      );
                  }}
                />
              )}
              {publicPage.kind === "overview" &&
                (activeTour ? (
                  <TourOverview
                    tour={activeTour}
                    showcase={publicData.showcase}
                    campusName={publicData.campus?.name ?? ""}
                    onBegin={beginTour}
                    onNavigate={navigatePublic}
                    initialMode={publicPage.mode ?? "online"}
                  />
                ) : (
                  <section className="exhibition-status" role="status">
                    <p>
                      {experiencesError
                        ? "暂时无法核对这条路线，请重试。"
                        : experiencesLoaded
                          ? "这条路线当前无法公开，请选择其他主题。"
                          : "正在读取路线介绍…"}
                    </p>
                    <button
                      onClick={() => {
                        setExperiencesRetry((v) => v + 1);
                      }}
                    >
                      重新核对
                    </button>
                    <button onClick={() => navigatePublic({ kind: "tours" })}>
                      全部主题路线
                    </button>
                  </section>
                ))}
              {publicPage.kind === "recap" &&
                (activeTour ? (
                  <VisitRecap
                    tour={activeTour}
                    record={loadVisit(activeTour.id, activeTour.revision)}
                    onNavigate={navigatePublic}
                  />
                ) : (
                  <p role="status">正在核对已发布路线…</p>
                ))}
            </>
          ))}
        {needsMap && publicData.state === "error" && (
          <div className="tile-warning" role="alert">
            公开内容核对失败。<button onClick={publicData.retry}>重试</button>
          </div>
        )}
        <section
          className={`map-stage ${sceneExpanded ? "scene-expanded" : ""}`}
          id="map-main"
          tabIndex={-1}
          aria-label="校园地图"
          hidden={!needsMap}
          inert={Boolean(resourceLayer || resourcePending)}
        >
          <SceneStage
            active={
              !resourceLayer &&
              !resourcePending &&
              !navigation &&
              !handoff &&
              !awaitingVersion &&
              !showList
            }
            onMediaActiveChange={setMediaActive}
            expanded={sceneExpanded}
            onExpand={
              publicPage.kind === "visit"
                ? () => setSceneExpanded((v) => !v)
                : undefined
            }
            view={
              publicPage.kind === "visit" &&
              activeTour &&
              !handoff &&
              !awaitingVersion
                ? stageView
                : { type: "map" }
            }
            pointId={
              currentTourStop(experienceCatalog, visit)?.stop.point_id ??
              selectedId ??
              ""
            }
            items={experienceCatalog}
            onMap={() => {
              changeMainView({ type: "map" });
              const id = currentTourStop(experienceCatalog, visit)?.stop
                .point_id;
              if (id) {
                selectedRef.current = id;
                setSelectedId(id);
              }
              setMapFocus((v) => v + 1);
            }}
            map={
              catalog?.map &&
              catalog.features &&
              needsMap &&
              catalog.campus.id === publicData.campus?.id ? (
                <Suspense fallback={<p role="status">正在加载地图查看器…</p>}>
                  <MapCanvas
                    focusToken={mapFocus}
                    detachedControls={publicPage.kind === "visit"}
                    info={catalog.map}
                    defaultView={
                      publicData.showcase?.visit_defaults.map_default_view ??
                      null
                    }
                    defaultsReady={publicData.state !== "loading"}
                    showRegions={
                      publicData.showcase?.visit_defaults.map_layers?.includes(
                        "point_regions",
                      ) ?? true
                    }
                    focusEffect={
                      publicData.showcase?.visit_defaults.map_focus_effect ??
                      "short"
                    }
                    showLabels={
                      publicData.showcase?.visit_defaults.map_show_labels ??
                      true
                    }
                    features={catalog.features}
                    points={points}
                    selectedId={selectedId}
                    onSelect={explorePoint}
                    onFocusResult={(id) => {
                      if (id === actionObservation.current?.point_id)
                        observeAction("opened");
                    }}
                    routeSegments={
                      navigationAvailable
                        ? (route?.segments ?? EMPTY_ROUTE_SEGMENTS)
                        : EMPTY_ROUTE_SEGMENTS
                    }
                    routePickMode={navigationAvailable ? pickMode : null}
                    routeStartId={
                      navigationAvailable && navigation
                        ? routeSelection.start
                        : null
                    }
                    routeEndId={
                      navigationAvailable && navigation
                        ? routeSelection.end
                        : null
                    }
                    routeAvailablePointIds={routeSelection.availablePointIds}
                    onRoutePick={(id) =>
                      setPickedPoint((value) => ({
                        sequence: (value?.sequence ?? 0) + 1,
                        id,
                      }))
                    }
                    onRoutePickCancel={() => setPickMode(null)}
                  />
                </Suspense>
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
              )
            }
          />
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
              mode={directoryMode}
              onMode={setDirectoryMode}
              panoramas={
                directoryMode === "vr" ? (
                  <PanoramaDirectory
                    campus={catalog?.campus ?? null}
                    campusStatus={status}
                    onRetryCampus={() => refresh.current()}
                    query={query}
                    locatedPointIds={locatedPointIds}
                    onLocate={(id) => {
                      if (!locatedPointIds.includes(id)) return;
                      setNavigation(null);
                      setRoute(null);
                      setPickMode(null);
                      explorePoint(id);
                    }}
                  />
                ) : undefined
              }
            />
          )}
          {needsMap && placeMessage && (
            <div className="place-message" role="status">
              {placeMessage}
              <button
                type="button"
                aria-label="关闭地点提示"
                onClick={() => setPlaceMessage("")}
              >
                关闭
              </button>
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
          {navigationAvailable && navigation && catalog?.map && (
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
          {experience && needsMap && !handoff && !awaitingVersion && (
            <aside
              className="experience-sheet"
              ref={visitReading}
              tabIndex={-1}
              hidden={
                !!navigation ||
                showList ||
                !!resourceLayer ||
                resourcePending ||
                showHome
              }
              aria-label="校园影像与主题导览"
              onPlay={() =>
                observeAction("playing", playbackRequest?.resourceId)
              }
              onPause={() =>
                observeAction("paused", playbackRequest?.resourceId)
              }
              onEnded={() =>
                observeAction("ended", playbackRequest?.resourceId)
              }
            >
              {publicPage.kind === "visit" && activeTour ? (
                <>
                  <div className="visit-topbar">
                    <button
                      onClick={() =>
                        navigatePublic({
                          kind: "overview",
                          tourId: activeTour.id,
                        })
                      }
                    >
                      ← 路线介绍
                    </button>
                    <strong>{activeTour.content.title}</strong>
                    <label>
                      <span className="sr-only">导览布局</span>
                      <select
                        value={
                          visitLayout ??
                          publicData.showcase?.visit_defaults.layout ??
                          "balanced"
                        }
                        onChange={(e) =>
                          setVisitLayout(
                            e.target.value as
                              | "balanced"
                              | "scene_first"
                              | "reading_first",
                          )
                        }
                      >
                        <option value="balanced">均衡</option>
                        <option value="scene_first">画面优先</option>
                        <option value="reading_first">阅读优先</option>
                      </select>
                    </label>
                  </div>
                  <TourPlayer
                    item={activeTour}
                    items={experienceCatalog}
                    immersive
                    active={
                      !navigation &&
                      !showList &&
                      !resourceLayer &&
                      !resourcePending &&
                      !locationParams.has("panorama")
                    }
                    onSelectPoint={(id) => {
                      selectExperiencePoint(id);
                      changeMainView({ type: "map" });
                    }}
                    pointNames={Object.fromEntries(
                      points.map((p) => [p.id, p.name]),
                    )}
                    position={
                      visit?.tourId === activeTour.id
                        ? {
                            ...visit.position,
                            segmentId: visit.position.segmentId ?? "",
                          }
                        : null
                    }
                    progress={
                      visit
                        ? {
                            revision: visit.position.revision,
                            index: visit.position.stopIndex,
                            segmentId: visit.position.segmentId,
                            completed: visit.completed ?? [],
                            skipped: visit.skipped ?? [],
                            paused: visit.paused ?? false,
                          }
                        : undefined
                    }
                    onPositionChange={updateVisitPosition}
                    onMainViewChange={changeMainView}
                    onResourceOpen={openTourResource}
                    onNarrate={narrateTour}
                    onNarrationStop={pauseTour}
                    onMediaActiveChange={setMediaActive}
                    onNavigateStop={
                      visitMode === "onsite" && navigationAvailable
                        ? (from, to) => openNavigation(to, from)
                        : undefined
                    }
                    onProgressChange={(p) =>
                      changeVisitRecord((v) => ({
                        ...v,
                        completed: p.completed,
                        skipped: p.skipped ?? [],
                        paused: p.paused,
                      }))
                    }
                    collections={visit?.collections}
                    onBookmark={(p, resourceId) => {
                      changeVisitRecord((v) => {
                        const row = {
                          segmentId: p.segmentId,
                          stopIndex: p.stopIndex,
                          ...(resourceId ? { resourceId } : {}),
                        };
                        const exists = v.collections?.some(
                          (c) =>
                            c.segmentId === row.segmentId &&
                            c.stopIndex === row.stopIndex &&
                            c.resourceId === resourceId,
                        );
                        return {
                          ...v,
                          collections: exists
                            ? v.collections?.filter(
                                (c) =>
                                  !(
                                    c.segmentId === row.segmentId &&
                                    c.stopIndex === row.stopIndex &&
                                    c.resourceId === resourceId
                                  ),
                              )
                            : [...(v.collections ?? []), row],
                        };
                      });
                      setVisitNotice("已更新本设备段落收藏。");
                    }}
                    notes={visit?.notes}
                    onNote={(id, text) =>
                      changeVisitRecord((v) => ({
                        ...v,
                        notes: { ...v.notes, [id]: text },
                      }))
                    }
                    onArrive={(index) =>
                      changeVisitRecord((v) => ({
                        ...v,
                        arrived: [...new Set([...(v.arrived ?? []), index])],
                      }))
                    }
                    onRecap={() =>
                      navigatePublic({ kind: "recap", tourId: activeTour.id })
                    }
                  />
                </>
              ) : (
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
                    !resourceLayer &&
                    !resourcePending &&
                    !showHome &&
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
                    setNarration(null);
                    setResourceLayer(null);
                    setViewResource(null);
                    setVisit(id ? loadVisit(id) : null);
                    setExperience(next);
                    writeLocation(
                      experienceLocation(
                        resourceLocation(window.location.href, null),
                        next,
                      ),
                      id ? "push" : "replace",
                    );
                  }}
                  onMediaActiveChange={setMediaActive}
                  onNavigateStop={
                    visitMode === "onsite" && navigationAvailable
                      ? (from, to) => openNavigation(to, from)
                      : undefined
                  }
                  position={
                    visit && visit.tourId === experience.id
                      ? {
                          ...visit.position,
                          segmentId: visit.position.segmentId ?? "",
                        }
                      : null
                  }
                  onPositionChange={updateVisitPosition}
                  onMainViewChange={changeMainView}
                  onResourceOpen={openTourResource}
                  onNarrate={narrateTour}
                  onNarrationStop={pauseTour}
                  onBookmark={() => {
                    if (visit) {
                      saveVisit(visit);
                      setVisitNotice("已在本设备保存当前参观位置。");
                    }
                  }}
                  onClose={closeExperience}
                />
              )}
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
        {(resourceLayer || resourcePending) && (
          <aside
            className="visit-resource-layer"
            aria-label="本站资料"
            onLoadCapture={() =>
              resourceLayer &&
              observeAction("opened", resourceLayer.resource.id)
            }
            onPlay={() => {
              setMediaActive(true);
              if (resourceLayer)
                observeAction("playing", resourceLayer.resource.id);
            }}
            onPause={() => {
              setMediaActive(false);
              if (resourceLayer)
                observeAction("paused", resourceLayer.resource.id);
            }}
            onEnded={() => {
              setMediaActive(false);
              if (resourceLayer)
                observeAction("ended", resourceLayer.resource.id);
            }}
            onErrorCapture={() =>
              resourceLayer &&
              observeAction("failed", resourceLayer.resource.id)
            }
          >
            <button
              ref={resourceReturn}
              className="visit-return"
              onClick={closeTourResource}
            >
              ← 返回本站讲解
            </button>
            {resourceLayer ? (
              <TourResourceView
                resource={resourceLayer.resource}
                pointId={resourceLayer.pointId}
                items={experienceCatalog}
                playbackRequest={currentPlaybackRequest}
                onMediaActiveChange={setMediaActive}
              />
            ) : (
              <p role="status">正在核对已发布资料…</p>
            )}
          </aside>
        )}
        {visit && (
          <div
            className="visit-controls"
            ref={visitControls}
            hidden={
              publicPage.kind !== "visit" ||
              showHome ||
              !!resourceLayer ||
              resourcePending ||
              !!navigation ||
              handoff ||
              awaitingVersion
            }
          >
            {visitNotice && <p role="status">{visitNotice}</p>}
            {publicPage.kind === "visit" &&
              activeTour &&
              currentTourStop(experienceCatalog, visit) && (
                <VisitTransport
                  tour={activeTour}
                  position={{
                    ...visit.position,
                    segmentId: visit.position.segmentId ?? "",
                  }}
                  hasNarration={!!narration}
                  onMove={updateVisitPosition}
                  onSkip={(next) => {
                    const index = visit.position.stopIndex;
                    if (next) updateVisitPosition(next);
                    changeVisitRecord((v) => ({
                      ...v,
                      skipped: v.completed?.includes(index)
                        ? v.skipped
                        : [...new Set([...(v.skipped ?? []), index])],
                    }));
                    if (!next)
                      navigatePublic({ kind: "recap", tourId: activeTour.id });
                  }}
                  onComplete={(next) => {
                    const index = visit.position.stopIndex;
                    if (next) updateVisitPosition(next);
                    changeVisitRecord((v) => ({
                      ...v,
                      completed: [...new Set([...(v.completed ?? []), index])],
                      skipped: v.skipped?.filter((i) => i !== index),
                    }));
                    if (!next)
                      navigatePublic({ kind: "recap", tourId: activeTour.id });
                  }}
                  onListen={() => {
                    const current = currentTourStop(experienceCatalog, visit);
                    if (current)
                      narrateTour({
                        tourId: activeTour.id,
                        tourRevision: activeTour.revision,
                        stopIndex: visit.position.stopIndex,
                        segmentId: current.stop.segments?.length
                          ? current.segment.id
                          : undefined,
                        text: current.segment.text,
                        sourceNote: current.segment.source_note,
                        narrationMode:
                          activeTour.content.kind === "tour"
                            ? activeTour.content.narration_mode
                            : "text",
                        assetId:
                          current.segment.narration_asset_id ?? undefined,
                      });
                  }}
                />
              )}
            <TourNarrator
              narration={narration}
              recordedAllowed={
                publicData.state === "ready" &&
                publicData.showcase?.capabilities.narration === true
              }
              initialBookmark={visit.audio}
              onStop={() => setNarration(null)}
              onBookmark={(audio) =>
                setVisit((current) => {
                  if (
                    !current ||
                    !narration ||
                    current.tourId !== narration.tourId ||
                    current.position.revision !== narration.tourRevision ||
                    current.position.stopIndex !== narration.stopIndex ||
                    (current.position.segmentId ??
                      `legacy-stop-${current.position.stopIndex + 1}`) !==
                      (narration.segmentId ??
                        `legacy-stop-${narration.stopIndex + 1}`)
                  )
                    return current;
                  const next = { ...current, audio };
                  saveVisit(next);
                  return next;
                })
              }
            />
            <ShareVisit session={visit} />
          </div>
        )}
        {publicPage.kind === "visit" &&
          (handoff || awaitingVersion) &&
          experience && (
            <dialog
              ref={handoffDialog}
              className="visit-handoff"
              role="dialog"
              aria-modal="true"
              aria-label="接续参观"
              onCancel={(event) => {
                event.preventDefault();
                setHandoff(false);
                closeExperience();
              }}
            >
              <strong>接续你的校园参观</strong>
              <p>
                将打开路线的第 {(visit?.position.stopIndex ?? 0) + 1}{" "}
                站。讲解由你点击开始。
              </p>
              {visitNotice && <p role="status">{visitNotice}</p>}
              {!activeTour && (
                <p role="status">
                  {experiencesLoaded
                    ? "这条路线暂未公开，仍可查看校园地图。"
                    : "正在读取已发布路线…"}
                </p>
              )}
              <button
                disabled={!activeTour || awaitingVersion}
                onClick={() => {
                  if (activeTour)
                    beginTour(activeTour, visitMode, undefined, false);
                }}
              >
                继续参观
              </button>
              {activeTour && (
                <button
                  onClick={() =>
                    navigatePublic({ kind: "overview", tourId: activeTour.id })
                  }
                >
                  查看新版目录并选择开始位置
                </button>
              )}
              <button
                onClick={() => {
                  setHandoff(false);
                  closeExperience();
                }}
              >
                返回校园地图
              </button>
            </dialog>
          )}
        {needsMap &&
        publicData.state === "ready" &&
        publicData.showcase?.capabilities.chat &&
        agentConfig?.enabled &&
        agentConfig.provider === "nk-genios-api" ? (
          <NativeAgentDock
            autoActions={agentConfig.auto_actions ?? true}
            publicEnabled={agentConfig.public_enabled ?? false}
            welcomeText={publicData.showcase?.visit_defaults.welcome_text}
            recommendedQuestions={
              publicData.showcase?.visit_defaults.recommended_questions
            }
            defaultMinimized={
              publicData.showcase?.visit_defaults.assistant_collapsed ?? true
            }
            current={nativeContext}
            request={agentRequest}
            pointName={selected?.name ?? ""}
            onAction={applyGuideAction}
            onCancelAction={cancelPlayback}
            onNavigate={
              navigationAvailable ? () => openNavigation() : undefined
            }
            mediaActive={mediaActive}
          />
        ) : null}
      </main>
    </div>
  );
}
