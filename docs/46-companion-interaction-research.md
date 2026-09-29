# 小开随行角色交互研究

研究日期：2026-09-29。本文是产品与技术建议，不代表已经改版、接入候选框架或通过真机验收。本次核对原始 GitHub 仓库、许可证和官方文档，并对照 TwinNKU 当前代码；没有安装这些候选项目，没有测量它们在本站的包体、帧率、温升、语音延迟或网络可用性。

## 推荐方向

将小开做成原创轻量 2D 随行角色：平时停在地图边缘，说话时出现短字幕，实际资料与操作卡在地图中按需出现；用户需要打字或看历史时，再展开文字抽屉。角色始终跟随本站的浏览、导航与导览状态，不占据一个常驻聊天窗口。

优先参考 AIRI 的角色状态设计与 assistant-ui 的会话、呈现分层方式。首版继续使用现有 React、学校问答 API 和经过核验的网站动作，不新增角色或智能体框架。确实需要 3D 讲解员时再评估 TalkingHead；真正的实时语音另立技术验证任务，不能靠替换角色外观宣称完成。

这里的“有趣”应来自角色参与校园任务：指向正在讲解的建筑、递出真实楼层图、提醒下一站、询问是否观看视频。动画表达实际状态，不代替资料检索、路线计算或动作执行。

## 已有能力、拟做交互与实时语音

| 层次 | 当前事实或计划 | 边界 |
| --- | --- | --- |
| 已有问答与会话 | 原生小开调用学校应用 API，前端保存当前会话和问答；导航等站内动作不要求卸载助手 | 真实模型、生产部署和手机效果需各自验收；不能从代码或本地测试推断线上结果 |
| 已有网站动作 | `focus_point`、`show_floor`、`open_vr`、`show_route`、`show_checkin`、`play_video`、`show_tour` | 以服务端允许的动作、公开目录、资源版本与地图上下文为准；模型不能提供任意网址、坐标或发布权限 |
| 已有语音方式 | 浏览器 Web Speech 识别与 `speechSynthesis`，围绕学校文本回答轮流听说 | 属于浏览器语音交互；学校接入仍是阻塞式文本协议，不是已经接通的实时音频模型 |
| 拟做呈现 | 原创 2D 角色、短字幕、地图资料卡、可展开文字抽屉、角色随实际动作反馈 | 本文只描述方案，尚未实现；不能将角色动画或演示图视为语音、导航已验收 |
| 后续实时语音 | 评估流式 STT、学校问答适配、流式 TTS、轮次检测、打断与取消 | 需要真实服务、中文效果、权限、成本、移动端和网络验证；学校接口若继续整段返回，其等待时间仍存在 |

当前事实可从 [NativeAgentDock](../apps/web/src/features/agent/NativeAgentDock.tsx)、[语音控制器](../apps/web/src/features/agent/voice.ts)、[动作处理](../apps/web/src/features/agent/native.ts)、[服务端动作与目录](../apps/api/app/modules/assistant.py)核对。已有部署边界见 [43 语音、媒体、打卡与路线](43-voice-media-tours.md)和 [44 全景与校园导览](44-vr-campus-tours-editor.md)。

2026-09-29 用户已纠正 VR 方案：使用原网站新标签页，不恢复 iframe。角色只留在 TwinNKU；不能承诺它进入学校原站继续对话。显式点击的小开 VR 动作仍先核验，再打开实际已发布的原网址；弹窗受阻时提供核验入口。

## 三种与项目真正联动的体验

### 1. 指图问“这儿”

用户点选地图建筑，角色朝该点位做轻微指向，并显示“问这里”的短入口。语音中的“这里”“这栋楼”使用当前选中点位上下文；没有明确选中对象时，引导用户选点，不猜地理位置。

回答涉及楼层时，地图中出现该建筑真实已发布楼层的资料卡；涉及打卡时，展示已审核样图和点位；涉及 VR 时，给出原站入口。角色指向与卡片内容都由核验后的结果驱动，失败或资料缺失时说明原因。

