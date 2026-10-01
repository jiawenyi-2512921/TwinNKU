import { Icon } from "../../shared/ui/Icon";
import type { ChangeItem, Result, StaffSession, Workbench } from "./api";
import { ChangeRows, type ReviewStart, kindNames } from "./ReviewCenter";
import { Empty, ErrorBox, useResource } from "./ui";

export function Overview({
  session,
  revision,
  stats,
  error,
  loading,
  onRefresh,
  onReview,
  onNavigate,
}: {
  session: StaffSession;
  revision: number;
  stats: Result<Workbench> | null;
  error: string;
  loading: boolean;
  onRefresh: () => void;
  onReview: (start?: ReviewStart) => void;
  onNavigate: (tab: "points" | "resources") => void;
}) {
  const pending = useResource<ChangeItem[]>(
    "/changes?page_size=5&state=in_review",
    revision,
  );
  const data = stats?.data;
  return (
    <section className="ad-dashboard">
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">YOUR CONTENT WORKSPACE</div>
          <h1>{session.user.display_name}，欢迎回来</h1>
          <p>先处理待办，再让校园内容变得更完整。</p>
        </div>
        <button onClick={onRefresh} disabled={loading}>
          <Icon name="refresh" size={16} />
          刷新工作台
        </button>
      </div>
      <ErrorBox text={error || pending.error} onRetry={onRefresh} />
      <div className="ad-stats">
        {[
          {
            name: "待审核",
            value: data?.pending_count,
            hint: "点位、楼层和 VR 统一汇总",
            icon: "check",
            state: "in_review" as const,
          },
          {
            name: "编辑中的草稿",
            value: data?.draft_count,
            hint: "继续完善后提交审核",
            icon: "edit",
            state: "draft" as const,
          },
          {
            name: "需要修改",
            value: data?.rejected_count,
            hint: "查看审核意见并补充资料",
            icon: "refresh",
            state: "rejected" as const,
          },
        ].map((item) => (
          <button
            className={`ad-stat ad-stat-button ${item.state}`}
            key={item.name}
            onClick={() => onReview({ state: item.state })}
          >
            <span>
              {item.name}
              <Icon name={item.icon} />
            </span>
            <strong>{item.value ?? "—"}</strong>
            <small>
              {item.hint}
              <Icon name="arrow" size={14} />
            </small>
          </button>
        ))}
        <button
          className="ad-stat ad-stat-button"
          onClick={() => onNavigate("points")}
        >
          <span>
            管理的点位
            <Icon name="pin" />
          </span>
          <strong>{data?.point_count ?? "—"}</strong>
          <small>
            当前账号可查看的地点
            <Icon name="arrow" size={14} />
          </small>
        </button>
      </div>
      <div className="ad-dashboard-columns">
        <section className="ad-card ad-inbox-card">
          <div className="ad-card-heading ad-card-padding">
            <div>
              <h2>待办收件箱</h2>
              <p>按提交时间排列，点击即可核对资料。</p>
            </div>
            <button onClick={() => onReview()}>查看全部 →</button>
          </div>
          <div className="ad-kind-totals">
            {Object.entries(kindNames).map(([kind, title]) => (
              <span key={kind}>
                {title}
                <strong>{data?.pending_by_kind[kind] ?? "—"}</strong>
              </span>
            ))}
          </div>
          {pending.loading && (
            <p className="ad-list-loading" role="status">
              正在读取待办…
            </p>
          )}
          {pending.data && (
            <ChangeRows
              rows={pending.data.data}
              onOpen={(item) => onReview({ item })}
            />
          )}
          {pending.data && !pending.data.data.length && (
            <Empty
              title="现在没有待审核事项"
              detail="提交后的点位、楼层和 VR 资料会在这里汇总。"
            />
          )}
        </section>
        <aside className="ad-dashboard-aside">
          <div className="ad-card ad-studio-card">
            <div className="ad-eyebrow">CONTENT STUDIO</div>
            <h2>
              让校园的每个细节
              <br />
              都有清晰的入口。
            </h2>
            <p>
              维护标注楼层图与全景资料，使用全局目录快速找到需要更新的内容。
            </p>
            <button
              className="ad-primary"
              onClick={() => onNavigate("resources")}
            >
              <Icon name="layers" size={17} />
              打开资料中心
            </button>
            <div className="ad-studio-orbit" aria-hidden="true">
              <Icon name="building" size={54} />
            </div>
          </div>
          <div className="ad-card ad-scope-card">
            <Icon name="shield" />
            <h3>协作范围</h3>
            <p>
              {session.user.role === "admin"
                ? "管理全部校区与点位"
                : `${session.user.campus_ids.length} 个校区 · ${session.user.point_ids.length ? `${session.user.point_ids.length} 个指定点位` : "校区内全部点位"}`}
            </p>
            <small>我参与的待审资料：{data?.my_pending_count ?? "—"} 项</small>
            <div className="ad-workflow-mini">
              <span>编辑</span>
              <Icon name="arrow" size={12} />
              <span>独立审核</span>
              <Icon name="arrow" size={12} />
              <span>公开展示</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
