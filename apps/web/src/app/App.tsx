import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Campus,
  type MapFeatures,
  type MapInfo,
  type Point,
} from "../shared/api/client";
import { Icon } from "../shared/ui/Icon";
import { MapCanvas } from "../features/map/MapCanvas";
import {
  PointDetails,
  categoryLabels,
  pointIcon,
} from "../features/points/PointDetails";

type Catalog = {
  campus: Campus;
  map: MapInfo | null;
  features: MapFeatures | null;
  points: Point[];
};
const categories = ["all", "academic", "public_area", "landscape"] as const;

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const selectPoint = useCallback((id: string | null) => {
    setSelectedId(id);
    setShowList(false);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("point", id);
    else url.searchParams.delete("point");
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    async function load() {
      const [system, campuses] = await Promise.all([
        api.status(controller.signal),
        api.campuses(controller.signal),
      ]);
      const campus =
        campuses.data.find((c) => c.id === "nku-jinnan") ?? campuses.data[0];
      if (!campus) {
        if (!controller.signal.aborted) {
          setCatalog(null);
          setStatus("empty");
        }
        return;
      }
      const maps = system.data.capabilities.map
        ? await api.maps(campus.id, controller.signal)
        : { data: [] };
      const map = maps.data.find((m) => m.kind === "campus" && m.tiles) ?? null;
      const [features, first] = await Promise.all([
        map
          ? api.mapFeatures(map.id, controller.signal)
          : Promise.resolve({ data: null }),
        api.points(campus.id, "", controller.signal),
      ]);
      if (
        map &&
        features.data &&
        (features.data.map_id !== map.id ||
          features.data.map_revision !== map.revision)
      )
        throw new Error("Map revision mismatch");
      const all = [...first.data];
      const total = first.meta.pagination?.total ?? first.data.length;
      for (let page = 2; all.length < total; page++) {
        const next = await api.points(campus.id, "", controller.signal, page);
        if (!next.data.length) break;
        all.push(...next.data);
      }
      if (controller.signal.aborted) return;
      const mapped = new Set(
        features.data?.points.map((p) => p.point_id) ?? [],
      );
      const points = all
        .filter((p) => !map || mapped.has(p.id))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      setCatalog({ campus, map, features: features.data, points });
      const requested = new URLSearchParams(window.location.search).get(
        "point",
      );
      setSelectedId(points.some((p) => p.id === requested) ? requested : null);
      setStatus(map ? "ready" : "empty");
    }
    load().catch(() => {
      if (!controller.signal.aborted) setStatus("error");
    });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        selectPoint(null);
        setShowHelp(false);
        setShowList(false);
      }
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectPoint]);

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
        <div className="header-campus">
          <span className="campus-indicator" /> 南开大学 <span>/</span> 津南校区
        </div>
        <button
          className={`help-button${showHelp ? " active" : ""}`}
          aria-expanded={showHelp}
          onClick={() => setShowHelp((v) => !v)}
        >
          <Icon name="help" size={18} />
          <span>使用帮助</span>
        </button>
        {showHelp && (
          <div className="help-popover">
            <strong>从地图开始探索</strong>
            <p>拖动或双指缩放地图，点击地点标记或左侧列表查看详情。</p>
            <p>使用“回到全图”恢复全景，按 Esc 关闭详情，按 / 搜索地点。</p>
          </div>
        )}
      </header>
      <main className="explorer">
        <aside
          className={`sidebar${showList ? " show-list" : ""}`}
          aria-label="地点搜索与列表"
        >
          <div className="sidebar-intro">
            <span className="eyebrow">EXPLORE JINNAN</span>
            <h1>
              从一个地方，
              <br />
              <em>走近南开。</em>
            </h1>
            <p>在校园的风景里，开启你的探索。</p>
          </div>
          <form
            className="place-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (filtered[0]) selectPoint(filtered[0].id);
            }}
          >
            <Icon name="search" size={19} />
            <label htmlFor="place-search" className="sr-only">
              搜索校园地点
            </label>
            <input
              id="place-search"
              ref={search}
              value={query}
              maxLength={120}
              placeholder="搜索地点，如图书馆"
              onChange={(e) => {
                setQuery(e.target.value);
                setShowList(true);
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
                <Icon name="close" size={15} />
              </button>
            ) : (
              <span className="search-shortcut">/</span>
            )}
          </form>
          <div className="category-filters" aria-label="按地点类型筛选">
            {groups.map((c) => (
              <button
                key={c}
                aria-pressed={category === c}
                className={category === c ? "selected" : ""}
                onClick={() => {
                  setCategory(c);
                  setShowList(true);
                }}
              >
                {c === "all" ? "全部" : categoryLabels[c]}
              </button>
            ))}
          </div>
          <div className="list-heading">
            <span>
              探索地点 <b>{filtered.length.toString().padStart(2, "0")}</b>
            </span>
            <button
              className="mobile-list-toggle"
              aria-expanded={showList}
              onClick={() => setShowList((v) => !v)}
            >
              <Icon name="list" size={16} />
              {showList ? "收起列表" : "展开列表"}
            </button>
            <span className="list-heading-hint">点击定位 ↗</span>
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
                    <span className={`point-symbol tone-${p.category}`}>
                      <Icon name={pointIcon(p)} size={22} />
                    </span>
                    <span className="point-row-text">
                      <strong>{p.name}</strong>
                      <small>{categoryLabels[p.category]}</small>
                    </span>
                    <span className="point-index">
                      {String(
                        points.findIndex((item) => item.id === p.id) + 1,
                      ).padStart(2, "0")}
                    </span>
                    <Icon name="arrow" size={15} />
                  </button>
                </li>
              ))}
            </ul>
            {status === "ready" && !filtered.length && (
              <div className="no-results">
                <Icon name="search" size={25} />
                <strong>没有找到这个地点</strong>
                <p>试试其他名称，或查看全部地点。</p>
                <button
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  查看全部地点
                </button>
              </div>
            )}
            {status === "loading" && (
              <div className="list-loading">
                <span className="spinner" /> 正在读取地点…
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="footer-monogram">NK</span>
            <div>
              一所大学，许多值得听的故事。
              <small>让每次探索，都成为与校园的相遇。</small>
            </div>
          </div>
        </aside>
        <section
          className="map-stage"
          id="map-main"
          tabIndex={-1}
          aria-label="校园地图"
        >
          {catalog?.map && catalog.features ? (
            <>
              <MapCanvas
                info={catalog.map}
                features={catalog.features}
                points={points}
                selectedId={selectedId}
                onSelect={selectPoint}
              />
            </>
          ) : (
            <div className="map-empty">
              <span className="empty-map-icon">
                <Icon name="pin" size={36} />
              </span>
              <span className="eyebrow">TWIN NKU · JINNAN</span>
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
                    ? "你的下一站，即将呈现。"
                    : "请检查网络连接后重试。"}
              </p>
              {status !== "loading" && (
                <button
                  className="primary-button"
                  onClick={() => setRetry((r) => r + 1)}
                >
                  重新加载
                </button>
              )}
            </div>
          )}
          {selected && (
            <PointDetails
              point={selected}
              index={points.findIndex((p) => p.id === selected.id)}
              onClose={() => selectPoint(null)}
            />
          )}
          {status === "error" && catalog && (
            <div className="tile-warning" role="status">
              连接暂不可用{" "}
              <button onClick={() => setRetry((r) => r + 1)}>重试</button>
            </div>
          )}
          {!selected && catalog?.map && (
            <div className="map-hint">
              <Icon name="pin" size={17} />
              <span>点击地点，发现校园</span>
              <span className="hint-key">拖动 · 缩放</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
