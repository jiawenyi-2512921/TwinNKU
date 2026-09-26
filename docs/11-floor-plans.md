# M05a 已标注楼层原图与分区查看

本页为2026-09-24当前规范，替代历史双图方案、19栋91层目录和第20项排除规则。当前分支 `feat/admin-console`；数据库head `0005_resource_editor`。本次交付代码与资源，由用户和DeepSeek部署。

## 1. 本次资料范围

已接收并逐张核对20栋建筑、96个实际楼层、100张标注原图。只交付标注版本；没有实拍照片或无标注图。文件以原尺寸、原格式、原字节保存，网页缩放仅改变显示比例。

权威接入清单：`data/floors/jinnan-v1/intake.json`。原图清单：同目录 `labeled-manifest-20260924.json`；仅标注来源与摘要：`labeled-sources-20260924.json`。公共清单不填写工作区本地路径。

| 序号 | 绑定的地图名称 | 楼层 | 图片数 |
|---|---|---|---:|
| 1 | 材料科学与工程学院 | 1—5 | 5 |
| 2 | 电子信息与光学工程学院 | 1—5 | 5 |
| 3 | 公共教学楼A区 | 1—4 | 4 |
| 4 | 公共教学楼B区 | 1—5 | 5 |
| 5 | 公共教学楼C区 | 1—5 | 5 |
| 6 | 公共教学楼D区 | 1—4 | 4 |
| 7 | 计算机学院、网络空间安全学院、人工智能学院 | 1—6 | 6 |
| 8 | 理科食堂 | 1—3 | 3 |
| 9 | 前沿交叉学科中心 | 1—2 | 2 |
| 10 | 软件学院 | 1—5 | 5 |
| 11 | 体育馆 | 1—4 | 8 |
| 12 | 图书馆 | 1、2、3、4、5、7 | 6 |
| 13 | 学5-A | 1—6 | 6 |
| 14 | 学5-B | 1—6 | 6 |
| 15 | 学5-D | 1—6 | 6 |
| 16 | 学6 | 1—4 | 4 |
| 17 | 学7-A | 1—6 | 6 |
| 18 | 综合实验楼A区 | 1—4 | 4 |
| 19 | 综合实验楼B区 | 1—5 | 5 |
| 20 | 综合实验楼C区 | 1—5 | 5 |

体育馆1、2层各有A/B/C三张图；3层为一张图；4层为A区一张图。分区不是额外楼层。图书馆源目录没有6层，不补造。第3项来源名称中的“公告”不改变已确认的“公共教学楼A区”。第9项显示沿用地图名称，资料来源名另行保留。

原图核对包含建筑、层号、标注版本及完整下载；不代表逐个房间号、现场通行或实际功能已经校方核验。部分原始标注仍有重复或疑似不一致的房号，保留源文件，不擅自修图。房间结构化数据与室内导航另行建设。

## 2. 客户端交互

点击/搜索已命名建筑 → 楼层结构 → 楼层 → 分区（有多张时）。支持拖动、双指/滚轮缩放、适合窗口、1:1原尺寸、大图与分享。无图或读取失败明确提示，不拿其他楼层替代。

原图独立等待30秒，加载失败或超时后可“重新加载”。重试只替换图片图层，保留当前缩放和位置；更换楼层/分区仍按对应原图尺寸初始化。超时/失败/离开时清理监听器和定时器，移除失效图层，迟到事件不能覆盖新图。移除图层不保证浏览器立即停止底层图片传输；未改为代理、缩略图或重编码图片。弱网、旋转屏幕与真机触控仍需部署后验收。

分享参数：`?point=<UUID>&floor=<UUID>&floor_section=a`。单图默认 `main`，可省略分区。重选同建筑保留楼层；切换建筑清除旧楼层；失效/越权/跨建筑参数回到实际可用楼层与分区。请求取消与迟到响应保护防止切楼后被旧请求覆盖。

楼层视图在页面可见时每30秒刷新元数据，重新聚焦/回到页面立即检查。未变更图片保留对象引用和缩放状态；已发布替换图使用新revision。后台发布后会回读公开接口，区别“发布已提交”和“公开端已确认”。

