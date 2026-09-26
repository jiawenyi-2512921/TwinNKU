# Twin NKU

**2026-09-26 持续开发：**按用户要求暂停智能体接入，新增地点收藏、最近浏览、名称/别名优先搜索、浏览器返回恢复地点与楼层、楼层/分区链接复制。此增量只需更新前端；开发记录、部署与验收见[36持续开发](docs/36-continuous-development.md)。收藏记录仅存当前浏览器，不能作为真实试用成效统计。

同日第二批补齐公共资料JSON请求15秒超时和取消清理，修复楼层/全景列表在网络挂起时可能一直加载的问题；前端61项回归与生产构建通过。楼层原图、外部全景网页及真实手机网络体验仍需单独验收。

**2026-09-25 小开接入：**已实现 NK-GeniOS WebSDK 独立聊天面板、点位/楼层提问入口、公开上下文开关、只读校园插件、导览链接与知识导出脚本。部署需同时更新 API 和 web，见 [32接入部署](docs/32-nk-genios-web-release.md)；你在平台需要配置的知识库、提示词、六个工具、十个变量与评测见 [33完整操作清单](docs/33-nk-genios-platform-setup.md)。真实学校平台联调、访客访问和手机视觉待部署验收；后端聊天API/自动动作仍未实现。

**2026-09-26 修复：**按平台重新提供的代码统一恢复 Full SDK，补充防止误切Lite的测试，保留最近地图坐标校正。平台“接口说明”失效时的接入办法、凭据区别及校方确认清单见 [35 API与访问排查](docs/35-nk-genios-api-access.md)。代码修复不等于校外访问权限或服务器部署已经完成。

**当前交付：**高清校园地图、83个命名地点、分层权限后台，以及新增的“楼层与 VR”资料编辑：标注原图上传/替换、同层分区、来源记录、独立审核发布、下架恢复与公开端更新。本批完整楼层包覆盖 **20栋、96层、100张标注原图**，保持原字节和尺寸。

**基础楼层/后台版部署：**使用 `feat/admin-console` 分支，先读[本次完整交付与部署](docs/17-floor-release.md)和[楼层/VR后台操作](docs/18-resource-editor.md)。需要更新API、前端、迁移至0005，并单独导入楼层资源包；不要重导旧地图或覆盖后台点位。首次启用后台仍按[账号初始化](docs/15-admin-console.md)，没有默认密码。本轮未部署用户服务器。

**2026-09-24介绍增量：**新增[83点介绍初稿与安全导入](docs/19-point-introductions.md)、正文分段与折叠来源；仅补介绍，保留后台地图修正。已运行楼层/VR版的站点按新文档更新前端并导入审核，无新增迁移。早期体验建议见[体验规划](docs/20-visitor-experience-plan.md)。

面向公众、校友与研学群体的校园文化 AI 导览服务。以修订校园规划图为入口，逐步连接官方点位资料、全景、楼层、路线与 NK-GeniOS 智能体。

本仓库是唯一开发仓库：**jiawenyi-2512921/TwinNKU**。旧的 `Twin-NKU` 仓库、旧地图重建方案与旧部署结论不作为本项目依据。

## 2026-09-24：界面精简与完整冲刺规范

该轮已实现地图主界面、按需目录、单地点面板、真实资源入口和直达楼层大图。该轮仅更新前端，无新增数据库迁移，不重导地图，见[30界面交付](docs/30-interface-release.md)。**本次小开接入需按32同时更新API和web**；真机视觉验收尚须部署后完成。

全项目高标准需求与执行细节从[21总纲](docs/21-project-master-spec.md)开始：

