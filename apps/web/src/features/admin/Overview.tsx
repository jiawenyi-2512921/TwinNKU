import { Icon } from "../../shared/ui/Icon";
import type { ChangeItem, Result, StaffSession, Workbench } from "./api";
import { ChangeRows, type ReviewStart, kindNames } from "./ReviewCenter";
import { Empty, ErrorBox, useResource } from "./ui";
import type { Campus } from "../../shared/api/client";
import { WorkspaceIssues, type IssueTarget } from "./WorkspaceIssues";

export function Overview({
  session,
  revision,
  stats,
  error,
  loading,
  onRefresh,
  onReview,
  onNavigate,
  campuses,
  onOpenIssue,
  onReviewIssue,
}: {
  session: StaffSession;
  revision: number;
  stats: Result<Workbench> | null;
  error: string;
  loading: boolean;
  campuses?: Campus[];
  onOpenIssue: (target: IssueTarget) => void;
  onReviewIssue: (target: IssueTarget) => void;
  onRefresh: () => void;
  onReview: (start?: ReviewStart) => void;
  onNavigate: (
    tab:
      | "points"
      | "resources"
      | "tours"
      | "configurations"
      | "guide-settings"
      | "imports",
  ) => void;
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
      {session.permissions.includes("points.edit") && (
        <button onClick={() => onNavigate("imports")}>
          通过 CSV／XLSX 整理私有草稿
        </button>
      )}
      <details className="ad-card ad-config-actions">
        <summary>第一次维护 · 六步交接指南</summary>
        <ol>
          <li>
            <strong>核对真实地点与资料。</strong>地图锚点、楼层和室外 VR
            归属先对应实际校园地点；导航长度和无障碍通行需现场核验。
            <button onClick={() => onNavigate("resources")}>
              打开资料中心
            </button>
          </li>
          <li>
            <strong>建立主题路线。</strong>
            选择校区与真实站点，填写导语和来源；不需要懂代码。
            <button onClick={() => onNavigate("tours")}>
              打开六步路线编辑
            </button>
          </li>
          <li>
            <strong>编排每段画面。</strong>选择本站已发布地图、图片、楼层或
            VR，填写讲稿、观察提示和回顾收获；原素材不修改。
          </li>
          <li>
            <strong>明确生成与试听音频。</strong>
            仅正式生成／重试会调用供应商，听完再采用。纯图文路线可明确选择图文模式。
          </li>
          <li>
            <strong>编排首页并检查。</strong>
            明确选择主视觉和推荐路线，使用电脑／手机预览，修复版本依赖报告。
            {session.permissions.some((p) =>
              ["configurations.edit", "configurations.review"].includes(p),
            ) && (
              <button onClick={() => onNavigate("configurations")}>
                打开页面编排
              </button>
            )}
          </li>
          <li>
            <strong>交给独立成员审核并真机走查。</strong>
            审核中心核对来源、版本和预览；手机音频、VR原站、校园现场通行须实际确认。
            <button onClick={() => onReview()}>打开统一审核中心</button>
          </li>
        </ol>
        <p>
          后台只展示当前账号授权范围。未保存输入保留在本页，遇冲突先比较；历史恢复建立新草稿，不恢复旧批准或已暂停服务。
        </p>
      </details>
      <div className="ad-stats">
        {[
          {
            name: "待审核",
            value: data?.pending_count,
            hint: "全部资料、导览和路网统一汇总",
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
              detail="所有资料、校园导览和路网提交后都会在这里汇总。"
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
      <WorkspaceIssues
        session={session}
        campuses={campuses}
        revision={revision}
        onOpen={onOpenIssue}
        onReview={onReviewIssue}
      />
    </section>
  );
}
