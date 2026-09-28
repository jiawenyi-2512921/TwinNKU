# 2026-09-28：小开嵌入故障证据与应用 API 接入

本次由用户要求继续解决 Web 嵌入失败。学校配置和公开网站已实际检查；没有部署服务器、修改访问权限或替换生产聊天入口。

## 已确认的事实

| 检查 | 2026-09-28 实际结果 | 能说明什么 |
| --- | --- | --- |
| https://2512921.cn 的公开配置、嵌入页/模块、现有 CSP 自检 | 通过，已是 Full SDK 配置 | 不再是先前 Lite/Full 配置不一致 |
| 匿名 GET `https://coze.nankai.edu.cn/resources/product/llm/public/sdk/embedFull.js` | HTTP 302，Location 指向 `iam.nankai.edu.cn` 的 `/api/oidc/authorize` | 此环境匿名请求拿不到 SDK 脚本；诊断记录不保存完整认证跳转 URL |
| Twin NKU 的“问小开” | `SDK_UNAVAILABLE` | 失败发生在脚本加载阶段，尚未进入对话 |
| 学校平台“已发布渠道”→WebSDK→访问控制 | 已选择“匿名用户访问”；发布更新时间 2026-09-28 13:22:15 | 不是忘记选择匿名，也不是只保存了未发布配置 |
| 已发布 WebSDK 嵌入域名 | `https://2512921.cn`、`https://www.2512921.cn` | 学校白名单已包含网站；官方说明允许按完整 origin 填写 |
| 已发布 Web 服务→访问控制 | 已选择“匿名用户访问” | 与 WebSDK 配置一致 |
| 同一浏览器完成学校登录后重新加载网站聊天 | 仍为 `SDK_UNAVAILABLE` | 登录平台本身未解决此浏览器中的跨站脚本加载 |
| 已登录浏览器打开学校独立聊天页并发送非敏感问候 | 收到“小开”真实回复 | 仅证明这次已登录网页对话可用，不证明公众免登录或后端 API 可用 |
| 匿名 GET API 基础地址 | 302 至学校认证 | 基础地址不是具体 API 调用；不能据此断定带有效密钥的 POST 必然失败 |
| 无密钥 POST 官方 `create_conversation` 地址 | 当前执行环境返回网络错误 | 没有取得业务响应；不代表有效应用密钥已验证失败 |

判断：当前可复现的首要阻断在学校统一认证入口/脚本访问链路。应用级匿名设置与外部实际访问行为不一致。现有证据不足以断言学校所有网络环境都同样失败，也不足以宣称 API 已接通。

## 已找回的官方文档

发布页“接口说明”跳转到旧路径 `/platform/doc/api/agent-api-call/agent-api-documentation`，实际显示 404。通过该页面的文档首页和左侧导航找到了新路径，以下均已在登录后的学校文档中心打开验证：

