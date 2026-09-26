import { useEffect, useState } from "react";
import type { Campus } from "../../shared/api/client";
import {
  message,
  request,
  roleNames,
  type AdminPoint,
  type StaffUser,
} from "./api";
import { Empty, ErrorBox, Pager, useResource } from "./ui";
type Form = {
  username: string;
  display_name: string;
  role: StaffUser["role"];
  campus_ids: string[];
  point_ids: string[];
  is_active: boolean;
  password: string;
};
const blank: Form = {
  username: "",
  display_name: "",
  role: "editor",
  campus_ids: [],
  point_ids: [],
  is_active: true,
  password: "",
};
export function Accounts({
  campuses,
  currentUser,
  onDirty,
}: {
  campuses: Campus[];
  currentUser: StaffUser;
  onDirty: (v: boolean) => void;
}) {
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [target, setTarget] = useState<StaffUser | null>(null),
    [editing, setEditing] = useState(false),
    [form, setForm] = useState<Form>(blank),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pointSearch, setPointSearch] = useState(""),
    [points, setPoints] = useState<AdminPoint[]>([]),
    [pointsError, setPointsError] = useState(""),
    [restrict, setRestrict] = useState(false);
  const list = useResource<StaffUser[]>(
    `/users?page=${page}&page_size=20`,
    revision,
  );
  useEffect(() => {
    onDirty(dirty);
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      onDirty(false);
    };
  }, [dirty, onDirty]);
  const scopeKey = form.campus_ids.join(",");
  useEffect(() => {
    const abort = new AbortController();
    setPoints([]);
    setPointsError("");
    if (!editing || form.role === "admin" || !scopeKey) return;
    (async () => {
      const all: AdminPoint[] = [];
      for (const campus of scopeKey.split(",")) {
        let page = 1;
        while (true) {
          const result = await request<AdminPoint[]>(
            `/points?${new URLSearchParams({ campus_id: campus, page_size: "100", page: String(page) })}`,
            "GET",
            undefined,
            abort.signal,
          );
          all.push(...result.data);
          if (page * 100 >= (result.meta.pagination?.total ?? 0)) break;
          page++;
        }
      }
      if (!abort.signal.aborted) setPoints(all);
    })().catch((e) => {
      if (!abort.signal.aborted) setPointsError(message(e));
    });
    return () => abort.abort();
  }, [scopeKey, editing, form.role, revision]);
  const guard = () =>
    !dirty || window.confirm("账号修改尚未保存，确定放弃吗？");
  function open(user: StaffUser | null) {
    if (!guard() || busy) return;
    setTarget(user);
    setForm(
      user
        ? {
            username: user.username,
            display_name: user.display_name,
            role: user.role,
            campus_ids: user.campus_ids,
            point_ids: user.point_ids,
            is_active: user.is_active,
            password: "",
          }
        : { ...blank, campus_ids: campuses[0] ? [campuses[0].id] : [] },
    );
    setRestrict(!!user?.point_ids.length);
    setEditing(true);
    setDirty(false);
    setError("");
    setNotice("");
    setPointSearch("");
  }
  function change(update: Partial<Form>) {
    setForm((v) => ({ ...v, ...update }));
    setDirty(true);
    setNotice("");
  }
  async function save() {
    if (
      form.role !== "admin" &&
      (!form.campus_ids.length || (restrict && !form.point_ids.length))
    ) {
      setError("请选择授权校区；限定建筑时至少选择一个点位。");
      return;
    }
    setBusy(true);
    setError("");
    const payload = {
      display_name: form.display_name,
      role: form.role,
      campus_ids: form.role === "admin" ? [] : form.campus_ids,
      point_ids: form.role === "admin" || !restrict ? [] : form.point_ids,
    };
    try {
      await request<StaffUser>(
        target ? `/users/${target.id}` : "/users",
        target ? "PUT" : "POST",
        target
          ? {
              ...payload,
              expected_revision: target.revision,
              is_active: form.is_active,
              ...(form.password ? { new_password: form.password } : {}),
            }
          : { ...payload, username: form.username, password: form.password },
      );
      setDirty(false);
      setEditing(false);
      setForm(blank);
      setRevision((v) => v + 1);
      setNotice(
        target
          ? "账号已更新；原有登录会话已失效。"
          : "账号已创建；首次登录需要修改临时密码。",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const self = target?.id === currentUser.id;
  return (
    <section>
      <div className="ad-section-heading">
        <div>
          <div className="ad-eyebrow">PEOPLE & ACCESS</div>
          <h1>账号与权限</h1>
          <p>按角色分工，按校区或指定建筑分配管理范围。</p>
        </div>
        <button
          className="ad-primary"
          disabled={busy}
          onClick={() => open(null)}
        >
          ＋ 添加成员
        </button>
      </div>
      <div className="ad-role-grid">
        {Object.entries(roleNames).map(([key, name]) => (
          <div className="ad-role-card" key={key}>
            <strong>{name}</strong>
            <p>
              {
                {
                  admin: "账号、授权、地图编辑与审核；管理全部校区。",
                  reviewer: "核对授权范围内的草稿，发布或退回。",
                  editor: "编辑授权范围内的点位，提交审核。",
                  viewer: "查看授权范围内的点位和草稿。",
                }[key]
              }
            </p>
          </div>
        ))}
      </div>
      <ErrorBox
        text={error || list.error}
        onRetry={() => setRevision((v) => v + 1)}
      />
      {notice && (
        <div className="ad-success" role="status">
          {notice}
        </div>
      )}
      <div className={`ad-accounts-layout${editing ? " editing" : ""}`}>
        <div className="ad-card ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>角色</th>
                <th>管理范围</th>
                <th>状态</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data?.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.display_name}</strong>
                    <small>
                      {u.username}
                      {u.id === currentUser.id ? " · 你" : ""}
                    </small>
                  </td>
                  <td>{roleNames[u.role]}</td>
                  <td>
                    {u.role === "admin"
                      ? "全部校区"
                      : u.campus_ids
                          .map(
                            (id) =>
                              campuses.find((c) => c.id === id)?.name ?? id,
                          )
                          .join("、")}
                    <small>
                      {u.point_ids.length
                        ? `限定 ${u.point_ids.length} 个点位`
                        : u.role !== "admin"
                          ? "校区内全部点位"
                          : ""}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`ad-badge ${u.is_active ? "published" : "retired"}`}
                    >
                      {u.is_active ? "启用" : "停用"}
                    </span>
                    {u.must_change_password && <small>待修改临时密码</small>}
                  </td>
                  <td>
                    <button disabled={busy} onClick={() => open(u)}>
                      管理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.loading && (
            <p className="ad-hint" role="status">
              正在读取成员…
            </p>
          )}
          <Pager page={list.data?.meta.pagination} onChange={setPage} />
        </div>
        {editing && (
          <form
            className="ad-account-form ad-card"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="ad-detail-head">
              <h2>{target ? "管理成员" : "添加成员"}</h2>
              <button
                type="button"
                disabled={busy}
                aria-label="关闭成员编辑"
                onClick={() => {
                  if (guard()) {
                    setEditing(false);
                    setDirty(false);
                    setForm(blank);
                  }
                }}
              >
                ×
              </button>
            </div>
            <fieldset disabled={busy}>
              <label>
                成员姓名
                <input
                  required
                  maxLength={80}
                  value={form.display_name}
                  onChange={(e) => change({ display_name: e.target.value })}
                />
              </label>
              <label>
                登录账号
                <input
                  required
                  pattern="[a-z][a-z0-9._\-]{2,63}"
                  title="3至64位，以小写字母开头，仅限小写字母、数字、点、横线和下划线"
                  autoComplete="off"
                  disabled={!!target}
                  value={form.username}
                  onChange={(e) => change({ username: e.target.value })}
                />
              </label>
              <label>
                角色
                <select
                  value={form.role}
                  disabled={self}
                  onChange={(e) => {
                    const role = e.target.value as Form["role"];
                    change({
                      role,
                      campus_ids:
                        role === "admin"
                          ? []
                          : form.campus_ids.length
                            ? form.campus_ids
                            : campuses[0]
                              ? [campuses[0].id]
                              : [],
                      point_ids: [],
                    });
                    setRestrict(false);
                  }}
                >
                  {Object.entries(roleNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              {form.role !== "admin" && (
                <>
                  <label>授权校区</label>
                  <div className="ad-check-list">
                    {campuses.map((c) => (
                      <label className="ad-check" key={c.id}>
                        <input
                          type="checkbox"
                          checked={form.campus_ids.includes(c.id)}
                          onChange={(e) =>
                            change({
                              campus_ids: e.target.checked
                                ? [...form.campus_ids, c.id]
                                : form.campus_ids.filter((id) => id !== c.id),
                              point_ids: [],
                            })
                          }
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                  <label className="ad-check">
                    <input
                      type="checkbox"
                      checked={restrict}
                      onChange={(e) => {
                        setRestrict(e.target.checked);
                        change({ point_ids: [] });
                      }}
                    />
                    限定到指定建筑 / 景点
                  </label>
                  {restrict && (
                    <div className="ad-scope-picker">
                      <input
                        aria-label="搜索授权点位"
                        placeholder="搜索建筑或景点"
                        value={pointSearch}
                        onChange={(e) => setPointSearch(e.target.value)}
                      />
                      <small>
                        已选 {form.point_ids.length} 项 ·
                        限定范围的编辑员不能新增其他建筑
                      </small>
                      <ErrorBox text={pointsError} />
                      <div className="ad-check-list">
                        {points
                          .filter((p) => p.point.name.includes(pointSearch))
                          .map((p) => (
                            <label key={p.point.id} className="ad-check">
                              <input
                                type="checkbox"
                                checked={form.point_ids.includes(p.point.id)}
                                onChange={(e) =>
                                  change({
                                    point_ids: e.target.checked
                                      ? [...form.point_ids, p.point.id]
                                      : form.point_ids.filter(
                                          (id) => id !== p.point.id,
                                        ),
                                  })
                                }
                              />
                              {p.point.name}
                            </label>
                          ))}
                      </div>
                      {!points.length && (
                        <p className="ad-hint">当前校区暂无可选点位。</p>
                      )}
                    </div>
                  )}
                </>
              )}
              {!self && (
                <label>
                  {target ? "重置临时密码（留空不修改）" : "临时密码"}
                  <input
                    type="password"
                    required={!target}
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => change({ password: e.target.value })}
                  />
                  <small>
                    12 至 128
                    个字符。请通过可信渠道单独交给本人，首次登录必须修改。
                  </small>
                </label>
              )}
              {target && (
                <label className="ad-check">
                  <input
                    type="checkbox"
                    disabled={self}
                    checked={form.is_active}
                    onChange={(e) => change({ is_active: e.target.checked })}
                  />
                  启用此账号
                </label>
              )}
              {self && (
                <p className="ad-hint">
                  本人密码请从左下方“修改密码”进入；不能停用或降级自己。
                </p>
              )}
              <button
                className="ad-primary"
                type="submit"
                disabled={!!target && !dirty}
              >
                {busy ? "正在保存…" : target ? "保存账号设置" : "创建成员"}
              </button>
            </fieldset>
          </form>
        )}
      </div>
      {!list.loading && list.data?.data.length === 0 && (
        <Empty title="还没有成员" />
      )}
    </section>
  );
}
