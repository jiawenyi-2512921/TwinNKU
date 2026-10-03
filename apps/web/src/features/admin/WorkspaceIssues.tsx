import { useEffect, useRef, useState } from "react";
import type { components } from "../../shared/api/schema";
import type { Campus } from "../../shared/api/client";
import { message, request, stateNames, type StaffSession } from "./api";
import type { HelpPage } from "./HelpPanel";
import { ErrorBox } from "./ui";
import "./issues.css";

export type WorkbenchIssue = components["schemas"]["WorkbenchIssue"];
type IssueBatch = components["schemas"]["WorkbenchIssueBatch"];
type EntityType = WorkbenchIssue["entity_type"];
export type IssueTarget = {
  issue: WorkbenchIssue;
  page: HelpPage;
  revision: number;
  publishedRevision: number;
  changed: boolean;
};
const entityNames: Record<EntityType, string> = {
  point: "地图点位",
  floor: "楼层",
  vr: "VR 全景",
  media: "图片与视频",
  checkin: "打卡",
  tour: "导览路线",
  navigation: "道路路网",
  configuration: "页面与运行配置",
};
const actionNames: Partial<Record<WorkbenchIssue["actions"][number], string>> =
  {
    edit: "打开编辑器",
    review: "进入独立审核",
    withdraw: "查看撤回操作",
    regenerate_audio: "定位讲解音频",
    replace_reference: "定位素材引用",
  };

export function locateTourIssue(
  content: components["schemas"]["ExperienceTourContent"],
  issue: WorkbenchIssue,
  identity: { id: string; revision: number; published_revision: number },
) {
  if (
    issue.entity_type !== "tour" ||
    issue.entity_id !== identity.id ||
    issue.revision !== identity.revision ||
    issue.published_revision !== identity.published_revision
  )
    return null;
  const stopIndex = issue.stop_index;
  if (
    stopIndex == null ||
    !Number.isSafeInteger(stopIndex) ||
    stopIndex < 0 ||
    stopIndex >= content.stops.length
  )
    return null;
  const stop = content.stops[stopIndex];
  if (
    issue.segment_id &&
    !(stop.segments ?? []).some((segment) => segment.id === issue.segment_id)
  )
    return null;
  return {
    stopIndex,
    segmentId: issue.segment_id ?? undefined,
    step:
      issue.resource_type === "narration"
        ? 3
        : issue.path === `stops.${stopIndex}`
          ? 1
          : 2,
  };
}

