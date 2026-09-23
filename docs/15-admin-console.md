# v0.4.0 管理后台：账号、地图编辑与审核发布

本次交付代码分支 `feat/admin-console`，在 `feat/floor-viewer-m05` 基础上增加后台。入口是站点同域的 `/admin`。使用现有 React/TypeScript/Leaflet、FastAPI、PostgreSQL 技术栈，不引入另一套地图或后台数据库。M01点位工作流与M02员工账号先落地；员工SSO、素材上传后台和楼层内部点位编辑仍为后续模块。

## 1. 交付范围与地图约定

- 工作台展示当前授权范围内的点位、草稿、待审、下架数量；不是全校统计泄露给局部账号。
- 校园地图编辑器支持浏览、点击定位、拖动定位锚点、两角框选矩形、点击绘制多边形、拖动或删除边界顶点、撤销最近40次已应用的位置调整。多边形绘制中也可以逐点撤销或取消。
- 支持搜索、正式状态筛选、分页、点位分类、别名、简介、可见范围、资料依据；不能为空名称。未命名建筑不会自动建立点击区域。
- 审核时展示草稿与正式资料，已改动的正式边界以灰色虚线对照，草稿范围为紫色；地图原有图块保持不变。
- 新增文字选项默认开启，采用与图像同比例的普通SVG文字，不增加编号或常驻浮动卡片。已有底图文字默认不重复标注。
- 周恩来雕像稳定ID `82e888ca-59f8-5c55-b8ab-4b80175c6ceb` 保持不变；迁移把其 `label_on_map` 初始化为true。其余已有文字依然在底图内。雕像坐标不变：原图像素(4613.818,4251.496)，位于业务西楼与业务东楼中央。
- **底图内已经烧录的名称不是数据库字段**。修改名称、下架或关闭显示只能改变交互/额外SVG文字，无法擦掉图片里的旧字。需要改底图文字时另行制作并审核新的底图版本；不得通过重压缩或AI重绘整幅图来替代精确编辑。
- 公开入口只返回 `published + public` 的点位。内部/受限点位即使发布也不会对公众显示；当前没有访客申请权限后查看内部资料的流程。
- 当前后台编辑校园点位，不提供上传地图/楼层原图、房间编辑、任意图内跳转或路网编辑。楼层继续使用已有标注图导入流程，不能把本次能力描述成完整楼层管理。

## 2. 权限模型

| 角色 | 查看点位/草稿 | 新建与编辑 | 提交/撤回 | 审核/发布 | 账号授权 | 操作记录 |
| --- | --- | --- | --- | --- | --- | --- |
| 管理员 admin | 全部 | 全部 | 全部 | 可，但不能审核自己参与的变更 | 全部 | 全部 |
| 审核员 reviewer | 授权范围 | 否 | 否 | 授权范围内，可发布/退回 | 否 | 授权点位 |
| 编辑员 editor | 授权范围 | 授权范围 | 可提交；只能撤回自己参与的变更 | 否 | 否 | 授权点位 |
| 只读成员 viewer | 授权范围 | 否 | 否 | 否 | 否 | 否 |

非管理员必须指定至少一个已启用校区。`point_ids=[]` 表示所选校区全部点位；非空则进一步限定到所列建筑/景点，列表、详情、几何、审核和点位日志一致限制。指定点位必须属于授权校区。限定到指定点位的编辑员不能创建新的未授权建筑；全校区编辑员和管理员可新建。

管理员是全局角色，不允许附加局部scope混淆权限。新成员必须显式设置角色与范围，不能自行注册。不能停用、降级自己的管理员账号；本人密码通过验证当前密码的入口修改。管理员可停用其他成员、改角色、改范围或重置临时密码。停用是保留历史身份的状态变更，不删除账号或审计。

所有校验在后端执行。隐藏按钮仅改善操作体验，不能作为权限控制。权限来自数据库和服务器会话；前端不能提交“我是管理员”。相同账号参与草稿编辑或提交后，连管理员也不能批准该次变更。它验证的是独立账号，无法证明两账号背后一定是不同自然人，需组织安排实际分工。

## 3. 状态、并发与可恢复操作

1. 新建点位先得到稳定UUID及未发布记录，`point_changes` 保存草稿；公众无法读取。
2. 修改已发布点位只写草稿，正式名称、介绍、几何不变。
3. 提交后变为 `in_review`，暂不允许继续改；需撤回或退回。
4. 另一位具备审核权限且不在本次贡献者/提交者名单中的账号进行审核。退回为 `rejected`，保留意见；发布时原子更新正式点位与几何，并递增正式revision。
5. 下架申请是 `operation=retire` 的待审变更。审核通过后正式点位变为retired，公共点位、地图点击及所属楼层入口一起隐藏；无硬删除。底图印刷文字仍可见。
6. 恢复：筛选“已下架/可恢复”，编辑并保存新草稿，再由独立账号审核发布。不是绕过审核的一键复原。
7. 撤回保留草稿快照和审计，但不把撤回内容当作待发布状态。重新编辑产生新的草稿revision。

