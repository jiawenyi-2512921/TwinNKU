export const PUBLIC_REQUEST_TIMEOUT_MS = 15_000;

/** A deadline covers headers AND body decoding, including stalled transports. */
export async function withRequestDeadline<T>(
  load: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = PUBLIC_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (parent?.aborted)
    throw new DOMException("Request cancelled", "AbortError");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new DOMException("Request cancelled", "AbortError"));
      controller.abort();
    };
    timer = setTimeout(() => {
      reject(new DOMException("Request timed out", "TimeoutError"));
      controller.abort();
    }, timeoutMs);
    parent?.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([
      // Deferring the transport also turns synchronous failures into rejections.
      Promise.resolve().then(() => {
        if (controller.signal.aborted)
          throw new DOMException("Request cancelled", "AbortError");
        return load(controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}
