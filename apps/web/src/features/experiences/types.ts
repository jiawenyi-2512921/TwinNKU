import type { components } from "../../shared/api/schema";
export type Experience = components["schemas"]["PublicExperience"];
export type AdminExperience = components["schemas"]["AdminExperience"];
export type ExperienceContent = Experience["content"];
export type ExperienceKind = ExperienceContent["kind"];
export type ExperienceStop = components["schemas"]["ExperienceStop"];
export type TourResource = components["schemas"]["TourResource"];
export type TourMainView =
  | NonNullable<components["schemas"]["TourSegment"]["main_view"]>
  | { type: "video"; id: string; revision: number }
  | { type: "vr_entry"; id: string; revision: number };
export type TourSegment = Omit<
  components["schemas"]["TourSegment"],
  "main_view" | "resources"
> & {
  main_view: TourMainView;
  resources: TourResource[];
  title?: string;
  observation_prompt?: string;
  takeaway?: string;
  narration_asset_id?: string | null;
};
export type ExperienceUpload = components["schemas"]["ExperienceUpload"];
export const experienceNames: Record<ExperienceKind, string> = {
  media: "图片与视频",
  checkin: "打卡点",
  tour: "校园导览路线",
};
export function sceneResource(
  view: TourResource | Exclude<TourMainView, { type: "map" }>,
): TourResource {
  return {
    id: view.id,
    revision: view.revision,
    type: view.type === "vr_entry" ? "vr" : view.type,
  };
}
