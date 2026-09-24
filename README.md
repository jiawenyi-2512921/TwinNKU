# Twin NKU

**当前交付：**高清校园地图、83个命名地点、分层权限后台，以及新增的“楼层与 VR”资料编辑：标注原图上传/替换、同层分区、来源记录、独立审核发布、下架恢复与公开端更新。本批完整楼层包覆盖 **20栋、96层、100张标注原图**，保持原字节和尺寸。

**给部署方：**使用 `feat/admin-console` 分支，先读[本次完整交付与部署](docs/17-floor-release.md)和[楼层/VR后台操作](docs/18-resource-editor.md)。需要更新API、前端、迁移至0005，并单独导入楼层资源包；不要重导旧地图或覆盖后台点位。首次启用后台仍按[账号初始化](docs/15-admin-console.md)，没有默认密码。本轮未部署用户服务器。

面向公众、校友与研学群体的校园文化 AI 导览服务。以修订校园规划图为入口，逐步连接官方点位资料、全景、楼层、路线与 NK-GeniOS 智能体。

本仓库是唯一开发仓库：**jiawenyi-2512921/TwinNKU**。旧的 `Twin-NKU` 仓库、旧地图重建方案与旧部署结论不作为本项目依据。

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

**未实现**：真实AI对话、VR文件托管/自建播放器、房间结构化数据、室内/室外路线、语音、员工SSO、校园底图网页上传和楼层点位编辑。已实现VR为经审核的外部HTTPS入口。不会用图上文字冒充可交互房间或可行走路径。

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
