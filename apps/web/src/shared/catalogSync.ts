export const CATALOG_CHANNEL = "twinnku-public-catalog";
export const CATALOG_PUBLISHED = "published";
export const CATALOG_REFRESH_MS = 30_000;

/** One active read; a publication during that read requires a fresh follow-up. */
export function createCatalogRefresh<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  failed: () => void;
  busy: (value: boolean) => void;
  timeoutMs?: number;
}) {
  let disposed = false;
  let pending = false;
  let current: Promise<void> | null = null;
  let controller: AbortController | null = null;
  async function run() {
    options.busy(true);
    do {
      pending = false;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(
        () => request.abort(),
        options.timeoutMs ?? 30_000,
      );
      try {
        const value = await Promise.resolve().then(() =>
          options.load(request.signal),
        );
        if (!disposed && !pending) {
          if (request.signal.aborted) options.failed();
          else options.apply(value);
        }
      } catch {
        if (!disposed && !pending) options.failed();
      } finally {
        clearTimeout(timeout);
      }
    } while (pending && !disposed);
    controller = null;
    current = null;
    if (!disposed) options.busy(false);
  }
  return {
    refresh(afterCurrent = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (current) {
        pending ||= afterCurrent;
        return current;
      }
      current = run();
      return current;
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}

type Channel = Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
function openChannel(): Channel | null {
  try {
    return new BroadcastChannel(CATALOG_CHANNEL);
  } catch {
    return null;
  }
}

// The message contains no point data or permissions; receivers reread public APIs.
export function notifyCatalogPublished() {
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage(CATALOG_PUBLISHED);
  } catch {
    /* focus/poll fallback */
  } finally {
    channel.close();
  }
}

export function watchCatalogChanges(
  refresh: (afterCurrent?: boolean) => unknown,
  page: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > = document,
  browser: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  channel: Channel | null = openChannel(),
) {
  const resume = () => {
    if (page.visibilityState !== "hidden") refresh(true);
  };
  const timer = setInterval(() => {
    if (page.visibilityState !== "hidden") refresh();
  }, CATALOG_REFRESH_MS);
  browser.addEventListener("focus", resume);
  browser.addEventListener("online", resume);
  page.addEventListener("visibilitychange", resume);
  if (channel)
    channel.onmessage = (event) => {
      if (event.data === CATALOG_PUBLISHED && page.visibilityState !== "hidden")
        refresh(true);
    };
  return () => {
    clearInterval(timer);
    browser.removeEventListener("focus", resume);
    browser.removeEventListener("online", resume);
    page.removeEventListener("visibilitychange", resume);
    if (channel) {
      channel.onmessage = null;
      channel.close();
    }
  };
}
