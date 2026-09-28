import type { components } from "../../shared/api/schema";
export type Experience = components["schemas"]["PublicExperience"];
export type AdminExperience = components["schemas"]["AdminExperience"];
export type ExperienceContent = Experience["content"];
export type ExperienceKind = ExperienceContent["kind"];
export type ExperienceStop = components["schemas"]["ExperienceStop"];
export type ExperienceUpload = components["schemas"]["ExperienceUpload"];
export const experienceNames: Record<ExperienceKind, string> = {
  media: "图片与视频",
  checkin: "打卡点",
  tour: "定制路线",
};
