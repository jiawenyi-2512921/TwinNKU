# 本地、服务器部署与运维

## 1. 部署状态的判断标准

代码有Dockerfile ≠ 已部署；本地页面能打开 ≠ 用户服务器能访问；截图中平台运行中 ≠ 后端已接通。只有完成对应环境的真实检查才能标记成功。

用户已提供本轮服务器连接信息。当前执行环境向 SSH 默认端口 22 发起 TCP 与 OpenSSH 连接均返回 `Network is unreachable`，在身份认证前失败；没有登录或修改服务器。该结果不能证明用户密码错误或服务器故障。服务器系统、已有站点及反向代理、域名和 HTTPS 情况仍未检查。不要从过期对话读取或复用旧密码，不把凭据提交 Git。

## 2. 环境要求

- Linux x86_64或arm64，Docker Engine与Compose v2（支持service_completed_successfully和up --wait）。
- 具备拉取Node、Python、PostgreSQL、Nginx、uv镜像及npm/PyPI依赖的网络条件。若校园网络受限，使用经管理员批准的镜像源，不关闭TLS验证。
- 现有服务、端口、磁盘和备份先检查；不直接覆盖宿主机Nginx配置。
- 首版大模型运行在平台，不在服务器上自部署大模型。容量以实际压测为准。

## 3. 本地启动

README列出两个终端的运行命令。开发默认SQLite位于apps/api/var，仅便于快速启动，测试PostgreSQL差异必须另行执行。

使用本地PostgreSQL时，在apps/api/.env设置 `DATABASE_URL=postgresql+psycopg://...`。数据库密码中有特殊字符应使用正确URL编码，或在生产使用DB_HOST/DB_USER/DB_PASSWORD拆分字段，让SQLAlchemy安全构造URL。

先 `uv run alembic upgrade head`，再 `uv run python -m app.seed`，最后启动服务。种子仅添加校园元数据，可以重复执行，不导入测试点位。后端不会自动建表。

## 4. 服务器首次部署

由用户和 DeepSeek 使用已获授权的方式连接服务器，核实主机身份与现有服务。不要关闭 SSH host key 校验，也不要通过脚本泄露密码。部署使用本仓库 `main` 中经过核验的完整源码；独立源码包可作为另一种交付方式。`SERVER-START.md` 提供两种获取源码的步骤。

使用 Git 获取源码后记录所选提交。首次安装优先使用配置初始化脚本：

```bash
git clone https://github.com/jiawenyi-2512921/TwinNKU.git
cd TwinNKU
bash scripts/first-run.sh
```

`first-run.sh` 先确认 Docker/Compose/daemon 可用、无已有同项目容器或数据卷，再执行 `init_env.py`：检查端口、原子创建权限 600 的 `.env`、在服务器生成 48 字符随机十六进制数据库密码。不输出密码。任一已有 `.env`、同名项目或数据卷都会阻止首次安装，以免丢失已有数据库连接配置。脚本不安装 Docker、不修改已有网站、不调整防火墙。

可传 `--port 18080` 改用空闲端口；可传 `--host your-approved-domain.example` 增加实际域名到 Host 白名单，重复 `--host` 增加多个。域名参数只配置白名单，不创建 DNS、证书或公网反向代理。

也可手工复制 `.env.example` 为 `.env`，设置权限 600，编辑以下变量并使用 `scripts/deploy.sh`：

| 变量 | 必填/默认 | 含义 |
| --- | --- | --- |
| APP_ENV | production | Compose强制生产配置 |
| APP_VERSION | 0.1.0 | 当前发布标识；后续版本应与镜像和应用一致 |
| DB_NAME / DB_USER | twinnku | 数据库名/用户 |
| DB_PASSWORD | 必填 | 至少24字符且非占位；建议48字符随机hex；不贴入聊天或Git |
| ALLOWED_HOSTS | localhost/127.0.0.1/api | 加入真实域名；JSON数组格式，不填协议/端口或* |
| HTTP_PORT | 8080 | 仅绑定127.0.0.1，冲突时改为另一个未使用端口 |

生成密码可以在服务器编辑器内使用可信密码生成器；只保存到权限600的.env。不要执行会把完整compose环境或.env打印到共享记录的命令。

```bash
bash scripts/deploy.sh
```

