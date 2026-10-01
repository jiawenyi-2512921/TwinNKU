# HTTP 接口规范 v1

> 最新逐端点/字段参考见[31](31-api-reference.md)：44已实现、36计划。后台点位/楼层/VR以15/18及机器契约为准；下方contributor/analyst等角色属于旧计划命名，不能作为现有四角色授权实现。智能体实现前按24清理协议缺口。

## 1. 使用方法与实现状态

基础路径 `/api/v1`，UTF-8 JSON，字段 snake_case。机器契约见 `contracts/openapi.json`；字段类型、必填、枚举、边界和响应模型均可直接用于代码生成。本文补充业务语义、权限、错误和模块依赖。

每个 operation 的 `x-implementation-status` 为 implemented/planned，`x-module` 标明交付阶段。planned 路由只存在于独立契约生成器，**不在运行服务挂载**。访问未实现路由返回真实 404，不能用占位 200 或固定回复冒充。

v0.2.0 运行 API 包含健康、系统状态、校园、公开点位读取，以及M01地图元信息、点位几何和PNG图块。完整机器契约中的其他接口用于后续模块开发。地图导入与版本规则见[地图模块说明](10-map-module.md)。

## 2. 请求/响应基础规则

- HTTPS 同源；生产 API 密钥不可出现在 URL、前端源码、localStorage 或日志。
- 请求体默认上限 1 MiB；文件上传以后按独立 endpoint 放宽，默认不开放。
- 未知 JSON 字段返回 422，避免拼写错误被忽略。所有 ID 经过格式校验。
- 200 用于读取与状态变更；201 创建资源；202 接受异步生成任务。
- 常规成功：`{"data": ..., "meta": {"request_id":"UUID"}}`。
- 分页额外有 `meta.pagination={page,page_size,total}`；page>=1，1<=page_size<=100，默认20。
- 错误：`{"error":{"code":"NOT_FOUND","message":"点位不存在或尚未公开","details":[]},"meta":{"request_id":"UUID"}}`。
- `X-Request-ID` 由服务端生成，与 body 一致；不回显请求输入值、SQL、密钥或堆栈。
- `/health/*` 为例外，成功返回 `{"status":"ok","service":"twinnku-api"}`；错误仍为统一错误体。
- v1 默认 `Cache-Control: no-store`。未来静态衍生素材可 immutable 缓存；私有文件不得进入公共缓存。
- 所有可选缺失信息允许 null；前端必须处理空列表、404、503和取消请求，不显示虚构默认值。

## 3. 已实现基础端点

| 方法/路径 | 输入 | 输出/业务规则 |
| --- | --- | --- |
| GET /health/live | 无 | 进程能响应即200；不访问数据库 |
| GET /health/ready | 无 | 数据库连接、迁移版本与基础表可用才200；否则503 |
| GET /api/v1/system/status | 无 | SystemStatus；version、api_version、capabilities，不泄露配置 |
| GET /api/v1/campuses | 无 | Campus[]，只返回 active 校园 |
| GET /api/v1/campuses/{campus_id} | slug | Campus；无效/停用校园404 |
| GET /api/v1/campuses/{campus_id}/points | q<=120、category枚举、page、page_size | Point[]；按name/id稳定排序；服务端搜索name/summary，M01前端读取公开目录后按名称和别名筛选 |
| GET /api/v1/points/{point_id} | UUID | Point；必须公开且已发布，校园active |

空校园目录合法返回 `data:[]`；存在的校园但没有点位返回 data:[]、total:0。不存在校园返回404。搜索中的 `%`、`_` 按普通字符转义，不允许绕过筛选。

## 4. 地图、VR、楼层和讲解

地图读取、PNG图块、公开楼层/标注图、每点VR列表和后台资源编辑已实现；通用媒体授权、讲解和房间接口仍为计划契约。PNG图块成功响应为二进制，不包裹JSON信封；失败仍使用统一错误体。

