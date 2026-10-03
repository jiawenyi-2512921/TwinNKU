import { useEffect, useRef, useState } from "react";
import { message, request, type StaffSession } from "./api";
import { ErrorBox, useResource } from "./ui";
import { ConfigurationWorkspace } from "./ConfigurationWorkspace";
import type { AdminConfiguration, RuntimeContent } from "./configurationTypes";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import type { WorkbenchIssue } from "./WorkspaceIssues";
type Service =
  | "chat"
  | "voice"
  | "narration_generation"
  | "narration_playback"
  | "navigation";
type Controls = {
  published_revision: number;
  approved: RuntimeContent;
  effective: RuntimeContent;
  deployment_allowed: Record<Service, boolean>;
  stops: Record<
    Service,
    { revision: number; stopped: boolean; reason: string; updated_at: string }
  >;
  permissions: { edit: boolean; review: boolean };
  provider_connectivity: "not_verified";
  narration_storage?: {
    used_bytes: number | null;
    maximum_bytes: number;
    unadopted_retention_days: number;
    state: "ok" | "warning" | "full" | "unavailable";
  };
};
const services: Record<Service, string> = {
  chat: "学校智能问答",
  voice: "问答语音",
  narration_generation: "正式讲解生成",
  narration_playback: "正式讲解播放",
  navigation: "到校道路导航",
};
const keys: Record<Service, string> = {
  chat: "chat_enabled",
  voice: "voice_enabled",
  narration_generation: "narration_generation_enabled",
  narration_playback: "narration_playback_enabled",
  navigation: "navigation_enabled",
};
export function GuideSettings({
  session,
  onDirty,
  onUpdate,
  onReview,
  initialId,
  initialIssue,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  onReview?: (id: string) => void;
  initialId?: string;
  initialIssue?: WorkbenchIssue;
}) {
  const [revision, setRevision] = useState(0),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{
    id: string;
    action: "pause" | "resume-request";
  } | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const controls = useResource<Controls>("/service-controls", revision);
  const configStatus = useRef({ dirty: false, busy: false });
  const [configTick, setConfigTick] = useState(0);
  useEffect(() => {
    onDirty(
      configStatus.current.dirty,
      busy || !!pending || configStatus.current.busy,
    );
  }, [busy, pending, onDirty, configTick]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy || pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, pending]);
  async function recover(
    id: string,
  ): Promise<AdminConfiguration | Controls | null> {
    try {
      return (
        await request<{ result: AdminConfiguration | Controls }>(
          `/operations/${id}`,
        )
      ).data.result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  function acknowledge(
    data: AdminConfiguration | Controls,
    action: "pause" | "resume-request",
  ) {
    setNotice(
      action === "pause"
        ? "已立即暂停。恢复需要新的独立审核。"
        : "已建立恢复草稿。请保存并提交审核；旧版本发布不会解除暂停。",
    );
    setRevision((v) => v + 1);
    onUpdate?.();
    if (action === "resume-request" && "id" in data) setResumeId(data.id);
  }
  async function queryPending() {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await recover(pending.id);
      if (!result)
        throw new Error(
          "本次结果仍未确认，请稍后再次查询，不要重复暂停／恢复申请。",
        );
      setPending(null);
      acknowledge(result, pending.action);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function operate(service: Service, action: "pause" | "resume-request") {
    if (
      busy ||
      pending ||
      configStatus.current.busy ||
      (action === "resume-request" && configStatus.current.dirty) ||
      !note.trim()
    )
      return;
    if (
      !window.confirm(
        action === "pause"
          ? `暂停${services[service]}？会立即影响该服务；其他资料继续可用。`
          : `申请恢复${services[service]}？需要独立审核且服务器部署开关允许。`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const operationId = crypto.randomUUID();
    try {
      const data = await confirmedOperation(
        operationId,
        async () =>
          (
            await request<AdminConfiguration | Controls>(
              `/service-controls/${service}/${action}`,
              "POST",
              { note, operation_id: operationId },
            )
          ).data,
        recover,
      );
      acknowledge(data, action);
    } catch (e) {
      if (e instanceof UnconfirmedOperation)
        setPending({ id: operationId, action });
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="ad-card ad-config-actions">
        <h2>服务状态与紧急暂停</h2>
        <p>
          状态取自服务器：审核允许、部署允许及人工暂停共同决定实际开关。供应商连通性尚未实测，开启开关不代表服务可达。
        </p>
        <ErrorBox
          text={controls.error || error}
          onRetry={() => setRevision((v) => v + 1)}
        />
        {controls.data?.data.narration_storage && (
          <div
            role={
              controls.data.data.narration_storage.state === "ok"
                ? "status"
                : "alert"
            }
            className="ad-storage-status"
          >
            <strong>正式讲解存储</strong>
            <p>
              {controls.data.data.narration_storage.state === "unavailable"
                ? "当前容量无法核验，新增生成会按服务端规则暂停。请检查存储后再操作。"
                : `已用 ${((controls.data.data.narration_storage.used_bytes ?? 0) / 1024 / 1024).toFixed(1)} MiB / ${(controls.data.data.narration_storage.maximum_bytes / 1024 / 1024).toFixed(1)} MiB。`}
              {controls.data.data.narration_storage.state === "warning" &&
                " 已达到80%容量警戒，请整理未采用任务并检查配额。"}
              {controls.data.data.narration_storage.state === "full" &&
                " 已满，不能继续创建正式讲解；已发布讲解按当前审核策略保留。"}
            </p>
            <small>
              未采用的资产保留{" "}
              {controls.data.data.narration_storage.unadopted_retention_days}{" "}
              天；回收不等于恢复供应商额度，已回收任务需要另建新任务。
            </small>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {resumeId && onReview && (
          <button
            disabled={busy || !!pending}
            onClick={() => onReview(resumeId)}
          >
            前往审核中心查看恢复草稿
          </button>
        )}
        {pending && (
          <button disabled={busy} onClick={() => void queryPending()}>
            查询本次服务操作结果
          </button>
        )}
        <label>
          暂停／恢复理由
          <input
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {controls.data && (
          <table>
            <thead>
              <tr>
                <th>服务</th>
                <th>实际状态</th>
                <th>已审核</th>
                <th>部署允许</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(services) as Service[]).map((s) => (
                <tr key={s}>
                  <th>{services[s]}</th>
                  <td>
                    {controls.data!.data.effective[keys[s]] ? "开启" : "关闭"}
                    {controls.data!.data.stops[s]?.stopped &&
                      ` · ${controls.data!.data.stops[s].reason}`}
                  </td>
                  <td>
                    {controls.data!.data.approved[keys[s]] ? "允许" : "关闭"}
                  </td>
                  <td>
                    {controls.data!.data.deployment_allowed[s]
                      ? "允许"
                      : "关闭"}
                  </td>
                  <td>
                    {controls.data!.data.permissions.edit && (
                      <>
                        <button
                          disabled={
                            busy ||
                            !!pending ||
                            configStatus.current.busy ||
                            !note.trim() ||
                            controls.data!.data.stops[s]?.stopped
                          }
                          onClick={() => void operate(s, "pause")}
                        >
                          立即暂停
                        </button>
                        <button
                          disabled={
                            busy ||
                            !!pending ||
                            configStatus.current.busy ||
                            configStatus.current.dirty ||
                            !note.trim() ||
                            !controls.data!.data.stops[s]?.stopped
                          }
                          onClick={() => void operate(s, "resume-request")}
                        >
                          申请恢复
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <fieldset
        disabled={busy || !!pending}
        className="ad-service-configuration"
      >
        <ConfigurationWorkspace
          initialId={initialId}
          initialIssue={initialIssue}
          session={session}
          onDirty={(dirty, processing) => {
            const changed =
              configStatus.current.dirty !== dirty ||
              configStatus.current.busy !== !!processing;
            configStatus.current = { dirty, busy: !!processing };
            if (changed) setConfigTick((value) => value + 1);
            onDirty(dirty, busy || !!pending || !!processing);
          }}
          onUpdate={onUpdate}
          onReview={onReview}
          initialKind="runtime"
          lockKind
        />
      </fieldset>
    </>
  );
}
