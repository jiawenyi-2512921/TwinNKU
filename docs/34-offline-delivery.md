# 本轮离线提交包导入说明（备用）

日期：2026-09-25。离线包最初在GitHub连接器写入返回403时制作；之后按用户授权改用已登录的GitHub网页提交。正常交付现在使用远程 `feat/admin-console` 分支，部署见32；本说明仅保留为离线备用。包内不包含服务器密码、实际WebSDK appKey或生产数据。

**不要重复导入：**GitHub网页上传产生的提交ID与包内本地提交ID不同，即使文件内容相同也不能快进到包内HEAD。已从远程取得本轮代码的仓库无需再导入本包、应用补丁或cherry-pick包内提交。下文仅适用于尚未取得本轮改动的旧基线副本；最终运行状态以远程最新提交的CI和部署验收为准。

## 1. 包里有哪些文件

- `TwinNKU-NK-GeniOS.bundle`：本轮全部Git提交及其文件对象，可保留原提交身份和内容。
- `TwinNKU-NK-GeniOS.patch`：同一改动的标准Git邮件补丁，作为备用；不要与bundle重复应用。
- `RELEASE.json`：基线提交、交付提交、树对象和文件数量。
- `SHA256SUMS`：包内文件校验值。
- `docs/32-nk-genios-web-release.md`：部署、环境变量、故障处理、知识导出与验收。
- `docs/33-nk-genios-platform-setup.md`：你在NK-GeniOS要填写的内容、知识库、六个工具、十个变量和评测流程。
- `contracts/`：可本地上传的只读OpenAPI文件。
- `data/nk-genios/`：可复制的提示词、开场白、变量片段、资料模板、评测草案。
- `source/`：此次修改文件的可阅读副本；不要直接覆盖服务器目录，用Git导入。

## 2. 仅离线接收：通过bundle导入旧基线仓库

在**自己的开发机或已有开发仓库**执行，确认仓库是 `jiawenyi-2512921/TwinNKU`。

先解压交付包，把下面示例路径换成实际绝对路径。仓库有未提交修改时先自行保存并确认，不能跳过检查或强制覆盖。

```bash
git status --short
git switch feat/admin-console
git pull --ff-only origin feat/admin-console
git bundle verify /绝对路径/TwinNKU-NK-GeniOS.bundle
git fetch /绝对路径/TwinNKU-NK-GeniOS.bundle feat/admin-console
git merge --ff-only FETCH_HEAD
git rev-parse HEAD
```

基线为 `bd77a0681623dd904a0631d2eb2024cd6c6e63c0`；交付HEAD见 `RELEASE.json`。成功后应与该HEAD一致，工作区应干净。

如果提示缺少前置提交，先确认原仓库和分支，并正常fetch获取历史；浅克隆需要按其实际情况补齐历史。如果远程已出现新提交导致不能快进，不要force或reset；在新集成分支按RELEASE.json中的提交顺序逐个cherry-pick并处理冲突，重新测试。已导入上一版完整包的仓库也可对新包执行fetch和快进，不必重复应用旧补丁。

确认后，用你已有的GitHub写权限推送：

```bash
git push origin HEAD:feat/admin-console
```

本轮CI已覆盖该分支的push；检查**本次实际推送提交**的两个任务：`contracts-and-tests`、`compose-smoke`。前者包含真实PostgreSQL测试，后者检查容器启动。未完成或失败时不要沿用旧提交的绿勾。完成后，服务器再按32拉取并重建API和web。

## 3. 备用：邮件补丁

只有没有使用bundle时才选此方式。在干净的目标分支上：

```bash
git am /绝对路径/TwinNKU-NK-GeniOS.patch
```

发生冲突按Git提示解决并继续；决定放弃此次应用可执行 `git am --abort`。不要删除生产文件或强行覆盖来消除冲突。补丁方式会生成新的提交ID，所以应核对内容并重新测试，不要求HEAD等于RELEASE.json中的原始提交ID。

## 4. 已验证与未验证

已完成：后端本地131通过（含15项部署自检测试）、前端38通过、生产构建、Ruff、生成契约和类型/接口文档一致性检查。续交付未修改前端源代码；4项PostgreSQL测试因本地无实例跳过。部署后运行32中的 `check_nk_genios.py` 获取真实环境报告，不以测试夹具冒充生产结果。

制包时未完成远程CI与Docker/Nginx运行；后续网页提交的检查结果请看GitHub最新完整提交与VALIDATION.md，不将包内旧提交ID与网页提交ID混用。生产部署、真实学校SDK加载及访客登录、网页实际问答、引用、变量绑定、手机视觉与键盘仍需验收。本地请求学校SDK返回502，本地浏览器预览被浏览器访问策略阻断；没有把这些失败记作成功。

本轮未修改数据库迁移、地图图块和楼层原图。部署只更新API/web；保留原 `.env` 与数据库。先用空变量跑通聊天，再在平台建立十个同名字符串变量并开启上下文开关。