| 方法/路径（均省略 /api/v1） | 响应模型 | 权限与语义 |
| --- | --- | --- |
| GET /campuses/{campus_id}/maps | MapInfo[] | 只返回可见已发布地图；含尺寸、版本、image_asset_id |
| GET /maps/{map_id} | MapInfo | 获取当前有效版本；更新版本导致几何重新加载 |
| GET /maps/{map_id}/features | MapFeatures | map_revision + PointGeometry[]；锚点与多边形在原图坐标系 |
| GET /maps/{map_id}/tiles/{revision}/{z}/{x}/{y}.png | image/png | 已实现；每次核对地图公开状态、校园启用状态、当前版本及图块边界 |
| GET /points/{point_id}/media | MediaInfo[] | 只返回有权限的媒体元数据，不含真实私有路径 |
| GET /media/{media_id}/access | MediaAccess | 每次校验当前权限、发布状态、有效期；不把模型判断当鉴权 |
| GET /points/{point_id}/narrations | Narration[] | 审核讲解词、source版本、可选audio_asset_id |
| GET /points/{point_id}/floors | Floor[] | 只列出允许查看的楼层；ordinal升序 |
| GET /floors/{floor_id} | Floor | 无权限视同404；不暴露内部楼层名称 |
| GET /floors/{floor_id}/rooms | Room[] | 公开范围内房间号、用途、几何与入口；不从图片猜测 |

MediaAccess.mode=external 表示外部官方资源，不能承诺本项目能限制其转发；同源私有下载后续使用服务端授权或<=5分钟签名，并禁止缓存。URL允许https或指定同源相对路径，拒绝 javascript/data/file、用户自定义内网地址。iframe仅在目标站实际允许且授权时使用。

图片像素坐标校验不仅验证>=0，还必须读取相应 map_revision 的 width/height验证上界。返回的地图、几何、路径版本必须一致；不一致前端停止绘制并重取。

## 5. 路线（M03）

`POST /routes` → 201 Envelope[RouteResult]，需匿名会话、CSRF与Idempotency-Key。

```json
{
  "campus_id": "nku-jinnan",
  "start": {"kind": "point", "id": "00000000-0000-4000-8000-000000000001"},
  "end": {"kind": "point", "id": "00000000-0000-4000-8000-000000000002"},
  "via": [],
  "accessibility": "standard",
  "departure_at": null,
  "graph_revision": null
}
```

上述 UUID 仅为协议示例，不是实际校园点位。start/end/via只能引用已存在且可达的 point/entrance/room；同一校园，via<=10。未指定 departure_at 使用服务端当前时间；图版本为空则选当前发布版。

步骤：身份与资源权限 → 读取发布图版本 → 时段/关闭/无障碍过滤 → 选择经核实入口 → 算路 → 转成按地图分段路径 → 保存输入和版本 → 输出。

RouteResult 提供 route_id、graph_revision、segments、distance_m、walking_duration_seconds、warnings、expires_at。缺少距离标定时两个度量均可null。不可达409 ROUTE_UNAVAILABLE，图版本过期409 STALE_VERSION；未知资源404；没有路网503 MODULE_UNAVAILABLE。

`GET /routes/{route_id}` 只允许创建者读取，重新检查资源权限；过期404/410 RESOURCE_EXPIRED，不可用别人的 route_id 读取内部路线。

## 6. 导览编排（M06）

| 方法/路径 | 请求/响应 | 语义 |
| --- | --- | --- |
| GET /campuses/{campus_id}/tours | →TourTemplate[] | 已审核模板，不能把生成草稿公开为官方路线 |
| POST /tour-plans | TourPlanRequest→TourPlan | mode必填；时长5—240分钟；preferred_point_ids<=20；walking必须start |
| GET /tour-plans/{plan_id} | →TourPlan | 会话所有者；提供顺序、来源、时长、route_id与revision |
| PATCH /tour-plans/{plan_id} | TourAdjustment→TourPlan | expected_revision；shorten需要duration_minutes，skip需要point_id，change_theme需要theme |

