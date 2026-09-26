# 后台楼层与VR编辑 · 实施说明

2026-09-24；分支 `feat/admin-console`；迁移 `0005_resource_editor`。本模块补齐“后台录入 → 原图/链接预览 → 独立审核 → 公开查看”，复用既有员工账号、点位scope和审计。当前支持外部HTTPS全景入口，不把链接表单描述成自建VR播放器或全景素材托管。

## 操作路径

1. `/admin`登录后进入“楼层与 VR”，按建筑名称查找。列表只包含当前成员有权管理的点位。2026-09-26补齐每页20项的上一页/下一页和总数，搜索变化回到第一页，加载失败可重试；不再将目录截在前50项。翻页/搜索仅浏览候选建筑，不清空正在编辑的资料；真正选择另一建筑仍检查未保存修改。
2. 楼层可新增、修改名称/来源、替换原图、增加/移除同层分区。已有楼层不能改层号或移到另一栋楼；选错建筑应撤回新增草稿并重新新增。
3. 图片限静态PNG/JPEG，每张≤32 MiB、≤4000万像素、单边≤20000。保留文件原字节；不做裁切、压缩、旋转或去字。编辑者须选择已标注图，程序不能自动证明文件内容是标注图。
4. 上传后可缩放、拖动、按原尺寸查看和新窗口打开原图。上传完成不等于已经公开；继续填写资料依据并保存草稿。
5. VR资料填写名称、HTTPS分享链接和说明，保存后可以预览链接。该链接需由审核人实际打开核对，不通过服务器自动请求、抓取或截图。
6. 填写操作说明，提交审核。审核人员在“查看待审核资料”中查看原图/分区/来源或全景链接，选择通过并发布/退回修改。
7. 已发布内容可申请下架，经审核后公开端隐藏；历史记录与原图保留，可重新编辑提交恢复。已发布楼层替换会增加revision；旧版图片URL不再公开读取。
8. 后台发布成功后回读公开列表，核对资源ID和revision（下架则核对已不存在）。失败会明确提示“后台发布已完成，公开端核验未通过”，不将前端读取错误伪装成发布回滚。

公开建筑详情显示已审核VR链接，点击新窗口进入；没有资料显示空状态。楼层和VR面板可见时每30秒检查、重新聚焦或返回页面立即刷新；普通访客无需重新登录。楼层图片未变化时不重置缩放。

后台列表读取在取消后忽略迟到成功结果，避免快速搜索/翻页时旧列表覆盖新列表；清空读取目标同时清除加载状态。此修复没有自动重试上传、保存、审核或发布写入；权限与scope继续由服务器检查。上线后使用有50项以上权限的账号翻到后页、搜索再清空、模拟列表读取失败并重试，核对草稿仍保留；窄屏分页控件与真实账号操作尚需人工验收。

## 权限和状态

| 角色 | 读取/预览获授权资料 | 上传/保存/提交 | 发布/退回 | 账号与scope |
|---|---|---|---|---|
| viewer | 是 | 否 | 否 | 否 |
| editor | 是 | 是 | 否 | 否 |
| reviewer | 是 | 否 | 是 | 否 |
| admin | 是 | 是 | 是，但禁止自审 | 是 |

范围沿用points.read / points.edit / points.review及校园、指定点位授权。前端按钮仅辅助操作，后端逐请求检查。未登录401，权限不足403，不在scope内404。

草稿状态：draft → in_review → published或rejected；退回后可编辑重提；编辑者可撤回参与过的草稿，管理员可撤回范围内草稿。上传者、任何本轮编辑贡献者、提交者均不可审核本轮资料，管理员也不例外。下架申请同样独立审核，不提供硬删除。

写入要求同源Origin、HttpOnly员工会话及X-CSRF-Token。会话失效沿用后台重新登录提示；强制改密/停用/撤销规则不变。

## 实际接口

