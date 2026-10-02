# 可配置校园导览与安全加固交付

记录日期：2026-10-02—03。本文描述当前源码与本轮实际验证，不构成部署或生产迁移完成记录。旧文档中的 SDK、任意文字云播报、内存访客限流和四站样板不再作为本批实现说明。

## 产品与内容边界

团队通过后台设计、维护和独立审核路线内容。前台读取任意已发布路线，不硬编码团队六条路线、不自动挑选站点、不生成或发布讲解稿。

- 路线可配置封面；每站可配置标题、多个讲解段落、来源说明、地图/图片/楼层主视图，以及对应图片、楼层、视频、VR、打卡资源。段落有稳定 ID；资源绑定类型、ID 和 revision。旧路线没有 `segments` 时兼容原单段讲解。
- 草稿支持后台权限范围内的效果预览，使用员工会话与预期草稿 revision；没有公开预览 token。预览不记录公众参观进度。所有引用须当前公开有效；引用资料更新或下架后，旧路线不会继续暴露失效资源，需内容负责人复核并重新发布。
- 公众入口提供线上参观和线下步行；浏览器保存站点、段落与音频片段/秒数，二维码只携带已发布路线与位置，不携带访客/员工 token。接续参观和版本变更须确认，讲解由用户点击开始。
- 地图、楼层、视频、VR 是段落可使用的真实资源。VR 仍在已核验的 HTTPS 原网站打开，本站保留路线；`external_requested` 只表示请求打开外站，不表示画面加载成功，也不表示小开能看见或控制跨域 VR。
- 追问、打开资源、切换段落、页面隐藏会暂停讲解。单一音频主控协调导览、小开与视频；继续讲解需点击，重新取得许可后使用当前段的书签。旧许可、旧字幕和旧进度不能复活或污染新段。

主要实现：[路线 DTO/服务](../apps/api/app/modules/experiences.py)、[分段播放器](../apps/web/src/features/experiences/ExperiencePanel.tsx)、[参观状态](../apps/web/src/features/visit/session.ts)、[讲解播放器](../apps/web/src/features/visit/TourNarrator.tsx)、[音频主控](../apps/web/src/features/visit/audioOwner.ts)。

## 公众小开、云语音与费用边界

`AGENT_PUBLIC_ENABLED=false` 为默认值；未通过上线验收前保持关闭。启用后公众点击小开即可建立本站匿名会话，无需员工账号或共享访问口令。私有口令入口保留，SDK/iframe 聊天入口关闭，网页只使用本站原生 API。学校问答模型、Qwen3 TTS 和 Cherry 音色未替换。

本站用 PostgreSQL 保存随机访客 token 的哈希、绝对过期时间、独立上游会话、CSRF、短期回答及许可；重启不会将所有访客混进同一会话。公众会话默认 1 小时，不因读取接口无限延长；结束会话删除本站会话、回答及其许可。上游已经接收的请求能否停止和删除，须按供应商能力单独确认。浏览器语音识别的服务行为仍取决于浏览器，不能称全部语音都在本机处理。

生产员工/待验证/访客 cookie 使用 `__Secure-` 前缀、`Secure`、`HttpOnly`、`SameSite=Strict`，不设置 Domain，并限制 API 路径。生产仅接受新名字，升级后旧会话须重新登录；开发/测试保留原名字。写入、云播报和动作核验同时检查精确 Origin 与 CSRF。代理仅信任指定直接上游；公网 Nginx 和容器 Nginx 覆盖客户端 IP 头并清除其他转发身份头，不接受浏览器自报 IP。

| 默认预算 | 小时 | 日 |
| --- | ---: | ---: |
| 模型供应商实际尝试，全局 | 120 | 720 |
| 语音供应商实际尝试，全局 | 200 | 1200 |
| 模型与语音合计，全局 | 分项计数 | 1920 |
| 同一访客模型/语音尝试 | 30 / 45 | 合计 450 |
| 同一可信 IP 的供应商尝试 | 180 | 1080 |
| 公众 HTTP 全局请求 | 2400 | 14400 |
| 云播报字符合计 | 随语音尝试限制 | 360000 |

