import { useEffect, useRef, useState } from "react";
import { get, type Campus } from "../../shared/api/client";
import { notifyCatalogPublished } from "../../shared/catalogSync";
import {
  experienceNames,
  type AdminExperience,
  type ExperienceContent,
  type ExperienceKind,
  type ExperienceStop,
  type ExperienceUpload,
} from "../experiences/types";
import { inlineVideo, moveStop, safeMediaUrl } from "../experiences/progress";
import {
  request,
  message,
  stateNames,
  type AdminPoint,
  type StaffSession,
} from "./api";
import { Empty, ErrorBox, useResource } from "./ui";
import { ExperienceEditor, ExperienceTourPreview } from "./ExperienceEditor";
import { locateTourIssue, type WorkbenchIssue } from "./WorkspaceIssues";
import { newSegment, normalizeSegment } from "../experiences/segments";
import { DraftCoordinator, type DraftStatus } from "./draftCoordinator";
import { DraftStatusBar } from "./DraftStatus";
import { NarrationStudio } from "./NarrationStudio";
import { ExperienceHistory } from "./ExperienceHistory";
import { VideoDescriptionPicker } from "./VideoDescriptionPicker";
import type { ConfigurationPreflight } from "./configurationTypes";
import { confirmedOperation, UnconfirmedOperation } from "./confirmedOperation";
import type { TourNarration } from "../experiences/ExperiencePanel";
import { TourNarrator } from "../visit/TourNarrator";
import { acquireAudio, releaseAudio } from "../visit/audioOwner";
import "../experiences/experiences.css";
import "./configuration.css";
import type { components } from "../../shared/api/schema";
type CaptionUpload = components["schemas"]["ExperienceCaptionUpload"];
type CaptionFields = Pick<
  Extract<ExperienceContent, { kind: "media" }>,
  "caption_upload_id" | "caption_language" | "caption_label"
>;

const newStop = (point_id: string): ExperienceStop => ({
  point_id,
  narrative: "",
  video_id: null,
  checkin_id: null,
  prompt_timing: "on_arrival",
  legacy_media_compat: false,
});
const resetVideoDecision = {
  video_visual_information: "unassessed" as const, video_accessibility_note: "",
  audio_description_video_id: null, audio_description_video_revision: null,
};
const videoDecisionNames = {
  unassessed: "尚未判断", audio_complete: "原声音完整表达理解所需的关键画面",
  description_required: "仍需口述描述版表达关键画面", silent: "无声视频，采用等价文字说明",
};
const tourSteps = [
  "基本信息",
  "真实地点",
  "段落编排",
  "讲解音频",
  "效果检查",
  "提交审核",
];
const tourStepHelp = [
  "先选择校区，未完成的标题、来源与站点可以保存为私有草稿。提审前需补齐真实内容与事实来源。",
  "搜索实际校园地点加入路线，安排叙事顺序。站点顺序不代表实测步行距离或通行保证。",
  "逐站选择讲解段落、主画面与附属资料。使用本站已发布版本，失效引用需明确处理，不会偷偷升级。",
  "明确生成所选讲稿，听完后手动采用。讲稿变化会让该段旧音频失效；生成不会自动发布。",
  "检查依赖与版本，并使用与公众相同组件私有预览。电脑、手机及真实设备的音频体验需分别确认。",
  "填写变更说明，保存确认后提交。草稿冻结并交给未参与本次编辑的审核成员。",
];
function newContent(kind: ExperienceKind, campus_id = ""): ExperienceContent {
  const base = { title: "", description: "", source_note: "" };
  const point_id = "";
  if (kind === "media")
    return {
      ...base,
      point_id,
      kind,
      media_type: "video",
      upload_id: null,
      url: null,
      alternative_text: "",
      transcript: "",
      caption_upload_id: null,
      caption_language: "zh-CN",
      caption_label: "中文字幕",
      ...resetVideoDecision,
    } as ExperienceContent;
  if (kind === "checkin") return { ...base, point_id, kind, image_id: null };
  return {
    ...base,
    campus_id,
    kind,
    stops: [],
    lead: "",
    outcomes: [],
    sort_order: 0,
    narration_mode: "recorded",
    cover_focus: { x: 0.5, y: 0.5 },
  };
}

