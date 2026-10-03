import { useEffect, useRef, useState } from "react";
import { get, type Campus } from "../../shared/api/client";
import type { PublicPage } from "../../shared/navigation";
import {
  ExhibitionHome,
  TourCatalog,
  type Showcase,
} from "../visit/Exhibition";
import { message, request, stateNames, type StaffSession } from "./api";
import { ErrorBox, useResource } from "./ui";
import {
  DraftCoordinator,
  stableContent,
  type DraftSnapshot,
  type DraftStatus,
} from "./draftCoordinator";
import { DraftStatusBar } from "./DraftStatus";
import {
  configurationNames,
  defaultConfiguration,
  moduleNames,
  newModule,
  type AdminConfiguration,
  type ConfigurationContent,
  type ConfigurationKind,
  type ConfigurationPreflight,
  type ConfigurationVersion,
  type ModuleType,
  type PresentationContent,
  type PresentationModule,
} from "./configurationTypes";
import "./configuration.css";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import type { WorkbenchIssue } from "./WorkspaceIssues";
import { MapDefaultsEditor } from "./MapDefaultsEditor";
export const beijingDateTimeInput = (value: string | null | undefined) =>
  value
    ? new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 16)
    : "";
export const beijingDateTimeUtc = (value: string) =>
  value ? new Date(`${value}+08:00`).toISOString() : null;

