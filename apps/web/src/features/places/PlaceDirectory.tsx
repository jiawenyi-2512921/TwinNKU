import type { Point } from "../../shared/api/client";
import { Icon } from "../../shared/ui/Icon";
import { categoryLabels, pointIcon } from "../points/PointDetails";
import type { PlaceScope } from "./search";

const scopes: { id: PlaceScope; label: string; icon: string }[] = [
  { id: "all", label: "全部地点", icon: "list" },
  { id: "favorites", label: "我的收藏", icon: "bookmark" },
  { id: "recent", label: "最近浏览", icon: "clock" },
];

export function PlaceDirectory({
  points,
  selectedId,
  favorites,
  recentCount,
  query,
  category,
  groups,
  scope,
  status,
  memoryOnly,
  onScope,
  onCategory,
  onSelect,
  onFavorite,
  onClearRecent,
  onReset,
  onRetry,
  onClose,
}: {
  points: Point[];
  selectedId: string | null;
  favorites: readonly string[];
  recentCount: number;
  query: string;
  category: string;
  groups: readonly string[];
  scope: PlaceScope;
  status: "loading" | "ready" | "empty" | "error";
  memoryOnly: boolean;
  onScope: (scope: PlaceScope) => void;
  onCategory: (category: string) => void;
  onSelect: (id: string) => void;
  onFavorite: (id: string) => void;
  onClearRecent: () => void;
  onReset: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const hasFilter = Boolean(query.trim() || category !== "all");
  return (
    <aside
      id="place-directory"
      className="place-directory"
      aria-label="地点目录"
    >
      <header className="directory-heading">
        <div>
          <h2>{query.trim() ? "搜索结果" : "探索地点"}</h2>
          <span role="status">{points.length} 个地点</span>
        </div>
        <button
          className="icon-button"
          aria-label="收起地点目录"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="place-scopes" role="group" aria-label="地点列表范围">
        {scopes.map(({ id, label, icon }) => (
          <button
            key={id}
            aria-pressed={scope === id}
            onClick={() => onScope(id)}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
      </div>
      <div className="category-filters" aria-label="按地点类型筛选">
        {groups.map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            onClick={() => onCategory(c)}
          >
            {c === "all" ? "全部类型" : categoryLabels[c as Point["category"]]}
          </button>
        ))}
      </div>
      <div className="point-list-scroll">
        <ul className="point-list">
          {points.map((p) => (
            <li key={p.id} className="place-list-item">
              <button
                className={`point-row${selectedId === p.id ? " active" : ""}`}
                aria-pressed={selectedId === p.id}
                data-place-result
                onClick={() => onSelect(p.id)}
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
              <button
                className="icon-button save-place"
                aria-label={`${favorites.includes(p.id) ? "取消收藏" : "收藏"}${p.name}`}
                aria-pressed={favorites.includes(p.id)}
                onClick={() => onFavorite(p.id)}
              >
                <Icon name="bookmark" size={19} />
              </button>
            </li>
          ))}
        </ul>
        {(status === "ready" || status === "empty") && !points.length && (
          <div className="no-results">
            <strong>
              {hasFilter
                ? "没有匹配的地点"
                : scope === "favorites"
                  ? "还没有收藏地点"
                  : scope === "recent"
                    ? "还没有最近浏览"
                    : "地点资料正在准备"}
            </strong>
            <p>
              {hasFilter
                ? "试试其他名称，或查看全部地点。"
                : scope === "favorites"
                  ? "点击地点旁的收藏按钮，下次可以从这里找到它。"
                  : scope === "recent"
                    ? "打开地点详情后，这里会保留最近浏览的地点。"
                    : "审核发布后就可以开始探索。"}
            </p>
            {(hasFilter || scope !== "all") && (
              <button className="text-button" onClick={onReset}>
                查看全部地点
              </button>
            )}
          </div>
        )}
        {status === "loading" && (
          <p className="list-loading" role="status">
            <span className="spinner" /> 正在读取地点…
          </p>
        )}
        {status === "error" && (
          <div className="no-results" role="status">
            <p>
              {points.length
                ? "更新暂不可用，正在显示上次读取的地点。"
                : "暂时无法读取地点，请检查网络后重试。"}
            </p>
            <button className="text-button" onClick={onRetry}>
              重新加载地点
            </button>
          </div>
        )}
      </div>
      <footer className="directory-footer">
        <small>
          {memoryOnly
            ? "本次记录暂存于页面，关闭后不会保留。"
            : "收藏和最近浏览仅保存在此浏览器。"}
        </small>
        {scope === "recent" && (
          <button
            className="text-button"
            disabled={!recentCount}
            onClick={onClearRecent}
          >
            清空最近浏览
          </button>
        )}
      </footer>
    </aside>
  );
}
