# 可配置校园导览与安全加固交付

记录日期：2026-10-02—03。截至 2026-10-03 本次交付，生产已配套上线 `1.7.0`，数据库为 `0012_staff_session_ids`，在线 API 已使用受限账户 `twinnku_app`。宿主、Docker、代理、迁移、旧内容保真和上线后公网 HTTP 检查已完成；真实登录 cookie/CSRF、员工认证器、电脑/手机视听和供应商问答仍待验收。公众助手、云 TTS、旧 SDK 关闭，MFA 保持登记阶段，不能将本次发布称为全部安全或设备验收完成。旧文档中的 SDK、任意文字云播报、内存访客限流和四站样板不再作为本批实现说明。

## 实际生产状态

应用使用隔离验收时冻结的 Git 树 `44af266ab2d7fb3d0efeaa2cca58f43780f18113`，没有在切换时重建镜像。生产工作区保留旧 Git HEAD 元数据，固定源码清单已应用并审计；不能只凭该 HEAD 推断运行版本，应核对发布清单、回执和实际容器镜像 ID。实际运行的不可变镜像如下：

| 服务 | 实际镜像 ID |
| --- | --- |
| API | `sha256:2a1c95646e6eb9b4263cc161303ff37acbb97bdb26df741f8321506f92d5c655` |
| DB | `sha256:39e67f9e9de647545f367c24000762ffb0ccfbc3b391aa87fdb5a2c9ad2e70ce` |
| web | `sha256:ec4492f298b0442170c6a842c5373667896c3b5716e474adfdbc5749c58f7eff` |

上线后的实际 API 进程 UID 为 `10001`、web 为 `101`，保留原 map/floor/PG 卷，三个服务均 healthy。API/web 只读根文件系统、cap-drop ALL、no-new-privileges 已核对；API 使用指定前端/私有数据库双网络，DB 仅在内网以非 root 身份运行，旧 agent-demo 已停止。API 运行进程不持有迁移 owner 密码。通过运行账户的真实只读连接确认：`twinnku_app` 的 superuser、createdb、createrole、replication、bypassrls、inherit 均为 false，login 为 true；成员关系及对象归属为 0，public schema 和当前数据库 CREATE 权限为 false。29 张业务表具备 SELECT/INSERT/UPDATE/DELETE，`alembic_version` 仅可 SELECT；现网检查只读权限元数据，没有在生产执行 DDL 探针。

18 张原表的原有列在冻结前和升级后规范化汇总 SHA256 均为 `4fd87c68f52cf0a69ecf0bde7b789d5891e4ace2cb4f40facb59a5177ec1f8d3`。原有 5 名后台成员保留：管理员 1、编辑员 3、审核员 1；升级前 4 条员工会话按 `0009` 计划撤销为 0，需重新登录。未 seed、重导地图、发布或改写团队路线内容。

实际有效配置为 `AGENT_PUBLIC_ENABLED=false`、`VOICE_ENABLED=false`、`NK_GENIOS_WEB_ENABLED=false`、`ADMIN_MFA_ENFORCED=false`；`/agent/embed.html` 返回 410。上线后只读 MFA 预检观察到启用管理员 1、verified 认证器 0、剩余恢复码 0、临时密码用户 0，`ready=false`，未输出用户名。管理员主/备用认证器的分别验证、恢复码本人保存与真机登录尚未完成，不能提前强制 MFA。

## 产品与内容边界

团队通过后台设计、维护和独立审核路线内容。前台读取任意已发布路线，不硬编码团队六条路线、不自动挑选站点、不生成或发布讲解稿。

- 路线可配置封面；每站可配置标题、多个讲解段落、来源说明、地图/图片/楼层主视图，以及对应图片、楼层、视频、VR、打卡资源。段落有稳定 ID；资源绑定类型、ID 和 revision。旧路线没有 `segments` 时兼容原单段讲解。
- 草稿支持后台权限范围内的效果预览，使用员工会话与预期草稿 revision；没有公开预览 token。预览不记录公众参观进度。所有引用须当前公开有效；引用资料更新或下架后，旧路线不会继续暴露失效资源，需内容负责人复核并重新发布。
- 公众入口提供线上参观和线下步行；浏览器保存站点、段落与音频片段/秒数，二维码只携带已发布路线与位置，不携带访客/员工 token。接续参观和版本变更须确认，讲解由用户点击开始。
- 地图、楼层、视频、VR 是段落可使用的真实资源。VR 仍在已核验的 HTTPS 原网站打开，本站保留路线；`external_requested` 只表示请求打开外站，不表示画面加载成功，也不表示小开能看见或控制跨域 VR。
- 追问、打开资源、切换段落、页面隐藏会暂停讲解。单一音频主控协调导览、小开与视频；继续讲解需点击，重新取得许可后使用当前段的书签。旧许可、旧字幕和旧进度不能复活或污染新段。