首版可复用既有选点、公开目录与动作，不增加新模型协议。后续若让资料卡跟随点位投影，应复用地图坐标适配层，不修改用户校准的几何或底图。

### 2. 路线站点任务

开始已发布校园导览后，将进度表现为小型路线票签：当前站、下一站、继续讲解。角色在用户继续或完成当前站后给出对应反馈；用户仍能随时问楼层、看图片或暂时离开导览，返回后保留进度。

第一阶段只复用已发布站点、讲解与现有导览进度。照片对比、学习问题、任务完成记录属于后续扩展，必须有审核内容和真实记录方案后再开放。不凭空生成打卡样图、问题答案或现场通行事实。

线上浏览完成与线下到达是不同状态。没有可靠定位或用户明确确认，不展示“已到达”；站点顺序也不能冒充可步行的道路。真实步行导航仍交给当前审核路网与出入口计算。

### 3. 视频讲解

用户问到某地点或事件时，角色在找到已发布视频后递出观看邀请，包含真实标题和可用的封面。只有目录确实有时长时才显示时长。用户点击后播放，并暂停助手语音，避免视频与朗读互相干扰。

播放结束后保留当前地图和会话，提供明确的“继续讲解”入口。后续可以将视频绑定导览站点，但播放时机必须来自后台配置；不能由模型临时编造时间点。文本、字幕与关闭操作始终可用，不强制开麦才能浏览。

## 候选项目比较

以下版本是研究当日官方发布页可见的状态，不构成稳定性或性能排名。没有使用 star 数量评判质量。