前缀 `/api/v1`；JSON响应统一Envelope。所有ID为UUID；POST/PUT均需X-CSRF-Token。完整字段约束见生成的OpenAPI，泛化media/upload/SSO等planned端点仍未实现。

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | `/admin/points/{point_id}/floor-images` | 原始PNG/JPEG请求体，Content-Type须匹配真实文件；返回201 FloorUpload |
| GET | `/admin/floor-images/{upload_id}` | 会话+scope私有预览，不提供公开直链 |
| GET | `/admin/resources?point_id=…&state=in_review&page=1&page_size=50` | scope内资料及草稿，分页上限100；state可draft/in_review/rejected |
| GET | `/admin/resources/{resource_id}` | 正式内容、待审核内容、revision、贡献者、原图预览URL |
| POST | `/admin/points/{point_id}/resources` | 新增floor或panorama草稿 |
| PUT | `/admin/resources/{resource_id}` | 修改草稿；已有类型及楼层绑定不可改 |
| GET | `/admin/resources/{resource_id}/images/{draft_revision}/{section}` | 草稿原图；revision=0预览正式图；过期草稿拒绝 |
| POST | `/admin/resources/{resource_id}/review/{action}` | action为submit/publish/reject/discard |
| POST | `/admin/resources/{resource_id}/retire` | 已发布资料下架申请；需独立审核 |
| GET | `/points/{point_id}/panoramas` | 公开已审核VR列表；所属建筑/校园必须公开有效 |

楼层保存示例（upload_id由真实上传返回；此处使用占位UUID，不是生产数据）：

```json
{
  "expected_revision": 0,
  "expected_published_revision": 0,
  "source_note": "资料提供者与本次改动依据",
  "content": {
    "kind": "floor",
    "label": "一层",
    "ordinal": 1,
    "attribution": "资料来源及允许展示范围",
    "images": [
      {"section": "a", "section_label": "A区", "upload_id": "00000000-0000-0000-0000-000000000001"}
    ]
  }
}
```

images共1—32项，section默认main；命名分区需非空section_label；每层分区键唯一。upload_id为空表示复用该正式楼层同section的已发布原图；新层/新分区不能缺图。上传记录绑定建筑，不能跨建筑引用，不接受客户端文件路径/任意图URL。

VR保存使用同样并发字段及source_note，content为 `{kind:"panorama",title,url,description}`。URL须HTTPS默认443、无账号密码、无空白/控制字符，不接受localhost、明显内网IP或非公开域名。这里只校验链接语法，未验证最终跳转、可访问性或内容真实性；审核人核对实际目标。前台noopener/noreferrer新窗口打开，不注入iframe，不放宽站点CSP。

操作请求：`{expected_revision,note}`；下架另需expected_published_revision。楼层正式revision与草稿revision独立；被别人修改、被CLI导入更新或状态不符返回409，不能覆盖较新内容。未保存修改切换页面会提示，上传/保存期间禁用本页切换操作。

## 存储、事务与审计

- floor_uploads保存UUID、所属点位、上传者、原图尺寸/格式/字节数/SHA256/私有文件名；原文件在floor_assets/.uploads/UUID。
- resource_changes保存当前草稿及贡献者、审核状态、base_revision、operation、操作说明和时间；SQLAlchemy版本检查防丢更新。
- panoramas保存正式标题、HTTPS URL、说明、revision、published/retired状态。公开读取附带父建筑及校园发布检查。
- 新文件按块读取，超过32 MiB即413；非法类型415；损坏图片/像素超限/旋转待核对422。临时文件失败会清理，不注册半张图片。
- 草稿读取与审核原件通过认证接口，不暴露卷目录。preview为no-store；全站nosniff。图片尺寸与摘要从文件得到，客户端无权声明。
- floor发布复用既有不可变资源导入器，再提交数据库事务及审计；所有同建筑资源写入/CLI导入获取建筑行锁。发布原子影响楼层/楼层map记录，不更新校园点位和点击几何。
- 审计记录上传、保存、提交、退回、撤回、正式发布/下架及前后内容。历史数据库记录不删除；磁盘旧版字节不覆盖。
- API的floor_assets可写；map_assets及容器根文件系统保持只读。操作系统文件权限需允许容器UID10001写floor_assets。
- 当前没有自动孤儿文件清理、总存储配额、实时恶意链接检测或图片内容自动审查；备份数据库与整个floor_assets，运维定期核对磁盘空间。

## 部署与范围

按 [17-floor-release.md](17-floor-release.md)更新API、前端、迁移与上传反代大小限制；ADMIN_ENABLED沿用原配置。FLOORS_ENABLED控制楼层公开读取，VR_ENABLED控制公开VR入口，ADMIN_ENABLED控制后台。资料保留以便重新启用。

本功能不包含校园底图网页替换、原图文字擦除、楼层房间选点/路网、VR文件托管、SSO或真实AI问答。已有地图点位编辑、审核和周恩来雕像标注继续使用原功能。下一步可在实际楼层图上逐步建立结构化房间资料，但不能将图上文字直接当成已核实导航节点。
