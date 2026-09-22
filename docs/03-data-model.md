# 数据模型、坐标和版本规范

## 1. 通用约定

资源 ID 默认 UUID v4 的小写标准字符串，不从中文名称派生。`campus_id` 使用稳定 slug，首个为 `nku-jinnan`。中文名、别名、房间号均可修改，ID 不变。URL 中不能使用数组下标当永久 ID。

时间为带时区 ISO 8601 UTC，例 `2026-09-23T00:00:00Z`。显示时按用户时区格式化。未确定的信息使用 null，不用空字符串或 0 冒充。长度以字符计，坐标是有限数值，拒绝 NaN/Infinity。

状态与字段是业务模型；公开 DTO 仅返回访问者获准阅读的子集。禁止把 ORM 对象 `__dict__` 全量序列化。

## 2. M00 实际建表

### campuses

| 字段 | 类型/规则 |
| --- | --- |
| id | varchar(64) 主键；小写字母数字与连字符 |
| name | varchar(120)，非空 |
| description | text，默认空字符串 |
| is_active | boolean，默认 true |
| created_at / updated_at | UTC datetime |

初始化只插入 `nku-jinnan / 南开大学津南校区`。不自动导入规划图上的未核实建筑，不写虚构点位。

### points

| 字段 | 类型/规则 |
| --- | --- |
| id | UUID 字符串主键 |
| campus_id | 外键 campuses.id，删除限制 |
| name | varchar(120)，非空；同名可存在，界面以院区/建筑区分 |
| aliases | JSON 字符串数组，默认 [] |
| category | public_area / patriotic / academic / residence / dining / commerce / landscape / history |
| summary | text，公开摘要，最多 2000 字 |
| status | draft / in_review / published / retired |
| visibility | public / internal / restricted |
| revision | 整数 >=1，修改递增 |
| created_at / updated_at | UTC datetime |

索引：campus_id/status/visibility；分类索引。公开查询强制 `status=published AND visibility=public AND campus.is_active=true`；未公开对象按不存在返回 404，不泄露名称。

M00 没有公开写接口，也没有后台登录。后续 M01 加入审核工作流后才允许业务写入；测试 fixtures 不进入正式初始化。

## 3. 后续表（已设计，需对应迁移后才存在）

| 表 | 核心字段 | 约束/索引 |
| --- | --- | --- |
| maps | id, campus_id, kind(campus/floor), width_px, height_px, image_asset_id, revision, published_at | width/height>0；资源必须可访问；保留旧版本关联 |
| point_geometries | id, point_id, map_id, map_revision, anchor_x/y, polygon_json, entrance_ids | 同一 point/map_revision 唯一；坐标不得越界 |
| entrances | id, point_id, floor_id?, map_id, x, y, public_access, verified_at | 对应路网节点；无核实不用于路线 |
| floors | id, point_id, label, ordinal, map_id, revision, visibility, status | ordinal 可为 -1/0/1；展示名保留实际命名 |
| rooms | id, floor_id, number, name?, kind, polygon, entrance_node_ids, visibility | number 是字符串，保留 001/A101/B1；房间与入口一对多 |
| graphs | id, campus_id, revision, status, verified_at, valid_from/to | 发布不可就地覆盖；路由记录 graph_revision |
| graph_nodes | id, graph_id, map_id, x, y, type, point_id?, room_id? | road/entrance/stair/elevator；指向存在的图层 |
| graph_edges | id, graph_id, from_id, to_id, directed, geometry, length_m?, cost, kind, access_policy, open_hours, verified_at | cost>0；非负权；每条边有核实状态；楼层连接需成对对应 |
| media_assets | id, point_id?, kind, storage_key?, external_url?, mime_type, sha256, bytes, visibility, status, rights_note, captured_at, revision | storage_key 不对外；URL 与本地文件二选一；不接受任意 scheme |
| sources | id, title, issuer, source_url?, document_asset_id?, effective_from/to, visibility, revision, status | 来源可到期、撤回；必须记录版本 |
| narrations | id, point_id, text, source_ids, audience, audio_asset_id?, revision, status | 讲解稿审核后生成音频；声音更换不改变事实版本 |
| publications | id, resource_type/id, revision, reviewer_id, published_at, index_state | 发布历史不可修改；记录索引同步状态 |
| tours | id, campus_id, title, theme, audience, mode, point_ids, source_ids, revision, status | 模板由人工审核；生成行程保留模板及内容版本 |
| route_results | id, campus_id, graph_revision, input_json, segments_json, expires_at | 权限上下文变化后不可复用受限结果 |
| tour_plans | id, session_id, mode, stops_json, constraints_json, route_id?, duration_seconds?, revision | walking 才可能有 route_id；顺序由验证后的编排确定 |
| chat_sessions | id, owner_session_hash, context_json, created_at, expires_at | 访客身份仅来自服务端会话；不可由请求自报 role |
| chat_turns | id, session_id, client_message_id, status, input_redacted, answer, sources_json, timestamps | unique(session_id,client_message_id)；不存平台密钥 |
| chat_events | turn_id, seq, type, payload, created_at | unique(turn_id,seq)；支持按 seq 续传 |
| action_receipts | action_id, turn_id, resource_revision, status, reason_code | 客户端 ack 仅用于体验统计，不能作为权限证据 |
| inquiries | id, session_id?, category, question_redacted, resolution, official_channel_id?, created_at | unresolved/resolved/referred；个人信息最小化 |
| official_channels | id, name, kind, url, source_id, effective_to, status | 只有经过核实的 https 官方地址 |
| staff / roles / grants | 人员身份、权限范围、有效期 | 从可信身份源建立；最小权限；禁止前端自授 |
| audit_events | actor_id/hash, action, resource_id, before/after_revision, request_id, time | 审核/撤回/权限修改追加记录，不记录密钥 |

