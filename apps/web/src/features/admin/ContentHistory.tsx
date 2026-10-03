import { useEffect, useState } from "react";
import type { components } from "../../shared/api/schema";
import { message, request } from "./api";
import { ErrorBox } from "./ui";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import type { ConfigurationPreflight } from "./configurationTypes";

type Entity = "point" | "floor" | "vr" | "navigation";
type Version = components["schemas"]["ContentHistory"];
type Dependency = components["schemas"]["ContentDependency"];
const events: Record<string, string> = {
  save: "保存草稿",
  checkpoint: "历史检查点",
  submit: "提交审核",
  withdraw: "撤回待审",
  publish: "审核发布",
  reject: "退回修改",
  restore: "恢复新草稿",
  retire: "申请下架",
  discard: "撤回草稿",
  create: "新建草稿",
};
function versionSummary(entity: Entity, content: unknown) {
  if (!content || typeof content !== "object")
    return "该版本没有可显示的内容。";
  const outer = content as Record<string, unknown>,
    value = (
      outer.content && typeof outer.content === "object" ? outer.content : outer
    ) as Record<string, unknown>;
  if (entity === "point")
    return `${typeof value.name === "string" ? value.name : "地点资料"}${typeof value.summary === "string" && value.summary ? `：${value.summary.slice(0, 160)}` : ""}`;
  if (entity === "floor")
    return `${typeof value.label === "string" ? value.label : "楼层资料"} · ${Array.isArray(value.images) ? value.images.length : 0} 个真实分区引用`;
  if (entity === "vr")
    return `${typeof value.title === "string" ? value.title : "VR 入口"}${typeof value.description === "string" && value.description ? `：${value.description.slice(0, 160)}` : ""}`;
  return `道路草稿 · ${Array.isArray(value.nodes) ? value.nodes.length : 0} 个节点、${Array.isArray(value.edges) ? value.edges.length : 0} 条路段；通行状态仍需现场核验`;
}
export function ContentHistory<R>({
  entity,
  id,
  revision,
  publishedRevision,
  state,
  editable,
  dirty,
  onSave,
  onLoad,
  onPendingChange,
}: {
  entity: Entity;
  id: string;
  revision: number;
  publishedRevision: number;
  state: string;
  editable: boolean;
  dirty: boolean;
  onSave: () => Promise<boolean>;
  onLoad: (row: R) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null),
    [dependencies, setDependencies] = useState<Dependency[] | null>(null),
    [report, setReport] = useState<ConfigurationPreflight | null>(null);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [note, setNote] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    onPendingChange(busy || !!pending);
  }, [busy, pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  useEffect(() => {
    setReport(null);
  }, [id, revision, publishedRevision, dirty]);
  async function recover(operation: string): Promise<R | null> {
    try {
      return (await request<{ result: R }>(`/operations/${operation}`)).data
        .result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  async function query() {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const row = await recover(pending);
      if (!row) throw new Error("原操作尚未确认，请保留页面并稍后查询。");
      setPending(null);
      onLoad(row);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function action(
    name:
      | "history"
      | "dependencies"
      | "preflight"
      | "checkpoint"
      | "withdraw"
      | "restore",
    version?: Version,
  ) {
    if (busy || pending) return;
    setBusy(true);
    setError("");
    try {
      if (name === "history") {
        setVersions(
          (
            await request<Version[]>(
              `/content-history?${new URLSearchParams({ entity_type: entity, entity_id: id })}`,
            )
          ).data,
        );
        return;
      }
      if (name === "dependencies") {
        setDependencies(
          (
            await request<Dependency[]>(
              `/resources/${entity === "navigation" ? "map" : entity}/${id}/dependencies`,
            )
          ).data,
        );
        return;
      }
      // Mutations bind the version the user sees. Saving would change that binding,
      // so defer until the parent has rendered the acknowledged revision.
      if (dirty) {
        if (!(await onSave()))
          throw new Error("保存尚未确认，请先解决保存状态。");
        throw new Error("草稿已保存，请核对新版本后再执行本次检查或恢复。");
      }
      if (
        ["restore", "withdraw"].includes(name) &&
        !window.confirm(
          name === "restore"
            ? "将该历史内容恢复为新私有草稿？不恢复旧批准，仍需重新预检和独立审核。"
            : "撤回待审版本并继续编辑？公开版本不受影响。",
        )
      )
        return;
      const body = {
        expected_revision: revision,
        expected_published_revision: publishedRevision,
        operation_id: crypto.randomUUID(),
        note:
          note ||
          (name === "restore"
            ? "历史恢复为新草稿"
            : name === "withdraw"
              ? "撤回并继续编辑"
              : name === "checkpoint"
                ? "手动检查点"
                : "检查当前草稿"),
      };
      const path = `/content/${entity}/${id}/${name === "restore" ? `history/${version!.id}/restore-draft` : name}`;
      if (name === "preflight")
        setReport(
          (await request<ConfigurationPreflight>(path, "POST", body)).data,
        );
      else {
        const row = await confirmedOperation(
          body.operation_id,
          async () => (await request<R>(path, "POST", body)).data,
          recover,
        );
        onLoad(row);
        setVersions(null);
      }
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPending(e.operationId);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ad-card ad-config-actions">
      <h3>版本、影响与恢复</h3>
      <p>
        检查与影响查询不调用收费服务。恢复只建立新草稿，不恢复旧批准或绕过当前范围授权。
      </p>
      <ErrorBox text={error} />
      {pending && (
        <button disabled={busy} onClick={() => void query()}>
          查询原版本操作结果
        </button>
      )}
      <label>
        检查点／恢复说明
        <input
          maxLength={1000}
          value={note}
          disabled={busy || !!pending}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div>
        <button
          disabled={busy || !!pending}
          onClick={() => void action("preflight")}
        >
          检查当前保存版本
        </button>
        <button
          disabled={busy || !!pending}
          onClick={() => void action("history")}
        >
          查看可访问历史
        </button>
        <button
          disabled={busy || !!pending}
          onClick={() => void action("dependencies")}
        >
          查看受影响内容
        </button>
        {editable && state !== "in_review" && (
          <button
            disabled={busy || !!pending}
            onClick={() => void action("checkpoint")}
          >
            建立检查点
          </button>
        )}
        {editable && state === "in_review" && (
          <button
            disabled={busy || !!pending}
            onClick={() => void action("withdraw")}
          >
            撤回并继续编辑
          </button>
        )}
      </div>
      {report && !dirty && report.revision === revision && (
        <div aria-label="当前版本检查报告">
          <h4>
            {report.valid ? "预检通过" : "需要处理"} · 草稿 v{report.revision}
          </h4>
          {report.issues.map((issue, index) => (
            <p
              key={index}
              role={issue.severity === "error" ? "alert" : undefined}
            >
              {issue.path}：{issue.message}
            </p>
          ))}
          <small>修改任意字段使报告失效；提交和发布时服务端再次核验。</small>
        </div>
      )}
      {dependencies && (
        <div aria-label="资料引用影响">
          <h4>当前账号可访问的引用 {dependencies.length} 项</h4>
          <p>
            这里不泄露其他校区或成员范围中的私有内容。版本更新不会自动把路线改成新素材；公开旧引用将按服务端失效规则处理。
          </p>
          <ul>
            {dependencies.map((item) => (
              <li key={`${item.entity_type}:${item.id}`}>
                {item.title || "未命名内容"} · {item.state} · 草稿 v
                {item.revision} / 发布 v{item.published_revision} ·{" "}
                {item.locations.join("、")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {versions && (
        <div aria-label="内容历史">
          <h4>历史检查点</h4>
          {versions.length ? (
            versions.map((version) => (
              <details key={version.id}>
                <summary>
                  {new Date(version.created_at).toLocaleString("zh-CN")} ·{" "}
                  {events[version.event.split(".").at(-1) ?? ""] || "保存版本"}{" "}
                  · 草稿 v{version.revision} / 发布 v
                  {version.published_revision}
                </summary>
                <p>{versionSummary(entity, version.content)}</p>
                <p>
                  恢复当时的字段和引用，失效资源仍需修复。地图底图原字节不改写，道路通行记录不视为现场验收。
                </p>
                <details>
                  <summary>查看保存内容与指纹</summary>
                  <p>{version.content_sha256}</p>
                  <pre>{JSON.stringify(version.content, null, 2)}</pre>
                </details>
                {editable && (
                  <button
                    disabled={busy || !!pending || state === "in_review"}
                    onClick={() => void action("restore", version)}
                  >
                    恢复为新草稿
                  </button>
                )}
              </details>
            ))
          ) : (
            <p>尚无可访问的历史检查点。</p>
          )}
        </div>
      )}
    </section>
  );
}