脚本校验.env不被Git跟踪、权限600、Compose语法，构建应用，运行迁移/幂等初始化，等服务健康，执行基础冒烟。脚本不安装Docker、不更改防火墙、不停止现有网站、不删除数据库卷。

如果HTTP_PORT不是8080，传入正确基础地址，例如 `bash scripts/deploy.sh http://127.0.0.1:18080`。

## 5. 容器启动顺序

PostgreSQL健康 → migrate容器完成Alembic与seed → API readiness通过 → web启动。迁移失败必须阻止新版本服务进入可用状态，不能忽略错误继续运行。

持久数据卷为Compose pgdata；API和web使用只读根文件系统与临时目录。数据库无公网端口。Docker日志每文件10MiB、保留3份。

迁移服务每次部署重新执行。应用启动不调用create_all，后续不可逆迁移须先备份，禁止部署脚本无条件drop/reset数据库。

## 6. HTTPS接入

由服务器现有反向代理终止HTTPS，转发到127.0.0.1:8080。`deploy/https-site.conf.example`是location片段，不是完整证书或Nginx配置；合入真实站点前先备份原配置并验证语法。

将公网域名加入ALLOWED_HOSTS后重新创建API容器。确认访问证书链、手机浏览器、静态资源、API同源、错误返回和健康检查。没有域名/证书时可使用SSH隧道进行受控预览；不能把这种预览标为公网正式上线。

基础CSP只允许同源资源。M01启用Leaflet时需为其样式策略验证CSP；M02嵌入外部VR时只添加实际获准域名到frame-src，不使用`*`。官网/公众号接入若需要iframe嵌入本项目，必须单独评审frame-ancestors和身份cookie策略，不能沿用基础SAMEORIGIN后宣称已支持。

## 7. 发布新模块

1. 在GitHub完成模块验收，固定发布commit，记录对应应用版本。
2. 服务器检查本地无未提交变更，备份数据库和已存在私有素材。
3. 拉取并检查目标commit，不对未知变更使用强制reset；确认迁移是否兼容旧版本。
4. `bash scripts/deploy.sh`，待健康与冒烟成功。
5. 验证真实HTTPS地址与该模块核心场景；必要数据审核通过后才打开能力。
6. 记录时间、commit、镜像digest、迁移head、验证人和结果。

单机Compose基础版更新可能短时中断，不承诺零停机。未来确需零停机时再设计双实例和兼容迁移。

## 8. 备份

```bash
bash scripts/backup.sh
```

备份文件位于backups/，权限受umask077限制且被Git忽略。建议初始每天一次，保留周期与部门确认；至少一份经过加密的离机副本。仅有备份脚本不等于已配置定时任务。

恢复演练应在独立数据库进行：使用对应PostgreSQL版本读取pg_dump格式，校验表数、迁移版本、内容与权限。不要自动对当前生产库执行覆盖恢复；实际生产恢复先停写、确认目标并保存现状。

## 9. 回滚

- 优先关闭故障模块能力，保留资料浏览和基础站。
- 数据库向后兼容时，用上一个已验证commit/镜像重新启动服务。
- 不自动执行Alembic downgrade；DROP列/表可能丢数据。
- 已进行不兼容迁移时采用前向修复，或明确停机与备份恢复方案；恢复前确认数据损失窗口。
- APP_VERSION镜像标签便于区分，但真正的发布身份是commit+digest+迁移head。不要只依赖可覆盖标签。

## 10. 监测和排错

`docker compose ps`看服务状态；`docker compose logs --tail=100 api`查看请求标识；不要导出环境变量或完整请求文本。live只表示进程响应，ready还检查数据库/迁移。外部探测需独立检查HTTPS与静态资源，不只探测内部端口。

常见失败：数据库密码占位（生产启动拒绝）、域名未列入ALLOWED_HOSTS（400）、数据库迁移失败（ready503）、镜像拉取受限、端口冲突、代理未配置。同一问题按明确错误定位，不以重启掩盖。

## 11. 外部平台接入

当前Compose不注入NK-GeniOS密钥，因为实际适配器未完成。M04提交时增加已验证配置字段、secret注入和健康检测，禁止仅增加一个enabled=true就宣称接通。正式接入记录必须包含去敏请求/响应样例。