## 4. 坐标系：统一原图像素

业务 DTO 一律 `{x,y}`：原图左上为 (0,0)，x 向右，y 向下；宽 W、高 H，范围 0<=x<=W、0<=y<=H。不使用经纬度，不伪装 GeoJSON geography。

Leaflet 适配采用 `lat = H - y, lng = x`，图像 bounds 为 `[[0,0],[H,W]]`；所有 image、polygon、polyline 使用相同转换。反向为 `x=lng, y=H-lat`。仅在 shared map adapter 中转换一次。

原图裁剪、缩放或换版必须更新 map_revision 并转换全部几何。禁止前端按截图尺寸存点，禁止换图不换坐标。容器大小和设备像素比不改变业务坐标。

地图几何包括锚点、点击多边形、入口与路径；四者职责不同。点击锚点不能自动当作可进入建筑的门。

## 5. 路网和楼层

一条路线由多个 segment 构成，每段明确 map_id/map_revision、floor_id?、二维 path。跨楼层转换另给 transition(stairs/elevator)、from_floor_id、to_floor_id。不能把不同楼层的坐标连在一张图上。

优先用经过测量的 length_m；没有标定时允许内部像素 cost 算相对路径，但 distance_m 和 walking_duration_seconds 返回 null。开放时段、道路关闭、访问权限在算路前过滤；若不可达返回 ROUTE_UNAVAILABLE，不画穿楼/穿水直线。

“无障碍”要求每条边的无障碍信息经过核实，未知边不能默认为可用。入口、门、楼梯、电梯需要人工确认；楼层图的疏散箭头不等同普通参观路径。

## 6. 发布与撤回状态机

draft → in_review → published → retired；审核退回回到 draft。编辑已发布内容创建新 revision，旧版持续有效直到新版审核通过。撤回立即停止公开读取，安排知识库与缓存清理；清理期间查询层仍必须过滤已撤回 source_ids。

审核必须记录人、时、版本和来源。内容作者与审核者原则上分离。没有审核权限时禁止仅凭模型标记 safe=true 发布。

## 7. 存储与知识库

PostgreSQL 是点位、权限、有效内容和发布状态的事实源。知识库仅含获准送入平台的发布副本，携带 source_id/revision/point_id/visibility/effective_to。平台无法保证分级检索时，首版只同步公开材料。

地图与公开素材可生成公开衍生文件；内部原件与私有素材存储在不公开目录。访问接口依据当前权限生成短时授权，不返回 storage_key。取消下载按钮不能替代权限。

## 8. 数据导入

导入前校验引用、ID、坐标范围、重复房间号、资料来源、公开范围与文件 hash。先进入草稿，审核后发布。每批导入有 batch_id 和回滚清单；不得在启动时自动扫描文件夹并公开所有图片。