## 3. 已实现公开接口

前缀 `/api/v1`；唯一DTO源为 `apps/api/app/contracts.py`，以自动生成OpenAPI及前端类型为准。

| 方法与路径 | 行为 |
|---|---|
| GET `/points/{point_id}/floors` | `Envelope[Floor[]]`，按ordinal排序；所属建筑未公开404；无资料/模块关闭空数组 |
| GET `/floors/{floor_id}` | 楼层、校园、建筑和楼层地图均可公开才返回 |
| GET `/floors/{floor_id}/images/{revision}/labeled?section=a` | 标注原文件；省略section视为main；旧revision/未发布/未知分区404，非法section422 |
| GET `/maps/{map_id}` | 楼层为kind=floor、tiles=null；以第一张标注图尺寸为元数据，不提供校园瓦片 |
| GET `/system/status` | floors取决于FLOORS_ENABLED及可公开资料；VR独立开关 |

Floor包含id、point_id、map_id、label、ordinal、revision、images、attribution。FloorImage包含variant=labeled、section（默认main）、section_label、width_px、height_px、media_type、size_bytes、sha256、url；不返回私有磁盘路径。

每张分区图各自保留尺寸，不共享房间像素坐标。未来若增加室内点位，必须关联floor_id、revision和section，不能只关联楼层map_id。

旧双图数据兼容，公开端始终过滤clean且拒绝其原图链接。旧单图链接不变。所有图片读取检查发布状态，使用no-store/nosniff；Nginx不直接暴露资源卷。公开显示的图可被保存或截屏，不承诺阻止复制。

## 4. 数据和离线导入

`(point_id, ordinal)`及map_id唯一；floor_id的建筑、楼层序号、map_id绑定不可变。资料修改沿用ID、revision加一。历史图书馆1层保留revision 2及完全相同清单摘要；新增楼层revision 1。

资源包根目录为manifest.json及 `<floor_id>/<revision>/labeled[-section].png|jpg`；schema_version=1。每层1—32张图，section不重复，有命名分区必须给section_label。新增包必须只含标注图；历史双图仅为兼容读取。

构建时在仓库外复制intake，逐层填写 `labeled_file`，或 `labeled_sections:[{section,section_label,labeled_file}]`，二者不能同时填写。命名分区示例为section=a、section_label=A区。不扫描照片目录，不从截图生成替代原图。

```bash
cd apps/api
uv run python ../../scripts/build_floor_bundle.py /absolute/floor-intake.local.json /absolute/floors-release
```

默认缺任何一层或任一分区图即失败；明确分批才使用 `--partial` 并报告跳过项。第20栋按正常规则纳入。

校验静态PNG/JPEG、可完整解码、每图≤32 MiB、≤4000万像素、单边≤20000像素、SHA256及实际类型。EXIF方向0/1原样保留，其他方向拒绝，交由资料提供者确认，不隐式旋转。输出直接复制原文件。

CLI完整校验后在事务中导入；与后台编辑按同一建筑锁串行化。旧revision不能覆盖新版；同revision不同内容拒绝。保存审核人、依据、摘要和时间。事务失败可能留下未引用版本目录，保留排查，不覆盖不可变文件。

```bash
docker compose --profile tools run --rm floor-import /incoming/floors-jinnan-20260924-v1 \
  --reviewer '实际核对人' --rights-note '用户整理的已标注楼层图，用于本项目展示' --publish
```

完整下载、校验及上线步骤见 [17-floor-release.md](17-floor-release.md)。本轮不运行旧地图导入、不覆盖后台发布过的点位位置、名称或范围。程序启动不自动从飞书抓图，也不自动导入ZIP。

## 5. 后台持续维护

见 [18-resource-editor.md](18-resource-editor.md)：网页直接上传/替换标注原图、新增楼层与分区、编辑来源、预览、提交、独立审核、发布、下架与恢复。图像处理不改变像素。VR链接同样经草稿与审核流程。

楼层资源卷由API用户10001可写，容器根文件系统仍只读；map_assets仍只读。上传暂存文件、正式版本、数据库审计和资源清单均需要备份。FLOORS_ENABLED=false可独立关闭公开楼层读取。
