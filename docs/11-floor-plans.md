# M05a 楼层双图查看 · v0.3.0

## 1. 本轮要求与真实状态

按用户最终要求提前实现独立楼层查看，不等待智能体、全景或路线模块。每层由已标注图和无标注图组成，默认展示已标注图；实拍照片只作原资料方核对依据，不进入GitHub、网站、资源包或公开接口。第20项综合实验楼C区未完成，本批排除。

已通过共享飞书目录核对19项、91个楼层子目录，并建立稳定建筑/楼层/地图ID。**目录核对不等于原文件已接收。本次已取得图书馆1层的原始双图，完成逐字节核验、配对打包和本地导入；其余90层尚未取得完整双图。没有修改用户服务器，不能把此次源码交付说成91层已经上线。** 后续继续收集两类整理图的原文件或ZIP；不能使用浏览器截图代替原尺寸图。

现有校园图保持8279×5604、84项名称版本，撤回的四个文化点位、绿化改绘均未恢复。校园地图revision 2只增加点击范围，共23项：原5项保留，19项楼层建筑与原图书馆重合1项，新增18项。265张图块与revision 1逐字节一致。

## 2. 建筑与楼层目录

权威机器清单：`data/floors/jinnan-v1/intake.json`。校园显示位置：`data/maps/jinnan-v2/catalog.json`。ID不从显示名临时计算；清单内ID为本批正式绑定，后续保留。

| 来源序号 | 地图名称 | 已看到的楼层目录 |
|---|---|---|
| 1 | 材料科学与工程学院 | 1—5 |
| 2 | 电子信息与光学工程学院 | 1—5 |
| 3 | 公共教学楼A区 | 1—4 |
| 4 | 公共教学楼B区 | 1—5 |
| 5 | 公共教学楼C区 | 1—5 |
| 6 | 公共教学楼D区 | 1—4 |
| 7 | 计算机学院、网络空间安全学院、人工智能学院 | 1—6 |
| 8 | 理科食堂 | 1—3 |
| 9 | 前沿交叉学科中心 | 1—2 |
| 10 | 软件学院 | 1—5 |
| 11 | 体育馆 | 1—4 |
| 12 | 图书馆 | 1、2、3、4、5、7 |
| 13 | 学5-A | 1—6 |
| 14 | 学5-B | 1—6 |
| 15 | 学5-D | 1—6 |
| 16 | 学6 | 1—4 |
| 17 | 学7-A | 1—6 |
| 18 | 综合实验楼A区 | 1—4 |
| 19 | 综合实验楼B区 | 1—5 |

第3项来源目录写作“公告教学楼A区”，地图仍使用“公共教学楼A区”。第9项来源写作“前沿交叉学科研究中心”，展示沿用已确认底图名称，来源名称作为别名。图书馆没有看到六楼目录，不能补造。总公教楼点位保留原ID，具体楼层绑定A/B/C/D分区点位。

新点击范围为依据规划图的人工显示圈选，便于打开资料；不是实测建筑边界、入口坐标或导航网络。上线前还应核对分区边界。

## 3. 用户交互

1. 搜索或点击地图上的建筑，打开“楼层结构”。食堂、宿舍同样有入口。
2. 按数字顺序选择实际已发布的楼层；不以文件名的字典排序决定楼层顺序。
3. 默认已标注图，可切换无标注图。每张图保留自己的尺寸；两张图尺寸不同时重新适配窗口，不强行共用坐标。
4. 支持拖动、滚轮/双指缩放、放大/缩小、适合窗口、1:1原尺寸查看和大图模式。100%以上仅放大已有像素。
5. `?point=<UUID>&floor=<UUID>`可返回指定建筑与楼层；楼层必须属于当前建筑，否则选择其第一个公开楼层并同步修正链接。重选同一建筑保留当前楼层；切换建筑、返回概览或没有可用楼层时清除旧楼层参数。没有楼层入口的地点不会因伪造floor参数打开楼层页。
6. 请求切换、组件卸载使用AbortSignal，旧请求不覆盖新建筑。缺图显示错误与重试，不替换成相邻楼层。

本次没有房间点击、房间搜索、室内路线、跨层连接或show_floor智能体动作。图上文字不是结构化房间数据。

## 4. 接口契约

唯一DTO源：`app/contracts.py`。现有operation_id保留，listFloors/getFloor从计划契约迁到运行路由。listRooms仍为planned，生产不挂载。