- [智能体接口文档](https://coze.nankai.edu.cn/platform/doc/api-sdk/api/agent-api-call/agent-api-documentation)
- [WebSDK iframe 嵌入说明](https://coze.nankai.edu.cn/platform/doc/development-guide/custom-channel-adaptation/hiagent-agent-websdk-iframe-embedded)

这些是本次查到的协议证据；此前 docs/35 中“接口协议完全未知”的记录属于历史状态。学校部署是否与文档所有功能一致，仍由真实请求验收。

## 最小应用 API 协议

固定基础地址：`https://coze.nankai.edu.cn/api/proxy/api/v1`。

请求头为 `Apikey: <应用API密钥>` 和 `Content-Type: application/json`。使用发布页的应用 API 密钥；WebSDK appKey、应用 APPID、账号密码和学校 Cookie 各有不同用途。文档将 body 中的 `AppKey` 标为废弃可不传，当前请求示例使用 header 即可。

| 步骤 | HTTP 方法与路径 | 请求 JSON | 读取响应 |
| --- | --- | --- | --- |
| 只读验证应用接口 | POST `/get_app_config_preview` | `{"UserID":"独立测试用户标识"}` | 应用配置 JSON，如 `Name`；不能把 HTML 登录页当成功 |
| 创建会话 | POST `/create_conversation` | `{"UserID":"独立测试用户标识","Inputs":{}}` | `Conversation.AppConversationID` |
| 普通问答/同会话追问 | POST `/chat_query_v2` | `{"UserID":"同一用户标识","AppConversationID":"上一步会话ID","Query":"问题","ResponseMode":"blocking"}` | JSON 中的 `event`、`answer`，同时检查平台错误 |

`UserID` 按文档要求为 1–20 字符，由我们的后端生成并绑定访客。不同访客使用不同标识与会话；不能接受前端任意指定上游会话 ID。沿用 `Conversation.AppConversationID`，不要用回答中的底层 `conversation_id` 替换。

首轮采用 `chat_query_v2` 的 blocking JSON。旧 `chat_query` 即使 blocking 也有历史 SSE 返回格式，不混用解析器。流式、引用、取消和地图动作留待真实连通后分项实现与验收。

## 在部署服务器完成下一步

新增 `scripts/probe_nk_genios_api.py`，仅使用 Python 3.8+ 标准库。运行前拉取包含本文件的 `feat/admin-console` 最新提交；本批仅增加诊断工具和文档，无需重建容器或迁移数据库。

默认只读取应用配置，不创建对话，不消耗模型生成：

```bash
python3 scripts/probe_nk_genios_api.py
```

脚本使用已有服务器环境变量 `NK_GENIOS_API_KEY`；没有该环境变量且处于交互终端时，安全隐藏输入应用密钥。它不会自动加载或执行 `.env`，也不打印、写入或接受命令行密钥。部署负责人可在服务器输入已有密钥，无需再次发到聊天。

只读请求通过后，显式测试真实问答和同会话上下文：

```bash
python3 scripts/probe_nk_genios_api.py --chat
```

此命令会在学校平台创建一个命名为 `TwinNKU API connectivity test` 的测试会话，并发送两个非敏感问题，消耗平台额度。不会自动删除该测试会话。每次运行生成新的 20 字符用户标识；因此第二条命令和前一次只读探测不会共用用户上下文。

安全与证据边界：固定学校 HTTPS 地址，保持证书验证；不使用 Cookie；任何 3xx 都停止，不把密钥跟随重定向送到认证平台；不重试可能已生成的请求；仅输出固定分类，不输出密钥、回答、会话ID、原始响应或上游异常。每请求 30 秒超时，可用 `--timeout` 在 1–60 秒内调整。平台要求额外变量时，先根据配置核对，不能靠随意填值绕过。

| 输出 | 后续处理 |
| --- | --- |
| `APPLICATION_API_REACHED` | 应用密钥已到达 API；再运行 `--chat` |
| `SSO_REDIRECT` | 请学校管理员核查外部应用 API 与统一认证网关的衔接；不要加入个人 Cookie |
| `AUTH_FAILED` / `ACCESS_DENIED` | 核对应用密钥是否有效、API 发布与调用范围；同时确认响应是否来自平台或前置网关 |
| `NETWORK_TIMEOUT` / `NETWORK_ERROR` / `TLS_ERROR` | 从部署服务器核查网络、DNS、TLS与学校准入，不关闭证书校验 |
| `ENDPOINT_NOT_FOUND` / `PLATFORM_ERROR` | 核对该部署版本和接口错误记录；不能以页面文档代替真实兼容性 |
| `CONTEXT_CONFIRMED` | 本次单用户两轮上下文测试通过；不同访客隔离、引用与网站全链路仍待验收 |

## 修复方向

1. 首选：我们的网页聊天界面 → Twin NKU 后端 → 学校应用 API。先用上述脚本从部署服务器验证，不将学校账号登录态作为网站共享凭据。
2. 若有效 API 凭据请求仍被送去统一登录，需要学校平台/网关管理员为本项目确认正式的服务接入路径、出口网络要求及目标访客范围。我们无法通过改网站 CSS、切换 Full/Lite SDK 或重复发布匿名配置修复前置网关行为。
3. 如果继续走 WebSDK，也需学校核查已发布匿名渠道的公开 SDK、发布页面及依赖接口如何按既定权限经过网关。不要扩大到整个域名免登录，不移除全站 CSP，不代理个人 Cookie。
4. 独立学校聊天页可作为需校园认证的临时入口；只有对应用户实际成功登录才能使用，不能写成公众免登录方案。

给学校维护者的诊断要点（尚未发送）：应用“小开”已发布，WebSDK 和 Web 服务均为匿名访问，域名白名单已含 `2512921.cn`；匿名获取官方 `embedFull.js` 却 302 到统一认证，网站报 `SDK_UNAVAILABLE`。请核对匿名渠道与统一认证网关规则的衔接，并修正发布页的旧文档链接。若应用 API 需要专用入口或网络准入，请提供正式接入条件。不要附带密钥或完整认证跳转 URL。

## 本批验证与未完成项

本地自动化仅验证诊断脚本的请求流程、两轮上下文判定、错误结果不误报，以及真实本地 HTTP 服务器的 301/302/303/307/308 不跟随重定向。使用的是虚构密钥和本地测试响应，不能证明学校 API 真实可用。

本次未使用真实应用 API 密钥调用学校接口，未部署服务器，未开启后端 chat，未修改任何生产数据和平台发布配置。学校独立网页成功回答与网站嵌入成功必须分开报告。
