# 技术规范导航

2026-09-26下午用户要求暂停智能体接入并持续推进其他功能；第一批收藏、最近浏览、搜索与浏览历史恢复见[36持续开发记录](36-continuous-development.md)。本次只更新前端，不重导地图或更改审核数据。

2026-09-26修复：统一使用平台重新提供的Full SDK，保留最新地图坐标校正。平台接口说明失效，后端接入所需替代材料与访问排查见[35](35-nk-genios-api-access.md)；不能通过共享学校登录态解决公众访问问题。

2026-09-25最新增量：[32 小开WebSDK接入与部署](32-nk-genios-web-release.md)、[33 平台完整配置](33-nk-genios-platform-setup.md)。已按用户提供的WebClient协议实现网页嵌入；上下文传参、只读查询与链接入口已具备代码。学校真实SDK/访客/对话仍需上线验收，后端聊天适配与自动动作仍待协议核验。

本轮通过用户已登录的GitHub网页提交至 `feat/admin-console`。部署方按32拉取该分支，并检查最新完整提交的CI；[34 离线提交包](34-offline-delivery.md)仅为备用渠道，已取得远程代码时不要重复导入。

规范版本：`2.0.0`；当前应用版本：`0.4.0`。本规范记录本轮明确的产品方向与实施决策，替代此前未核验的技术计划。接口发生不兼容变化须使用新 API 主版本。

2026-09-24更新：GitHub为代码、部署指导与图片素材的交付渠道。部署方先读[20栋楼完整资源交付](17-floor-release.md)及[后台楼层/VR编辑](18-resource-editor.md)；本轮不重新导入地图。

## 当前冲刺入口

请先读[21全项目需求总纲](21-project-master-spec.md)和[29冲刺工作包](29-sprint-backlog.md)。完整章节22—28覆盖交互、架构/数据、智能体、资源/VR、主题/路线、后台/渠道、质量与比赛；[31](31-api-reference.md)是从机器契约生成的全部端点/字段。

2026-09-24交付为前端精简，部署见[30](30-interface-release.md)，该轮无API/迁移/生产数据变更。本次2026-09-25小开接入另需按32同时更新API和web，并运行只读部署自检。01—20保留已有实施与历史方案，未来任务以21—29最新分期为准：线上主题不依赖未核实步行路网；动作枚举以contracts.py为准；现有员工角色为viewer/editor/reviewer/admin。

## 状态含义

- **已定**：本仓库采用的技术或协议，开发不得自行替换。
- **已实现**：存在运行代码和相应验证证据，范围以 VALIDATION.md 为准。
- **已设计**：字段、错误、权限与验收已规定，运行服务尚未提供该能力。
- **外部待核验**：需要真实材料、平台文档或环境验证，不能写成已完成。

## 已定的关键决策

1. 网页产品，兼容手机与电脑；修订校园规划图为唯一主底图。
2. React/TypeScript/Vite、Leaflet CRS.Simple、FastAPI、PostgreSQL、NetworkX。
3. NK-GeniOS 是首版智能体平台；用户本轮明确提供WebSDK代码并要求接入，先实现独立网页容器。公开WebSDK appKey按平台协议进入浏览器，服务端API密钥和SSO凭据永不进入浏览器。后端API适配器路线保留，协议尚待核验。
4. 模块化单体后端；同域部署；基础版本先部署，然后逐步启用模块。
5. 路径、权限、公开范围、有效内容由业务系统确定；模型只能提出允许的动作。
6. 保留全景与内部楼层查看；首版不做全校三维、实时定位或全校室内导航。
7. 主题导览区分线上参观与线下步行；距离与时长没有校准依据时返回 null。
8. 不把截图中的“运行中”当作本项目已经完成真实 API 调用的证明。

## 阅读顺序

- 产品/内容负责人：21 → 25 → 26 → 29。
- 前端：22 → 24 → 31 → 29；现有坐标约定继续遵守03。
- 后端：23 → 24 → 27 → 31 → 28；现有实现细节继续读15/18。
- 部署负责人：README → 30 → 07 → VALIDATION。

## 规范的唯一来源

| 对象 | 唯一来源 |
| --- | --- |
| DTO 和字段约束 | `apps/api/app/contracts.py` 的 Pydantic 模型 |
| 已实现接口 | `apps/api/app/api.py`、`app/modules/*/router.py`及`app/modules/admin/resources.py` |
| 未实现目标接口 | `apps/api/app/planned_contract.py`，只供契约生成，生产不挂载 |
| 完整机器契约 | 自动生成的 `contracts/openapi.json` |
| 前端接口类型 | 自动生成的 `apps/web/src/shared/api/schema.d.ts` |
| 当前数据库结构 | Alembic 迁移；03 文档中未来表不能冒充已经建表 |
| 业务内容 | 审核后发布的数据库记录；知识库是可重建检索副本 |
| 部署事实 | 实际环境检查与验证记录，绝不从 README 推断 |

接口变更顺序：模型/接口 → 导出 OpenAPI → 生成前端类型 → 实现/测试 → 更新文档。禁止手工修改生成文件后遗漏源模型。

## M01地图交付

新增 [地图模块说明](10-map-module.md)：接口、资产包导入、版本与楼层接入约定。地图交互、受控CLI导入已交付；v0.4.0新增[管理后台](15-admin-console.md)，落地点位编辑审核与独立员工账号，楼层标注原图上传与VR链接编辑现见[18-resource-editor.md](18-resource-editor.md)；SSO、校园底图上传仍未实现。

## M05a 楼层查看

用户要求提前接入楼层资料，当前只交付有标注图查看，完整M05室内路线仍待后续。详见 [11-floor-plans.md](11-floor-plans.md)。本批20栋、96层、100张标注原图全部核对并打包，通过本地全量导入与HTTP字节验收；第20栋已纳入。服务器上线独立验收。

## 2026-09-23地图反馈整改

[13-map-interaction-update.md](13-map-interaction-update.md)记录83个命名点位、周恩来雕像、仅有标注楼层图与资源导入步骤。用户后续否决浮动名称，最新显示与部署要求见[14-restore-map-lettering.md](14-restore-map-lettering.md)：恢复图内原文字，只补随图缩放的雕像标注。M01/M05旧文档中的5/23点位为历史交付数量，本批校园地图revision仍为3。

## v0.4.0 管理后台

[15-admin-console.md](15-admin-console.md)是本次角色、scope、审核状态、会话协议与部署的实施说明。此前计划文档中contributor/SSO相关内容属于后续目标，本次实际角色以该文和机器契约为准。

## 审核后客户端更新修复

[16-publication-sync-fix.md](16-publication-sync-fix.md)记录线上公开数据核对、自动刷新、整体移动点位、发布后公开端核验和前端单独升级步骤。此补丁不修改API契约、数据库或地图素材；仍以提交SHA识别本次前端版本。

## 后台楼层与VR增量

[18-resource-editor.md](18-resource-editor.md)规定新模块的角色/scope、原图上传、分区、独立审核、发布验证与HTTPS链接入口。数据库head为0005_resource_editor。完整原图交付和部署方操作见[17-floor-release.md](17-floor-release.md)。历史双图与19栋数量不再表示当前范围。

## 点位介绍与下一阶段体验

[19-point-introductions.md](19-point-introductions.md)说明83点来源、仅介绍导入、独立审核和前端展示；不修改地图/楼层资产。[20-visitor-experience-plan.md](20-visitor-experience-plan.md)区分本次实际交付与整体UI、AI联动、VR组织、主题参观及试用的后续计划。
