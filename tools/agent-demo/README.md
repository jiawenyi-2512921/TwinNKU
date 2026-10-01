# TwinNKU 比赛演示后端接入

这是一套独立、可回退的文字问答演示补丁：复用网站已有「问小开」窗口，经自己的后端调用学校应用 API。应用密钥只进入服务器，不使用学校账号密码、登录 Cookie 或统一认证 JWT。

**实际状态（2026-09-28）**：本地 11 项边界/协议测试通过；学校登录后的独立聊天已取得真实回答；服务器 SSH 在认证前返回 `Network is unreachable`。因此，本补丁尚未部署，应用密钥调用、容器运行和网站实际问答均未验收。测试中使用的上游桩不属于真实 AI 验证。

## 在服务器执行

从 GitHub 分支获取与部署的完整命令见 [39 部署说明](../../docs/39-agent-demo-deployment.md)。

把此包上传并解压到服务器，在解压目录执行：

```bash
sudo python3 tools/agent-demo/deploy.py
```

按隐藏输入提示填写**学校应用 API 密钥**，然后设置至少 16 位的演示口令，或直接回车自动生成。API 密钥不是服务器密码，也不是学校统一认证密码。不要把凭据粘贴到聊天、命令参数或 GitHub。

脚本默认识别现有 Docker Compose 项目 `twinnku`、网站 `https://2512921.cn`，保存部署和回退文件至 `/opt/twinnku-agent-demo`。使用其他项目名称或实际访问域名时传入 `--project` / `--origin`；`www` 与不带 `www` 是不同来源，本补丁只允许所配置的一个 HTTPS 来源。

执行顺序：

1. 检查现有 web/api 容器、原 Compose 文件、配置哈希、共同网络和已有聊天入口；不符合条件就停止。
2. 在服务器测试正式 API：读取应用配置、创建测试会话、真实问答、第二轮上下文。失败不替换现有网页。
3. 保存当前 Nginx 配置及当前容器镜像 ID，复用现有 API 镜像启动独立服务，无需安装依赖或重建镜像。
4. 从新增容器再执行真实 API 测试，验证容器出口网络；通过 Nginx 语法检查后才重建 web 容器。此操作会造成一次短暂网页连接中断。
5. 检查同域后端路由。如切换后检查失败，尝试恢复原 Nginx 配置和 web 镜像。

正常部署总计创建两个测试会话、发送四条连通性问题，会消耗学校平台额度。只操作 web 和独立的 agent-demo 服务；不执行数据库迁移、seed、素材导入或内容审核。原业务 API/数据容器不重启。

服务器保留 `/opt/twinnku-agent-demo/demo.env`，权限 600，目录 700；包含应用密钥和演示口令。控制台只显示演示口令，不打印应用密钥。使用 `--quiet-code` 可不输出演示口令。不要上传该目录或运行 `docker inspect` / `docker compose config` 后粘贴完整输出，它们可能显示环境变量。

## 比赛使用与验收

1. 浏览器打开 `https://2512921.cn`，刷新并打开「问小开」，输入演示口令。
2. 询问一个校园问题，确认得到实际回答，再追问前一条内容。
3. 使用另一个浏览器或隐私窗口，输入口令，确认它不知道第一位访客的会话内容。
4. 核对地图、楼层图和 VR 入口仍然可用。回答中的文字和网址均以纯文本呈现，不执行模型生成的脚本或动作。

这是受口令保护的比赛文字问答，不是公开生产聊天验收。每位浏览器访客对应独立的学校 UserID 和会话；会话保留 1 小时，服务重启即失效。最多 64 个有效访客会话、每会话每小时 30 条、全站每小时 120 条。口令登录每分钟最多 30 次。点击「新对话」后再次输入口令。

当前浏览的校区/地点/楼层名称作为用户提供的问题背景传入；它们不代表已核实资料或权限。学校应用本身仍负责回答质量和知识来源。此补丁不新增自动地图动作、楼层定位、流式输出或本地聊天记录数据库。主 API 的 `capabilities.chat` 不因此改为 true。

## 回退与后续部署

在本包目录运行：

```bash
sudo python3 tools/agent-demo/deploy.py --rollback
```

恢复部署前的嵌入页配置与 web 镜像，停止并移除独立演示容器，保留备份文件。若使用自定义 `--state-dir`，回退时传入相同目录。自动回退失败时，不要运行 `docker compose down`；保留状态目录，交给维护者检查原 Compose 文件。

**这是显式 Compose 覆盖文件部署。** 后续常规发布若仅使用原 Compose 文件重建 web，将回到旧嵌入页。比赛前避免再次执行普通发布；下一轮正式发布应把接入迁入主后端并完成正式契约与验收。再次安装前先回退，保留旧目录作为备份，并为新安装指定另一个 `--state-dir`，不要覆盖现有备份。

## 失败原因

| 输出 | 含义与下一步 |
| --- | --- |
| `SSO_REDIRECT` | 正式 API 请求仍被引向统一认证。让学校管理员开放应用 API 网关/应用访问权限；后端搬运不能消除这个限制。 |
| `AUTH_FAILED` / `ACCESS_DENIED` | 核实应用 API 密钥、应用发布和调用授权。不能用学校登录 Cookie 替代。 |
| `NETWORK_ERROR` / `NETWORK_TIMEOUT` | 在服务器核实到学校服务的出口、DNS/TLS 与平台状态。 |
| `CONTEXT_NOT_CONFIRMED` | 已有接口回答，但未确认第二轮上下文；不切换网页，检查平台应用会话逻辑。 |
| `Compose settings differ…` | 原 Compose 文件/环境与正在运行的容器不同；先由维护者确认差异，本脚本不猜测。 |

如果正式 API 仍不可用，已经验证的比赛备用方式是登录后打开[学校官方小开对话页](https://coze.nankai.edu.cn/product/llm/chat/dar5kpl4shh989l2lhr0)，与地图分别演示。它不是本网站后端接入成功的证明。

## 协议与代码

正式协议来源：[学校应用 API 文档](https://coze.nankai.edu.cn/platform/doc/api-sdk/api/agent-api-call/agent-api-documentation)。请求使用 `Apikey` 头；`UserID` 为 20 位随机值；`create_conversation` 返回的 `Conversation.AppConversationID` 用于 `chat_query_v2`，`ResponseMode=blocking`。不跟随任何 HTTP 重定向、不自动重试、不保存或转发学校 Cookie、不展示思考过程字段。

`server.py` 中 Pydantic 模型定义此独立演示的请求/回答约束。它不挂接到主项目 `/api/v1`，不修改主项目公开契约或生成的 TypeScript 类型。

| 路由 | 行为 |
| --- | --- |
| `GET /agent/embed.html` | 与现有窗口兼容的 iframe 页面 |
| `POST /agent-demo/login` | `{code}`，成功设置 HttpOnly/Secure/SameSite=Strict 会话 Cookie |
| `POST /agent-demo/chat` | `{query, request_id, context?}`，返回 `{answer}`；访客/学校会话 ID 不接受客户端指定 |
| `GET /agent-demo/health` | 仅表示演示服务存活，不表示学校 API 可用 |

所有 POST 校验精确来源，错误只返回固定分类。重复请求 ID 返回已取得的回答；超时等结果不明确的请求不会自动再发。服务只暴露 Docker 内网端口，由原 Nginx 和原 HTTPS 入口代理。

本地验证（Python 3.12，已安装 Pydantic 2）：

```bash
python3 tools/agent-demo/test_demo.py
python3 apps/api/tests/test_nk_genios_api_probe.py
node --check tools/agent-demo/app.js
```