| 文档 | 内容 |
| --- | --- |
| [21 全项目需求总纲](docs/21-project-master-spec.md) | 用户、范围、逐项需求ID、P0—P3、发布门槛 |
| [22 交互与界面](docs/22-experience-and-interface.md) | 每种状态、响应式布局、焦点、URL、空/错/加载 |
| [23 架构与数据](docs/23-architecture-and-data.md) | 技术栈、表/约束、版本、outbox、worker、容量与ADR |
| [24 智能体实施](docs/24-agent-implementation.md) | 平台证据、检索、引用、会话、SSE、动作、取消与失败 |
| [25 资源与VR](docs/25-resources-and-vr.md) | 原图保真、楼层分区、场景台账、多点关联、内容质检 |
| [26 主题与路线](docs/26-tours-learning-and-routing.md) | 线上编排、进度、观察任务、回顾、实测路网边界 |
| [27 后台与运营](docs/27-admin-operations-and-channels.md) | 权限、审核、知识同步、咨询缺口、渠道与数据保留 |
| [28 质量与比赛](docs/28-quality-evaluation-and-contest.md) | 100题评测、真实试用、性能、回归、证据与材料 |
| [29 冲刺工作包](docs/29-sprint-backlog.md) | 逐任务依赖/实现/交付/验收/责任角色、里程碑与扩展 |
| [30 本轮部署](docs/30-interface-release.md) | 只更新web、保留生产数据、真机检查与回退 |
| [31 完整接口与字段](docs/31-api-reference.md) | 自动生成82项操作及全部DTO；46已实现、36计划 |
| [32 小开嵌入部署](docs/32-nk-genios-web-release.md) | SDK实现、运行开关、CSP、部署、验收与回退 |
| [33 NK-GeniOS配置](docs/33-nk-genios-platform-setup.md) | 提示词、知识库、插件、变量、发布与100题评测 |
| [34 离线提交包备用](docs/34-offline-delivery.md) | 离线bundle导入与CI验证；已从远程取得代码时无需导入 |
| [35 API与访问排查](docs/35-nk-genios-api-access.md) | 文档失效替代材料、凭据边界、学校访问策略与后端接入门槛 |
| [36 持续开发记录](docs/36-continuous-development.md) | 非智能体迭代、收藏/最近浏览、导航恢复、验收与下一任务 |

部署后可运行 `python3 scripts/check_nk_genios.py --base-url https://2512921.cn --expect-enabled`，只读检查嵌入配置、页面与CSP、校园插件接口；不输出凭据。完整参数及平台真实问答验收见32。

**规格不等于功能完成。** WebSDK接入本轮已提供实现与配套文件，真实平台联调仍须执行；后端AI会话、自动动作、主题研学、咨询闭环等继续按工作包推进。GitHub作为交付渠道，用户/DeepSeek执行部署；不把写好方案说成已经上线。

## 先阅读规范

| 文档 | 内容 |
| --- | --- |
| [规范导航](docs/README.md) | 决策状态、阅读顺序、实施证据 |
| [产品范围](docs/01-product-scope.md) | 目标、边界、用户流程与验收 |
| [技术栈与架构](docs/02-stack-and-architecture.md) | 版本策略、模块职责、目录、数据流 |
| [数据模型](docs/03-data-model.md) | ID、字段、坐标、路网、版本、权限 |
| [HTTP 接口规范](docs/04-http-api.md) | 全部端点、输入输出、错误、并发和兼容规则 |
| [智能体与前端动作](docs/05-agent-protocol.md) | NK-GeniOS 适配、SSE、动作白名单、上下文 |
| [分模块实施](docs/06-module-plan.md) | 依赖顺序、文件归属、每阶段交付和验收 |
| [部署运维](docs/07-deployment.md) | 本地启动、服务器首发、HTTPS、备份、回滚 |
| [质量与安全](docs/08-quality-and-security.md) | 自动化验证、人工验收、权限、内容边界 |
| [素材与内容交付](docs/09-content-handoff.md) | 宣传部材料、地图/VR/楼层数据格式 |
| [20栋楼完整资源与部署](docs/17-floor-release.md) | 20栋96层100图、原图校验、部署与保护既有地图编辑 |
| [后台楼层与VR编辑](docs/18-resource-editor.md) | 上传、分区、审核、发布、权限、接口与存储 |
| [开发协作](CONTRIBUTING.md) | 分支、接口修改、提交与模块接入流程 |

