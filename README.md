# Twin NKU

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
| [开发协作](CONTRIBUTING.md) | 分支、接口修改、提交与模块接入流程 |

## 当前交付范围

当前交付 **v0.3.0 · 地图与楼层查看**：保留原地图与点位ID，校园点击目录扩为23项；增加楼层读取、已标注/无标注切换、缩放拖动、原尺寸查看、大图模式、楼层分享、双图校验与审核导入。

**素材状态：**已核对飞书前19项、91个楼层目录，第20项排除。图书馆1层的两张整理原图已取得、校验并单独打包，其余90层仍待原文件；不能宣称91层已经上线。实拍照片不上传、不打包、不提供访问接口；Git只含代码和接入清单。楼层模块在真实双图经CLI导入后启用。

校园底图仍为8279×5604，revision 2的265张图块与revision 1逐字节一致，只扩展点击范围。资源生成与导入见 [楼层模块及部署](docs/11-floor-plans.md)，底图历史说明见 [地图模块](docs/10-map-module.md)。

**未实现**：真实AI对话、VR、房间结构化数据、室内/室外路线、语音、员工SSO和后台审核界面。不会用图上文字冒充可交互房间或可行走路径。

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
uv run ruff check . ../../scripts
uv run pytest
uv run python ../../scripts/export_contract.py --check
cd ../web
npm run typecheck
npm run build
```

验证证据及限制见 [VALIDATION.md](VALIDATION.md)。不要提交密钥、密码、数据库备份、未经审核的校园内部图或未获授权的全景资源。