主要实现：[路线 DTO/服务](../apps/api/app/modules/experiences.py)、[分段播放器](../apps/web/src/features/experiences/ExperiencePanel.tsx)、[参观状态](../apps/web/src/features/visit/session.ts)、[讲解播放器](../apps/web/src/features/visit/TourNarrator.tsx)、[音频主控](../apps/web/src/features/visit/audioOwner.ts)。

## 公众小开、云语音与费用边界

`AGENT_PUBLIC_ENABLED=false` 为默认值，也是本次上线后的实际值；真实网络、供应商及设备验收通过前保持关闭。云 TTS 同时关闭，旧 SDK 入口已实际返回 410。启用后公众点击小开即可建立本站匿名会话，无需员工账号或共享访问口令。私有口令入口保留，网页只使用本站原生 API。学校问答模型、Qwen3 TTS 和 Cherry 音色未替换。

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

1. 新 schema 和受限运行角色已上线并完成现网只读验收，`ADMIN_MFA_ENFORCED=false` 仍作绑定阶段。已绑定的账号始终必须验证 MFA，不因全局开关关闭而降级。
2. 每个启用的管理员使用自己的密码登录；若账号要求修改临时密码，先完成修改。登记主认证器并签名验证，再登记独立备用认证器，并用备用本身签名验证。应在实际使用的电脑/手机上退出后分别登录验收，不把测试签名或注册返回成功当作真机完成。
3. 获取 10 个恢复码并离线保存；服务端只保存 256 位随机码的哈希。原文只在本次生成响应出现，重新生成会作废旧码。预检只能证明码已生成且尚有剩余，不能证明持有人已经保存。
4. 在运行镜像执行只读预检：`docker compose run --rm --no-deps api python -m app.modules.admin.mfa_preflight`。所有启用管理员均须无临时密码、至少两把分别 verified 的认证器、至少一个未用恢复码，否则退出非零。
5. 保存预检和真机验收记录后再设置 `ADMIN_MFA_ENFORCED=true`，重建运行容器并逐角色验证登录、scope、独立审核、最近 MFA 与闲置失效。强制开关覆盖所有员工，预检重点防止管理员全部被锁在外面。

恢复码需先通过自己的密码及 pending 流程；成功使用一次后作废，撤销旧认证器和全部会话，只开启 15 分钟重新绑定窗口，不直接生成业务会话。重新绑定后仍需验证主/备用与保存新的恢复码。最后一把认证器不能在网页直接删除。所有因素均丢失时，由获授权运维在已认证、交互式服务器控制台执行 `python -m app.modules.admin.mfa_recover --username <员工名> --reason <维护工单>`；可选隐藏输入临时密码，但不能通过脚本伪造员工会话、提升角色或绕过绑定。控制台恢复的人身份核验与工单由运维承担，目前尚无生产演练记录。

证据：[MFA HTTP 流程](../apps/api/app/modules/admin/mfa.py)、[会话与 step-up](../apps/api/app/modules/admin/security.py)、[只读预检](../apps/api/app/modules/admin/mfa_preflight.py)、[控制台恢复](../apps/api/app/modules/admin/mfa_recover.py)、[P-256 签名边界测试](../apps/api/tests/test_staff_mfa.py)、[生产 cookie 测试](../apps/api/tests/test_production_cookies.py)。