## 当前交付范围

管理后台详细规范见 [15-admin-console.md](docs/15-admin-console.md)，覆盖角色矩阵、坐标、状态流、已实现接口、初始化、升级和关闭流程。账号权限在后端强制执行；已发布内容不受草稿修改影响。

当前交付 **地图交互与标注楼层查看**：保留原点位ID，83个命名地点可点击；无未命名点击区域；保留两座业务楼正中央的周恩来雕像。取消常驻浮动名称与排序序号，名称恢复为原规划图文字的显示方式；雕像标注与地图同步缩放。楼层提供缩放、拖动、原尺寸、大图和分享，只显示有标注图。

**素材状态：**20栋全部纳入，包括第20项综合实验楼C区。96层100图已接收、人工核对并完成本地全量导入与HTTP原字节校验。体育馆同层A/B/C图合为分区；图书馆没有6层资料。只交付标注图，不含实拍/无标注图。清单、摘要、来源和验收命令见[楼层规范](docs/11-floor-plans.md)。GitHub资源包交付不等于服务器已经导入。

校园底图仍为8279×5604，revision 3的265张图块与旧版逐字节一致；原有文字保留在图中，仅雕像名称使用与图像等比例的SVG文字补充，不改写底图。导入与验收见[当前交付说明](docs/14-restore-map-lettering.md)。

**未实现**：后端AI会话/SSE与自动动作、VR文件托管/自建播放器、房间结构化数据、室内/室外路线、语音、员工SSO、校园底图网页上传和楼层点位编辑。WebSDK聊天容器已实现但真实平台联调待验收；已实现VR为经审核的外部HTTPS入口。不会用图上文字冒充可交互房间或可行走路径。

`contracts/openapi.json` 描述全部目标接口；每个 operation 有 `x-implementation-status` 和 `x-module`。运行中的 `/openapi.json` 只列出已经实现的接口。**有契约不等于有实现。**

## 本地运行

环境：Node.js 24 LTS、Python 3.12、uv。生产数据库是 PostgreSQL 17；本地与快速测试可使用 SQLite，不能据此宣称完成 PostgreSQL 验证。

```bash
cd apps/api
uv sync --frozen
uv run alembic upgrade head
uv run python -m app.seed
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

另开一个终端：

```bash
cd apps/web
npm ci
npm run dev -- --host 127.0.0.1
```

打开 `http://127.0.0.1:5173`；Vite 将 `/api`、`/health` 代理至后端。API 文档：`http://127.0.0.1:8000/docs`。

## 一台服务器部署

首次安装，服务器已具备 Docker Engine、Compose v2 和 Python 3 时：

```bash
bash scripts/first-run.sh
```

脚本检查已有 Twin NKU 容器/数据卷和端口，在服务器生成权限 600 的 `.env` 与随机数据库密码，再构建、迁移并运行冒烟。已有 `.env` 时不会覆盖；更新使用 `bash scripts/deploy.sh`。详见 [部署运维](docs/07-deployment.md)；随源码交付包提供 [服务器操作说明](SERVER-START.md)。

默认只监听服务器 `127.0.0.1:8080`，通过已有 HTTPS 反向代理对外提供服务。公网域名、证书、服务器连接与实际部署状态需单独核实。

## 验证

```bash
cd apps/api
uv run ruff check --config pyproject.toml . ../../scripts
uv run pytest
uv run python ../../scripts/export_contract.py --check
cd ../web
npm run typecheck
npm run build
```

验证证据及限制见 [VALIDATION.md](VALIDATION.md)。不要提交密钥、密码、数据库备份、未经审核的校园内部图或未获授权的全景资源。