日预算采用小时初值 × 6 的累计成本政策，不代表供应商账户余额。所有供应商尝试在调用前原子扣额；创建学校会话、语音降级重试也计数。HTTP/IP 限流在音频缓存命中前执行。跨进程并发租约默认模型/语音各 4，每访客每类 1；数据库或预算服务失败时拒绝收费调用，不退回单进程内存计数。不自动重试结果不明的模型请求；浏览器取消不能保证供应商不计费。

云语音只接受服务端核验的已发布路线段落引用，或当前会话签发的短期回答播报许可；浏览器不能提交任意文字计费。草稿试听是员工鉴权接口，不进入公开音频缓存。服务器分片保留全文，首片最多 80 字，其后按配置最多 300 字。缓存限制 64 MiB、512 片，私有回答/草稿按主体隔离；同内容并发生成合并，取消等待者不会取消正在进行的供应商尝试。

供应商音频下载限制 HTTPS、精确主机名单、公共 DNS 地址和固定验证后的连接地址；禁止重定向、私网地址、通配供应商租户域名与任意 URL 工具。JSON/base64/下载大小、时间和 WAV 内容受限。`VOICE_ALLOWED_AUDIO_HOSTS=[]` 默认仅支持供应商内联音频；真实返回主机尚未核验，不能猜测后填入通配名单。

模型输出和后台来源文字都属于数据，不能修改本站授权。动作须先登记到会话/轮次/上下文/revision/短期 TTL，执行时再次检查公开资源、类型、版本和后台动作白名单。回执必须匹配登记动作及允许状态；它证明本站观察到的状态，不证明导航实际到达或外部 VR 加载。日志只保留本站诊断编号、阶段、耗时及安全元数据，不记录问题/回答、API key、原始 IP 或上游异常全文；回答本身只用于限时会话处理，不作为访问日志。

证据：[公众会话与预算](../apps/api/app/integrations/public_agent_security.py)、[小开核验](../apps/api/app/modules/assistant.py)、[语音入口](../apps/api/app/modules/voice/router.py)、[安全下载](../apps/api/app/modules/voice/rotation.py)、[共享访客会话](../apps/web/src/shared/visitorSession.ts)。

## 员工 MFA：先绑定主、备用，再强制

员工 WebAuthn 绑定 `2512921.cn` / `https://2512921.cn`，要求认证器完成用户验证 UV。密码验证后的 pending cookie 只允许完成验证/绑定，不是后台业务会话。注册后还须用刚登记的那一把认证器签名登录，才能标记 verified；主认证器不能代替备用认证器完成证明。验证挑战短期有效、失败累计，验证 Origin、RP ID、challenge、签名、账号版本与跨域标记。敏感账号操作、每次发布和运行策略修改要求最近 5 分钟的 MFA；员工会话默认绝对 8 小时、闲置 30 分钟，GET 轮询不延长闲置期。

上线顺序如下，不能在员工未准备好时先切强制开关：

1. 完成新 schema 和受限运行角色验收，`ADMIN_MFA_ENFORCED=false` 暂作绑定阶段。已绑定的账号始终必须验证 MFA，不因全局开关关闭而降级。
2. 每个启用的管理员使用自己的密码登录，先修改临时密码；登记主认证器并签名验证，再登记独立备用认证器，并用备用本身签名验证。应在实际使用的电脑/手机上退出后分别登录验收，不把测试签名或注册返回成功当作真机完成。
3. 获取 10 个恢复码并离线保存；服务端只保存 256 位随机码的哈希。原文只在本次生成响应出现，重新生成会作废旧码。预检只能证明码已生成且尚有剩余，不能证明持有人已经保存。
4. 在运行镜像执行只读预检：`docker compose run --rm --no-deps api python -m app.modules.admin.mfa_preflight`。所有启用管理员均须无临时密码、至少两把分别 verified 的认证器、至少一个未用恢复码，否则退出非零。
5. 保存预检和真机验收记录后再设置 `ADMIN_MFA_ENFORCED=true`，重建运行容器并逐角色验证登录、scope、独立审核、最近 MFA 与闲置失效。强制开关覆盖所有员工，预检重点防止管理员全部被锁在外面。