export function ExperienceWorkspace({
  session,
  onDirty,
  onUpdate,
  initialId,
  initialIssue,
  kindScope = "all",
  review = false,
  focused = false,
  onReview,
  onTourNarrate,
  onNarrationStop,
}: {
  session: StaffSession;
  onDirty: (dirty: boolean, busy?: boolean) => void;
  onUpdate?: () => void;
  initialId?: string;
  initialIssue?: WorkbenchIssue;
  kindScope?: "all" | "places" | "tours";
  review?: boolean;
  focused?: boolean;
  onReview?: (id: string) => void;
  onTourNarrate?: (narration: TourNarration) => void;
  onNarrationStop?: () => void;
}) {
  const [kind, setKind] = useState<ExperienceKind | "">(
    kindScope === "tours" ? "tour" : "",
  );
  const [state, setState] = useState("");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [points, setPoints] = useState<AdminPoint[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [activeStop, setActiveStop] = useState(0);
  const [focusedSegment, setFocusedSegment] = useState<string | undefined>();
  const [stationQuery, setStationQuery] = useState("");
  const [stationSource, setStationSource] = useState<
    "points" | "videos" | "checkins"
  >("points");
  const [pointsError, setPointsError] = useState("");
  const [selected, setSelected] = useState<AdminExperience | null>(null);
  const [content, setContent] = useState<ExperienceContent | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [captionPreview, setCaptionPreview] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const nativeVideo = useRef<HTMLVideoElement | null>(null);
  const videoLease = useRef<{
    element: HTMLVideoElement;
    lease: number;
    source: string;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState("");
  const [videoReviewConfirmed, setVideoReviewConfirmed] = useState(false);
  useEffect(() => setVideoReviewConfirmed(false), [selected?.id, selected?.revision, selected?.published_revision]);
  const [detailRetry, setDetailRetry] = useState(0);
  const [narration, setNarration] = useState<TourNarration | null>(null);
  const [step, setStep] = useState(0),
    [fullEditor, setFullEditor] = useState(false);
  const [draftStatus, setDraftStatus] =
    useState<DraftStatus<ExperienceContent> | null>(null);
  const [preflight, setPreflight] = useState<ConfigurationPreflight | null>(
    null,
  );
  const [narrationPending, setNarrationPending] = useState(false);
  const [historyPending, setHistoryPending] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const coordinator = useRef<DraftCoordinator<ExperienceContent> | null>(null);
  const stopDraftSubscription = useRef<(() => void) | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(
    () => () => {
      stopDraftSubscription.current?.();
      coordinator.current?.dispose();
    },
    [session.user.id],
  );
  const rows = useResource<AdminExperience[]>(
    `/experiences?${new URLSearchParams({ ...((kindScope === "tours" ? "tour" : kind) ? { kind: kindScope === "tours" ? "tour" : kind } : {}), ...(state ? { state } : {}), ...(query.trim() ? { q: query.trim() } : {}) })}`,
    revision,
  );
  const allMedia = useResource<AdminExperience[]>(
    "/experiences?kind=media&referenceable=true",
    revision,
  );
  const allCheckins = useResource<AdminExperience[]>(
    "/experiences?kind=checkin&referenceable=true",
    revision,
  );
  const editable =
    !review &&
    !pendingOperation &&
    session.permissions.includes("points.edit") &&
    selected?.state !== "in_review";
  const canReview = review && session.permissions.includes("points.review");
  const videoSource =
    content?.kind === "media"
      ? `${selected?.id ?? "new"}:${content.media_type}:${content.upload_id ?? content.url ?? ""}:${content.caption_upload_id ?? ""}`
      : "";
  useEffect(
    () => () => {
      const playing = videoLease.current;
      if (playing?.source === videoSource) {
        playing.element.pause();
        releaseAudio("video", playing.lease);
        videoLease.current = null;
      }
    },
    [videoSource],
  );
  const selfReview =
    !!selected &&
    (selected.contributor_ids.includes(session.user.id) ||
      selected.submitted_by === session.user.id);
  useEffect(() => {
    onDirty(
      dirty || busy,
      busy ||
        !!pendingOperation ||
        narrationPending ||
        historyPending ||
        draftStatus?.phase === "saving" ||
        draftStatus?.phase === "uncertain",
    );
    return () => onDirty(false);
  }, [
    dirty,
    busy,
    pendingOperation,
    narrationPending,
    historyPending,
    draftStatus?.phase,
    onDirty,
  ]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        dirty ||
        busy ||
        pendingOperation ||
        narrationPending ||
        historyPending ||
        draftStatus?.phase === "uncertain"
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    dirty,
    busy,
    pendingOperation,
    narrationPending,
    historyPending,
    draftStatus?.phase,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    setPointsError("");
    async function loadPoints() {
      const collected: AdminPoint[] = [];
      for (let page = 1; ; page++) {
        const result = await request<AdminPoint[]>(
          `/points?page_size=100&page=${page}`,
          "GET",
          undefined,
          controller.signal,
        );
        collected.push(...result.data);
        if (
          !result.data.length ||
          !result.meta.pagination ||
          collected.length >= result.meta.pagination.total
        )
          break;
      }
      if (!controller.signal.aborted) setPoints(collected);
    }
    void Promise.all([
      loadPoints(),
      get<Campus[]>("/campuses", controller.signal).then((result) => {
        if (!controller.signal.aborted) setCampuses(result.data);
      }),
    ]).catch((e) => {
      if (!controller.signal.aborted) setPointsError(message(e));
    });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    request<AdminExperience>(
      `/experiences/${initialId}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) load(r.data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [initialId, detailRetry]);
  function load(item: AdminExperience) {
    setNarration(null);
    setSelected(item);
    const next = ["draft", "in_review", "rejected"].includes(item.state)
      ? (item.content ?? item.published_content)
      : (item.published_content ?? item.content);
    selectedRef.current = item;
    setContent(next);
    if (next) installDraft(item, next);
    const location =
      next?.kind === "tour" && initialIssue
        ? locateTourIssue(next, initialIssue, item)
        : null;
    setActiveStop(location?.stopIndex ?? 0);
    setFocusedSegment(location?.segmentId);
    if (location) {
      setStep(location.step);
      setFullEditor(false);
      setNotice(
        `已定位第 ${location.stopIndex + 1} 站${location.segmentId ? "的指定段落" : ""}。请检查当前内容后再修改。`,
      );
    } else if (initialIssue && item.id === initialIssue.entity_id) {
      setNotice(
        "对象版本或站段已变化，旧检查位置不自动套用。请运行完整检查取得当前位置。",
      );
    }
    setStationQuery("");
    setPreview(item.media_url ?? null);
    setCaptionPreview(
      next?.kind === "media" &&
        next.caption_upload_id &&
        item.caption_url ===
          `/api/v1/admin/experience-captions/${next.caption_upload_id}`
        ? { id: next.caption_upload_id, url: item.caption_url }
        : null,
    );
    setDirty(false);
    setNote("");
    setPreflight(null);
  }
  function installDraft(
    item: AdminExperience | null,
    value: ExperienceContent,
  ) {
    stopDraftSubscription.current?.();
    coordinator.current?.dispose();
    const snap = (row: AdminExperience) => ({
      id: row.id,
      revision: row.revision,
      published_revision: row.published_revision,
      content: row.content ?? row.published_content!,
    });
    const current = new DraftCoordinator<ExperienceContent>(
      item
        ? { ...snap(item), content: value }
        : { id: "", revision: 0, published_revision: 0, content: value },
      {
        save: async (next, version) => {
          const invalid = (text: string) => {
            throw Object.assign(new Error(text), { status: 422 });
          };
          if (next.kind === "tour") {
            const allowed = new Set(
              pointsRef.current
                .filter((p) => p.point.campus_id === next.campus_id)
                .map((p) => p.point.id),
            );
            if (
              !next.campus_id ||
              next.stops.some((s) => !allowed.has(s.point_id))
            )
              invalid("请给每站选择该校区内可管理的真实地点，才能保存草稿。");
          } else if (!next.point_id) invalid("请选择归属地点，才能保存草稿。");
          const existing = selectedRef.current;
          const result = await request<AdminExperience>(
            existing ? `/experiences/${existing.id}` : "/experiences",
            existing ? "PUT" : "POST",
            { ...version, content: next },
          );
          selectedRef.current = result.data;
          setSelected(result.data);
          setRevision((n) => n + 1);
          onUpdate?.();
          return snap(result.data);
        },
        recover: async (operation) => {
          try {
            const r = await request<{ result: AdminExperience }>(
              `/operations/${operation}`,
            );
            selectedRef.current = r.data.result;
            setSelected(r.data.result);
            setRevision((n) => n + 1);
            onUpdate?.();
            return snap(r.data.result);
          } catch (e) {
            if ((e as { status?: number }).status === 404) return null;
            throw e;
          }
        },
        latest: async () => {
          const row = (
            await request<AdminExperience>(
              `/experiences/${selectedRef.current!.id}`,
            )
          ).data;
          selectedRef.current = row;
          setSelected(row);
          return snap(row);
        },
      },
      { initialDirty: !item },
    );
    coordinator.current = current;
    setDraftStatus(current.state);
    stopDraftSubscription.current = current.subscribe((status) => {
      setDraftStatus(status);
      setContent(status.value);
      setDirty(status.dirty);
    });
  }
  function canLeave() {
    return (
      !busy &&
      !narrationPending &&
      !historyPending &&
      !pendingOperation &&
      draftStatus?.phase !== "saving" &&
      draftStatus?.phase !== "uncertain" &&
      (!dirty || window.confirm("当前体验内容尚未保存，确定放弃修改吗？"))
    );
  }
  function edit(next: ExperienceContent) {
    if (!editable || busy || narrationPending || historyPending) return;
    coordinator.current?.retryValidation();
    if (coordinator.current) coordinator.current.edit(next);
    else {
      setContent(next);
      setDirty(true);
    }
    setNotice("");
    setPreflight(null);
  }
  async function choose(item: AdminExperience) {
    if (!canLeave()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      load((await request<AdminExperience>(`/experiences/${item.id}`)).data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function create(value: ExperienceKind) {
    if (review) return;
    if (!canLeave()) return;
    setNarration(null);
    setSelected(null);
    const available = campuses.filter((campus) =>
      points.some((point) => point.point.campus_id === campus.id),
    );
    const next = newContent(
      value,
      available.length === 1 ? available[0].id : "",
    );
    selectedRef.current = null;
    setContent(next);
    installDraft(null, next);
    setStep(0);
    setActiveStop(0);
    setStationQuery("");
    setPreview(null);
    setDirty(true);
    setError("");
    setNotice("");
    setNote("");
  }
  async function save(submit = false): Promise<boolean> {
    if (!content || !editable || busy || !coordinator.current) return false;
    setBusy(true);
    setError("");
    setNotice("");
    const submissionNote =
      note.trim() || `提交${experienceNames[content.kind]}审核`;
    try {
      coordinator.current.retryValidation();
      if (!(await coordinator.current.flush())) {
        setError("保存尚未确认，请先处理保存状态，再预览或提交。");
        return false;
      }
      const saved = selectedRef.current;
      if (submit && saved) {
        const body = {
          expected_revision: saved.revision,
          expected_published_revision: saved.published_revision,
          operation_id: crypto.randomUUID(),
          note: submissionNote,
        };
        const result = await confirmedOperation(
          body.operation_id,
          async () =>
            (
              await request<AdminExperience>(
                `/experiences/${saved.id}/review/submit`,
                "POST",
                body,
              )
            ).data,
          recoverOperation,
        );
        load(result);
        setRevision((n) => n + 1);
        onUpdate?.();
        setNotice("草稿已保存并提交审核，请另一位审核人员核对后发布。");
      } else setNotice("草稿已保存，可以继续编排或提交审核。");
      return true;
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPendingOperation(e.operationId);
      setError(
        (submit && selectedRef.current
          ? "草稿已保存，但提交审核未完成："
          : "") + message(e),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function recoverOperation(id: string): Promise<AdminExperience | null> {
    try {
      return (await request<{ result: AdminExperience }>(`/operations/${id}`))
        .data.result;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }
  async function queryPendingOperation() {
    if (!pendingOperation || busy) return;
    setBusy(true);
    try {
      const row = await recoverOperation(pendingOperation);
      if (!row) throw new Error("该操作还未确认，请保留本页并稍后查询。");
      load(row);
      setPendingOperation(null);
      setError("");
      setNotice("已确认本次操作，没有重复提交。");
      setRevision((n) => n + 1);
      onUpdate?.();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function operate(
    action: "submit" | "publish" | "reject" | "discard" | "retire",
  ) {
    if (!selected || busy || dirty || pendingOperation) return;
    if (["publish", "reject"].includes(action) ? !canReview : review) return;
    if (!note.trim()) {
      setError("请填写本次操作说明。");
      return;
    }
    if (action === "publish" && selected.operation !== "retire" && content?.kind === "media"
      && content.media_type === "video" && !videoReviewConfirmed) {
      setError("请核对本版本画面信息判断及口述描述关联，并明确勾选确认。"); return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        expected_revision: selected.revision,
        expected_published_revision: selected.published_revision,
        operation_id: crypto.randomUUID(),
        note,
        video_accessibility_confirmed: videoReviewConfirmed,
        ...(action === "retire"
          ? { expected_published_revision: selected.published_revision }
          : {}),
      };
      const row = await confirmedOperation(
        body.operation_id,
        async () =>
          (
            await request<AdminExperience>(
              `/experiences/${selected.id}/${action === "retire" ? "retire" : `review/${action}`}`,
              "POST",
              body,
            )
          ).data,
        recoverOperation,
      );
      const result = { data: row };
      load(row);
      setRevision((n) => n + 1);
      onUpdate?.();
      if (action === "publish") {
        notifyCatalogPublished();
        try {
          const publicRows =
            await get<{ id: string; revision: number }[]>("/experiences");
          const found = publicRows.data.find((row) => row.id === selected.id);
          if (
            result.data.status === "retired"
              ? !!found
              : found?.revision !== result.data.published_revision
          )
            throw new Error("公开版本尚未匹配");
          setNotice(
            result.data.status === "retired"
              ? "已下架，公开端已确认隐藏。"
              : "已发布，公开端已确认新版本。",
          );
        } catch {
          setNotice("后台发布已完成，公开端核验暂未通过，请打开校园体验确认。");
        }
      } else
        setNotice(
          {
            submit: "已提交审核，请另一位审核人员核对。",
            reject: "已退回，可继续修改。",
            discard: "本次草稿已撤回。",
            retire: "已创建下架申请，等待另一位审核人员审核。",
          }[action],
        );
    } catch (e) {
      if (e instanceof UnconfirmedOperation) setPendingOperation(e.operationId);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (
      !content ||
      content.kind !== "media" ||
      !content.point_id ||
      !editable ||
      busy
    )
      return;
    const accepted =
      content.media_type === "video"
        ? ["video/mp4", "video/webm"]
        : ["image/jpeg", "image/png"];
    if (!accepted.includes(file.type) || file.size > 100 * 1024 * 1024) {
      setError(
        "请选择对应格式的文件，最大 100 MiB。图片支持 JPG/PNG，视频支持 MP4/WebM。",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<ExperienceUpload>(
        `/points/${content.point_id}/experience-media`,
        "POST",
        file,
      );
      coordinator.current?.retryValidation();
      coordinator.current?.edit({
        ...content,
        upload_id: result.data.id,
        url: null,
        caption_upload_id: null,
        ...resetVideoDecision,
      } as ExperienceContent);
      setCaptionPreview(null);
      setPreview(result.data.url);
      setNotice("文件已上传。保存并通过独立审核后才会公开。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function uploadCaption(file: File) {
    if (
      content?.kind !== "media" ||
      content.media_type !== "video" ||
      !content.point_id ||
      !editable ||
      busy
    )
      return;
    if (
      !file.name.toLowerCase().endsWith(".vtt") ||
      !file.size ||
      file.size > 1024 * 1024
    ) {
      setError("请选择不超过1MiB的 WebVTT 字幕文件。不能填写外部字幕网址。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = (
        await request<CaptionUpload>(
          `/points/${content.point_id}/experience-captions`,
          "POST",
          file.slice(0, file.size, "text/vtt"),
        )
      ).data;
      if (
        result.point_id !== content.point_id ||
        result.mime_type !== "text/vtt" ||
        result.url !== `/api/v1/admin/experience-captions/${result.id}` ||
        !/^[a-f0-9]{64}$/.test(result.sha256)
      )
        throw new Error("字幕上传结果无法核对，未采用该文件。");
      coordinator.current?.retryValidation();
      coordinator.current?.edit({
        ...content,
        caption_upload_id: result.id,
      } as ExperienceContent);
      setCaptionPreview({ id: result.id, url: result.url });
      setNotice(
        `字幕已上传并加入私有草稿，共 ${result.cue_count} 个字幕段。请核对真实画面和时间后再提交独立审核；未公开。`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const mediaRows = (allMedia.data?.data ?? []).filter(
    (row) =>
      row.status === "published" && row.published_content?.kind === "media",
  );
  const checkinRows = (allCheckins.data?.data ?? []).filter(
    (row) =>
      row.status === "published" && row.published_content?.kind === "checkin",
  );
  const publicMediaTitle = (id: string) =>
    [...mediaRows, ...checkinRows].find((row) => row.id === id)
      ?.published_content?.title ?? "当前引用的资料（请核实其公开状态）";
  const pointName = (id: string) =>
    points.find((point) => point.point.id === id)?.point.name ?? "所选地点";
  const campusName = (id: string) =>
    campuses.find((campus) => campus.id === id)?.name ?? "校区资料待加载";
  const availableCampuses = campuses.filter((campus) =>
    points.some((point) => point.point.campus_id === campus.id),
  );
  const allowedKinds: ExperienceKind[] =
    kindScope === "tours"
      ? ["tour"]
      : kindScope === "places"
        ? ["media", "checkin"]
        : ["media", "checkin", "tour"];
  const visibleRows = (rows.data?.data ?? []).filter((row) =>
    allowedKinds.includes((row.content ?? row.published_content)!.kind),
  );
  const routePoints =
    content?.kind === "tour"
      ? points.filter((point) => point.point.campus_id === content.campus_id)
      : points;
  const stationMatches = routePoints.filter(
    (point) =>
      !stationQuery.trim() ||
      [point.point.name, ...(point.point.aliases ?? [])].some((name) =>
        name
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(stationQuery.trim().normalize("NFKC").toLocaleLowerCase()),
      ),
  );
  const stationResources = (
    stationSource === "videos" ? mediaRows : checkinRows
  ).filter((row) => {
    const published = row.published_content;
    return (
      published &&
      published.kind !== "tour" &&
      (stationSource !== "videos" ||
        (published.kind === "media" && published.media_type === "video")) &&
      routePoints.some((point) => point.point.id === published.point_id) &&
      (!stationQuery.trim() ||
        [published.title, pointName(published.point_id)].some((name) =>
          name
            .normalize("NFKC")
            .toLocaleLowerCase()
            .includes(
              stationQuery.trim().normalize("NFKC").toLocaleLowerCase(),
            ),
        ))
    );
  });
  function addStation(pointId: string, resource?: AdminExperience) {
    if (content?.kind !== "tour") return;
    const published = resource?.published_content;
    const entry = {
      ...newStop(pointId),
      ...(content.narration_mode === "recorded"
        ? {
            segments: [
              {
                ...newSegment(),
                resources:
                  resource && published?.kind !== "tour"
                    ? [
                        {
                          type:
                            published?.kind === "checkin"
                              ? ("checkin" as const)
                              : ("video" as const),
                          id: resource.id,
                          revision: resource.published_revision,
                        },
                      ]
                    : [],
              },
            ],
          }
        : {}),
      ...(published?.kind === "media" ? { video_id: resource!.id } : {}),
      ...(published?.kind === "checkin" ? { checkin_id: resource!.id } : {}),
    };
    const blank = content.stops.findIndex((stop) => !stop.point_id);
    const next =
      blank >= 0
        ? content.stops.map((stop, index) => (index === blank ? entry : stop))
        : [...content.stops, entry];
    edit({ ...content, stops: next });
    setActiveStop(blank >= 0 ? blank : next.length - 1);
  }
  function pointOptions(current: string, options = points) {
    return (
      <>
        <option value="">请选择地点</option>
        {current && !options.some((p) => p.point.id === current) && (
          <option value={current}>{pointName(current)}</option>
        )}
        {options.map((point) => (
          <option key={point.point.id} value={point.point.id}>
            {point.point.name}
          </option>
        ))}
      </>
    );
  }
  function mediaOptions(
    mediaType: "image" | "video",
    value: string | null | undefined,
    pointId: string,
  ) {
    const available = mediaRows.filter(
      (row) =>
        row.published_content?.kind === "media" &&
        row.published_content.media_type === mediaType &&
        row.published_content.point_id === pointId,
    );
    return (
      <>
        <option value="">不关联</option>
        {value && !available.some((row) => row.id === value) && (
          <option value={value}>{publicMediaTitle(value)}</option>
        )}
        {available.map((row) => (
          <option key={row.id} value={row.id}>
            {row.published_content?.title} ·{" "}
            {row.published_content?.kind === "media"
              ? pointName(row.published_content.point_id)
              : ""}
          </option>
        ))}
      </>
    );
  }
  function changeStop(index: number, patch: Partial<ExperienceStop>) {
    if (content?.kind === "tour")
      edit({
        ...content,
        stops: content.stops.map((stop, i) => {
          if (i !== index) return stop;
          let next = { ...stop, ...patch };
          if (
            stop.segments?.length &&
            ("video_id" in patch || "checkin_id" in patch)
          ) {
            const type = "video_id" in patch ? "video" : "checkin";
            const oldId = type === "video" ? stop.video_id : stop.checkin_id;
            const id = type === "video" ? patch.video_id : patch.checkin_id;
            const row = (type === "video" ? mediaRows : checkinRows).find(
              (r) => r.id === id,
            );
            next = {
              ...next,
              segments: stop.segments.map((segment, segmentIndex) => {
                const normalized = normalizeSegment(segment);
                const resources = normalized.resources.filter(
                  (r) => !(r.type === type && r.id === oldId),
                );
                return {
                  ...normalized,
                  resources:
                    segmentIndex === 0 && row
                      ? [
                          ...resources.filter(
                            (r) => !(r.type === type && r.id === row.id),
                          ),
                          {
                            type,
                            id: row.id,
                            revision: row.published_revision,
                          },
                        ]
                      : resources,
                };
              }),
            };
          }
          return next;
        }),
      });
  }
  function checkinOptions(value: string | null | undefined, pointId: string) {
    const available = checkinRows.filter(
      (row) =>
        row.published_content?.kind === "checkin" &&
        row.published_content.point_id === pointId,
    );
    return (
      <>
        <option value="">不关联</option>
        {value && !available.some((row) => row.id === value) && (
          <option value={value}>{publicMediaTitle(value)}</option>
        )}
        {available.map((row) => (
          <option key={row.id} value={row.id}>
            {row.published_content?.title} · {pointName(pointId)}
          </option>
        ))}
      </>
    );
  }
  const previewUrl =
    content?.kind === "media" ? safeMediaUrl(content.url || preview) : null;
  const captionUrl =
    content?.kind === "media" &&
    content.caption_upload_id &&
    captionPreview?.id === content.caption_upload_id
      ? captionPreview.url
      : null;
  return (
    <section
      className={`ad-experience-workspace${focused ? " is-focused" : ""}`}
    >
      {!focused && (
        <div className="ad-section-heading">
          <div>
            <div className="ad-eyebrow">CAMPUS EXPERIENCE</div>
            <h1>
              {kindScope === "tours"
                ? "校园导览路线"
                : kindScope === "places"
                  ? "地点影像与打卡"
                  : "校园内容工作台"}
            </h1>
            <p>
              {kindScope === "tours"
                ? "从校区出发，串联多个地点，统一安排讲解、视频和参观顺序。"
                : "整理地点影像与打卡参考，保存后交由另一位成员审核。"}
            </p>
          </div>
        </div>
      )}
      <ErrorBox
        text={error}
        onRetry={
          initialId && !selected
            ? () => setDetailRetry((n) => n + 1)
            : undefined
        }
      />
      {pendingOperation && (
        <button disabled={busy} onClick={() => void queryPendingOperation()}>
          查询本次提交／审核操作结果
        </button>
      )}
      {notice && (
        <p className="ad-notice" role="status">
          {notice}
        </p>
      )}
      <ErrorBox text={pointsError} onRetry={() => setRevision((n) => n + 1)} />
      <div className="ad-experience-layout">
        {!focused && (
          <aside className="ad-card ad-experience-list">
            <label>
              {kindScope === "tours" ? "搜索校园路线" : "搜索体验"}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="标题、介绍或来源"
              />
            </label>
            <div className="ad-experience-filters">
              {kindScope !== "tours" && (
                <label>
                  类型
                  <select
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as ExperienceKind | "")
                    }
                  >
                    <option value="">所有类型</option>
                    {allowedKinds.map((value) => (
                      <option key={value} value={value}>
                        {experienceNames[value]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                审核状态
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="">全部状态</option>
                  {[
                    "draft",
                    "in_review",
                    "rejected",
                    "published",
                    "discarded",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {stateNames[value]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!review && session.permissions.includes("points.edit") && (
              <div className="ad-experience-create">
                {allowedKinds.map((value) => (
                  <button
                    key={value}
                    disabled={busy}
                    onClick={() => create(value)}
                  >
                    ＋{experienceNames[value]}
                  </button>
                ))}
              </div>
            )}
            <ErrorBox
              text={rows.error}
              onRetry={() => setRevision((n) => n + 1)}
            />
            {rows.loading && <p role="status">正在读取…</p>}
            {visibleRows.map((row) => (
              <button
                key={row.id}
                className={`ad-experience-row${selected?.id === row.id ? " is-active" : ""}`}
                aria-pressed={selected?.id === row.id}
                disabled={busy}
                onClick={() => void choose(row)}
              >
                <strong>
                  {row.content?.title ||
                    row.published_content?.title ||
                    "未命名体验草稿"}
                </strong>
                <span>
                  {
                    experienceNames[
                      (row.content ?? row.published_content)!.kind
                    ]
                  }{" "}
                  · {stateNames[row.state]}
                  {row.status === "retired" ? " · 已下架" : ""}
                </span>
                <small>
                  {(row.content ?? row.published_content)?.kind === "tour"
                    ? `${campusName(row.campus_id)} · ${((row.content ?? row.published_content) as Extract<ExperienceContent, { kind: "tour" }>).stops.length} 站`
                    : pointName(
                        (
                          (row.content ?? row.published_content) as Exclude<
                            ExperienceContent,
                            { kind: "tour" }
                          >
                        ).point_id,
                      )}
                </small>
              </button>
            ))}
            {rows.data && !visibleRows.length && (
              <p className="ad-muted">暂无符合筛选的体验。</p>
            )}
          </aside>
        )}
        <div className="ad-card ad-experience-editor">
          {!content ? (
            <Empty
              title={
                kindScope === "tours"
                  ? "开始编排一条校园路线"
                  : "选择一项体验，或新建内容"
              }
              detail={
                kindScope === "tours"
                  ? "选择校区 → 添加校园站点 → 配置讲解与视频 → 保存并提交审核。"
                  : "先整理图片/视频并发布，再将它们关联到打卡点。"
              }
            />
          ) : (
            <>
              <header>
                <span className="ad-eyebrow">
                  {experienceNames[content.kind]}
                </span>
                <h2>
                  {selected
                    ? content.title
                    : content.kind === "tour"
                      ? "新建校园导览路线"
                      : "新建体验"}
                </h2>
                {selected && (
                  <p>
                    {selected.operation === "retire" ? "下架申请 · " : ""}
                    {stateNames[selected.state]} · 已发布版本{" "}
                    {selected.published_revision}
                  </p>
                )}
              </header>
              {draftStatus && coordinator.current && !review && (
                <DraftStatusBar
                  state={draftStatus}
                  coordinator={coordinator.current}
                />
              )}
              {content.kind === "tour" && !review && (
                <>
                  <nav className="ad-tour-steps" aria-label="路线编辑步骤">
                    {tourSteps.map((name, i) => (
                      <button
                        type="button"
                        key={name}
                        aria-current={
                          !fullEditor && step === i ? "step" : undefined
                        }
                        onClick={() => {
                          setFullEditor(false);
                          setStep(i);
                        }}
                      >
                        {i + 1}. {name}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-pressed={fullEditor}
                      onClick={() => setFullEditor((v) => !v)}
                    >
                      完整编辑
                    </button>
                  </nav>
                  <div className="ad-tour-guide" role="status">
                    {fullEditor
                      ? "完整编辑与六步引导编辑同一份内容。"
                      : tourStepHelp[step]}
                  </div>
                </>
              )}
              {review ? (
                <PublishedContent
                  content={content}
                  pointName={pointName}
                  campusName={campusName}
                  mediaTitle={publicMediaTitle}
                />
              ) : (
                <fieldset
                  disabled={
                    !editable || busy || narrationPending || historyPending
                  }
                  className="ad-experience-fields"
                >
                  <legend className="sr-only">体验内容</legend>
                  <div
                    hidden={
                      content.kind === "tour" && !fullEditor && step !== 0
                    }
                  >
                    {content.kind === "tour" ? (
                      <label>
                        路线所属校区
                        <select
                          value={content.campus_id}
                          disabled={!!selected}
                          onChange={(e) => {
                            if (
                              content.stops.some((stop) => stop.point_id) &&
                              !window.confirm(
                                "切换校区将清空当前站点编排，确定继续吗？",
                              )
                            )
                              return;
                            edit({
                              ...content,
                              campus_id: e.target.value,
                              stops: [],
                              cover_image_id: null,
                              cover_image_revision: null,
                            });
                            setActiveStop(0);
                            setStationQuery("");
                          }}
                        >
                          <option value="">请选择校区</option>
                          {content.campus_id &&
                            !availableCampuses.some(
                              (campus) => campus.id === content.campus_id,
                            ) && (
                              <option value={content.campus_id}>
                                {campusName(content.campus_id)}
                              </option>
                            )}
                          {availableCampuses.map((campus) => (
                            <option key={campus.id} value={campus.id}>
                              {campus.name}
                            </option>
                          ))}
                        </select>
                        <small>
                          路线属于整个校区，可以串联校门、建筑、景观和文化点位。
                        </small>
                      </label>
                    ) : (
                      <label>
                        归属地点
                        <select
                          value={content.point_id}
                          disabled={!!selected}
                          onChange={(e) => {
                            const id = e.target.value;
                            if (content.kind === "media") {
                              edit({
                                ...content,
                                point_id: id,
                                upload_id: null,
                                caption_upload_id: null,
                                ...resetVideoDecision,
                              } as ExperienceContent);
                              setPreview(null);
                            } else
                              edit({
                                ...content,
                                point_id: id,
                                image_id: null,
                              });
                          }}
                        >
                          {pointOptions(content.point_id)}
                        </select>
                      </label>
                    )}
                    <label>
                      标题
                      <input
                        maxLength={120}
                        value={content.title}
                        onChange={(e) =>
                          edit({ ...content, title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      {content.kind === "tour" ? "路线介绍" : "介绍与观看提示"}
                      <textarea
                        rows={4}
                        maxLength={8000}
                        value={content.description}
                        onChange={(e) =>
                          edit({ ...content, description: e.target.value })
                        }
                      />
                    </label>
                    {content.kind === "tour" && (
                      <>
                        <label>
                          路线导语
                          <textarea
                            maxLength={800}
                            rows={3}
                            value={content.lead ?? ""}
                            onChange={(e) =>
                              edit({ ...content, lead: e.target.value })
                            }
                          />
                          <small>
                            显示在路线介绍页最先阅读的位置。依据真实资料，用两三句话说明参观主题。
                          </small>
                        </label>
                        {[0, 1, 2].map((i) => (
                          <label key={i}>
                            参观收获 {i + 1}
                            <input
                              maxLength={200}
                              value={content.outcomes?.[i] ?? ""}
                              onChange={(e) => {
                                const next = [...(content.outcomes ?? [])];
                                next[i] = e.target.value;
                                edit({
                                  ...content,
                                  outcomes: next.filter(Boolean),
                                });
                              }}
                            />
                            <small>
                              最多三个，留空不显示；不编造学习测评结果。
                            </small>
                          </label>
                        ))}
                        <label>
                          路线展示排序
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            value={content.sort_order ?? 0}
                            onChange={(e) =>
                              edit({
                                ...content,
                                sort_order: Number(e.target.value),
                              })
                            }
                          />
                          <small>
                            数字较小排在前面，推荐路线由首页编排另行明确选择。
                          </small>
                        </label>
                        <label>
                          讲解方式
                          <select
                            value={content.narration_mode ?? "text"}
                            onChange={(e) =>
                              edit({
                                ...content,
                                narration_mode: e.target.value as
                                  | "text"
                                  | "recorded",
                              })
                            }
                          >
                            <option value="recorded">
                              正式音频导览（新路线默认）
                            </option>
                            <option value="text">纯图文导览（明确选择）</option>
                          </select>
                          <small>
                            正式音频模式需每个非空段落具备匹配、试听并采用的音频才能提交；图文模式不会偷偷生成语音。
                          </small>
                        </label>
                      </>
                    )}
                  </div>
                  {content.kind === "media" && (
                    <>
                      <label>
                        图片文字替代／视频说明
                        <textarea
                          maxLength={4000}
                          rows={3}
                          value={content.alternative_text ?? ""}
                          onChange={(e) =>
                            edit({
                              ...content,
                              alternative_text: e.target.value,
                            })
                          }
                        />
                        <small>
                          向无法看到画面的访客描述重要内容；不写成无意义的“图片”。
                        </small>
                      </label>
                      {content.media_type === "video" && (
                        <section className="ad-caption-editor">
                          <h4>关键画面与声音等价信息</h4>
                          <label>画面信息判断
                            <select value={content.video_visual_information ?? "unassessed"} onChange={(event) => {
                              const value = event.target.value as keyof typeof videoDecisionNames;
                              edit({ ...content, video_visual_information: value,
                                ...(value !== "description_required" ? { audio_description_video_id: null, audio_description_video_revision: null } : {}) });
                            }}>
                              {Object.entries(videoDecisionNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </label>
                          <label>实际核对说明
                            <textarea maxLength={2000} rows={3} value={content.video_accessibility_note ?? ""}
                              onChange={(event) => edit({ ...content, video_accessibility_note: event.target.value })} />
                          </label>
                          <p>由编辑和独立审核人员判断实际画面，系统不会自动认证。理解内容所需的视觉信息未被声音表达时必须关联口述描述版；字幕或普通文字稿不能替代适用的口述描述要求。无声视频请在下方文字稿说明关键画面。</p>
                        </section>
                      )}
                      {content.media_type === "video" && (
                        <label>
                          视频字幕／文字实录
                          <textarea
                            maxLength={20000}
                            rows={5}
                            value={content.transcript ?? ""}
                            onChange={(e) =>
                              edit({ ...content, transcript: e.target.value })
                            }
                          />
                          <small>
                            供不能听声音、网络较慢或阅读优先的访客使用；请校对实际视频，不自动生成事实。
                          </small>
                        </label>
                      )}
                      {content.media_type === "video" && (
                        <section className="ad-caption-editor">
                          <h4>与视频对应的正式字幕</h4>
                          <p>
                            使用本网站受控 WebVTT
                            文件，上传后仍要保存草稿和独立审核。替换视频文件、网址或归属地点会解除旧字幕关联。
                          </p>
                          <label>
                            字幕语言
                            <input
                              maxLength={35}
                              value={
                                (content as typeof content & CaptionFields)
                                  .caption_language ?? "zh-CN"
                              }
                              onChange={(e) =>
                                edit({
                                  ...content,
                                  caption_language: e.target.value,
                                } as ExperienceContent)
                              }
                              placeholder="例如 zh-CN"
                            />
                          </label>
                          <label>
                            播放器中的字幕名称
                            <input
                              maxLength={64}
                              value={
                                (content as typeof content & CaptionFields)
                                  .caption_label ?? "中文字幕"
                              }
                              onChange={(e) =>
                                edit({
                                  ...content,
                                  caption_label: e.target.value,
                                } as ExperienceContent)
                              }
                            />
                          </label>
                          <label>
                            上传并采用 WebVTT 字幕
                            <input
                              type="file"
                              accept=".vtt,text/vtt"
                              disabled={!content.point_id}
                              onChange={(e) => {
                                const file = e.currentTarget.files?.[0];
                                e.currentTarget.value = "";
                                if (file) void uploadCaption(file);
                              }}
                            />
                          </label>
                          <small>
                            最多1MiB、10000段、12小时；解析、来源、地点和版本会由服务端核验。支持字幕不代表字幕与画面已由人工校对。
                          </small>
                          {(content as typeof content & CaptionFields)
                            .caption_upload_id && (
                            <p role="status">
                              已关联受控字幕文件。
                              <button
                                type="button"
                                onClick={() =>
                                  edit({
                                    ...content,
                                    caption_upload_id: null,
                                  } as ExperienceContent)
                                }
                              >
                                解除字幕关联
                              </button>
                            </p>
                          )}
                        </section>
                      )}
                      <label>
                        媒体类型
                        <select
                          value={content.media_type}
                          onChange={(e) => {
                            edit({
                              ...content,
                              media_type: e.target.value as "image" | "video",
                              upload_id: null,
                              url: null,
                              caption_upload_id: null,
                              ...resetVideoDecision,
                            } as ExperienceContent);
                            setPreview(null);
                          }}
                        >
                          <option value="video">视频</option>
                          <option value="image">图片</option>
                        </select>
                      </label>
                      <label>
                        公开 HTTPS 链接
                        <input
                          type="url"
                          value={content.url ?? ""}
                          placeholder="https://…"
                          onChange={(e) => {
                            edit({
                              ...content,
                              url: e.target.value || null,
                              upload_id: null,
                              caption_upload_id: null,
                              ...resetVideoDecision,
                            } as ExperienceContent);
                            setPreview(null);
                          }}
                        />
                      </label>
                      <span className="ad-muted">
                        或上传本地
                        {content.media_type === "video"
                          ? "视频（MP4/WebM）"
                          : "图片（JPG/PNG）"}
                        ，最大 100
                        MiB。外部视频页面以链接打开；直链和上传视频可在站内播放。
                      </span>
                      <label>
                        上传文件
                        <input
                          type="file"
                          disabled={!content.point_id}
                          accept={
                            content.media_type === "video"
                              ? "video/mp4,video/webm"
                              : "image/jpeg,image/png"
                          }
                          onChange={(e) => {
                            const file = e.currentTarget.files?.[0];
                            if (file) void upload(file);
                            e.currentTarget.value = "";
                          }}
                        />
                      </label>
                      {content.upload_id && (
                        <p role="status">
                          已关联上传文件，保存草稿后仍需审核。
                        </p>
                      )}
                    </>
                  )}
                  {content.kind === "checkin" && (
                    <>
                      <label>
                        打卡样图
                        <select
                          value={content.image_id ?? ""}
                          onChange={(e) =>
                            edit({
                              ...content,
                              image_id: e.target.value || null,
                            })
                          }
                        >
                          {mediaOptions(
                            "image",
                            content.image_id,
                            content.point_id,
                          )}
                        </select>
                      </label>
                      <p className="ad-muted">
                        样图先在“图片与视频”发布。访客的打卡记录由本人确认，仅存于其浏览器，不作为定位证明。
                      </p>
                    </>
                  )}
                  {content.kind === "tour" && (
                    <div
                      className="ad-tour-builder"
                      hidden={!fullEditor && step !== 1 && step !== 2}
                    >
                      <header className="ad-tour-builder-heading">
                        <div>
                          <h3>校园站点编排</h3>
                          <p>
                            {
                              content.stops.filter((stop) => stop.point_id)
                                .length
                            }{" "}
                            个已选站点 ·{" "}
                            {
                              content.stops.filter((stop) => stop.video_id)
                                .length
                            }{" "}
                            段关联视频 ·{" "}
                            {
                              content.stops.filter((stop) => stop.checkin_id)
                                .length
                            }{" "}
                            个关联打卡
                          </p>
                        </div>
                        <span>最多 50 站</span>
                      </header>
                      <p className="ad-muted">
                        路线连接校区内多个地点。步行路径由已审核路网计算；此处安排参观顺序和各站内容。
                      </p>
                      <div className="ad-tour-canvas">
                        <section
                          className="ad-tour-picker"
                          aria-label="添加校园站点"
                        >
                          <label>
                            添加来源
                            <select
                              value={stationSource}
                              onChange={(e) =>
                                setStationSource(
                                  e.target.value as typeof stationSource,
                                )
                              }
                            >
                              <option value="points">校园地点</option>
                              <option value="videos">已发布视频</option>
                              <option value="checkins">已发布打卡</option>
                            </select>
                          </label>
                          <label>
                            搜索校园地点
                            <input
                              value={stationQuery}
                              onChange={(e) => setStationQuery(e.target.value)}
                              placeholder="地点、视频或打卡名称"
                              disabled={!content.campus_id}
                            />
                          </label>
                          {!content.campus_id ? (
                            <p>先选择路线所属校区。</p>
                          ) : (
                            <div className="ad-tour-candidates">
                              {stationSource === "points" &&
                                stationMatches.map((point) => (
                                  <button
                                    type="button"
                                    key={point.point.id}
                                    disabled={
                                      content.stops.filter(
                                        (stop) => stop.point_id,
                                      ).length >= 50
                                    }
                                    onClick={() => addStation(point.point.id)}
                                  >
                                    <span>{point.point.name}</span>
                                    <small>
                                      {content.stops.some(
                                        (stop) =>
                                          stop.point_id === point.point.id,
                                      )
                                        ? "再次加入"
                                        : "＋ 加入路线"}
                                    </small>
                                  </button>
                                ))}
                              {stationSource !== "points" &&
                                stationResources.map((row) => {
                                  const published = row.published_content!;
                                  if (published.kind === "tour") return null;
                                  return (
                                    <button
                                      type="button"
                                      key={row.id}
                                      disabled={
                                        content.stops.filter(
                                          (stop) => stop.point_id,
                                        ).length >= 50
                                      }
                                      onClick={() =>
                                        addStation(published.point_id, row)
                                      }
                                    >
                                      <span>{published.title}</span>
                                      <small>
                                        {pointName(published.point_id)} · ＋
                                        加入路线
                                      </small>
                                    </button>
                                  );
                                })}
                              {stationSource === "points" &&
                                !stationMatches.length && (
                                  <p>没有匹配的可管理地点。</p>
                                )}
                              {stationSource !== "points" &&
                                !stationResources.length && (
                                  <p>
                                    没有匹配的已发布
                                    {stationSource === "videos"
                                      ? "视频"
                                      : "打卡"}
                                    。请先在“地点影像与打卡”保存、提交并由另一位成员审核发布；上传文件本身仍是待审资料。
                                  </p>
                                )}
                            </div>
                          )}
                        </section>
                        <section
                          className="ad-tour-itinerary"
                          aria-label="校园路线顺序"
                        >
                          <ol>
                            {content.stops.map((stop, index) => (
                              <li key={index}>
                                <button
                                  type="button"
                                  aria-current={
                                    activeStop === index ? "step" : undefined
                                  }
                                  onClick={() => setActiveStop(index)}
                                >
                                  <span>{index + 1}</span>
                                  <div>
                                    <strong>
                                      {stop.point_id
                                        ? pointName(stop.point_id)
                                        : "待添加站点"}
                                    </strong>
                                    <small>
                                      {stop.video_id ? "含视频" : "未关联视频"}{" "}
                                      ·{" "}
                                      {stop.checkin_id
                                        ? "含打卡"
                                        : "未关联打卡"}{" "}
                                      ·{" "}
                                      {stop.narrative.trim()
                                        ? "已填写讲解"
                                        : "待填写讲解"}
                                    </small>
                                  </div>
                                </button>
                              </li>
                            ))}
                          </ol>
                        </section>
                      </div>
                      {content.stops.map((stop, index) =>
                        index !== activeStop ? null : (
                          <fieldset className="ad-tour-stop" key={index}>
                            <legend>
                              第 {index + 1} 站 ·{" "}
                              {stop.point_id
                                ? pointName(stop.point_id)
                                : "待添加"}
                            </legend>
                            <div className="ad-tour-order">
                              <button
                                type="button"
                                aria-label={`第 ${index + 1} 站上移`}
                                disabled={index === 0}
                                onClick={() => {
                                  edit({
                                    ...content,
                                    stops: moveStop(content.stops, index, -1),
                                  });
                                  setActiveStop(index - 1);
                                }}
                              >
                                ↑ 上移
                              </button>
                              <button
                                type="button"
                                aria-label={`第 ${index + 1} 站下移`}
                                disabled={index === content.stops.length - 1}
                                onClick={() => {
                                  edit({
                                    ...content,
                                    stops: moveStop(content.stops, index, 1),
                                  });
                                  setActiveStop(index + 1);
                                }}
                              >
                                ↓ 下移
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = content.stops.filter(
                                    (_, i) => i !== index,
                                  );
                                  edit({
                                    ...content,
                                    stops: next,
                                  });
                                  setActiveStop(Math.max(0, index - 1));
                                }}
                              >
                                移除此站
                              </button>
                              <button
                                type="button"
                                disabled={content.stops.length >= 50}
                                onClick={() => {
                                  const copy = {
                                    ...structuredClone(stop),
                                    segments: stop.segments?.map((segment) => ({
                                      ...segment,
                                      id: crypto.randomUUID(),
                                      narration_asset_id: null,
                                    })),
                                  };
                                  const next = [...content.stops];
                                  next.splice(index + 1, 0, copy);
                                  edit({ ...content, stops: next });
                                  setActiveStop(index + 1);
                                }}
                              >
                                复制本站为新段落
                              </button>
                            </div>
                            <label>
                              本站地点
                              <select
                                value={stop.point_id}
                                disabled={!content.campus_id}
                                onChange={(e) =>
                                  changeStop(index, {
                                    point_id: e.target.value,
                                    video_id: null,
                                    checkin_id: null,
                                    segments:
                                      stop.segments?.map((segment) => ({
                                        ...segment,
                                        main_view: { type: "map" as const },
                                        resources: [],
                                        narration_asset_id: null,
                                      })) ?? null,
                                  })
                                }
                              >
                                {pointOptions(stop.point_id, routePoints)}
                              </select>
                            </label>
                            <label hidden={!!stop.segments}>
                              本站讲解
                              <textarea
                                rows={5}
                                value={stop.narrative}
                                maxLength={8000}
                                onChange={(e) =>
                                  changeStop(index, {
                                    narrative: e.target.value,
                                  })
                                }
                                placeholder="访客在本站看到的讲解；请依据已核实资料填写"
                              />
                            </label>
                            <div
                              className="ad-tour-media-settings"
                              hidden={!!stop.segments}
                            >
                              <label>
                                本站打卡
                                <select
                                  value={stop.checkin_id ?? ""}
                                  onChange={(e) =>
                                    changeStop(index, {
                                      checkin_id: e.target.value || null,
                                    })
                                  }
                                >
                                  {checkinOptions(
                                    stop.checkin_id,
                                    stop.point_id,
                                  )}
                                </select>
                                <small>
                                  关联本站已发布打卡，访客可在导览中查看参考图并自行确认。
                                </small>
                              </label>
                              <label>
                                本站视频
                                <select
                                  value={stop.video_id ?? ""}
                                  onChange={(e) =>
                                    changeStop(index, {
                                      video_id: e.target.value || null,
                                    })
                                  }
                                >
                                  {mediaOptions(
                                    "video",
                                    stop.video_id,
                                    stop.point_id,
                                  )}
                                </select>
                                <small>
                                  这里只显示本站已发布视频，可先在地点影像中上传并审核。
                                </small>
                              </label>
                              <label
                                hidden={
                                  !!stop.segments?.length &&
                                  !stop.legacy_media_compat
                                }
                              >
                                何时询问观看
                                <select
                                  value={stop.prompt_timing}
                                  onChange={(e) =>
                                    changeStop(index, {
                                      prompt_timing: e.target
                                        .value as ExperienceStop["prompt_timing"],
                                    })
                                  }
                                >
                                  <option value="on_arrival">打开本站时</option>
                                  <option value="after_intro">
                                    访客确认读完介绍后
                                  </option>
                                  <option value="manual">
                                    访客主动选择视频时
                                  </option>
                                </select>
                              </label>
                            </div>
                          </fieldset>
                        ),
                      )}
                      <ExperienceEditor
                        focusSegmentId={focusedSegment}
                        content={content}
                        activeStop={activeStop}
                        mediaRows={mediaRows}
                        checkinRows={checkinRows}
                        onChange={edit}
                        mode={
                          !fullEditor
                            ? step === 1
                              ? "cover"
                              : "segments"
                            : "all"
                        }
                      />
                    </div>
                  )}
                  <label>
                    来源与公开依据
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={content.source_note}
                      onChange={(e) =>
                        edit({ ...content, source_note: e.target.value })
                      }
                      placeholder="注明资料来源、使用授权以及需要审核的事实"
                    />
                  </label>
                </fieldset>
              )}
              {content.kind === "tour" && (
                <div hidden={!review && !fullEditor && step !== 4}>
                  <ExperienceTourPreview
                    content={content}
                    mediaRows={mediaRows}
                    checkinRows={checkinRows}
                    pointNames={Object.fromEntries(
                      points.map((entry) => [entry.point.id, entry.point.name]),
                    )}
                    savedId={selected?.id}
                    draftRevision={selected?.revision}
                    dirty={dirty}
                    onNarrate={(value) => {
                      setNarration(value);
                      onTourNarrate?.(value);
                    }}
                    onNarrationStop={() => {
                      setNarration(null);
                      onNarrationStop?.();
                    }}
                  />
                </div>
              )}
              {content.kind === "tour" && !review && (
                <div hidden={!fullEditor && step !== 3}>
                  <NarrationStudio
                    focusSegmentId={focusedSegment}
                    key={`${session.user.id}:${selected?.id ?? "new"}`}
                    content={content}
                    tourId={selected?.id}
                    revision={selected?.revision}
                    dirty={dirty}
                    editable={editable && !busy}
                    onSave={() => save()}
                    onChange={edit}
                    onPendingChange={setNarrationPending}
                  />
                </div>
              )}
              {selected && (
                <div
                  hidden={
                    content.kind === "tour" &&
                    !review &&
                    !fullEditor &&
                    step !== 4 &&
                    step !== 5
                  }
                >
                  <ExperienceHistory
                    key={selected.id}
                    getRecord={() => selectedRef.current}
                    onPreviewOpen={() => {
                      setNarration(null);
                      nativeVideo.current?.pause();
                      const lease = acquireAudio("tour", () => {});
                      releaseAudio("tour", lease);
                    }}
                    onSave={() => save()}
                    onLoad={(item) => {
                      load(item);
                      setRevision((n) => n + 1);
                      onUpdate?.();
                    }}
                    editable={editable}
                    dirty={dirty}
                    onPendingChange={setHistoryPending}
                    onReport={setPreflight}
                    onJump={(path) => {
                      const match = /stops(?:\[|\.)(\d+)/.exec(path);
                      if (match) {
                        setActiveStop(Number(match[1]));
                        setStep(2);
                        setFullEditor(false);
                      } else setStep(0);
                    }}
                  />
                </div>
              )}
              <TourNarrator
                narration={narration}
                staffCsrf={session.csrf_token}
                onStop={() => setNarration(null)}
              />
              {content.kind === "media" && content.media_type === "video" && content.video_visual_information === "description_required" && (
                <VideoDescriptionPicker key={`${content.point_id}:${selected?.revision}:${selected?.published_revision}`}
                  pointId={content.point_id} sourceId={selected?.id} value={content.audio_description_video_id}
                  revision={content.audio_description_video_revision} disabled={!editable || busy}
                  onChange={(id, revision) => edit({ ...content, audio_description_video_id: id, audio_description_video_revision: revision })} />
              )}
              {previewUrl && content.kind === "media" && (
                <section
                  className="ad-experience-preview"
                  aria-label="媒体预览"
                >
                  <h3>预览</h3>
                  {content.media_type === "image" ? (
                    <img
                      src={previewUrl}
                      alt={
                        content.alternative_text ||
                        content.title ||
                        "待审核图片"
                      }
                      referrerPolicy="no-referrer"
                      loading="lazy"
                    />
                  ) : inlineVideo(previewUrl, !!content.upload_id) ? (
                    <video
                      ref={nativeVideo}
                      key={`${previewUrl}:${content.caption_upload_id ?? ""}`}
                      src={previewUrl}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={content.title || "待审核视频"}
                      onPlay={(event) => {
                        const element = event.currentTarget;
                        if (nativeVideo.current !== element) return;
                        videoLease.current = {
                          element,
                          source: videoSource,
                          lease: acquireAudio("video", () => element.pause()),
                        };
                      }}
                      onPause={(event) => {
                        const playing = videoLease.current;
                        if (playing?.element === event.currentTarget) {
                          releaseAudio("video", playing.lease);
                          videoLease.current = null;
                        }
                      }}
                      onEnded={(event) => {
                        const playing = videoLease.current;
                        if (playing?.element === event.currentTarget) {
                          releaseAudio("video", playing.lease);
                          videoLease.current = null;
                        }
                      }}
                    >
                      {captionUrl && (
                        <track
                          kind="captions"
                          src={captionUrl}
                          srcLang={content.caption_language}
                          label={content.caption_label}
                          default
                        />
                      )}
                    </video>
                  ) : (
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      在新窗口预览链接
                    </a>
                  )}
                </section>
              )}
              <ErrorBox
                text={allMedia.error}
                onRetry={() => setRevision((n) => n + 1)}
              />
              <ErrorBox
                text={allCheckins.error}
                onRetry={() => setRevision((n) => n + 1)}
              />
              {editable && (
                <div className="ad-experience-savebar">
                  <span>
                    {dirty
                      ? "有未保存修改"
                      : selected?.state === "published"
                        ? "当前为公开版本"
                        : selected?.state === "discarded"
                          ? "草稿已撤回"
                          : "草稿已保存"}
                  </span>
                  <button disabled={busy || !dirty} onClick={() => void save()}>
                    {busy ? "正在处理…" : "保存草稿"}
                  </button>
                  <button
                    className="ad-primary"
                    disabled={
                      busy ||
                      (!dirty &&
                        !["draft", "rejected"].includes(selected?.state ?? ""))
                    }
                    onClick={() => void save(true)}
                  >
                    保存并提交审核
                  </button>
                  <small>提交后由另一位成员审核，不会自动公开。</small>
                  {content.kind === "tour" && !fullEditor && (
                    <>
                      <button
                        disabled={step === 0}
                        onClick={() => setStep((v) => Math.max(0, v - 1))}
                      >
                        上一步
                      </button>
                      <button
                        disabled={step === 5}
                        onClick={() => setStep((v) => Math.min(5, v + 1))}
                      >
                        下一步
                      </button>
                    </>
                  )}
                </div>
              )}
              {selected?.published_content && (
                <details className="ad-experience-published">
                  <summary>对照当前公开版本</summary>
                  <PublishedContent
                    content={selected.published_content}
                    pointName={pointName}
                    campusName={campusName}
                    mediaTitle={publicMediaTitle}
                  />
                </details>
              )}
              {selected && (
                <section
                  className="ad-experience-review"
                  hidden={
                    content.kind === "tour" &&
                    !review &&
                    !fullEditor &&
                    step !== 5
                  }
                >
                  <h3>{review ? "审核与发布" : "提交与审核进度"}</h3>
                  {selected.review_note && (
                    <p className="experience-prose">
                      上次说明：{selected.review_note}
                    </p>
                  )}
                  <label>
                    本次操作说明
                    <textarea
                      rows={2}
                      value={note}
                      disabled={busy}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  {dirty && <p>请先保存修改，再进行审核操作。</p>}
                  {canReview && selected.operation !== "retire" && content.kind === "media" && content.media_type === "video" && (
                    <label><input type="checkbox" checked={videoReviewConfirmed} disabled={busy || dirty || selfReview}
                      onChange={(event) => setVideoReviewConfirmed(event.target.checked)} />
                      我已核对本稿视频实际画面及声音，确认本版本的画面判断和口述描述版关联／无声等价说明正确。此确认不代表设备播放或完整无障碍认证。
                    </label>
                  )}
                  {selected.state === "in_review" && selfReview && (
                    <p>你参与了本次修改，请由另一位审核人员审核。</p>
                  )}
                  <div className="ad-experience-actions">
                    {editable &&
                      ["draft", "rejected"].includes(selected.state) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("submit")}
                        >
                          提交审核
                        </button>
                      )}
                    {!review &&
                      session.permissions.includes("points.edit") &&
                      (selfReview || session.user.role === "admin") &&
                      ["draft", "rejected", "in_review"].includes(
                        selected.state,
                      ) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("discard")}
                        >
                          撤回草稿
                        </button>
                      )}
                    {canReview && selected.state === "in_review" && (
                      <>
                        <button
                          disabled={busy || dirty || selfReview || (selected.operation !== "retire" && content.kind === "media" && content.media_type === "video" && !videoReviewConfirmed)}
                          className="ad-primary"
                          onClick={() => void operate("publish")}
                        >
                          {selected.operation === "retire"
                            ? "审核通过并下架"
                            : "审核通过并发布"}
                        </button>
                        <button
                          disabled={busy || dirty || selfReview}
                          onClick={() => void operate("reject")}
                        >
                          退回修改
                        </button>
                      </>
                    )}
                    {!review && onReview && selected.state === "in_review" && (
                      <button
                        disabled={busy || dirty}
                        onClick={() => onReview(selected.id)}
                      >
                        去审核中心
                      </button>
                    )}
                    {editable &&
                      selected.status === "published" &&
                      ["published", "discarded"].includes(selected.state) && (
                        <button
                          disabled={busy || dirty}
                          onClick={() => void operate("retire")}
                        >
                          申请下架
                        </button>
                      )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function PublishedContent({
  content,
  pointName,
  campusName,
  mediaTitle,
}: {
  content: ExperienceContent;
  pointName: (id: string) => string;
  campusName: (id: string) => string;
  mediaTitle: (id: string) => string;
}) {
  return (
    <div>
      <h3>{content.title}</h3>
      <p>
        {content.kind === "tour"
          ? `校区：${campusName(content.campus_id)} · ${content.stops.length} 站校园导览`
          : `地点：${pointName(content.point_id)}`}
      </p>
      <p className="experience-prose">{content.description}</p>
      {content.kind === "media" && (
        <><p>
          {content.media_type === "image" ? "图片" : "视频"}：
          {content.url || "已上传文件"}
        </p>
        {content.media_type === "video" && <div><p>画面信息判断：{videoDecisionNames[content.video_visual_information ?? "unassessed"]}</p>
          <p className="experience-prose">{content.video_accessibility_note}</p>
          {content.audio_description_video_id && <p>口述描述版：{mediaTitle(content.audio_description_video_id)} · 正式版本 {content.audio_description_video_revision}</p>}
        </div>}</>
      )}
      {content.kind === "checkin" && (
        <p>参考图：{content.image_id ? mediaTitle(content.image_id) : "无"}</p>
      )}
      {content.kind === "tour" && (
        <>
          <p>
            路线封面：
            {content.cover_image_id
              ? mediaTitle(content.cover_image_id)
              : "简洁封面"}
          </p>
          <ol>
            {content.stops.map((stop, index) => (
              <li key={index}>
                <strong>{stop.title || pointName(stop.point_id)}</strong>
                {stop.segments ? (
                  <ol>
                    {stop.segments.map(normalizeSegment).map((segment) => (
                      <li key={segment.id}>
                        <p className="experience-prose">{segment.text}</p>
                        <p>
                          主画面：
                          {segment.main_view.type === "map"
                            ? "本站地图"
                            : `${segment.main_view.type === "image" ? mediaTitle(segment.main_view.id) : "楼层"} · 版本 ${segment.main_view.revision}`}
                        </p>
                        {segment.resources.map((resource) => (
                          <p key={`${resource.type}:${resource.id}`}>
                            {resource.type} · {mediaTitle(resource.id)} · 版本{" "}
                            {resource.revision}
                          </p>
                        ))}
                        <p className="experience-prose">
                          本段来源：{segment.source_note || content.source_note}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="experience-prose">{stop.narrative}</p>
                )}
                {!stop.segments && (
                  <p>
                    打卡：{stop.checkin_id ? mediaTitle(stop.checkin_id) : "无"}
                    ； 视频：{stop.video_id ? mediaTitle(stop.video_id) : "无"}
                    ；展示：
                    {
                      {
                        on_arrival: "打开本站时",
                        after_intro: "读完介绍后",
                        manual: "主动选择时",
                      }[stop.prompt_timing]
                    }
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="experience-prose">来源：{content.source_note}</p>
    </div>
  );
}
