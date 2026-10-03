import { useState } from "react";
import type { Campus } from "../../shared/api/client";
import { message, request, type StaffUser } from "./api";
import { ErrorBox, useResource } from "./ui";
const names = {
  "configurations.edit": "编辑首页／参观配置",
  "configurations.review": "审核首页／参观配置",
  "runtime.edit": "编辑服务费用／暂停服务",
  "runtime.review": "审核服务费用／恢复服务",
};
type Grant = {
  user_id: string;
  permission: keyof typeof names;
  scope: string;
  note: string;
};
export function ConfigurationPermissions({
  user,
  campuses,
}: {
  user: StaffUser;
  campuses: Campus[];
}) {
  const [revision, setRevision] = useState(0),
    [scope, setScope] = useState("global"),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const grants = useResource<Grant[]>("/configuration-permissions", revision);
  async function update(permission: keyof typeof names, enabled: boolean) {
    if (busy || !note.trim()) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/configuration-permissions/${user.id}/${permission}`,
        "PUT",
        { scope, enabled, note },
      );
      setRevision((v) => v + 1);
      window.dispatchEvent(new Event("staff-permissions-changed"));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ad-card ad-config-actions">
      <h3>展示与运行配置权限</h3>
      <p>
        独立授权，不随管理员角色自动开放。权限修改需近期通行密钥验证；编辑人员不能审核自己的贡献。
      </p>
      <ErrorBox text={error || grants.error} />
      <label>
        授权范围
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="global">全站</option>
          {campuses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        授权理由
        <input
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {(Object.keys(names) as (keyof typeof names)[]).map((p) => {
        const enabled = grants.data?.data.some(
          (g) =>
            g.user_id === user.id && g.scope === scope && g.permission === p,
        );
        return (
          <div key={p}>
            {names[p]} · {enabled ? "已授予" : "未授予"}
            <button
              disabled={busy || !note.trim() || !grants.data}
              onClick={() => void update(p, !enabled)}
            >
              {enabled ? "撤销" : "授予"}
            </button>
          </div>
        );
      })}
    </section>
  );
}
