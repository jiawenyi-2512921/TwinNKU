import { useEffect, useRef, useState } from "react";
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
  `${item.type}:${item.id}:${item.revision}`;
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
}: {
  content: TourContent;
  activeStop: number;
  mediaRows: AdminExperience[];
  checkinRows: AdminExperience[];
  onChange: (content: TourContent) => void;
}) {
  const stop = content.stops[activeStop];
  const pointId = stop?.point_id ?? "";
  const [floors, setFloors] = useState<Floor[]>([]);
  const [panoramas, setPanoramas] = useState<Panorama[]>([]);
  const [resourceError, setResourceError] = useState("");
  const [resourceRetry, setResourceRetry] = useState(0);
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
      (stop.segments || [])
        .map(normalizeSegment)
        .map((segment) =>
          segment.id === id ? { ...segment, ...patch } : segment,
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
    editSegments([
      {
        ...newSegment(),
        text: stop.narrative,
        source_note: content.source_note,
        resources,
      },
    ]);
  }
  return (
    <section className="ad-segment-editor" aria-label="路线画面与分段编排">
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
      {stop && (
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
                <fieldset key={segment.id} className="ad-segment-card">
                  <legend>第 {index + 1} 段</legend>
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
                            candidate &&
                            (candidate.type === "image" ||
                              candidate.type === "floor")
                              ? {
                                  type: candidate.type,
                                  id: candidate.id,
                                  revision: candidate.revision,
                                }
                              : { type: "map" },
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
                            entry.type === "image" || entry.type === "floor",
                        )
                        .map((entry) => (
                          <option key={keyFor(entry)} value={keyFor(entry)}>
                            {labels[entry.type]} · {entry.label}
                          </option>
                        ))}
                    </select>
                  </label>
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
                    {segment.resources.map((resource) => (
                      <li key={keyFor(resource)}>
                        <span>
                          {labels[resource.type]} ·{" "}
                          {candidates.find(
                            (entry) => keyFor(entry) === keyFor(resource),
                          )?.label ?? "资料已变更，请重新选择"}
                        </span>
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
  const pending = useRef<AbortController | null>(null);
  const items = publicItems([...mediaRows, ...checkinRows]);
  useEffect(() => {
    setPreview(null);
    setPreviewPoint("");
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
          {previewPoint && (
            <p role="status">
              预览已选择：{pointNames[previewPoint] || "本站地点"}
              。实际导览通过地图按钮定位。
            </p>
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
            onSelectPoint={setPreviewPoint}
          />
        </section>
      )}
    </section>
  );
}
