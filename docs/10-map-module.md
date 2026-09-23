# M01 地图交互基础版 · v0.2.0

## 范围与数据依据

采用用户已确认并恢复的84项名称标注版，8279×5604像素。没有采用撤回的绿化图，没有重新加入周恩来雕像、张伯苓雕像、严范孙雕像、学生文化谷四个撤回标注。已有地图文字保留，不代表全校建筑均已做点击轮廓。

5个试点：南门、图书馆、公共教学楼、大通学生活动中心、马蹄湖。轮廓是对规划图可见范围的人工圈选，仅用于点击定位；入口IDs为空，未建立可行走路网。简介、VR、讲解、楼层均未编造。

源PNG SHA256：`aa5f84fc993dca7371e1d1bf6a5e190925ec2ce5f0d2d4dc968093346028218f`。

应用地图ID：`eee88cf5-87a0-592e-b1cc-a70674941bbf`；应用地图revision：1。文件历史版本号和API地图revision不是同一概念。

## 已实现的行为

- 规划图拖动、鼠标/触摸缩放、放大/缩小按钮、回到全图、地点标记开关。
- 五个地点的多边形点击、高亮、编号标记；位置随缩放保持一致。
- 名称和别名搜索、分类筛选、无结果提示；列表与地图联动。
- 桌面侧浮层、手机底部详情；定位时预留面板空间，地点不被遮挡。
- `?point=<UUID>`地点直达链接、复制链接；无效ID不触发任意请求。
- 建筑详情中的“楼层结构”入口。目前显示待补充，不发起尚未实现的楼层API请求。
- 已预留按map_id/revision过滤的路线显示层，但没有生成或开放路线服务。
- `MAP_ENABLED=false`可关闭地图读取；已发布点位目录仍可浏览。素材读取一直经过后端公开状态检查。

## 图像与坐标

`data/maps/jinnan-v1/catalog.json`保存点位、人工点击轮廓与源图校验值。业务层统一使用原图左上角像素`{x,y}`；仅`features/map/coordinates.ts`转换成Leaflet坐标。瓦片为512×512、zoom 0—5，共265块；zoom 5为187块原尺寸无损PNG。边缘以透明像素补齐，不能把残缺尺寸图块交给浏览器拉伸。

源图和最高层没有重采样。低层是用于远景浏览的缩略层，不替代原图。超过原尺寸的放大只放大现有像素，不承诺产生新细节。

离线生成（开发工具需要ImageMagick；只读验证另需Pillow）：

```bash
python3 scripts/build_map_bundle.py /absolute/path/original.png /absolute/path/jinnan-v1
python3 scripts/verify_map_bundle.py /absolute/path/original.png /absolute/path/jinnan-v1
```

生成器要求源图校验值与catalog完全相符。资源包包含`jinnan-v1/manifest.json`及`jinnan-v1/tiles/`，每一块都记录SHA256。生成文件与原始大图不入Git，不进入前端public目录。

## 数据库与接口

迁移：`0002_map_catalog`，增加maps、point_geometries、map_imports。点位继续使用M00的points表。导入审核记录含审核人、实际说明、时间、manifest校验值和发布标志；这不是校方SSO，也不代表自动获得学校正式公开授权。

| 已实现端点 | 行为 |
| --- | --- |
| GET /api/v1/campuses/{campus_id}/maps | 仅返回启用校园下公开发布的地图 |
| GET /api/v1/maps/{map_id} | 元信息、源图尺寸/校验值和瓦片模板 |
| GET /api/v1/maps/{map_id}/features | 只返回当前地图版本、公开已发布点位的几何 |
| GET /api/v1/maps/{map_id}/tiles/{revision}/{z}/{x}/{y}.png | 状态、版本、坐标和文件路径检查后返回PNG |

MapInfo新增tiles、source_sha256、attribution字段；原字段保留。以上三条原计划地图端点已经移到运行router。素材/楼层/AI/路线目标接口仍在planned_contract，不冒充实现。Pydantic、OpenAPI和前端类型同步生成。

