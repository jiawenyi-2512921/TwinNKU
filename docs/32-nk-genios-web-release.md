# 小开网页嵌入：开发交付与部署

日期：2026-09-25。对应用户提供的 `embedFull.js` 与 `HiagentWebSDK.WebClient` 代码。业务分支 `feat/admin-console`；本次不连接服务器、不导入地图、不修改生产资料。平台配置步骤见 [33](33-nk-genios-platform-setup.md)。

2026-09-26修订：按用户再次提供的Full SDK代码纠正远程 `0b25f5e` 的Lite切换；前端、后端公开配置和部署自检统一为Full，并增加协议回归测试。保留已校正点位和嵌入页worker策略。平台“接口说明”已失效时，按[35](35-nk-genios-api-access.md)取得替代证据；不尝试猜测后端鉴权或端点。

交付渠道：本轮通过用户已登录的GitHub网页提交至 `feat/admin-console`。检查最新完整提交的 `contracts-and-tests` 与 `compose-smoke` 均通过后，按下面步骤拉取该分支并更新服务器。[34](34-offline-delivery.md)保留离线包导入方法；已拉取本轮远程代码时不要重复导入。服务器尚未由Codex部署，真实学校SDK和访客访问仍需验收。

## 1. 本轮交付

| 项目 | 实现与边界 |
| --- | --- |
| 网站入口 | 右下角“问小开”；桌面独立侧栏，手机全屏对话；地点详情、楼层查看页可进入 |
| SDK 容器 | 独立 `/agent/embed.html` 文档运行全页面 SDK；外层网站提供收起、重新加载和返回地图 |
| 生命周期 | 首次打开才加载第三方脚本；收起保留 iframe；明确重载才重建；不调用未经确认的 destroy/reset/sendMessage 方法 |
| 加载异常 | 配置请求 12 秒、SDK 脚本 20 秒、外层初始化 45 秒超时；断网提示、错误重试、地图继续使用 |
| 运行配置 | 后端环境变量决定是否启用；浏览器只读取 WebSDK 公开嵌入标识，不读取服务端 API key/SSO token |
| 上下文 | 可传 10 个公开点位/楼层字段；默认关闭，平台建好同名变量并验证后开启；当前对话的地点快照明确显示 |
| 变更地点 | 不自动清空正在输入的问题；提示用户切换讲解地点并重载，也可在对话中直接说新地点 |
| 提问建议 | 能复制包含地点/楼层名称的问题，由用户粘贴发送；不是自动发送 |
| 平台插件 | 6 个公开只读工具的 OpenAPI 3.0.3 与 3.1 文件；只有已实现操作，不含后台与计划接口 |
| 导览链接 | 后端生成点位、楼层/分区和全景入口；用户点击；全景落地页再次读取已发布列表，不直接执行模型给出的 URL |
| 别名查询 | 中文名称/别名及字面量 `%`、`_` 搜索；公开过滤与分页仍由数据库完成 |
| 知识资料 | 从生产公开接口导出已发布介绍，带 ID、版本、来源原文、摘要与资源快照；不自动上传平台 |
| 测试材料 | 平台系统提示词、上下文片段、资料模板、100 题评测草案与验收说明 |

`capabilities.chat_embed` 表示 WebSDK 已配置启用；不代表校方服务健康。原 `capabilities.chat` 仍为 false，后端 `/chat/*`、模型动作回调、SSE、会话审计与自动知识同步仍属后续工作。不能把网页 SDK 会话宣传成已经实现后端聊天适配器。

## 2. SDK 证据与限制

用户本轮提供的构造字段只有 `appKey`、`baseUrl`、`hideSidebar`、`variables`。代码仅使用这些字段。SDK 地址固定为：

```text
https://coze.nankai.edu.cn/resources/product/llm/public/sdk/embedFull.js
```

实现不读取第三方聊天 DOM、不监听猜测的动作事件、不仿造学校 API、不把初始化成功标成回答成功。WebClient 构造成功后即交给平台展示登录/会话；平台内的权限和模型错误可能在其窗口内显示。

本轮从执行环境下载 SDK 返回 502，真实源文件未取回；浏览器本地预览返回 `ERR_BLOCKED_BY_CLIENT`。因此真实学校 iframe、登录、引用和链接打开方式必须由部署方验收。原用户“图书馆知识回答成功”是平台内单次试验，不等于网站端全链路通过。

## 3. 新接口

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| GET `/api/v1/agent/web-config` | 返回嵌入配置、公开 appKey、变量开关 | 公开；默认关闭且 key 为 null；no-store |
| GET `/api/v1/guide/points/{point_id}` | 聚合公开点位、楼层、VR、页面 links | 复用现有校园/点位/楼层/全景公开过滤 |

