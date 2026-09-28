import { useEffect, useState } from "react";
import type { components } from "../../shared/api/schema";
import { request, message } from "./api";
import { ErrorBox } from "./ui";

type View = components["schemas"]["GuidePolicyView"];
type Policy = components["schemas"]["GuidePolicy"];
const labels = {
  focus_point: "定位与高亮地点",
  show_floor: "打开楼层图",
  open_vr: "打开已发布全景",
  show_route: "规划地图路线",
} as const;

export function GuideSettings({
  onDirty,
}: {
  onDirty: (dirty: boolean, busy?: boolean) => void;
}) {
  const [view, setView] = useState<View | null>(null),
    [policy, setPolicy] = useState<Policy | null>(null);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [note, setNote] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    onDirty(dirty, busy);
  }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    request<View>("/guide-settings", "GET", undefined, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) {
          setView(r.data);
          setPolicy(r.data.policy);
          setDirty(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [revision]);
  function change(next: Partial<Policy>) {
    if (policy) {
      setPolicy({ ...policy, ...next });
      setDirty(true);
    }
  }
  async function save() {
    if (!view || !policy || !note.trim()) {
      setError("请填写变更原因。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<View>("/guide-settings", "PUT", {
        expected_revision: view.revision,
        policy,
        note,
      });
      setView(result.data);
      setPolicy(result.data.policy);
      setDirty(false);
      setNote("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="ad-eyebrow">GUIDE OPERATIONS</div>
      <h1>智能导览设置</h1>
      <p className="road-info">
        管理问答、网站动作和导航的运行状态。设置保存后对新请求生效，公开页面最多60秒刷新一次入口。
      </p>
      <ErrorBox text={error} />
      <button
        disabled={busy}
        onClick={() => {
          if (!dirty || window.confirm("放弃修改并重新加载？"))
            setRevision((v) => v + 1);
        }}
      >
        重新加载
      </button>
      {view && policy && (
        <>
          <div className="road-summary">
            <strong>
              {view.api_configured
                ? "学校应用 API 已配置"
                : "学校应用 API 尚未配置"}
            </strong>
            <p>这里只检查服务端配置，真实连通性请用网站问答验收。</p>
            <p>
              同时处理上限 {view.concurrency_limit}，会话容量{" "}
              {view.session_limit}。服务重启后用户需新建对话。
            </p>
            <p>应用密钥和访问口令由服务器环境管理，后台不显示其内容。</p>
          </div>
          <fieldset disabled={busy} className="road-controls">
            <legend>运行开关</legend>
            {(
              [
                ["chat_enabled", "启用小开问答"],
                ["navigation_enabled", "启用已审核道路导航"],
                ["auto_actions", "允许单个明确动作自动定位 / 显示路线"],
              ] as const
            ).map(([key, label]) => (
              <label className="road-check" key={key}>
                <input
                  type="checkbox"
                  checked={policy[key] ?? true}
                  onChange={(e) => change({ [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <p className="road-info">
              全景保持用户点击打开；缺起点、歧义或资料失效时由用户选择。
            </p>
          </fieldset>
          <fieldset disabled={busy} className="road-controls">
            <legend>允许小开调用的功能</legend>
            {Object.entries(labels).map(([key, label]) => (
              <label className="road-check" key={key}>
                <input
                  type="checkbox"
                  checked={
                    policy.allowed_actions?.includes(
                      key as keyof typeof labels,
                    ) ?? false
                  }
                  onChange={(e) => {
                    const values = policy.allowed_actions ?? [];
                    change({
                      allowed_actions: e.target.checked
                        ? [...values, key as keyof typeof labels]
                        : values.filter((v) => v !== key),
                    });
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset disabled={busy} className="road-controls">
            <legend>问答额度</legend>
            <label>
              每位访客每小时问题数
              <input
                type="number"
                min={1}
                max={120}
                value={policy.visitor_turns_per_hour ?? 30}
                onChange={(e) =>
                  change({ visitor_turns_per_hour: Number(e.target.value) })
                }
              />
            </label>
            <label>
              全站每小时问题数
              <input
                type="number"
                min={1}
                max={1000}
                value={policy.total_turns_per_hour ?? 120}
                onChange={(e) =>
                  change({ total_turns_per_hour: Number(e.target.value) })
                }
              />
            </label>
          </fieldset>
          <div className="road-controls">
            <label>
              变更原因
              <textarea
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !dirty || !note.trim()}
              onClick={() => void save()}
            >
              {busy ? "正在保存…" : "保存运行设置"}
            </button>
          </div>
          <p className="road-info">
            设置版本 {view.revision} · 最近说明：{view.note}
            。修改记录可在“操作记录”检索。
          </p>
        </>
      )}
    </section>
  );
}
