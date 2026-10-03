# 后台备份控制与固定主机执行器

本包实现 `docs/58` §13.1 的后台申请、独立授权、持久任务、状态和维护执行器。源码与自动测试不能替代实际主机部署、真实加密备份和隔离恢复验收。后台申请默认关闭；没有安装维护执行器时页面显示离线，不能宣称备份正常。

## 权限与后台工作流

- `backup.read` 只允许查看全站备份摘要和申请记录。
- `backup.request` 允许申请完整备份、查看和取消自己的任务。它只能读取非敏感的执行能力标志，不能读取其他成员任务或全站恢复结果。
- 角色不自动获得上述权限。`users.manage` 成员在“备份与恢复记录”选择成员、填写原因并显式授权。申请、取消和修改授权都要求实际已绑定认证器以及5分钟内验证；分阶段开放 MFA 的例外不适用于主机维护。
- 所有写操作沿用员工 Cookie、Origin 和 CSRF。读取不延长空闲会话。成员失效或权限撤销后，API 与执行器重新检查，不因旧页面仍有按钮而继续操作。
- 申请只接受操作 UUID 与5–500字原因，固定为完整备份。浏览器不能指定路径、命令、快照、密钥、目的地或恢复覆盖。
- 收不到响应时按原操作 UUID 查询；明确重试仍用原 UUID 与相同原因，不产生第二任务。取消同样绑定任务、申请人和取消操作 UUID；“申请取消”与“执行器确认已取消”分别显示。

## 持久任务与硬限制

`0020_backup_jobs` 建立独立 grants、job、事务 admission gate 与只读摘要镜像。其上游为 `0019_vr_checks`。API 通过同一事务中的 gate UPDATE 串行核对全局活动任务、操作幂等和24小时请求数。`queued / running / unknown` 均阻止新增；取消和失败仍计入申请频率。

部署硬上限是每名员工2次/滚动24小时、全局6次/滚动24小时、相邻申请至少3600秒；设置只能收紧。主机执行器另在 root 私有 `manual-budget.json` 原子记录已开始尝试，崩溃、失败与取消都不返还额度。数据库中的配置或旧数据库恢复不能删除这个主机账本来放开限制。

排队授权最长到原 MFA 验证的5分钟或原会话绝对期限。实际开始再次检查有效成员、`backup.request`、原会话、近期 MFA 和取消标志。运行期间不因 MFA 自然超过5分钟而自动中断，但继续检查成员、授权、会话撤销与取消。任务最长30分钟，主机 systemd 最长35分钟并清理整个进程组。租约丢失标记 `unknown`，不自动重试；维护人员须核对固定回执与真实仓库后处理。

## 主机维护边界

API 只写任务、读取白名单摘要，没有 Docker socket、主机根目录、备份密钥、restic 仓库或数据库 owner 凭据。`scripts/backup_executor.py` 是独立 root oneshot 服务，按30秒 timer 观察队列，通过既有 DB 容器本地 psql 执行固定 SQL。任务正文不会进入 shell、SQL标识符或 argv。

执行器只读取 root-owned 0600、路径无符号链接的固定 `/etc/twinnku/backup-executor.json`。目录祖先须由 root 控制、不可被组/其他用户写入。它核对新 `backup.py` 的完整 SHA256、固定部署与仓库、容量预留和固定 Nginx 配置白名单。所有 scheduled/CLI/后台入口共用仓库下 `.backup.lock`，备份内部继续使用 floor_assets 的 `.maintenance.lock` 与上传/清理保持一致。

尤其注意旧部署曾用 `/root/twinnku-release-preflight-20261002/backup.py` 的冻结副本：**必须更新有效 `twinnku-backup.service` 的 ExecStart 到新版脚本或同 SHA 的受控副本，且使用同一仓库/密钥/预留空间。** 执行器会实际读取 unit ExecStart，脚本 SHA 或存储参数不等价便拒绝启动；不能仅安装新的 worker 而保留绕过共锁的旧 timer。

