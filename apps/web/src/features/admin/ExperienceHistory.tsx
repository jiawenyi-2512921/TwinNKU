import { useEffect, useRef, useState } from "react";
import type { AdminExperience } from "../experiences/types";
import { contentDiff } from "./draftCoordinator";
import { message, request } from "./api";
import { ErrorBox } from "./ui";
import type { ConfigurationPreflight } from "./configurationTypes";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import type {
  ExperienceVersion as Version,
  HistorySnapshot,
} from "./experienceHistoryTypes";
import { ExperienceHistoryPreview } from "./ExperienceHistoryPreview";
export function ExperienceHistory({
  getRecord,
  onSave,
  onLoad,
  editable,
  onReport,
  onJump,
  dirty,
  onPendingChange,
  onPreviewOpen,
}: {
  getRecord: () => AdminExperience | null;
  onSave: () => Promise<boolean>;
  onLoad: (item: AdminExperience) => void;
  editable: boolean;
  onReport: (report: ConfigurationPreflight | null) => void;
  onJump: (path: string) => void;
  dirty: boolean;
  onPendingChange?: (pending: boolean) => void;
  onPreviewOpen?: () => void;
}) {
  const [versions, setVersions] = useState<Version[]>([]),
    [open, setOpen] = useState(false),
    [report, setReport] = useState<ConfigurationPreflight | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    experienceId: string;
    versionId: string;
    snapshot: HistorySnapshot;
  } | null>(null);
  const historyRead = useRef<AbortController | null>(null);
  useEffect(() => () => historyRead.current?.abort(), []);
  useEffect(() => {
    onPendingChange?.(busy || !!pending);
  }, [busy, pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  async function action(
    name:
      | "history"
      | "preflight"
      | "checkpoint"
      | "copy"
      | "convert-legacy"
      | "restore",
    version?: Version,
  ) {
    if (busy || pending) return;
    setBusy(true);
    setError("");
    try {
      if (name !== "history" && editable && !(await onSave()))
        throw new Error("请先确认草稿保存，再操作当前版本。");
      const row = getRecord();
      if (!row) throw new Error("请先填写并保存草稿。");
      if (name === "history") {
        historyRead.current?.abort();
        const controller = new AbortController();
        historyRead.current = controller;
        const result = (
          await request<Version[]>(
            `/experiences/${row.id}/history`,
            "GET",
            undefined,
            controller.signal,
          )
        ).data;
        if (controller.signal.aborted || getRecord()?.id !== row.id) return;
        setVersions(
          result.filter((version) => version.experience_id === row.id),
        );
        setOpen(true);
        return;
      }
      if (
        ["copy", "convert-legacy", "restore"].includes(name) &&
        !window.confirm(
          name === "convert-legacy"
            ? "明确将旧单段讲解转换为稳定分段？原文、视频、打卡和提示时机保留，不会改写内容或自动生成音频。"
            : name === "copy"
              ? "建立一条新的私有路线草稿？新的段落标识会重新生成，音频及旧审核结论不会复制。"
              : "将这个历史版本恢复为新草稿？仍需重新检查和独立审核。",
        )
      )
        return;
      const body = {
        expected_revision: row.revision,
        expected_published_revision: row.published_revision,
        note:
          note ||
          {
            preflight: "检查当前草稿",
            checkpoint: "手动历史检查点",
            copy: "复制为新草稿",
            "convert-legacy": "明确转换旧单段讲解",
            restore: "历史恢复为新草稿",
          }[name],
        operation_id: crypto.randomUUID(),
      };
      const path =
        name === "restore"
          ? `/experiences/${row.id}/history/${version!.id}/restore-draft`
          : `/experiences/${row.id}/${name}`;
      if (name === "preflight") {
        const r = (await request<ConfigurationPreflight>(path, "POST", body))
          .data;
        setReport(r);
        onReport(r);
      } else {
        const r = await confirmedOperation(
          body.operation_id,
          async () => (await request<AdminExperience>(path, "POST", body)).data,
          recover,
        );
        onLoad(r);
        setReport(null);
        onReport(null);
        setOpen(false);
      }
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPending(e.operationId);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function recover(id: string): Promise<AdminExperience | null> {
    try {
      return (await request<{ result: AdminExperience }>(`/operations/${id}`))
        .data.result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  async function query() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const row = await recover(pending);
      if (!row) throw new Error("该操作结果还未确认，请保留本页并稍后查询。");
      setPending(null);
      onLoad(row);
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const row = getRecord();
  return (
    <section className="ad-card ad-config-actions">
      <h3>版本检查与草稿恢复</h3>
      <p>
        检查只读取当前版本和引用，不调用收费服务。历史恢复及复制始终建立草稿，独立审核和资源版本检查继续适用。
      </p>
      <ErrorBox text={error} />
      {pending && (
        <button disabled={busy} onClick={() => void query()}>
          查询本次历史／复制操作结果
        </button>
      )}
      <label>
        检查点／复制／恢复说明
        <input
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div>
        <button
          disabled={busy || !row}
          onClick={() => void action("preflight")}
        >
          检查当前保存版本
        </button>
        <button disabled={busy || !row} onClick={() => void action("history")}>
          查看历史
        </button>
        {editable && (
          <>
            <button
              disabled={busy || !row}
              onClick={() => void action("checkpoint")}
            >
              建立历史检查点
            </button>
            {row?.content?.kind === "tour" && (
              <>
                <button disabled={busy} onClick={() => void action("copy")}>
                  复制为新路线草稿
                </button>
                {row.content.stops.some((s) => !s.segments) && (
                  <button
                    disabled={busy}
                    onClick={() => void action("convert-legacy")}
                  >
                    明确转换旧单段讲解
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
      {report && !dirty && row?.revision === report.revision && (
        <div aria-label="路线预检报告">
          <h4>
            {report.valid ? "当前版本通过" : "需要处理"} · v{report.revision}
          </h4>
          <small>
            内容指纹 {report.content_sha256} · 依赖指纹{" "}
            {report.dependency_sha256}
          </small>
          {report.issues.map((i, n) => (
            <p key={n}>
              <button type="button" onClick={() => onJump(i.path)}>
                {i.path || "基本信息"}
              </button>{" "}
              · {i.severity === "error" ? "阻断" : "提示"} · {i.message}
              {i.expected_revision != null &&
                ` · 引用 v${i.expected_revision} / 当前 v${i.actual_revision ?? "不可用"}`}
            </p>
          ))}
        </div>
      )}
      {open && (
        <div aria-label="体验历史记录">
          <button onClick={() => setOpen(false)}>收起历史</button>
          {versions.map((v) => {
            const content = v.content ?? v.published_content;
            return (
              <details key={v.id}>
                <summary>
                  {new Date(v.created_at).toLocaleString("zh-CN")} · {v.event} ·
                  草稿 v{v.revision} / 发布 v{v.published_revision}
                </summary>
                <h4>{content?.title ?? "该记录没有内容快照"}</h4>
                <p>{content?.description}</p>
                <p>来源：{content?.source_note}</p>
                {content?.kind === "tour" && (
                  <ol>
                    {content.stops.map((s, i) => (
                      <li key={i}>
                        {s.title || `第 ${i + 1} 站`} ·{" "}
                        {s.segments?.length ?? 1} 段讲解
                      </li>
                    ))}
                  </ol>
                )}
                <details>
                  <summary>与当前内容的字段差异</summary>
                  {contentDiff(row?.content, v.content).map((d, i) => (
                    <p key={i}>
                      {d.path}：{JSON.stringify(d.before)} →{" "}
                      {JSON.stringify(d.after)}
                    </p>
                  ))}
                </details>
                <small>内容指纹 {v.content_sha256}</small>
                {(["draft", "published"] as const).map(
                  (snapshot) =>
                    (snapshot === "draft"
                      ? v.content
                      : v.published_content) && (
                      <button
                        key={snapshot}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!row) return;
                          onPreviewOpen?.();
                          setPreview({
                            experienceId: row.id,
                            versionId: v.id,
                            snapshot,
                          });
                        }}
                      >
                        只读预览历史{snapshot === "draft" ? "草稿" : "正式快照"}
                      </button>
                    ),
                )}
                <button
                  disabled={!editable || busy || !v.content}
                  onClick={() => void action("restore", v)}
                >
                  恢复为新草稿
                </button>
              </details>
            );
          })}
          {!versions.length && (
            <p>
              尚无历史记录。保存活动按五分钟间隔保留检查点，提审／审核等重要操作另有历史。
            </p>
          )}
        </div>
      )}
      {preview && row?.id === preview.experienceId && (
        <ExperienceHistoryPreview
          key={`${preview.experienceId}:${preview.versionId}:${preview.snapshot}`}
          {...preview}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}
