# 开发与模块协作

## 开发与部署分工

按用户最新约定，Codex负责开发、接口和文档维护、本地验证及GitHub同步；用户与DeepSeek负责服务器部署。每次交付应给出已经核实的GitHub提交/分支链接、实际验证结果、需要执行的迁移和部署步骤。服务器凭据不进入仓库。首次部署参考 `SERVER-START.md`，更新和回滚参考 `docs/07-deployment.md`。

仓库写入受连接授权限制时，保留本地成果并报告真实错误；只有远端引用与文件核实成功，才可称为“已上传”。部署方也应回传健康检查与实际访问结果后才标记“已部署”。

## 开发规则

1. 唯一仓库为 TwinNKU，默认分支main；日常开发用 `feat/m01-map` 等短分支。
2. 开工前读对应规范与模块验收，不能复用已废弃地图重建目标。
3. API变更先改Pydantic模型/路由，生成OpenAPI，再生成TypeScript类型；前端不得手写另一份DTO。
4. 只提交对应模块必要的文件。大图、原始楼层、密钥、数据库和构建产物不入Git。
5. 数据库变更必须Alembic迁移并验证升级；迁移不能在生产启动时自动删除业务数据。
6. 保持已有接口operation_id；planned→implemented时移除重复计划路由并更新能力状态。
7. PR说明业务问题、改动后的行为、验证与已知限制。未真实调用第三方或部署时直说。
8. 合并前检查后端测试、构建、契约漂移。涉及权限、路线、发布状态应有相应测试；样式变更用构建和视觉检查。

## 契约更新命令

```bash
cd apps/api
uv sync --frozen
uv run python ../../scripts/export_contract.py
cd ../web
npm ci
npm run generate:api
npm run typecheck
```

## 版本与完成状态

基础应用SemVer，HTTP主版本使用路径 `/api/v1`。每个模块交付同步修改VALIDATION.md与对应文档。不能仅勾选TODO就写“已测试”。

## 外部依赖

NK-GeniOS需要实际管理页的API调用说明；员工SSO、外部VR控制也需要真实接口资料。未知项集中记录，使用适配器隔离，不猜协议。不向聊天、Git提交或截图索要/暴露完整密钥。
