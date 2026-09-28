# 39 · 比赛用后端问答部署

适用：已经运行 TwinNKU、已有「问小开」入口的 Docker Compose 服务器。本次通过独立后端调用学校应用 API，复用现有前端窗口；密钥留在服务器。

代码已完成本地 11 项协议/边界测试。学校应用 API 已在服务器实测连通：`/agent-demo/health` 返回 `{"ok": true, "mode": "private-demo"}`，登录、Cookie 与真实问答全链路可用。此前 `Network is unreachable` 的出口问题已由学校平台侧恢复。

> **注意**：普通整站部署会重建 web 容器，从而丢掉演示入口的 Nginx 挂载。部署后 `/agent-demo/health` 会返回主站 `index.html` 而不是 JSON —— 这是演示入口失效的特征。恢复方法见文末「演示入口被普通部署覆盖后如何恢复」。

## 从 GitHub 获取代码

分支固定为 `feat/admin-console`。建议在服务器另取一份代码用于执行本补丁，保留正在运行的项目目录与 `.env`：

```bash
git clone --branch feat/admin-console --single-branch \
  https://github.com/jiawenyi-2512921/TwinNKU.git TwinNKU-agent-release
cd TwinNKU-agent-release
git rev-parse HEAD
sudo python3 tools/agent-demo/deploy.py
```

若 `TwinNKU-agent-release` 已存在，先查看其中的 `git status --short`，确认没有本地修改，再运行 `git pull --ff-only origin feat/admin-console`。不要覆盖生产项目的 `.env`，不要使用强制 reset 或清空数据的命令。

脚本需要主机 Python 3.8+、Docker Compose v2，以及已有 web/api 容器。演示容器复用正在运行的 API 镜像中的 Python 3.12/Pydantic，无需新安装运行依赖。主机 Python 3.8 仅做了语法兼容设计，本地执行验证环境是 Python 3.12。

## 输入与执行过程

1. 隐藏输入学校**应用 API 密钥**。不要输入 SSH 密码或校园统一认证密码，不要把密钥写进命令参数。
2. 设置至少 16 位的演示口令，或直接回车生成随机口令。口令只用于此次演示入口。
3. 脚本检查当前 Compose 文件与运行配置是否一致、web/api 网络及已有入口，然后验证学校 API 的真实两轮问答。
4. 通过后备份 Nginx 和当前镜像信息，启动独立演示服务，再从实际容器测试学校 API，确认出口连通。
5. Nginx 配置检查通过后才重建 web，检查同域演示路由。网页可能短暂中断；失败时尝试自动恢复。

API 测试包括创建两个测试会话、发送四条连通性问题，会消耗平台额度。脚本不重启业务 API 或数据库，不运行迁移/seed，不导入地图楼层或审核内容。

默认参数：项目 `twinnku`，站点 `https://2512921.cn`，状态目录 `/opt/twinnku-agent-demo`。若实际配置不同：

```bash
sudo python3 tools/agent-demo/deploy.py \
  --project twinnku \
  --origin https://2512921.cn \
  --state-dir /opt/twinnku-agent-demo
```

来源必须与浏览器地址一致；带 `www` 与不带 `www` 是两个来源。已存在的状态目录不会覆盖。

## 部署后验收

打开网站并刷新「问小开」，输入演示口令，完成真实问题和连续追问。另开隐私窗口测试另一访客，确认会话不串用。再验证地图、地点、楼层图和 VR 入口。

`/agent-demo/health` 只表示演示服务存活。页面能打开、脚本通过、GitHub CI 成功都不能代替真实回答和两个访客的验收。当前为文字问答演示，不承诺流式回答、自动地图动作或完整生产聊天能力。

应用密钥与口令仅保存在服务器状态目录的 `demo.env`（600 权限，父目录 700）。不要将状态目录、完整 `docker inspect` / `docker compose config` 输出提交到 GitHub。

## 回退

从上述代码目录执行：

```bash
sudo python3 tools/agent-demo/deploy.py --rollback
```

使用自定义状态目录时，带上相同的 `--state-dir`。回退恢复原嵌入页配置与 web 镜像，停止独立演示服务，保留备份与原数据库。请勿使用 `docker compose down -v`。

此方案采用额外 Compose 覆盖文件。后续仅按原 Compose 配置重建 web 会回到原 WebSDK 页面；比赛前不要再执行普通整站部署。正式整合到主后端是下一阶段工作。

