// This is Twin NKU's parent/frame protocol, NOT a claimed Hiagent SDK API.
export const FRAME_CHANNEL = "twinnku:agent-frame:v1";
export const SDK_ORIGIN = "https://coze.nankai.edu.cn";
export const SDK_URL = `${SDK_ORIGIN}/resources/product/llm/public/sdk/embedFull.js`;

export type AgentContext = {
  campus_id: string;
  campus_name: string;
  point_id: string;
  point_name: string;
  point_revision: string;
  map_id: string;
  map_revision: string;
  floor_id: string;
  floor_label: string;
  floor_section: string;
};

export const EMPTY_CONTEXT: AgentContext = {
  campus_id: "",
  campus_name: "",
  point_id: "",
  point_name: "",
  point_revision: "",
  map_id: "",
  map_revision: "",
  floor_id: "",
  floor_label: "",
  floor_section: "",
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = Object.keys(EMPTY_CONTEXT) as (keyof AgentContext)[];
export function safeContext(input: unknown): AgentContext {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const result = { ...EMPTY_CONTEXT };
  for (const key of keys) {
    const value = source[key];
    if (
      typeof value !== "string" ||
      value.length > 120 ||
      /[\u0000-\u001f]/.test(value)
    )
      continue;
    if (
      ["point_id", "map_id", "floor_id"].includes(key) &&
      value &&
      !uuid.test(value)
    )
      continue;
    if (
      key === "campus_id" &&
      value &&
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)
    )
      continue;
    if (key.endsWith("_revision") && value && !/^[1-9][0-9]{0,9}$/.test(value))
      continue;
    if (
      key === "floor_section" &&
      value &&
      !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)
    )
      continue;
    result[key] = value;
  }
  if (!result.campus_id) return { ...EMPTY_CONTEXT };
  if (!result.point_id) {
    result.point_name = result.point_revision = "";
    result.floor_id = result.floor_label = result.floor_section = "";
  }
  if (!result.floor_id) result.floor_label = result.floor_section = "";
  return result;
}

export function contextKey(context: AgentContext): string {
  return JSON.stringify(keys.map((key) => context[key]));
}

export function contextQuestion(context: AgentContext): string {
  if (context.floor_id)
    return `请介绍${context.campus_name}的${context.point_name}${context.floor_label}。请依据已核实资料回答；没有房间资料时请说明，并提供已发布楼层图入口。`;
  if (context.point_id)
    return `请介绍${context.campus_name}的${context.point_name}，说明值得了解的校园文化，并提供已发布的地图、楼层图或全景入口。没有的资料请说明。`;
  return "请介绍南开大学津南校区有哪些可以在线了解的校园文化点位，并说明资料来源。";
}

export type FrameStatus = "booted" | "loading" | "initialized" | "error";
export type FrameMessage = {
  channel: typeof FRAME_CHANNEL;
  instance: string;
  type: FrameStatus;
  code?: string;
};

export function isFrameMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expectedWindow: MessageEventSource | null,
  origin: string,
  instance: string,
): event is MessageEvent<FrameMessage> {
  const data = event.data;
  return Boolean(
    expectedWindow &&
      event.source === expectedWindow &&
      event.origin === origin &&
      data &&
      typeof data === "object" &&
      data.channel === FRAME_CHANNEL &&
      data.instance === instance &&
      ["booted", "loading", "initialized", "error"].includes(data.type),
  );
}
