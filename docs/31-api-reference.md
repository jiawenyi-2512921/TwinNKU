# HTTP接口与字段完整参考（自动生成）

由scripts/render_api_reference.py从contracts/openapi.json生成；不要手工改字段。
完整契约含已实现和planned。planned只供开发，不代表生产可调用。
业务约束见21—29；接口上线前必须先处理24中的协议缺口和旧角色命名，不能猜学校平台API。
字段约束只覆盖JSON Schema；来源有效期、关联权限、跨字段状态仍须service和测试保证。

接口操作数：80；状态统计：{"implemented": 44, "planned": 36}。
契约SHA256：`4b07dc381c71b895a95864a3d05036ce83536e507a92751753018031a555b1a9`。

## 1. 全部端点

| 方法 | 路径 | operation_id | 状态 | 权限标签 | 请求 | 成功响应 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/admin/audit` | listAdminAudit | implemented | staff | — | 200: application/json Envelope_list_AuditEvent__ |
| POST | `/api/v1/admin/auth/login` | staffLogin | implemented | public | application/json: StaffLogin | 200: application/json Envelope_StaffSession_ |
| POST | `/api/v1/admin/auth/logout` | staffLogout | implemented | staff | — | 200: application/json Envelope_ActionResult_ |
| POST | `/api/v1/admin/auth/password` | changeStaffPassword | implemented | staff | application/json: StaffPasswordChange | 200: application/json Envelope_ActionResult_ |
| GET | `/api/v1/admin/campuses` | listStaffCampuses | implemented | staff | — | 200: application/json Envelope_list_Campus__ |
| GET | `/api/v1/admin/floor-images/{upload_id}` | previewUploadedFloor | implemented | staff | — | 见契约响应 |
| GET | `/api/v1/admin/inquiries` | listAdminInquiries | planned | analyst | — | 200: application/json Envelope_list_AdminInquiry__ |
| GET | `/api/v1/admin/inquiries/stats` | getInquiryStats | planned | analyst | — | 200: application/json Envelope_InquiryStats_ |
| PATCH | `/api/v1/admin/inquiries/{inquiry_id}` | resolveInquiry | planned | analyst | application/json: InquiryResolution | 200: application/json Envelope_AdminInquiry_ |
| GET | `/api/v1/admin/maps` | listStaffMaps | implemented | staff | — | 200: application/json Envelope_list_MapInfo__ |
| GET | `/api/v1/admin/maps/{map_id}/points` | listStaffMapPoints | implemented | staff | — | 200: application/json Envelope_list_AdminMapPoint__ |
| GET | `/api/v1/admin/media` | listAdminMedia | planned | contributor | — | 200: application/json Envelope_list_AdminMedia__ |
| POST | `/api/v1/admin/media` | registerMedia | planned | contributor | application/json: MediaRegistration | 201: application/json Envelope_MediaInfo_ |
| GET | `/api/v1/admin/media/{media_id}` | getAdminMedia | planned | contributor | — | 200: application/json Envelope_AdminMedia_ |
| POST | `/api/v1/admin/media/{media_id}/publish` | publishMedia | planned | reviewer | application/json: ReviewRequest | 200: application/json Envelope_MediaInfo_ |
| POST | `/api/v1/admin/media/{media_id}/retire` | retireMedia | planned | reviewer | application/json: ReviewRequest | 200: application/json Envelope_MediaInfo_ |
| GET | `/api/v1/admin/points` | listAdminPoints | implemented | staff | — | 200: application/json Envelope_list_AdminPoint__ |
| POST | `/api/v1/admin/points` | createPointDraft | implemented | staff | application/json: PointDraftInput | 201: application/json Envelope_AdminPoint_ |
| GET | `/api/v1/admin/points/{point_id}` | getAdminPoint | implemented | staff | — | 200: application/json Envelope_AdminPoint_ |
| PUT | `/api/v1/admin/points/{point_id}` | updatePointDraft | implemented | staff | application/json: PointDraftUpdate | 200: application/json Envelope_AdminPoint_ |
| POST | `/api/v1/admin/points/{point_id}/discard` | discardPointDraft | implemented | staff | application/json: ReviewRequest | 200: application/json Envelope_AdminPoint_ |
| POST | `/api/v1/admin/points/{point_id}/floor-images` | uploadFloorOriginal | implemented | staff | image/jpeg: string (binary); image/png: string (binary) | 201: application/json Envelope_FloorUpload_ |
| POST | `/api/v1/admin/points/{point_id}/publish` | publishPoint | implemented | staff | application/json: ReviewRequest | 200: application/json Envelope_AdminPoint_ |
| POST | `/api/v1/admin/points/{point_id}/reject` | rejectPointReview | implemented | staff | application/json: ReviewRequest | 200: application/json Envelope_AdminPoint_ |
| POST | `/api/v1/admin/points/{point_id}/resources` | createResourceDraft | implemented | staff | application/json: ResourceDraftSave | 201: application/json Envelope_AdminResource_ |
| POST | `/api/v1/admin/points/{point_id}/retire` | retirePoint | implemented | staff | application/json: PointRetireRequest | 200: application/json Envelope_AdminPoint_ |
| POST | `/api/v1/admin/points/{point_id}/submit` | submitPointReview | implemented | staff | application/json: ReviewRequest | 200: application/json Envelope_AdminPoint_ |
| GET | `/api/v1/admin/resources` | listAdminResources | implemented | staff | — | 200: application/json Envelope_list_AdminResource__ |
| GET | `/api/v1/admin/resources/{resource_id}` | getAdminResource | implemented | staff | — | 200: application/json Envelope_AdminResource_ |
| PUT | `/api/v1/admin/resources/{resource_id}` | updateResourceDraft | implemented | staff | application/json: ResourceDraftSave | 200: application/json Envelope_AdminResource_ |
| GET | `/api/v1/admin/resources/{resource_id}/images/{draft_revision}/{section}` | previewResourceFloor | implemented | staff | — | 见契约响应 |
| POST | `/api/v1/admin/resources/{resource_id}/retire` | requestResourceRetirement | implemented | staff | application/json: ResourceRetireRequest | 200: application/json Envelope_AdminResource_ |
| POST | `/api/v1/admin/resources/{resource_id}/review/{action}` | transitionResourceReview | implemented | staff | application/json: ReviewRequest | 200: application/json Envelope_AdminResource_ |
| GET | `/api/v1/admin/session` | getStaffSession | implemented | staff | — | 200: application/json Envelope_StaffSession_ |
| GET | `/api/v1/admin/sources` | listAdminSources | planned | contributor | — | 200: application/json Envelope_list_AdminSource__ |
| POST | `/api/v1/admin/sources` | createSourceDraft | planned | contributor | application/json: SourceDraftInput | 201: application/json Envelope_SourceDraft_ |
| GET | `/api/v1/admin/sources/{source_id}` | getAdminSource | planned | contributor | — | 200: application/json Envelope_AdminSource_ |
| PUT | `/api/v1/admin/sources/{source_id}` | updateSourceDraft | planned | contributor | application/json: SourceDraftUpdate | 200: application/json Envelope_AdminSource_ |
| POST | `/api/v1/admin/sources/{source_id}/publish` | publishSource | planned | reviewer | application/json: ReviewRequest | 200: application/json Envelope_SourceDraft_ |
| POST | `/api/v1/admin/sources/{source_id}/retire` | retireSource | planned | reviewer | application/json: ReviewRequest | 200: application/json Envelope_SourceDraft_ |
| POST | `/api/v1/admin/uploads` | uploadFile | planned | contributor | multipart/form-data: Body_uploadFile | 201: application/json Envelope_UploadedFile_ |
| GET | `/api/v1/admin/users` | listStaffUsers | implemented | staff | — | 200: application/json Envelope_list_StaffUser__ |
| POST | `/api/v1/admin/users` | createStaffUser | implemented | staff | application/json: StaffUserCreate | 201: application/json Envelope_StaffUser_ |
| PUT | `/api/v1/admin/users/{user_id}` | updateStaffUser | implemented | staff | application/json: StaffUserUpdate | 200: application/json Envelope_StaffUser_ |
| POST | `/api/v1/auth/guest-session` | createGuestSession | planned | public | — | 201: application/json Envelope_GuestSession_ |
| GET | `/api/v1/auth/me` | getIdentity | planned | guest_session | — | 200: application/json Envelope_Identity_ |
| DELETE | `/api/v1/auth/session` | endSession | planned | guest_session | — | 200: application/json Envelope_Identity_ |
| GET | `/api/v1/campuses` | listCampuses | implemented | 未标记 | — | 200: application/json Envelope_list_Campus__ |
| GET | `/api/v1/campuses/{campus_id}` | getCampus | implemented | 未标记 | — | 200: application/json Envelope_Campus_ |
| GET | `/api/v1/campuses/{campus_id}/maps` | listMaps | implemented | public | — | 200: application/json Envelope_list_MapInfo__ |
| GET | `/api/v1/campuses/{campus_id}/points` | listPoints | implemented | 未标记 | — | 200: application/json Envelope_list_Point__ |
| GET | `/api/v1/campuses/{campus_id}/tours` | listTourTemplates | planned | public | — | 200: application/json Envelope_list_TourTemplate__ |
| POST | `/api/v1/chat/sessions` | createChatSession | planned | guest_session | application/json: ChatSessionRequest | 201: application/json Envelope_ChatSession_ |
| POST | `/api/v1/chat/sessions/{session_id}/turns` | createChatTurn | planned | owner | application/json: ChatTurnRequest | 202: application/json Envelope_ChatTurnAccepted_ |
| DELETE | `/api/v1/chat/turns/{turn_id}` | cancelChatTurn | planned | owner | — | 200: application/json Envelope_ChatTurnAccepted_ |
| GET | `/api/v1/chat/turns/{turn_id}` | getChatTurn | planned | owner | — | 200: application/json Envelope_ChatTurnAccepted_ |
| POST | `/api/v1/chat/turns/{turn_id}/actions/{action_id}/ack` | acknowledgeAction | planned | owner | application/json: ActionAck | 200: application/json Envelope_ActionAck_ |
| GET | `/api/v1/chat/turns/{turn_id}/events` | streamChatEvents | planned | owner | — | 200: text/event-stream string |
| GET | `/api/v1/floors/{floor_id}` | getFloor | implemented | resource_policy | — | 200: application/json Envelope_Floor_ |
| GET | `/api/v1/floors/{floor_id}/images/{revision}/{variant}` | getFloorImage | implemented | resource_policy | — | 200: image/jpeg string (binary); 200: image/png string (binary) |
| GET | `/api/v1/floors/{floor_id}/rooms` | listRooms | planned | resource_policy | — | 200: application/json Envelope_list_Room__ |
| POST | `/api/v1/inquiries` | createInquiry | planned | guest_session | application/json: InquiryRequest | 201: application/json Envelope_Inquiry_ |
| GET | `/api/v1/maps/{map_id}` | getMap | implemented | public | — | 200: application/json Envelope_MapInfo_ |
| GET | `/api/v1/maps/{map_id}/features` | getMapFeatures | implemented | public | — | 200: application/json Envelope_MapFeatures_ |
| GET | `/api/v1/maps/{map_id}/tiles/{revision}/{z}/{x}/{y}.png` | getMapTile | implemented | public | — | 200: image/png string (binary) |
| GET | `/api/v1/media/{media_id}/access` | getMediaAccess | planned | resource_policy | — | 200: application/json Envelope_MediaAccess_ |
| GET | `/api/v1/official-channels` | listOfficialChannels | planned | public | — | 200: application/json Envelope_list_OfficialChannel__ |
| GET | `/api/v1/points/{point_id}` | getPoint | implemented | 未标记 | — | 200: application/json Envelope_Point_ |
| GET | `/api/v1/points/{point_id}/floors` | listFloors | implemented | resource_policy | — | 200: application/json Envelope_list_Floor__ |
| GET | `/api/v1/points/{point_id}/media` | listPointMedia | planned | public | — | 200: application/json Envelope_list_MediaInfo__ |
| GET | `/api/v1/points/{point_id}/narrations` | listNarrations | planned | public | — | 200: application/json Envelope_list_Narration__ |
| GET | `/api/v1/points/{point_id}/panoramas` | listPointPanoramas | implemented | 未标记 | — | 200: application/json Envelope_list_Panorama__ |
| POST | `/api/v1/routes` | calculateRoute | planned | guest_session | application/json: RouteRequest | 201: application/json Envelope_RouteResult_ |
| GET | `/api/v1/routes/{route_id}` | getRoute | planned | owner | — | 200: application/json Envelope_RouteResult_ |
| GET | `/api/v1/system/status` | getSystemStatus | implemented | 未标记 | — | 200: application/json Envelope_SystemStatus_ |
| POST | `/api/v1/tour-plans` | createTourPlan | planned | guest_session | application/json: TourPlanRequest | 201: application/json Envelope_TourPlan_ |
| GET | `/api/v1/tour-plans/{plan_id}` | getTourPlan | planned | owner | — | 200: application/json Envelope_TourPlan_ |
| PATCH | `/api/v1/tour-plans/{plan_id}` | adjustTourPlan | planned | owner | application/json: TourAdjustment | 200: application/json Envelope_TourPlan_ |
| GET | `/health/live` | healthLive | implemented | 未标记 | — | 200: application/json Health |
| GET | `/health/ready` | healthReady | implemented | 未标记 | — | 200: application/json Health |

## 2. 路径与查询参数

认证cookie、Origin/CSRF和幂等header的业务规则另见04、15、18、24。以下是契约显式声明的参数。

### GET /api/v1/admin/audit

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | query | 否 | string (uuid) / null | —; — |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 25 |

### POST /api/v1/admin/auth/login

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| Origin | header | 是 | string | — |

### POST /api/v1/admin/auth/logout

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/auth/password

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/floor-images/{upload_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| upload_id | path | 是 | string (uuid) | — |

### GET /api/v1/admin/inquiries

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 20 |

### PATCH /api/v1/admin/inquiries/{inquiry_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| inquiry_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/maps/{map_id}/points

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| map_id | path | 是 | string (uuid) | — |

### GET /api/v1/admin/media

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 20 |

### POST /api/v1/admin/media

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/media/{media_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| media_id | path | 是 | string (uuid) | — |

### POST /api/v1/admin/media/{media_id}/publish

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| media_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/media/{media_id}/retire

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| media_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/points

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| campus_id | query | 否 | string / null | 格式: ^[a-z0-9][a-z0-9-]{1,63}$; — |
| q | query | 否 | string | 最长: 100; 默认: "" |
| status | query | 否 | ContentStatus / null | —; — |
| draft_state | query | 否 | draft / in_review / rejected / published / discarded / null | —; — |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 25 |

### POST /api/v1/admin/points

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/points/{point_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### PUT /api/v1/admin/points/{point_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/discard

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/floor-images

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/publish

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/reject

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/resources

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/retire

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/points/{point_id}/submit

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/resources

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | query | 否 | string (uuid) / null | —; — |
| state | query | 否 | draft / in_review / rejected / null | —; — |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 50 |

### GET /api/v1/admin/resources/{resource_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| resource_id | path | 是 | string (uuid) | — |

### PUT /api/v1/admin/resources/{resource_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| resource_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/resources/{resource_id}/images/{draft_revision}/{section}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| resource_id | path | 是 | string (uuid) | — |
| draft_revision | path | 是 | integer | — |
| section | path | 是 | string | — |

### POST /api/v1/admin/resources/{resource_id}/retire

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| resource_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/resources/{resource_id}/review/{action}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| resource_id | path | 是 | string (uuid) | — |
| action | path | 是 | submit / publish / reject / discard | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/sources

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 20 |

### POST /api/v1/admin/sources

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/sources/{source_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| source_id | path | 是 | string (uuid) | — |

### PUT /api/v1/admin/sources/{source_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| source_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/sources/{source_id}/publish

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| source_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/sources/{source_id}/retire

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| source_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/admin/uploads

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/admin/users

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 25 |

### POST /api/v1/admin/users

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### PUT /api/v1/admin/users/{user_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| user_id | path | 是 | string (uuid) | — |
| Origin | header | 是 | string | — |
| X-CSRF-Token | header | 是 | string | — |

### DELETE /api/v1/auth/session

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/campuses/{campus_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| campus_id | path | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |

### GET /api/v1/campuses/{campus_id}/maps

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| campus_id | path | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |

### GET /api/v1/campuses/{campus_id}/points

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| campus_id | path | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| q | query | 否 | string / null | 最长: 120; — |
| category | query | 否 | PointCategory / null | —; — |
| page | query | 否 | integer | 最小: 1; 默认: 1 |
| page_size | query | 否 | integer | 最小: 1; 最大: 100; 默认: 20 |

### GET /api/v1/campuses/{campus_id}/tours

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| campus_id | path | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |

### POST /api/v1/chat/sessions

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |

### POST /api/v1/chat/sessions/{session_id}/turns

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| session_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |
| Idempotency-Key | header | 是 | string (uuid) | — |

### DELETE /api/v1/chat/turns/{turn_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| turn_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/chat/turns/{turn_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| turn_id | path | 是 | string (uuid) | — |

### POST /api/v1/chat/turns/{turn_id}/actions/{action_id}/ack

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| turn_id | path | 是 | string (uuid) | — |
| action_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

### GET /api/v1/chat/turns/{turn_id}/events

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| turn_id | path | 是 | string (uuid) | — |
| Last-Event-ID | header | 否 | integer | 最小: 0 |

### GET /api/v1/floors/{floor_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| floor_id | path | 是 | string (uuid) | — |

### GET /api/v1/floors/{floor_id}/images/{revision}/{variant}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| floor_id | path | 是 | string (uuid) | — |
| revision | path | 是 | integer | — |
| variant | path | 是 | labeled / clean | — |
| section | query | 否 | string | 格式: ^[a-z0-9][a-z0-9_-]{0,31}$; 默认: "main" |

### GET /api/v1/floors/{floor_id}/rooms

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| floor_id | path | 是 | string (uuid) | — |

### POST /api/v1/inquiries

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |
| Idempotency-Key | header | 是 | string (uuid) | — |

### GET /api/v1/maps/{map_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| map_id | path | 是 | string (uuid) | — |

### GET /api/v1/maps/{map_id}/features

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| map_id | path | 是 | string (uuid) | — |

### GET /api/v1/maps/{map_id}/tiles/{revision}/{z}/{x}/{y}.png

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| map_id | path | 是 | string (uuid) | — |
| revision | path | 是 | integer | — |
| z | path | 是 | integer | — |
| x | path | 是 | integer | — |
| y | path | 是 | integer | — |

### GET /api/v1/media/{media_id}/access

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| media_id | path | 是 | string (uuid) | — |

### GET /api/v1/points/{point_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### GET /api/v1/points/{point_id}/floors

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### GET /api/v1/points/{point_id}/media

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### GET /api/v1/points/{point_id}/narrations

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### GET /api/v1/points/{point_id}/panoramas

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| point_id | path | 是 | string (uuid) | — |

### POST /api/v1/routes

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |
| Idempotency-Key | header | 是 | string (uuid) | — |

### GET /api/v1/routes/{route_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| route_id | path | 是 | string (uuid) | — |

### POST /api/v1/tour-plans

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| X-CSRF-Token | header | 是 | string | — |
| Idempotency-Key | header | 是 | string (uuid) | — |

### GET /api/v1/tour-plans/{plan_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| plan_id | path | 是 | string (uuid) | — |

### PATCH /api/v1/tour-plans/{plan_id}

| 字段 | 位置 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- | --- |
| plan_id | path | 是 | string (uuid) | — |
| X-CSRF-Token | header | 是 | string | — |

## 3. 全部DTO与字段

必填表示字段必须出现；nullable表示允许null，两者不是同一件事。数组、最大长度和枚举均须校验。引用模型继续查本节同名标题。

### ActionAck

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| reason | 是 | ok / stale_context / user_declined / resource_unavailable / playback_blocked | — |
| status | 是 | applied / skipped / failed | — |

### ActionResult

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| ok | 否 | boolean | 默认: true |

### AdminInquiry

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| category | 是 | visit_policy / campus_info / content_correction / other | — |
| created_at | 是 | string (date-time) | — |
| id | 是 | string (uuid) | — |
| official_channel_id | 否 | string (uuid) / null | —; — |
| question_redacted | 是 | string | — |
| resolution_note | 否 | string / null | —; — |
| revision | 是 | integer | 最小: 1.0 |
| status | 是 | unresolved / resolved / referred | — |

### AdminMapPoint

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| draft_geometry | 是 | PointLocationInput / null | —; — |
| draft_state | 是 | string / null | —; — |
| geometry | 是 | PointGeometry / null | —; — |
| id | 是 | string (uuid) | — |
| name | 是 | string | — |
| status | 是 | ContentStatus | — |

### AdminMedia

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| media | 是 | MediaInfo | — |
| status | 是 | ContentStatus | — |

### AdminPoint

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| draft | 是 | PointChange / null | —; — |
| geometries | 是 | array<PointGeometry> | — |
| point | 是 | Point | — |
| status | 是 | ContentStatus | — |
| visibility | 是 | Visibility | — |

### AdminResource

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| current | 是 | FloorContent / PanoramaContent / null | —; —; — |
| draft | 是 | ResourceChange / null | —; — |
| id | 是 | string (uuid) | — |
| images | 否 | array<FloorImage> | — |
| kind | 是 | floor / panorama | — |
| point_id | 是 | string (uuid) | — |
| point_name | 是 | string | — |
| published_revision | 是 | integer | 最小: 0.0 |
| status | 是 | draft / published / retired | — |

### AdminSource

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| effective_until | 否 | string (date-time) / null | —; — |
| id | 是 | string (uuid) | — |
| issuer | 是 | string | 最短: 1; 最长: 120 |
| revision | 是 | integer | 最小: 1.0 |
| source_url | 否 | string / null | —; — |
| status | 是 | ContentStatus | — |
| text | 是 | string | 最短: 1; 最长: 100000 |
| title | 是 | string | 最短: 1; 最长: 200 |
| visibility | 是 | Visibility | — |

### AgentAction

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| action_id | 是 | string (uuid) | — |
| context_revision | 是 | integer | 最小: 0 |
| requires_user_gesture | 是 | boolean | — |
| resource_id | 是 | string (uuid) | — |
| resource_revision | 是 | integer | 最小: 1 |
| type | 是 | focus_point / show_route / open_vr / show_floor / play_narration / show_tour | — |

### AuditEvent

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| action | 是 | string | — |
| actor_id | 是 | string (uuid) | — |
| actor_name | 是 | string | — |
| campus_id | 是 | string / null | 格式: ^[a-z0-9][a-z0-9-]{1,63}$; — |
| created_at | 是 | string (date-time) | — |
| details | 是 | object | — |
| id | 是 | string (uuid) | — |
| note | 是 | string | — |
| point_id | 是 | string (uuid) / null | —; — |

### Body_uploadFile

未知字段：按源模型定义。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| file | 是 | string | — |

### Campus

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| description | 是 | string | — |
| id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| name | 是 | string | 最短: 1; 最长: 120 |

### Capabilities

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| admin | 否 | boolean | 默认: false |
| chat | 否 | boolean | 默认: false |
| floors | 否 | boolean | 默认: false |
| map | 否 | boolean | 默认: false |
| routing | 否 | boolean | 默认: false |
| tours | 否 | boolean | 默认: false |
| vr | 否 | boolean | 默认: false |

### ChatEvent

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| action | 否 | AgentAction / null | 默认: null; —; — |
| error | 否 | ErrorInfo / null | 默认: null; —; — |
| seq | 是 | integer | 最小: 1 |
| source | 否 | SourceRef / null | 默认: null; —; — |
| text | 否 | string / null | 默认: null; —; — |
| turn_id | 是 | string (uuid) | — |
| type | 是 | turn.started / answer.delta / source.added / action.ready / turn.completed / turn.failed / turn.cancelled | — |

### ChatSession

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expires_at | 是 | string (date-time) | — |
| id | 是 | string (uuid) | — |

### ChatSessionRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| context | 是 | ViewContext | — |

### ChatTurnAccepted

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| events_url | 是 | string | — |
| state | 是 | queued / running / completed / failed / cancelled | — |
| turn_id | 是 | string (uuid) | — |

### ChatTurnRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| client_message_id | 是 | string (uuid) | — |
| context | 是 | ViewContext | — |
| message | 是 | string | 最短: 1; 最长: 2000 |

### ContentStatus

类型：draft / in_review / published / retired；—。

### Envelope_ActionAck_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | ActionAck | — |
| meta | 是 | Meta | — |

### Envelope_ActionResult_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | ActionResult | — |
| meta | 是 | Meta | — |

### Envelope_AdminInquiry_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | AdminInquiry | — |
| meta | 是 | Meta | — |

### Envelope_AdminMedia_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | AdminMedia | — |
| meta | 是 | Meta | — |

### Envelope_AdminPoint_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | AdminPoint | — |
| meta | 是 | Meta | — |

### Envelope_AdminResource_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | AdminResource | — |
| meta | 是 | Meta | — |

### Envelope_AdminSource_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | AdminSource | — |
| meta | 是 | Meta | — |

### Envelope_Campus_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | Campus | — |
| meta | 是 | Meta | — |

### Envelope_ChatSession_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | ChatSession | — |
| meta | 是 | Meta | — |

### Envelope_ChatTurnAccepted_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | ChatTurnAccepted | — |
| meta | 是 | Meta | — |

### Envelope_FloorUpload_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | FloorUpload | — |
| meta | 是 | Meta | — |

### Envelope_Floor_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | Floor | — |
| meta | 是 | Meta | — |

### Envelope_GuestSession_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | GuestSession | — |
| meta | 是 | Meta | — |

### Envelope_Identity_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | Identity | — |
| meta | 是 | Meta | — |

### Envelope_InquiryStats_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | InquiryStats | — |
| meta | 是 | Meta | — |

### Envelope_Inquiry_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | Inquiry | — |
| meta | 是 | Meta | — |

### Envelope_MapFeatures_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | MapFeatures | — |
| meta | 是 | Meta | — |

### Envelope_MapInfo_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | MapInfo | — |
| meta | 是 | Meta | — |

### Envelope_MediaAccess_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | MediaAccess | — |
| meta | 是 | Meta | — |

### Envelope_MediaInfo_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | MediaInfo | — |
| meta | 是 | Meta | — |

### Envelope_Point_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | Point | — |
| meta | 是 | Meta | — |

### Envelope_RouteResult_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | RouteResult | — |
| meta | 是 | Meta | — |

### Envelope_SourceDraft_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | SourceDraft | — |
| meta | 是 | Meta | — |

### Envelope_StaffSession_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | StaffSession | — |
| meta | 是 | Meta | — |

### Envelope_StaffUser_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | StaffUser | — |
| meta | 是 | Meta | — |

### Envelope_SystemStatus_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | SystemStatus | — |
| meta | 是 | Meta | — |

### Envelope_TourPlan_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | TourPlan | — |
| meta | 是 | Meta | — |

### Envelope_UploadedFile_

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | UploadedFile | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminInquiry__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminInquiry> | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminMapPoint__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminMapPoint> | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminMedia__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminMedia> | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminPoint__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminPoint> | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminResource__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminResource> | — |
| meta | 是 | Meta | — |

### Envelope_list_AdminSource__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AdminSource> | — |
| meta | 是 | Meta | — |

### Envelope_list_AuditEvent__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<AuditEvent> | — |
| meta | 是 | Meta | — |

### Envelope_list_Campus__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Campus> | — |
| meta | 是 | Meta | — |

### Envelope_list_Floor__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Floor> | — |
| meta | 是 | Meta | — |

### Envelope_list_MapInfo__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<MapInfo> | — |
| meta | 是 | Meta | — |

### Envelope_list_MediaInfo__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<MediaInfo> | — |
| meta | 是 | Meta | — |

### Envelope_list_Narration__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Narration> | — |
| meta | 是 | Meta | — |

### Envelope_list_OfficialChannel__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<OfficialChannel> | — |
| meta | 是 | Meta | — |

### Envelope_list_Panorama__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Panorama> | — |
| meta | 是 | Meta | — |

### Envelope_list_Point__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Point> | — |
| meta | 是 | Meta | — |

### Envelope_list_Room__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<Room> | — |
| meta | 是 | Meta | — |

### Envelope_list_StaffUser__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<StaffUser> | — |
| meta | 是 | Meta | — |

### Envelope_list_TourTemplate__

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| data | 是 | array<TourTemplate> | — |
| meta | 是 | Meta | — |

### ErrorEnvelope

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| error | 是 | ErrorInfo | — |
| meta | 是 | Meta | — |

### ErrorInfo

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| code | 是 | string | — |
| details | 否 | array<FieldError> | — |
| message | 是 | string | — |

### FieldError

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| field | 是 | string | — |
| message | 是 | string | — |

### Floor

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| attribution | 否 | string | 默认: "" |
| id | 是 | string (uuid) | — |
| images | 否 | array<FloorImage> | — |
| label | 是 | string | — |
| map_id | 是 | string (uuid) | — |
| ordinal | 是 | integer | — |
| point_id | 是 | string (uuid) | — |
| revision | 是 | integer | 最小: 1.0 |

### FloorContent

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| attribution | 是 | string | 最短: 1; 最长: 2000 |
| images | 是 | array<FloorSectionInput> | 至少项数: 1; 最多项数: 32 |
| kind | 否 | 'floor' | 默认: "floor" |
| label | 是 | string | 最短: 1; 最长: 64 |
| ordinal | 是 | integer | 最小: -20.0; 最大: 200.0 |

### FloorImage

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| height_px | 是 | integer | 大于: 0.0 |
| media_type | 是 | image/png / image/jpeg | — |
| section | 否 | string | 格式: ^[a-z0-9][a-z0-9_-]{0,31}$; 默认: "main" |
| section_label | 否 | string / null | 最短: 1; 最长: 64; — |
| sha256 | 是 | string | 格式: ^[0-9a-f]{64}$ |
| size_bytes | 是 | integer | 大于: 0.0 |
| url | 是 | string | — |
| variant | 是 | labeled / clean | — |
| width_px | 是 | integer | 大于: 0.0 |

### FloorSectionInput

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| section | 否 | string | 格式: ^[a-z0-9][a-z0-9_-]{0,31}$; 默认: "main" |
| section_label | 否 | string / null | 最短: 1; 最长: 64; — |
| upload_id | 否 | string (uuid) / null | —; — |

### FloorTransition

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| description | 是 | string | — |
| from_floor_id | 是 | string (uuid) | — |
| kind | 是 | stairs / elevator | — |
| to_floor_id | 是 | string (uuid) | — |

### FloorUpload

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| id | 是 | string (uuid) | — |
| image | 是 | FloorImage | — |

### GuestSession

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| csrf_token | 是 | string | — |
| expires_at | 是 | string (date-time) | — |

### HTTPValidationError

未知字段：按源模型定义。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| detail | 否 | array<ValidationError> | — |

### Health

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| service | 否 | 'twinnku-api' | 默认: "twinnku-api" |
| status | 是 | ok / not_ready | — |

### Identity

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| authenticated | 是 | boolean | — |
| roles | 是 | array<guest / visitor / contributor / reviewer / analyst / admin> | — |

### Inquiry

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| created_at | 是 | string (date-time) | — |
| id | 是 | string (uuid) | — |
| status | 是 | unresolved / resolved / referred | — |

### InquiryRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| category | 是 | visit_policy / campus_info / content_correction / other | — |
| point_id | 否 | string (uuid) / null | —; — |
| question | 是 | string | 最短: 1; 最长: 2000 |

### InquiryResolution

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expected_revision | 是 | integer | 最小: 1.0 |
| note | 是 | string | 最短: 1; 最长: 2000 |
| official_channel_id | 否 | string (uuid) / null | —; — |
| status | 是 | resolved / referred | — |

### InquiryStats

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| frequent_questions | 是 | array<string> | — |
| period_end | 是 | string (date-time) | — |
| period_start | 是 | string (date-time) | — |
| referred | 是 | integer | 最小: 0.0 |
| total | 是 | integer | 最小: 0.0 |
| unresolved | 是 | integer | 最小: 0.0 |

### MapFeatures

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| map_id | 是 | string (uuid) | — |
| map_revision | 是 | integer | 最小: 1.0 |
| points | 是 | array<PointGeometry> | — |

### MapInfo

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| attribution | 否 | string | 默认: "" |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| coordinate_system | 否 | 'image-pixel-top-left' | 默认: "image-pixel-top-left" |
| height_px | 是 | integer | 大于: 0.0 |
| id | 是 | string (uuid) | — |
| image_asset_id | 是 | string (uuid) | — |
| kind | 是 | campus / floor | — |
| revision | 是 | integer | 最小: 1.0 |
| source_sha256 | 否 | string / null | —; — |
| tiles | 否 | MapTiles / null | —; — |
| title | 是 | string | — |
| width_px | 是 | integer | 大于: 0.0 |

### MapTiles

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| max_native_zoom | 是 | integer | 最小: 0.0; 最大: 16.0 |
| min_zoom | 是 | integer | 最小: 0.0 |
| tile_size | 是 | integer | 最小: 128.0; 最大: 1024.0 |
| url_template | 是 | string | — |

### MediaAccess

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expires_at | 是 | string (date-time) / null | —; — |
| media_id | 是 | string (uuid) | — |
| mode | 是 | same_origin / external | — |
| presentation | 是 | image / audio / document / external_link / iframe | — |
| url | 是 | string | — |

### MediaInfo

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| attribution | 是 | string | — |
| captured_at | 否 | string (date-time) / null | —; — |
| id | 是 | string (uuid) | — |
| kind | 是 | image / panorama / floorplan / audio / document | — |
| point_id | 是 | string (uuid) / null | —; — |
| revision | 是 | integer | 最小: 1.0 |
| title | 是 | string | — |
| visibility | 是 | Visibility | — |

### MediaRegistration

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| external_url | 否 | string / null | —; — |
| kind | 是 | image / panorama / floorplan / audio / document | — |
| point_id | 否 | string (uuid) / null | —; — |
| rights_note | 是 | string | 最短: 1; 最长: 2000 |
| title | 是 | string | 最短: 1; 最长: 200 |
| uploaded_file_id | 否 | string (uuid) / null | —; — |
| visibility | 是 | Visibility | — |

### Meta

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| pagination | 否 | Pagination / null | —; — |
| request_id | 是 | string (uuid) | — |

### Narration

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| audience | 是 | general / school_group / alumni | — |
| audio_asset_id | 是 | string (uuid) / null | —; — |
| id | 是 | string (uuid) | — |
| point_id | 是 | string (uuid) | — |
| revision | 是 | integer | 最小: 1.0 |
| sources | 是 | array<SourceRef> | 至少项数: 1 |
| text | 是 | string | — |
| title | 是 | string | — |

### OfficialChannel

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| description | 是 | string | — |
| id | 是 | string (uuid) | — |
| name | 是 | string | — |
| source | 是 | SourceRef | — |
| url | 是 | string | — |

### Pagination

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| page | 是 | integer | 最小: 1.0 |
| page_size | 是 | integer | 最小: 1.0; 最大: 100.0 |
| total | 是 | integer | 最小: 0.0 |

### Panorama

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| description | 否 | string | 最长: 2000; 默认: "" |
| id | 是 | string (uuid) | — |
| kind | 否 | 'panorama' | 默认: "panorama" |
| point_id | 是 | string (uuid) | — |
| revision | 是 | integer | 最小: 1.0 |
| title | 是 | string | 最短: 1; 最长: 120 |
| url | 是 | string | 最短: 1; 最长: 2048 |

### PanoramaContent

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| description | 否 | string | 最长: 2000; 默认: "" |
| kind | 否 | 'panorama' | 默认: "panorama" |
| title | 是 | string | 最短: 1; 最长: 120 |
| url | 是 | string | 最短: 1; 最长: 2048 |

### Point

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| aliases | 是 | array<string> | — |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| category | 是 | PointCategory | — |
| id | 是 | string (uuid) | — |
| name | 是 | string | 最短: 1; 最长: 120 |
| revision | 是 | integer | 最小: 1.0 |
| summary | 是 | string | 最长: 2000 |
| updated_at | 是 | string (date-time) | — |

### PointCategory

类型：public_area / patriotic / academic / residence / dining / commerce / landscape / history；—。

### PointChange

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| base_revision | 是 | integer | 最小: 1.0 |
| contributor_ids | 是 | array<string (uuid)> | — |
| editor_id | 是 | string (uuid) | — |
| operation | 是 | upsert / retire | — |
| payload | 是 | PointDraftInput / null | —; — |
| review_note | 是 | string | — |
| revision | 是 | integer | 最小: 1.0 |
| state | 是 | draft / in_review / rejected / published / discarded | — |
| submitted_at | 是 | string (date-time) / null | —; — |
| submitted_by | 是 | string (uuid) / null | —; — |
| updated_at | 是 | string (date-time) | — |

### PointDraftInput

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| aliases | 否 | array<string> | 最多项数: 20 |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| category | 是 | PointCategory | — |
| geometry | 是 | PointLocationInput | — |
| name | 是 | string | 最短: 1; 最长: 120 |
| source_note | 是 | string | 最短: 1; 最长: 2000 |
| summary | 是 | string | 最长: 2000 |
| visibility | 是 | Visibility | — |

### PointDraftUpdate

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| aliases | 否 | array<string> | 最多项数: 20 |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| category | 是 | PointCategory | — |
| expected_point_revision | 是 | integer | 最小: 1.0 |
| expected_revision | 是 | integer | 最小: 0.0 |
| geometry | 是 | PointLocationInput | — |
| name | 是 | string | 最短: 1; 最长: 120 |
| source_note | 是 | string | 最短: 1; 最长: 2000 |
| summary | 是 | string | 最长: 2000 |
| visibility | 是 | Visibility | — |

### PointGeometry

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| anchor | 是 | XY | — |
| entrance_ids | 是 | array<string (uuid)> | — |
| label_on_map | 否 | boolean | 默认: false |
| map_id | 是 | string (uuid) | — |
| map_revision | 是 | integer | 最小: 1.0 |
| point_id | 是 | string (uuid) | — |
| polygon | 是 | array<XY> | 至少项数: 3 |

### PointLocationInput

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| anchor | 是 | XY | — |
| label_on_map | 否 | boolean | 默认: true |
| map_id | 是 | string (uuid) | — |
| map_revision | 是 | integer | 最小: 1.0 |
| polygon | 是 | array<XY> | 至少项数: 3; 最多项数: 200 |

### PointRetireRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expected_point_revision | 是 | integer | 最小: 1.0 |
| expected_revision | 是 | integer | 最小: 0.0 |
| note | 是 | string | 最短: 1; 最长: 1000 |

### ResourceChange

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| base_revision | 是 | integer | 最小: 0.0 |
| contributor_ids | 是 | array<string (uuid)> | — |
| operation | 是 | upsert / retire | — |
| payload | 是 | ResourceDraftData / null | —; — |
| review_note | 是 | string | — |
| revision | 是 | integer | 最小: 1.0 |
| state | 是 | draft / in_review / rejected / published / discarded | — |
| submitted_by | 是 | string (uuid) / null | —; — |
| updated_at | 是 | string (date-time) | — |

### ResourceDraftData

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| content | 是 | FloorContent / PanoramaContent | —; — |
| source_note | 是 | string | 最短: 1; 最长: 2000 |

### ResourceDraftSave

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| content | 是 | FloorContent / PanoramaContent | —; — |
| expected_published_revision | 是 | integer | 最小: 0.0 |
| expected_revision | 是 | integer | 最小: 0.0 |
| source_note | 是 | string | 最短: 1; 最长: 2000 |

### ResourceRetireRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expected_published_revision | 是 | integer | 最小: 1.0 |
| expected_revision | 是 | integer | 最小: 0.0 |
| note | 是 | string | 最短: 1; 最长: 1000 |

### ReviewRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| expected_revision | 是 | integer | 最小: 1.0 |
| note | 是 | string | 最短: 1; 最长: 1000 |

### Room

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| entrance_node_ids | 是 | array<string (uuid)> | — |
| floor_id | 是 | string (uuid) | — |
| id | 是 | string (uuid) | — |
| kind | 是 | room / toilet / shower / stairs / elevator / public_space | — |
| name | 否 | string / null | —; — |
| number | 是 | string | 最短: 1; 最长: 32 |
| polygon | 是 | array<XY> | 至少项数: 3 |

### RouteEndpoint

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| id | 是 | string (uuid) | — |
| kind | 是 | point / entrance / room | — |

### RouteRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| accessibility | 否 | standard / step_free | 默认: "standard" |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| departure_at | 否 | string (date-time) / null | —; — |
| end | 是 | RouteEndpoint | — |
| graph_revision | 否 | integer / null | 最小: 1.0; — |
| start | 是 | RouteEndpoint | — |
| via | 否 | array<RouteEndpoint> | 最多项数: 10 |

### RouteResult

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| distance_m | 是 | number / null | 最小: 0.0; — |
| expires_at | 是 | string (date-time) | — |
| graph_revision | 是 | integer | 最小: 1.0 |
| id | 是 | string (uuid) | — |
| segments | 是 | array<RouteSegment> | 至少项数: 1 |
| walking_duration_seconds | 是 | integer / null | 最小: 0.0; — |
| warnings | 是 | array<string> | — |

### RouteSegment

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| distance_m | 是 | number / null | 最小: 0.0; — |
| floor_id | 是 | string (uuid) / null | —; — |
| map_id | 是 | string (uuid) | — |
| map_revision | 是 | integer | 最小: 1.0 |
| path | 是 | array<XY> | 至少项数: 2 |
| transition_after | 否 | FloorTransition / null | —; — |

### SourceDraft

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| id | 是 | string (uuid) | — |
| revision | 是 | integer | 最小: 1.0 |
| status | 是 | ContentStatus | — |

### SourceDraftInput

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| effective_until | 否 | string (date-time) / null | —; — |
| issuer | 是 | string | 最短: 1; 最长: 120 |
| source_url | 否 | string / null | —; — |
| text | 是 | string | 最短: 1; 最长: 100000 |
| title | 是 | string | 最短: 1; 最长: 200 |
| visibility | 是 | Visibility | — |

### SourceDraftUpdate

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| effective_until | 否 | string (date-time) / null | —; — |
| expected_revision | 是 | integer | 最小: 1.0 |
| issuer | 是 | string | 最短: 1; 最长: 120 |
| source_url | 否 | string / null | —; — |
| text | 是 | string | 最短: 1; 最长: 100000 |
| title | 是 | string | 最短: 1; 最长: 200 |
| visibility | 是 | Visibility | — |

### SourceRef

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| effective_until | 否 | string (date-time) / null | 默认: null; —; — |
| id | 是 | string (uuid) | — |
| issuer | 是 | string | — |
| revision | 是 | integer | 最小: 1 |
| title | 是 | string | — |
| url | 否 | string / null | 默认: null; —; — |

### StaffLogin

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| password | 是 | string (password) | 最短: 1; 最长: 128 |
| username | 是 | string | 格式: ^[a-z][a-z0-9._-]{2,63}$ |

### StaffPasswordChange

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| current_password | 是 | string (password) | 最短: 1; 最长: 128 |
| new_password | 是 | string (password) | 最短: 12; 最长: 128 |

### StaffSession

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| csrf_token | 是 | string | — |
| expires_at | 是 | string (date-time) | — |
| permissions | 是 | array<string> | — |
| user | 是 | StaffUser | — |

### StaffUser

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_ids | 是 | array<string> | — |
| created_at | 是 | string (date-time) | — |
| display_name | 是 | string | — |
| id | 是 | string (uuid) | — |
| is_active | 是 | boolean | — |
| must_change_password | 是 | boolean | — |
| point_ids | 是 | array<string (uuid)> | — |
| revision | 是 | integer | 最小: 1.0 |
| role | 是 | admin / reviewer / editor / viewer | — |
| updated_at | 是 | string (date-time) | — |
| username | 是 | string | 格式: ^[a-z][a-z0-9._-]{2,63}$ |

### StaffUserCreate

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_ids | 否 | array<string> | 最多项数: 100 |
| display_name | 是 | string | 最短: 1; 最长: 80 |
| password | 是 | string (password) | 最短: 12; 最长: 128 |
| point_ids | 否 | array<string (uuid)> | 最多项数: 500 |
| role | 是 | admin / reviewer / editor / viewer | — |
| username | 是 | string | 格式: ^[a-z][a-z0-9._-]{2,63}$ |

### StaffUserUpdate

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_ids | 否 | array<string> | 最多项数: 100 |
| display_name | 是 | string | 最短: 1; 最长: 80 |
| expected_revision | 是 | integer | 最小: 1.0 |
| is_active | 是 | boolean | — |
| new_password | 否 | string (password) / null | 最短: 12; 最长: 128; — |
| point_ids | 否 | array<string (uuid)> | 最多项数: 500 |
| role | 是 | admin / reviewer / editor / viewer | — |

### SystemStatus

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| api_version | 否 | 'v1' | 默认: "v1" |
| capabilities | 是 | Capabilities | — |
| service | 否 | 'twinnku-api' | 默认: "twinnku-api" |
| version | 是 | string | — |

### TourAdjustment

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| duration_minutes | 否 | integer / null | 最小: 5.0; 最大: 240.0; — |
| expected_revision | 是 | integer | 最小: 1.0 |
| operation | 是 | shorten / skip / change_theme | — |
| point_id | 否 | string (uuid) / null | —; — |
| theme | 否 | string / null | 最短: 1; 最长: 100; — |

### TourPlan

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| estimated_seconds | 是 | integer / null | 最小: 0.0; — |
| id | 是 | string (uuid) | — |
| mode | 是 | virtual / walking | — |
| revision | 是 | integer | 最小: 1.0 |
| route_id | 是 | string (uuid) / null | —; — |
| sources | 是 | array<SourceRef> | — |
| stops | 是 | array<TourStop> | 至少项数: 1 |
| title | 是 | string | — |
| warnings | 是 | array<string> | — |

### TourPlanRequest

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| audience | 否 | general / school_group / alumni | 默认: "general" |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| duration_minutes | 是 | integer | 最小: 5.0; 最大: 240.0 |
| mode | 是 | virtual / walking | — |
| preferred_point_ids | 否 | array<string (uuid)> | 最多项数: 20 |
| start | 否 | RouteEndpoint / null | —; — |
| theme | 是 | string | 最短: 1; 最长: 100 |

### TourStop

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| estimated_seconds | 是 | integer / null | 最小: 0.0; — |
| learning_prompt | 否 | string / null | —; — |
| narration_id | 是 | string (uuid) / null | —; — |
| point_id | 是 | string (uuid) | — |

### TourTemplate

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| id | 是 | string (uuid) | — |
| point_ids | 是 | array<string (uuid)> | — |
| revision | 是 | integer | 最小: 1.0 |
| theme | 是 | string | — |
| title | 是 | string | — |

### UploadedFile

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| bytes | 是 | integer | 最小: 0.0 |
| id | 是 | string (uuid) | — |
| mime_type | 是 | string | — |
| sha256 | 是 | string | — |

### ValidationError

未知字段：按源模型定义。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| ctx | 否 | object | — |
| input | 否 | object | — |
| loc | 是 | array<string / integer> | — |
| msg | 是 | string | — |
| type | 是 | string | — |

### ViewContext

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| campus_id | 是 | string | 格式: ^[a-z0-9][a-z0-9-]{1,63}$ |
| current_floor_id | 否 | string (uuid) / null | —; — |
| current_map_id | 否 | string (uuid) / null | —; — |
| current_point_id | 否 | string (uuid) / null | —; — |
| mode | 否 | virtual / walking | 默认: "virtual" |
| revision | 是 | integer | 最小: 0.0 |
| tour_plan_id | 否 | string (uuid) / null | —; — |

### Visibility

类型：public / internal / restricted；—。

### XY

未知字段：拒绝。

| 字段 | 必填 | 类型/枚举 | 约束/默认 |
| --- | --- | --- | --- |
| x | 是 | number | 最小: 0.0 |
| y | 是 | number | 最小: 0.0 |

## 4. 重新生成与审核

```bash
python3 scripts/render_api_reference.py
python3 scripts/render_api_reference.py --check
```

新增HTTP接口先修改contracts.py/planned_contract.py或正式router，导出OpenAPI与TS类型，再重新生成本文件。字段变更必须检查旧客户端、权限、迁移、空/错状态。
