# 20栋楼原图交付与部署步骤 · 2026-09-24

本次仅交付GitHub代码、资源及指导，服务器由用户/DeepSeek更新。不要执行旧地图导入，也不要重新导入旧点位种子覆盖用户的后台编辑。

## 交付对象

- 分支：`feat/admin-console`；既有PR #4。部署前记录实际commit并确认该commit的CI通过，不直接假设main已包含本功能。
- Release：`floors-2026.09.24-v1`，标题“20栋楼标注原图与后台楼层/VR编辑”。
- 资源文件：`TwinNKU-floors-jinnan-20260924-v1.zip`，**81,728,317字节**。
- SHA256：`fee22db8d4ab112da8eeb524c833d631dcb5d3a4236e613e72dafb99c63725d2`。
- 包内容：根目录 `floors-jinnan-20260924-v1/`，1份manifest + 100张PNG/JPEG标注原图；**20栋、96层、100图**。不含实拍、不含无标注图，不进行缩放/压缩/重画。
- 第20栋综合实验楼C区含1—5层。体育馆1、2层各3分区，3、4层各1张；图书馆含1/2/3/4/5/7层，不补造6层。
- 清单位于 `data/floors/jinnan-v1/`；图书馆1层继续使用revision 2，原文件和不可变摘要均不变；其余新层revision 1。

## 1. 先备份，再更新代码与迁移

在已有项目目录操作。先备份PostgreSQL、map_assets、floor_assets和.env，记录当前代码commit、容器镜像和卷名。备份脚本见 `scripts/backup.sh`；不得运行 `docker compose down -v`。

```bash
git fetch origin
git switch feat/admin-console
git pull --ff-only origin feat/admin-console
git rev-parse HEAD
bash scripts/deploy.sh
```

如果工作区有未提交更改，先保留并处理冲突，不强制覆盖。.env沿用原值；新可选开关 `VR_ENABLED=true` 默认启用已审核链接的公开展示。既有ADMIN_ENABLED、ADMIN_PUBLIC_ORIGIN和账号继续生效，不创建默认口令。

本次迁移为 `0005_resource_editor`，仅新增floor_uploads、resource_changes、panoramas；不修改既有点位与地图数据。deploy脚本会重建并启动迁移服务，执行幂等校区seed（仅补缺失校区，不导入点位），再启动API与前端。API的floor_assets卷改为可写，必须重建API容器；不能只替换前端。

`floor-import`使用构建好的API镜像，不是独立build目标。先运行部署脚本，再执行以下导入命令。

## 2. 下载并完整校验原图包

从本仓库上述Release下载ZIP和SHA256SUMS，放在同一目录。以下命令在已有项目根目录操作：

```bash
mkdir -p var/floor-import
curl -fL --retry 3 \
  https://github.com/jiawenyi-2512921/TwinNKU/releases/download/floors-2026.09.24-v1/TwinNKU-floors-jinnan-20260924-v1.zip \
  -o var/floor-import/TwinNKU-floors-jinnan-20260924-v1.zip
curl -fL --retry 3 \
  https://github.com/jiawenyi-2512921/TwinNKU/releases/download/floors-2026.09.24-v1/SHA256SUMS \
  -o var/floor-import/SHA256SUMS
(cd var/floor-import && sha256sum -c SHA256SUMS)
unzip -n var/floor-import/TwinNKU-floors-jinnan-20260924-v1.zip -d var/floor-import
```

若摘要不符或解压路径已有人为修改，停止导入并重新取得完整包。不要用浏览器截图、缩略图或微信压缩图补文件；不要为通过校验而改manifest中的摘要。

## 3. 发布96个楼层

前置条件：当前校园地图里20栋建筑已公开且ID与既有83点目录一致。程序会检查，缺建筑即整批拒绝。遇到缺点位先核对已有数据，不运行旧地图包覆盖后台位置。

```bash
docker compose --profile tools run --rm floor-import /incoming/floors-jinnan-20260924-v1 \
  --reviewer '实际核对人' \
  --rights-note '用户整理提供的已标注楼层图，用于本项目校园导览展示' \
  --publish
```

应返回floors=96、images=100、status=published。这条命令会更新楼层、楼层map记录和导入记录，不修改校园底图、校园点位名称、点击范围或周恩来雕像位置。包可重复导入，但如果后来在后台发布了更高楼层revision，旧包将拒绝覆盖；保留新版本，不降级强行重导。

## 4. 严格验收

```bash
python3 scripts/smoke.py http://127.0.0.1:8080
python3 scripts/verify_floor_release.py http://127.0.0.1:8080 \
  data/floors/jinnan-v1/labeled-manifest-20260924.json
python3 scripts/verify_floor_release.py https://2512921.cn \
  data/floors/jinnan-v1/labeled-manifest-20260924.json
```

严格验收应输出 `PASS {"buildings": 20, "floors": 96, "images": 100}`。它逐项核对ID/所属建筑/层号/revision/分区/尺寸/格式/字节数/SHA256；少一层、旧版本或图片变动均失败。普通smoke只能证明“现有公开资料可读”，不能独立证明这批96层齐全。

随后人工核对：公共教学楼A—D分区、体育馆同层A/B/C切换、图书馆实际层号、第20栋C区、手机缩放与大图关闭、楼层分享。图像文字供查阅，不代表已有可点击房间或导航路径。

## 5. 启用后台维护

后台 → “楼层与 VR” → 搜索建筑 → 选择已有楼层或新增 → 上传PNG/JPEG标注原图/填写HTTPS VR链接 → 保存草稿 → 提交审核 → 另一名审核员预览后发布。新增接口与权限细节见 [18-resource-editor.md](18-resource-editor.md)。

原图每张限32 MiB；容器Nginx已对上传端点设置32m。若最外层HTTPS反代还有默认1m限制，须同步给下面路径设置32m并保留原代理目标和headers：

```nginx
location ~ ^/api/v1/admin/points/[0-9a-f-]+/floor-images$ {
    client_max_body_size 32m;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

将配置合并到**已有对应域名server块**，先执行nginx配置检查再由部署方reload；不要新建重复server或改掉既有HTTPS/域名。原图不能靠先压缩成小图绕过上传限制。

## 6. 维护与回退

- FLOORS_ENABLED=false关闭公开楼层；VR_ENABLED=false关闭公开全景入口；ADMIN_ENABLED=false关闭后台。改变.env后重建API使配置生效，资料保留。
- 上传临时原件保存在floor_assets/.uploads；正式版本保存于floor_id/revision。暂未做自动清理或总空间配额，管理员关注剩余磁盘。勿人工清理正在审核或已发布版本。
- 同时备份数据库与floor_assets（包含上传原件、旧版本）；map_assets沿用原备份。两者应属于同一备份时间点。
- 应用回退须考虑新迁移head；旧代码ready只认识旧head可能拒绝启动。优先关闭受影响模块，不擅自执行删表降级。
- 本地演练已验证0004→0005、原有83点及范围不变、历史图书馆v2兼容、全包重复导入、100图HTTP原字节一致与漏层检测。GitHub CI与服务器验收是独立记录，不互相替代。
