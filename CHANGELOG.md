# 更新日志

## 0.4.1 — 2026-10-30

### 新增

- **`coreExclude`：按端过滤核心记忆注入**。注入前丢弃含指定标记的行；某个 `##` 节正文被过滤空时，连标题一起丢（不留空标题）。
  - 默认 `null`：**子端（`role: child`）自动过滤 `【手机】`**，主端不过滤 —— 电脑端/便携端零配置就能少读手机专属内容（实测省约 1/3 注入量）
  - 也可显式指定，如 `coreExclude: ['【手机】', '【内网】']`
  - **过滤发生在 `coreLimit` 截断之前**，所以子端能用满自己的额度
- 冒烟测试 68 → **75 条**（覆盖：子端过滤行、整节空时丢标题、主端不丢、显式标记、过滤先于截断）

### 用法

在 `MEMORY.md` 里给端专属内容打标记，例如：

```markdown
## 环境（手机）【手机】
- 只给手机看的内容
```

## 0.4.0 — 2026-10-25

定位从「又一个跨会话记忆插件」改成「**多端共享记忆**」——本地记忆库的同类插件已有上百个，
多设备共用一份记忆才是这个项目的差异点。

### 新增

- **`autoRecall` 自动召回（默认开）**：每轮从当前用户消息抽检索词（英文整词、中文双字滑窗），
  给归档打分（标题 ×3 / 标签 ×2 / 正文 ×1），把最相关的几条直接注入系统提示。
  不需要模型"想起来去 `memory_search`"——这是竞品最影响体感的能力，用纯词袋实现，
  不发 LLM 请求、不引入数据库。
  - `autoRecall: false` 关闭
  - `autoRecallLimit: 5` 最多注入几条
  - `autoRecallMinScore: 4` 分数门槛（调高更保守，避免无关记忆干扰）
- 用户消息文本从 `user/message` 事件的 `content` 取（兼容字符串与 block 数组两种形态）。

### 文档

- README 重写开头：说明「为什么不跟本地库插件比功能」、适合与不适合的场景
- 特性列表、配置示例补上 `autoRecall` 三项

### 测试

- 冒烟测试 63 → **68 条**（覆盖：命中相关归档、不注入无关归档、无相关时不硬塞、关闭开关）

## 0.3.0 — 2026-10-25

参考同类插件（dsh-prime-memory、meow-memory、@try-works/dsh-memory、@modusensus/dsh-mneme 等
百余个生态作品）后补齐的「记忆全生命周期」能力。仍然零依赖、纯 Markdown + git。

### 新增

- **`memory_update`**：改已有归档的 title / tags / content，刷新 `updated` 并自动提交推送。
- **`memory_forget`**：`archive`（移到 `notes/archive/`，可回滚）或 `delete`（直接删文件）。
- **`memory_stats`**：条数、总大小、标签分布、核心记忆长度、后端信息、最近更新时间。
- **`memory_history`**：GitHub 后端的提交历史，可追溯某条记忆何时被哪个工具写进来。
- **`recentLimit`**：每轮在系统提示末尾注入最近 N 条归档的 id / 标题 / 标签（默认关）。
  竞品普遍靠「自动召回」提升命中率；这个是最便宜的近似做法，不引入数据库。
- **查重提示**：`memory_write` 写入前与已有归档做词袋 Jaccard 比较（≥45%），
  命中就在返回里提示「考虑用 `memory_update`」，减少同一件事写两遍。可用 `dedupeHint: false` 关闭。

### 改进

- `findNote` 现在支持三种定位方式：id 精确 / id 前缀 / **标题** / id 含该 slug，
  并且多处命中时明确列出候选，不再直接报"找不到"。
- 只读模式（`role: child`）下新增的两个读工具 `memory_stats`、`memory_history` 也可用。

### 测试

- 冒烟测试从 42 条扩到 **63 条**（覆盖 update / forget / stats / history / recentLimit / 查重）。

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
