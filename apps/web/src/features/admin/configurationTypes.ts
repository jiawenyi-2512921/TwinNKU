import type {
  MapDefaultView,
  MapFocusEffect,
  MapLayer,
} from "../map/mapDefaults";

export type ConfigurationKind = "presentation" | "visit_defaults" | "runtime";
export type ConfigurationReference = {
  type: "image" | "tour";
  id: string;
  revision: number;
};
export type ModuleType =
  | "hero"
  | "visit_modes"
  | "continue_visit"
  | "featured_routes"
  | "all_routes"
  | "introduction"
  | "resource_entries"
  | "announcement";
export type PresentationModule = {
  id: string;
  type: ModuleType;
  enabled: boolean;
  title: string;
  body: string;
  button_label: string;
  layout: "default" | "wide" | "split";
  image: ConfigurationReference | null;
  routes: ConfigurationReference[];
  target:
    | { type: "home" | "map" | "vr" | "routes" }
    | { type: "tour"; id: string; revision: number }
    | null;
  image_focus: { x: number; y: number };
  alt: string;
  source_url?: string | null;
  start_at?: string | null;
  end_at?: string | null;
};
export type PresentationContent = {
  kind: "presentation";
  site_name: string;
  description: string;
  footer: string;
  contact_help: string;
  appearance: {
    palette: "nku-purple" | "light-purple";
    density: "comfortable" | "compact";
    radius: "soft" | "square";
  };
  modules: PresentationModule[];
};
export type VisitDefaultsContent = {
  kind: "visit_defaults";
  layout: "balanced" | "scene_first" | "reading_first";
  assistant_collapsed: boolean;
  welcome_text: string;
  recommended_questions: string[];
  map_categories: string[];
  map_show_labels: boolean;
  map_default_view: MapDefaultView | null;
  map_layers: MapLayer[];
  map_focus_effect: MapFocusEffect;
};
export type RuntimeContent = {
  kind: "runtime";
  chat_enabled: boolean;
  navigation_enabled: boolean;
  auto_actions: boolean;
  allowed_actions: string[];
  voice_enabled: boolean;
  narration_generation_enabled: boolean;
  narration_playback_enabled: boolean;
  profile_id: "cherry";
  [key: string]: string | number | boolean | string[];
};
export type ConfigurationContent =
  | PresentationContent
  | VisitDefaultsContent
  | RuntimeContent;
export type AdminConfiguration = {
  id: string;
  kind: ConfigurationKind;
  scope: string;
  schema_version: number;
  revision: number;
  published_revision: number;
  state: "draft" | "in_review" | "rejected" | "published";
  draft: ConfigurationContent;
  published: ConfigurationContent | null;
  override_fields?: string[];
  contributor_ids: string[];
  submitted_by: string | null;
  submitted_at: string | null;
  resume_services: string[];
  review_note: string;
  updated_at: string;
  permissions: { edit: boolean; review: boolean };
  content_sha256: string;
};
export type ConfigurationVersion = {
  id: string;
  configuration_id: string;
  event: string;
  revision: number;
  published_revision: number;
  content: ConfigurationContent;
  override_fields: string[];
  content_sha256: string;
  contributor_ids: string[];
  actor_id: string | null;
  created_at: string;
};
export type ConfigurationPreflight = {
  valid: boolean;
  revision: number;
  content_sha256: string;
  dependency_sha256: string;
  issues: {
    code: string;
    severity: "warning" | "error";
    path: string;
    message: string;
    expected_revision?: number | null;
    actual_revision?: number | null;
  }[];
};
export const configurationNames = {
  presentation: "首页与展示编排",
  visit_defaults: "参观默认设置",
  runtime: "服务与费用设置",
};
export const moduleNames: Record<ModuleType, string> = {
  hero: "首页主视觉",
  visit_modes: "参观方式",
  continue_visit: "继续参观",
  featured_routes: "推荐路线",
  all_routes: "全部路线",
  introduction: "校园介绍",
  resource_entries: "地图与 VR 入口",
  announcement: "公告",
};
export function newModule(type: ModuleType): PresentationModule {
  return {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    title: "",
    body: "",
    button_label: "开始发现",
    layout: "default",
    image: null,
    routes: [],
    target: null,
    image_focus: { x: 0.5, y: 0.5 },
    alt: "",
    source_url: null,
    start_at: null,
    end_at: null,
  };
}
export function defaultConfiguration(
  kind: ConfigurationKind,
): ConfigurationContent {
  if (kind === "presentation")
    return {
      kind,
      site_name: "南开校园文化导览",
      description: "",
      footer: "",
      contact_help: "",
      appearance: {
        palette: "nku-purple",
        density: "comfortable",
        radius: "soft",
      },
      modules: (
        [
          "hero",
          "visit_modes",
          "continue_visit",
          "all_routes",
          "resource_entries",
        ] as ModuleType[]
      ).map(newModule),
    };
  if (kind === "visit_defaults")
    return {
      kind,
      layout: "balanced",
      assistant_collapsed: true,
      welcome_text: "",
      recommended_questions: [],
      map_categories: [],
      map_show_labels: true,
      map_default_view: null,
      map_layers: ["point_regions"],
      map_focus_effect: "short",
    };
  return {
    kind,
    chat_enabled: false,
    navigation_enabled: true,
    auto_actions: true,
    allowed_actions: [
      "focus_point",
      "show_floor",
      "open_vr",
      "show_route",
      "show_checkin",
      "play_video",
      "show_tour",
    ],
    voice_enabled: false,
    narration_generation_enabled: false,
    narration_playback_enabled: true,
    profile_id: "cherry",
    visitor_turns_per_hour: 30,
    total_turns_per_hour: 120,
    model_requests_per_day: 720,
    voice_visitor_requests_per_hour: 45,
    voice_total_requests_per_hour: 200,
    voice_requests_per_day: 1200,
    supplier_requests_per_day: 1920,
    supplier_characters_per_day: 360000,
    supplier_session_requests_per_day: 450,
    ip_requests_per_hour: 180,
    ip_requests_per_day: 1080,
    http_requests_per_hour: 2400,
    http_requests_per_day: 14400,
  };
}
