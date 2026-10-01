# 短首段语音与随行字幕部署验收

2026-09-30，接续 `feat/admin-console` 的 `6064421`，部署 `98a1309`（`fix: shorten initial speech wait and keep subtitles beside companion`）。本批为[50 语音等待与字幕定位](50-voice-latency-and-captions.md)的实际部署验收记录。

## 改动范围

`git show --stat 98a1309` 只触及前端、测试与文档：

| 检查项 | 结论 |
| --- | --- |
| `data/`（坐标数据） | 未改 |
| `apps/api/`（后端） | 未改 |
| 新增迁移 | 无 |
| `compose.yaml` / `.env.example` | 未改 |
| 新增环境变量 | 无 |

主要文件：`cloudVoice.ts`（+97）、`companionPosition.ts`（新增 94）、`useCompanionPosition.ts`（新增 70）、`native.css`、`NativeAgentDock.tsx`，测试 `cloud-voice.test.mjs`（+241）、`companion-subtitles.test.mjs`（新增 164）。

因此**只重建 web**。不重建 api 是有意为之：api 容器一旦重建，进程内的语音缓存与限流计数会被清零，而本次后端零改动。

## 部署

```bash
cd /root/TwinNKU
git pull                  # → 98a1309
# .env: APP_VERSION 1.6.1 → 1.6.2
docker compose build web  # → twinnku-web:1.6.2
docker compose up -d web
```

部署后容器状态：

```
SERVICE      IMAGE                  STATUS
agent-demo   sha256:ee5b772c...      Up 47 hours (healthy)
api          twinnku-api:1.6.1       Up 4 hours (healthy)
db           postgres:17-alpine      Up 6 days (healthy)
web          twinnku-web:1.6.2       Up (healthy)
```

api 仍显示 `1.6.1` 是符合预期的：`compose.yaml` 使用显式 environment 锚点而非 `env_file`，环境变量在容器创建时冻结，改 `.env` 必须 `up -d` 重建才生效（`restart` 无效）。本次不改后端，不重建 api 是正确选择；接口行为与 v1.6.1 一致。

## 上线验证

服务可达性：

```
127.0.0.1:8080/                      → 200
127.0.0.1:8080/api/v1/voice/status   → 200
```

```json
{"enabled":true,"provider":"bailian","tiers":["primary","backup"],
 "models":["qwen3-tts-flash","qwen3-tts-instruct-flash"],
 "max_characters":300,"cached_clips":16}
```

构建产物已换新：

```
首页引用: main-386tLyvw.js / main-BBto1D77.css
main-386tLyvw.js 含 companionPosition / ResizeObserver → 命中 2 处
```

数据完整性（线上库复核）：

```sql
select count(*) from point_geometries;                    -- 83
select p.name, pg.anchor->>'x', pg.anchor->>'y'
  from point_geometries pg join points p on p.id = pg.point_id
 where p.name like '%西南门%';                              -- 西南门 | 2531.171 | 5010.456
```

83 条点位完好，西南门坐标未变。

## 浏览器验收

使用 Playwright（Chromium，移动端视口 420×780）。**未使用** `--autoplay-policy` 覆盖——那会绕过本次要验证的播放限制。

### 短首段与预取

```
{'kind': 'play',       't': 1124,  'rejected': 'AbortError'}
{'kind': 'play',       't': 7284,  'resolved': True, 'ct': 0,    'paused': True,  'ok': False}
{'kind': 'speech-req', 't': 17098, 'chars': 73,  'status': 200, 'ttfb': 5533}
{'kind': 'play',       't': 22635, 'resolved': True, 'ct': 1.16, 'paused': False, 'ok': True}
{'kind': 'speech-req', 't': 22648, 'chars': 209, 'status': 200, 'ttfb': 11630}

合成请求 2 次 / 播放尝试 3 次（真正发声 1）
首段字符数: 73
第二次请求距首次播放开始: 13 ms
```