线上模式不填步行距离；walking须调用路线模块并满足可达性。调整保留已经完成的点位；revision冲突409，不能静默覆盖另一个标签页的修改。执行完毕返回新revision。

## 7. 身份与聊天（M02/M04）

| 方法/路径 | 请求/响应 |
| --- | --- |
| POST /auth/guest-session | 无体→GuestSession；Set-Cookie不透明会话，返回CSRF token |
| GET /auth/me | →Identity；来自服务端会话的角色 |
| DELETE /auth/session | →Identity(authenticated=false,roles=[])；注销并使关联私有会话不可继续访问 |
| POST /chat/sessions | ChatSessionRequest→ChatSession |
| POST /chat/sessions/{session_id}/turns | ChatTurnRequest→202 ChatTurnAccepted |
| GET /chat/turns/{turn_id} | →ChatTurnAccepted，含当前状态 |
| GET /chat/turns/{turn_id}/events | text/event-stream；事件data为ChatEvent |
| DELETE /chat/turns/{turn_id} | 取消→ChatTurnAccepted；终态可重复取消，不恢复任务 |
| POST /chat/turns/{turn_id}/actions/{action_id}/ack | ActionAck→ActionAck |

ChatTurnRequest.message长度1—2000，client_message_id唯一UUID，context显式包含campus_id/revision/当前点位/楼层/模式等；服务端必须验证上下文引用，不能相信用户提交的角色、权限或源码URL。

身份cookie：HttpOnly+Secure+SameSite=Lax；跨站写入检查Origin与CSRF。建立访客会话也做同源与限流校验。后台现有独立员工会话已实现，SSO真实回调协议仍需学校提供；不凭空假定SSO已完成。

SSE状态机、动作和平台适配详见05。

## 8. 咨询与后台

| 方法/路径 | 请求→响应 | 角色 |
| --- | --- | --- |
| GET /official-channels | →OfficialChannel[] | 公众；有效期内的官方渠道 |
| POST /inquiries | InquiryRequest→Inquiry | 访客；问题先脱敏再存储 |
| GET /admin/inquiries/stats | →InquiryStats | analyst；v1固定过去7个UTC日聚合，不返回原始个人咨询 |
| POST /admin/points | PointDraftInput→AdminPoint | contributor；新建草稿 |
| PUT /admin/points/{point_id} | PointDraftUpdate→AdminPoint | contributor；全字段替换草稿，expected_revision并发保护 |
| POST /admin/points/{point_id}/submit | ReviewRequest→AdminPoint | contributor；提交审核 |
| POST /admin/points/{point_id}/publish | ReviewRequest→AdminPoint | reviewer；只发布审核状态且来源有效版本 |
| POST /admin/points/{point_id}/retire | ReviewRequest→AdminPoint | reviewer；撤回并触发索引失效 |
| POST /admin/sources | SourceDraftInput→SourceDraft | contributor；正文<=100000字符 |
| POST /admin/sources/{source_id}/publish | ReviewRequest→SourceDraft | reviewer；发布有效资料 |
| POST /admin/sources/{source_id}/retire | ReviewRequest→SourceDraft | reviewer；停止相关资料被引用 |
| POST /admin/uploads | multipart/form-data file→UploadedFile | contributor；写隔离暂存区，校验真实类型和大小 |
| POST /admin/media | MediaRegistration→MediaInfo | contributor；external_url/uploaded_file_id二选一，先草稿 |
| POST /admin/media/{media_id}/publish | ReviewRequest→MediaInfo | reviewer；授权、脱敏、公开范围全部确认 |
| POST /admin/media/{media_id}/retire | ReviewRequest→MediaInfo | reviewer；撤回并失效访问授权 |
| GET /admin/points | →AdminPoint[]，分页 | contributor；可访问范围内的草稿/审核/发布点位 |
| GET /admin/points/{point_id} | →AdminPoint | contributor；供编辑和审核读取 |
| GET /admin/sources | →AdminSource[]，分页 | contributor；含正文、来源、状态与版本 |
| GET /admin/sources/{source_id} | →AdminSource | contributor；审核时读取实际内容 |
| PUT /admin/sources/{source_id} | SourceDraftUpdate→AdminSource | contributor；expected_revision，编辑产生草稿新版本 |
| GET /admin/media | →AdminMedia[]，分页 | contributor；元数据及发布状态 |
| GET /admin/media/{media_id} | →AdminMedia | contributor；文件预览仍通过授权访问接口 |
| GET /admin/inquiries | →AdminInquiry[]，分页 | analyst；只含脱敏问题、处理状态和版本 |
| PATCH /admin/inquiries/{inquiry_id} | InquiryResolution→AdminInquiry | analyst；expected_revision；转交必须填写官方channel_id |

