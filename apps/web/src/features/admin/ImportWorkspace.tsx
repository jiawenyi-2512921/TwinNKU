import { useEffect, useRef, useState } from "react";
import { message, readAdminFile, request, type StaffSession } from "./api";
import { ErrorBox } from "./ui";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import "./configuration.css";
import type { components } from "../../shared/api/schema";
import { ImportReferencePicker, ImportScopeExport } from "./ImportReferences";

export type ImportKind = "point" | "vr" | "tour" | "media";
export type ImportView = components["schemas"]["ImportView"];
export type ImportBinding = components["schemas"]["ImportReferenceBinding"];
type Pending =
  | {
      type: "upload";
      id: string;
      kind: ImportKind;
      sha: string;
      filename: string;
    }
  | {
      type: "mapping";
      id: string;
      mapping: Record<string, string>;
      previousDigest: string;
    }
  | { type: "references"; id: string; bindings: ImportBinding[] }
  | { type: "commit"; id: string; operationId: string };
const kindNames: Record<ImportKind, string> = {
  point: "地图点位",
  vr: "VR 全景入口",
  tour: "校园导览路线",
  media: "图片与视频资料",
};
const actionNames = {
  create: "新建私有草稿",
  update: "更新私有草稿",
  skip: "保持原样",
  error: "需要处理",
};
export function importBindingsConfirmed(
  view: ImportView,
  bindings: ImportBinding[],
) {
  const actual = view.reference_bindings ?? [];
  return bindings.every((binding) =>
    binding.rows.every((row) => {
      const found = actual.find(
        (item) => item.rows.includes(row) && item.field === binding.field,
      );
      return binding.id === null
        ? !found
        : !!found &&
            found.id === binding.id &&
            found.kind === binding.kind &&
            found.revision === binding.revision;
    }),
  );
}
export function sameImportMapping(
  a: Record<string, string>,
  b: Record<string, string>,
) {
  const entries = (v: Record<string, string>) =>
    JSON.stringify(
      Object.entries(v)
        .filter(([, value]) => value)
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  return entries(a) === entries(b);
}
export function importCanCommit(
  view: ImportView | null,
  mapping: Record<string, string>,
) {
  return (
    !!view &&
    view.state === "checked" &&
    !!view.preview.length &&
    !!view.preview_sha256 &&
    sameImportMapping(view.mapping, mapping) &&
    !view.preview.some((row) => row.action === "error") &&
    view.preview.some((row) => ["create", "update"].includes(row.action))
  );
}
export function importCommitOutcome(
  view: ImportView,
  operationId: string,
): "this_operation" | "another_operation" | "unknown" {
  if (view.state !== "committed") return "unknown";
  return view.commit_operation_id === operationId
    ? "this_operation"
    : "another_operation";
}
export function ImportWorkspace({
  session,
  onDirty,
  onUpdate,
  onReview,
  onOpenDraft,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  onReview?: () => void;
  onOpenDraft?: (
    kind: "point" | "vr" | "experience",
    id: string,
    isTour: boolean,
  ) => void;
}) {
  const [kind, setKind] = useState<ImportKind>("point"),
    [file, setFile] = useState<File | null>(null),
    [job, setJob] = useState<ImportView | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [referenceRows, setReferenceRows] = useState<number[]>([]);
  const controller = useRef<AbortController | null>(null),
    live = useRef(true);
  const dirty =
    !!job &&
    job.state === "checked" &&
    !sameImportMapping(job.mapping, mapping);
  useEffect(() => {
    onDirty(dirty, busy || !!pending);
  }, [dirty, busy, pending, onDirty]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.current?.abort();
      onDirty(false, false);
    };
  }, [session.user.id, onDirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || busy || pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, pending]);
  function accept(view: ImportView) {
    if (!live.current) return;
    setJob(view);
    setMapping(view.mapping);
  }
  async function recoverUpload(op: Extract<Pending, { type: "upload" }>) {
    const rows = (
      await request<ImportView[]>(
        `/import-jobs?${new URLSearchParams({ operation_id: op.id })}`,
      )
    ).data;
    const row = rows.length === 1 ? rows[0] : null;
    return row &&
      row.kind === op.kind &&
      row.source_sha256 === op.sha &&
      row.filename === op.filename &&
      row.state !== "uploading"
      ? row
      : null;
  }
  async function recoverMapping(op: Extract<Pending, { type: "mapping" }>) {
    const row = (await request<ImportView>(`/import-jobs/${op.id}`)).data;
    return row.state === "checked" && sameImportMapping(row.mapping, op.mapping)
      ? row
      : null;
  }
  async function recoverCommit(op: Extract<Pending, { type: "commit" }>) {
    const row = (await request<ImportView>(`/import-jobs/${op.id}`)).data;
    return row.state === "committed" ? row : null;
  }
  async function recoverReferences(
    op: Extract<Pending, { type: "references" }>,
  ) {
    const view = (await request<ImportView>(`/import-jobs/${op.id}`)).data;
    return view.state === "checked" &&
      importBindingsConfirmed(view, op.bindings)
      ? view
      : null;
  }
  async function reloadInspection() {
    if (
      !job ||
      busy ||
      pending ||
      (dirty &&
        !window.confirm(
          "重新读取服务器列匹配与检查结果？本页未确认的列匹配将放弃，原文件和已有草稿保留。",
        ))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const view = (await request<ImportView>(`/import-jobs/${job.id}`)).data;
      accept(view);
      setReferenceRows([]);
      if (view.state === "committed") {
        setStep(3);
        setNotice("该任务已有真实生成结果，请继续校对，未再次提交。");
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function applyReferences(bindings: ImportBinding[]) {
    if (!job || job.state !== "checked" || dirty || busy || pending) return;
    const op: Extract<Pending, { type: "references" }> = {
      type: "references",
      id: job.id,
      bindings,
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const view = await confirmedOperation(
        crypto.randomUUID(),
        async () =>
          (
            await request<ImportView>(
              `/import-jobs/${job.id}/references`,
              "POST",
              { expected_preview_sha256: job.preview_sha256, bindings },
            )
          ).data,
        () => recoverReferences(op),
      );
      if (!importBindingsConfirmed(view, bindings))
        throw new UnconfirmedOperation("reference-selection");
      accept(view);
      setNotice("已按所选真实地点／资料重新检查，仍未生成或发布任何业务草稿。");
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPending(op);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function commitAcknowledged(view: ImportView, operationId: string) {
    accept(view);
    setStep(3);
    onUpdate?.();
    setNotice(
      importCommitOutcome(view, operationId) === "this_operation"
        ? "本批私有草稿已生成。没有提审或发布，请逐项校对后提交审核。"
        : "该任务已由另一个窗口完成，已读取真实结果；不会再次生成草稿。这不是当前请求的成功确认。",
    );
  }
  async function query() {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const view =
        pending.type === "upload"
          ? await recoverUpload(pending)
          : pending.type === "mapping"
            ? await recoverMapping(pending)
            : pending.type === "references"
              ? await recoverReferences(pending)
              : await recoverCommit(pending);
      if (!view)
        throw new Error(
          "本次结果仍未确认，请保留页面并稍后查询；不会重新上传或生成草稿。",
        );
      if (pending.type === "commit")
        commitAcknowledged(view, pending.operationId);
      else {
        accept(view);
        setStep(pending.type === "upload" ? 1 : 2);
        setNotice("已读取原操作结果，没有重复提交。");
      }
      setPending(null);
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function upload() {
    if (
      !file ||
      busy ||
      pending ||
      !session.permissions.includes("points.edit")
    )
      return;
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    if (
      !["csv", "xlsx"].includes(extension || "") ||
      file.size > 10 * 1024 * 1024 ||
      !file.size ||
      file.name.length > 200
    ) {
      setError(
        "请选择不超过10MB的 CSV 或 XLSX 文件；不接受宏工作簿或旧 XLS 格式。",
      );
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const sha = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (!live.current) return;
      const op: Extract<Pending, { type: "upload" }> = {
        type: "upload",
        id: crypto.randomUUID(),
        kind,
        sha,
        filename: file.name,
      };
      try {
        const view = await confirmedOperation(
          op.id,
          async () =>
            (
              await request<ImportView>(
                `/import-jobs?${new URLSearchParams({ kind, file_type: extension!, operation_id: op.id, source_sha256: sha, filename: file.name })}`,
                "POST",
                file,
                abort.signal,
              )
            ).data,
          () => recoverUpload(op),
        );
        accept(view);
        setFile(null);
        setStep(1);
      } catch (e) {
        if (e instanceof UnconfirmedOperation && live.current) setPending(op);
        throw e;
      }
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
      controller.current = null;
    }
  }
  async function checkMapping() {
    if (!job || job.state !== "checked" || busy || pending) return;
    setBusy(true);
    setError("");
    setNotice("");
    const op: Extract<Pending, { type: "mapping" }> = {
      type: "mapping",
      id: job.id,
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(([, value]) => value),
      ),
      previousDigest: job.preview_sha256,
    };
    try {
      const view = await confirmedOperation(
        crypto.randomUUID(),
        async () =>
          (
            await request<ImportView>(
              `/import-jobs/${job.id}/mapping`,
              "POST",
              {
                expected_preview_sha256: job.preview_sha256,
                mapping: op.mapping,
              },
            )
          ).data,
        () => recoverMapping(op),
      );
      accept(view);
      setStep(2);
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPending(op);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!job || busy || pending || !importCanCommit(job, mapping)) return;
    const changes = job.preview.filter(
      (r) => r.action === "create" || r.action === "update",
    );
    if (
      !window.confirm(
        `将本批 ${changes.length} 项资料生成或更新为私有草稿？更新路线将按预检说明替换整条站段。本次不会提审或发布。`,
      )
    )
      return;
    const op: Extract<Pending, { type: "commit" }> = {
      type: "commit",
      id: job.id,
      operationId: crypto.randomUUID(),
    };
    setBusy(true);
    setError("");
    try {
      const view = await confirmedOperation(
        op.operationId,
        async () =>
          (
            await request<ImportView>(`/import-jobs/${job.id}/commit`, "POST", {
              expected_preview_sha256: job.preview_sha256,
              operation_id: op.operationId,
            })
          ).data,
        () => recoverCommit(op),
      );
      if (view.state !== "committed")
        throw new Error("导入响应未确认草稿生成，请查询任务。");
      commitAcknowledged(view, op.operationId);
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPending(op);
      else if ((e as { status?: number }).status === 409) {
        try {
          const existing = await recoverCommit(op);
          if (existing) {
            commitAcknowledged(existing, op.operationId);
            return;
          }
        } catch {
          /* Preserve the original rejection without a blind retry. */
        }
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function download(path: string, filename: string) {
    if (busy || pending) return;
    setBusy(true);
    setError("");
    try {
      const blob = await readAdminFile(path);
      if (!live.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="ad-import-workspace">
      <header className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">CONTENT IMPORT</div>
          <h1>表格导入</h1>
          <p>
            把现有资料整理成私有草稿。列匹配和检查只读取，不发布内容、不访问表格内的网址。
          </p>
        </div>
      </header>
      <nav className="ad-tour-steps" aria-label="导入步骤">
        {["选择与上传", "匹配资料列", "检查整批差异", "生成草稿与交接"].map(
          (label, index) => (
            <button
              key={label}
              aria-current={step === index ? "step" : undefined}
              disabled={
                busy ||
                !!pending ||
                (index > 0 && !job) ||
                (index === 3 && job?.state !== "committed")
              }
              onClick={() => setStep(index)}
            >
              {index + 1}. {label}
            </button>
          ),
        )}
      </nav>
      <ErrorBox text={error} />
      {notice && <p role="status">{notice}</p>}
      {job?.state === "failed" && (
        <p role="alert">
          这批检查未完成：{job.error_code || "文件无法解析"}
          。请保留原文件、修正后开始新任务；没有生成业务草稿。
        </p>
      )}
      {job && job.state !== "committed" && (
        <button
          disabled={busy || !!pending}
          onClick={() => void reloadInspection()}
        >
          重新读取本任务版本
        </button>
      )}
      {pending && (
        <div role="alert">
          <p>
            操作结果尚未确认。当前资料保留，生成按钮已暂停；只能查询本次任务，不自动重试。
          </p>
          <button disabled={busy} onClick={() => void query()}>
            查询原导入操作结果
          </button>
        </div>
      )}
      <fieldset
        disabled={
          busy || !!pending || !session.permissions.includes("points.edit")
        }
        className="ad-card ad-config-fields"
      >
        <legend className="sr-only">导入内容</legend>
        {step === 0 && (
          <>
            <h2>准备表格</h2>
            <label>
              资料类型
              <select
                value={kind}
                disabled={!!job}
                onChange={(e) => setKind(e.target.value as ImportKind)}
              >
                {Object.entries(kindNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() =>
                void download(
                  `/import-templates/${kind}`,
                  `twinnku-${kind}-template.csv`,
                )
              }
            >
              下载空白 CSV 模板
            </button>
            <ImportScopeExport
              kind={kind}
              session={session}
              disabled={busy || !!pending}
              onBusy={setBusy}
              onError={setError}
              onDownload={download}
            />
            <p>
              使用 UTF-8 CSV 或单工作表
              XLSX，最多500行资料、10MB。公式、宏、外部工作簿链接和多个工作表会被拒绝。更新已有资料请先导出已有资料，保留模板带出的版本和关联列；相同名称不会覆盖旧资料。
            </p>
            {kind === "vr" && (
              <p>
                VR
                模板与范围导出均包含全景观察提示、封面图片、封面图片版本和目录顺序。第三步可按名称、缩略图和所属地点选择封面，版本自动带入；更新表格请保留这四列。技术、场景位置和设备人工核查记录不从表格导入。
              </p>
            )}
            <label>
              选择资料文件
              <input
                type="file"
                accept=".csv,.xlsx"
                disabled={!!job}
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setError("");
                }}
              />
            </label>
            {file && (
              <p>
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </p>
            )}
            <button
              className="ad-primary"
              disabled={!file || !!job}
              onClick={() => void upload()}
            >
              上传并读取列
            </button>
            <small>
              上传只创建检查任务。已有地点、图片、楼层和视频可以在第三步按名称选择真实版本，不需要手填数据库编号；不会从网址下载素材。
            </small>
          </>
        )}
        {step === 1 && job && (
          <>
            <h2>匹配资料列</h2>
            <p>
              {job.filename} · 服务器识别 {job.row_count}{" "}
              行资料。忽略的列不会导入。
            </p>
            {job.columns.map((column) => (
              <label key={column}>
                表格列「{column}」
                <select
                  value={mapping[column] || ""}
                  disabled={job.state !== "checked"}
                  onChange={(e) =>
                    setMapping((v) => ({ ...v, [column]: e.target.value }))
                  }
                >
                  <option value="">忽略该列</option>
                  {Object.entries(job.fields).map(([key, label]) => (
                    <option
                      key={key}
                      value={key}
                      disabled={Object.entries(mapping).some(
                        ([original, target]) =>
                          original !== column && target === key,
                      )}
                    >
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {job.kind === "vr" && (
              <section
                className="ad-import-vr-fields"
                aria-label="VR 展示字段列匹配"
              >
                <h3>检查 VR 展示字段</h3>
                <ul>
                  {[
                    ["observation_prompt", "全景观察提示"],
                    ["cover_image_id", "封面图片"],
                    ["cover_image_revision", "封面图片版本"],
                    ["sort_order", "目录顺序"],
                  ].map(([key, label]) => (
                    <li key={key}>
                      {label}：
                      {Object.values(mapping).includes(key)
                        ? "已对应表格列"
                        : "未对应；本批不从此列更新"}
                    </li>
                  ))}
                </ul>
                <p>
                  封面图片和版本须成对；也可在第三步按名称选择，自动绑定精确版本。更新旧资料时，未提供的展示字段保留原值；明确提供两列空白封面值会移除原封面。忽略的列不会应用本次修改。
                </p>
              </section>
            )}
            <button
              className="ad-primary"
              disabled={job.state !== "checked"}
              onClick={() => void checkMapping()}
            >
              按当前列匹配重新检查
            </button>
            <small>修改匹配后旧检查报告失效；确认新报告后才能生成草稿。</small>
          </>
        )}
        {step === 2 && job && (
          <>
            <h2>逐项检查</h2>
            <p>
              共 {job.row_count} 行；
              {job.preview.filter((r) => r.action === "error").length}{" "}
              项需处理。存在任何错误时整批不会写入业务草稿。
            </p>
            {dirty && (
              <p role="alert">
                列匹配已修改，当前报告失效。请返回第二步重新检查。
              </p>
            )}
            <div className="ad-import-table">
              <table>
                <thead>
                  <tr>
                    <th>原表行</th>
                    <th>资料</th>
                    <th>处理</th>
                    <th>差异与问题</th>
                  </tr>
                </thead>
                <tbody>
                  {job.preview.map((row, i) => (
                    <tr key={i}>
                      <td>{row.rows.join("、")}</td>
                      <th>{row.title || "未命名资料"}</th>
                      <td>{actionNames[row.action]}</td>
                      <td>
                        {row.message}
                        {row.fields.length > 0 && (
                          <p>
                            {row.fields
                              .map((f) => job.fields[f] || f)
                              .join("、")}
                          </p>
                        )}
                        {row.code && <small>{row.code}</small>}
                        {job.state === "checked" && (
                          <button
                            type="button"
                            disabled={dirty}
                            onClick={() => setReferenceRows(row.rows)}
                          >
                            选择关联地点／资料
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {referenceRows.length > 0 && job.state === "checked" && (
              <ImportReferencePicker
                view={job}
                rows={referenceRows}
                session={session}
                disabled={busy || !!pending || dirty}
                onApply={applyReferences}
                onClose={() => setReferenceRows([])}
              />
            )}
            <button
              onClick={() =>
                void download(
                  `/import-jobs/${job.id}/report.csv`,
                  `twinnku-${job.kind}-check.csv`,
                )
              }
            >
              下载检查报告
            </button>
            <p>
              修改原文件中的问题后，在新的任务重新上传。更新路线按报告整体替换站点／段落；未列出的封面和展示设置按服务端规则保留。
            </p>
            <button
              className="ad-primary"
              disabled={!importCanCommit(job, mapping)}
              onClick={() => void commit()}
            >
              明确生成整批私有草稿
            </button>
            <small>不会自动提审，不会调用收费问答或讲解生成。</small>
          </>
        )}
        {step === 3 && job && (
          <>
            <h2>草稿交接</h2>
            <p>
              真实生成结果 {job.result.length}{" "}
              项。请在对应工作台检查地理位置、事实依据与资料，再保存并提交独立审核。
            </p>
            <ul>
              {job.result.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  原表行 {item.rows.join("、")} ·{" "}
                  {item.kind === "point"
                    ? "点位"
                    : item.kind === "vr"
                      ? "VR"
                      : "体验／路线"}{" "}
                  ·{" "}
                  {job.preview.find((row) =>
                    item.rows.some((value) => row.rows.includes(value)),
                  )?.title || "未命名资料"}
                  （待校对、提审与独立审核）
                  {onOpenDraft && (
                    <button
                      disabled={busy || !!pending}
                      onClick={() =>
                        onOpenDraft(item.kind, item.id, job.kind === "tour")
                      }
                    >
                      打开这项私有草稿继续校对
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              onClick={() =>
                void download(
                  `/import-jobs/${job.id}/report.csv`,
                  `twinnku-${job.kind}-check.csv`,
                )
              }
            >
              下载本批报告
            </button>
          </>
        )}
      </fieldset>
      {job && !busy && !pending && (
        <button
          onClick={() => {
            if (
              !dirty ||
              window.confirm(
                "放弃本页未确认的列匹配并开始新任务？已生成的草稿会保留。",
              )
            ) {
              setJob(null);
              setFile(null);
              setMapping({});
              setStep(0);
              setError("");
              setNotice("");
              setReferenceRows([]);
            }
          }}
        >
          开始另一批导入
        </button>
      )}
      {job?.state === "committed" && onReview && (
        <button disabled={busy || !!pending} onClick={onReview}>
          前往统一审核中心
        </button>
      )}
    </section>
  );
}
