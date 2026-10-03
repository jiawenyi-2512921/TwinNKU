/** In-memory, one-writer CAS drafts. Never persist private content in browser storage. */
export type DraftSnapshot<T> = {
  id: string;
  revision: number;
  published_revision: number;
  content: T;
};
export type DraftPhase =
  | "clean"
  | "editing"
  | "saving"
  | "uncertain"
  | "conflict"
  | "error";
export type DraftStatus<T> = {
  value: T;
  base: DraftSnapshot<T>;
  phase: DraftPhase;
  dirty: boolean;
  error: string;
  savedAt: number | null;
  conflict?: { opened: T; local: T; server: DraftSnapshot<T> };
};
export type DraftWrite = {
  expected_revision: number;
  expected_published_revision: number;
  operation_id: string;
};
export type DraftTransport<T> = {
  save(value: T, version: DraftWrite): Promise<DraftSnapshot<T>>;
  recover(operationId: string): Promise<DraftSnapshot<T> | null>;
  latest(): Promise<DraftSnapshot<T>>;
};
type Timer = ReturnType<typeof setTimeout>;
export function stableContent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContent).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableContent((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function contentDiff(
  base: unknown,
  value: unknown,
  path = "内容",
): { path: string; before: unknown; after: unknown }[] {
  if (stableContent(base) === stableContent(value)) return [];
  if (
    base &&
    value &&
    typeof base === "object" &&
    typeof value === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(value)
  ) {
    const a = base as Record<string, unknown>,
      b = value as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      contentDiff(a[key], b[key], `${path}.${key}`),
    );
  }
  return [{ path, before: base, after: value }];
}
export class DraftCoordinator<T> {
  private status: DraftStatus<T>;
  private readonly opened: T;
  private timer: Timer | undefined;
  private pending: Promise<void> | undefined;
  private operation: { id: string; value: T; forced: number } | undefined;
  private forced = 0;
  private disposed = false;
  private listeners = new Set<(state: DraftStatus<T>) => void>();
  constructor(
    snapshot: DraftSnapshot<T>,
    private transport: DraftTransport<T>,
    private options: {
      delay?: number;
      uuid?: () => string;
      now?: () => number;
      initialDirty?: boolean;
    } = {},
  ) {
    this.opened = structuredClone(snapshot.content);
    this.status = {
      value: snapshot.content,
      base: snapshot,
      phase: options.initialDirty ? "editing" : "clean",
      dirty: !!options.initialDirty,
      error: "",
      savedAt: null,
    };
  }
  get state() {
    return this.status;
  }
  subscribe(listener: (state: DraftStatus<T>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(patch: Partial<DraftStatus<T>>) {
    if (this.disposed) return;
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((fn) => fn(this.status));
  }
  edit(value: T) {
    if (this.disposed) return;
    const dirty =
      stableContent(value) !== stableContent(this.status.base.content);
    this.emit({
      value,
      dirty,
      phase:
        this.status.phase === "conflict" || this.status.phase === "uncertain"
          ? this.status.phase
          : this.pending
            ? "saving"
            : dirty
              ? "editing"
              : "clean",
      conflict: this.status.conflict
        ? { ...this.status.conflict, local: value }
        : undefined,
    });
    this.schedule();
  }
  forceDirty() {
    this.forced++;
    this.emit({
      dirty: true,
      phase: ["uncertain", "conflict"].includes(this.status.phase)
        ? this.status.phase
        : this.pending
          ? "saving"
          : "editing",
      error: "",
    });
    this.schedule();
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (
      this.disposed ||
      this.pending ||
      !this.status.dirty ||
      ["conflict", "uncertain", "error"].includes(this.status.phase)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.delay ?? 3000);
  }
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending) {
      await this.pending;
      return this.flush();
    }
    if (
      this.disposed ||
      ["conflict", "uncertain", "error"].includes(this.status.phase)
    )
      return false;
    if (!this.status.dirty) return true;
    const value = structuredClone(this.status.value),
      base = this.status.base;
    const id = this.options.uuid?.() ?? crypto.randomUUID();
    this.operation = { id, value, forced: this.forced };
    this.emit({ phase: "saving", error: "" });
    this.pending = this.write(value, base, id);
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
      this.schedule();
    }
    return (
      !this.disposed && this.status.phase === "clean" && !this.status.dirty
    );
  }
  private acknowledge(snapshot: DraftSnapshot<T>) {
    if (this.disposed) return;
    if (snapshot.revision < this.status.base.revision) {
      this.emit({
        phase: "uncertain",
        error: "服务器确认的版本早于当前版本，请重新核对保存结果。",
      });
      return;
    }
    const untouched =
      !!this.operation &&
      stableContent(this.status.value) ===
        stableContent(this.operation.value) &&
      this.forced === this.operation.forced;
    const value = untouched ? snapshot.content : this.status.value;
    const dirty =
      stableContent(value) !== stableContent(snapshot.content) ||
      (!!this.operation && this.forced > this.operation.forced);
    this.operation = undefined;
    this.emit({
      value,
      base: snapshot,
      dirty,
      phase: dirty ? "editing" : "clean",
      error: "",
      savedAt: this.options.now?.() ?? Date.now(),
      conflict: undefined,
    });
  }
  private async write(value: T, base: DraftSnapshot<T>, id: string) {
    try {
      this.acknowledge(
        await this.transport.save(value, {
          expected_revision: base.revision,
          expected_published_revision: base.published_revision,
          operation_id: id,
        }),
      );
    } catch (error) {
      if (this.disposed) return;
      const status = (error as { status?: number }).status;
      if (status === 409) {
        try {
          const server = await this.transport.latest();
          this.operation = undefined;
          this.emit({
            phase: "conflict",
            error: "另一位成员更新了这份草稿。你的输入仍在，请比较后明确选择。",
            conflict: { opened: this.opened, local: this.status.value, server },
          });
        } catch {
          this.emit({
            phase: "conflict",
            error: "草稿版本冲突，服务器最新内容暂时无法读取。你的输入仍保留。",
          });
        }
      } else if (
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408
      ) {
        this.operation = undefined;
        this.emit({
          phase: "error",
          error:
            error instanceof Error
              ? error.message
              : "保存被拒绝，请检查字段与权限。",
        });
      } else {
        this.emit({
          phase: "uncertain",
          error: "未收到保存确认，正在查询操作结果；不会重复发送保存。",
        });
        await this.recover();
      }
    }
  }
  async recover() {
    if (!this.operation || this.disposed) return false;
    try {
      const result = await this.transport.recover(this.operation.id);
      if (result) {
        this.acknowledge(result);
        return true;
      }
    } catch {
      /* No acknowledgement is not evidence that the write failed. */
    }
    this.emit({
      phase: "uncertain",
      error:
        "保存结果尚未确认。草稿保留在本页，请查询结果；不要关闭页面或重复提交。",
    });
    return false;
  }
  retryValidation() {
    if (this.status.phase === "error") {
      this.emit({ phase: this.status.dirty ? "editing" : "clean", error: "" });
      this.schedule();
    }
  }
  async refreshConflict() {
    if (this.disposed || this.status.phase !== "conflict" || this.pending)
      return false;
    try {
      const server = await this.transport.latest();
      if (this.disposed || this.status.phase !== "conflict") return false;
      this.operation = undefined;
      this.emit({
        conflict: { opened: this.opened, local: this.status.value, server },
        error: "已读取最新版本，请比较并明确选择。",
      });
      return true;
    } catch {
      this.emit({
        error: "最新版本仍无法读取。你的输入保留，自动保存继续暂停。",
      });
      return false;
    }
  }
  acceptExternal(snapshot: DraftSnapshot<T>) {
    if (this.pending || this.disposed)
      throw new Error("保存尚未完成，不能替换草稿。");
    if (this.timer) clearTimeout(this.timer);
    this.operation = undefined;
    this.emit({
      value: snapshot.content,
      base: snapshot,
      phase: "clean",
      dirty: false,
      error: "",
      conflict: undefined,
      savedAt: this.options.now?.() ?? Date.now(),
    });
  }
  resolve(choice: "server" | "local", resolved?: T) {
    if (!this.status.conflict) return;
    const server = this.status.conflict.server;
    const value =
      choice === "server" ? server.content : (resolved ?? this.status.value);
    this.operation = undefined;
    const dirty = stableContent(value) !== stableContent(server.content);
    // Explicit subsequent save is required for a local/merged conflict resolution.
    this.emit({
      value,
      base: server,
      conflict: undefined,
      dirty,
      phase: dirty ? "error" : "clean",
      error: dirty
        ? "已按最新服务器版本保留你的内容，请检查并点击保存确认。"
        : "",
    });
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
