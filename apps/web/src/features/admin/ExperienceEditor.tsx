import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { get, type Floor, type Panorama } from "../../shared/api/client";
import { TourPlayer, type TourNarration } from "../experiences/ExperiencePanel";
import {
  moveSegment,
  newSegment,
  normalizeSegment,
} from "../experiences/segments";
import type {
  AdminExperience,
  Experience,
  ExperienceContent,
  TourMainView,
  TourResource,
  TourSegment,
} from "../experiences/types";
import { message, request } from "./api";
const AdminTourMapPreview = lazy(() => import("./AdminTourMapPreview"));

type TourContent = Extract<ExperienceContent, { kind: "tour" }>;
type Candidate = TourResource & { label: string };
const labels = {
  image: "图片",
  floor: "楼层",
  video: "视频",
  vr: "VR 全景",
  checkin: "打卡",
};
const keyFor = (item: TourResource | Exclude<TourMainView, { type: "map" }>) =>
  `${item.type === "vr_entry" ? "vr" : item.type}:${item.id}:${item.revision}`;
const refFor = ({ type, id, revision }: Candidate): TourResource => ({
  type,
  id,
  revision,
});

function publicItems(rows: AdminExperience[]): Experience[] {
  return rows.flatMap((row) =>
    row.status === "published" && row.published_content
      ? [
          {
            id: row.id,
            campus_id: row.campus_id,
            revision: row.published_revision,
            content: row.published_content,
            media_url:
              row.published_content.kind === "media"
                ? row.published_content.url ||
                  `/api/v1/experiences/${row.id}/media`
                : null,
            caption_url:
              row.published_content.kind === "media" &&
              row.published_content.caption_upload_id
                ? `/api/v1/experiences/${row.id}/captions/${row.published_revision}/${row.published_content.caption_upload_id}`
                : null,
          },
        ]
      : [],
  );
}

