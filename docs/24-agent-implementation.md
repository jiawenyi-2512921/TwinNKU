# 智能体、检索与界面动作开发规格

状态：以下为后端会话/SSE/自动动作方案，仍待真实平台API协议。2026-09-25用户另提供明确的WebClient嵌入代码，本轮已实现WebSDK容器、初始化上下文、六个只读工具文件与点击导览链接，见[32](32-nk-genios-web-release.md)和[33](33-nk-genios-platform-setup.md)。这不代表下文后端流水线已实现。全文所有超时、额度和阈值都是初始工程目标，不是已测结果。

## 1. 接入前置证据包

必须取得以下材料并提交去敏版本到fixtures/nk-genios/，密钥只放服务器环境：

| 材料 | 必须回答的问题 | 未满足的处理 |
| --- | --- | --- |
| 请求示例 | 精确base URL/path/method/header/body；bot/workflow真实ID | 不从公开聊天链接slug猜测 |
| 返回示例 | 非流式和流式字段、会话ID、错误体、request ID | 解析器只接受证实的形态 |
| 会话行为 | 新会话、续轮、TTL、服务端隔离 | 自有visitor/chat session与平台ID绑定 |
| 来源行为 | 文档ID/片段/版本/引用能否返回 | 无来源能力时使用我方受控检索，不用模型猜来源 |
| 工具能力 | 函数/JSON结构化输出/动作限制 | 无工具调用可解析JSON，但等价验证 |
| 取消与幂等 | 是否可cancel、查询任务、重放 | 不支持时本地取消且不盲目重发 |
| 配额 | 并发、RPM、token/费用、超时 | 后端限流与预算，UI明确繁忙 |
| 内容边界 | 平台允许接收的数据、保留方式、访问范围 | 首发仅获准公开资料；不传密码/原始私人信息 |
| 网络 | 部署服务器TLS/DNS/连通/时延 | 由部署方实际测试；浏览器能聊天不证明服务器能调用 |

gate NK-READY：一次真实问答、一次同会话追问、两会话隔离、来源映射、错误处理和服务端日志脱敏通过。chat能力此前保持false。现有API/WebSDK“运行中”截图只证明平台发布状态。

## 2. 访客会话与鉴权

1. 网页无需先注册才能看公共地图。用户首次使用会话功能才POST /auth/guest-session。
2. 服务端下发高熵不透明cookie，HttpOnly/Secure/SameSite=Lax；返回CSRF token和expires_at。token在服务端只存hash。
3. chat/tour/inquiry写操作检查Origin+CSRF+会话过期+限流。ID知道并不代表拥有资源。
4. API创建chat session并绑定visitor session；客户端不得传其他用户的平台会话ID。
5. 会话过期：只读地图继续可用；可建立新会话，明确旧私有进度不可无验证继承。
6. 多标签页可共享访客身份，但每个chat session的正在运行turn互斥；并行用户绝不共享上下文。
7. 不把cookie、CSRF token、API key放URL或提交GitHub；日志只存不可逆会话指纹用于限流诊断。

当前Identity设计含contributor/analyst等旧计划角色；实际员工为viewer/editor/reviewer/admin。实现访客身份时须先统一角色契约：guest/visitor用于公开会话，员工权限沿用现行scope；不能把未实现的analyst当现有后台权限。

## 3. 一轮问题的完整流水线

| 阶段 | 输入 | 处理/校验 | 输出/失败 |
| --- | --- | --- | --- |
| receive | message 1—2000字、client_message_id、context | 限长、控制字符、身份、CSRF、幂等 | turn queued；非法422/403/409/429 |
| resolve | 校区/当前点位/楼层/主题 | 资源属于当前用户可见范围；消歧 | validated context，或先询问用户选择 |
| classify | 问题与上下文 | 普通事实/政策/操作/主题/越权请求 | 策略与可用工具集合 |
| retrieve | 实体ID、意图、语言 | 仅published有效资料，按来源层级排序 | 有界片段集+真实source/version/chunk |
| generate | 片段、允许ID、问题、上下文 | NK-GeniOS调用，明确资料不是指令 | 文本、实际引用候选、动作候选 |
| validate | 模型输出 | schema、长度、引用支持、资源存在/版本/权限 | 可发布回答/动作，或保守降级 |
| persist | 验证结果 | 原子终态和事件记录 | seq单调事件 |
| deliver | SSE或终态恢复 | 只向owner读取 | 回答/来源/动作卡片 |
| acknowledge | 前端结果 | action所属turn/owner、允许状态转换 | applied/skipped/failed，幂等 |

