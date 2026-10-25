# dsh-memory-github

[![test](https://github.com/Administrator016/dsh-memory-github/actions/workflows/test.yml/badge.svg)](https://github.com/Administrator016/dsh-memory-github/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/Administrator016/dsh-memory-github)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**多端共享记忆插件**。

生态里同类插件有上百个（`dsh-prime-memory`、`meow-memory`、`dsh-mnemonic`…），绝大多数是
**本地库**：SQLite、向量索引、面板 UI，功能很强，但**只在那一台机器上**。
这个插件的取舍相反——不引入数据库、不调 embedding，只用一个目录 + 一个 git 仓库，
把「手机 / 电脑 / 移动硬盘」这些设备连成**同一份记忆**：

- 一台机当**整理端**（`role: primary`）负责写和推
- 其余机器当**子端**（`role: child`）只读，想留话就写 `inbox/`，整理端处理完归档
- 换机器：`git clone` 或拷贝目录即恢复；连不联网都能用

> 记忆分两层：**核心记忆**（`MEMORY.md`，每轮注入系统提示，硬上限可配）和**归档记忆**
> （`notes/*.md` + `index.json`，按关键词检索 + **自动召回**）。模型自己决定什么时候写、写什么。

## 特性

- 🧠 **两段式记忆**：核心记忆常驻注入，归档记忆按需检索（`memory_search` / `memory_read`）
- 🎯 **自动召回**：每轮按你的消息自动挑几条相关归档注入（无需模型想起来去 search）
- 🌐 **多端共享**：`primary` / `child` 角色分工，GitHub 做同步总线
- 💾 **零依赖**：一个目录就是记忆库（Markdown + JSON），可读、可审计、可 `git diff`
- ☁️ **可选 GitHub**：写入自动 commit + push，启动自动 pull，冲突自动 `rebase --abort`
- 🔒 **只读模式**：`readOnly: true` 只注册读工具，适合"手机写入、电脑只读"这类分工
- 🩹 **索引自愈**：`index.json` 丢了会从 `notes/` 重建，不会因为一个文件损坏就丢记忆
- 🧪 **自带测试**：`node test/smoke.mjs`（68 条断言）+ `test/git-backend.mjs`（12 条），不依赖 DSH 运行时

## 什么时候适合用它

✅ 你有多台设备（手机 + 电脑），想让它们记住同一批事
✅ 你想知道 AI 到底记住了什么（纯 Markdown，直接打开看）
✅ 记忆要能带走、能版本管理、能自己审查

❌ 你要的是单机最强检索（那去用带 BM25 / 向量库的插件）
❌ 你要的是聊天框里的记忆面板 UI（本项目没有客户端插件）

## 两种后端

| | `local`（默认） | `github`（进阶） |
|---|---|---|
| 存储 | `$DSH_HOME/memory/` | 同一个目录，同时是 git 工作副本 |
| 换机 | 手动拷贝目录 | `git clone` 即恢复 |
| 多设备 | 各存各的 | 共享一份，自动 pull / push |
| 依赖 | 无 | `git` 可执行文件 |


## 安装

**方式一：npm（推荐）**

```sh
dsh plugin --profile desktop add dsh-memory-github
```

**方式二：直接从 GitHub 装**

```sh
# pnpm 语法（dsh plugin 内部就是 pnpm）
dsh plugin --profile desktop add github:Administrator016/dsh-memory-github
```

**方式三：本地目录**

```sh
dsh plugin --profile desktop add link:/path/to/dsh-memory-github
```

**方式四：手动接线**

把包放进 `<profile>/node_modules/`，然后在 `<profile>/package.json` 的
`dsh.profile.bundles` 里加上 `"dsh-memory-github"`。

装完重启 DSH 生效。

> ⚠️ **和 `dsh-core-memory` 只能二选一。** 两者注册的工具同名
> （`memory_write` / `memory_core` / `memory_search` / `memory_read` / `memory_list`），
> 同时装会因重复注册而挂掉一个。换装时先把旧的从 `dsh.profile.bundles` 里去掉。

## 配置

配置写在 `<profile>/cordis.patch.yml`（插件自带一份默认值，直接改它或在自己的 patch 层覆盖）：

```yaml
- id: dsh-memory-github
  name: 'dsh-memory-github'
  config:
    backend: local            # local | github
    dir: ''                   # 空 = $DSH_HOME/memory
    role: primary             # primary（整理端，可写）| child（子端，只读 + 写 inbox）
    readOnly: false           # true 强制只读；role=child 时自动为 true
    coreLimit: 3000           # 核心记忆注入上限（字符）
    remote: ''                # github 后端：git@github.com:you/dsh-memory.git
    branch: main
    autoPull: true            # 启动时 pull
    autoPush: true            # 写入后 commit + push
    pushOnTurnEnd: false      # 每轮结束若有未提交改动就推送
    remindEvery: 6            # 每 N 条用户消息没动记忆 → 注入提醒（0=关）
    staleMinutes: 0           # 距上次同步超过 N 分钟 → 提示先 pull（0=关）
    autoRecall: true          # 按当前用户消息自动召回相关归档（默认开）
    autoRecallLimit: 5        # 自动召回最多注入几条
    autoRecallMinScore: 4     # 自动召回打分门槛，调高更保守
    recentLimit: 0            # 额外注入最近 N 条归档标题（0=关）
    dedupeHint: true          # 写入时提示与已有归档高度相似
    commitMessage: 'memory: {tool}'   # {tool} 会替换成触发的工具名
    gitBin: git               # git 可执行文件（不在 PATH 就写绝对路径）
    authorName: dsh-memory
    authorEmail: dsh-memory@localhost
```

## 多端分工与同步提醒

一台机器当"整理端"，其余当"子端"：

| | `role: primary`（整理端） | `role: child`（子端） |
|---|---|---|
| 写核心 / 归档 | ✅ `memory_write` / `memory_core` | ❌ 不注册写工具 |
| 写 `inbox/` | 可选 | ✅ 推荐做法 |
| 自动推送 | `autoPush` / `pushOnTurnEnd` | ❌（`memory_sync push` 也会被拒） |
| 启动拉取 | `autoPull` | `autoPull`（必须开，否则看不到别人的更新） |
| 提醒文案 | 用 `memory_write` 存、`memory_sync push` 推 | 写 `inbox/` 再 `git pull/commit/push` |

提醒怎么触发：

- **`remindEvery`（默认 6）**：连续 N 条用户消息没动过记忆库（核心/notes/index/inbox 的 mtime 都没变），
  就在系统提示里追一段提醒；一旦写了记忆，计数自动归零。
- **`staleMinutes`（默认关）**：距上次成功 pull/push 超过 N 分钟，提示先 `memory_sync pull`
  再动手，避免两台设备同时改同一份记忆。
- **`pushOnTurnEnd`**：整理端可以打开，每轮结束自动把改动推上去（相当于"自动存盘"）。

`local` 后端下这些提醒同样有效（只是不涉及 git 同步）。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 保存一条归档记忆（title / content / tags），立刻进索引；写入前会做**相似度查重** |
| `memory_update` | 改已有归档的 title / tags / content，刷新 `updated` |
| `memory_forget` | `archive`（移到 `notes/archive/` 可回滚）或 `delete` |
| `memory_core` | 编辑 `MEMORY.md`：`append` / `replace` / `remove` 某个分节 |
| `memory_search` | 按关键词检索（标题权重 6、标签 3、正文按出现次数），返回摘要 |
| `memory_read` | 按 id 读全文，支持唯一前缀 |
| `memory_list` | 列出归档（新→旧），可按标签过滤 |
| `memory_stats` | 条数、总大小、标签分布、核心记忆长度、后端与最近更新 |
| `memory_history` | 提交历史（GitHub 后端），追溯某条记忆是何时被哪个工具写进来的 |
| `memory_sync` | `status` / `pull` / `push`，GitHub 后端专用 |

**查重**：`memory_write` 会把新内容与已有归档做词袋相似度比较（Jaccard ≥ 45% 视为高度相似），
命中时在返回里提示「考虑改用 `memory_update`」。关掉：`dedupeHint: false`。

**最近归档注入**：`recentLimit: 5` 会在每轮系统提示末尾附上最近 5 条归档的 id/标题/标签，
让模型"看得见目录"，召回率比纯靠 `memory_search` 高。默认关闭（`0`）。


模型侧的使用约定由插件注入的系统提示承载：核心记忆里写"永远要记住的"，
归档里写"以后可能用得上、但不用每轮都占上下文的"。

## 开启 GitHub 后端

1. **建一个私有仓库**（比如 `you/dsh-memory`），初始化一个 `README.md` 即可，不要勾选自动生成太多文件。

2. **准备认证**，两种都行：

   ```sh
   # SSH（推荐，无 token 泄露风险）
   git clone git@github.com:you/dsh-memory.git ~/.dsh/memory

   # 或者 HTTPS + PAT（token 只放本地 remote，别提交进仓库）
   git clone https://<token>@github.com/you/dsh-memory.git ~/.dsh/memory
   ```

3. **改配置**：

   ```yaml
   backend: github
   remote: git@github.com:you/dsh-memory.git
   ```

4. **重启 DSH**。之后每次 `memory_write` / `memory_core` 都会自动提交推送；
   启动时会先 `pull --rebase`。手动同步随时可以 `memory_sync`。

> 多设备同时写入会有冲突。默认策略是 `pull --rebase`；冲突时插件会在工具返回里提示，
> 建议只让一台设备负责写入，其余设备用 `readOnly: true`。

## 数据结构

```
$DSH_HOME/memory/
├─ MEMORY.md        # 核心记忆，每轮注入（超出 coreLimit 会截断）
├─ index.json       # { version, notes: [{ id, title, tags, created, updated, size }] }
└─ notes/
   └─ 20261025-104912-windows-自启.md   # 带 front-matter 的 Markdown
```

笔记文件：

```markdown
---
id: 20261025-104912-windows-自启
title: Windows 端开机自启
tags: windows, dsh
created: 2026-10-25T02:49:12.000Z
updated: 2026-10-25T02:49:12.000Z
---

正文……
```

## 安全提示

- GitHub 仓库请设为 **私有**：记忆里难免出现环境细节。
- 不要把 PAT 写进 `cordis.patch.yml`、更不要提交进仓库；用 SSH key 或本地 remote。
- `readOnly: true` 下不会注册任何写工具，适合给不信任的机器用。

## 开发

```sh
node test/smoke.mjs        # 30 条断言：工具注册 / 写入 / 检索 / 核心编辑 / 只读 / 索引自愈
node test/git-backend.mjs  # 用本地裸仓库验证自动 push / pull（需要 git）
```

## License

MIT