每次更新携带 `expected_revision`（草稿；从未有草稿时为0）与 `expected_point_revision`。提交/审核携带草稿expected_revision。过期返回409，前端保留输入并提示重新载入；不能自动覆盖。后端锁定点位行串行处理该点位的写操作，并对草稿/账号使用SQLAlchemy版本列。管理员变更串行锁定管理员记录并重新核验操作者身份，防止两个管理员同时停用彼此。

`map_revision` 表示图片版本，与点位发布revision分离。几何保存须匹配当前已发布公共校园图的校区和revision；坐标以原图左上角为(0,0)，单位为原生像素，Y向下，不使用GPS或缩放后的屏幕像素。锚点和3–200个顶点必须在图内，范围不得退化、自相交或重复顶点。已有标注锚点可能位于建筑外，故不强制锚点位于多边形内部。

未保存内容留在浏览器内存，离开页面有提示，不写localStorage。同一身份与范围在会话失效后重新登录可继续本页输入；切换账号/权限范围后清空原工作区。网页刷新或关闭仍会丢失未保存内容。已保存草稿在数据库中保留。

## 4. 会话和账号实现

- Argon2id密码摘要（argon2-cffi，memory=65536 KiB、time=3、parallelism=2）；密码12–128字符，拒绝纯空白。库及底层bindings由uv.lock固定。
- 随机不透明会话token放在 `twinnku_staff` Cookie；数据库仅存token的SHA256；HttpOnly、生产Secure、SameSite=Strict、Path=/api/v1/admin。有效期默认8小时，可配置1–24小时，不做无限滑动续期。
- 所有写接口精确核对Origin；已登录写接口额外核对独立CSRF token，前端仅在内存保存。登录本身也校验Origin。无跨域开放配置。
- 登录错误统一响应。数据库原子计数限制每个用户名15分钟8次尝试、每个连接对端15分钟250次；限流在多worker间共享。用户名/IP均以摘要作为计数键。
- 当前不信任X-Forwarded-For，Nginx后面的连接对端通常相同，因此对端限额可能由全部人员共用；不能把它当成精准访客IP限流。大规模后台用户接入时应再设计受信代理链。
- 初始管理员由服务器交互命令建立，无默认密码。管理员创建/重置的其他账号首次登录必须改密码，再允许读取内容。
- 改密码、角色、范围或停用会撤销该成员已有会话；后续请求需要重新登录。已经进入处理的请求不是远程撤销事务，日志会保留结果。
- 修改账号与点位、提交、审核、下架、登录/退出均写审计。审计接口只读，无删除入口；保留before/after和提交依据，但不记录密码、密码摘要、token或CSRF。数据库管理员仍能直接改库，因此不宣称具备不可篡改的司法存证能力。
- 不提供SSO、MFA、自助找回邮件或扫码登录；这些不是本次已实现功能。

## 5. 已实现接口

前缀 `/api/v1/admin`，JSON统一Envelope，字段以`app/contracts.py`和自动生成的OpenAPI为准。GET带同域Cookie；写请求带Origin以及X-CSRF-Token（登录仅Origin）。

| 方法与路径 | 输入/用途 | 权限 |
| --- | --- | --- |
| POST /auth/login | StaffLogin；返回session+CSRF，设置Cookie | 未登录可用，受限流 |
| GET /session | StaffSession：用户、scope、permissions、到期时间 | 已登录，包括待改密码 |
| POST /auth/logout | 注销当前会话 | 已登录 |
| POST /auth/password | 当前密码、新密码；撤销全部会话 | 已登录，包括待改密码 |
| GET /campuses、/maps | 可选校区和已发布校园底图 | 内容就绪的成员 |
| GET /maps/{map_id}/points | 当前范围的正式及草稿几何 | points.read |
| GET /points | q、campus_id、status、draft_state、page/page_size | points.read |
| GET /points/{id} | AdminPoint，正式点位+几何+最新草稿 | points.read |
| POST /points | PointDraftInput，含geometry、source_note；201 | points.edit，完整校区范围 |
| PUT /points/{id} | PointDraftUpdate + 双revision | points.edit |
| POST /points/{id}/submit | ReviewRequest：expected_revision、note | points.edit |
| POST /points/{id}/discard | ReviewRequest；撤回，不硬删 | points.edit，管理员或本次贡献者 |
| POST /points/{id}/publish | ReviewRequest；发布或批准下架 | points.review，禁止自审 |
| POST /points/{id}/reject | ReviewRequest，意见不可空 | points.review，禁止自审 |
| POST /points/{id}/retire | PointRetireRequest：双revision、原因 | points.edit |
| GET /audit | point_id可选，page/page_size | audit.read，按点位scope |
| GET/POST /users | 分页人员列表 / StaffUserCreate | users.manage |
| PUT /users/{id} | StaffUserUpdate，expected_revision | users.manage |

