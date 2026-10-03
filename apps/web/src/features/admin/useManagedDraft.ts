import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import {
  DraftCoordinator,
  type DraftSnapshot,
  type DraftStatus,
  type DraftWrite,
} from "./draftCoordinator";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";

/** Shared one-writer draft boundary; entity adapters keep their existing service DTO. */
export function useManagedDraft<T, R>(options: {
  snapshot: (record: R, value?: T) => DraftSnapshot<T>;
  save: (record: R | null, value: T, version: DraftWrite) => Promise<R>;
  latest: (record: R) => Promise<R>;
  onRecord: (record: R) => void;
  onValue: (value: T, dirty: boolean) => void;
  onAction: (record: R) => void;
}) {
  const settings = useRef(options);
  settings.current = options;
  const record = useRef<R | null>(null),
    coordinator = useRef<DraftCoordinator<T> | null>(null),
    unsubscribe = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<DraftStatus<T> | null>(null),
    [pendingAction, setPendingAction] = useState<string | null>(null);
  function clear() {
    unsubscribe.current?.();
    coordinator.current?.dispose();
    unsubscribe.current = null;
    coordinator.current = null;
    record.current = null;
    setStatus(null);
  }
  async function recover(id: string): Promise<R | null> {
    try {
      return (await request<{ result: R }>(`/operations/${id}`)).data.result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  function install(row: R | null, value: T, initiallyDirty = false) {
    clear();
    record.current = row;
    const initial = row
      ? settings.current.snapshot(row, value)
      : { id: "", revision: 0, published_revision: 0, content: value };
    const apply = (r: R) => {
      if (coordinator.current === manager) {
        record.current = r;
        settings.current.onRecord(r);
      }
      return settings.current.snapshot(r);
    };
    const manager = new DraftCoordinator(
      initial,
      {
        save: async (v, version) =>
          apply(await settings.current.save(record.current, v, version)),
        recover: async (id) => {
          const r = await recover(id);
          return r ? apply(r) : null;
        },
        latest: async () => {
          if (!record.current)
            throw new Error("新草稿尚未创建，请先核对原操作结果。");
          return apply(await settings.current.latest(record.current));
        },
      },
      { initialDirty: initiallyDirty },
    );
    coordinator.current = manager;
    unsubscribe.current = manager.subscribe((next) => {
      setStatus(next);
      settings.current.onValue(next.value, next.dirty);
    });
    setStatus(manager.state);
  }
  function edit(value: T) {
    const manager = coordinator.current;
    if (!manager) return;
    manager.retryValidation();
    manager.edit(value);
  }
  async function flush() {
    const manager = coordinator.current;
    if (!manager) return false;
    manager.retryValidation();
    for (let i = 0; i < 3; i++) {
      if (await manager.flush()) return true;
      if (["error", "conflict", "uncertain"].includes(manager.state.phase))
        break;
    }
    return false;
  }
  async function action(path: string, body: Record<string, unknown>) {
    if (pendingAction) throw new Error("请先查询原操作结果。");
    const id = crypto.randomUUID();
    try {
      return await confirmedOperation(
        id,
        async () =>
          (await request<R>(path, "POST", { ...body, operation_id: id })).data,
        recover,
      );
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPendingAction(id);
      throw e;
    }
  }
  async function queryAction() {
    if (!pendingAction) return;
    const r = await recover(pendingAction);
    if (!r)
      throw new Error("原操作仍未确认，请保留页面并稍后查询；不会重复提交。");
    setPendingAction(null);
    settings.current.onAction(r);
  }
  useEffect(
    () => () => {
      unsubscribe.current?.();
      coordinator.current?.dispose();
    },
    [],
  );
  return {
    status,
    coordinator,
    record,
    pendingAction,
    install,
    edit,
    clear,
    flush,
    action,
    queryAction,
    saving: status?.phase === "saving",
    uncertain: status?.phase === "uncertain" || !!pendingAction,
  };
}