## 学校 API 不可用时

浏览器已为后端可发出的全部错误码提供中文说明，页面会直接指出故障类别，不再统一显示「暂时无法取得回答」。常见几类：

- `SSO_REDIRECT`：应用 API 仍被统一认证拦截，联系学校平台管理员开放应用调用权限。共享个人登录 Cookie 不能作为公众接入方案。
- `AUTH_FAILED` / `ACCESS_DENIED` / `ENDPOINT_NOT_FOUND`：核实应用 API 密钥、发布与授权、网关地址。
- `NETWORK_ERROR` / `NETWORK_TIMEOUT` / `TLS_ERROR`：检查服务器出口与学校平台连通性。
- `NO_FINAL_ANSWER`：上游未给出合格回答（超时或空响应），换问法重试。
- `INVALID_REQUEST` / `INTERNAL_ERROR`：请求参数不合规或演示服务内部异常，刷新页面重试；`INTERNAL_ERROR` 持续出现需查服务端日志。
- `Compose settings differ…`：现有文件/环境与运行配置不一致，先由维护者核对；脚本不会猜测或替换现有配置。

前端错误码与后端保持同步由 `tools/agent-demo/test_demo.py::test_every_backend_error_code_is_mapped_in_the_browser` 强制保证：新增后端错误码而未补前端文案时该测试会失败。

失败时旧页面保持或恢复。比赛备用入口：[学校官方小开对话页](https://coze.nankai.edu.cn/product/llm/chat/dar5kpl4shh989l2lhr0)，需按学校要求登录；此前已取得真实回答，但不表示本站后端已接通。

## 演示入口被普通部署覆盖后如何恢复

普通整站部署（`scripts/deploy.sh`）会重建 web 容器，容器内的 `/etc/nginx/nginx.conf` 回到镜像原版，演示路由随之消失。演示服务容器本身仍在运行，因此不要重新执行安装器（状态目录已存在会拒绝）。

判断是否失效：

```bash
curl -s https://2512921.cn/agent-demo/health     # 失效时返回 index.html，而不是 {"ok": true, ...}
docker exec twinnku-web-1 grep -c agent-demo /etc/nginx/nginx.conf   # 失效时输出 0
```

恢复步骤（不需要重新输入密钥或口令）：

```bash
cd /root/TwinNKU
# 1. 从新镜像取出当前 nginx 配置，确认其与安装时备份一致
docker cp twinnku-web-1:/etc/nginx/nginx.conf /tmp/nginx.current.conf
diff /tmp/nginx.current.conf /opt/twinnku-agent-demo/nginx.original.conf

# 2. 用安装器的同一函数重新生成演示配置，避免手工编辑出错
python3 - <<'EOF'
import sys
sys.path.insert(0, "/root/TwinNKU/tools/agent-demo")
sys.path.insert(0, "/root/TwinNKU/scripts")
from deploy import patch_nginx
src = open("/opt/twinnku-agent-demo/nginx.original.conf").read()
patched = patch_nginx(src)
assert patched != src and "agent-demo" in patched
open("/opt/twinnku-agent-demo/nginx.demo.conf", "w").write(patched)
EOF

# 3. 必须同时给出 compose.yaml 与覆盖文件，否则 compose 会当成独立项目另建一套容器
docker compose --env-file .env \
  -f compose.yaml -f /opt/twinnku-agent-demo/compose.demo.json \
  up -d --no-deps --no-build --pull never web

# 4. 验收
docker exec twinnku-web-1 grep -c agent-demo /etc/nginx/nginx.conf   # 应为 3
curl -s https://2512921.cn/agent-demo/health                         # 应为 {"ok": true, ...}
```

第 3 步若漏掉 `-f compose.yaml`，compose 会把覆盖文件当作独立项目，另建 `twinnku-agent-demo-web-1` 与同名网络，而演示路由不会挂到真正对外的 `twinnku-web-1` 上。误建后可清理：`docker rm -f twinnku-agent-demo-web-1 && docker network rm twinnku-agent-demo_default`。

完整限制、服务接口、测试和脚本行为见 [演示模块 README](../tools/agent-demo/README.md)，访问证据与正式 API 文档见 [38 访问诊断](38-nk-genios-access-diagnosis.md)。