type Props = {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  onReview?: (id: string) => void;
  initialId?: string;
  initialIssue?: WorkbenchIssue;
  initialKind?: ConfigurationKind;
  lockKind?: boolean;
  review?: boolean;
};
type ImageChoice = {
  id: string;
  revision: number;
  title: string;
  url: string;
  campus_id: string;
};
type ConfigurationGrant = {
  user_id: string;
  permission: string;
  scope: string;
};
const snapshot = (
  record: AdminConfiguration,
): DraftSnapshot<ConfigurationContent> => ({
  id: record.id,
  revision: record.revision,
  published_revision: record.published_revision,
  content: record.draft,
});
export function ConfigurationWorkspace(props: Props) {
  const [kind, setKind] = useState<ConfigurationKind>(
    props.initialKind ?? "presentation",
  );
  const [scope, setScope] = useState("global");
  const [selected, setSelected] = useState<AdminConfiguration | null>(null);
  const [newDraft, setNewDraft] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const dirty = useRef(false),
    busy = useRef(false);
  const rows = useResource<AdminConfiguration[]>(
    `/configurations?kind=${kind}`,
    revision,
  );
  const campuses = useResource<Campus[]>("", 0, (signal) =>
    get<Campus[]>("/campuses", signal),
  );
  const grants = useResource<ConfigurationGrant[]>(
    "/configuration-permissions",
    revision,
  );
  const allowedCampuses = (campuses.data?.data ?? []).filter(
    (c) =>
      props.session.user.role === "admin" ||
      props.session.user.campus_ids.includes(c.id),
  );
  const mayCreate =
    !props.review &&
    !!grants.data?.data.some(
      (g) =>
        g.user_id === props.session.user.id &&
        g.permission ===
          (kind === "runtime" ? "runtime.edit" : "configurations.edit") &&
        (g.scope === "global" || g.scope === scope),
    ) &&
    (kind !== "runtime" || scope === "global");
  useEffect(() => {
    if (!props.initialId) return;
    const controller = new AbortController();
    void request<AdminConfiguration>(
      `/configurations/${props.initialId}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          setSelected(r.data);
          setKind(r.data.kind);
          setScope(r.data.scope);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [props.initialId]);
  function canLeave() {
    return (
      !busy.current &&
      (!dirty.current ||
        window.confirm("本页仍有未确认保存的输入，确定切换并放弃吗？"))
    );
  }
  function select(record: AdminConfiguration | null, fresh = false) {
    if (!canLeave()) return;
    if (record) {
      setKind(record.kind);
      setScope(record.scope);
    }
    setSelected(record);
    setNewDraft(fresh);
    setEpoch((v) => v + 1);
    setError("");
  }
  return (
    <section className="ad-configuration-workspace">
      {!props.review && (
        <div className="ad-section-heading">
          <div>
            <div className="ad-eyebrow">EXHIBITION STUDIO</div>
            <h1>{configurationNames[kind]}</h1>
            <p>
              使用固定模块编排页面。保存只更新私有草稿，预检并交由另一位成员审核后才公开。
            </p>
          </div>
        </div>
      )}
      <ErrorBox
        text={error || rows.error || campuses.error || grants.error}
        onRetry={() => setRevision((v) => v + 1)}
      />
      {!props.initialId && (
        <div className="ad-configuration-select">
          <label>
            设置类型
            <select
              value={kind}
              disabled={props.lockKind}
              onChange={(e) => {
                if (!canLeave()) return;
                setKind(e.target.value as ConfigurationKind);
                if (e.target.value === "runtime") setScope("global");
                setSelected(null);
                setNewDraft(false);
              }}
            >
              {Object.entries(configurationNames)
                .filter(
                  ([value]) =>
                    value === kind ||
                    props.session.permissions.some((p) =>
                      (value === "runtime"
                        ? ["runtime.edit", "runtime.review"]
                        : ["configurations.edit", "configurations.review"]
                      ).includes(p),
                    ),
                )
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            新建范围
            <select
              value={scope}
              disabled={kind === "runtime"}
              onChange={(e) => {
                if (canLeave()) {
                  setScope(e.target.value);
                  setSelected(null);
                  setNewDraft(false);
                }
              }}
            >
              <option value="global">全站默认</option>
              {allowedCampuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy.current || !mayCreate}
            onClick={() => select(null, true)}
          >
            ＋ 新建该范围草稿
          </button>
          {!mayCreate && (
            <small>新建需要该范围的编辑授权；服务与费用仅在全站设置。</small>
          )}
          <div className="ad-configuration-records">
            {(rows.data?.data ?? []).map((r) => (
              <button
                key={r.id}
                aria-pressed={selected?.id === r.id}
                onClick={() => select(r)}
              >
                {r.scope === "global"
                  ? "全站默认"
                  : campuses.data?.data.find((c) => c.id === r.scope)?.name ||
                    "校区设置"}{" "}
                · {stateNames[r.state]} · v{r.revision}
                {!r.permissions.edit && " · 只读"}
              </button>
            ))}
          </div>
        </div>
      )}
      {selected || newDraft ? (
        <ConfigurationEditor
          key={`${props.session.user.id}:${epoch}:${props.initialId || "list"}`}
          {...props}
          initial={selected}
          kind={kind}
          scope={scope}
          campuses={allowedCampuses}
          onSaved={() => {
            setRevision((v) => v + 1);
            props.onUpdate?.();
          }}
          onDirty={(d, b) => {
            dirty.current = d;
            busy.current = !!b;
            props.onDirty(d, b);
          }}
        />
      ) : (
        <p>
          选择已有设置，或新建全站／校区设置。未配置时公众端使用中性默认展示，不会自动挑选主视觉或推荐路线。
        </p>
      )}
    </section>
  );
}

function ConfigurationEditor({
  initial,
  kind,
  scope,
  campuses,
  ...props
}: Props & {
  initial: AdminConfiguration | null;
  kind: ConfigurationKind;
  scope: string;
  campuses: Campus[];
  onSaved: () => void;
}) {
  const [record, setRecord] = useState(initial);
  const recordRef = useRef(initial);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<ConfigurationVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<{
    version: ConfigurationVersion;
    showcase: Showcase;
    campusId: string;
  } | null>(null);
  const [historyPage, setHistoryPage] = useState<PublicPage>({ kind: "home" });
  const historyAbort = useRef<AbortController | null>(null),
    historyEpoch = useRef(0);
  const [report, setReport] = useState<ConfigurationPreflight | null>(null);
  const [moduleId, setModuleId] = useState(() => {
    const issue = props.initialIssue;
    const match = /^modules\.(\d+)(?:\.|$)/.exec(issue?.path ?? "");
    return initial &&
      issue &&
      issue.entity_id === initial.id &&
      issue.revision === initial.revision &&
      issue.published_revision === initial.published_revision &&
      initial.draft.kind === "presentation" &&
      match
      ? (initial.draft.modules[Number(match[1])]?.id ?? "")
      : "";
  });
  const [previewSize, setPreviewSize] = useState("desktop");
  const [previewPage, setPreviewPage] = useState<PublicPage>({ kind: "home" });
  const [previewCampus, setPreviewCampus] = useState(
    scope === "global" ? (campuses[0]?.id ?? "") : scope,
  );
  const [showcase, setShowcase] = useState<Showcase | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [resolvedPreview, setResolvedPreview] = useState<Showcase | null>(null);
  useEffect(
    () => () => {
      historyAbort.current?.abort();
      historyEpoch.current++;
    },
    [],
  );
  useEffect(() => {
    setHistoryPreview(null);
    setHistoryPage({ kind: "home" });
  }, [previewCampus]);
  const [images, setImages] = useState<ImageChoice[]>([]);
  const [resourceRevision, setResourceRevision] = useState(0);
  const noteRef = useRef(note);
  noteRef.current = note;
  const [overrides, setOverrides] = useState<string[]>(
    initial?.override_fields ??
      (scope === "global"
        ? Object.keys(defaultConfiguration(kind)).filter((k) => k !== "kind")
        : []),
  );
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const coordinatorRef = useRef<DraftCoordinator<ConfigurationContent> | null>(
    null,
  );
  if (!coordinatorRef.current)
    coordinatorRef.current = new DraftCoordinator(
      initial
        ? snapshot(initial)
        : {
            id: "",
            revision: 0,
            published_revision: 0,
            content: defaultConfiguration(kind),
          },
      {
        save: async (content, version) => {
          const current = recordRef.current;
          const partial = {
            kind,
            ...Object.fromEntries(
              Object.entries(content).filter(([key]) =>
                overridesRef.current.includes(key),
              ),
            ),
          };
          const result = await request<AdminConfiguration>(
            current ? `/configurations/${current.id}` : "/configurations",
            current ? "PUT" : "POST",
            current
              ? { ...version, content: partial, note: noteRef.current }
              : {
                  kind,
                  scope,
                  content: partial,
                  note: noteRef.current,
                  operation_id: version.operation_id,
                },
          );
          recordRef.current = result.data;
          setRecord(result.data);
          props.onSaved();
          return snapshot(result.data);
        },
        recover: async (operation_id) => {
          try {
            const operation = await request<{ result: AdminConfiguration }>(
              `/operations/${operation_id}`,
            );
            recordRef.current = operation.data.result;
            setRecord(operation.data.result);
            props.onSaved();
            return snapshot(operation.data.result);
          } catch (e) {
            if ((e as { status?: number }).status === 404) return null;
            throw e;
          }
        },
        latest: async () => {
          const row = (
            await request<AdminConfiguration>(
              `/configurations/${recordRef.current!.id}`,
            )
          ).data;
          recordRef.current = row;
          setRecord(row);
          return snapshot(row);
        },
      },
      { initialDirty: !initial },
    );
  const coordinator = coordinatorRef.current;
  const [draft, setDraft] = useState<DraftStatus<ConfigurationContent>>(
    coordinator.state,
  );
  useEffect(() => {
    const stop = coordinator.subscribe(setDraft);
    return () => {
      stop();
      coordinator.dispose();
    };
  }, [coordinator]);
  useEffect(() => {
    props.onDirty(
      draft.dirty,
      actionBusy ||
        !!pendingAction ||
        draft.phase === "saving" ||
        draft.phase === "uncertain",
    );
  }, [draft.dirty, draft.phase, actionBusy, pendingAction, props.onDirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        draft.dirty ||
        actionBusy ||
        pendingAction ||
        draft.phase === "uncertain"
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.dirty, draft.phase, pendingAction, actionBusy]);
  useEffect(() => {
    if (!previewCampus && campuses.length)
      setPreviewCampus(scope === "global" ? campuses[0].id : scope);
  }, [campuses, previewCampus, scope]);
  useEffect(() => {
    const controller = new AbortController();
    setShowcase(null);
    setPreviewError("");
    if (!previewCampus) return () => controller.abort();
    void Promise.all([
      get<Showcase>(
        `/campuses/${encodeURIComponent(previewCampus)}/showcase`,
        controller.signal,
      ),
      request<
        {
          id: string;
          campus_id: string;
          published_revision: number;
          published_content?: {
            kind: string;
            media_type?: string;
            title: string;
            url?: string | null;
          } | null;
        }[]
      >(
        "/experiences?kind=media&referenceable=true",
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([s, m]) => {
        if (controller.signal.aborted) return;
        setShowcase(s.data);
        setImages(
          m.data.flatMap((r) =>
            r.campus_id === previewCampus &&
            r.published_content?.kind === "media" &&
            r.published_content.media_type === "image"
              ? [
                  {
                    id: r.id,
                    revision: r.published_revision,
                    title: r.published_content.title,
                    campus_id: r.campus_id,
                    url:
                      r.published_content.url ||
                      `/api/v1/experiences/${r.id}/media`,
                  },
                ]
              : [],
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setPreviewError(
            "已发布资源或页面预览读取失败。你的草稿仍在，可重新读取。",
          );
      });
    return () => controller.abort();
  }, [previewCampus, resourceRevision]);
  const editable =
    !props.review &&
    !pendingAction &&
    record?.state !== "in_review" &&
    (record
      ? record.permissions.edit
      : props.session.permissions.includes(
          kind === "runtime" ? "runtime.edit" : "configurations.edit",
        ));
  const content = draft.value;
  function edit(next: ConfigurationContent) {
    if (!editable || actionBusy) return;
    const changed = Object.keys(next).filter(
      (key) =>
        key !== "kind" &&
        stableContent((next as unknown as Record<string, unknown>)[key]) !==
          stableContent(
            (coordinator.state.value as unknown as Record<string, unknown>)[
              key
            ],
          ),
    );
    overridesRef.current = [...new Set([...overridesRef.current, ...changed])];
    setOverrides(overridesRef.current);
    coordinator.retryValidation();
    coordinator.edit(next);
    setReport(null);
    setNotice("");
  }
  function overrideVisitFields(
    patch: Partial<import("./configurationTypes").VisitDefaultsContent>,
  ) {
    if (!editable || actionBusy || content.kind !== "visit_defaults") return;
    // Explicit null (fit) must remain an override even when the local default
    // was already null. Omission is the separate inherit operation.
    const fields = Object.keys(patch).filter((field) => field !== "kind");
    overridesRef.current = [...new Set([...overridesRef.current, ...fields])];
    setOverrides(overridesRef.current);
    edit({ ...content, ...patch });
    coordinator.forceDirty();
  }
  function inheritVisitField(field: string) {
    if (!editable || actionBusy) return;
    overridesRef.current = overridesRef.current.filter((key) => key !== field);
    setOverrides(overridesRef.current);
    coordinator.forceDirty();
    setReport(null);
  }
  async function flush() {
    coordinator.retryValidation();
    for (let i = 0; i < 3; i++) {
      if (await coordinator.flush()) return true;
      if (["error", "conflict", "uncertain"].includes(coordinator.state.phase))
        break;
    }
    return false;
  }
  async function action(
    name:
      | "preflight"
      | "submit"
      | "withdraw"
      | "publish"
      | "reject"
      | "checkpoint",
  ) {
    if (actionBusy || pendingAction) return;
    setError("");
    setActionBusy(true);
    try {
      if (draft.dirty && !(await flush()))
        throw new Error("请先确认草稿保存结果，再进行预检或审核。");
      const current = recordRef.current;
      if (!current) {
        if (!(await flush())) throw new Error("请先填写并保存草稿。");
        if (!recordRef.current) throw new Error("请先保存一份草稿。");
      }
      const row = recordRef.current!;
      const body = {
        expected_revision: row.revision,
        expected_published_revision: row.published_revision,
        note,
        operation_id: crypto.randomUUID(),
      };
      if (name === "preflight") {
        const r = await request<ConfigurationPreflight>(
          `/configurations/${row.id}/preflight`,
          "POST",
          body,
        );
        setReport(r.data);
        setNotice(
          r.data.valid
            ? "本次版本预检通过。提交和发布时服务端仍会复核依赖。"
            : "预检发现需要处理的字段。请按下方路径检查。",
        );
      } else {
        if (!note.trim())
          throw new Error("请填写操作说明，方便下一位成员理解这次变更。");
        const result = await confirmedOperation(
          body.operation_id,
          async () =>
            (
              await request<AdminConfiguration>(
                `/configurations/${row.id}/${name}`,
                "POST",
                body,
              )
            ).data,
          recoverAction,
        );
        recordRef.current = result;
        setRecord(result);
        coordinator.acceptExternal(snapshot(result));
        setNotice(
          name === "submit"
            ? "已提交，草稿冻结。请在审核中心由独立成员审核。"
            : name === "publish"
              ? "审核发布成功。"
              : name === "checkpoint"
                ? "已建立可恢复的历史检查点。"
                : "操作已完成。",
        );
        props.onSaved();
      }
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPendingAction(e.operationId);
      setError(message(e));
    } finally {
      setActionBusy(false);
    }
  }
  async function recoverAction(id: string): Promise<AdminConfiguration | null> {
    try {
      return (
        await request<{ result: AdminConfiguration }>(`/operations/${id}`)
      ).data.result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  async function queryPendingAction() {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    try {
      const row = await recoverAction(pendingAction);
      if (!row) throw new Error("本次操作尚未确认，请保留页面并稍后查询。");
      recordRef.current = row;
      setRecord(row);
      coordinator.acceptExternal(snapshot(row));
      setPendingAction(null);
      overridesRef.current =
        row.override_fields ??
        Object.keys(row.draft).filter((k) => k !== "kind");
      setOverrides(overridesRef.current);
      setError("");
      setNotice("已查询并核对本次操作结果。");
      props.onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setActionBusy(false);
    }
  }
  async function readHistory() {
    if (!recordRef.current || actionBusy) return;
    setActionBusy(true);
    try {
      setHistory(
        (
          await request<ConfigurationVersion[]>(
            `/configurations/${recordRef.current.id}/history`,
          )
        ).data,
      );
      setHistoryOpen(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setActionBusy(false);
    }
  }
  async function restore(version: ConfigurationVersion) {
    const row = recordRef.current;
    if (
      !row ||
      actionBusy ||
      pendingAction ||
      draft.phase === "uncertain" ||
      draft.phase === "saving"
    )
      return;
    if (
      !window.confirm(
        "将该历史内容建立为当前新草稿？本页未保存输入会被替换；不会恢复旧审核结论或恢复已暂停服务。",
      )
    )
      return;
    setActionBusy(true);
    try {
      const body = {
        expected_revision: row.revision,
        expected_published_revision: row.published_revision,
        note: note || "从历史建立新草稿",
        operation_id: crypto.randomUUID(),
      };
      const result = await confirmedOperation(
        body.operation_id,
        async () =>
          (
            await request<AdminConfiguration>(
              `/configurations/${row.id}/history/${version.id}/restore-draft`,
              "POST",
              body,
            )
          ).data,
        recoverAction,
      );
      recordRef.current = result;
      setRecord(result);
      overridesRef.current =
        result.override_fields ?? Object.keys(result.draft);
      setOverrides(overridesRef.current);
      coordinator.acceptExternal(snapshot(result));
      setReport(null);
      setHistoryOpen(false);
      setNotice("历史内容已成为新草稿，需要重新预检和独立审核。");
      props.onSaved();
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPendingAction(e.operationId);
      setError(message(e));
    } finally {
      setActionBusy(false);
    }
  }
  async function previewHistory(version: ConfigurationVersion) {
    const row = recordRef.current;
    if (
      !row ||
      actionBusy ||
      !previewCampus ||
      version.content.kind === "runtime"
    )
      return;
    historyAbort.current?.abort();
    const abort = new AbortController();
    historyAbort.current = abort;
    const epoch = ++historyEpoch.current;
    setActionBusy(true);
    setError("");
    setHistoryPreview(null);
    setHistoryPage({ kind: "home" });
    try {
      const result = await request<Showcase>(
        `/configurations/${row.id}/history/${version.id}/preview?${new URLSearchParams({ campus_id: previewCampus })}`,
        "GET",
        undefined,
        abort.signal,
      );
      if (!abort.signal.aborted && historyEpoch.current === epoch)
        setHistoryPreview({
          version,
          showcase: result.data,
          campusId: previewCampus,
        });
    } catch (error) {
      if (!abort.signal.aborted && historyEpoch.current === epoch)
        setError(message(error));
    } finally {
      if (historyEpoch.current === epoch) setActionBusy(false);
    }
  }
  const modules = content.kind === "presentation" ? content.modules : [];
  const selectedModule = modules.find((m) => m.id === moduleId) ?? modules[0];
  function updateModule(patch: Partial<PresentationModule>) {
    if (content.kind === "presentation" && selectedModule)
      edit({
        ...content,
        modules: modules.map((m) =>
          m.id === selectedModule.id ? { ...m, ...patch } : m,
        ),
      });
  }
  const preview = resolvedPreview;
  const previewContent = stableContent({
    kind,
    ...Object.fromEntries(
      Object.entries(content).filter(([key]) => overrides.includes(key)),
    ),
  });
  useEffect(() => {
    const controller = new AbortController();
    setResolvedPreview(null);
    if (!previewCampus || kind === "runtime") return () => controller.abort();
    const canPreviewInput =
      !props.review &&
      record?.state !== "in_review" &&
      (record?.permissions.edit ?? true);
    const timer = setTimeout(() => {
      const read = canPreviewInput
        ? request<Showcase>(
            "/configurations/preview",
            "POST",
            {
              kind,
              scope,
              content: JSON.parse(previewContent),
              campus_id: previewCampus,
            },
            controller.signal,
          )
        : record
          ? request<Showcase>(
              `/configurations/${record.id}/preview?${new URLSearchParams({ campus_id: previewCampus, expected_revision: String(record.revision) })}`,
              "GET",
              undefined,
              controller.signal,
            )
          : null;
      if (!read) return;
      void read
        .then((r) => {
          if (!controller.signal.aborted) {
            setResolvedPreview(r.data);
            setPreviewError("");
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setPreviewError(message(e));
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    kind,
    scope,
    previewCampus,
    previewContent,
    props.review,
    record?.id,
    record?.revision,
    record?.state,
    record?.permissions.edit,
    resourceRevision,
  ]);
  return (
    <div>
      <header className="ad-configuration-title">
        <h2>
          {configurationNames[kind]} ·{" "}
          {scope === "global"
            ? "全站默认"
            : campuses.find((c) => c.id === scope)?.name || "校区"}
        </h2>
        <p>
          {record
            ? `${stateNames[record.state]} · 已发布版本 ${record.published_revision}`
            : "尚未保存的新草稿"}
          {record?.state === "in_review" && " · 撤回后才能继续修改"}
        </p>
      </header>
      <DraftStatusBar
        state={draft}
        coordinator={coordinator}
        onResolve={(choice) => {
          if (choice === "server" && recordRef.current) {
            overridesRef.current =
              recordRef.current.override_fields ??
              Object.keys(recordRef.current.draft).filter((k) => k !== "kind");
            setOverrides(overridesRef.current);
          }
        }}
      />
      <ErrorBox text={error} />
      {pendingAction && (
        <button disabled={actionBusy} onClick={() => void queryPendingAction()}>
          查询本次审核／恢复操作结果
        </button>
      )}
      {notice && (
        <p role="status" className="ad-notice">
          {notice}
        </p>
      )}
      <div
        className={`ad-config-grid${content.kind !== "presentation" ? " without-modules" : ""}`}
      >
        {content.kind === "presentation" && (
          <aside className="ad-card ad-module-list">
            <h3>1. 页面模块</h3>
            <p>按钮可用键盘排序。主视觉、路线与资源入口均由你明确选择。</p>
            {modules.map((m, i) => (
              <div key={m.id} className="ad-module-item">
                <button
                  aria-pressed={selectedModule?.id === m.id}
                  onClick={() => setModuleId(m.id)}
                >
                  {moduleNames[m.type]}
                  {!m.enabled && " · 已隐藏"}
                </button>
                <div>
                  <button
                    disabled={!editable || i === 0}
                    aria-label={`${moduleNames[m.type]}上移`}
                    onClick={() => {
                      const next = [...modules];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      edit({ ...content, modules: next });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    disabled={!editable || i === modules.length - 1}
                    aria-label={`${moduleNames[m.type]}下移`}
                    onClick={() => {
                      const next = [...modules];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      edit({ ...content, modules: next });
                    }}
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
            <label>
              添加固定模块
              <select
                value=""
                disabled={!editable || modules.length >= 30}
                onChange={(e) => {
                  const m = newModule(e.target.value as ModuleType);
                  edit({ ...content, modules: [...modules, m] });
                  setModuleId(m.id);
                }}
              >
                <option value="">请选择模块</option>
                {Object.entries(moduleNames)
                  .filter(
                    ([type]) =>
                      ["announcement", "introduction"].includes(type) ||
                      !modules.some((m) => m.type === type),
                  )
                  .map(([type, label]) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
          </aside>
        )}
        <section className="ad-card ad-config-preview">
          <h3>2. 私有实时预览</h3>
          <div className="ad-preview-tools">
            <label>
              校区
              <select
                value={previewCampus}
                disabled={actionBusy}
                onChange={(e) => setPreviewCampus(e.target.value)}
              >
                {campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              aria-pressed={previewSize === "desktop"}
              onClick={() => setPreviewSize("desktop")}
            >
              电脑
            </button>
            <button
              aria-pressed={previewSize === "mobile"}
              onClick={() => setPreviewSize("mobile")}
            >
              手机
            </button>
            <button onClick={() => setPreviewPage({ kind: "home" })}>
              回到首页
            </button>
            <button onClick={() => setResourceRevision((v) => v + 1)}>
              更新已发布资源
            </button>
          </div>
          <ErrorBox text={previewError} />
          <div className={`ad-preview-viewport ${previewSize}`}>
            {preview ? (
              previewPage.kind === "home" ? (
                <ExhibitionHome
                  previewOnly
                  showcase={preview}
                  campusName={
                    campuses.find((c) => c.id === previewCampus)?.name ?? "校区"
                  }
                  onNavigate={setPreviewPage}
                />
              ) : previewPage.kind === "tours" ? (
                <TourCatalog showcase={preview} onNavigate={setPreviewPage} />
              ) : (
                <div className="ad-preview-destination">
                  <p>
                    该入口指向：
                    {previewPage.kind === "overview"
                      ? showcase?.routes.find(
                          (r) => r.id === previewPage.tourId,
                        )?.title || "路线"
                      : previewPage.kind === "panoramas"
                        ? "VR 全景目录"
                        : "校园地图"}
                    。
                  </p>
                  <p>
                    页面编排预览不会打开外站、调用服务商或写入你的参观进度。路线详细预览请在路线工作台使用同一参观组件。
                  </p>
                  <button onClick={() => setPreviewPage({ kind: "home" })}>
                    回到首页
                  </button>
                </div>
              )
            ) : (
              <p role="status">正在读取公开素材…</p>
            )}
          </div>
          <small>预览内容只保留在本页，不生成公开草稿网址。</small>
        </section>
        <section className="ad-card ad-config-fields">
          <h3>3. 字段与说明</h3>
          <fieldset disabled={!editable || actionBusy}>
            <details>
              <summary>继承与覆盖 · 未覆盖字段使用全站／系统默认</summary>
              <p>
                改动字段后会自动成为本范围的覆盖。关闭覆盖会恢复默认，整个模块列表作为一个字段替换。
              </p>
              {Object.keys(content)
                .filter((key) => key !== "kind")
                .map((key) => (
                  <label className="ad-check" key={key}>
                    <input
                      type="checkbox"
                      checked={overrides.includes(key)}
                      onChange={(e) => {
                        const fields = e.target.checked
                          ? [...new Set([...overridesRef.current, key])]
                          : overridesRef.current.filter((k) => k !== key);
                        overridesRef.current = fields;
                        setOverrides(fields);
                        coordinator.forceDirty();
                        setReport(null);
                      }}
                    />
                    覆盖 {fieldNames[key] || runtimeLabels[key] || key}
                  </label>
                ))}
            </details>
            {content.kind === "presentation" && (
              <>
                <details open={!selectedModule}>
                  <summary>全站文字与外观</summary>
                  <label>
                    站点名称
                    <input
                      maxLength={120}
                      value={content.site_name}
                      onChange={(e) =>
                        edit({ ...content, site_name: e.target.value })
                      }
                    />
                    <small>
                      显示在首页校区名称旁；默认“南开校园文化导览”。
                    </small>
                  </label>
                  {(["description", "footer", "contact_help"] as const).map(
                    (key) => (
                      <label key={key}>
                        {
                          {
                            description: "网站介绍",
                            footer: "页脚说明",
                            contact_help: "联系与帮助",
                          }[key]
                        }
                        <textarea
                          maxLength={1000}
                          value={content[key]}
                          onChange={(e) =>
                            edit({ ...content, [key]: e.target.value })
                          }
                        />
                        <small>填写团队核实的说明；留空不会编造文字。</small>
                      </label>
                    ),
                  )}
                  {(["palette", "density", "radius"] as const).map((key) => (
                    <label key={key}>
                      {
                        {
                          palette: "颜色主题",
                          density: "排版密度",
                          radius: "边角样式",
                        }[key]
                      }
                      <select
                        value={content.appearance[key]}
                        onChange={(e) =>
                          edit({
                            ...content,
                            appearance: {
                              ...content.appearance,
                              [key]: e.target.value,
                            },
                          })
                        }
                      >
                        {{
                          palette: [
                            ["nku-purple", "南开紫"],
                            ["light-purple", "浅紫"],
                          ],
                          density: [
                            ["comfortable", "舒适"],
                            ["compact", "紧凑"],
                          ],
                          radius: [
                            ["soft", "柔和"],
                            ["square", "方正"],
                          ],
                        }[key].map(([v, t]) => (
                          <option key={v} value={v}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </details>
                {selectedModule && (
                  <>
                    <h4>{moduleNames[selectedModule.type]}</h4>
                    <label className="ad-check">
                      <input
                        type="checkbox"
                        checked={selectedModule.enabled}
                        onChange={(e) =>
                          updateModule({ enabled: e.target.checked })
                        }
                      />
                      显示该模块
                    </label>
                    <label>
                      标题
                      <input
                        maxLength={120}
                        value={selectedModule.title}
                        onChange={(e) =>
                          updateModule({ title: e.target.value })
                        }
                      />
                      <small>
                        显示在该模块顶部；留空沿用该模块中性默认文字。
                      </small>
                    </label>
                    <label>
                      正文
                      <textarea
                        rows={5}
                        maxLength={4000}
                        value={selectedModule.body}
                        onChange={(e) => updateModule({ body: e.target.value })}
                      />
                    </label>
                    {selectedModule.type === "hero" && (
                      <label>
                        入口按钮文字
                        <input
                          maxLength={40}
                          value={selectedModule.button_label ?? "开始发现"}
                          onChange={(e) =>
                            updateModule({ button_label: e.target.value })
                          }
                        />
                        <small>按钮去向由下方入口设置决定。</small>
                      </label>
                    )}
                    <label>
                      模块布局
                      <select
                        value={selectedModule.layout}
                        onChange={(e) =>
                          updateModule({
                            layout: e.target
                              .value as PresentationModule["layout"],
                          })
                        }
                      >
                        <option value="default">默认</option>
                        <option value="wide">宽幅</option>
                        <option value="split">图文分栏</option>
                      </select>
                    </label>
                    <label>
                      主视觉图片
                      <select
                        value={
                          selectedModule.image
                            ? `${selectedModule.image.id}:${selectedModule.image.revision}`
                            : ""
                        }
                        onChange={(e) => {
                          const image = images.find(
                            (i) => `${i.id}:${i.revision}` === e.target.value,
                          );
                          updateModule({
                            image: image
                              ? {
                                  type: "image",
                                  id: image.id,
                                  revision: image.revision,
                                }
                              : null,
                          });
                        }}
                      >
                        <option value="">简洁文字视觉，不选图片</option>
                        {selectedModule.image &&
                          !images.some(
                            (i) =>
                              i.id === selectedModule.image?.id &&
                              i.revision === selectedModule.image.revision,
                          ) && (
                            <option
                              value={`${selectedModule.image.id}:${selectedModule.image.revision}`}
                            >
                              原图片版本已变更，请核对后选择
                            </option>
                          )}
                        {images.map((i) => (
                          <option key={i.id} value={`${i.id}:${i.revision}`}>
                            {i.title} · v{i.revision}
                          </option>
                        ))}
                      </select>
                      <small>
                        只使用该校区已发布图片。不会自动选择第一张。
                      </small>
                    </label>
                    <label>
                      图片文字替代
                      <input
                        maxLength={500}
                        value={selectedModule.alt}
                        onChange={(e) => updateModule({ alt: e.target.value })}
                      />
                      <small>
                        向无法看图的访客描述图片内容，避免重复旁边标题。
                      </small>
                    </label>
                    {(["x", "y"] as const).map((axis) => (
                      <label key={axis}>
                        裁切焦点 · {axis === "x" ? "水平" : "垂直"}
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={selectedModule.image_focus[axis]}
                          onChange={(e) =>
                            updateModule({
                              image_focus: {
                                ...selectedModule.image_focus,
                                [axis]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    <label>
                      入口目标
                      <select
                        value={
                          selectedModule.target?.type === "tour"
                            ? `${selectedModule.target.id}:${selectedModule.target.revision}`
                            : (selectedModule.target?.type ?? "")
                        }
                        onChange={(e) => {
                          const route = showcase?.routes.find(
                            (r) => `${r.id}:${r.revision}` === e.target.value,
                          );
                          updateModule({
                            target: route
                              ? {
                                  type: "tour",
                                  id: route.id,
                                  revision: route.revision,
                                }
                              : e.target.value
                                ? {
                                    type: e.target.value as
                                      | "home"
                                      | "map"
                                      | "vr"
                                      | "routes",
                                  }
                                : null,
                          });
                        }}
                      >
                        <option value="">默认路线目录</option>
                        <option value="home">首页</option>
                        <option value="map">校园地图</option>
                        <option value="vr">VR 全景目录</option>
                        <option value="routes">全部路线</option>
                        {showcase?.routes.map((r) => (
                          <option key={r.id} value={`${r.id}:${r.revision}`}>
                            {r.title} · v{r.revision}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedModule.type === "featured_routes" && (
                      <div>
                        <p>推荐路线 · 按下方顺序展示</p>
                        {selectedModule.routes.map((r, i) => (
                          <div key={r.id}>
                            {showcase?.routes.find(
                              (s) => s.id === r.id && s.revision === r.revision,
                            )?.title || "路线版本已变更，请核对"}{" "}
                            · v{r.revision}
                            <button
                              type="button"
                              disabled={i === 0}
                              aria-label={`上移推荐路线 ${i + 1}`}
                              onClick={() => {
                                const routes = [...selectedModule.routes];
                                [routes[i - 1], routes[i]] = [
                                  routes[i],
                                  routes[i - 1],
                                ];
                                updateModule({ routes });
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={i === selectedModule.routes.length - 1}
                              aria-label={`下移推荐路线 ${i + 1}`}
                              onClick={() => {
                                const routes = [...selectedModule.routes];
                                [routes[i + 1], routes[i]] = [
                                  routes[i],
                                  routes[i + 1],
                                ];
                                updateModule({ routes });
                              }}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateModule({
                                  routes: selectedModule.routes.filter(
                                    (_, j) => i !== j,
                                  ),
                                })
                              }
                            >
                              移除
                            </button>
                          </div>
                        ))}
                        <select
                          value=""
                          onChange={(e) => {
                            const route = showcase?.routes.find(
                              (r) => r.id === e.target.value,
                            );
                            if (route)
                              updateModule({
                                routes: [
                                  ...selectedModule.routes,
                                  {
                                    type: "tour",
                                    id: route.id,
                                    revision: route.revision,
                                  },
                                ],
                              });
                          }}
                        >
                          <option value="">添加已发布路线</option>
                          {showcase?.routes
                            .filter(
                              (r) =>
                                !selectedModule.routes.some(
                                  (ref) => ref.id === r.id,
                                ),
                            )
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.title}
                              </option>
                            ))}
                        </select>
                        <small>未选择时不自动推荐第一条路线。</small>
                      </div>
                    )}
                    {selectedModule.type === "announcement" && (
                      <>
                        {(["start_at", "end_at"] as const).map((key) => (
                          <label key={key}>
                            {key === "start_at" ? "开始显示" : "结束显示"}
                            <input
                              type="datetime-local"
                              value={beijingDateTimeInput(selectedModule[key])}
                              onChange={(e) =>
                                updateModule({
                                  [key]: beijingDateTimeUtc(e.target.value),
                                })
                              }
                            />
                            <small>
                              北京时间（UTC+8），与编辑设备所在时区无关；留空不限制时间。正式展示由服务器时间判断。
                            </small>
                          </label>
                        ))}
                      </>
                    )}
                    <label>
                      来源网址
                      <input
                        type="url"
                        value={selectedModule.source_url ?? ""}
                        onChange={(e) =>
                          updateModule({ source_url: e.target.value || null })
                        }
                        placeholder="https://…"
                      />
                      <small>
                        只填写可核验的 HTTPS 来源，不会由预览自动访问。
                      </small>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm("移除此模块？可通过历史草稿恢复。"))
                          edit({
                            ...content,
                            modules: modules.filter(
                              (m) => m.id !== selectedModule.id,
                            ),
                          });
                      }}
                    >
                      移除模块
                    </button>
                  </>
                )}
              </>
            )}
            {content.kind === "visit_defaults" && (
              <>
                <label>
                  默认布局
                  <select
                    value={content.layout}
                    onChange={(e) =>
                      edit({
                        ...content,
                        layout: e.target.value as typeof content.layout,
                      })
                    }
                  >
                    <option value="balanced">画面与文字平衡</option>
                    <option value="scene_first">画面优先</option>
                    <option value="reading_first">阅读优先</option>
                  </select>
                  <small>访客仍可按自己的需要切换布局。</small>
                </label>
                <label className="ad-check">
                  <input
                    type="checkbox"
                    checked={content.assistant_collapsed}
                    onChange={(e) =>
                      edit({
                        ...content,
                        assistant_collapsed: e.target.checked,
                      })
                    }
                  />
                  小开初始收起
                </label>
                <label>
                  欢迎文字
                  <textarea
                    maxLength={500}
                    value={content.welcome_text}
                    onChange={(e) =>
                      edit({ ...content, welcome_text: e.target.value })
                    }
                  />
                </label>
                <label>
                  建议问题 · 每行一个，最多六个
                  <textarea
                    rows={6}
                    value={content.recommended_questions.join("\n")}
                    onChange={(e) =>
                      edit({
                        ...content,
                        recommended_questions: e.target.value
                          .split("\n")
                          .filter(Boolean)
                          .slice(0, 6),
                      })
                    }
                  />
                </label>
                <fieldset className="ad-config-category-fields">
                  <legend>地图分类优先顺序</legend>
                  <small>
                    选择优先出现的分类并上下调整。未选择的合法分类仍排在其后，访客可以筛选；不会隐藏地点。
                  </small>
                  <small>
                    {overrides.includes("map_categories")
                      ? "本范围草稿覆盖"
                      : preview?.visit_default_sources?.map_categories ===
                          "global"
                        ? "继承已审全站设置"
                        : preview?.visit_default_sources?.map_categories ===
                            "builtin"
                          ? "继承系统默认"
                          : "正在核对继承来源"}
                  </small>
                  <ol className="ad-category-order">
                    {(overrides.includes("map_categories")
                      ? content.map_categories
                      : (preview?.visit_defaults.map_categories ??
                        content.map_categories)
                    )
                      .filter((category) => category in categoryNames)
                      .map((category, index, ordered) => (
                        <li key={category}>
                          <span>
                            {
                              categoryNames[
                                category as keyof typeof categoryNames
                              ]
                            }
                          </span>
                          <button
                            type="button"
                            aria-label={`上移${categoryNames[category as keyof typeof categoryNames]}`}
                            disabled={index === 0}
                            onClick={() => {
                              const next = [...ordered];
                              [next[index - 1], next[index]] = [
                                next[index],
                                next[index - 1],
                              ];
                              overrideVisitFields({ map_categories: next });
                            }}
                          >
                            上移
                          </button>
                          <button
                            type="button"
                            aria-label={`下移${categoryNames[category as keyof typeof categoryNames]}`}
                            disabled={index === ordered.length - 1}
                            onClick={() => {
                              const next = [...ordered];
                              [next[index], next[index + 1]] = [
                                next[index + 1],
                                next[index],
                              ];
                              overrideVisitFields({ map_categories: next });
                            }}
                          >
                            下移
                          </button>
                        </li>
                      ))}
                  </ol>
                  {Object.entries(categoryNames).map(([category, label]) => (
                    <label className="ad-check" key={category}>
                      <input
                        type="checkbox"
                        checked={(overrides.includes("map_categories")
                          ? content.map_categories
                          : (preview?.visit_defaults.map_categories ??
                            content.map_categories)
                        ).includes(category)}
                        onChange={(e) =>
                          overrideVisitFields({
                            map_categories: e.target.checked
                              ? [
                                  ...new Set([
                                    ...(overrides.includes("map_categories")
                                      ? content.map_categories
                                      : (preview?.visit_defaults
                                          .map_categories ??
                                        content.map_categories)),
                                    category,
                                  ]),
                                ]
                              : (overrides.includes("map_categories")
                                  ? content.map_categories
                                  : (preview?.visit_defaults.map_categories ??
                                    content.map_categories)
                                ).filter((c) => c !== category),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={!overrides.includes("map_categories")}
                    onClick={() => inheritVisitField("map_categories")}
                  >
                    恢复继承分类顺序
                  </button>
                </fieldset>
              </>
            )}
            {content.kind === "runtime" && (
              <>
                <p>
                  开关和额度需独立审核。保存、预览和预检不会调用收费服务；紧急暂停与恢复分别处理。
                </p>
                {(
                  [
                    "chat_enabled",
                    "voice_enabled",
                    "narration_generation_enabled",
                    "narration_playback_enabled",
                    "navigation_enabled",
                    "auto_actions",
                  ] as const
                ).map((key) => (
                  <label className="ad-check" key={key}>
                    <input
                      type="checkbox"
                      checked={content[key] as boolean}
                      onChange={(e) =>
                        edit({ ...content, [key]: e.target.checked })
                      }
                    />
                    {
                      {
                        chat_enabled: "学校智能问答",
                        voice_enabled: "问答语音",
                        narration_generation_enabled: "正式讲解音频生成",
                        narration_playback_enabled: "正式讲解音频播放",
                        navigation_enabled: "到校导航",
                        auto_actions: "允许小开执行已核验的明确操作",
                      }[key]
                    }
                  </label>
                ))}
                <details>
                  <summary>服务额度与操作范围</summary>
                  {Object.entries(content)
                    .filter(([, v]) => typeof v === "number")
                    .map(([key, value]) => (
                      <label key={key}>
                        {runtimeLabels[key] || key}
                        <input
                          type="number"
                          min={1}
                          value={value as number}
                          onChange={(e) =>
                            edit({ ...content, [key]: Number(e.target.value) })
                          }
                        />
                        <small>
                          服务端仍受部署硬上限约束，表单不能恢复已暂停服务。
                        </small>
                      </label>
                    ))}
                  {[
                    "focus_point",
                    "show_floor",
                    "open_vr",
                    "show_route",
                    "show_checkin",
                    "play_video",
                    "show_tour",
                  ].map((value) => (
                    <label className="ad-check" key={value}>
                      <input
                        type="checkbox"
                        checked={content.allowed_actions.includes(value)}
                        onChange={(e) =>
                          edit({
                            ...content,
                            allowed_actions: e.target.checked
                              ? [...content.allowed_actions, value]
                              : content.allowed_actions.filter(
                                  (v) => v !== value,
                                ),
                          })
                        }
                      />
                      {actionLabels[value]}
                    </label>
                  ))}
                </details>
              </>
            )}
          </fieldset>
          {content.kind === "visit_defaults" && (
            <MapDefaultsEditor
              campusId={previewCampus}
              scope={scope}
              value={content}
              effective={preview?.visit_defaults}
              sources={preview?.visit_default_sources}
              overrides={overrides}
              disabled={!editable || actionBusy}
              onChange={overrideVisitFields}
              onInherit={inheritVisitField}
            />
          )}
        </section>
      </div>
      <section className="ad-card ad-config-actions">
        <label>
          变更／审核说明
          <textarea
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="说明这次改了什么、依据是什么，方便另一位成员审核"
          />
        </label>
        <div>
          {editable && (
            <>
              <button
                disabled={
                  actionBusy ||
                  draft.phase === "uncertain" ||
                  draft.phase === "conflict"
                }
                onClick={() => void flush()}
              >
                立即保存
              </button>
              <button
                disabled={actionBusy}
                onClick={() => void action("checkpoint")}
              >
                建立历史检查点
              </button>
              <button
                disabled={actionBusy}
                onClick={() => void action("preflight")}
              >
                检查当前版本
              </button>
              <button
                disabled={actionBusy || !note.trim()}
                onClick={() => void action("submit")}
              >
                保存并提交审核
              </button>
            </>
          )}
          {record?.state === "in_review" &&
            !props.review &&
            record.permissions.edit && (
              <button
                disabled={actionBusy || !note.trim()}
                onClick={() => void action("withdraw")}
              >
                撤回后继续编辑
              </button>
            )}
          {record && (
            <button disabled={actionBusy} onClick={() => void readHistory()}>
              查看历史与恢复草稿
            </button>
          )}
          {record && props.onReview && (
            <button onClick={() => props.onReview?.(record.id)}>
              前往统一审核中心
            </button>
          )}
          {props.review &&
            record?.state === "in_review" &&
            record.permissions.review && (
              <>
                <button
                  disabled={actionBusy}
                  onClick={() => void action("preflight")}
                >
                  复核预检
                </button>
                <button
                  disabled={
                    actionBusy ||
                    !note.trim() ||
                    record.contributor_ids.includes(props.session.user.id) ||
                    record.submitted_by === props.session.user.id
                  }
                  onClick={() => void action("publish")}
                >
                  审核通过并发布
                </button>
                <button
                  disabled={
                    actionBusy ||
                    !note.trim() ||
                    record.contributor_ids.includes(props.session.user.id) ||
                    record.submitted_by === props.session.user.id
                  }
                  onClick={() => void action("reject")}
                >
                  退回修改
                </button>
                <p>
                  本次贡献者及提交人不能自审；恢复服务和运行配置发布仍需近期通行密钥验证。
                </p>
              </>
            )}
        </div>
      </section>
      {report && (
        <section
          className="ad-card ad-preflight-report"
          aria-label="当前版本检查报告"
        >
          <h3>
            {report.valid ? "预检通过" : "需要处理"} · 草稿 v{report.revision}
          </h3>
          <p>
            内容指纹 {report.content_sha256} · 依赖指纹{" "}
            {report.dependency_sha256}
          </p>
          {report.issues.map((i, n) => (
            <p key={n} role={i.severity === "error" ? "alert" : undefined}>
              <strong>
                {i.severity === "error" ? "阻断" : "提示"} · {i.path}
              </strong>
              ：{i.message}
              {i.expected_revision != null &&
                ` · 引用 v${i.expected_revision} / 当前 v${i.actual_revision ?? "不可用"}`}
            </p>
          ))}
          <small>任何字段修改都会使此报告失效；发布时服务端重新核验。</small>
        </section>
      )}
      {historyOpen && (
        <section className="ad-card ad-history" aria-label="历史草稿">
          <h3>历史与恢复</h3>
          <button onClick={() => setHistoryOpen(false)}>收起历史</button>
          {history.length ? (
            history.map((v) => (
              <details key={v.id}>
                <summary>
                  {new Date(v.created_at).toLocaleString("zh-CN")} ·{" "}
                  {historyEventNames[v.event] || "保存版本"} · 草稿 v
                  {v.revision} / 发布 v{v.published_revision}
                </summary>
                <p>{configurationSummary(v.content)}</p>
                <p>
                  当时明确覆盖：
                  {v.override_fields?.length
                    ? v.override_fields
                        .map((f) => fieldNames[f] || f)
                        .join("、")
                    : "沿用上层设置"}
                  。恢复后仍为私有草稿，需要重新预检和独立审核。
                </p>
                {v.content.kind === "presentation" && (
                  <ol>
                    {v.content.modules.map((m) => (
                      <li key={m.id}>
                        {moduleNames[m.type]} · {m.title || "默认标题"} ·{" "}
                        {m.enabled ? "显示" : "隐藏"}
                        {m.image ? " · 已选择图片" : ""}
                        {m.routes.length
                          ? ` · ${m.routes.length} 条推荐路线`
                          : ""}
                      </li>
                    ))}
                  </ol>
                )}
                <details>
                  <summary>版本核对信息</summary>
                  <p>内容指纹 {v.content_sha256}</p>
                  <pre>{JSON.stringify(v.content, null, 2)}</pre>
                </details>
                {v.content.kind !== "runtime" && (
                  <button
                    disabled={actionBusy || !previewCampus}
                    onClick={() => void previewHistory(v)}
                  >
                    用此历史配置私有预览
                  </button>
                )}
                <button
                  disabled={!editable || actionBusy}
                  onClick={() => void restore(v)}
                >
                  恢复为新草稿
                </button>
              </details>
            ))
          ) : (
            <p>
              尚无历史检查点。自动保存不是每次都建立快照，编辑活动每五分钟及提审／审核等操作会建立版本。
            </p>
          )}
        </section>
      )}
      {historyPreview && (
        <section
          className="ad-card ad-config-preview"
          aria-label="历史配置私有预览"
        >
          <h3>历史草稿 v{historyPreview.version.revision} 的私有效果</h3>
          <p>
            此历史明确覆盖字段叠加当前正式继承层；不会重放当年的其他配置、发布或写入参观记录。旧素材是否可用仍按当前授权与公开状态核验。
          </p>
          <button
            disabled={actionBusy}
            onClick={() => {
              historyAbort.current?.abort();
              historyEpoch.current++;
              setHistoryPreview(null);
            }}
          >
            关闭历史预览
          </button>
          <button onClick={() => setHistoryPage({ kind: "home" })}>
            历史预览回到首页
          </button>
          <div className={`ad-preview-viewport ${previewSize}`}>
            {historyPage.kind === "home" ? (
              <ExhibitionHome
                previewOnly
                showcase={historyPreview.showcase}
                campusName={
                  campuses.find(
                    (campus) => campus.id === historyPreview.campusId,
                  )?.name ?? "校区"
                }
                onNavigate={setHistoryPage}
              />
            ) : historyPage.kind === "tours" ? (
              <TourCatalog
                showcase={historyPreview.showcase}
                onNavigate={setHistoryPage}
              />
            ) : (
              <p>
                该按钮的站内目标已按历史配置显示。详细地图与路线请在相应工作台检查；本历史预览不离开后台或打开外站。
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
const actionLabels: Record<string, string> = {
  focus_point: "定位地图地点",
  show_floor: "查看楼层",
  open_vr: "打开官方 VR",
  show_route: "计算到校道路",
  show_checkin: "查看打卡参考",
  play_video: "播放已发布视频",
  show_tour: "打开主题路线",
};
const runtimeLabels: Record<string, string> = {
  visitor_turns_per_hour: "单次参观每小时问答",
  total_turns_per_hour: "全站每小时问答",
  model_requests_per_day: "每日模型请求",
  voice_visitor_requests_per_hour: "单次参观每小时语音",
  voice_total_requests_per_hour: "全站每小时语音",
  voice_requests_per_day: "每日语音请求",
  supplier_requests_per_day: "每日供应商总请求",
  supplier_characters_per_day: "每日合成字符",
  supplier_session_requests_per_day: "单次参观每日供应商请求",
  ip_requests_per_hour: "每个网络来源每小时请求",
  ip_requests_per_day: "每个网络来源每日请求",
  http_requests_per_hour: "每小时 HTTP 请求",
  http_requests_per_day: "每日 HTTP 请求",
};
const fieldNames: Record<string, string> = {
  site_name: "站点名称",
  description: "网站介绍",
  footer: "页脚",
  contact_help: "联系与帮助",
  appearance: "外观",
  modules: "完整模块列表",
  layout: "参观布局",
  assistant_collapsed: "小开初始状态",
  welcome_text: "欢迎文字",
  recommended_questions: "建议问题",
  map_categories: "地图分类顺序",
  map_show_labels: "地图名称",
  map_default_view: "默认地图视角",
  map_layers: "地图区域覆盖层",
  map_focus_effect: "地图定位效果",
  chat_enabled: "学校问答",
  voice_enabled: "问答语音",
  narration_generation_enabled: "讲解生成",
  narration_playback_enabled: "讲解播放",
  navigation_enabled: "导航",
  auto_actions: "明确动作",
  allowed_actions: "操作范围",
  profile_id: "音色配置",
};
const categoryNames = {
  public_area: "公共区域",
  patriotic: "爱国教育",
  academic: "教学科研",
  residence: "生活住宿",
  dining: "餐饮",
  commerce: "商业服务",
  landscape: "自然景观",
  history: "历史文化",
};
const historyEventNames: Record<string, string> = {
  created: "创建草稿",
  create: "创建草稿",
  autosave: "编辑检查点",
  checkpoint: "手动检查点",
  submit: "提交审核",
  publish: "审核发布",
  reject: "退回修改",
  withdraw: "撤回草稿",
  restore: "历史恢复",
  restore_draft: "历史恢复",
};
function configurationSummary(content: ConfigurationContent): string {
  if (content.kind === "presentation")
    return `${content.site_name || "默认站点名称"} · ${content.modules.length} 个模块 · ${content.modules.filter((m) => m.enabled).length} 个显示`;
  if (content.kind === "visit_defaults")
    return `${{ balanced: "画面与文字平衡", scene_first: "画面优先", reading_first: "阅读优先" }[content.layout]} · 小开${content.assistant_collapsed ? "收起" : "展开"} · ${content.recommended_questions.length} 个建议问题`;
  return `学校问答${content.chat_enabled ? "允许" : "关闭"} · 问答语音${content.voice_enabled ? "允许" : "关闭"} · 正式讲解生成${content.narration_generation_enabled ? "允许" : "关闭"}`;
}