| 项目 | 可借鉴之处 | 许可与维护状态 | 依赖、浏览器负担及学校 API 适配 |
| --- | --- | --- | --- |
| [AIRI](https://github.com/moeru-ai/airi) | 角色的视线、待机、倾听、说话；Live2D/VRM；角色与声音的状态协作 | 主仓库 MIT；发布页可见 `v0.12.0-beta.5`，仍处早期迭代；具体角色素材须单独核对 | Vue/TypeScript 多应用仓库，覆盖浏览器、桌面和移动端，含多种音频与渲染能力。本地推理是可选项，不是所有部署必须启用 WebGPU。整套移入现有 React 站点成本较高；学校自定义协议需适配，不能只填一个未经核验的 OpenAI base URL |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | 免按键交互、语音打断、Live2D 反馈与桌面宠物模式 | 后端仓库 LICENSE 为 MIT；当前 Web 前端采用带额外条件的 Open-LLM-VTuber License 1.0，不能笼统称全套 MIT。v1 发布页可见 `v1.2.1`；README 已说明讨论 v2 重写，v1 继续修错和处理已有工作 | 独立 Python 后端与前端、可选 STT/TTS/LLM 服务、Live2D 资源；整套部署会新增一条服务链。支持兼容提供方不等于已兼容学校协议；借鉴轮次与角色反馈比直接替换学校后端合适 |
| [TalkingHead](https://github.com/met4citizen/TalkingHead) | 3D 全身讲解员、口型、表情和动作 | 类库 MIT，发布页可见 `v1.7.0`；作者在 README 中将其描述为个人业余项目。示例模型、动作、音效等有各自许可 | 基于 Three.js/WebGL，需合适骨骼与表情形变的 GLB。可接已有模型回答与音频，属于表现层；现有 `speechSynthesis` 不能直接提供其精确口型所需的可靠音频时间信息。中文口型与音频供应方需实测，不能宣称直接可用 |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | 会话状态与展示分离、工具结果卡、取消和执行反馈 | MIT；发布页持续有多包更新，研究时可见 `assistant-ui@0.0.118` 等包，不能把 CLI 版本当作所有 React 包版本 | React/TypeScript；官方 LocalRuntime 可接自定义 REST，ExternalStoreRuntime 可用已有状态。无须强制换模型或上托管云。自身主要面向聊天界面，不负责角色动画；本项目先参考分层，暂无必要引入新依赖 |
| [LiveKit Agents](https://github.com/livekit/agents) | 真正音频会话、轮次检测、打断、STT→LLM→TTS 管线 | 核心 Apache-2.0；发布页可见 `livekit-agents@1.8.3`。部分模型受独立 LiveKit Model License 约束，不能将该权重许可当作 Apache-2.0 | 浏览器 WebRTC 客户端、LiveKit Cloud 或自建服务、agent worker 与语音提供方。官方允许自定义 LLM 节点，因此可评估包装学校协议；这是架构可行性判断，尚未接通或测试。它解决音频基础设施，不提供校园宠物形象 |

Open-LLM-VTuber 前端许可证允许非商业、教育、研究等用途，另列收费托管、商业重包装及收费产品集成需独立商业许可；实际采用时应针对拟使用版本与方式核对。后端 MIT 文件、前端许可证和 Live2D 样例许可必须分别保留与检查。

LiveKit 核心框架与模型许可也需分开。当前 `MODEL_LICENSE` 限定相应模型随 LiveKit Agents 使用，不能脱离该框架独立复用。AIRI、TalkingHead 的代码许可证同样不会自动授予所有示例角色、纹理和声音的使用权。首版原创角色可以减少素材来源不清的问题。

## 适合现有项目的轻量架构

现有 `NativeAgentDock` 同时持有窗口开合、会话、请求、字幕、语音和动作状态。先将会话与控制逻辑抽离为常驻控制器，再换表现层，避免角色收起或资料打开时丢会话。

| 组件或职责 | 推荐行为 |
| --- | --- |
| 常驻会话控制器 | 管理会话、当前点位和版本、请求取消、动作结果；继续调用现有 `/agent/chat` 与动作核验接口 |
| 语音控制器 | 保留用户显式启用、听说互斥、取消与错误处理；向界面提供真实的 idle/listening/thinking/speaking/paused/error 状态 |
| 原创角色 | 用 SVG/CSS 或少量精灵帧表现真实状态；动画不驱动业务、不模拟回答、不在地图上伪装用户位置 |
| 字幕与文字抽屉 | 短字幕不遮地图；历史与输入按需展开；关闭抽屉保留会话；键盘和屏幕阅读器可操作 |
| 地图动作卡 | 展示已核验的点位、楼层、图片、视频邀请或导览；公开资料撤回后失效；重试时重新核验 |
| 业务反馈 | 地图真正定位、资料真正打开、路线真正计算后再回传结果，让角色反馈实际完成状态 |

学校 API 密钥继续只在服务器。候选框架如需适配，应由服务器转换已有正式协议；不把平台凭据送入浏览器，不把学校接口未经验证地当作 OpenAI 兼容接口。原有草稿、审核、scope、revision、已发布过滤及真实路网机制都保留。

## 部署栈与性能预算建议

首版保持当前 React/TypeScript/Vite、Leaflet、FastAPI、PostgreSQL、NetworkX 和学校适配器。表现层重构应优先只改 web；不因此新增数据库迁移、部署另一个智能体服务或引入 Vue、Three.js、Live2D SDK。是否最终仅需更新 web，以实际改动为准，不能提前代替发布说明。

以下是建议验收预算，**不是测量结果或现有承诺**。以同一部手机、相同地图和网络条件比较改版前后；超出目标时先简化表现再讨论预算。

| 维度 | 首版建议目标与验收方式 |
| --- | --- |
| 首屏资源 | 角色与独有样式、代码的新增压缩传输量以不超过 250 KB 为初始目标；记录网络面板实际值，角色资源延迟加载，不阻塞地图 |
| 待机与动画 | 静止角色不运行持续动画循环；仅在交互状态使用短动画；页面隐藏时暂停，遵守 `prefers-reduced-motion` |
| 地图交互 | 开关角色前后对比地图拖动、缩放和选点；采样帧耗时与长任务，不能用桌面构建成功代替手机流畅性 |
| 屏幕空间 | 角色视觉尺寸先以 64–96 CSS px 试验，字幕最多两行；触控按钮至少 44×44 CSS px；适配安全区、横屏与软键盘，不覆盖导航主操作 |
| 请求与音频 | 一次明确问答只触发一次请求；取消和上下文切换后旧回答不执行动作；识别与朗读不同时运行，视频播放不与助手抢音频 |
| 降级 | 语音不可用时仍可点图、打字和看资料；角色资源失败时保留文本入口；不要让装饰性加载失败阻断导航 |

3D、Live2D 或真正实时音频应作为独立可关闭的增强项，在上述基线完成后再测。LiveKit 方案还需服务与 worker 运维、短期会话凭据、中文 STT/TTS、回声与打断、目标手机及实际网络验收；本次未部署这些服务。

## 建议实施顺序与验收

1. 抽离会话和语音控制器，保持当前行为；回归动作核验、导航保留、资料撤回、取消、视频暂停与 VR 弹窗回退。
2. 以原创 2D 角色、短字幕和文字抽屉替换常驻窗口；覆盖触控、键盘、减少动态效果及语音不可用的降级。
3. 用一栋资料齐备的真实建筑完成“选点→问这里→楼层或样图→继续导航”的端到端验收；再接首条已发布校园导览和一段有权使用的视频。
4. 单独建立真实语音验证记录，分别测录音结束到转写、学校回答、首段音频及可打断状态；没有数据前不承诺实时或低延迟。

这份研究没有产生测试通过数量或性能成绩。下一项可完成增量是控制器解耦与轻量角色交互原型；具体 UI 实施须保留现有可用功能，不能为采用候选项目而重建后端。

## 原始来源

以下链接于 2026-09-29 核对。GitHub 发布页只用于记录当日可见版本与维护方向，不以部分页面省略年份的日期推断完整发布日期。依赖和服务能力可能变化，真正采用时需锁定版本再次检查。

- AIRI：[仓库与架构说明](https://github.com/moeru-ai/airi)、[MIT 许可](https://github.com/moeru-ai/airi/blob/main/LICENSE)、[包声明](https://github.com/moeru-ai/airi/blob/main/package.json)、[发布记录](https://github.com/moeru-ai/airi/releases)。
- Open-LLM-VTuber：[仓库与 v2 维护方向](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)、[后端 MIT 许可](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE)、[Web 前端许可](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web/blob/main/LICENSE)、[Live2D 样例许可](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE-Live2D.md)、[Python 依赖](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/pyproject.toml)、[发布记录](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/releases)。
- TalkingHead：[仓库、依赖及 Web Speech FAQ](https://github.com/met4citizen/TalkingHead)、[MIT 许可](https://github.com/met4citizen/TalkingHead/blob/main/LICENSE)、[包声明](https://github.com/met4citizen/TalkingHead/blob/main/package.json)、[发布记录](https://github.com/met4citizen/TalkingHead/releases)。
- assistant-ui：[仓库](https://github.com/assistant-ui/assistant-ui)、[MIT 许可](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE)、[自定义 runtime](https://www.assistant-ui.com/docs/runtimes/custom/overview)、[LocalRuntime](https://www.assistant-ui.com/docs/runtimes/custom/local-runtime)、[发布记录](https://github.com/assistant-ui/assistant-ui/releases)。
- LiveKit Agents：[仓库](https://github.com/livekit/agents)、[核心许可](https://github.com/livekit/agents/blob/main/LICENSE)、[模型许可](https://github.com/livekit/agents/blob/main/MODEL_LICENSE)、[官方管线节点与自定义提供方](https://docs.livekit.io/agents/logic/nodes/)、[发布记录](https://github.com/livekit/agents/releases)。