涉及政策、人物、校史年份等的事实文本必须先校验后展示。可以展示不含事实的等待提示；不能先流出错误事实再靠最终段更正。第一版允许“完整回答验证后分块输出”，同时如实称为验证后分块，不宣传未经实现的即时原生流式。

## 4. 检索与口径策略

### 4.1 来源层级

有效制度/政策 > 校方审核讲解稿 > 校方官网/学院官网 > 用户核实的地图事实。冲突先按事实类型和有效期判断，不机械选择更新时间最新的网页。人名、时间、数量或现址冲突无法解决时不拼接折中版本，进入缺口队列。

实体命中优先使用数据库ID和别名。例：“业务西楼”可映射综合业务西楼；“体育场”有多个候选则列出名称澄清，不默认距离最近（没有真实定位）。校区不明的校史原址不能投射到津南图上。

### 4.2 检索实现顺序

A. 核验平台是否返回文档/片段ID；有则建立版本映射，服务端复核。
B. 无可靠元数据时，先从业务库按点位、政策类别、来源状态选取有限资料再交平台生成；首版83点优先确定性实体检索，不急于独立向量库。
C. 语义检索确有召回缺口后，以固定评测集比较embedding/重排方案；再通过ADR增加组件和预算。

推荐初始top_k=6、单片段300—800中文字符、重叠50—100字符、总上下文上限由真实模型窗口决定。这些参数必须在100题集调优；片段不跨越来源版本/权限/有效期。

### 4.3 引用验证

source_id必须属于本次实际检索集合，version仍有效，chunk确实包含支撑事实。校验“ID存在”不足以证明“来源支持答案”；关键事实采用审核模板、实体数值核查，评测由人工判定支持性。模型置信度不是安全阈值。

对无来源闲聊可简短回答并引回导览，不冒充校方立场；对事实不足回答明确“目前公开资料未确认”，给相关正式资料或渠道。安全拒答、知识不足、服务故障是不同状态，运营统计分别计算。

## 5. 固定动作协议

**统一使用当前contracts.py的枚举**：focus_point、show_floor、open_vr、show_route、show_tour、play_narration。旧规划中open_panorama/start_tour是描述性词，不能另建同义接口。

```json
{
  "action_id": "00000000-0000-4000-8000-000000000011",
  "type": "show_floor",
  "resource_id": "00000000-0000-4000-8000-000000000012",
  "resource_revision": 2,
  "context_revision": 7,
  "requires_user_gesture": false
}
```

示例UUID仅协议说明。模型输出候选动作不能自行生成有授权效力的action_id；由服务端验证后分配并保存。

| 动作 | resource_id | 服务端条件 | 前端行为 | 成功定义 |
| --- | --- | --- | --- | --- |
| focus_point | Point.id | published、同校区、几何与map版本匹配 | 选点并打开详情 | 公共资料读取且选中成功 |
| show_floor | Floor.id | 关联点位可见、标注图可用、revision一致 | 切正确建筑并打开大图 | 层/区资源加载；当前协议分区字段缺口见下 |
| open_vr | 当前Panorama.id；未来scene稳定ID | 正式资源、HTTPS、获准域、未失效 | 用户点击卡片才新开 | 只确认用户点击，不宣称外站全景内部加载完成 |
| show_tour | TourPlan.id | owner、版本、未过期、全部站可见 | 进入步骤面板 | 对应计划成功读取 |
| show_route | RouteResult.route_id | owner、图版本/时段仍有效 | 按segment绘图 | 全segment地图版本匹配 |
| play_narration | Narration.id | 审核文本/音频版本、权限有效 | 用户点击播放；保留文字 | 播放事件成功，否则playback_blocked |

初次只实现前三项。show_route等能力关闭时不把动作发给客户端。资源ID解析走business resolver，不执行任何任意URL、JS、SQL、上传/发布/改权限动作。

### 5.1 契约缺口必须在开发前解决

- open_vr旧05写media_asset，实际VR先有Panorama模型；先定义适配映射和兼容规则，不能用不明UUID混查多张表。
- show_floor目前AgentAction没有section字段。首版默认合法首分区；支持指定A/B/C时增加经限制的可选参数或引入专用discriminated union，生成OpenAPI/TS和测试后才能启用。
- 同turn多个focus/show_floor互相竞争：第一版每轮最多一个自动上下文切换动作，其他动作变用户手动卡片；避免第一个动作增加contextRevision导致后续动作错误执行。
- 当前事件模型text/source/action都是可选；实现时须用type专属验证，禁止source.added却没有source、action.ready却没有action。
- 计划协议没有最终Answer DTO、SSE事件过期后的完整恢复响应，须新增字段/端点契约并标planned再实现；不能只用ChatTurnAccepted冒充已持久化答案。

