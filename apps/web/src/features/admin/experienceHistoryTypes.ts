import type { components } from "../../shared/api/schema";
export type ExperienceVersion = components["schemas"]["ExperienceHistory"];
export type HistoricalResource = components["schemas"]["HistoricalResource"];
export type ExperienceHistoryPreviewData =
  components["schemas"]["ExperienceHistoryPreview"];
export type HistorySnapshot = ExperienceHistoryPreviewData["snapshot"];
export type HistoryBinding = {
  experienceId: string;
  versionId: string;
  snapshot: HistorySnapshot;
  stopIndex: number;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function historyPrefix(binding: HistoryBinding) {
  if (!uuid.test(binding.experienceId) || !uuid.test(binding.versionId))
    throw new Error("历史预览身份无效。");
  return `/experiences/${binding.experienceId}/history/${binding.versionId}`;
}
/** Private file links are tied to the selected snapshot and station, never a public draft URL. */
export function safeHistoryFile(
  value: string | null | undefined,
  binding: HistoryBinding,
  suffix: string,
  path?: string,
): string | null {
  if (
    !value ||
    !value.startsWith("/api/v1/admin/") ||
    /[\s\\\u0000-\u001f]/u.test(value)
  )
    return null;
  const url = new URL(value, "https://private.invalid");
  const keys = [...url.searchParams.keys()];
  if (
    url.hash ||
    keys.length !== (path === undefined ? 2 : 3) ||
    new Set(keys).size !== keys.length ||
    url.pathname !== `/api/v1/admin${historyPrefix(binding)}${suffix}` ||
    url.searchParams.get("snapshot") !== binding.snapshot ||
    url.searchParams.get("stop_index") !== String(binding.stopIndex) ||
    (path !== undefined && url.searchParams.get("path") !== path) ||
    [...url.searchParams.keys()].some(
      (key) =>
        ![
          "snapshot",
          "stop_index",
          ...(path !== undefined ? ["path"] : []),
        ].includes(key),
    )
  )
    return null;
  return value;
}
export function assertHistoryResponse(
  data: ExperienceHistoryPreviewData,
  binding: HistoryBinding,
  originalSha?: string,
) {
  if (
    data.experience_id !== binding.experienceId ||
    data.version_id !== binding.versionId ||
    data.item?.id !== binding.experienceId ||
    data.snapshot !== binding.snapshot ||
    data.stop_index !== binding.stopIndex ||
    !/^[a-f0-9]{64}$/.test(data.snapshot_sha256) ||
    (originalSha && data.snapshot_sha256 !== originalSha) ||
    data.map_context !== "current_public_reference" ||
    !Array.isArray(data.resources)
  )
    throw new Error("历史快照身份或原文指纹已变化，请关闭预览重新读取。");
}