导览接口 `links` 带 `kind`、`label`、`url`、`point_id`、`resource_id`、`revision`、`section`。kind 使用原动作枚举名称，但交互语义明确为 `user_click_link`，不是动作执行回执。链接 origin 取显式配置，不采用请求 Host 或代理 Header。

无数据库迁移，head 保持 `0005_resource_editor`。完整机器契约由 Pydantic 生成，新增两项已实现操作；既有计划聊天接口没有挂生产 router。

## 4. 部署步骤（用户或 DeepSeek 执行）

以下适用于已经运行现有后台/楼层版本的服务器。先确认现有路径、分支和工作区改动，保留本机 `.env`。不要 `git reset --hard`、不要复制 `.env.example` 覆盖已有密码。

```bash
git status --short
git switch feat/admin-console
git pull --ff-only origin feat/admin-console
docker compose exec -T api alembic current
```

当前迁移应是 `0005_resource_editor`。如果不是，先按既有后台升级规范处理；本次 SDK 接入不负责重建数据库或重新导入资源。

在原 `.env` 末尾添加，已有同名项则修改，不要重复定义：

```dotenv
PUBLIC_SITE_ORIGIN=https://2512921.cn
NK_GENIOS_WEB_ENABLED=true
NK_GENIOS_WEB_APP_KEY=填本次平台嵌入代码中的appKey
NK_GENIOS_WEB_CONTEXT_ENABLED=false
NK_GENIOS_WEB_HIDE_SIDEBAR=true
```

`appKey` 是平台要求发送给浏览器的嵌入标识，并非服务端 API 密钥。仍通过服务器环境配置，仓库不包含用户给出的实际值。学校登录 JWT、Cookie 或后端 API key 不得填入该字段。`PUBLIC_SITE_ORIGIN` 不带尾部 `/`、路径或查询参数；若实际站点域名变化，重生成插件文件中的 servers。

```bash
chmod 600 .env
docker compose config --quiet
docker compose build api web
docker compose up -d --no-deps --force-recreate api web
docker compose ps
python3 scripts/smoke.py http://127.0.0.1:8080
```

只重建 API/web，不执行种子导入、不删除卷、不触碰地图图块和楼层原图。不要只更新 web：旧后端没有新配置和导览接口。

检查公开配置时不要输出 appKey：

```bash
curl -fsS https://2512921.cn/api/v1/agent/web-config | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print({k:v for k,v in d.items() if k != "app_key"})'
curl -fsS https://2512921.cn/api/v1/campuses
curl -fsSI https://2512921.cn/agent/embed.html
```

返回配置应有 `enabled: true`；校园接口中选实际校区 ID 再查询地点。域名白名单、智能体发布和 NK-GeniOS 配置按 [33](33-nk-genios-platform-setup.md) 完成。

本次修复后 `sdk_url` 必须是上文的 `embedFull.js`。若仍是 `embedLite.js`，先核对是否真的重建并重新创建了API容器；只刷新浏览器或只更新web不能修复旧API配置。前后端不一致时会显示 `INVALID_CONFIG`，不会静默尝试另一套SDK。`NK_GENIOS_WEB_HIDE_SIDEBAR=false` 可保留平台侧边栏；true是本网站嵌入布局的默认选择，不改变鉴权方式。

也可用本轮新增的只读自检汇总上述检查，并检查嵌入HTML/脚本、实际响应中的多条CSP、六个公开插件接口和导览链接目标：

```bash
python3 scripts/check_nk_genios.py \
  --base-url https://2512921.cn \
  --campus-id nku-jinnan \
  --expect-enabled \
  --check-sdk \
  --json-out var/nk-genios/deployment-check-20260925.json
```

校区ID以实际公开接口为准；重复运行时给报告换一个新文件名。脚本只发GET，不登录、不写资料、不执行学校SDK；不输出appKey、Cookie、响应原文或异常中的跳转地址。`--check-sdk`只检查运行机器能否取到学校脚本，不能代表访客浏览器能登录或回答。

`PASS`表示该项检查通过，`FAIL`使退出码为1，`WARN`需要阅读原因，`SKIP`表示未执行。没有公开点位时会明确跳过四个点位工具，不能作为六工具全通过证明。平台真实聊天始终列为手工验收；即使退出码为0，也不是全部发布验收完成。

先检测容器内部入口时，用 `--base-url http://127.0.0.1:8080`；再检查外部HTTPS域名，才能发现外层代理额外添加的CSP。未开聊天开关时可省略 `--expect-enabled`，报告会提示关闭状态。CI的compose-smoke已加入本脚本；2026-09-25完整交付 `32ec45a` 的两项CI曾通过，后续 `0b25f5e` 因OpenAPI漂移失败。部署必须检查本次修复的最新完整提交，历史绿勾不能替代当前结果。

## 5. CSP 与 iframe

主地图和管理后台继续使用原有 CSP。仅 `/agent/embed.html` 允许学校域名脚本、连接、iframe；不允许任意域名脚本、内联脚本或 unsafe-eval。内嵌容器允许该 SDK 所需的内联样式，例外只作用于此文档。