恢复码需先通过自己的密码及 pending 流程；成功使用一次后作废，撤销旧认证器和全部会话，只开启 15 分钟重新绑定窗口，不直接生成业务会话。重新绑定后仍需验证主/备用与保存新的恢复码。最后一把认证器不能在网页直接删除。所有因素均丢失时，由获授权运维在已认证、交互式服务器控制台执行 `python -m app.modules.admin.mfa_recover --username <员工名> --reason <维护工单>`；可选隐藏输入临时密码，但不能通过脚本伪造员工会话、提升角色或绕过绑定。控制台恢复的人身份核验与工单由运维承担，目前尚无生产演练记录。

证据：[MFA HTTP 流程](../apps/api/app/modules/admin/mfa.py)、[会话与 step-up](../apps/api/app/modules/admin/security.py)、[只读预检](../apps/api/app/modules/admin/mfa_preflight.py)、[控制台恢复](../apps/api/app/modules/admin/mfa_recover.py)、[P-256 签名边界测试](../apps/api/tests/test_staff_mfa.py)、[生产 cookie 测试](../apps/api/tests/test_production_cookies.py)。

新建、修改、后台重置和控制台临时密码统一采用离线密码策略。来源为 [SecLists 官方 MIT 集合](https://github.com/danielmiessler/SecLists)，其 [维护者说明](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/README.md) 明确 Xato 集合按常见程度排序；本批处理密码子集，没有用户名/账号组合。完整来源快照 SHA256 已核对，从 1,000,000 项中按原顺序提取前 3000 个符合 12–128 字符政策的候选，并附前 10000 个历史泄露候选的完整 SHA256 与 casefold 变体，衍生文件控制在 1 MB 内。本站名称、学校/产品名称与实际角色词及其数字/标点装饰变体也会拒绝；不要求大小写/数字/符号组成、不定期强制换密。原文字只在构建过程内存处理，不写入仓库，用户密码及哈希不外发。缺失/损坏策略文件时拒绝新密码操作；已经验证成功的旧登录仅更新 Argon2 编码，不被当成新密码创建，也不修改原始密码。有限历史集合中未命中不代表从未泄露。[策略与校验和](../apps/api/app/password_policy.py)、[来源/许可/规模记录](../apps/api/app/data/README.md)、[离线重建工具](../scripts/build_password_blocklist.py)、[HTTP 无副作用与故障测试](../apps/api/tests/test_password_policy.py)。

员工“我的有效会话”仅显示本人仍有效的会话、服务端时间、创建/活动/过期时间与当前标记；随机 UUID 只用于定位，不是登录凭据，接口不返回 token、哈希或 IP。可撤销单个其他会话或全部其他会话，操作要求精确 Origin、CSRF 及最近 5 分钟 WebAuthn UV，绑定阶段也不允许密码会话直接撤销。自己的当前会话通过退出登录结束；他人和未知 ID 均返回 404，撤销后旧 cookie 立即失效，旧 pending 证明也失效。账号切换取消旧请求，界面不会显示上一账号列表。[后台接口](../apps/api/app/modules/admin/sessions.py)、[会话界面](../apps/web/src/features/admin/MfaAuth.tsx)、[签名与授权测试](../apps/api/tests/test_staff_sessions.py)、[迁移保真测试](../apps/api/tests/test_staff_session_migration.py)。当前实现允许多个独立浏览器会话，没有统一账号并行数量上限；员工列表与单个/其他撤销不是全员管理入口，此政策及集中撤销待单独评审。

## 部署预检与顺序

本批源码迁移链为 `0008_campus_tours` → `0009_staff_mfa` → `0010_public_agent_security` → `0011_upload_budgets` → `0012_staff_session_ids`。四项新迁移须顺序执行，不能漏掉持久上传预算和员工会话 UUID。0012 保留既有 token 哈希、CSRF 与时间字段，只新增随机会话定位 ID；SQLite 升降级保真测试通过，生产和 PostgreSQL 实证另行记录。API/web/契约必须配套升级。路线配置继续在既有 JSON 内容快照中存储，不需要导入团队路线或重做地图。

1. 先处理服务器系统维护。当前确认 Ubuntu 20.04 未启用 ESM，用户没有 Ubuntu Pro；20.04 标准安全维护已于 2025-05 结束。代码和容器加固不能补齐宿主机安全更新。先在受支持 LTS 上完成兼容与恢复演练，再安排迁移；未完成前不宣称“服务器最顶级安全”。[Ubuntu 官方维护周期](https://ubuntu.com/about/release-cycle)。SSH 加固也须保留独立会话和控制台后验证，当前不能写成已经修改。
2. 取得完整备份、恢复密钥及恢复结果。保留用户选择的服务器本机加密 restic 备份，不声称已配置异地副本。`scripts/backup.py` 备份 DB dump、地图/楼层/媒体原件、私有部署配置及明确指定的 Nginx 配置；`scripts/restore_backup.py` 只恢复到新私有目录和隔离 PostgreSQL，不切换生产。密码文件不得进入 Git、日志或公网目录。
3. 核对准确 HTTPS Origin、允许主机、可信代理链、独立 `DB_APP_USER` / `DB_APP_PASSWORD` 和迁移 owner；`.env` 为未跟踪的 0600 文件。先保持 `AGENT_PUBLIC_ENABLED=false`，收费服务先关闭待验；沿用实际服务商/模型/音色配置。不要输出包含密钥的 `docker compose config`，使用 `docker compose config --quiet`。
4. 对备份恢复得到的隔离数据库先执行 Alembic 到 head、角色分权、全部 PostgreSQL/预算并发测试和只读烟测。在线 API 只拿受限 DML 账号，迁移容器单独持 owner；在线账号不得拥有对象、超级用户/创建角色/DDL 权限，不得更新 `alembic_version`。新角色及迁移在生产尚未执行。
5. 在维护窗口按 `scripts/deploy.sh` 配套构建 API/web，运行一次性 migrate（含角色授权），检查健康和原公开资料；升级中不 seed、不重导地图、不自动审核路线。更新公网 Nginx 可信头配置后执行 `nginx -t` 和外部 HTTPS 检查，确认第三方 SDK 入口已关闭。自动脚本并未代替前述预检或执行外部付费验收。
6. 按上一节完成员工主/备用/恢复码与强制 MFA。随后在批准的小额度内逐项真实验收学校会话/问答、TTS 内联或精确下载域名、费用计数、设备发声和取消，记录供应商真实结果；只有这些及 PostgreSQL 保护通过后才考虑开启公众开关。
7. 内容负责人在后台预览、提审并独立发布实际路线；逐段检查真实来源、资源 revision、返回讲解、二维码接续和下架失效。自动测试夹具不是校园实际内容。

2026-10-02 已完成一次服务器完整加密备份和隔离恢复验证：旧 schema 20 表、head `0008_campus_tours`；`restic check` 与 `pg_restore` 成功；逐 DB 引用验证 265 张 map tiles、100 张 floor images、1 个 floor original、46 个 media originals。地图卷 532 文件 / 173794199 字节，楼层卷 150 文件 / 395050061 字节。恢复结果 `production_modified=false`，没有把恢复数据写回生产。这证明旧版本备份可恢复，不证明新迁移、在线权限、全量新版本 PostgreSQL 并发或新版本恢复已经通过。

本机备份 timer 已在服务器启用，执行冻结预检目录 `/root/twinnku-release-preflight-20261002/backup.py --root /root/TwinNKU`，并显式覆盖现用 Nginx site；每天约 03:00（Asia/Shanghai，随机延迟最多 5 分钟），保留 14 个日快照、4 个周快照。restic 固定 0.19.1，安装时核对官方 SHA256。`twinnkuops` 已用既有 authorized keys 登录并验证 sudo uid 0；root/密码 SSH 入口仍开启，尚未关闭，不能把备用运维登录验证称为 SSH 加固完成。

## 关闭与回滚

先关闭 `AGENT_PUBLIC_ENABLED` 与云收费服务，保留图文/地图/楼层/公开路线；已有公众会话也会被服务端开关拒绝。停止浏览器播放不会撤销已提交的供应商收费。工作人员被 MFA 锁住时使用上述恢复流程，不通过关闭强制 MFA 绕过已绑定账号。

新迁移是增量表/字段，首次回退优先保留新 schema、恢复已验证的配套镜像。不要自动执行 Alembic downgrade、清空卷或旧 seed。若必须回退到尚无 MFA/公众预算的旧代码，先关闭后台、公众问答、云语音和 SDK，再复核旧代码与新 schema 的兼容，避免把防护一起撤回。数据库恢复先在隔离目录验证；生产切换须另行明确授权，保留维护窗口期间的新数据。恢复脚本没有生产切换功能。

## ASVS 5.0.0 适用 L2 控制映射

使用 [OWASP ASVS 官方 v5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0) 的固定版本编号；L2 范围包含适用 L1 前置控制。以下是本批相关项的证据清单，**不是完整 ASVS 评估、认证、渗透测试或绝对安全保证**。`本地证据` 不等于生产控制生效；不存在的模块应说明不适用理由，不能把未检验项默认为通过。

| 控制 | 本批证据与状态 |
| --- | --- |
| [v5.0.0-1.2.4 / 1.2.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x10-V1-Encoding-and-Sanitization.md) | ORM/参数化 SQL；图片、视频处理固定参数子进程，禁止 shell 拼接。本地测试/静态扫描；完整注入评估待做。 |
| [v5.0.0-1.3.6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x10-V1-Encoding-and-Sanitization.md) | TTS HTTPS 精确名单、公共 DNS、固定 IP 连接、不跟随重定向及有界下载；`test_voice_rotation.py` 有 SSRF 拒绝用例，真实域名待验。 |
| [v5.0.0-3.3.1 / 3.3.2 / 3.3.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 生产 __Secure-/Secure/Strict/HttpOnly；HTTPS HTTP 边界测试已覆盖新名、拒绝旧名和注销。生产头待验。 |
| [v5.0.0-3.3.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 部分：当前按 API 路径隔离使用 __Secure-，未使用要求 Path=/ 的 __Host-；域树威胁评估和例外审批尚未完成。 |
| [v5.0.0-3.4.1 / 3.4.3 / 3.4.4 / 3.4.5 / 3.4.6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | CSP self/对象禁止/base-uri none/禁止被框架嵌入、nosniff、Referrer-Policy 已写配置；真实所有响应头待验。HSTS 模板尚需启用，未盲目要求未知子域 HTTPS，L2 includeSubDomains 项部分。 |
| [v5.0.0-3.5.1 / 3.5.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 精确 Origin、CSRF 和非 GET 敏感调用；员工/访客/语音边界测试。 |
| [v5.0.0-4.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x13-V4-API-and-Web-Service.md) | 两层代理覆盖身份头，API 精确可信 peer；伪造 IP 用例已测，公网 Nginx 与 Uvicorn 实际链待验。 |
| [v5.0.0-5.1.1 / 5.2.1 / 5.2.2 / 5.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md) | 上传格式/字节/像素/解析时间、CPU/内存/并发及 actor/campus 持久额度；内部生成路径，拒绝链接/越界；`test_uploads.py`。生产沙箱待验。 |
| [v5.0.0-5.4.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md) | 尚无已验证 AV 扫描链；格式校验、重编码与审核不能替代此项。 |
| [v5.0.0-6.3.1 / 6.3.3 / 6.3.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 持久登录限流、密码后 WebAuthn UV、pending 不授业务权限、所有入口统一校验。暂留绑定阶段；未强制且未真机验收前不能称生产 L2 MFA 通过。 |
| [v5.0.0-6.4.3 / 6.4.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 恢复不生成业务会话，只允许重新绑定；密码/码与控制台审计已测。人员身份核验、维护工单和真实恢复演练待补。 |
| [v5.0.0-6.5.1 / 6.5.2 / 6.5.3 / 6.5.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | CSPRNG 256 位恢复码、SHA-256 存储、一次性消费、重新生成撤销；HTTP 签名/恢复测试。 |
| [v5.0.0-6.2.4 / 6.2.11 / 6.2.12](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 离线按频率选择至少 3000 个合规常见候选、10000 个历史泄露候选、组织/角色词及变体；完整 SHA256 只用于拒绝，凭据仍 Argon2id。来源、许可、校验和和无副作用边界测试；非实时完整泄露数据库，生产操作待验。 |
| [v5.0.0-7.2.1–7.2.4 / 7.3.1 / 7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 服务器校验随机哈希会话、登录轮换、员工闲置/绝对失效、访客绝对失效。本地边界证据；匿名访客不是员工身份认证。 |
| [v5.0.0-7.4.1–7.4.4 / 7.5.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 注销/停用/凭据变化撤销；可见退出入口；敏感凭据操作 recent MFA。本地覆盖；所有受保护页面可达性和真机待验。 |
| [v5.0.0-7.5.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 本人有效会话列表、单个/其他撤销及当前注销；撤销必须 5 分钟内 UV（绑定阶段也强制）、Origin/CSRF。后台真实 P-256 及授权边界 16 passed，含旧 pending 签名撤销后失效；前台 request 与切号竞态 4 passed。生产与真机待验。 |
| [v5.0.0-7.1.2 / 7.4.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 部分：并行浏览器会话暂无统一数量上限，上述政策需审定；管理员停用/重置及控制台恢复可撤销单用户，但尚无独立全员集中撤销入口。自身列表不替代这两项。 |
| [v5.0.0-8.1.1 / 8.1.2 / 8.2.1–8.2.3 / 8.3.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md) | 四角色、campus/point scope、独立审核、状态/revision/字段和动作许可在后端强制；公开段落与私有预览不共用授权。权限矩阵测试，生产账号需复核。 |
| [v5.0.0-13.1.1 / 13.2.2–13.2.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x22-V13-Configuration.md) | 出站学校/TTS 服务和名单已记录；Compose 迁移/运行账号分离、私有 DB 网络。供应商、生产角色和连接实测待验。 |
| [v5.0.0-13.2.1 / 13.3.1 / 13.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x22-V13-Configuration.md) | 部分：服务端密钥、0600 私有环境文件、运行容器不持 owner 密码；未部署独立 secrets manager 或短期服务凭据，不能标完整满足。 |
| [v5.0.0-16.2.5 / 16.5.1–16.5.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) | 安全诊断与一般错误文案；DB/额度失败关闭；密钥/正文/上游异常不入访问日志，相关测试。 |
| [v5.0.0-16.1.1 / 16.3.1–16.3.3 / 16.4.2 / 16.4.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) | 部分：已有员工审计、容器日志轮转；全栈日志保留/访问清单、全部拒绝事件、独立防篡改收集与告警闭环尚未验收。 |

## 验证记录与交付限制

本地实际执行：后端公众/小开/云语音相关 87 passed，SDK/资源/部署诊断回归 71 passed；前端 native/cloud/visitor/dock 88 passed；本次讲解竞态新增 6 passed，生产 cookie/MFA/公众/native/admin 组 57 passed，语音/资源/guide 补充组 67 passed；离线密码策略（含构建顺序/来源校验）、生产 cookie、旧 MFA/后台回归最新 54 passed；员工会话后台 16 passed、前台 4 passed。前端本轮完整 Node 回归 366 passed，TypeScript 检查通过。这些分组有重叠，不应相加为全量成绩；最终全量后端与 PostgreSQL 结果另以交付记录为准。

实际扫描：Bandit 1.9.4 未见 medium/high（3 个 low 经定位为固定子进程/测试语言误报）；pip-audit 2.10.1 对锁定运行依赖、npm audit 对锁定前端依赖均未见已知漏洞；Gitleaks 8.30.1 对全部 355 个提交、当前 tracked diff 及新增代码脱敏扫描无泄露。`.gitleaksignore` 仅列三条经 AST/定位确认的历史误报指纹，不忽略整条规则或目录。[CI 安全工作流](../.github/workflows/security.yml) 钉住 action SHA、工具版本和 Gitleaks 校验和，包含镜像 HIGH/CRITICAL 阻断；本地没有 Docker，不能称镜像扫描或远程 CI 已运行成功。

仍待完成：受支持宿主机/SSH 加固；新迁移及生产 DB 权限、PostgreSQL 并发/重启限额；全新版本的隔离恢复与生产切换演练；真实学校 API/云语音与批准额度计费证据；主/备用认证器与控制台恢复真机；公网可信链/HTTPS 所有响应头；路线上线内容和电脑/手机视觉/发声。已完成的旧 schema 备份恢复不能替代这些项目。