新建、修改、后台重置和控制台临时密码统一采用离线密码策略。来源为 [SecLists 官方 MIT 集合](https://github.com/danielmiessler/SecLists)，其 [维护者说明](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/README.md) 明确 Xato 集合按常见程度排序；本批处理密码子集，没有用户名/账号组合。完整来源快照 SHA256 已核对，从 1,000,000 项中按原顺序提取前 3000 个符合 12–128 字符政策的候选，并附前 10000 个历史泄露候选的完整 SHA256 与 casefold 变体，衍生文件控制在 1 MB 内。本站名称、学校/产品名称与实际角色词及其数字/标点装饰变体也会拒绝；不要求大小写/数字/符号组成、不定期强制换密。原文字只在构建过程内存处理，不写入仓库，用户密码及哈希不外发。缺失/损坏策略文件时拒绝新密码操作；已经验证成功的旧登录仅更新 Argon2 编码，不被当成新密码创建，也不修改原始密码。有限历史集合中未命中不代表从未泄露。[策略与校验和](../apps/api/app/password_policy.py)、[来源/许可/规模记录](../apps/api/app/data/README.md)、[离线重建工具](../scripts/build_password_blocklist.py)、[HTTP 无副作用与故障测试](../apps/api/tests/test_password_policy.py)。

员工“我的有效会话”仅显示本人仍有效的会话、服务端时间、创建/活动/过期时间与当前标记；随机 UUID 只用于定位，不是登录凭据，接口不返回 token、哈希或 IP。可撤销单个其他会话或全部其他会话，操作要求精确 Origin、CSRF 及最近 5 分钟 WebAuthn UV，绑定阶段也不允许密码会话直接撤销。自己的当前会话通过退出登录结束；他人和未知 ID 均返回 404，撤销后旧 cookie 立即失效，旧 pending 证明也失效。账号切换取消旧请求，界面不会显示上一账号列表。[后台接口](../apps/api/app/modules/admin/sessions.py)、[会话界面](../apps/web/src/features/admin/MfaAuth.tsx)、[签名与授权测试](../apps/api/tests/test_staff_sessions.py)、[迁移保真测试](../apps/api/tests/test_staff_session_migration.py)。当前实现允许多个独立浏览器会话，没有统一账号并行数量上限；员工列表与单个/其他撤销不是全员管理入口，此政策及集中撤销待单独评审。

## 部署预检与顺序

本批源码迁移链为 `0008_campus_tours` → `0009_staff_mfa` → `0010_public_agent_security` → `0011_upload_budgets` → `0012_staff_session_ids`。四项新迁移已在生产顺序执行，健康检查确认 head 为 0012。0012 单项迁移保留既有 token 哈希、CSRF 与时间字段，只新增随机会话定位 ID；SQLite 和实际隔离 PostgreSQL 升降级保真测试已通过。0009 按计划撤销升级前员工会话，两者不能混为账号或内容损失。API/web/契约已配套升级。路线配置继续在既有 JSON 内容快照中存储，无需导入团队路线或重做地图。

1. 宿主已按官方顺序从 Ubuntu 20.04 经 22.04 升级至 `24.04.5 LTS`，实际内核 `6.8.0-146`；目标系统重启、运维登录及容器健康检查通过。最初未启用 ESM、没有 Ubuntu Pro 的 20.04 已离开标准安全维护，不能继续以应用容器加固替代宿主更新。[Ubuntu 官方维护周期](https://ubuntu.com/about/release-cycle)。SSH 已恢复为 `twinnkuops` 密钥登录与 sudo 运维，root/密码登录关闭。
2. 取得完整备份、恢复密钥及恢复结果。保留用户选择的服务器本机加密 restic 备份，不声称已配置异地副本。`scripts/backup.py` 备份 DB dump、地图/楼层/媒体原件、私有部署配置及明确指定的 Nginx 配置；`scripts/restore_backup.py` 只恢复到新私有目录和隔离 PostgreSQL，不切换生产。密码文件不得进入 Git、日志或公网目录。
3. 核对准确 HTTPS Origin、允许主机、可信代理链、独立 `DB_APP_USER` / `DB_APP_PASSWORD` 和迁移 owner；`.env` 为未跟踪的 0600 文件。先保持 `AGENT_PUBLIC_ENABLED=false`，收费服务先关闭待验；沿用实际服务商/模型/音色配置。不要输出包含密钥的 `docker compose config`，使用 `docker compose config --quiet`。
4. 上线前加密备份已在隔离数据库实际恢复并迁移到 `0012_staff_session_ids`，受限角色与旧内容保真验收通过，具体范围见下文。生产也已完成迁移及降权：在线 API 使用受限 DML 账号，迁移容器单独持 owner；在线账号无对象归属、超级用户/创建角色/DDL 权限，不能写 `alembic_version`。
5. 镜像全量证据、唯一测试环境失败的定向修复结果、恢复迁移证据及运维入口均核验后，已应用固定源码/配置并切换上述不可变镜像；原源码和 0600 环境文件保留。一次性 migrate（含角色授权）、健康、运行身份、原公开资料及 18 表原列保真检查通过；升级中未 seed、重导地图或自动审核路线。上线后公网 26 项主检查和 2 项楼层补测通过，包含配套安全响应头及 SDK 410。自动 HTTP 检查不代替员工真实登录、真机视听或外部付费验收。
6. 按上一节完成员工主/备用/恢复码与强制 MFA。随后在批准的小额度内逐项真实验收学校会话/问答、TTS 内联或精确下载域名、费用计数、设备发声和取消，记录供应商真实结果；只有这些及 PostgreSQL 保护通过后才考虑开启公众开关。
7. 内容负责人在后台预览、提审并独立发布实际路线；逐段检查真实来源、资源 revision、返回讲解、二维码接续和下架失效。自动测试夹具不是校园实际内容。

2026-10-03 `03:43 UTC`（北京时间 11:43）的上线前本机加密备份已通过 `restic check` 和实际隔离 `pg_restore`；逐 DB 引用验证 265 张 map tiles、100 张 floor images、1 个 floor original、53 个 media originals。恢复结果 `production_modified=false`，没有把恢复数据写回生产。它覆盖备份当时的资料；团队之后编辑的内容应由后续快照保存。

该恢复副本使用固定候选 API/DB 镜像实际完成 `0008` → `0012`，检查运行角色所有高权限 flags、成员关系、对象归属以及 DDL、`alembic_version` 写入拒绝。18 张旧业务/账号表的原有列按行规范化 SHA256 在迁移前后相同，包含 `staff_users`；升级前 4 条 `staff_sessions` 按 0009 计划撤销为 0，单独记录。`restored-migration-receipt.json` 实际为 `status=passed`、`runtime_role_verified=true`、`content_unchanged=true`、`production_modified=false`，绑定上述冻结源码及实际 API/DB 镜像。这是上线前恢复副本的证据；生产迁移和只读权限验收另行完成，不能把隔离 DDL 探针描述为生产操作。

本机备份 timer 为 active，每天约 03:00（Asia/Shanghai，随机延迟最多 5 分钟），保留 14 个日快照、4 个周快照，并明确覆盖现用 Nginx site。restic 固定 0.19.1，安装时核对官方 SHA256。升级后发现的 systemd 服务未提供 HOME 或 XDG_CACHE_HOME、导致 restic 无法确定缓存目录的问题已用宿主 drop-in 修复；真实 systemd unit 于 `04:54 UTC`（北京时间 12:54）执行成功，快照为 `1b66846fb22472ee4773a5b72d01867a5e675ba81274535c7b1d699ea312a20c`。这份快照覆盖上线前状态，新版在线备份见下段。对应运维单元修复单独提交为本地 `fb545f5691cac10e4a1f6f9185d12b177dd69079`、远程 `a05c847f4674a4f3181e1785a06b5509e03bbbbe` / 树 `89de585aa060d4a0425f294c4c2a844908df41fa`，没有重打包应用候选。用户选择备份仍在同一服务器；整机、磁盘丢失或该服务器完全受控时，这些本机快照不能提供独立灾备。

新版上线后，真实 systemd unit 于 `05:15:16—05:15:20 UTC` 完成备份，InvocationID 为 `5d502275df0b44e5b6a34a7c252e30b5`，新快照为 `8688c6b35bd3d55e5cadfed57027c6534eaff1d97f6428c55ca921b436ebedd8`，数据库 dump SHA256 为 `c4ec1994c23b565510f25d0b9a8930bc1f5f6be04e758f235942371375cc4f18`，记录 head 0012、30 张表；备份仓库当时占用 489624280 字节。旧上线前快照已附独立 tag `twinnku-precutover-1.7.0-20261003`，内容树不变，带 tag 后快照 ID 为 `4a4581bda18b2beea668ee70a9af498d903416af7064a72494ebee5eb03fce32`，避免同日保留策略移除回退批次。新版备份的私有回执为 `/root/twinnku-production-cutover-20261003/post-release-backup-receipt.json`；该固定新版快照随后实际完成 `restic check --read-data`、恢复文件校验和隔离 `pg_restore`：30 张表、head `0012_staff_session_ids` 与 dump SHA 一致，逐 DB 引用核验 265 张地图瓦片、100 张楼层图片、1 份楼层原件和 53 份媒体原件；`production_modified=false`。回执位于 `/root/twinnku-production-cutover-20261003/restore-live-1791005245272355297/restore-receipt.json`，SHA256 为 `5147ffb19b218df41c9c396175ad94475a42390b59e92552e3a109a952e1564a`。临时数据库仅在隔离环境运行并按所属标签和完整容器 ID 清理，没有触碰生产库或原资源卷。

宿主升级前为 Docker Engine 28.1.1、containerd 1.7.27；两者分别位于 [CVE-2026-92543 注册表 TLS 降级](https://github.com/moby/moby/security/advisories/GHSA-7cfq-22r6-qp73) 和 [CVE-2026-53493 OCI 索引拉取耗尽资源](https://github.com/containerd/containerd/security/advisories/GHSA-pg57-6jwg-q645) 的影响范围。本轮已通过 [官方签名 APT 源](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository) 实际安装并验收 Docker Engine `29.8.2`、containerd `2.3.6`、runc `1.5.1`；保留原 daemon 配置、`overlay2`、`/var/lib/docker`、容器和全部既有卷。官方 Ubuntu 公钥主指纹核为 `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`。[官方存储说明](https://docs.docker.com/engine/storage/containerd/) 明确旧版原地升级继续 overlay2，本轮未启用 snapshotter/实验迁移或删除数据目录。

公网代理实际拒绝 TLS 1.0 / 1.1，TLS 1.2 / 1.3 和证书验证通过；已启用 `Strict-Transport-Security: max-age=31536000`、`www` → 主域 308 及转发身份头净化。SSH 已禁用 root 登录和密码认证；`twinnkuops` 全新密钥登录及 `sudo -n` 成功，本地 `myserver` 默认用户已切为 `twinnkuops` 并验证。此前间歇超时已结合 auth.log 和 Fail2ban 确认：本次 root 负向认证验收触发了已知管理出口 IP 的误封；仅解封该 IP，没有设置永久白名单或放宽 root/密码认证。运维入口现已恢复，不能继续列为部署阻断项，也不应重复负向认证触发封禁。

## 关闭与回滚

先关闭 `AGENT_PUBLIC_ENABLED` 与云收费服务，保留图文/地图/楼层/公开路线；已有公众会话也会被服务端开关拒绝。停止浏览器播放不会撤销已提交的供应商收费。工作人员被 MFA 锁住时使用上述恢复流程，不通过关闭强制 MFA 绕过已绑定账号。

故障处理优先在保留新 schema 的前提下前向修复。旧 `1.6.4` API 不能直接接到 `0012`：新员工会话字段存在非空约束，旧登录写入不兼容。不要只启动旧容器、自动 Alembic downgrade、清空卷或旧 seed。确需回退时先关闭后台与付费入口，使用部署前回执中的实际旧镜像身份和配套私有配置；原 `.env` 的旧版本标签与当时实际镜像不完全相同，不能凭标签猜测。数据库恢复先在隔离目录验证；正式切换前明确保存或处理重新开放后产生的数据，避免覆盖新增编辑。恢复脚本没有生产切换功能。

## ASVS 5.0.0 适用 L2 控制映射

使用 [OWASP ASVS 官方 v5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0) 的固定版本编号；L2 范围包含适用 L1 前置控制。以下是本批相关项的证据清单，**不是完整 ASVS 评估、认证、渗透测试或绝对安全保证**。`本地证据` 不等于生产控制生效；不存在的模块应说明不适用理由，不能把未检验项默认为通过。

| 控制 | 本批证据与状态 |
| --- | --- |
| [v5.0.0-1.2.4 / 1.2.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x10-V1-Encoding-and-Sanitization.md) | ORM/参数化 SQL；图片、视频处理固定参数子进程，禁止 shell 拼接。本地测试/静态扫描；完整注入评估待做。 |
| [v5.0.0-1.3.6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x10-V1-Encoding-and-Sanitization.md) | TTS HTTPS 精确名单、公共 DNS、固定 IP 连接、不跟随重定向及有界下载；`test_voice_rotation.py` 有 SSRF 拒绝用例，真实域名待验。 |
| [v5.0.0-3.3.1 / 3.3.2 / 3.3.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | __Secure-/Secure/Strict/HttpOnly 配置已上线；HTTPS HTTP 边界测试覆盖新名、拒绝旧名和注销。公网旧 cookie 不授认证返回 401 已验；没有真实有效员工/访客会话，新 cookie 签发属性与已认证 CSRF 尚待登录验收。 |
| [v5.0.0-3.3.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 部分：当前按 API 路径隔离使用 __Secure-，未使用要求 Path=/ 的 __Host-；域树威胁评估和例外审批尚未完成。 |
| [v5.0.0-3.4.1 / 3.4.3 / 3.4.4 / 3.4.5 / 3.4.6](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 固定 web 候选的实际 HTTP 隔离检查已验证 CSP self/对象禁止/base-uri none/禁止被框架嵌入、nosniff、Referrer-Policy。上线后 26＋2 次有界公网请求的安全头检查通过，涵盖页面、资源、JSON 与所测错误响应；没有声称覆盖全部路径。HSTS max-age=31536000 和 www 308 已验；未知子域未承诺 HTTPS，L2 includeSubDomains 项部分。 |
| [v5.0.0-3.5.1 / 3.5.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md) | 精确 Origin、CSRF 和非 GET 敏感调用；员工/访客/语音边界测试。公网异源拒绝 403 已验，有效会话的 CSRF 流程尚待本人登录。 |
| [v5.0.0-4.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x13-V4-API-and-Web-Service.md) | 两层代理覆盖身份头，API 精确可信 peer；伪造 IP 用例及固定 web 候选隔离代理净化检查已测。配套 Nginx/Uvicorn 已上线，现网容器网络身份已核对；完整可信/不可信入口矩阵不能由普通公网成功请求代替。 |
| [v5.0.0-5.1.1 / 5.2.1 / 5.2.2 / 5.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md) | 上传格式/字节/像素/解析时间、CPU/内存/并发及 actor/campus 持久额度；内部生成路径，拒绝链接/越界；`test_uploads.py`。实际候选的有界子进程、六种真实视频 codec、原件字节保留与凭据隔离检查通过；现网 UID/容器隔离已验，真实登录后的上传仍待验。 |
| [v5.0.0-5.4.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x14-V5-File-Handling.md) | 尚无已验证 AV 扫描链；格式校验、重编码与审核不能替代此项。 |
| [v5.0.0-6.3.1 / 6.3.3 / 6.3.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 持久登录限流、密码后 WebAuthn UV、pending 不授业务权限、所有入口统一校验。暂留绑定阶段；未强制且未真机验收前不能称生产 L2 MFA 通过。 |
| [v5.0.0-6.4.3 / 6.4.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 恢复不生成业务会话，只允许重新绑定；密码/码与控制台审计已测。人员身份核验、维护工单和真实恢复演练待补。 |
| [v5.0.0-6.5.1 / 6.5.2 / 6.5.3 / 6.5.4](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | CSPRNG 256 位恢复码、SHA-256 存储、一次性消费、重新生成撤销；HTTP 签名/恢复测试。 |
| [v5.0.0-6.2.4 / 6.2.11 / 6.2.12](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x15-V6-Authentication.md) | 离线按频率选择至少 3000 个合规常见候选、10000 个历史泄露候选、组织/角色词及变体；完整 SHA256 只用于拒绝，凭据仍 Argon2id。来源、许可、校验和和无副作用边界测试；非实时完整泄露数据库，生产操作待验。 |
| [v5.0.0-7.2.1–7.2.4 / 7.3.1 / 7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 服务器校验随机哈希会话、登录轮换、员工闲置/绝对失效、访客绝对失效。本地边界证据；匿名访客不是员工身份认证。 |
| [v5.0.0-7.4.1–7.4.4 / 7.5.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 注销/停用/凭据变化撤销；可见退出入口；敏感凭据操作 recent MFA。本地覆盖；所有受保护页面可达性和真机待验。 |
| [v5.0.0-7.5.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 本人有效会话列表、单个/其他撤销及当前注销；撤销必须 5 分钟内 UV（绑定阶段也强制）、Origin/CSRF。后台真实 P-256 及授权边界 16 passed，含旧 pending 签名撤销后失效；前台 request 与切号竞态 4 passed。功能已上线，真实员工登录、认证器和会话撤销仍待本人验收。 |
| [v5.0.0-7.1.2 / 7.4.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | 部分：并行浏览器会话暂无统一数量上限，上述政策需审定；管理员停用/重置及控制台恢复可撤销单用户，但尚无独立全员集中撤销入口。自身列表不替代这两项。 |
| [v5.0.0-8.1.1 / 8.1.2 / 8.2.1–8.2.3 / 8.3.1](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md) | 四角色、campus/point scope、独立审核、状态/revision/字段和动作许可在后端强制；公开段落与私有预览不共用授权。权限矩阵测试通过，原 5 名生产成员保留；公网匿名私有入口 401 和真实未发布资料 404 已验，各角色有效会话/scope 与独立审核仍待本人验收。 |
| [v5.0.0-13.1.1 / 13.2.2–13.2.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x22-V13-Configuration.md) | 出站学校/TTS 服务和名单已记录；Compose 迁移/运行账号分离、私有 DB 网络已上线。隔离恢复迁移角色/DDL 拒绝通过，生产只读目录查询确认运行角色 flags/成员/归属/权限；学校 TCP 超时、TTS TCP/TLS/无认证 HEAD 可达，真实收费调用未验。 |
| [v5.0.0-13.2.1 / 13.3.1 / 13.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x22-V13-Configuration.md) | 部分：服务端密钥、0600 私有环境文件、运行/迁移账号分离已上线；实际 API 进程密码与 runtime 密码一致且不同于 owner，仅以布尔值记录，API 的 DB_APP_PASSWORD 为空。未部署独立 secrets manager 或短期服务凭据，不能标完整满足。 |
| [v5.0.0-16.2.5 / 16.5.1–16.5.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) | 安全诊断与一般错误文案；DB/额度失败关闭；密钥/正文/上游异常不入访问日志，相关测试。 |
| [v5.0.0-16.1.1 / 16.3.1–16.3.3 / 16.4.2 / 16.4.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md) | 部分：已有员工审计、容器日志轮转；全栈日志保留/访问清单、全部拒绝事件、独立防篡改收集与告警闭环尚未验收。 |

## 验证记录与交付限制

本地实际执行：后端公众/小开/云语音相关 87 passed，SDK/资源/部署诊断回归 71 passed；前端 native/cloud/visitor/dock 88 passed；本次讲解竞态新增 6 passed，生产 cookie/MFA/公众/native/admin 组 57 passed，语音/资源/guide 补充组 67 passed；离线密码策略（含构建顺序/来源校验）、生产 cookie、旧 MFA/后台回归最新 54 passed；员工会话后台 16 passed、前台 4 passed。前端本轮完整 Node 回归 366 passed，TypeScript 检查通过。先前真实 CI 的隔离 PostgreSQL 组也已通过：迁移/公开资料 7、公众持久额度与会话 4、运行角色保护 4；这是测试数据库实证，不能推广为生产迁移/授权完成。这些分组有重叠，不应相加为全量成绩；最终候选全量后端与 PostgreSQL 结果另以交付记录为准。

本轮用于构建和恢复验收的冻结应用候选为远程 `9e27ff9898fe058748393198e67a3005f2a77431`、本地 `6a726be0da74bbe14c5b6b40147eaafbc78ffe85`，两者 Git 树同为 `44af266ab2d7fb3d0efeaa2cca58f43780f18113`。396 个 tracked 文件的冻结 archive SHA256 为 `2180a105f89aa4c427118861bca33fdb9d4799326368bbe652167d396fa0869a`，规范化文件树 SHA256 为 `5e63b4f44958bd22878c2f246012e73988e73eda3f725ec5ccded3c28ade50dc`。备份单元修复的后续提交没有重打包这份应用，也没有改 API/DB 候选镜像。

冻结候选的实际 [Foundation run 37042698199](https://github.com/jiawenyi-2512921/TwinNKU/actions/runs/37042698199) 与 [Security run 37042698489](https://github.com/jiawenyi-2512921/TwinNKU/actions/runs/37042698489) 全部成功：CI 后端 561 passed、agent-demo 11 passed、前端 Node 366 passed / 0 failed / 0 skipped，类型、契约、构建和 Compose 检查通过。API、web、实际派生 PostgreSQL 三个运行镜像的 Trivy HIGH/CRITICAL 均为 0；API 最小 ffprobe 的签名/源码/组件证明、Grype 与漏洞 canary guard 通过。DB 真实非 root fresh volume、原官方 UID70 物理卷接续、重启和 stdin dump 恢复均通过，gosu 实际不存在。CI 结果不能替代服务器上的完整 API 镜像测试。

上一次已完成的文档/运维验证 [CI run 37096131647](https://github.com/jiawenyi-2512921/TwinNKU/actions/runs/37096131647) 与 [CI run 37096131651](https://github.com/jiawenyi-2512921/TwinNKU/actions/runs/37096131651) 已核实均为 success；本次未重新逐日志抄录测试数量，前述数量来自已逐项核对的冻结候选 run。应用镜像仍绑定冻结树 44af，没有因运维或文档增量重建；这两条 run 不代表本文后续提交的 CI 已执行。

[CI 安全工作流](../.github/workflows/security.yml) 钉住 action SHA、工具版本和 Gitleaks 校验和，镜像 HIGH/CRITICAL 仍阻断。源码及依赖扫描包含 Bandit、pip-audit、npm audit 与 Gitleaks 全历史；Gitleaks 只输出 RuleID/Commit/File/StartLine/Fingerprint，不输出或上传 Secret/Match/人员信息。远程历史配置测试的两条告警已按相同 blob/测试内容核验；`.gitleaksignore` 共五个精确历史夹具指纹，不忽略测试文件、整条规则或目录。源码扫描与组件扫描均按实际范围记录，零已知 HIGH/CRITICAL 不等于不存在漏洞。

服务器实际 API 候选镜像的第一轮完整测试耗时 18 分 16 秒，结果为 **560 passed / 1 failed / 0 skipped**；唯一失败为 `test_deployment_bootstrap.py::test_existing_project_blocks_first_install` 调用测试环境未安装的 `bash`，异常 `FileNotFoundError`。六种真实视频 codec 验收和四项持久 PostgreSQL 验收实际通过。原完整 receipt、JUnit 和控制文件已逐字节保留。随后仅为测试镜像补齐 bash，实际重新运行整个 bootstrap 文件：8 passed；demo：11 passed；4 项余下契约检查和 Ruff 通过。生产源码、API/DB 镜像及候选层绑定均未改变，修复回执为 `environment-repair-receipt.json`、`status=passed`。其覆盖依据为首轮通过的 560 项加上定向修复中通过的唯一失败项，独立覆盖 561 项；**没有再跑或伪造一份单次全量 561 全绿 JUnit**，CI 的 561 passed 与服务器这两轮证据分别记录。

上线后 `05:04:28—05:04:45 UTC` 实际公网主检查 26 项全部通过，包含首页/后台壳和 hash 资源、1.7.0 版本、live/ready、公开点位/地图瓦片/VR目录/媒体/路线、匿名后台/草稿/上传拒绝、真实未发布资料隐藏、旧 cookie 不授认证、公众助手关闭、异源拒绝、匿名云播报拒绝和任意文字计费代理拒绝。`05:07:43—05:07:44 UTC` 补充楼层 metadata 200 与原图前 65536 字节 Range 206 两项通过；这是有界前缀检查，没有宣称公网整张图 SHA 或真机渲染已验。全部请求检查安全头，没有创建账号、有效会话或调用供应商；新 cookie 签发和有效会话 CSRF 不在该结果内。

私有原始证据位于 `/root/twinnku-validation-20261002` 和 `/root/twinnku-production-cutover-20261003`，不将真实环境、凭据或业务行内容提交仓库。生产发布回执为后者的 `deployment-receipt.json`，现网只读身份/权限回执为 `runtime-api-receipt.json`；18 表原列的升级前后保真记录在 `freeze-backup-1791003221212071725` 子目录。本地保存的回执校验和如下：

| 回执 | SHA256 |
| --- | --- |
| 首轮完整 `receipt.json` | `9fbd45b89031418b25d436b9a6fc9d344af6eabb351119df4e459ef8397dd120` |
| 首轮原始 `api-junit.xml` | `6781165947b8286858686c1beb606517fc5421e7ad13018e7e33acbc709377f3` |
| 定向 `environment-repair-receipt.json` | `fd37c58defacf9f74a9f397577742bb7737da17f1f57c5035a92e7d3c709357a` |
| 上线后 `public-http-smoke-20261003-final.json` | `ca740c09f4f19d5ec64f2e281cfda0c2a0d0e55470f520c9b7cdc7757f51b4ef` |
| 楼层 `public-http-floor-supplement-20261003.json` | `a663a11d549c91be7fdc3a1b043d5b03ce14c938b84dfa8f15158d13870d4824` |

2026-10-03 `03:58 UTC` 从仍运行的 `1.6.4` API 容器作有限、无认证的供应商检查：学校 `coze.nankai.edu.cn` DNS 正常解析到 `222.30.38.25`，TCP 443 在 3 秒期限内超时，未进入 TLS/HTTP；同期电脑访问学校入口取得 HTTP 302，响应来自学校飞连网关。这支持两条网络路径存在差异，不能据此断言美国服务器地理位置是唯一原因，也没有验证学校 API key 或实际问答。语音实际配置是阿里云北京 MaaS 工作区 origin，TCP 可连接、TLS 1.3 和证书验证通过，无认证根路径 HEAD 返回 404；根路径 404 不能证明语音接口、鉴权、模型或额度正确。本轮没有发送模型或 TTS 合成请求，也没有配置 VPN。浏览器 CUA 会话超时，电脑/手机界面和发声尚未视觉实测。

上线后从新版实际 API 容器再次作 DNS/TCP/TLS 有界检查：学校域名仍解析为 `222.30.38.25`，TCP 443 仍在 3 秒连接限时内超时，未进入 TLS；总计约 3.45 秒，没有发送鉴权信息或模型请求。

仍待完成：确定学校上游网络接入方案；在批准额度内真实验收学校 API/云语音、持久计数和取消；本人有效登录的新 cookie 签发/CSRF、主/备用认证器、恢复码保存和控制台恢复；各角色实际 scope/独立审核、团队路线预览与电脑/手机视觉、资源返回、二维码接续和发声。学校服务器 443 超时与电脑飞连网关 302 只证明路径差异，未选择 VPN 或中转方案。生产 1.7.0、迁移、受限角色、原资料保真、SSH 恢复、新版完整备份与隔离恢复、26＋2 公网 HTTP 边界检查已完成；本轮未发布或改写团队正在维护的内容。继续保持公众助手/云 TTS/旧 SDK 关闭、MFA 登记阶段，不能把 HTTP 或隔离测试推广为真实供应商和设备验收。
