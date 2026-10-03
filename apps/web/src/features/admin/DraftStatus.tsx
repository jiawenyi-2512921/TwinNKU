import type { DraftCoordinator, DraftStatus } from "./draftCoordinator";
import { contentDiff } from "./draftCoordinator";
export function DraftStatusBar<T>({
  state,
  coordinator,
  onResolve,
}: {
  state: DraftStatus<T>;
  coordinator: DraftCoordinator<T>;
  onResolve?: (choice: "server" | "local") => void;
}) {
  const names = {
    clean: "已保存",
    editing: "编辑中 · 停下输入 3 秒自动保存",
    saving: "正在保存 · 可以继续输入",
    uncertain: "正在核对保存结果",
    conflict: "版本冲突 · 自动保存已暂停",
    error: "保存已暂停",
  };
  return (
    <section className="ad-draft-status" aria-label="草稿保存状态">
      <div role="status">
        {names[state.phase]} · 草稿版本 {state.base.revision}
        {state.savedAt &&
          ` · ${new Date(state.savedAt).toLocaleTimeString("zh-CN")}`}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {state.phase === "uncertain" && (
        <button type="button" onClick={() => void coordinator.recover()}>
          查询这次保存结果
        </button>
      )}
      {state.phase === "error" && (
        <button
          type="button"
          onClick={() => {
            coordinator.retryValidation();
            void coordinator.flush();
          }}
        >
          检查后保存确认
        </button>
      )}
      {state.conflict && (
        <div className="ad-conflict" role="region" aria-label="版本比较">
          <p>
            打开时版本 → 你的输入 → 服务器最新版本{" "}
            {state.conflict.server.revision}
            。下方展示发生变化的字段；选择保留本地后仍需明确保存。
          </p>
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>打开时</th>
                <th>你的输入</th>
                <th>服务器最新</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...new Set(
                  [
                    ...contentDiff(state.conflict.opened, state.value),
                    ...contentDiff(
                      state.conflict.opened,
                      state.conflict.server.content,
                    ),
                  ].map((d) => d.path),
                ),
              ].map((path) => {
                const read = (value: unknown) =>
                  path
                    .split(".")
                    .slice(1)
                    .reduce<unknown>(
                      (v, key) =>
                        v && typeof v === "object"
                          ? (v as Record<string, unknown>)[key]
                          : undefined,
                      value,
                    );
                const show = (value: unknown) =>
                  JSON.stringify(value) ?? "（空）";
                return (
                  <tr key={path}>
                    <th>{path}</th>
                    <td>{show(read(state.conflict!.opened))}</td>
                    <td>{show(read(state.value))}</td>
                    <td>{show(read(state.conflict!.server.content))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => {
              coordinator.resolve("local");
              onResolve?.("local");
            }}
          >
            保留本页输入，按最新版本确认保存
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("用服务器版本替换本页未保存输入？")) {
                coordinator.resolve("server");
                onResolve?.("server");
              }
            }}
          >
            采用服务器版本
          </button>
        </div>
      )}
      {state.phase === "conflict" && !state.conflict && (
        <div>
          <p>最新版本尚未读取；本页输入保留，自动保存已暂停。</p>
          <button
            type="button"
            onClick={() => void coordinator.refreshConflict()}
          >
            重新读取最新版本用于比较
          </button>
        </div>
      )}
    </section>
  );
}
