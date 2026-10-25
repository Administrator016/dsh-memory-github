# dsh-memory-github

[![test](https://github.com/Administrator016/dsh-memory-github/actions/workflows/test.yml/badge.svg)](https://github.com/Administrator016/dsh-memory-github/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/Administrator016/dsh-memory-github)](LICENSE)

**English** | [中文](README.md)

A **cross-device shared memory plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

There are already a hundred-plus memory plugins in this ecosystem (`dsh-prime-memory`, `meow-memory`,
`dsh-mnemonic`, …). Most of them are **local stores**: SQLite, vector indexes, a panel UI — powerful,
but the memory only lives on **that one machine**. This plugin makes the opposite trade-off: no database,
no embeddings, just one directory plus one git repository, so your **phone / desktop / external drive**
share a single memory:

- One machine is the **primary** (`role: primary`) — it writes and pushes.
- The others are **children** (`role: child`) — read-only; they leave notes in `inbox/`, and the primary
  files them into the archive.
- Moving to a new machine is a `git clone` (or a directory copy). Works offline too.

> Memory has two layers: **core memory** (`MEMORY.md`, injected into the system prompt every turn,
> configurable hard cap) and **archive** (`notes/*.md` + `index.json`, keyword search + **auto recall**).
> The model decides when to write and what to write.

## Features

- 🧠 **Two-layer memory** — core memory is always injected; the archive is searched on demand (`memory_search` / `memory_read`)
- 🎯 **Auto recall** — every turn, a few relevant archive entries are injected automatically, so the model does not have to remember to search
- 🌐 **Cross-device** — `primary` / `child` roles, with GitHub as the sync bus
- 💾 **Zero dependencies** — a directory is the database (Markdown + JSON): readable, auditable, `git diff`-able
- ☁️ **Optional GitHub** — commit + push on write, `pull --rebase` on startup, automatic `rebase --abort` on conflict
- 🔒 **Read-only mode** — `readOnly: true` registers read tools only
- 🩹 **Self-healing index** — if `index.json` is lost it is rebuilt from `notes/`
- 🧪 **Tests included** — `node test/smoke.mjs` (68 assertions) + `test/git-backend.mjs` (12), no DSH runtime required

## When it fits

✅ You have several devices (phone + desktop) that should remember the same things
✅ You want to see exactly what the AI remembers (plain Markdown, just open it)
✅ Memory should be portable, version-controlled, and reviewable

❌ You want the strongest single-machine retrieval (use a plugin with BM25 / a vector store)
❌ You want an in-chat memory panel UI (this project ships no client plugin)

## Two backends

| | `local` (default) | `github` (advanced) |
|---|---|---|
| Storage | `$DSH_HOME/memory/` | the same directory, also a git working copy |
| New machine | copy the directory | `git clone` |
| Multi-device | each device keeps its own | one shared memory, automatic pull / push |
| Requires | nothing | a `git` executable |

## Install

**1. npm (recommended)**

```sh
dsh plugin --profile desktop add dsh-memory-github
```

**2. Straight from GitHub**

```sh
dsh plugin --profile desktop add github:Administrator016/dsh-memory-github
```

**3. Local directory**

```sh
dsh plugin --profile desktop add link:/path/to/dsh-memory-github
```

**4. Manual wiring**

Drop the package into `<profile>/node_modules/`, then add `"dsh-memory-github"` to
`dsh.profile.bundles` in `<profile>/package.json`.

Restart DSH afterwards.

> ⚠️ **Pick either this plugin or `dsh-core-memory`, never both.** They register the same tool names
> (`memory_write` / `memory_core` / `memory_search` / `memory_read` / `memory_list`); installing both
> makes one of them fail on duplicate registration. Remove the old one from `dsh.profile.bundles` first.

## Configuration

Configuration lives in `<profile>/cordis.patch.yml` (the plugin ships defaults; edit them or override
them in your own patch layer):

```yaml
- id: dsh-memory-github
  name: 'dsh-memory-github'
  config:
    backend: local            # local | github
    dir: ''                   # empty = $DSH_HOME/memory
    role: primary             # primary (writes) | child (read-only + inbox)
    readOnly: false           # true forces read-only; implied by role=child
    coreLimit: 3000           # max characters of core memory injected
    remote: ''                # github backend: git@github.com:you/dsh-memory.git
    branch: main
    autoPull: true            # pull on startup
    autoPush: true            # commit + push on write
    pushOnTurnEnd: false      # push uncommitted changes at the end of every turn
    remindEvery: 6            # inject a reminder after N user messages with no memory write (0 = off)
    staleMinutes: 0           # warn to pull if the last sync is older than N minutes (0 = off)
    autoRecall: true          # inject relevant archive entries based on the user message (on by default)
    autoRecallLimit: 5        # how many auto-recalled entries to inject
    autoRecallMinScore: 4     # score threshold; higher = more conservative
    recentLimit: 0            # additionally inject the N most recent archive titles (0 = off)
    dedupeHint: true          # warn when a new note is very similar to an existing one
    commitMessage: 'memory: {tool}'   # {tool} is replaced with the triggering tool name
    gitBin: git               # git executable (absolute path if not on PATH)
    authorName: dsh-memory
    authorEmail: dsh-memory@localhost
```

## Multi-device roles and reminders

| | `role: primary` | `role: child` |
|---|---|---|
| Write core / archive | ✅ `memory_write` / `memory_core` | ❌ write tools are not registered |
| Write `inbox/` | optional | ✅ the recommended path |
| Automatic push | `autoPush` / `pushOnTurnEnd` | ❌ (`memory_sync push` is refused too) |
| Pull on startup | `autoPull` | `autoPull` (required, or it never sees updates) |
| Reminder wording | save with `memory_write`, push with `memory_sync` | write to `inbox/`, then `git pull/commit/push` |

Reminder triggers:

- **`remindEvery` (default 6)** — after N consecutive user messages with no change to core / notes / index / inbox
  (mtime based), a reminder is appended to the system prompt; writing anything resets the counter.
- **`staleMinutes` (off by default)** — if the last successful pull/push is older than N minutes, the prompt
  suggests `memory_sync pull` first, so two devices do not edit the same memory simultaneously.
- **`pushOnTurnEnd`** — for the primary: push uncommitted changes at the end of each turn ("autosave").

These reminders also work with the `local` backend (they simply do not involve git).

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Save an archive note (title / content / tags); deduplicated against existing notes |
| `memory_update` | Edit an existing note's title / tags / content, refreshing `updated` |
| `memory_forget` | `archive` (move to `notes/archive/`, reversible) or `delete` |
| `memory_core` | Edit `MEMORY.md`: `append` / `replace` / `remove` a section |
| `memory_search` | Keyword search (title weight 6, tags 3, body by occurrence), returns summaries |
| `memory_read` | Read a note by id; unique prefixes are accepted |
| `memory_list` | List notes (newest first), optionally filtered by tag |
| `memory_stats` | Count, total size, tag distribution, core length, backend, last update |
| `memory_history` | Commit history (GitHub backend) — which tool wrote a note and when |
| `memory_sync` | `status` / `pull` / `push` (GitHub backend only) |

**Dedupe**: `memory_write` compares the new content with existing notes using bag-of-words Jaccard
(≥ 45% counts as very similar) and suggests `memory_update` instead. Disable with `dedupeHint: false`.

**Recent-archive injection**: `recentLimit: 5` appends the id / title / tags of the five newest notes to
each turn's system prompt, so the model can "see the catalogue". Off by default (`0`).

The behavioural contract on the model side is carried by the injected system prompt: put what must
*always* be remembered into core memory, and what may be useful later but should not occupy every
turn's context into the archive.

## Enabling the GitHub backend

1. **Create a private repository** (e.g. `you/dsh-memory`) with a single `README.md`.
2. **Set up authentication** — either works:

   ```sh
   # SSH (recommended: no token to leak)
   git clone git@github.com:you/dsh-memory.git ~/.dsh/memory

   # or HTTPS + PAT (keep the token in the local remote only)
   git clone https://<token>@github.com/you/dsh-memory.git ~/.dsh/memory
   ```

3. **Point the config at it**:

   ```yaml
   backend: github
   remote: git@github.com:you/dsh-memory.git
   ```

4. **Restart DSH.** Every `memory_write` / `memory_core` then commits and pushes automatically, and startup
   runs `pull --rebase` first. `memory_sync` is available at any time.

> Two devices writing concurrently will conflict. The default strategy is `pull --rebase`; on conflict the
> plugin reports it in the tool result. Prefer one writing device and keep the rest at `readOnly: true`.

## Data layout

```
$DSH_HOME/memory/
├─ MEMORY.md        # core memory, injected every turn (truncated above coreLimit)
├─ index.json       # { version, notes: [{ id, title, tags, created, updated, size }] }
└─ notes/
   └─ 20261025-104912-windows-autostart.md   # Markdown with front-matter
```

```markdown
---
id: 20261025-104912-windows-autostart
title: Windows autostart
tags: windows, dsh
created: 2026-10-25T02:49:12.000Z
updated: 2026-10-25T02:49:12.000Z
---

Body…
```

## Security notes

- Keep the GitHub repository **private** — memory tends to contain environment details.
- Never put a PAT into `cordis.patch.yml` and never commit it; use an SSH key or a local remote.
- With `readOnly: true` no write tools are registered at all — suitable for machines you do not trust.

## Development

```sh
node test/smoke.mjs        # 68 assertions: registration / write / search / core editing / read-only / index recovery
node test/git-backend.mjs  # auto push / pull against a local bare repository (needs git)
```

## License

MIT