| 方法与路径（前缀/api/v1） | 结果与权限 |
|---|---|
| GET /points/{point_id}/floors | Envelope[Floor[]]；ordinal升序。建筑不公开返回404；建筑公开但没有楼层/模块关闭返回空数组 |
| GET /floors/{floor_id} | Envelope[Floor]；楼层、建筑、校园、所属地图同时有效，否则404 |
| GET /floors/{floor_id}/images/{revision}/{variant} | 原文件字节；variant仅labeled/clean；旧版本404，不提供original |
| GET /maps/{map_id} | 楼层MapInfo以已标注图为基准，kind=floor、tiles=null；同样检查楼层与建筑权限 |
| GET /campuses/{campus_id}/maps | 返回各自开关允许且授权的地图；前端选kind=campus作为校园底图 |
| GET /system/status | floors只有存在可公开楼层且FLOORS_ENABLED=true时才为true；不连带启用routing/chat |

Floor保留id、point_id、label、ordinal、map_id、revision，新增images、attribution。images每项含variant、width_px、height_px、sha256、media_type、size_bytes、url；不返回私有文件路径、实拍文件名或文件服务凭据。媒体类型仅image/png或image/jpeg。

楼层图片不走地图瓦片端点。已标注图定义未来楼层map_id的基准；若未来房间坐标基于另一张图，必须明确新版本及坐标基准，不能混用。

楼层列表返回后才把实际选中的楼层写入分享链接。来自已切换建筑的迟到响应不能重写当前建筑链接。

二进制图片端点逐次检查发布状态，Cache-Control为no-store、X-Content-Type-Options为nosniff。目录位于API只读数据卷，Nginx不直接暴露。已经查看的公开图片仍可被截图；本模块不承诺阻止所有复制。

## 5. 数据与导入

迁移head：`0003_floor_plans`。新增floors与floor_imports，楼层地图使用既有maps表。每个(point_id, ordinal)与map_id唯一，floor_id的建筑/楼层序号/map_id绑定不可静默更换。

楼层资源包根目录含manifest.json与`<floor_id>/<revision>/labeled.png|jpg`、`clean.png|jpg`。清单schema_version=1，每层两图，禁止额外图片和未列出的文件。API不提供无认证上传或发布入口。

准备流程：

1. 在仓库外建立私有接入清单副本。将每层的clean_file、labeled_file填写为两张整理图的真实原文件路径；相对路径按清单所在目录解析。不得指向实拍文件，不凭扩展名猜角色。
2. 逐层核对建筑、层号、标签与两张图内容。没有完整两图时保留null。
3. 在apps/api目录构建资源包：

```bash
uv run python ../../scripts/build_floor_bundle.py \
  /absolute/path/floor-intake.local.json /absolute/path/floors-v1
```

默认任一楼层缺图即停止，不生成半成品。确需分批时显式增加`--partial`，输出会列出所有跳过楼层；零个完整楼层仍拒绝。第20项硬性排除。不得把--partial的结果报告为完整91层。

生成器只复制两份明确指定的文件；生成器和服务器导入器都会拒绝两种角色使用同一份字节。检查静态PNG/JPEG、完整可解码数据、每张不超过32MiB/4000万像素/单边20000像素；EXIF旋转需先回到原资料方核实，不隐式旋转。检查不重编码源图。

导入时校验全部图片的尺寸、类型、字节数和SHA256，拒绝路径穿越/符号链接/额外实拍；记录审核人、公开依据、清单hash、revision、时间和发布状态。同版本内容不可变，相同包可重复审核；旧版本拒绝覆盖。新版本沿用ID并增加revision。文件以临时目录完成后原子改名，数据库事务失败不会部分发布，但可能留下未引用的同版本资源目录；按原包恢复，不随意覆盖。

```bash
uv run python -m app.modules.floors.import_bundle /absolute/path/floors-v1 \
  --reviewer '实际核对人' --rights-note '实际公开范围及依据'
```

默认draft/internal。显式`--publish`才公开；建筑必须已公开且校园启用。重新以草稿导入同一版本会撤回该批楼层。此CLI留痕不代表校方SSO或自动获得正式公开授权。

## 6. 服务器更新（用户与DeepSeek执行）

1. 获取本次`feat/floor-viewer-m05`的明确提交，保留.env与现有卷；本分支包含先前地图PR的代码。main尚未合并时不能直接拉main冒充本版本。
2. 按原流程构建与迁移：`bash scripts/deploy.sh`。ready要求0003_floor_plans。API增加只读floor_assets卷，floor-import工具服务可写该卷。新卷目录属于容器用户10001。
3. 校园新增建筑需要revision 2目录包。若已有v1资源包，可在开发机器复用同一批图块生成：

