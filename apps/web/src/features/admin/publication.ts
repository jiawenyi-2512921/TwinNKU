import type { api } from "../../shared/api/client";
import type { AdminPoint } from "./api";

export type PublicationCheck = { ok: boolean; message: string };

/** Read back through exactly the same public API used by the visitor client. */
export async function verifyPublication(
  expected: AdminPoint,
  mapId: string,
  source: Pick<typeof api, "point" | "mapFeatures">,
  signal: AbortSignal,
): Promise<PublicationCheck> {
  try {
    const [point, features] = await Promise.all([
      source
        .point(expected.point.id, signal)
        .then((result) => result.data)
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            "status" in error &&
            error.status === 404
          )
            return null;
          throw error;
        }),
      source.mapFeatures(mapId, signal).then((result) => result.data),
    ]);
    const geometry = features.points.find(
      (p) => p.point_id === expected.point.id,
    );
    if (expected.status !== "published" || expected.visibility !== "public")
      return !point && !geometry
        ? {
            ok: true,
            message: "此点位已下架或不是公开可见；已核对公众端不展示。",
          }
        : {
            ok: false,
            message:
              "公开接口仍能读取此点位，与下架或可见范围不符。请联系部署人员核查。",
          };
    if (!point || point.revision !== expected.point.revision)
      return {
        ok: false,
        message: `公开接口${point ? `仍返回正式 v${point.revision}` : "尚未返回此点位"}，本次核对的是 v${expected.point.revision}。请核对后台与客户端地址、服务部署；无需重复审核。`,
      };
    const expectedGeometry = expected.geometries.find(
      (g) => g.map_id === mapId,
    );
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const pointMatches = (
      ["name", "aliases", "category", "summary"] as const
    ).every((key) => same(point[key], expected.point[key]));
    const geometryMatches =
      geometry &&
      expectedGeometry &&
      features.map_id === mapId &&
      features.map_revision === expectedGeometry.map_revision &&
      (
        ["map_id", "map_revision", "anchor", "polygon", "label_on_map"] as const
      ).every((key) => same(geometry[key], expectedGeometry[key]));
    return pointMatches && geometryMatches
      ? {
          ok: true,
          message: `公开接口已核对：正式 v${point.revision} 的资料、定位和点击范围一致。`,
        }
      : {
          ok: false,
          message:
            "公开接口的资料或点击范围与后台正式版本不一致。请重新核对；持续不一致时请联系部署人员。",
        };
  } catch {
    return {
      ok: false,
      message:
        "尚未完成公开核对，可能是网络超时或接口不可用。审核结果已保存，请稍后重新核对。",
    };
  }
}