export function ExperienceEditor({
  content,
  activeStop,
  mediaRows,
  checkinRows,
  onChange,
  mode = "all",
  focusSegmentId,
}: {
  content: TourContent;
  activeStop: number;
  mediaRows: AdminExperience[];
  checkinRows: AdminExperience[];
  onChange: (content: TourContent) => void;
  mode?: "all" | "cover" | "segments";
  focusSegmentId?: string;
}) {
  const stop = content.stops[activeStop];
  const pointId = stop?.point_id ?? "";
  const [floors, setFloors] = useState<Floor[]>([]);
  const [panoramas, setPanoramas] = useState<Panorama[]>([]);
  const [resourceError, setResourceError] = useState("");
  const [resourceRetry, setResourceRetry] = useState(0);
  const [templateHints, setTemplateHints] = useState<
    Record<string, "map" | "image" | "floor" | "video" | "vr">
  >({});
  const editor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusSegmentId || mode === "cover") return;
    const cards =
      editor.current?.querySelectorAll<HTMLElement>("[data-segment-id]");
    const card = [...(cards ?? [])].find(
      (element) => element.dataset.segmentId === focusSegmentId,
    );
    card?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [focusSegmentId, activeStop, mode]);
  useEffect(() => {
    const controller = new AbortController();
    setFloors([]);
    setPanoramas([]);
    setResourceError("");
    if (!pointId) return () => controller.abort();
    void Promise.all([
      get<Floor[]>(`/points/${pointId}/floors`, controller.signal),
      get<Panorama[]>(`/points/${pointId}/panoramas`, controller.signal),
    ])
      .then(([a, b]) => {
        if (controller.signal.aborted) return;
        setFloors(a.data);
        setPanoramas(b.data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResourceError("楼层或VR资料暂时读取失败，请重新读取。");
      });
    return () => controller.abort();
  }, [pointId, resourceRetry]);
  const items = publicItems([...mediaRows, ...checkinRows]);
  const candidates: Candidate[] = [
    ...items.flatMap((item): Candidate[] =>
      item.content.kind !== "tour" && item.content.point_id === pointId
        ? [
            {
              type:
                item.content.kind === "checkin"
                  ? "checkin"
                  : item.content.media_type,
              id: item.id,
              revision: item.revision,
              label: item.content.title,
            },
          ]
        : [],
    ),
    ...floors
      .filter((floor) => floor.point_id === pointId)
      .map(
        (floor): Candidate => ({
          type: "floor",
          id: floor.id,
          revision: floor.revision,
          label: floor.label,
        }),
      ),
    ...panoramas
      .filter((vr) => vr.point_id === pointId)
      .map(
        (vr): Candidate => ({
          type: "vr",
          id: vr.id,
          revision: vr.revision,
          label: vr.title,
        }),
      ),
  ];
  const covers = items.filter((item) => {
    const image = item.content;
    return (
      image.kind === "media" &&
      image.media_type === "image" &&
      content.stops.some((entry) => entry.point_id === image.point_id)
    );
  });
  function editSegments(segments: TourSegment[]) {
    onChange({
      ...content,
      stops: content.stops.map((entry, i) =>
        i === activeStop ? { ...entry, segments } : entry,
      ),
    });
  }
  function editSegment(id: string, patch: Partial<TourSegment>) {
    editSegments(
      (stop.segments || []).map(normalizeSegment).map((segment) =>
        segment.id === id
          ? {
              ...segment,
              ...patch,
              ...(patch.text !== undefined && patch.text !== segment.text
                ? { narration_asset_id: null }
                : {}),
            }
          : segment,
      ),
    );
  }
  function enableSegments() {
    const resources: TourResource[] = [];
    for (const [id, type] of [
      [stop.video_id, "video"],
      [stop.checkin_id, "checkin"],
    ] as const) {
      if (!id) continue;
      const found = candidates.find(
        (candidate) => candidate.id === id && candidate.type === type,
      );
      if (!found) {
        setResourceError(
          "旧站点引用的资料已不可用，请先在原单段设置中处理该引用，再添加分段。原文已保留。",
        );
        return;
      }
      resources.push(refFor(found));
    }
    // Backend explicit conversion preserves legacy media timing. Local conversion only
    // changes the selected draft and retains the legacy fields for the adapter.
    onChange({
      ...content,
      stops: content.stops.map((entry, i) =>
        i === activeStop
          ? {
              ...entry,
              legacy_media_compat: true,
              segments: [
                {
                  ...newSegment(),
                  text: stop.narrative,
                  source_note: content.source_note,
                  resources,
                },
              ],
            }
          : entry,
      ),
    });
  }
  return (
    <section
      ref={editor}
      className="ad-segment-editor"
      aria-label="路线画面与分段编排"
    >
      <div hidden={mode === "segments"}>
        <label>
          路线封面
          <select
            value={
              content.cover_image_id
                ? `${content.cover_image_id}:${content.cover_image_revision}`
                : ""
            }
            onChange={(event) => {
              const cover = covers.find(
                (item) => `${item.id}:${item.revision}` === event.target.value,
              );
              onChange({
                ...content,
                cover_image_id: cover?.id ?? null,
                cover_image_revision: cover?.revision ?? null,
              });
            }}
          >
            <option value="">使用路线简洁封面</option>
            {content.cover_image_id &&
              !covers.some(
                (item) =>
                  item.id === content.cover_image_id &&
                  item.revision === content.cover_image_revision,
              ) && (
                <option
                  value={`${content.cover_image_id}:${content.cover_image_revision}`}
                >
                  原封面已变更，请重新选择
                </option>
              )}
            {covers.map((item) => (
              <option key={item.id} value={`${item.id}:${item.revision}`}>
                {item.content.title}
              </option>
            ))}
          </select>
          <small>仅可使用这条路线站点的已发布图片。</small>
        </label>
        {(["x", "y"] as const).map((axis) => (
          <label key={axis}>
            封面裁切焦点 · {axis === "x" ? "水平" : "垂直"}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={content.cover_focus?.[axis] ?? 0.5}
              onChange={(e) =>
                onChange({
                  ...content,
                  cover_focus: {
                    ...content.cover_focus,
                    x: content.cover_focus?.x ?? 0.5,
                    y: content.cover_focus?.y ?? 0.5,
                    [axis]: Number(e.target.value),
                  },
                })
              }
            />
            <small>只改变展示裁切，不修改原图片。</small>
          </label>
        ))}
      </div>
      {stop && mode !== "cover" && (
        <>
          <label>
            本站显示标题（可选）
            <input
              maxLength={120}
              value={stop.title ?? ""}
              onChange={(event) =>
                onChange({
                  ...content,
                  stops: content.stops.map((entry, i) =>
                    i === activeStop
                      ? { ...entry, title: event.target.value || null }
                      : entry,
                  ),
                })
              }
              placeholder="留空使用地点名称"
            />
          </label>
          <h4>第 {activeStop + 1} 站的讲解编排</h4>
          {!stop.segments ? (
            <div className="ad-segment-legacy">
              <p>
                本站保留原有单段讲解和媒体出现时机。添加分段后可逐段选择画面与资料，原讲解文字会带入第一段。
              </p>
              <button
                type="button"
                disabled={!pointId}
                onClick={enableSegments}
              >
                添加分段讲解
              </button>
            </div>
          ) : (
            <>
              {stop.segments.map(normalizeSegment).map((segment, index) => (
                <fieldset
                  key={segment.id}
                  className="ad-segment-card"
                  data-segment-id={segment.id}
                  data-issue-focus={segment.id === focusSegmentId || undefined}
                >
                  <legend>第 {index + 1} 段</legend>
                  {segment.id === focusSegmentId && (
                    <p role="status">
                      检查结果指向本段；请核对当前讲稿、画面和素材。
                    </p>
                  )}
                  {templateHints[segment.id] && (
                    <div role="status">
                      {templateHints[segment.id] === "map"
                        ? "地图讲解结构：填写本站讲稿与来源。"
                        : `请明确选择本站已发布${labels[templateHints[segment.id] as keyof typeof labels]}作为画面，并填写观察提示与来源。`}
                      <button
                        type="button"
                        onClick={() =>
                          setTemplateHints((v) => {
                            const next = { ...v };
                            delete next[segment.id];
                            return next;
                          })
                        }
                      >
                        显示全部画面类型
                      </button>
                    </div>
                  )}
                  <div className="ad-tour-order">
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={`第 ${index + 1} 段上移`}
                      onClick={() =>
                        editSegments(
                          moveSegment(
                            stop.segments!.map(normalizeSegment),
                            index,
                            -1,
                          ),
                        )
                      }
                    >
                      ↑ 上移
                    </button>
                    <button
                      type="button"
                      disabled={index === stop.segments!.length - 1}
                      aria-label={`第 ${index + 1} 段下移`}
                      onClick={() =>
                        editSegments(
                          moveSegment(
                            stop.segments!.map(normalizeSegment),
                            index,
                            1,
                          ),
                        )
                      }
                    >
                      ↓ 下移
                    </button>
                    <button
                      type="button"
                      disabled={stop.segments!.length === 1}
                      onClick={() =>
                        editSegments(
                          stop
                            .segments!.filter(
                              (entry) => entry.id !== segment.id,
                            )
                            .map(normalizeSegment),
                        )
                      }
                    >
                      移除此段
                    </button>
                  </div>
                  <label>
                    本段标题（可选）
                    <input
                      maxLength={120}
                      value={segment.title ?? ""}
                      onChange={(e) =>
                        editSegment(segment.id, { title: e.target.value })
                      }
                    />
                    <small>用于段落目录；留空使用段落序号。</small>
                  </label>
                  <label>
                    本段讲解
                    <textarea
                      rows={5}
                      maxLength={8000}
                      value={segment.text}
                      onChange={(event) =>
                        editSegment(segment.id, { text: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    本段主画面
                    <select
                      value={
                        segment.main_view.type === "map"
                          ? "map"
                          : keyFor(segment.main_view)
                      }
                      onChange={(event) => {
                        const candidate = candidates.find(
                          (entry) => keyFor(entry) === event.target.value,
                        );
                        editSegment(segment.id, {
                          main_view:
                            (candidate &&
                              (candidate.type === "image" ||
                                candidate.type === "floor")) ||
                            (candidate &&
                              (candidate.type === "video" ||
                                candidate.type === "vr"))
                              ? {
                                  type:
                                    candidate.type === "vr"
                                      ? "vr_entry"
                                      : candidate.type,
                                  id: candidate.id,
                                  revision: candidate.revision,
                                }
                              : { type: "map" },
                        });
                        setTemplateHints((v) => {
                          const next = { ...v };
                          delete next[segment.id];
                          return next;
                        });
                      }}
                    >
                      <option value="map">本站地图</option>
                      {segment.main_view.type !== "map" &&
                        !candidates.some(
                          (entry) =>
                            keyFor(entry) ===
                            keyFor(
                              segment.main_view as Exclude<
                                TourMainView,
                                { type: "map" }
                              >,
                            ),
                        ) && (
                          <option value={keyFor(segment.main_view)}>
                            当前画面已变更，请重新选择
                          </option>
                        )}
                      {candidates
                        .filter(
                          (entry) =>
                            !templateHints[segment.id] ||
                            templateHints[segment.id] === "map" ||
                            entry.type === templateHints[segment.id],
                        )
                        .filter(
                          (entry) =>
                            entry.type === "image" ||
                            entry.type === "floor" ||
                            entry.type === "video" ||
                            entry.type === "vr",
                        )
                        .map((entry) => (
                          <option key={keyFor(entry)} value={keyFor(entry)}>
                            {labels[entry.type]} · {entry.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  {segment.main_view.type === "floor" && (
                    <label>
                      楼层分区
                      <select
                        value={segment.main_view.section_id ?? ""}
                        onChange={(e) => {
                          if (segment.main_view.type !== "floor") return;
                          editSegment(segment.id, {
                            main_view: {
                              ...segment.main_view,
                              section_id: e.target.value || null,
                            },
                          });
                        }}
                      >
                        <option value="">默认分区</option>
                        {floors
                          .find(
                            (f) =>
                              segment.main_view.type === "floor" &&
                              f.id === segment.main_view.id,
                          )
                          ?.images?.map((image) => (
                            <option key={image.section} value={image.section}>
                              {image.section}
                            </option>
                          ))}
                      </select>
                      <small>
                        只选择这版楼层公开清单里的分区，不猜测房间位置。
                      </small>
                    </label>
                  )}
                  {segment.main_view.type === "vr_entry" && (
                    <p className="ad-muted">
                      VR
                      主画面展示官方入口卡。原站在新标签页打开，本站不能控制第三方视角或保证外站可达。
                    </p>
                  )}
                  <label>
                    添加本段资料
                    <select
                      value=""
                      onChange={(event) => {
                        const candidate = candidates.find(
                          (entry) => keyFor(entry) === event.target.value,
                        );
                        if (
                          candidate &&
                          !segment.resources.some(
                            (entry) =>
                              entry.type === candidate.type &&
                              entry.id === candidate.id,
                          )
                        )
                          editSegment(segment.id, {
                            resources: [
                              ...segment.resources,
                              refFor(candidate),
                            ],
                          });
                      }}
                      disabled={segment.resources.length >= 25}
                    >
                      <option value="">选择本站的已发布资料</option>
                      {candidates
                        .filter(
                          (entry) =>
                            !segment.resources.some(
                              (r) => r.type === entry.type && r.id === entry.id,
                            ),
                        )
                        .map((entry) => (
                          <option key={keyFor(entry)} value={keyFor(entry)}>
                            {labels[entry.type]} · {entry.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <ul className="ad-segment-references">
                    {segment.resources.map((resource, resourceIndex) => (
                      <li key={keyFor(resource)}>
                        <span>
                          {labels[resource.type]} ·{" "}
                          {candidates.find(
                            (entry) => keyFor(entry) === keyFor(resource),
                          )?.label ?? "资料已变更，请重新选择"}
                        </span>
                        <button
                          type="button"
                          disabled={resourceIndex === 0}
                          aria-label={`上移资料 ${resourceIndex + 1}`}
                          onClick={() => {
                            const resources = [...segment.resources];
                            [
                              resources[resourceIndex - 1],
                              resources[resourceIndex],
                            ] = [
                              resources[resourceIndex],
                              resources[resourceIndex - 1],
                            ];
                            editSegment(segment.id, { resources });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={
                            resourceIndex === segment.resources.length - 1
                          }
                          aria-label={`下移资料 ${resourceIndex + 1}`}
                          onClick={() => {
                            const resources = [...segment.resources];
                            [
                              resources[resourceIndex + 1],
                              resources[resourceIndex],
                            ] = [
                              resources[resourceIndex],
                              resources[resourceIndex + 1],
                            ];
                            editSegment(segment.id, { resources });
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            editSegment(segment.id, {
                              resources: segment.resources.filter(
                                (entry) => keyFor(entry) !== keyFor(resource),
                              ),
                            })
                          }
                        >
                          移除资料
                        </button>
                      </li>
                    ))}
                  </ul>
                  <label>
                    本段来源说明
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={segment.source_note}
                      onChange={(event) =>
                        editSegment(segment.id, {
                          source_note: event.target.value,
                        })
                      }
                      placeholder="注明这一段的事实依据与素材来源"
                    />
                  </label>
                  <label>
                    观察提示
                    <textarea
                      maxLength={800}
                      rows={2}
                      value={segment.observation_prompt ?? ""}
                      onChange={(e) =>
                        editSegment(segment.id, {
                          observation_prompt: e.target.value,
                        })
                      }
                    />
                    <small>
                      请访客观察真实画面或现场，不把提示作为自动签到或已验证结论。
                    </small>
                  </label>
                  <label>
                    参观回顾收获
                    <textarea
                      maxLength={500}
                      rows={2}
                      value={segment.takeaway ?? ""}
                      onChange={(e) =>
                        editSegment(segment.id, { takeaway: e.target.value })
                      }
                    />
                    <small>显示在回顾页；留空不生成总结。</small>
                  </label>
                  <button
                    type="button"
                    disabled={stop.segments!.length >= 50}
                    onClick={() => {
                      const next = stop.segments!.map(normalizeSegment);
                      next.splice(index + 1, 0, {
                        ...structuredClone(segment),
                        id: crypto.randomUUID(),
                        narration_asset_id: null,
                      });
                      editSegments(next);
                    }}
                  >
                    复制本段（生成新标识并清除音频）
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                disabled={stop.segments.length >= 50}
                onClick={() =>
                  editSegments([
                    ...stop.segments!.map(normalizeSegment),
                    newSegment(),
                  ])
                }
              >
                ＋ 添加讲解段落
              </button>
              <label>
                按结构添加段落
                <select
                  value=""
                  disabled={stop.segments.length >= 50}
                  onChange={(event) => {
                    const segment = newSegment();
                    setTemplateHints((v) => ({
                      ...v,
                      [segment.id]: event.target.value as
                        | "map"
                        | "image"
                        | "floor"
                        | "video"
                        | "vr",
                    }));
                    editSegments([
                      ...stop.segments!.map(normalizeSegment),
                      segment,
                    ]);
                  }}
                >
                  <option value="">选择讲解结构</option>
                  <option value="map">地图定位＋讲解</option>
                  <option value="image">图片观察＋讲解</option>
                  <option value="floor">楼层分区＋讲解</option>
                  <option value="video">视频片段＋讲解</option>
                  <option value="vr">VR 入口＋讲解</option>
                </select>
                <small>
                  先建立空白段落，再明确选择本站画面。模板不自动挑图片、楼层或
                  VR；讲稿与事实依据由团队填写。
                </small>
              </label>
            </>
          )}
        </>
      )}
      {resourceError && (
        <div role="alert">
          <p>{resourceError}</p>
          <button type="button" onClick={() => setResourceRetry((n) => n + 1)}>
            重新读取本站资料
          </button>
        </div>
      )}
    </section>
  );
}

export function ExperienceTourPreview({
  content,
  mediaRows,
  checkinRows,
  pointNames,
  savedId,
  draftRevision,
  dirty,
  onNarrate,
  onNarrationStop,
}: {
  content: TourContent;
  mediaRows: AdminExperience[];
  checkinRows: AdminExperience[];
  pointNames: Record<string, string>;
  savedId?: string;
  draftRevision?: number;
  dirty: boolean;
  onNarrate?: (narration: TourNarration) => void;
  onNarrationStop?: () => void;
}) {
  const [preview, setPreview] = useState<Experience | null>(null);
  const [previewSaved, setPreviewSaved] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewPoint, setPreviewPoint] = useState("");
  const [previewSize, setPreviewSize] = useState<"desktop" | "mobile">(
    "desktop",
  );
  const [mainView, setMainView] = useState<{
    view: TourMainView;
    pointId: string;
  } | null>(null);
  const [mapRequested, setMapRequested] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const items = publicItems([...mediaRows, ...checkinRows]);
  useEffect(() => {
    setPreview(null);
    setPreviewPoint("");
    setMainView(null);
    setMapRequested(false);
    setPreviewBusy(false);
    return () => pending.current?.abort();
  }, [savedId, draftRevision]);
  async function showSavedPreview() {
    if (!savedId || !draftRevision || dirty || previewBusy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await request<Experience>(
        `/experiences/${savedId}/preview?expected_revision=${draftRevision}`,
        "GET",
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPreview(result.data);
      setPreviewSaved(true);
    } catch (error) {
      if (!controller.signal.aborted) setPreviewError(message(error));
    } finally {
      if (pending.current === controller) setPreviewBusy(false);
    }
  }
  return (
    <section
      className="ad-tour-preview-workspace"
      aria-label="工作人员路线预览"
    >
      <div className="ad-tour-preview-actions">
        <button
          type="button"
          aria-pressed={previewSize === "desktop"}
          onClick={() => setPreviewSize("desktop")}
        >
          电脑宽度预览
        </button>
        <button
          type="button"
          aria-pressed={previewSize === "mobile"}
          onClick={() => setPreviewSize("mobile")}
        >
          手机宽度预览
        </button>
        <button
          type="button"
          disabled={previewBusy || !savedId || !draftRevision || dirty}
          onClick={() => void showSavedPreview()}
        >
          预览已保存版本
        </button>
        <button
          type="button"
          onClick={() => {
            pending.current?.abort();
            setPreviewBusy(false);
            setPreview({
              id: savedId || "local-preview",
              campus_id: content.campus_id,
              revision: draftRevision || 0,
              content,
              media_url: null,
            });
            setPreviewSaved(false);
            setPreviewError("");
          }}
        >
          预览当前编辑
        </button>
      </div>
      {previewError && <p role="alert">{previewError}</p>}
      {preview && (
        <section
          className="ad-tour-preview"
          aria-label={
            previewSaved ? "已保存路线的工作人员预览" : "当前编辑的本地预览"
          }
        >
          <header>
            <strong>{previewSaved ? "已保存版本预览" : "当前编辑预览"}</strong>
            <button
              type="button"
              onClick={() => {
                pending.current?.abort();
                setPreview(null);
                setPreviewPoint("");
                onNarrationStop?.();
              }}
            >
              关闭预览
            </button>
          </header>
          {!previewSaved && (
            <p>当前编辑只在此页面预览，保存并审核通过后才公开。</p>
          )}
          <small>宽度预览检查布局，不代替真实手机、字幕和扬声器验收。</small>
          {previewPoint && (
            <p role="status">
              预览已选择：{pointNames[previewPoint] || "本站地点"}
              。实际导览通过地图按钮定位。
            </p>
          )}
          <div className={`ad-preview-viewport ${previewSize}`}>
            {mainView && mapRequested && (
              <div hidden={mainView.view.type !== "map" && !previewPoint}>
                <Suspense fallback={<p role="status">正在加载地图查看器…</p>}>
                  <AdminTourMapPreview
                    campusId={content.campus_id}
                    pointId={previewPoint || mainView.pointId}
                  />
                </Suspense>
              </div>
            )}
            <TourPlayer
              key={`${preview.id}:${preview.revision}:${previewSaved}`}
              item={preview}
              items={items}
              pointNames={pointNames}
              preview
              draftRevision={previewSaved ? preview.revision : undefined}
              onNarrate={previewSaved ? onNarrate : undefined}
              onNarrationStop={onNarrationStop}
              onSelectPoint={(pointId) => {
                setPreviewPoint(pointId);
                setMapRequested(true);
              }}
              onMainViewChange={(view, pointId) => {
                setMainView({ view, pointId });
                setPreviewPoint("");
                if (view.type === "map") setMapRequested(true);
              }}
            />
          </div>
        </section>
      )}
    </section>
  );
}