本轮随交付提供`TwinNKU-map-assets-v2.zip`，可直接解压取得`jinnan-v2/`，不必重复生成。文件86,899,933字节；SHA256为`e02415762bc26ee564403f20b165c5c8b44ba62aea63584046bdc0db55955544`。包内265个PNG与v1逐文件相同，更新的是点位目录与几何。

```bash
cd apps/api
uv run python ../../scripts/reuse_map_tiles.py \
  /absolute/path/jinnan-v1 ../../data/maps/jinnan-v2/catalog.json /absolute/path/jinnan-v2
```

这一步不缩放、不重编码图块，校验旧包与新目录的尺寸/源hash/图块参数完全一致。复制生成的jinnan-v2到服务器`var/map-import/`，然后：

```bash
docker compose --profile tools run --rm map-import /incoming/jinnan-v2 \
  --reviewer '实际核对人' --rights-note '具体允许展示的范围' --publish
```

4. 完整楼层双图准备好后，将构建的floors-v1放入`var/floor-import/`。当前仓库不含这批原图，也不会在启动时自动从飞书抓取。

```bash
docker compose --profile tools run --rm floor-import /incoming/floors-v1 \
  --reviewer '实际核对人' --rights-note '具体允许展示的楼层与依据' --publish
python3 scripts/smoke.py http://127.0.0.1:8080
```

5. 浏览器核对每个已导入建筑、楼层顺序、双图角色、手机缩放、大图关闭与分享链接。记录实际commit、迁移head、导入批次、审核人及结果，再认定上线完成。

## 7. 关闭、回退与备份

设置`FLOORS_ENABLED=false`并重建API配置，可独立关闭楼层读取；校园地图、点位与基础服务继续运行。关闭MAP_ENABLED不自动关闭楼层；如需二者都关闭须分别设置。回退前检查代码是否支持新迁移head，不执行删表降级，不删除数据库/地图/楼层卷。

除数据库外，备份map_assets、floor_assets及各版资源包和hash。源文件留在原资料方。正式接入材料缺失、损坏或撤回时，前端显示暂无资料/无法加载，不使用其他建筑图片替代。


## 8. 图书馆一层实际双图交付

本批文件名为`TwinNKU-floor-assets-library-1F-v1.zip`，解压后为`floors-library-1f-v1/`。只有1层、2张PNG和manifest.json，不含实拍、不含其他楼层。ZIP大小2356264字节，SHA256为`aade53c2aca65795e67577b75ed6cbc6d088d383b1497a229f9fb7cbf5282ece`。

对应点位ID：`48da7106-7d24-5493-84d3-48d334d07410`；楼层ID：`91719ef5-6e0b-510c-a24c-4f47b6749e76`；revision=1。可核对的无图片清单见`data/floors/jinnan-v1/library-1f-manifest.json`。公共intake中本层status为bundle_ready，但clean_file/labeled_file仍为null，防止把私有源路径写入Git；直接导入已交付包即可。

| 图种 | 原文件尺寸 | 原文件字节数 | SHA256 |
|---|---|---|---|
| 无标注 | 1838×1084 | 1374029 | 28f38f361935590444b5cf27c1c6063ef33d5eb467df148248dc3f722558fa66 |
| 已标注 | 1675×937 | 980417 | 52d85727e25fbac029c4d3ce1cea8f7a130ae05f5bc61d078809bb6ae0895a00 |

两张源图尺寸不同，保留各自原文件，不拉伸、不重编码；本批仅支持整图查看，没有逐房间核对或导航。用文件中的房号和箭头推算实际路线仍不受支持。

将解压目录放到服务器`var/floor-import/`，使用本次源码构建后，由实际负责人确认公开范围，再执行：

```bash
docker compose --profile tools run --rm floor-import /incoming/floors-library-1f-v1 \
  --reviewer '实际核对人' --rights-note '实际允许展示图书馆一层整理双图的依据' --publish
python3 scripts/smoke.py http://127.0.0.1:8080
```

期待冒烟输出`PASS 1 published floors and byte-identical clean/labeled images`；如已发布更多楼层，数字应增加。随后使用实际站点地址加上`?point=48da7106-7d24-5493-84d3-48d334d07410&floor=91719ef5-6e0b-510c-a24c-4f47b6749e76`核对切换、缩放和分享链接。
