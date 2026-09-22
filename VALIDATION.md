# 验证记录

范围：规范v1.0.0与M00基础应用v0.1.0。本文件记录已执行检查，不代替服务器上线记录。

## 已执行

| 检查 | 结果 |
| --- | --- |
| Python Ruff检查及格式化 | 通过 |
| 后端单元/接口测试 | 12通过；1项真实PostgreSQL测试因本地无实例而跳过 |
| SQLite Alembic upgrade head | 通过 |
| 种子重复执行 | 通过，只保留一个校园元数据记录 |
| Alembic模型/迁移差异检查 | 通过，无未迁移结构差异 |
| 完整OpenAPI导出一致性 | 通过；55个operation，7个已实现；97个schema |
| operation_id唯一及所有本地schema引用 | 通过 |
| TypeScript生成、类型检查与生产构建 | 通过 |
| 真实本地前后端HTTP冒烟 | live、ready、status、campuses、points与HTML均通过 |
| Chromium页面交互 | 页面加载、真实空目录、搜索无结果、恢复全部点位通过，无JS页面异常 |
| 390px手机布局 | 未发现横向溢出；已检查桌面与手机截图。QA环境补充中文字体后复核，产品继续使用设备系统字体 |
| Shell脚本语法、Git diff空白检查 | 通过 |
| 首次部署配置保护 | 8项专项测试通过：密码不输出且文件权限600、重复运行不更换密码、拒绝覆盖符号链接、端口占用时不生成配置、拒绝非法/注入主机名、发现已有项目时停止。已有项目检查使用测试CLI，未冒充真实Docker集成测试 |
| GitHub PostgreSQL、契约与前端构建检查 | PR #1 首次运行的 contracts-and-tests 任务通过，包含真实 PostgreSQL 测试、契约一致性与前端生产构建。后续结果以对应提交的 Actions 为准 |

这些检查验证基础站，不证明尚未实现的地图、AI、路线或后台已可用。

## 未完成/外部条件

- 本地没有Docker Engine；尚未在本地执行Compose容器构建与启动。
- GitHub Actions 首次 Compose 检查发现非 root Nginx 无法写入默认缓存临时目录；已将各临时路径显式指向可写的 `/tmp`，保留非 root、只读根文件系统和移除 capabilities 的限制。修复后的完整启动结果以 [PR #1 的检查](https://github.com/jiawenyi-2512921/TwinNKU/pull/1/checks) 为准。
- GitHub API 连接的实际写入返回 403 Resource not accessible by integration，本轮使用用户已登录的 GitHub 云浏览器提交。网页登录不会自动修复 API 连接授权。
- 用户已提供当前服务器连接信息；本执行环境的 TCP 与 OpenSSH 连接均在认证前返回 `Network is unreachable`。未登录或修改服务器，未部署到用户服务器，也未验证外部 HTTPS；不能据此认定服务器故障或密码错误。
- NK-GeniOS真实API协议未取得/联调，智能体调用与工具执行未验证，chat能力关闭。
- 官方地图、路网、全景对应、楼层和讲解资料尚未审核导入。

## 已知非阻断情况

本地依赖组合的测试客户端产生上游弃用提示（httpx与BlockingPortal）；当前12项测试通过。升级测试工具时按真实兼容性处理，不通过关闭安全校验或忽略测试来消除提示。

## 发布证据待补

服务器发布后补充：目标环境（不含密码）、commit、镜像digest、迁移head、部署时间、HTTPS地址、基础冒烟和负责确认人员。生产口令与原始日志不要粘贴在此文件。
