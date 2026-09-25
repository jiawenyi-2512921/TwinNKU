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
import { pointLocation } from "../shared/navigation";
import { MapCanvas } from "../features/map/MapCanvas";
import { AgentDock, type AgentRequest } from "../features/agent/AgentDock";
import { useAgentConfig } from "../features/agent/useAgentConfig";
import {
  EMPTY_CONTEXT,
  safeContext,
  type AgentContext,
} from "../features/agent/protocol";
import {
  PointDetails,
  categoryLabels,
  pointIcon,
} from "../features/points/PointDetails";

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
    window.history.replaceState(
      window.history.state,
      "",
      pointLocation(window.location.href, id),
    );
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
        if (retained !== selectedRef.current) selectPoint(retained);
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
  }, [selectPoint]);

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
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return points.filter(
      (p) =>
        (category === "all" || p.category === category) &&
        [p.name, ...p.aliases].some((s) => s.toLocaleLowerCase().includes(q)),
    );
  }, [points, query, category]);
  const selected = points.find((p) => p.id === selectedId);
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
              onFocus={() => {
                setShowList(true);
                setShowHelp(false);
              }}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowList(true);
              }}
              onKeyDown={(e) => {
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
            <aside
              id="place-directory"
              className="place-directory"
              aria-label="地点目录"
            >
              <header className="directory-heading">
                <div>
                  <h2>{query.trim() ? "搜索结果" : "探索地点"}</h2>
                  <span role="status">{filtered.length} 个地点</span>
                </div>
                <button
                  className="icon-button"
                  aria-label="收起地点目录"
                  onClick={closeList}
                >
                  <Icon name="close" />
                </button>
              </header>
              <div className="category-filters" aria-label="按地点类型筛选">
                {groups.map((c) => (
                  <button
                    key={c}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                  >
                    {c === "all" ? "全部" : categoryLabels[c]}
                  </button>
                ))}
              </div>
              <div className="point-list-scroll">
                <ul className="point-list">
                  {filtered.map((p) => (
                    <li key={p.id}>
                      <button
                        className={`point-row${selectedId === p.id ? " active" : ""}`}
                        aria-pressed={selectedId === p.id}
                        onClick={() => selectPoint(p.id)}
                      >
                        <span className="point-symbol">
                          <Icon name={pointIcon(p)} size={21} />
                        </span>
                        <span className="point-row-text">
                          <strong>{p.name}</strong>
                          <small>{categoryLabels[p.category]}</small>
                        </span>
                        <Icon name="arrow" size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
                {status === "ready" && !filtered.length && (
                  <div className="no-results">
                    <strong>没有找到这个地点</strong>
                    <p>试试其他名称，或清除分类筛选。</p>
                    <button
                      className="text-button"
                      onClick={() => {
                        setQuery("");
                        setCategory("all");
                        search.current?.focus();
                      }}
                    >
                      查看全部地点
                    </button>
                  </div>
                )}
                {status === "loading" && (
                  <p className="list-loading" role="status">
                    <span className="spinner" /> 正在读取地点…
                  </p>
                )}
              </div>
            </aside>
          )}
          {selected && !showList && (
            <PointDetails
              key={selected.id}
              point={selected}
              onClose={closeDetails}
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
