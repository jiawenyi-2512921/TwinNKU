# 83点介绍补充与部署交接

2026-09-24；分支 `feat/admin-console`。这次交付包含内容初稿、通过现有后台接口保存草稿的工具，以及前台分段正文/折叠来源展示。**提交代码不等于83条介绍已经在服务器公开。** 服务器继续由用户与部署方操作。

## 内容与证据

- 唯一内容包：[jinnan-20260924.json](../data/introductions/jinnan-20260924.json)。覆盖当前83个命名点位的既有UUID，没有创建新点位。
- 完整审阅稿：[REVIEW.md](../data/introductions/REVIEW.md)。53条有学校官网资料支持；30条为地图可确认的楼号、校门、历史机构标识等基础介绍。共有35个官方来源及1个项目组地图来源。
- `official`表示引用了学校来源，不表示每句话已由宣传部门签字批准；观察提示是编辑编写的导读。`map_only`不宣称掌握该楼完整沿革和使用情况。两类均须独立审核。
- 每条介绍包含正文、来源标题/链接和核对日期。官网的学院简介说明学科，不能证明当前楼宇每个房间用途。历史文章不作为当前开放时间或预约规则。
- 不提供未经核实的宿舍入住学院/性别/年级、房间分配、校门时段或访客通行承诺。

重点审核：津南思源堂、秀山堂、木斋图书馆明确为复建建筑；前沿交叉学科中心采用2026年9月全面启用资料；“新闻与传播学院”介绍说明2025年组建信息与传播学院；合并学院点位说明“密码与网络空间安全学院”现行名称。**上述院系变化仅进入介绍，不自动改地图名称。** “教1/2/3”和“新校区规划建设指挥部”当前用途仍需项目组补正式依据。

## 更新代码

在已有项目仓库中按正常方式备份并更新 `feat/admin-console` 分支；先确认工作区没有尚未提交的本地修改，不使用 `reset --hard` 丢弃部署方文件。

已运行上一版楼层/VR后台（迁移head为0005）的部署，本次只需构建更新前端：

```bash
docker compose build web
docker compose up -d --no-deps web
```

本次不新增API端点、不修改DTO或数据库结构，不运行地图seed或旧地图导入，不重导楼层包。服务仍读取数据库的正式内容，前端不会加载JSON包冒充已发布内容。介绍导入依赖已有后台启用、HTTPS正常和账号有相应点位权限。

## 校验和预览

脚本仅依赖标准库，兼容服务器系统Python 3.8及以上。以下命令在项目根目录执行；把 `your_editor_username` 改成已有编辑账号名。密码在终端交互输入，勿写入命令、文件或GitHub。

```bash
python3 scripts/stage_point_introductions.py --validate-only
python3 scripts/stage_point_introductions.py \
  --base-url https://2512921.cn --username your_editor_username
```

第一条只读本地包；第二条默认只登录并读取后台以预览，**不保存点位、不发布**。登录/退出会留下正常会话审计。新增账号首次改密须先在网页后台完成。

预览逐条输出UUID、名称和状态：

| 状态 | 处理方式 |
| --- | --- |
| ready | 当前正式介绍为空，可以补充 |
| existing_summary | 已有非空介绍，默认保留；人工比较审阅稿后决定 |
| unchanged | 正式介绍与本包相同，无需重复更新 |
| pending_draft | 有草稿/待审核/退回内容，保留原工作，由编辑者处理 |
| name_changed / identity_mismatch | 名称、校区或ID不匹配，停止该点导入，人工核对 |
| ambiguous_geometry / stale_map | 当前几何或图版本不明确，停止该点导入，不套用旧目录 |
| not_public | 非公开或已下架，保持原状态 |
| error | 读取、权限或并发失败；依据HTTP状态和阶段核对，不盲目重试 |

包没有坐标、轮廓、别名或分类。每次保存前读取后台当前正式记录，只更换介绍和编辑依据；原名称、别名、分类、visibility、几何与标注设置原样带入。正式revision与草稿revision由已有API校验。并发冲突会拒绝保存，不刷新revision后强行重试。

## 保存并提交审核

预览及审阅稿核对后执行：

```bash
python3 scripts/stage_point_introductions.py \
  --base-url https://2512921.cn --username your_editor_username \
  --apply --submit
```

`--apply`只保存草稿；同时带 `--submit`才提请审核。脚本**没有发布功能**，由另一名有权限的审核员在后台点位审核中检查正文和来源后发布。管理员同样不能自审。结果中的 `published_by_script: 0`是正确状态。

现有周恩来雕像可能已保留短介绍；默认会跳过。要采用本包更完整版本，先在网页核对该点当前介绍，再复制它在审阅稿中的UUID，针对单点运行：

```bash
python3 scripts/stage_point_introductions.py \
  --base-url https://2512921.cn --username your_editor_username \
  --point-id '填写审阅稿中的实际UUID' \
  --replace-point-id '填写同一个实际UUID' \
  --apply --submit
```

显式替换也不能越过其他人的未完成草稿或revision冲突。若需要保留用户刚补的介绍，就不要替换。已发布的相同介绍会被识别为unchanged；待审核项重复运行会跳过。

每个点位独立请求，批次不是全有或全无事务。超时可能发生在服务已保存之后；脚本记录reading/saving/submitting阶段，不自动重试写操作。出现网络异常、会话失效、限流或服务不可用时停止后续请求；先检查后台已有草稿再继续。读取权限不足的点位只报告错误，不扩大账号权限。

## 前台验收与回退

发布后核对公开 `/api/v1/points/{UUID}` 的summary与revision，再在网页选择该点查看。客户端可见页面每30秒更新，重新聚焦也会刷新；未审核内容不应出现在公开端。

验收至少覆盖：图书馆、周恩来雕像、一个复建建筑、新闻与传播学院、一个宿舍楼号。正文应分段清晰，来源默认折叠且链接能打开；手机不横向溢出。原底图、名称显示方式、雕像标注、点击区域、楼层和VR入口保持既有行为。已完成代码构建和逻辑测试；最终桌面/手机实机视觉验收由部署后执行。

若需回退已发布文案，在后台创建新的修订、独立审核；保留其他已修正字段。不要回滚全库或导入旧地图来撤销一段介绍。包源文件修改后可用下列命令重新生成审阅稿：

```bash
python3 scripts/stage_point_introductions.py \
  --render-review data/introductions/REVIEW.md
```

当前来源放在summary的固定末尾格式里，兼容已有API。前端只识别这一小段格式，不执行HTML或通用Markdown；格式不正确时整段作为普通文本显示。下一阶段知识库需从**已发布记录**建索引；不得直接将本包编辑初稿当成已审核AI知识。