管理列表使用page/page_size，与公开列表一致；返回总数。reviewer/admin需要相应内容读取授权才能执行审核，不因进入页面就获得所有资料权限。员工角色可组合，权限范围由服务端赋予。

地图/路网批量标注首版通过经过schema校验的管理CLI导入，不暴露通用任意SQL/文件执行HTTP接口。可视化地图编辑器后续另立协议版本，不假装本轮已经提供。

## 9. 幂等、并发和错误

POST turns/routes/tour-plans/inquiries 必须携带UUID Idempotency-Key。按主体+方法+路径+key存24小时；同key同body返回原资源，同key不同body返回409 IDEMPOTENCY_CONFLICT。并发创建通过数据库唯一约束解决，不能只在内存检查。聊天另对session_id/client_message_id去重。

编辑使用expected_revision；写入 SQL 同时比较 revision，成功后+1。所有body的权限、revision、状态校验在同一事务完成；审核发布写audit事件。

| HTTP | code | 前端处理 |
| --- | --- | --- |
| 400 | BAD_REQUEST / INVALID_ORIGIN | 提示请求无法处理，不自动重试 |
| 401 | AUTH_REQUIRED | 建立/恢复会话；后台进入正式登录 |
| 403 | FORBIDDEN / CSRF_INVALID | 不展示受限动作，不重复尝试绕过 |
| 404 | NOT_FOUND | 清理选中资源，提示不存在或不可用 |
| 409 | STALE_VERSION / INVALID_STATE / ROUTE_UNAVAILABLE / IDEMPOTENCY_CONFLICT | 重新读取或让用户改条件 |
| 410 | RESOURCE_EXPIRED / EVENT_HISTORY_EXPIRED | 读取终态/重新发起，不续接不完整事件 |
| 413 | FILE_TOO_LARGE | 告知文件限制 |
| 415 | UNSUPPORTED_MEDIA_TYPE | 拒绝伪装扩展名 |
| 422 | VALIDATION_ERROR | 按details.field提示，不显示原始异常 |
| 429 | RATE_LIMITED | 遵循Retry-After |
| 500 | INTERNAL_ERROR | 显示request_id供排查 |
| 503 | DATABASE_NOT_READY / MODULE_UNAVAILABLE / AGENT_UNAVAILABLE | 保留已有页面，提供重试 |
| 504 | UPSTREAM_TIMEOUT | 提示超时；写请求必须用原幂等键重试 |

## 10. 兼容与契约变更

新增可选字段可留在v1；删字段、改语义、缩小枚举和改变权限前提属于破坏性变化，提交ADR并升级主版本。新增枚举时前端未知值必须安全回退。禁止复用旧action type表达新含义。

每次修改模型后运行：`uv run python ../../scripts/export_contract.py`；在web执行 `npm run generate:api`。CI检查两种生成文件与源定义同步。HTTP文档以稳定operation_id作为功能对接名称，不依赖函数名或文件行号。