当前图块为`Cache-Control: no-store`，确保撤回后新的读取必须重新授权。已经下载或截图的内容无法技术性收回。状态核查优先于缓存优化；后续可按真实访问压力设计带授权的缓存策略。

## 本地导入

先启动数据库并运行迁移/种子，再在`apps/api`执行：

```bash
uv run alembic upgrade head
uv run python -m app.seed
uv run python -m app.modules.maps.import_bundle /absolute/path/jinnan-v1 \
  --reviewer '实际核对人的姓名' \
  --rights-note '这份地图允许展示的具体范围与依据'
```

以上默认只登记草稿，公众API不可读。核对公开范围后，同一命令加`--publish`才会明确发布地图及资源包列出的5项点位元数据。没有无认证HTTP上传或审核接口。

校验包括：地图尺寸/版本、点位归属、坐标边界、非退化多边形、完整瓦片集合、PNG尺寸、SHA256、路径不能越出资源目录。同版本内容不可覆盖；相同包可重复导入并留下独立审核记录。导入旧版本会拒绝，修改内容须增加revision。不得用导入覆盖更高版本的正式内容。

## 服务器升级（由用户与DeepSeek执行）

1. 获取交付消息中的确切提交或PR分支，保留已有`.env`和数据库卷。构建并运行`bash scripts/deploy.sh`，迁移应到`0002_map_catalog`。
2. 将`TwinNKU-map-assets-v1.zip`上传至项目工作目录，解压到受控导入目录：

```bash
mkdir -p var/map-import
unzip TwinNKU-map-assets-v1.zip -d var/map-import
```

3. 使用专用导入服务。审核人和说明必须换成实际内容：

```bash
docker compose --profile tools run --rm map-import /incoming/jinnan-v1 \
  --reviewer '实际核对人的姓名' \
  --rights-note '实际允许公开的范围与依据' \
  --publish
```

`map-import`使用应用用户10001，拥有map_assets卷写权限；API仅只读挂载同一卷。地图资产目录不通过Nginx静态暴露。API镜像创建`/data/maps`并设置应用用户所有权。没有初始地图发布的自动迁移。

4. 运行基础冒烟，并检查地图能力和瓦片：

```bash
python3 scripts/smoke.py http://127.0.0.1:8080
```

地图发布后，冒烟还会读取地图、几何与一张PNG。浏览器核对五个点位、搜索、公教楼别名、手机详情和楼层待补充状态。最终上线结论必须来自实际服务器结果。

本地未运行Docker或真实PostgreSQL，不能把以上命令称为已经在用户服务器执行。

## 回退与备份

异常时设置`.env`的`MAP_ENABLED=false`并重建API容器配置，例如`docker compose up -d --force-recreate api`。不要删除pgdata/map_assets卷或降级删除表。代码回退前先确认旧版迁移健康检查是否接受新head。

数据库备份记录业务状态，地图原始资源包及其校验值也需保留。map_assets卷单独备份，不在数据库备份脚本覆盖范围内。

## 下一批楼层图的接入

用户提供“建筑正式名称＋楼层号＋原图”，再补公开范围与必要核对。沿用本次点位UUID建立Floor记录，每层单独map_id和revision；不得从文件名猜房间号，也不将清理图直接当作可走路网。

前端入口是`features/floors/FloorPanel.tsx`，图像坐标/显示能力复用MapCanvas。此轮未实现楼层内容导入、房间识别、室内导航，上传楼层图后按实际资料补充。

### 本批点位对应表

| 正式名称 | point_id |
| --- | --- |
| 南门 | `e62f4f62-7a79-5ec8-b391-e1e2fe00056b` |
| 图书馆 | `48da7106-7d24-5493-84d3-48d334d07410` |
| 公共教学楼 | `f6527692-d448-50fb-ae1f-df0a082ee28d` |
| 大通学生活动中心 | `a3ce1544-4a2c-5712-9a47-6f0a3a458b2c` |
| 马蹄湖 | `13d78a03-9905-5d19-9738-1a8c1d91e0bd` |