分页默认25，最大100。错误401未登录/会话失效；403权限、来源或CSRF错误；404关闭功能/超出范围；409过期revision或状态冲突；422非法内容/坐标；429登录限流；503数据库未就绪。越权访问具体点位返回404，避免泄露其存在。用户输入不在错误响应中回显。

## 6. 部署方执行步骤

这一节是交给用户和DeepSeek的部署说明，**不表示本轮已连接服务器或已上线**。保留现有数据库、地图卷、楼层卷和`.env`；不要重新跑first-run，也不要删除卷。

1. 在当前仓库备份数据库（沿用docs/07的备份流程），记录当前commit/镜像及迁移版本。确认已有HTTPS域名可用。
2. 获取新代码，保留服务器未提交改动：

```bash
git fetch origin
git switch feat/admin-console
git pull --ff-only origin feat/admin-console
```

3. 在原`.env`中保留数据库密码，更新/增加下列配置，权限继续为600。实际部署域名不同应相应替换，Origin不带路径与结尾斜线：

```dotenv
APP_VERSION=0.4.0
ADMIN_ENABLED=false
ADMIN_PUBLIC_ORIGIN=https://2512921.cn
ADMIN_SESSION_HOURS=8
```

4. 先以后台关闭状态部署，执行迁移并保持公众导览运行：

```bash
bash scripts/deploy.sh
docker compose exec api alembic current
```

迁移head应为`0004_admin_console`。新增账号/会话/限流/草稿/审计表和几何标注开关。已有底图和楼层原文件不变，不需要重新下载资源包，不要用资源Release中的旧源码覆盖新代码。

5. 交互创建第一个管理员（密码从终端隐式输入两次，不放在命令参数、GitHub、截图或日志里）：

```bash
docker compose exec -it api python -m app.modules.admin.bootstrap --username campus.admin --name '项目管理员'
```

只允许空账号表首次初始化；重复执行会拒绝。若已有成员无需再次执行。账号名称3–64字符，小写字母开头，仅小写字母、数字、点、横线和下划线。

6. `.env`改为`ADMIN_ENABLED=true`后使API环境生效：

```bash
docker compose up -d --force-recreate api web
```

生产要求配置显式HTTPS Origin，否则启动校验会失败。Nginx的`/api/`同域反代和SPA回退已覆盖这些路径，不向公网单独开放API端口。

7. 访问 `https://2512921.cn/admin`。初始管理员先创建至少一个审核员和一个编辑员并分配校区；各成员首次登录设置自己的密码。管理员参与编辑后不能自己审批，避免实际工作卡在只有一个可用账号。
8. 用不同账号在非关键测试点完成保存草稿→提交→退回→重提→发布→申请下架→批准→恢复。公开浏览器单独检查每次状态。最后把测试点保持下架，不污染正式公开地图。

后台应急关闭：`.env`设置`ADMIN_ENABLED=false`后重新创建API，保留账号、审计、草稿与现有公开导览。不以`alembic downgrade`作为关闭后台方式，不通过回退数据库删除审计。正式代码回滚先核对兼容性；新版本公开SVG标注依赖label_on_map，旧代码不支持新建动态文字。

忘记成员密码由管理员在后台重置。所有管理员均不可用时需服务器运维人员按单独审核的恢复步骤处理；本版没有匿名找回和通用后门密码。

## 7. 验证与验收边界

- 本地后端：既有地图/楼层回归 + 新增HTTP权限、CSRF/Origin、账号生命周期、限流、发布隔离、退回、下架恢复、几何、过期revision测试。
- SQLite迁移upgrade与Alembic模型一致性已验证。GitHub CI在一次性PostgreSQL17中执行迁移、种子幂等与相同的发布/下架/恢复流程；只以当前提交实际CI结果认定通过。
- 前端TypeScript、生产构建和坐标几何回归已运行。代码分包，公开导览不加载后台业务JS。
- 云浏览器此前对本地预览地址的访问受限，本版未完成真实浏览器桌面/手机交互验收；构建成功不是视觉验收的替代。部署后需检查：桌面三栏、小屏纵向布局、拖动顶点、手机双指缩放、草稿会话重登、确认弹窗、退回意见、地图重新读取及原有楼层链接。
- 未连接用户服务器，未声明已升级2512921.cn。AI、VR、室内路线、完整素材后台没有借此完成。
