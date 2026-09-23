# Twin NKU 基础版本服务器操作说明

当前版本v0.2.0已增加地图交互模块。首次启动仍先构建前后端、迁移数据库；地图需要单独导入随交付提供的资源包。**仅更新代码不会自动发布地图内容。**

地图模块的资源包、审核导入命令、数据卷与回退见 [docs/10-map-module.md](docs/10-map-module.md)。实际验证与环境限制以 [VALIDATION.md](VALIDATION.md) 为准；本轮不登录或部署服务器。

## 1. 获取源码

优先从当前唯一仓库获取已经核对的交付分支/提交源码（未合并PR时不要直接部署旧main）：

```bash
git clone --branch feat/campus-map-m01 https://github.com/jiawenyi-2512921/TwinNKU.git
cd TwinNKU
git log -1 --oneline
```

先核对交付消息中的提交，再部署。已有本地目录时，不直接覆盖或强制重置。

## 2. 检查服务器条件

需要 Linux、Docker Engine、Compose v2（支持 `up --wait`）和 Python 3。检查：

```bash
docker version
docker compose version
python3 --version
df -h .
```

若 Docker 未安装，应按实际操作系统使用 Docker 官方安装说明；本包不猜测发行版或自动变更宿主机。首次运行需具备拉取镜像及依赖的网络条件。建议先确认内存/磁盘足以容纳现有服务和构建；本版本尚无真实服务器资源基线。

## 3. 首次启动

```bash
bash scripts/first-run.sh
```

默认使用空闲的 `127.0.0.1:8080`。端口被占用时：

```bash
bash scripts/first-run.sh --port 18080
```

脚本自动在服务器生成数据库密码并只写到权限 600 的 `.env`。它不读取 SSH 密码，不覆盖已有 `.env`，不删除数据卷，不替换宿主机反向代理。

如需要添加已经确定的实际域名，可传 `--host`，例如 `bash scripts/first-run.sh --host your-approved-domain.example`。请替换示例域名。此参数仅设置主机名白名单。

启动过程包括镜像构建、PostgreSQL 健康检查、Alembic 迁移、校园元数据初始化、前后端健康检查和 HTTP 冒烟。终端出现所有 `PASS` 后，才可将服务器本地基础服务标记为通过。若构建失败，`.env` 已保留，修复错误后运行 `bash scripts/deploy.sh`；改过端口则传入相应 URL，例如 `bash scripts/deploy.sh http://127.0.0.1:18080`。不要删除 `.env` 来重新生成数据库密码。

## 4. 查看运行结果

```bash
docker compose ps
python3 scripts/smoke.py http://127.0.0.1:8080
```

端口改动时同步改冒烟测试地址。未导入地图时，网页显示地图待准备及已公开点位目录；完成资源包审核导入后显示地图。AI、VR、真实路线和楼层资料不因地图启用而自动开放。

默认地址只有服务器本机可访问；`http://服务器IP:8080` 不能据此认为可打开。公网访问需要将实际域名加入 `.env` 的 `ALLOWED_HOSTS`，并在现有 HTTPS 反向代理中转发至本地端口。示例片段见 `deploy/https-site.conf.example`；不能直接覆盖正在使用的 Nginx 站点配置。没有域名和代理检查结果前，不能声称公网部署完成。

## 5. 回传部署结果

后续继续联调只需要：服务器系统版本、`docker compose ps` 的状态、冒烟成功/失败输出、实际域名（如已有）以及具体报错。不要回传 `.env`、数据库密码、完整环境变量或原始个人咨询数据。

后续由 Codex 按模块计划继续开发并同步 GitHub，用户与 DeepSeek 部署明确的提交版本。GitHub 网页提交、API 连接权限、服务器部署分别记录和验证。
