import type { AudioBookmark } from "./session";

export type RecordedChunk = {
  chunk_id: string;
  text: string;
  duration_seconds: number;
  byte_size: number;
  sha256: string;
  url: string;
};
export type RecordedManifest = {
  manifest_id: string;
  asset_id: string;
  text_sha256: string;
  chunks: RecordedChunk[];
};
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validateRecordedManifest(
  value: unknown,
  routeId: string,
  revision: number,
  stopIndex: number,
  segmentId: string,
  staffAssetId?: string,
): RecordedManifest {
  const m = value as RecordedManifest;
  if (
    !m ||
    typeof m.manifest_id !== "string" ||
    m.manifest_id.length > 128 ||
    !m.manifest_id ||
    typeof m.asset_id !== "string" ||
    !uuid.test(m.asset_id) ||
    typeof m.text_sha256 !== "string" ||
    !hash.test(m.text_sha256) ||
    !Array.isArray(m.chunks) ||
    !m.chunks.length ||
    m.chunks.length > 100 ||
    m.chunks.some((c) => !c || typeof c.chunk_id !== "string") ||
    new Set(m.chunks.map((c) => c.chunk_id)).size !== m.chunks.length
  )
    throw new Error("正式声音清单格式不正确。");
  for (const c of m.chunks) {
    if (!c || typeof c.url !== "string")
      throw new Error("正式声音清单格式不正确。");
    const u = new URL(c.url, "https://local.invalid");
    const staffPath =
      staffAssetId &&
      m.asset_id === staffAssetId &&
      c.url ===
        `/api/v1/admin/narration-assets/${staffAssetId}/chunks/${c.chunk_id}`;
    const publicPath = `/api/v1/experiences/${routeId}/narration/${m.asset_id}/chunks/${c.chunk_id}`;
    const queryKeys = [...u.searchParams.keys()];
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(c.chunk_id) ||
      u.origin !== "https://local.invalid" ||
      u.hash ||
      /[\\\s]/.test(c.url) ||
      (!staffPath &&
        (!c.url.startsWith("/") ||
          c.url.startsWith("//") ||
          c.url.split("?")[0] !== publicPath ||
          u.pathname !== publicPath ||
          queryKeys.length !== 3 ||
          !["revision", "stop_index", "segment_id"].every(
            (key) => u.searchParams.getAll(key).length === 1,
          ) ||
          u.origin !== "https://local.invalid" ||
          /[\\\s]/.test(c.url) ||
          u.pathname.split("/").at(-1) !== c.chunk_id ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(c.chunk_id) ||
          u.searchParams.get("revision") !== String(revision) ||
          u.searchParams.get("stop_index") !== String(stopIndex) ||
          u.searchParams.get("segment_id") !== segmentId)) ||
      (staffAssetId && !staffPath) ||
      typeof c.sha256 !== "string" ||
      !hash.test(c.sha256) ||
      typeof c.text !== "string" ||
      c.text.length > 8000 ||
      !Number.isFinite(c.duration_seconds) ||
      c.duration_seconds <= 0 ||
      c.duration_seconds > 180 ||
      !Number.isInteger(c.byte_size) ||
      c.byte_size < 12 ||
      c.byte_size > 8 * 1024 * 1024
    )
      throw new Error("正式声音与当前段落不匹配。");
  }
  return m;
}
export function recordedOffset(
  manifest: RecordedManifest,
  bookmark?: AudioBookmark,
) {
  const index =
    bookmark?.manifestId === manifest.manifest_id &&
    bookmark.textSha256 === manifest.text_sha256
      ? manifest.chunks.findIndex((c) => c.chunk_id === bookmark.chunkId)
      : -1;
  return {
    index: Math.max(0, index),
    time:
      index >= 0
        ? Math.min(bookmark?.time ?? 0, manifest.chunks[index].duration_seconds)
        : 0,
    reset: Boolean(
      bookmark && (bookmark.time || bookmark.chunkIndex) && index < 0,
    ),
  };
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function createRecordedPlayer(
  onState: (state: "idle" | "loading" | "speaking" | "blocked") => void,
) {
  const audio = new Audio();
  audio.preload = "metadata";
  let epoch = 0,
    pending: AbortController | null = null,
    url: string | null = null,
    settle: ((done: boolean) => void) | null = null;
  let position: AudioBookmark = { chunkIndex: 0, time: 0 };
  function cancel() {
    epoch++;
    pending?.abort();
    pending = null;
    audio.pause();
    settle?.(false);
    settle = null;
    audio.removeAttribute("src");
    audio.load();
    if (url) URL.revokeObjectURL(url);
    url = null;
    onState("idle");
  }
  function pause() {
    const saved = {
      ...position,
      time: Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : position.time,
    };
    cancel();
    return saved;
  }
  function unlock() {
    const turn = epoch,
      source = url;
    if (url)
      void audio
        .play()
        .then(() => {
          if (turn === epoch && source === url) onState("speaking");
        })
        .catch(() => {
          if (turn === epoch && source === url) onState("blocked");
        });
  }
  async function play(
    manifest: RecordedManifest,
    bookmark: AudioBookmark | undefined,
    onCaption: (text: string) => void,
    onProgress: (value: AudioBookmark) => void,
    signal: AbortSignal,
    staff = false,
  ) {
    cancel();
    const turn = epoch;
    const offset = recordedOffset(manifest, bookmark);
    const abort = () => cancel();
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (let index = offset.index; index < manifest.chunks.length; index++) {
        if (signal.aborted || turn !== epoch) return false;
        const c = manifest.chunks[index];
        onState("loading");
        pending = new AbortController();
        const requestTimeout = setTimeout(() => pending?.abort(), 15000);
        let bytes: Uint8Array;
        try {
          const response = await fetch(c.url, {
            credentials: staff ? "same-origin" : "omit",
            cache: "no-store",
            redirect: "error",
            signal: pending.signal,
          });
          if (
            !response.ok ||
            !response.body ||
            !/^audio\/(?:wav|x-wav|wave)(?:;|$)/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            throw new Error("正式声音暂不可用，请重新核对路线。");
          const reader = response.body.getReader();
          const pieces: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > c.byte_size || size > 8 * 1024 * 1024) {
              await reader.cancel();
              throw new Error("声音文件超出安全范围。");
            }
            pieces.push(part.value);
          }
          bytes = new Uint8Array(size);
          let at = 0;
          for (const p of pieces) {
            bytes.set(p, at);
            at += p.byteLength;
          }
          if (size !== c.byte_size || (await sha256(bytes)) !== c.sha256)
            throw new Error("声音文件校验失败，请重新核对路线。");
        } finally {
          clearTimeout(requestTimeout);
        }
        if (signal.aborted || turn !== epoch) return false;
        position = {
          chunkIndex: index,
          time: 0,
          manifestId: manifest.manifest_id,
          chunkId: c.chunk_id,
          textSha256: manifest.text_sha256,
        };
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
        );
        audio.src = url;
        const ended = await new Promise<boolean>((done) => {
          let finished = false;
          const complete = (value: boolean) => {
            if (finished) return;
            finished = true;
            audio.onended = null;
            audio.onerror = null;
            audio.ontimeupdate = null;
            audio.onloadedmetadata = null;
            settle = null;
            done(value);
          };
          settle = complete;
          audio.onended = () => complete(true);
          audio.onerror = () => complete(false);
          audio.ontimeupdate = () => {
            if (turn !== epoch) return;
            position = { ...position, time: audio.currentTime };
            onProgress(position);
          };
          audio.onloadedmetadata = () => {
            if (index === offset.index && offset.time > 0)
              audio.currentTime = Math.min(
                offset.time,
                Math.max(0, audio.duration - 0.05),
              );
          };
          onCaption(c.text);
          void audio
            .play()
            .then(() => {
              if (turn === epoch) onState("speaking");
            })
            .catch(() => {
              if (turn === epoch) onState("blocked");
            });
        });
        if (!ended || turn !== epoch) return false;
      }
      onState("idle");
      return true;
    } catch (error) {
      if (turn === epoch) cancel();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  return { play, pause, cancel, unlock };
}