保留嵌入页已有的 `worker-src 'self' blob: https://coze.nankai.edu.cn`，不扩大到主地图或管理后台。CSP放行不等于学校登录、配额、网络和会话权限已通过。

若服务器外层 HTTPS Nginx/CDN 又添加了一条更严格 CSP，浏览器会同时执行多条策略，仅更新 Docker 内的配置可能仍被阻断。按浏览器控制台的具体违规项，对同一 `/agent/embed.html` 路径应用配套策略；不要删除整个网站 CSP 或添加通配符。额外资源域名只有取得平台实际请求证据后才加入。

iframe 的作用是隔离布局与生命周期，不把“allow-scripts + allow-same-origin”宣称为不可信代码安全边界。学校 SDK 属于本次用户明确授权的外部脚本；主站不向它传员工会话或管理数据。全景仍通过经审核的公开数据及用户点击打开。

## 6. 上下文启用

先用空 `variables` 跑通聊天。平台建好 10 个同名字符串变量、追加上下文提示片段、保存发布并验证变量后，再改：

```dotenv
NK_GENIOS_WEB_CONTEXT_ENABLED=true
```

重建配置只需重新创建 api 容器：

```bash
docker compose up -d --no-deps --force-recreate api
```

客户端在重新打开页面、窗口聚焦或约 60 秒可见轮询后读取新配置。配置实质变化会关闭旧嵌入窗口，下次打开使用新配置。普通地图轮询不会重建对话。变量只是初始化快照，尚未确认 SDK 有运行中更新接口；切换点位时用户明确重载才传入新快照，平台历史会话是否保留由平台决定。

## 7. 知识库导出

脚本兼容 Python 3.8+ 标准库。先从 `/api/v1/campuses` 核对校区 ID。当前仓库种子使用 `nku-jinnan`，生产仍以接口实际返回为准。

```bash
python3 scripts/export_nk_genios_knowledge.py \
  --base-url https://2512921.cn \
  --campus-id nku-jinnan \
  --output var/nk-genios/knowledge-20260925
```

脚本只 GET，不登录后台、不发布草稿、不上传平台。输出必须是新目录；同路径重复执行会拒绝覆盖。检查 `manifest.json` 的数量、版本、跳过原因；只将 `documents/` 下核对过的 Markdown 文档上传知识库。如果平台未列出 Markdown 支持，用 UTF-8 纯文本保存同一正文再导入，不能仅改扩展名假装 Word/PDF。

没有介绍的点位会跳过；导出中已撤回的点位会记录而不收录；网络失败不产生完整快照。后台资料以后改变时重新导出，对照 manifest 替换/删除平台旧文档。该脚本不是自动索引同步，旧文档不会自行消失。

## 8. 发布后验收

1. 电脑和手机打开网站：地图不受影响，点击“问小开”才发出 SDK 请求；收起后地图可操作，再打开不会重复初始化。
2. 平台回答图书馆介绍；检查平台真实引用内容。不要仅凭回答看似合理确认检索成功。
3. 无痕窗口和另一设备测试登录要求、会话隔离；不要把当前校内已登录浏览器当公众无登录可用证据。
4. 平台工具独立调试：listCampuses → listPoints → getGuidePoint；输出只能包含实际公开资料和本站链接。
5. 在 SDK 回答中点击地图、楼层分区、VR链接。若平台 Markdown 把链接留在内层 iframe，验证其“新窗口打开”行为后记录；本轮不跨域改写聊天 DOM。
6. 点击地图另一个点位，确认不会自动重建正在输入的会话；上下文开启时显示切换提示，明确点击后再核对新地点。
7. 知识库不含的问题、错误校区、不存在楼层、下架全景、插件断网，均不能生成伪造答案/入口。
8. SDK 域名不可达时出现可重试状态；地图、点位和楼层仍可用。窗口已初始化后的平台内部错误由其页面呈现，外层不声称能检测所有模型失败。
9. 手机软键盘、横竖屏、返回按钮、桌面 Tab/关闭焦点；iframe 内 Esc 可能由平台处理，必须保留可点的外层关闭按钮。

## 9. 回退

设 `NK_GENIOS_WEB_ENABLED=false` 并重新创建 API。客户端读取新配置后移除聊天入口/窗口，地图与已发布资料保持。平台自身发布渠道与外部会话需要在 NK-GeniOS 单独管理，本站开关不能撤销用户持有的其他平台入口。

## 10. 仍待核验的外部能力

真实 SDK 能否在该部署环境加载、平台访客身份要求、引用呈现、变量绑定/会话复用、Markdown 链接目标、配额与费用，以及后端对话 API/事件协议。取得证据后再实现自动地图动作、后端会话、完整审计和自动知识同步，见 [24](24-agent-implementation.md)。
