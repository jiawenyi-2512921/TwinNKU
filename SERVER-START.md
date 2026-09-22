# Twin NKU 基础版本服务器操作说明

本包包含完整源码、规范、锁文件、数据库迁移和启动脚本，无需依赖 GitHub 上尚未同步的提交。版本范围是 M00：网页、基础 API 和 PostgreSQL；地图、AI、路线等仍关闭。不是已构建的容器镜像，服务器需要从镜像仓库及 npm/PyPI 下载构建依赖。

## 当前状态

- 已完成本地基础应用验证，详见 `VALIDATION.md`。
- 服务器连接在认证前因本执行环境 `Network is unreachable` 失败，服务器未被登录或修改。
- GitHub 连接实际写入返回 403，代码未发布。没有把凭据放入本包。
- 容器构建、实际 PostgreSQL、服务器部署和公网访问均待真实执行。

## 1. 上传并解压

使用云服务器管理控制台/已有 SFTP 客户端，将 `TwinNKU-server-v0.1.0.tar.gz` 上传到服务器一个空的工作目录。进入该目录：

```bash
tar -xzf TwinNKU-server-v0.1.0.tar.gz
cd TwinNKU-server-v0.1.0
```

不要解压到已运行项目的目录。已有 Twin NKU 安装时保留其 `.env` 和数据库卷，按 `docs/07-deployment.md` 更新。

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

端口改动时同步改冒烟测试地址。网页会显示基础站和真实空点位目录；当前不包含未经审核的学校点位和假 AI 回答。

默认地址只有服务器本机可访问；`http://服务器IP:8080` 不能据此认为可打开。公网访问需要将实际域名加入 `.env` 的 `ALLOWED_HOSTS`，并在现有 HTTPS 反向代理中转发至本地端口。示例片段见 `deploy/https-site.conf.example`；不能直接覆盖正在使用的 Nginx 站点配置。没有域名和代理检查结果前，不能声称公网部署完成。

## 5. 回传部署结果

后续继续联调只需要：服务器系统版本、`docker compose ps` 的状态、冒烟成功/失败输出、实际域名（如已有）以及具体报错。不要回传 `.env`、数据库密码、完整环境变量或原始个人咨询数据。

GitHub 写入权限恢复后，补发当前源码提交，并按模块计划继续开发。服务器 SSH 连接不等于 GitHub 接口有写权限，两个状态分别验证。