## 6. SSE、幂等、取消和失败

事件种类：turn.started、answer.delta、source.added、action.ready、turn.completed、turn.failed、turn.cancelled。id=seq；DB unique(turn_id,seq)，客户端按(turn,seq)去重，动作再按action_id去重。单个事件建议≤32KiB，完整回答建议≤4000字为首版产品预算，最终在DTO落实。

POST创建turn先202返回events_url；同源EventSource使用HttpOnly cookie，不把token放query。断线携Last-Event-ID（新实例必要时受限cursor参数也须鉴权）恢复；15秒注释心跳；Nginx SSE关闭buffer，空闲读超时覆盖心跳；SSE每次重连仍验证owner和过期。

幂等scope=(visitor,session,endpoint,Idempotency-Key)。同key同规范化请求返回同turn；同key不同body 409。仅client_message_id去重仍需查session归属。创建后丢响应时可以恢复查询，不能要求用户不断刷新提交。

取消先事务标cancelled，写终态事件，再尝试平台cancel；平台不支持也不能把晚到动作发送到当前UI。completed之后重复cancel返回已完成状态，不回滚回答。终态唯一。

| 故障 | API/事件 | 用户处理 | 后台处理 |
| --- | --- | --- | --- |
| 平台连接失败 | AGENT_UNAVAILABLE/503 | 保留问题，可稍后重试，静态资料继续 | 脱敏错误、有限熔断 |
| 超总预算 | UPSTREAM_TIMEOUT/504或turn.failed | 显示超时，不伪造答案 | 终态落库，禁止重复结算生成 |
| 平台429 | 统一繁忙/429+Retry-After | 明确稍后再试 | 退避，不无限排队 |
| SSE断线 | 重连或终态读取 | 保留已显示内容，恢复seq | 不重复创建turn |
| 来源撤回 | 不发送依赖该源的事实 | 说明资料更新中，给有效渠道 | 阻断旧索引，记录受影响问答 |
| 非法结构化输出 | turn.failed或有依据的纯文本降级 | 不执行动作，显示可用正文时明确不联动 | 存错误分类，复测样例 |
| 用户已换点 | 动作skipped/stale_context | 保留回答但不移动地图 | 记录上下文冲突比例 |
| 会话过期 | 401/410 | 建立新会话，可继续地图 | 清理过期事件/会话 |

初始后端预算：连接5s、首响应30s、总90s；单会话一个运行turn；每访客10条/5min、60条/日，全局最多4个上游并发、队列最多20条为试点起点。必须配置化、后台可观察，压测与平台额度确认后修改。不将这些目标写为已生效设置。

## 7. 可防御的提问处理

资料和用户内容均是低信任数据。系统指令规定“只能引用给定资源ID”；权限仍由代码保证。检索到“忽略所有规则”等文字按普通资料处理。恶意要求获取宿舍个人信息、管理员密码、隐蔽安保细节或改后台，不提供这些能力；不将普通质疑/批评归为攻击。

过滤分三层：输入长度/类别限制；检索公开范围和有效期；输出事实/动作/敏感内容复核。不可只靠一段提示词保证合规。不需要为正常浏览收集姓名、手机号、精确位置；咨询引导到学校正式渠道。

## 8. 开发目录、验收与交付

建议新增app/modules/chat/{router,service,repository,worker}.py；integrations/nk_genios.py独立协议解析；sources/负责资料与检索；前端features/chat/{ChatPanel,turnStream,ActionDispatcher}。共享DTO仍归contracts.py，计划端点实现后从planned_contract移除，防止重复operation_id。

必须提交：脱敏平台样例、source映射方案、请求/事件/动作模型、持久化迁移、worker启动方式、限流配置、日志字段、错误表、回退开关、下列验收记录。

- CHAT-01：图书馆问答有实际来源，追问二层打开正确楼层。
- CHAT-02：两个不同访客同时问不同建筑无串话。
- CHAT-03：同请求网络重试只产生一个turn/上游任务。
- CHAT-04：停止后迟到回答不执行动作。
- CHAT-05：用户问A后手动切B，A返回不把地图拉回。
- CHAT-06：未知点、错误UUID、旧revision、未发布资源均不执行。
- CHAT-07：来源撤回或政策过期后旧索引答案受阻。
- CHAT-08：任意URL/脚本/发布命令等候选动作被拒。
- CHAT-09：SSE断线恢复没有重复正文/动作，事件过期有明确终态方案。
- CHAT-10：平台断网/429/慢响应/无引用，UI均可恢复，底图不受影响。

达到以上再向用户开放chat，不使用连接外部聊天页的按钮代替本系统内智能联动。