- 首段 73 字符 ≤ 80，短首段策略生效，不必等整段合成完才出声。
- 第二次合成请求在首次播放开始后 13 ms 发出，确认是「开播后立即预取」，不是「播完再请求」。
- `t=22635` 那次 `ct: 1.16, paused: False, ok: True`，音频确实在走，不是「`play()` 未报错但实际没播」。

`AbortError` 是 `cancel()` 的设计内路径（`request?.abort()` 用于打断/接管上一段），验收脚本已按 `rejected != "AbortError"` 过滤。`ok: False`（`ct: 0, paused: True`）是播放前的静音预热元素，属预期。

### 字幕跟随小开

首次运行曾报「未找到字幕元素」。核对渲染条件后确认是**测试写错**：`NativeAgentDock.tsx` 中

```
{open && !expanded && !minimized && caption && (
```

浮动字幕只在文字抽屉收起时显示。修正脚本、改为提问后点击「收起文字抽屉」再取几何：

```
步骤 4：等待字幕出现        +1.5s 字幕出现
步骤 5：字幕几何
  存在: True
  文本: '正在查阅校园资料…'
  方向 data-side: above
  字幕: {'x': 84,  'y': 494, 'w': 320, 'h': 43}
  小开: {'x': 232, 'y': 549, 'w': 144, 'h': 163}
  视口: 420x780
  完全在视口内: True
  与小开的偏移 dx=148 dy=55 → 邻近: True

步骤 6：拖动小开后字幕是否跟随
  拖动前字幕: {'x': 84, 'y': 494, ...}
  拖动后字幕: {'x': 16, 'y': 242, ...}
  字幕是否跟随移动: True
  拖动后仍在视口内: True

字幕验收全部通过
```

## 回归与 CI

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 前端 | `node --test tests/*.test.mjs` | 281 passed / 0 failed（v1.6.1 为 263） |
| 后端 | `python -m pytest -q` | 364 passed / 8 skipped（与 v1.6.1 持平） |
| CI | `compose-smoke` + `contracts-and-tests` @ `98a1309` | 均 success |

新增 18 个用例正好覆盖本次两个改动（`cloud-voice.test.mjs` +241 行、新增 `companion-subtitles.test.mjs` 164 行）。

## 需要知晓的两点

**缓存与限流是进程内的。** 语音片段缓存随容器重启清零（本次观察 14 → 16 的自然增长，无重启）。多容器部署前需换成共享存储，否则各副本缓存/限流互不相通。

**`APP_VERSION` 与实际容器值可能不一致。** 见上「部署」一节，根因是显式 environment 锚点而非 `env_file`。这是本项目最容易绊倒的一处，下一次涉及后端或环境变量的发布务必记得 `up -d` 重建。

## 真机验收仍未完成

自动化只能证明元素确实在走，不能证明人耳真的听到了。待测项：

- iPhone Safari / Android Chrome / 桌面端首次打开，预热不被 CSP 阻断；
- 语音提问 → 云端回答可听到且音色正确，回答结束后麦克风才恢复；
- 打字提问无需二次授权即可播放；
- 自动播放被拦时，点击播放图标恢复同一段音频，且不产生第二次合成请求；
- 打断 / 收起 / 新对话 / 切后台 / 视频播放时音频停止，且无延迟补播；
- 云端失败且无系统音色时显示重试图标并保留完整文字；第二段失败不重读第一段；
- 地图 / 楼层 / 路线 / VR 原有功能未受影响；
- 字幕：四边拖动、窄屏、横屏、键盘弹出时字幕贴小开且在视口内可滚动；抽屉展开时不出现重复字幕。

建议用浏览器 Network 面板记录 `/agent/chat` 与 `/voice/speech` 的请求开始 / 首字节 / 完成时间，与实际出声时刻对比，作为体验指标的基线。

## 回退

本次未修改代码、迁移、权限或地图素材，回退只需将 `APP_VERSION` 改回 `1.6.1` 并 `docker compose up -d web`。部署前的数据库与 `.env` 备份保留在服务器 `/root/`。
