import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/api/client";
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
import { pointLocation, writeLocation } from "../shared/navigation";
import { usePlaceMemory } from "../features/places/usePlaceMemory";
import { findPlaces, type PlaceScope } from "../features/places/search";
import { PlaceDirectory } from "../features/places/PlaceDirectory";
import { MapCanvas } from "../features/map/MapCanvas";
import { AgentDock, type AgentRequest } from "../features/agent/AgentDock";
import { useAgentConfig } from "../features/agent/useAgentConfig";
import {
  EMPTY_CONTEXT,
  safeContext,
  type AgentContext,
} from "../features/agent/protocol";
import { PointDetails } from "../features/points/PointDetails";

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

export function App() {
  const agentConfig = useAgentConfig();
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
  const selectPoint = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
    setShowList(false);
    setShowHelp(false);
    writeLocation(pointLocation(window.location.href, id));
  }, []);
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
          selectedRef.current = retained;
          setSelectedId(retained);
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
      unwatch();
      sync.dispose();
    };
  }, []);

  useEffect(() => {
    function restoreLocation() {
      const requested = new URLSearchParams(window.location.search).get(
        "point",
      );
      const current = catalogRef.current;
      const id = current ? availableSelection(current, requested) : requested;
      selectedRef.current = id;
      setSelectedId(id);
      setShowList(false);
      setShowHelp(false);
      if (current && requested !== id) {
        writeLocation(pointLocation(window.location.href, id), "replace");
      }
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector("dialog[open]"))
        return;
      if (event.key === "Escape") {
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
  }, [showHelp, showList, closeDetails]);

  const points = catalog?.points ?? [];
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
        <span className="header-campus">南开大学 · 津南校区</span>
        <div className="explore-tools">
          <form
            className="place-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (filtered[0]) selectPoint(filtered[0].id);
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
              onSelect={selectPoint}
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
              onSelect={selectPoint}
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
          {selected && !showList && (
            <PointDetails
              key={selected.id}
              point={selected}
              onClose={closeDetails}
              saved={memory.places.favorites.includes(selected.id)}
              onFavorite={() => toggleFavorite(selected.id)}
              onAsk={agentConfig?.enabled ? askAgent : undefined}
            />
          )}
          {status === "error" && catalog && (
            <div className="tile-warning" role="status">
              更新暂不可用，正在显示上次读取的地图。
              <button onClick={() => refresh.current()}>重试</button>
            </div>
          )}
          {!selected && !showList && catalog?.map && (
            <div className="map-hint">
              <Icon name="pin" size={17} />
              <span>点击图上地点，探索校园故事</span>
            </div>
          )}
        </section>
        <AgentDock
          config={agentConfig}
          current={agentContext}
          request={agentRequest}
        />
      </main>
    </div>
  );
}
