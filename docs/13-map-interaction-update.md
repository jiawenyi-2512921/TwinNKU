# 地图交互改版与当前产品目标

2026-09-23。针对“建筑都能点击、序号太乱、未放大时看不清文字、项目方向不清楚”的反馈。

## 产品目标

面向公众、校友和研学团体，提供校园文化与爱国主义教育的线上导览：找到地点、看懂介绍、查看实景、基于已审核材料追问，并按主题连续参观。宣传部负责内容口径和素材更新，系统减少重复咨询并指向官方申请渠道。

地图是进入内容的入口；楼层平面图是建筑详情中的补充材料。完成地图和楼层查看只是基础阶段，不能称为已完成AI导览。

下一阶段先完成一条可验收的线上主题导览：选5个有真实材料的点位 → 显示来源明确的介绍 → 按审核顺序参观 → 根据当前位置追问 → 没有材料时明确提示 → 如需入校则指向已核对的官方申请渠道。没有步行路网和距离依据时，仅提供线上参观顺序，不画假导航、不报假距离。随后扩展点位和主题，再做咨询统计和维护后台。

## 本次实现与用户最新要求

- 仅有名称的地点设置点击；未命名建筑不设点击、不进入列表。
- 新增**周恩来雕像**：用户最新指定在综合业务西楼与综合业务东楼正中央；作为独立景点，有独立UUID、名称、搜索和分享链接。此要求覆盖之前撤回该雕像的指示，其余张伯苓雕像、严范孙雕像、学生文化谷仍不添加。
- 地图、地点列表和详情删除排序序号；真实楼号如“学5-A”保留。
- 点击建筑区域或清晰名称打开详情；悬停、键盘聚焦和选中时高亮。名称关闭、资料不齐时，已命名区域仍可点击。
- 名称层保持14px屏幕字号、白底对比，自动避让；全图突出主要地点，放大逐步显示学院、宿舍和楼区。选择的地点优先显示，搜索与分类仍可访问全部命名点位。
- 重叠点击范围按面积绘制，大范围在下面，避免总体楼区盖住A/B/C/D。
- 保留原23个点位UUID及其元数据，既有图书馆楼层和分享链接继续有效。
- 地图和楼层只交付有标注图。楼层导入只需要`labeled_file`；前端移除无标注切换；公共楼层API只返回、提供有标注图，旧clean链接返回404。导入器仍识别旧双图包以兼容历史数据，但新生成器不会复制无标注图或实拍照片。

## 点击目录与来源

`data/maps/jinnan-v3/catalog.json`：地图revision 3，**83个命名点位、0个未命名区域**。其中84项原文字名称的三所共同用楼学院沿用同一点位，形成82个命名点位，再加用户指定的周恩来雕像。点位包含校门、湖泊、体育场、楼区和共用楼宇，83不是建筑物总数。

`coverage.json`保留原名称对应关系及雕像的位置依据。雕像图上锚点为1536×1040参考画布的(856,789)，即原图像素(4613.818,4251.496)附近；点击范围是人工图上定位，不冒充实测边界或导航入口。前沿交叉学科中心保留，综合实验楼C/D可以点击，C区未完成的楼层不导入。

## 图片与楼层交付

校园底图仍为8279×5604有标注版本，265张PNG瓦片与v2逐字节一致，未压缩、缩小或重绘。雕像名称以独立可点击文字叠加，不改写原底图像素。远景中的原图文字会随图片缩小，清晰名称层与搜索承担阅读功能，不将低清晰度截图替代原图。

图书馆1层沿用原楼层ID，更新到revision 2，只有一张1675×937有标注PNG，字节不变。其余90层仍待真实标注原文件。

无标注图可供将来制作可点击房间、设施或路线图层使用，但不是当前楼层查看所需的交付物；当前不上传、不展示，也不把它作为导入前置条件。

## 资源校验值

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| TwinNKU-map-assets-v3.zip | 86,748,264 | `7f3020a694eb5739638ef5480edc7fe4dd8ef700900c0e32e271129d65ec2ac8` |
| TwinNKU-floor-library-1F-labeled-v2.zip | 981,404 | `3a4988778866beaa831aa6f938ab46dc36ac98262206942e525321fbcca75281` |

## 给DeepSeek的升级步骤

代码使用本仓库`feat/floor-viewer-m05`分支、PR #3的本次交付提交；不要切回尚未包含这些功能的main。资源发布页：

https://github.com/jiawenyi-2512921/TwinNKU/releases/tag/map-interactions-2026.09.23-v3

先更新代码并执行`bash scripts/deploy.sh`，保留已有`.env`与数据库/图片卷。服务器部署由用户与DeepSeek执行，本文不是已部署记录。

```bash
mkdir -p var/map-download-v3 var/map-import var/floor-import
curl -fL --retry 3 'https://github.com/jiawenyi-2512921/TwinNKU/releases/download/map-interactions-2026.09.23-v3/TwinNKU-map-assets-v3.zip' -o var/map-download-v3/TwinNKU-map-assets-v3.zip
curl -fL --retry 3 'https://github.com/jiawenyi-2512921/TwinNKU/releases/download/map-interactions-2026.09.23-v3/TwinNKU-floor-library-1F-labeled-v2.zip' -o var/map-download-v3/TwinNKU-floor-library-1F-labeled-v2.zip
curl -fL --retry 3 'https://github.com/jiawenyi-2512921/TwinNKU/releases/download/map-interactions-2026.09.23-v3/MAP-V3-SHA256SUMS' -o var/map-download-v3/MAP-V3-SHA256SUMS
(cd var/map-download-v3 && sha256sum -c MAP-V3-SHA256SUMS)
unzip -n var/map-download-v3/TwinNKU-map-assets-v3.zip -d var/map-import
unzip -n var/map-download-v3/TwinNKU-floor-library-1F-labeled-v2.zip -d var/floor-import
docker compose --profile tools run --rm map-import /incoming/jinnan-v3 \
  --reviewer '填写实际核对人' \
  --rights-note '用户授权地图经GitHub交付；只发布命名点位与用户指定的两座业务楼中央周恩来雕像；图上人工点击范围' \
  --publish
docker compose --profile tools run --rm floor-import /incoming/floors-library-1f-labeled-v2 \
  --reviewer '填写实际核对人' \
  --rights-note '用户提供并要求仅交付有标注楼层图；本批图书馆1层标注原图不重编码' \
  --publish
python3 scripts/smoke.py http://127.0.0.1:8080
python3 scripts/smoke.py https://2512921.cn
```

导入结果：地图revision 3、83 points；楼层导入1 floor、1 image，图书馆1层revision 2；map/floors保持true。AI、VR、主题导览不会因此启用。不要删除旧数据卷、重建数据库或强行覆盖旧版本；正常导入新revision即可，原分享链接继续指向同一楼层。

人工验收：全图没有编号圆点；名称字号稳定；放大出现更多名称；已命名建筑可选，未命名建筑不可选；搜索周恩来雕像并确认在两座业务楼正中央；关闭名称后建筑仍可点击；楼层只显示有标注图，无“无标注”按钮，旧clean直链返回404；手机详情、缩放与分享可用。后端返回83个区域不等于已经完成全机型触摸验收。
