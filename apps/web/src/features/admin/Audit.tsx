import { useState } from "react";
import { type AuditEvent } from "./api";
import { Empty, ErrorBox, Pager, timestamp, useResource } from "./ui";
const names: Record<string, string> = {
  "point.draft_saved": "保存草稿",
  "point.submit": "提交审核",
  "point.discard": "撤回修改",
  "point.reject": "退回修改",
  "point.published": "发布点位",
  "point.retire_requested": "申请下架",
  "point.retired": "下架点位",
  "user.created": "创建成员",
  "user.updated": "更新账号权限",
  "user.password_changed": "修改本人密码",
  "user.bootstrap": "初始化管理员",
  "session.login": "登录后台",
  "session.logout": "退出登录",
};
export function Audit() {
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const rows = useResource<AuditEvent[]>(
    `/audit?page=${page}&page_size=25`,
    revision,
  );
  return (
    <section>
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">ACTIVITY LOG</div>
          <h1>操作记录</h1>
          <p>记录谁在什么时候进行了修改，以及变更前后的内容。</p>
        </div>
        <button onClick={() => setRevision((v) => v + 1)}>刷新记录</button>
      </div>
      <ErrorBox text={rows.error} onRetry={() => setRevision((v) => v + 1)} />
      <div className="ad-card ad-audit">
        {rows.loading && <p role="status">正在读取操作记录…</p>}
        {rows.data?.data.map((row) => (
          <article className="ad-audit-row" key={row.id}>
            <span className="ad-audit-mark" aria-hidden="true">
              {row.action.includes("published") ? "✓" : "•"}
            </span>
            <div>
              <div className="ad-audit-title">
                <strong>{names[row.action] ?? row.action}</strong>
                <time dateTime={row.created_at}>
                  {timestamp(row.created_at)}
                </time>
              </div>
              <p>
                {row.actor_name}
                {row.note ? ` · ${row.note}` : ""}
              </p>
              {row.point_id && <small>点位 {row.point_id}</small>}
              {Object.keys(row.details).length > 0 && (
                <details>
                  <summary>查看变更记录</summary>
                  <pre>{JSON.stringify(row.details, null, 2)}</pre>
                </details>
              )}
            </div>
          </article>
        ))}
        {rows.data && !rows.data.data.length && (
          <Empty title="当前范围暂无操作记录" />
        )}
        <Pager page={rows.data?.meta.pagination} onChange={setPage} />
      </div>
    </section>
  );
}