每个阶段用双向 ACK：子备份进程先报告固定阶段，维护执行器重新核验授权并刷新租约，确认后才进入该阶段。API 不能回应 ACK。异常只打印固定 phase/status，不打印子进程 stderr、环境变量、SQL返回正文、用户名、密钥或数据内容。数据库/租约不可用时终止本次进程组，结果不明时保持未知。

维护执行器的“在线”与“接受申请”分别记录。即便观察 timer 正常运行，主机 `requests_enabled=false` 时 API 也拒绝新增，不消耗申请额度。每次执行结束先落 root 私有 `executions/<job>-<execution>.json` 不可覆盖回执，再发布任务完成结果；回执落盘失败保留未知状态，不能标为成功。

## 安装顺序（须由部署人员实际验收）

1. 配套迁移至0020，部署 API/web，保持 `BACKUP_REQUESTS_ENABLED=false`。
2. 将维护脚本、service/timer 和固定私有策略安装到经核对的主机路径，保留原加密仓库和密钥。策略填实际部署 root、仓库 destination、key_file、min_free_gib、nginx_sites 和 `backup_script_sha256`；首次 `requests_enabled=false`。路径与 SHA 由主机部署提供，不从后台表单取值。
3. 核对并更新既有 scheduled backup unit 的实际 ExecStart，确认与执行器的脚本指纹及存储参数一致；daemon-reload 后只启动观察 worker，页面状态须显示真实容量/最近成功时间。原 timer 保持受控 schedule，不能并发旧版入口。
4. 先在隔离数据/仓库执行完整申请→真实 dump→restic→check，演练容量不足、排队过期、授权撤销、阶段取消、数据库不可用和结果未知，核对 API 不持有任何主机权限。数据库必须用实际 PostgreSQL 验证 admission 并发及0020升降级。
5. 单独完成真实隔离恢复，固定真实回执才可设置 `restore_receipt`。generic `{"status":"passed"}` 不能宣称恢复通过。摘要只展示核验时间与状态，不暴露磁盘路径、数据库正文或密钥。
6. 检查同机备份限制与恢复材料的保管后，由维护人员显式启用主机策略 `requests_enabled` 和 API `BACKUP_REQUESTS_ENABLED`，只向必要成员授予独立权限。

恢复旧快照时，queued/running/unknown 的备份申请须冻结并清除租约，不自动重放；摘要心跳应清为未知，等维护执行器重新观察。备份仓库、密钥和主机手动额度账本不能随旧数据库覆盖或清空。覆盖生产的恢复不通过后台按钮开放。

## 验证范围

已落地专项覆盖真实 FastAPI 员工授权/Origin/CSRF/近期验证、独立授权、只读轮询不续会话、原操作查询、硬额度、未知阻断；执行器固定策略/旧timer核验、私有耐久额度、固定SQL输入、真实子进程阶段ACK；页面自动测试覆盖默认关闭、丢响应查询、原编号保留、MFA不自动重播、跨账号迟到响应和取消身份绑定。

Windows不能证明 Linux root文件权限、flock/process-group、systemd、实际 PostgreSQL或restic恢复。对应真实主机/隔离验收须单独记录。此包没有运行生产备份、安装服务或启用后台申请。

`pg_dump` 已通过固定 `/bin/busybox timeout -s KILL 1140 pg_dump` 在数据库容器内限制为19分钟，主机侧保留1200秒上限，预留60秒收集容器退出结果。期限和命令不能由任务或后台填写；超时、watchdog不存在或导出非零退出都中止后续加密、保留最近成功记录并显示本次失败。候选 DB 镜像的实际 BusyBox applet、期限到达与主机取消仍须在 Linux/PostgreSQL 专项验证；主机进程组取消不保证容器内立即终止，容器内导出最迟受上述期限限制。不能用模拟子进程通过替代实际容器验收。
