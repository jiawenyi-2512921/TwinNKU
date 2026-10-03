import { useEffect, useRef, useState } from "react";
import type { components } from "../../shared/api/schema";
import { get, type Campus } from "../../shared/api/client";
import { message, request, type StaffSession } from "./api";
import { ErrorBox, Pager, useResource } from "./ui";
import type { ImportBinding, ImportKind, ImportView } from "./ImportWorkspace";

type Reference = components["schemas"]["ImportReference"];
type ExportManifest = components["schemas"]["ImportExportManifest"];
type ReferenceKind = Reference["kind"];
const names: Record<ReferenceKind, string> = {
  point: "真实地点",
  map: "校园底图",
  floor: "楼层图",
  vr: "VR 全景入口",
  image: "图片资料",
  video: "视频资料",
  checkin: "打卡提示",
  tour: "校园路线",
};
const choices: Record<ImportBinding["field"], ReferenceKind[]> = {
  point_id: ["point"],
  map_id: ["map"],
  main_id: ["map", "image", "floor", "video", "vr"],
  image_id: ["image"],
  video_id: ["video"],
  floor_id: ["floor"],
  vr_id: ["vr"],
  checkin_id: ["checkin"],
  cover_image_id: ["image"],
  audio_description_video_id: ["video"],
};
export function importImageThumbnail(item: Reference): string | null {
  const path = `/api/v1/experiences/${encodeURIComponent(item.id)}/media`;
  return item.kind === "image" &&
    item.referenceable &&
    item.thumbnail_url === path
    ? path
    : null;
}
export function importVideoPreview(item: Reference): string | null {
  const path = `/api/v1/experiences/${encodeURIComponent(item.id)}/media/${item.revision}`;
  return item.kind === "video" && item.referenceable && item.revision > 0 && Number.isInteger(item.revision)
    && item.preview_url === path ? path : null;
}
function scopedCampuses(session: StaffSession, campuses: Campus[]) {
  return campuses.filter(
    (campus) =>
      session.user.role === "admin" ||
      session.user.campus_ids.includes(campus.id),
  );
}
export function ImportReferencePicker({
  view,
  rows,
  session,
  disabled,
  onApply,
  onClose,
}: {
  view: ImportView;
  rows: number[];
  session: StaffSession;
  disabled: boolean;
  onApply: (bindings: ImportBinding[]) => Promise<void>;
  onClose: () => void;
}) {
  const fields = (Object.keys(choices) as ImportBinding["field"][]).filter(
    (field) =>
      field in view.fields &&
      (field !== "cover_image_id" || view.kind === "vr") &&
      (field !== "audio_description_video_id" || view.kind === "media"),
  );
  const [field, setField] = useState<ImportBinding["field"]>(
    fields[0] ?? "point_id",
  );
  const [kind, setKind] = useState<ReferenceKind>(choices[field][0]);
  const [campus, setCampus] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const [picked, setPicked] = useState<{
      item: Reference;
      source: string;
    } | null>(null),
    [selectedRows, setSelectedRows] = useState<number[]>(rows);
  const [previewed, setPreviewed] = useState<{ id: string; revision: number; source: string } | null>(null);
  const campuses = useResource<Campus[]>("", 0, (signal) =>
    get<Campus[]>("/campuses", signal),
  );
  const allowed = scopedCampuses(session, campuses.data?.data ?? []);
  const rowIdentity = rows.join(",");
  useEffect(() => {
    setSelectedRows(rows);
    setSelected(null);
    setPage(1);
  }, [rowIdentity]);
  const pointBindings = (view.reference_bindings ?? []).filter(
    (binding) =>
      binding.field === "point_id" &&
      binding.id &&
      selectedRows.some((row) => binding.rows.includes(row)),
  );
  const pointIds = [...new Set(pointBindings.map((binding) => binding.id!))];
  const coverReady =
    !["cover_image_id", "audio_description_video_id"].includes(field) ||
    (selectedRows.length > 0 &&
      pointIds.length === 1 &&
      selectedRows.every((row) =>
        pointBindings.some((binding) => binding.rows.includes(row)),
      ));
  const params = new URLSearchParams({
    kind,
    page: String(page),
    page_size: "25",
    referenceable: "true",
    ...(field === "audio_description_video_id" ? { purpose: "audio_description" } : {}),
    ...(campus ? { campus_id: campus } : {}),
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(pointIds.length === 1 && !["point", "map", "tour"].includes(kind)
      ? { point_id: pointIds[0] }
      : {}),
  });
  const catalog = useResource<Reference[]>(
    disabled || !coverReady ? null : `/import-references?${params}`,
  );
  const sourceKey = JSON.stringify([
    field,
    kind,
    campus,
    query,
    page,
    selectedRows,
    pointIds,
    view.preview_sha256,
    session.user.id,
    session.user.role,
    session.user.campus_ids,
    session.user.point_ids,
    session.permissions,
  ]);
  const candidates = (catalog.data?.data ?? []).filter(
    (item) =>
      item.kind === kind &&
      (!campus || item.campus_id === campus) &&
      (session.user.role === "admin" ||
        session.user.campus_ids.includes(item.campus_id) ||
        (!!item.point_id && session.user.point_ids?.includes(item.point_id))) &&
      (kind === "point" || item.referenceable) &&
      (!["cover_image_id", "audio_description_video_id"].includes(field) ||
        (coverReady && item.point_id === pointIds[0])) &&
      (field !== "audio_description_video_id" || item.audio_description_eligible),
  );
  const selected =
    picked?.source === sourceKey &&
    candidates.some(
      (item) =>
        item.id === picked.item.id &&
        item.kind === picked.item.kind &&
        item.revision === picked.item.revision,
    )
      ? picked.item
      : null;
  const previewItem = previewed?.source === sourceKey
    ? candidates.find((item) => item.id === previewed.id && item.revision === previewed.revision) : undefined;
  function setSelected(item: Reference | null) {
    setPicked(item ? { item, source: sourceKey } : null);
  }
  useEffect(() => {
    setSelected(null);
  }, [sourceKey]);
  function selectField(value: ImportBinding["field"]) {
    setField(value);
    setKind(choices[value][0]);
    setPage(1);
    setSelected(null);
  }
  const existing = (view.reference_bindings ?? []).filter(
    (binding) =>
      binding.field === field &&
      selectedRows.some((row) => binding.rows.includes(row)),
  );
  return (
    <section className="ad-import-reference ad-card" aria-label="导入关联选择">
      <h3>给原表行 {rows.join("、")} 选择真实关联</h3>
      <p>
        按名称搜索并明确选择，版本由服务器带入。选择只更新这批私有检查输入；地点与资料范围、当前版本仍由服务端重新核验。
      </p>
      <ErrorBox text={campuses.error || catalog.error} />
      <fieldset disabled={disabled}>
        <legend>应用范围与关联类型</legend>
        <div className="ad-import-row-choices">
          {rows.map((row) => (
            <label key={row}>
              <input
                type="checkbox"
                checked={selectedRows.includes(row)}
                onChange={(event) =>
                  setSelectedRows((old) =>
                    event.target.checked
                      ? [...old, row]
                      : old.filter((value) => value !== row),
                  )
                }
              />
              原表第 {row} 行
            </label>
          ))}
        </div>
        <label>
          要填写的关联
          <select
            value={field}
            onChange={(event) =>
              selectField(event.target.value as ImportBinding["field"])
            }
          >
            {fields.map((value) => (
              <option key={value} value={value}>
                {view.fields[value]}
              </option>
            ))}
          </select>
        </label>
        {["cover_image_id", "audio_description_video_id"].includes(field) && (
          <div role="status">
            <p>
              {field === "cover_image_id" ? "VR封面只采用所属真实地点的已发布图片" : "口述描述版只采用同地点已发布且独立审核为声音完整表达关键画面的视频"}；采用时同时绑定正式版本。不同地点请分开选择。
            </p>
            {!coverReady && (
              <>
                <p>
                  {pointIds.length > 1
                    ? "当前勾选的行属于不同地点，请先只勾选同一地点的行。"
                    : "请先为每个勾选行按名称确认所属真实地点，再选择该地点的资料。原表中的地点标识会保留，确认不会改动生产地点。"}
                </p>
                <button type="button" onClick={() => selectField("point_id")}>
                  先按名称确认所属地点
                </button>
              </>
            )}
          </div>
        )}
        {choices[field].length > 1 && (
          <label>
            画面资料类型
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ReferenceKind);
                setPage(1);
                setSelected(null);
              }}
            >
              {choices[field].map((value) => (
                <option key={value} value={value}>
                  {names[value]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          校区范围
          <select
            value={campus}
            onChange={(event) => {
              setCampus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">我的全部授权校区</option>
            {allowed.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          按名称搜索
          <input
            value={query}
            maxLength={120}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="地点或资料名称"
          />
        </label>
        {catalog.loading && <p role="status">正在读取真实关联目录…</p>}
        {coverReady && catalog.data && !candidates.length && (
          <p>
            当前范围没有可选资料。请先在相应工作台创建并审核资料，再回到本批选择；不会编造关联。
          </p>
        )}
        <div className="ad-reference-candidates">
          {candidates.map((item) => (
            <label key={`${item.kind}:${item.id}`}>
              <input
                type="radio"
                name="import-reference"
                checked={
                  selected?.id === item.id && selected.kind === item.kind
                }
                onChange={() => setSelected(item)}
              />
              {importImageThumbnail(item) && (
                <img
                  className="ad-import-thumbnail"
                  src={importImageThumbnail(item)!}
                  alt=""
                  width={72}
                  height={54}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}
              {item.kind === "video" && <span className="ad-import-thumbnail" aria-hidden="true">视频</span>}
              <span>
                <strong>{item.title || "未命名资料"}</strong>
                <small>
                  {item.point_name ||
                    allowed.find((campus) => campus.id === item.campus_id)
                      ?.name ||
                    item.campus_id}{" "}
                  · {names[item.kind]} ·{" "}
                  {item.referenceable
                    ? `已发布 v${item.revision}`
                    : `地点私有草稿 v${item.draft_revision}，是否可用按检查结果确认`}
                </small>
              </span>
              {importVideoPreview(item) && <button type="button" onClick={(event) => {
                event.preventDefault(); event.stopPropagation();
                if (!disabled) setPreviewed({ id: item.id, revision: item.revision, source: sourceKey });
              }}>查看此正式视频</button>}
            </label>
          ))}
        </div>
        {previewItem && importVideoPreview(previewItem) && <section aria-label="所选正式视频预览">
          <h4>{previewItem.title} · 正式版本 {previewItem.revision}</h4>
          <p>按需读取真实视频，默认静音且不自动播放。无已发布缩略图时只显示资料类型，不合成画面。</p>
          <video key={`${previewItem.id}:${previewItem.revision}`} src={importVideoPreview(previewItem)!}
            controls muted playsInline preload="none" aria-label={`${previewItem.title}正式视频预览`} />
          <a href={importVideoPreview(previewItem)!} target="_blank" rel="noopener noreferrer">在新标签页查看此版本</a>
          <button type="button" onClick={() => setPreviewed(null)}>关闭视频预览</button>
        </section>}
        <Pager
          page={catalog.data?.meta.pagination}
          onChange={(value) => {
            setPage(value);
            setSelected(null);
          }}
        />
        <button
          className="ad-primary"
          disabled={!selected || !selectedRows.length}
          onClick={() => {
            if (!disabled && selected && selectedRows.length && coverReady)
              void onApply([
                {
                  rows: selectedRows,
                  field,
                  kind: selected.kind,
                  id: selected.id,
                  revision: selected.revision,
                },
              ]);
          }}
        >
          采用所选真实关联并重新检查
        </button>
        {existing.length > 0 && (
          <button
            disabled={!selectedRows.length}
            onClick={() =>
              void onApply([
                { rows: selectedRows, field, kind, id: null, revision: 0 },
              ])
            }
          >
            撤销本页选择，恢复原表单元格
          </button>
        )}
      </fieldset>
      <button disabled={disabled} onClick={onClose}>
        关闭关联选择
      </button>
    </section>
  );
}

export function ImportScopeExport({
  kind,
  session,
  disabled,
  onBusy,
  onError,
  onDownload,
}: {
  kind: ImportKind;
  session: StaffSession;
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onError: (value: string) => void;
  onDownload: (path: string, filename: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [campus, setCampus] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const [ids, setIds] = useState<string[]>([]),
    [manifest, setManifest] = useState<ExportManifest | null>(null);
  const campuses = useResource<Campus[]>(
    open ? "" : null,
    0,
    open ? (signal) => get<Campus[]>("/campuses", signal) : undefined,
  );
  const allowed = scopedCampuses(session, campuses.data?.data ?? []);
  const referenceKind: ReferenceKind = kind === "media" ? "video" : kind;
  const [mediaKind, setMediaKind] = useState<"image" | "video">("video");
  const params = new URLSearchParams({
    kind: kind === "media" ? mediaKind : referenceKind,
    campus_id: campus,
    referenceable: "false",
    page: String(page),
    page_size: "25",
    ...(query.trim() ? { q: query.trim() } : {}),
  });
  const catalog = useResource<Reference[]>(
    open && campus ? `/import-references?${params}` : null,
  );
  const identity = `${kind}:${campus}:${ids.join(",")}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    setManifest(null);
  }, [identity]);
  useEffect(() => {
    setIds([]);
    setPage(1);
    setQuery("");
    setManifest(null);
  }, [kind, campus]);
  function exportPath(preview: boolean) {
    const params = new URLSearchParams({ campus_id: campus });
    ids.forEach((id) => params.append("ids", id));
    if (!preview && manifest) params.set("expected_sha256", manifest.sha256);
    return `/import-exports/${kind}${preview ? "/preview" : ""}?${params}`;
  }
  async function preview() {
    if (disabled || !campus) return;
    const target = identity;
    onBusy(true);
    onError("");
    try {
      const value = (await request<ExportManifest>(exportPath(true))).data;
      if (
        identityRef.current === target &&
        value.kind === kind &&
        value.campus_id === campus &&
        /^[a-f0-9]{64}$/.test(value.sha256)
      )
        setManifest(value);
      else throw new Error("导出范围已经变化，请重新检查。");
    } catch (error) {
      onError(message(error));
    } finally {
      onBusy(false);
    }
  }
  return (
    <section className="ad-import-export">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        导出已有资料作为更新表格
      </button>
      {open && (
        <fieldset disabled={disabled}>
          <legend>导出范围</legend>
          <p>
            保留已有条目的标识、版本与关联，不按同名覆盖。高级保留列承载旧路线触发方式与多项资料，更新时请保留这些列；重新导入仍只生成私有草稿并走独立审核。
          </p>
          {kind === "vr" && (
            <p>
              VR
              表格同时保留全景观察提示、封面图片及其精确版本、目录顺序这四列。技术连通、场景位置和设备人工核查记录不从表格导入，仍须在
              VR 工作台单独完成。
            </p>
          )}
          <ErrorBox text={campuses.error || catalog.error} />
          <label>
            要导出的校区
            <select
              value={campus}
              onChange={(event) => setCampus(event.target.value)}
            >
              <option value="">请选择授权校区</option>
              {allowed.map((campus) => (
                <option key={campus.id} value={campus.id}>
                  {campus.name}
                </option>
              ))}
            </select>
          </label>
          {kind === "media" && (
            <label>
              查找资料类型
              <select
                value={mediaKind}
                onChange={(event) => {
                  setMediaKind(event.target.value as "image" | "video");
                  setPage(1);
                }}
              >
                <option value="video">视频</option>
                <option value="image">图片</option>
              </select>
            </label>
          )}
          <label>
            查找需要更新的资料
            <input
              value={query}
              maxLength={120}
              disabled={!campus}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <p>
            {ids.length
              ? `已明确选择 ${ids.length} 项（最多100项）；只导出所选项。`
              : "未勾选时导出该校区全部授权资料；超出500行／10MB时会明确拒绝，不会静默截断。"}
          </p>
          <div className="ad-reference-candidates">
            {catalog.data?.data.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(item.id)}
                  disabled={!ids.includes(item.id) && ids.length >= 100}
                  onChange={(event) =>
                    setIds((old) =>
                      event.target.checked
                        ? [...old, item.id]
                        : old.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  <strong>{item.title || "未命名资料"}</strong>
                  <small>
                    {item.point_name} ·{" "}
                    {item.referenceable
                      ? `已发布 v${item.revision}`
                      : `私有草稿 v${item.draft_revision}`}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <Pager page={catalog.data?.meta.pagination} onChange={setPage} />
          {ids.length > 0 && (
            <button onClick={() => setIds([])}>清除选择，改为全校区范围</button>
          )}
          <button disabled={!campus} onClick={() => void preview()}>
            检查导出范围与提醒
          </button>
          {manifest && (
            <div role="status">
              <p>
                将导出 {manifest.record_count} 项资料、{manifest.row_count} 行。
              </p>
              {manifest.warnings.length > 0 && (
                <ul>
                  {manifest.warnings.map((warning, index) => (
                    <li key={index}>{warning.message}</li>
                  ))}
                </ul>
              )}
              <button
                className="ad-primary"
                disabled={!manifest.record_count}
                onClick={() =>
                  void onDownload(exportPath(false), manifest.filename)
                }
              >
                下载已核对范围的 CSV
              </button>
              <small>下载绑定这次检查的内容指纹；资料变化时需重新检查。</small>
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
