# 更新日志

## 0.2.0 — 2026-10-25

### 新增

- **角色区分 `role`**：`primary`（整理端，可写核心与归档）与 `child`（子端，只读，
  写内容走 `inbox/`）。`child` 会自动只读，`memory_sync push` 也会被拒。
- **`remindEvery`**（默认 6）：连续 N 条用户消息没动过记忆库（`MEMORY.md` / `notes/` /
  `index.json` / `inbox/` 的 mtime 都没变）就在系统提示里注入提醒；写过记忆后计数自动归零。
  提醒文案按角色区分：整理端提示用 `memory_write`，子端提示写 `inbox/`。
- **`staleMinutes`**（默认关闭）：距上次成功 pull/push 超过 N 分钟，提醒先
  `memory_sync pull` 再动手，避免多设备同时改同一份记忆。
- **`pushOnTurnEnd`**（默认关闭）：每轮结束若有未提交改动就自动提交推送。
- 实现依赖宿主事件 `session/event`（`user/message` 计数、`turn/end` 触发推送）。

### 修复

- **工具 `output` 必须是 `{ schema, render }` 对象**。此前写成函数，DSH 加载时会抛
  `tool "..." must declare output { schema, render, presentationMeta? }`，导致整个插件挂载失败。
  单元测试覆盖了新形状。
- **`git add` 只加实际存在的路径**。以前固定写 `add -A -- MEMORY.md notes index.json`，
  只要 `MEMORY.md` 还没生成，git 会整体失败、笔记永远提交不上去。
- **启动拉取不再阻塞启动**：`git pull` 挪到下一轮事件循环执行。
- **pull 失败自动 `git rebase --abort`**，不再把工作副本卡在 rebase 中间态。
- 目录已有记忆文件但还不是 git 仓库时，不再贸然 `clone` 覆盖，只告警并跳过。
- `memory_sync status` 增加「最近提交」一行。

## 0.1.0 — 2026-10-25

首个版本。

- 两段式记忆：`MEMORY.md`（每轮注入，`coreLimit` 默认 3000 字符）+ `notes/*.md` + `index.json`
- 六个工具：`memory_write` / `memory_core` / `memory_search` / `memory_read` /
  `memory_list` / `memory_sync`
- 两种后端：`local`（默认）与 `github`（同一目录套 git，启动 pull、写入 commit+push）
- `readOnly` 模式：只注册读工具
- 索引自愈：`index.json` 丢失后从 `notes/` 重建
- 自带冒烟测试（`test/smoke.mjs`、`test/git-backend.mjs`）与 GitHub Actions
