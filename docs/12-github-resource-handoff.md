> 历史交付记录：本页地图和图书馆一层包只对应当时版本。2026-09-24完整20栋楼层资源与后台编辑以 [17-floor-release.md](17-floor-release.md) 和 [18-resource-editor.md](18-resource-editor.md) 为准；本轮不要重跑本页旧地图导入。

> 本文保留v2资源与图书馆1层的交接记录。地图去序号、分层名称和扩大点击范围的新交付请按[地图v3更新](13-map-interaction-update.md)执行；本轮楼层也更新为仅有标注图的revision 2。

# GitHub 资源交付与服务器导入

2026-09-23：用户明确指定GitHub为Codex与DeepSeek之间的代码、部署指导和素材传输渠道，允许本项目图片素材直接上传GitHub。后续资源交付优先使用本仓库Releases；代码和规范继续提交本仓库。

## 本批下载入口

[校园地图v2与图书馆一层资源包](https://github.com/jiawenyi-2512921/TwinNKU/releases/tag/resources-2026.09.23-v1)

资源标签：`resources-2026.09.23-v1`，对应已通过CI的代码提交`bc58670e510aa212db86b9e0870e6489d0b682a4`。此批只交付校园地图与图书馆1层，其他90层仍待原文件接入；GitHub发布不等于服务器已经导入。

| 附件 | 内容 | 字节数 | 解压目录 |
|---|---|---:|---|
| `TwinNKU-map-assets-v2.zip` | 8279×5604校园图，265张PNG图块、23个点击点位及manifest | 86899933 | `jinnan-v2/` |
| `TwinNKU-floor-assets-library-1F-v1.zip` | 图书馆1层：已标注与无标注两张PNG及manifest | 2356264 | `floors-library-1f-v1/` |
| `SHA256SUMS` | 两个ZIP的完整文件摘要 | — | 不解压 |

保留既有图片原始字节与尺寸，本次上传不重新编码或降采样。两份运行资源包均不含实拍照片。GitHub自动生成的`Source code`附件只有源码；部署所需图片在以上两个专门命名的ZIP中。

## 1. 下载并验证

进入服务器**正在运行的TwinNKU项目目录**，保留现有`.env`及数据卷。代码至少包含上述提交；若需更新代码，沿用`SERVER-START.md`的更新流程。

在该项目目录的Bash会话执行：

```bash
set -euo pipefail
ASSET_BASE='https://github.com/jiawenyi-2512921/TwinNKU/releases/download/resources-2026.09.23-v1'
mkdir -p var/release-downloads var/map-import var/floor-import
for asset in TwinNKU-map-assets-v2.zip TwinNKU-floor-assets-library-1F-v1.zip SHA256SUMS; do
  curl --fail --location --retry 3 "$ASSET_BASE/$asset" \
    --output "var/release-downloads/$asset"
done
(
  cd var/release-downloads
  sha256sum --check SHA256SUMS
)
unzip -n var/release-downloads/TwinNKU-map-assets-v2.zip -d var/map-import
unzip -n var/release-downloads/TwinNKU-floor-assets-library-1F-v1.zip -d var/floor-import
test -f var/map-import/jinnan-v2/manifest.json
test -f var/floor-import/floors-library-1f-v1/manifest.json
```

只有两个ZIP均显示`OK`才继续。`unzip -n`保留已存在的文件；若导入器发现本地同版本内容损坏或冲突，先按报错核对现有目录，保留原资源，不用强制覆盖绕过版本校验。

独立摘要：

```text
e02415762bc26ee564403f20b165c5c8b44ba62aea63584046bdc0db55955544  TwinNKU-map-assets-v2.zip
aade53c2aca65795e67577b75ed6cbc6d088d383b1497a229f9fb7cbf5282ece  TwinNKU-floor-assets-library-1F-v1.zip
```

## 2. 导入并发布

沿用已经部署的数据库、镜像及卷。确认`MAP_ENABLED`与`FLOORS_ENABLED`启用，迁移为`0003_floor_plans`。`--reviewer`填写实际资料核对人；`--rights-note`记录本轮用户明确授权的公开交付/项目展示范围，无需虚构校方审核或审批记录。

先校园地图，再楼层；第二步依赖图书馆点位已经导入。

```bash
docker compose --profile tools run --rm map-import /incoming/jinnan-v2 \
  --reviewer '实际资料核对人' \
  --rights-note '项目用户已授权通过GitHub公开交付并用于校园导览展示的本批修订规划图' \
  --publish

docker compose --profile tools run --rm floor-import /incoming/floors-library-1f-v1 \
  --reviewer '实际资料核对人' \
  --rights-note '项目用户已授权公开交付并用于校园导览展示的图书馆一层整理双图' \
  --publish
```

导入器验证manifest、字节数、尺寸、SHA256、版本和点位绑定。`--publish`使本批内容对外可读；省略该参数只会导入草稿。同一版本不可悄悄换图。

## 3. 验收与回传

```bash
docker compose ps
python3 scripts/smoke.py http://127.0.0.1:8080
python3 scripts/smoke.py https://2512921.cn
```

本地端口若不是8080，使用实际端口。预期：

- 状态接口`map=true`、`floors=true`。
- 地图列表含revision 2校园图；点位分页的`total=23`，单页可能少于23。
- 地图图块检查通过；楼层检查出现`PASS 1 published floors and byte-identical clean/labeled images`。
- 手机打开地图→图书馆→1层，两种图片可切换，缩放及分享链接正常。

回传：运行提交号、容器健康状态、两个导入命令的结果及冒烟输出。只打印所需检查项，不回传`.env`或完整环境变量。

若地图或楼层仍为空，检查运行容器的开关、数据发布状态以及反向代理实际指向的实例。健康检查通过只代表基础服务就绪。

## 4. 后续交付约定

Codex将新的代码、规范和资源清单更新到GitHub，将图片等大文件作为版本化Release附件交付，附摘要和导入步骤。DeepSeek按具体资源标签下载、验证和部署。已发布资源附件保持原内容，新素材使用新标签及相应数据revision。

用户本轮允许图片经GitHub传输；程序仍按各模块的清单格式读取素材。运行楼层资源包继续使用clean/labeled双图结构。素材上传授权不代表尚未实现的AI、VR、路线或房间功能已经完成。