/** Resolve only structured entity IDs through the authenticated detail API. */
export async function readIssueTarget(
  issue: WorkbenchIssue,
  signal?: AbortSignal,
): Promise<IssueTarget> {
  const id = encodeURIComponent(issue.entity_id);
  let page: HelpPage, revision: number, publishedRevision: number;
  if (issue.entity_type === "point") {
    const row = (
      await request<components["schemas"]["AdminPoint"]>(
        `/points/${id}`,
        "GET",
        undefined,
        signal,
      )
    ).data;
    if (row.point.id !== issue.entity_id)
      throw new Error("地点响应身份不符，已停止打开。");
    page = "points";
    revision = row.draft?.revision ?? 0;
    publishedRevision = row.point.revision;
  } else if (issue.entity_type === "floor" || issue.entity_type === "vr") {
    const row = (
      await request<components["schemas"]["AdminResource"]>(
        `/resources/${id}`,
        "GET",
        undefined,
        signal,
      )
    ).data;
    if (
      row.id !== issue.entity_id ||
      row.kind !== (issue.entity_type === "vr" ? "panorama" : "floor")
    )
      throw new Error("资料响应身份不符，已停止打开。");
    page = "resources";
    revision = row.draft?.revision ?? 0;
    publishedRevision = row.published_revision;
  } else if (issue.entity_type === "navigation") {
    const row = (
      await request<components["schemas"]["RoadWorkspace"]>(
        `/navigation/${id}`,
        "GET",
        undefined,
        signal,
      )
    ).data;
    if (row.map_id !== issue.entity_id)
      throw new Error("路网响应身份不符，已停止打开。");
    page = "roads";
    revision = row.revision;
    publishedRevision = row.published_revision;
  } else if (issue.entity_type === "configuration") {
    const row = (
      await request<components["schemas"]["AdminConfiguration"]>(
        `/configurations/${id}`,
        "GET",
        undefined,
        signal,
      )
    ).data;
    if (row.id !== issue.entity_id)
      throw new Error("配置响应身份不符，已停止打开。");
    page = row.kind === "runtime" ? "guide-settings" : "configurations";
    revision = row.revision;
    publishedRevision = row.published_revision;
  } else {
    const row = (
      await request<components["schemas"]["AdminExperience"]>(
        `/experiences/${id}`,
        "GET",
        undefined,
        signal,
      )
    ).data;
    const content = row.content ?? row.published_content;
    if (
      row.id !== issue.entity_id ||
      !content ||
      content.kind !== issue.entity_type
    )
      throw new Error("体验响应身份不符，已停止打开。");
    page = content.kind === "tour" ? "tours" : "experiences";
    revision = row.revision;
    publishedRevision = row.published_revision;
  }
  if (
    ![revision, publishedRevision].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("对象版本无法核验，已停止打开。");
  return {
    issue,
    page,
    revision,
    publishedRevision,
    changed:
      revision !== issue.revision ||
      publishedRevision !== issue.published_revision,
  };
}

export function WorkspaceIssues({
  session,
  campuses = [],
  revision,
  onOpen,
  onReview,
}: {
  session: StaffSession;
  revision: number;
  campuses?: Campus[];
  onOpen: (target: IssueTarget) => void;
  onReview: (target: IssueTarget) => void;
}) {
  const scope = JSON.stringify([
    session.user.id,
    session.user.role,
    session.user.campus_ids,
    session.user.point_ids,
    session.permissions,
  ]);
  const [kind, setKind] = useState<EntityType | "">(""),
    [campus, setCampus] = useState("");
  const effectiveCampus =
    campus &&
    session.user.role !== "admin" &&
    !session.user.campus_ids.includes(campus)
      ? ""
      : campus;
  const binding = `${scope}:${kind}:${effectiveCampus}`;
  const [paging, setPaging] = useState<{
    binding: string;
    cursors: (string | null)[];
  }>({ binding, cursors: [null] });
  const cursors = paging.binding === binding ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1];
  const [refresh, setRefresh] = useState(0),
    [error, setError] = useState("");
  const [loaded, setLoaded] = useState<{
    key: string;
    batch: IssueBatch;
  } | null>(null);
  const [opening, setOpening] = useState(false);
  const operation = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const key = `${binding}:${cursor ?? ""}:${revision}:${refresh}`;
  const batch = loaded?.key === key ? loaded.batch : null;
  useEffect(() => {
    operation.current?.abort();
    epoch.current++;
    setOpening(false);
    setError("");
    const abort = new AbortController();
    const params = new URLSearchParams({
      limit: "20",
      ...(kind ? { entity_type: kind } : {}),
      ...(effectiveCampus ? { campus_id: effectiveCampus } : {}),
      ...(cursor ? { cursor } : {}),
    });
    void request<IssueBatch>(
      `/workbench/issues?${params}`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        if (
          result.data.coverage !== "saved_entity_page" ||
          !Array.isArray(result.data.items)
        )
          throw new Error("检查结果格式无法核验，请重新读取。");
        setLoaded({ key, batch: result.data });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => {
      abort.abort();
      operation.current?.abort();
      epoch.current++;
    };
  }, [key]);

  async function open(issue: WorkbenchIssue, review = false) {
    if (
      opening ||
      !batch ||
      !issue.actions.includes(review ? "review" : "open")
    )
      return;
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    const current = ++epoch.current;
    setOpening(true);
    setError("");
    try {
      const target = await readIssueTarget(issue, abort.signal);
      if (abort.signal.aborted || current !== epoch.current) return;
      if (review) onReview(target);
      else onOpen(target);
    } catch (e) {
      if (!abort.signal.aborted && current === epoch.current)
        setError(message(e));
    } finally {
      if (current === epoch.current) setOpening(false);
    }
  }
  return (
    <section className="ad-card ad-issues" aria-labelledby="admin-issues-title">
      <div className="ad-card-heading">
        <div>
          <h2 id="admin-issues-title">最近保存内容的检查结果</h2>
          <p>
            按保存时间分批检查当前账号范围；这里只统计当前页，不代表全站全部问题。
          </p>
        </div>
        <button
          disabled={opening}
          onClick={() => {
            setPaging({ binding, cursors: [null] });
            setRefresh((n) => n + 1);
          }}
        >
          重新检查第一页
        </button>
      </div>
      <div className="ad-issues-filters">
        <label>
          内容类型
          <select
            value={kind}
            disabled={opening}
            onChange={(event) => setKind(event.target.value as EntityType | "")}
          >
            <option value="">所有授权类型</option>
            {Object.entries(entityNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {!!campuses.length && (
          <label>
            校区范围
            <select
              disabled={opening}
              value={effectiveCampus}
              onChange={(event) => setCampus(event.target.value)}
            >
              <option value="">全部授权校区及全站配置</option>
              {campuses
                .filter(
                  (item) =>
                    session.user.role === "admin" ||
                    session.user.campus_ids.includes(item.id),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <ErrorBox text={error} onRetry={() => setRefresh((n) => n + 1)} />
      {!batch && !error && <p role="status">正在检查本页已保存内容…</p>}
      {opening && <p role="status">正在重新核对对象权限与版本…</p>}
      {batch && (
        <>
          <p role="status">
            本页检查 {batch.checked_entity_count} 项内容，返回{" "}
            {batch.issue_count} 条状态或问题。
          </p>
          {batch.omitted_issue_count > 0 && (
            <p role="alert">
              本页有 {batch.omitted_issue_count}{" "}
              条检查未完整展示，请进入相关对象运行完整检查。
            </p>
          )}
          {!batch.items.length && (
            <p>
              {batch.checked_entity_count
                ? "本页未返回问题；实际素材、声音和现场通行仍需人工核验。"
                : "本页没有可检查的已保存内容。"}
            </p>
          )}
          <ul className="ad-issues-list">
            {batch.items.map((issue, index) => (
              <li
                key={`${issue.entity_type}:${issue.entity_id}:${issue.path}:${issue.code}:${index}`}
              >
                <div>
                  <strong>
                    {issue.title || entityNames[issue.entity_type]}
                  </strong>
                  <span className={`ad-issue-level ${issue.severity}`}>
                    {issue.severity === "error"
                      ? "需要处理"
                      : issue.severity === "warning"
                        ? "需要核对"
                        : "状态说明"}
                  </span>
                </div>
                <p>{issue.message}</p>
                <small>
                  {entityNames[issue.entity_type]} ·{" "}
                  {stateNames[issue.state] ?? issue.state} · 草稿 v
                  {issue.revision} / 正式 v{issue.published_revision}
                  {issue.stop_index != null &&
                    ` · 第 ${issue.stop_index + 1} 站`}
                  {issue.segment_id && " · 指定段落"}
                </small>
                {issue.expected_revision != null && (
                  <p>
                    引用版本 v{issue.expected_revision}；
                    {issue.current_revision == null
                      ? "当前引用不可核验，请在编辑器替换或完整检查。"
                      : `当前正式版本 v${issue.current_revision}`}
                  </p>
                )}
                {issue.code === "DETAIL_CHECK_REQUIRED" && (
                  <p>
                    本批检查预算有限，必须打开此对象运行完整检查；不能将本页视为已通过。
                  </p>
                )}
                <div className="ad-issue-actions">
                  {issue.actions.includes("open") && (
                    <button disabled={opening} onClick={() => void open(issue)}>
                      打开此项并定位
                    </button>
                  )}
                  {issue.actions
                    .filter((action) => action !== "open")
                    .map((action) => (
                      <button
                        key={action}
                        disabled={opening}
                        onClick={() => void open(issue, action === "review")}
                      >
                        {actionNames[action]}
                      </button>
                    ))}
                </div>
                <details>
                  <summary>检查详情</summary>
                  <p>
                    检查代码：{issue.code}；字段：{issue.path || "内容"}
                  </p>
                </details>
              </li>
            ))}
          </ul>
          <div className="ad-issues-pager">
            <span>第 {cursors.length} 批（每批最多 20 项内容）</span>
            <button
              disabled={opening || cursors.length === 1}
              onClick={() =>
                setPaging({ binding, cursors: cursors.slice(0, -1) })
              }
            >
              上一批
            </button>
            <button
              disabled={opening || !batch.has_more || !batch.next_cursor}
              onClick={() => {
                if (batch.next_cursor)
                  setPaging({
                    binding,
                    cursors: [...cursors, batch.next_cursor],
                  });
              }}
            >
              检查较早保存的内容
            </button>
          </div>
        </>
      )}
    </section>
  );
}
