import { NativeError, post } from "../features/agent/native.ts";
import { withRequestDeadline } from "./requestDeadline.ts";

export type VoiceManifest = {
  permit: string | null;
  chunks: string[];
  csrf: string;
  endpoint?: "/voice/speech" | "/admin/voice/speech";
  startChunk?: number;
  startTime?: number;
  onProgress?: (position: { chunkIndex: number; time: number }) => void;
};
export type TourVoiceSource = {
  kind: "tour_segment";
  tour_id: string;
  tour_revision: number;
  stop_index: number;
  segment_id?: string | null;
};
export type DraftVoiceSource = {
  kind: "draft_segment";
  tour_id: string;
  draft_revision: number;
  stop_index: number;
  segment_id?: string | null;
};

let csrf = "";
let generation = 0;
let pending: Promise<{ csrf_token: string }> | null = null;
let ending = false;

async function readSession(): Promise<{ csrf_token: string }> {
  return withRequestDeadline(
    async (signal) => {
      const response = await fetch("/api/v1/agent/session", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new NativeError(
          body?.error?.message || "会话暂不可用",
          response.status,
          { code: body?.error?.code, requestId: body?.meta?.request_id },
        );
      if (typeof body?.data?.csrf_token !== "string" || !body.data.csrf_token)
        throw new NativeError("会话返回格式异常", 502, {
          code: "INVALID_RESPONSE",
        });
      return body.data;
    },
    undefined,
    10_000,
  );
}

export function rememberVisitorSession(value: string) {
  generation++;
  pending = null;
  csrf = value;
}

export function forgetVisitorSession() {
  generation++;
  csrf = "";
  pending = null;
}

export async function ensureVisitorSession(
  publicEnabled = true,
  signal?: AbortSignal,
  refresh = false,
): Promise<{ csrf_token: string }> {
  signal?.throwIfAborted();
  if (ending) throw new DOMException("Session ending", "AbortError");
  if (csrf && !refresh) return { csrf_token: csrf };
  if (refresh) csrf = "";
  if (!pending) {
    const epoch = generation;
    pending = (async () => {
      try {
        return await readSession();
      } catch (error) {
        if (
          !publicEnabled ||
          !(error && typeof error === "object" && "status" in error) ||
          error.status !== 401
        )
          throw error;
        return post<{ csrf_token: string }>("/agent/guest", undefined);
      }
    })()
      .then((session) => {
        if (epoch !== generation)
          throw new DOMException("Session replaced", "AbortError");
        if (typeof session.csrf_token !== "string" || !session.csrf_token)
          throw new NativeError("会话返回格式异常", 502, {
            code: "INVALID_RESPONSE",
          });
        csrf = session.csrf_token;
        return session;
      })
      .finally(() => {
        if (epoch === generation) pending = null;
      });
  }
  const session = await pending;
  signal?.throwIfAborted();
  return session;
}

export async function endVisitorSession(signal?: AbortSignal) {
  const session = await ensureVisitorSession(false, signal);
  ending = true;
  forgetVisitorSession();
  try {
    await post("/agent/logout", undefined, session.csrf_token, signal);
  } finally {
    ending = false;
  }
}

export async function prepareTourVoice(
  source: TourVoiceSource,
  signal?: AbortSignal,
): Promise<VoiceManifest> {
  for (let attempt = 0; ; attempt++) {
    const session = await ensureVisitorSession(true, signal);
    try {
      const result = await post<{ permit: string | null; chunks: string[] }>(
        "/voice/prepare",
        { source },
        session.csrf_token,
        signal,
      );
      return { ...result, csrf: session.csrf_token };
    } catch (error) {
      if (
        !(error instanceof NativeError) ||
        error.status !== 401 ||
        attempt > 0
      )
        throw error;
      // Preparing a source is unpaid. An expired guest may be replaced once;
      // the supplier request itself is never retried by this helper.
      forgetVisitorSession();
    }
  }
}

export async function prepareDraftVoice(
  source: DraftVoiceSource,
  staffCsrf: string,
  signal?: AbortSignal,
): Promise<VoiceManifest> {
  const result = await post<{ permit: string | null; chunks: string[] }>(
    "/admin/voice/prepare",
    { source },
    staffCsrf,
    signal,
  );
  return { ...result, csrf: staffCsrf, endpoint: "/admin/voice/speech" };
}
