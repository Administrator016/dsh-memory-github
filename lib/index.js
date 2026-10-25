/**
 * dsh-memory-github — 跨会话记忆插件
 *
 * 两种存储后端：
 *   local  （默认）：记忆库就是本地一个目录（MEMORY.md + notes/ + index.json）
 *   github （可选）：同一个目录是 git 仓库，读写后自动 pull / commit / push
 *
 * 设计要点：
 *   - 本地目录是唯一数据源；github 后端只是给它套一层 git 同步
 *   - 所有写操作串行（enqueue），避免索引与笔记文件不一致
 *   - core（MEMORY.md）每轮注入系统提示，硬上限可配（默认 3000 字符）
 *   - readOnly=true 时只注册读工具，适合"手机写入、电脑只读"这类分工
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const name = 'dsh-memory-github';
export const inject = ['systemPrompt', 'tools'];

const DEFAULTS = {
  backend: 'local',        // local | github
  dir: '',                 // 空 = $DSH_HOME/memory
  role: 'primary',         // primary（整理端，可写）| child（子端，只读 + 写 inbox）
  readOnly: false,         // true 强制只读；role=child 时自动为 true
  coreLimit: 3000,
  remote: '',              // github 后端：git remote（ssh 或 https）
  branch: 'main',
  autoPull: true,          // 启动时 pull
  autoPush: true,          // 写入后 commit+push
  pushOnTurnEnd: false,    // 每轮结束时若有未提交改动就推送
  remindEvery: 6,          // 每 N 条用户消息、且期间没动过记忆 → 提醒（0=关）
  staleMinutes: 0,         // 距上次同步超过 N 分钟 → 提醒（0=关）
  recentLimit: 0,          // 每轮额外注入最近 N 条归档的标题与标签（0=关）
  dedupeHint: true,        // 写入时检查是否与已有归档高度相似
  commitMessage: 'memory: {tool}',
  gitBin: 'git',
  authorName: 'dsh-memory',
  authorEmail: 'dsh-memory@localhost',
};

// ---------------------------------------------------------------- 路径

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function makePaths(config) {
  const dir = config.dir
    ? config.dir.replace(/^~(?=$|[\\/])/, homedir())
    : join(dshHome(), 'memory');
  return {
    dir,
    core: join(dir, 'MEMORY.md'),
    notes: join(dir, 'notes'),
    index: join(dir, 'index.json'),
  };
}

function ensureDirs(p) {
  mkdirSync(p.notes, { recursive: true });
}

// ---------------------------------------------------------------- 基础 IO

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function readTextSafe(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function sanitizeSlug(text) {
  return String(text)
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'note';
}

function makeId(title, existingIds) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  let id = `${stamp}-${sanitizeSlug(title)}`;
  let n = 2;
  while (existingIds.has(id)) id = `${stamp}-${sanitizeSlug(title)}-${n++}`;
  return id;
}

// ---------------------------------------------------------------- 笔记格式

function noteFileText(meta, content) {
  const tags = (meta.tags ?? []).join(', ');
  return [
    '---',
    `id: ${meta.id}`,
    `title: ${meta.title}`,
    `tags: ${tags}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    '---',
    '',
    content.trim(),
    '',
  ].join('\n');
}

function parseNoteFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: null, content: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) meta[k] = v;
  }
  meta.tags = meta.tags ? String(meta.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  return { meta, content: m[2].trim() };
}

function noteSort(a, b) {
  return String(b.created ?? '').localeCompare(String(a.created ?? ''));
}

// ---------------------------------------------------------------- 索引

function loadIndex(p) {
  const raw = readTextSafe(p.index, '');
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.notes)) return parsed.notes;
    } catch { /* 落到重建 */ }
  }
  return rebuildIndex(p);
}

function rebuildIndex(p) {
  const notes = [];
  try {
    for (const f of readdirSync(p.notes)) {
      if (!f.endsWith('.md')) continue;
      const file = join(p.notes, f);
      const parsed = parseNoteFile(readTextSafe(file));
      const st = statSync(file);
      notes.push({
        id: parsed.meta?.id || f.replace(/\.md$/, ''),
        title: parsed.meta?.title || f.replace(/\.md$/, ''),
        tags: parsed.meta?.tags ?? [],
        created: parsed.meta?.created || st.mtime.toISOString(),
        updated: parsed.meta?.updated || st.mtime.toISOString(),
        size: st.size,
      });
    }
  } catch { /* 目录还没建 */ }
  notes.sort(noteSort);
  try {
    atomicWrite(p.index, JSON.stringify({ version: 1, notes }, null, 2));
  } catch { /* 只读目录就算了 */ }
  return notes;
}

function saveIndex(p, notes) {
  const sorted = [...notes].sort(noteSort);
  atomicWrite(p.index, JSON.stringify({ version: 1, notes: sorted }, null, 2));
  return sorted;
}

/** 按 id（或唯一前缀）找到一条归档。 */
function findNote(p, want) {
  const id = String(want ?? '').replace(/\.md$/, '').trim();
  if (!id) return { error: 'id 不能为空。' };
  const notes = loadIndex(p);
  const exact = notes.find((n) => n.id === id);
  if (exact) return { note: exact, notes };

  // 依次尝试：id 前缀 / 标题（忽略大小写）/ id 后缀（用户常只给 slug）
  const byPrefix = notes.filter((n) => n.id.startsWith(id));
  if (byPrefix.length === 1) return { note: byPrefix[0], notes };
  const lower = id.toLowerCase();
  const byTitle = notes.filter((n) => String(n.title ?? '').toLowerCase() === lower);
  if (byTitle.length === 1) return { note: byTitle[0], notes };
  const bySuffix = notes.filter((n) => n.id.includes(`-${id}`));
  if (bySuffix.length === 1) return { note: bySuffix[0], notes };

  const candidates = [...byPrefix, ...byTitle, ...bySuffix].filter((n, i, arr) => arr.findIndex((x) => x.id === n.id) === i);
  if (candidates.length > 1) {
    return {
      error: `「${id}」匹配到 ${candidates.length} 条，请给更长前缀或完整 id：\n`
        + candidates.map((n) => `- ${n.id}  ${n.title}`).join('\n'),
    };
  }
  return { error: `没有找到 id 为「${id}」的记忆。` };
}

/** 词袋：用于相似度判断（标题 / 标签 / 正文前 600 字）。 */
function tokenSet(text) {
  const set = new Set();
  for (const tok of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok && tok.length > 1) set.add(tok);
  }
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 写入前查重：返回最多 3 条高相似（Jaccard ≥ 0.45）的归档。 */
function similarNotes(p, title, content) {
  const mine = tokenSet(`${title} ${String(content ?? '').slice(0, 600)}`);
  const hits = [];
  for (const n of loadIndex(p)) {
    // 只比正文，不要把 frontmatter 里的 id/时间戳算进相似度，否则会把相似度稀释掉
    const parsed = parseNoteFile(readTextSafe(join(p.notes, `${n.id}.md`), ''));
    const body = parsed.content ?? '';
    const theirs = tokenSet(`${n.title} ${(n.tags ?? []).join(' ')} ${body.slice(0, 600)}`);
    const score = jaccard(mine, theirs);
    if (score >= 0.45) hits.push({ id: n.id, title: n.title, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 3);
}

/** 把归档移到 notes/archive/（保留内容，可回滚）。 */
function archiveNoteFile(p, id) {
  const dir = join(p.notes, 'archive');
  mkdirSync(dir, { recursive: true });
  const from = join(p.notes, `${id}.md`);
  const to = join(dir, `${id}.md`);
  renameSync(from, to);
  return to;
}

/** 最近 N 条归档的标题清单，用于注入系统提示。 */
function recentSection(p, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return '';
  const notes = loadIndex(p).slice(0, Math.floor(n));
  if (!notes.length) return '';
  const lines = notes.map((x) => `- \`${x.id}\` ${x.title}${(x.tags ?? []).length ? '  #' + x.tags.join(' #') : ''}`);
  return ['', `### 最近归档（${notes.length} 条，细节用 memory_search）`, ...lines].join('\n');
}

// ---------------------------------------------------------------- core 记忆

function coreLimit(config) {
  const n = Number(config.coreLimit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3000;
}

// ---------------------------------------------------------------- 提醒

/** 记忆库最近一次"被写过"的时间戳：核心 / 索引 / notes / inbox 里最新的 mtime。 */
function activityStamp(p) {
  let latest = 0;
  const touch = (file) => {
    try {
      const st = statSync(file);
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch { /* 不存在就算了 */ }
  };
  touch(p.core);
  touch(p.index);
  for (const sub of ['notes', 'inbox']) {
    let names = [];
    try { names = readdirSync(join(p.dir, sub)); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      touch(join(p.dir, sub, name));
    }
  }
  return latest;
}

function writeReminder(config, count) {
  if (config.role === 'child') {
    return [
      `## 同步提醒（dsh-memory-github · 子端）`,
      ``,
      `已经连续 ${count} 条用户消息没有往记忆库写东西了。**本机是子端（只读）**，不能改 MEMORY.md / notes/，做法是：`,
      ``,
      `1. 在 \`${config.dir || '$DSH_HOME/memory'}\\inbox\\\` 新建一个 \`pc-<日期>-<主题>.md\`（一文件一事，写清：发生了什么、影响什么、以后该记住什么）；`,
      `2. \`git pull --rebase\` → \`git add inbox\` → \`git commit -m "pc inbox: 主题"\` → \`git push\`；`,
      `3. 整理端处理后会把它挪进 inbox/done/ 并归档。`,
      ``,
      `如果这轮确实没有值得长期记住的内容，可以忽略。`,
    ].join('\n');
  }
  return [
    `## 记忆提醒（dsh-memory-github · 整理端）`,
    ``,
    `已经连续 ${count} 条用户消息没有动过记忆库了。如果这轮出现了值得长期保留的内容：`,
    ``,
    `- 用 \`memory_write\` 存归档（一文件一事、自包含），或 \`memory_core\` 更新 MEMORY.md 的分节；`,
    `- 写完用 \`memory_sync push\` 推到远端，让子端能拉到。`,
    ``,
    `没有就忽略，计数会在下次写入后自动归零。`,
  ].join('\n');
}

function syncReminder(config, minutes) {
  return [
    `## 同步提醒（dsh-memory-github）`,
    ``,
    `距上次成功同步已经 ${Math.round(minutes)} 分钟（阈值 ${config.staleMinutes} 分钟）。如果刚接手别人的改动，先 \`memory_sync pull\` 再动手，避免冲突。`,
  ].join('\n');
}

function readCore(p) {
  return readTextSafe(p.core, '');
}

function coreSection(text, limit) {
  const body = (text ?? '').trim();
  if (!body) {
    return '## 跨会话记忆（dsh-memory-github）\n\n> 记忆库还是空的。用 memory_write 存归档、memory_core 写核心记忆。';
  }
  const cut = body.length > limit;
  const shown = cut ? body.slice(0, limit) : body;
  return shown
    + (cut ? `\n\n> 核心记忆已截断（硬上限 ${limit} 字符），用 memory_search / memory_read 取细节。` : '');
}

function splitSections(md) {
  const lines = String(md).split(/\r?\n/);
  const head = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (cur) sections.push(cur);
      cur = { title: line.replace(/^##\s+/, '').trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      head.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { head, sections };
}

function joinSections(head, sections) {
  const out = [...head];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const s of sections) {
    if (out.length) out.push('');
    out.push(`## ${s.title}`);
    const body = s.body.join('\n').replace(/^\n+|\n+$/g, '');
    if (body) out.push('', body);
  }
  return out.join('\n').trimEnd() + '\n';
}

function editCore(p, config, action, section, text) {
  const cur = readCore(p) || '# 记忆\n';
  const { head, sections } = splitSections(cur);
  const idx = sections.findIndex((s) => s.title === section);
  const body = (text ?? '').trim();

  if (action === 'append') {
    if (idx < 0) sections.push({ title: section, body: body ? ['', body] : [] });
    else sections[idx].body.push(...(body ? ['', body] : []));
  } else if (action === 'replace') {
    if (idx < 0) sections.push({ title: section, body: body ? ['', body] : [] });
    else sections[idx].body = body ? ['', body] : [];
  } else if (action === 'remove') {
    if (idx < 0) return { ok: false, message: `没有分节「${section}」` };
    sections.splice(idx, 1);
  }
  const next = joinSections(head, sections);
  atomicWrite(p.core, next);
  return { ok: true, message: `核心记忆已更新（${action} ${section}），现在 ${next.length} 字符。` };
}

// ---------------------------------------------------------------- 检索

function tokenize(q) {
  return String(q ?? '')
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function searchNotes(p, query, limit = 8) {
  const tokens = tokenize(query);
  const notes = loadIndex(p);
  const hits = [];
  for (const n of notes) {
    const file = join(p.notes, `${n.id}.md`);
    const raw = readTextSafe(file);
    const { content } = parseNoteFile(raw);
    const hay = {
      title: String(n.title ?? '').toLowerCase(),
      tags: (n.tags ?? []).join(' ').toLowerCase(),
      body: content.toLowerCase(),
    };
    let score = 0;
    for (const t of tokens) {
      if (hay.title.includes(t)) score += 6;
      if (hay.tags.includes(t)) score += 3;
      const bodyHits = hay.body.split(t).length - 1;
      score += Math.min(bodyHits, 5);
    }
    if (tokens.length === 0) score = 1;
    if (score <= 0) continue;
    const first = tokens.find((t) => hay.body.includes(t));
    let snippet = content.slice(0, 160).replace(/\s+/g, ' ');
    if (first) {
      const at = Math.max(0, hay.body.indexOf(first) - 40);
      snippet = content.slice(at, at + 180).replace(/\s+/g, ' ');
    }
    hits.push({ note: n, score, snippet });
  }
  hits.sort((a, b) => b.score - a.score || noteSort(a.note, b.note));
  return hits.slice(0, Math.max(1, Math.min(Number(limit) || 8, 50)));
}

// ---------------------------------------------------------------- git

function gitAvailable(config) {
  const r = spawnSync(config.gitBin, ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function git(p, config, args, { allowFail = false } = {}) {
  const r = spawnSync(config.gitBin, ['-C', p.dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: config.authorName,
      GIT_AUTHOR_EMAIL: config.authorEmail,
      GIT_COMMITTER_NAME: config.authorName,
      GIT_COMMITTER_EMAIL: config.authorEmail,
    },
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`);
  }
  return r;
}

function isRepo(p) {
  return existsSync(join(p.dir, '.git'));
}

function gitPull(p, config) {
  if (!isRepo(p)) return { ok: false, message: '目录还不是 git 仓库' };
  const r = git(p, config, ['pull', '--rebase', 'origin', config.branch], { allowFail: true });
  if (r.status === 0) {
    return { ok: true, message: (r.stdout || '').trim() || '已是最新' };
  }
  // 失败（常见：conflict）时把 rebase 状态清干净，别把工作副本卡在中间态
  git(p, config, ['rebase', '--abort'], { allowFail: true });
  return { ok: false, message: (r.stderr || r.stdout || '').trim() || `exit ${r.status}` };
}

function gitPush(p, config, message) {
  if (!isRepo(p)) return { ok: false, message: '目录还不是 git 仓库' };
  // 只提交记忆相关文件：目录里顺手放的其他东西不该被推上去
  // 注意 pathspec 里只要有一个不存在的路径，git add 会整体失败，所以要过滤
  const paths = ['MEMORY.md', 'notes', 'index.json'].filter((f) => existsSync(join(p.dir, f)));
  if (paths.length === 0) return { ok: true, message: '没有可提交的记忆文件' };
  const added = git(p, config, ['add', '-A', '--', ...paths], { allowFail: true });
  if (added.status !== 0) return { ok: false, message: `git add 失败：${(added.stderr || '').trim().split('\n')[0]}` };
  const status = git(p, config, ['status', '--porcelain'], { allowFail: true });
  if (!status.stdout.trim()) return { ok: true, message: '没有改动，跳过提交' };
  git(p, config, ['commit', '-m', message]);
  const push = git(p, config, ['push', 'origin', config.branch], { allowFail: true });
  if (push.status !== 0) {
    const why = (push.stderr || '').trim().split('\n').filter(Boolean)[0] || `exit ${push.status}`;
    return { ok: false, message: `已本地提交，但推送失败（远端可能有了新提交，先 memory_sync pull）：${why}` };
  }
  return { ok: true, message: `已提交并推送：${message}` };
}

// ---------------------------------------------------------------- 串行队列

let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- 工具输出

// DSH 的工具 API：output 必须是 { schema, render } 对象，不是函数
const outputText = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

function errText(e) {
  return `操作失败：${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, config0) {
  const config = { ...DEFAULTS, ...(config0 ?? {}) };
  const p = makePaths(config);
  try { ensureDirs(p); } catch { /* 目录建不了就在工具里报 */ }

  const githubMode = config.backend === 'github';
  // role=child 时强制只读：子端只写 inbox，不改核心与归档
  const readOnly = Boolean(config.readOnly) || config.role === 'child';

  // 提醒状态：消息计数 / 最近一次记忆活动 / 最近一次成功同步
  const syncState = { count: 0, lastActivity: activityStamp(p), lastSyncAt: Date.now() };

  const doPull = () => {
    const r = gitPull(p, config);
    if (r.ok) syncState.lastSyncAt = Date.now();
    return r;
  };
  const doPush = (message) => {
    const r = gitPush(p, config, message);
    if (r.ok) syncState.lastSyncAt = Date.now();
    return r;
  };

  // 启动时拉一次：放到下一轮事件循环，别让 git 的网络往返拖慢 DSH 启动
  if (githubMode && config.autoPull) {
    setTimeout(() => {
      try {
        if (!gitAvailable(config)) {
          console.warn('[dsh-memory-github] 找不到 git，跳过自动拉取');
          return;
        }
        if (!isRepo(p) && config.remote) {
          const leftover = ['MEMORY.md', 'notes', 'index.json'].filter((f) => existsSync(join(p.dir, f)));
          if (leftover.length) {
            // 已有本地记忆但还不是仓库：不覆盖，交给用户决定
            console.warn(`[dsh-memory-github] ${p.dir} 已有记忆文件（${leftover.join(', ')}）但不是 git 仓库，跳过 clone。想接远端请先手动 git init + remote add + pull。`);
            return;
          }
          const r = spawnSync(config.gitBin, ['clone', config.remote, p.dir], { encoding: 'utf8' });
          console.log(r.status === 0
            ? `[dsh-memory-github] 已 clone ${config.remote}`
            : `[dsh-memory-github] clone 失败：${(r.stderr || '').trim()}`);
          return;
        }
        if (isRepo(p)) {
          const r = doPull();
          console.log(`[dsh-memory-github] 启动拉取：${r.ok ? '成功' : '失败'} ${r.message.split('\n')[0]}`);
        }
      } catch (e) {
        console.warn(`[dsh-memory-github] 启动拉取异常：${e instanceof Error ? e.message : e}`);
      }
    }, 0);
  }

  // 每轮注入核心记忆 + 到点提醒
  ctx.systemPrompt.section({
    name: 'dsh-memory-github:core',
    order: 60,
    text: () => {
      const base = coreSection(readCore(p), coreLimit(config)) + recentSection(p, config.recentLimit);
      const stamp = activityStamp(p);
      if (stamp > syncState.lastActivity) {
        // 记忆被写过（本进程写的，或别的进程/设备同步下来的），计数归零
        syncState.lastActivity = stamp;
        syncState.count = 0;
      }
      const extra = [];
      const every = Number(config.remindEvery);
      if (Number.isFinite(every) && every > 0 && syncState.count >= every) {
        extra.push(writeReminder({ ...config, dir: p.dir }, syncState.count));
      }
      const stale = Number(config.staleMinutes);
      if (githubMode && Number.isFinite(stale) && stale > 0) {
        const minutes = (Date.now() - syncState.lastSyncAt) / 60000;
        if (minutes >= stale) extra.push(syncReminder(config, minutes));
      }
      return extra.length ? `${base}\n\n${extra.join('\n\n')}` : base;
    },
  });

  const afterWrite = (tool) => {
    if (!githubMode || !config.autoPush) return '';
    const r = doPush(String(config.commitMessage).replace('{tool}', tool));
    return r.ok ? '' : `\n（GitHub 同步失败：${r.message.split('\n')[0]}）`;
  };

  // 计数用户消息；turn/end 时可选自动推送
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (_session, event) => {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'user/message') {
        syncState.count += 1;
      } else if (event.type === 'turn/end' && githubMode && config.pushOnTurnEnd && !readOnly) {
        enqueue(() => {
          try {
            const r = doPush(String(config.commitMessage).replace('{tool}', 'turn/end'));
            if (!r.ok) console.warn(`[dsh-memory-github] turn/end 推送失败：${r.message.split('\n')[0]}`);
          } catch (e) {
            console.warn(`[dsh-memory-github] turn/end 推送异常：${e instanceof Error ? e.message : e}`);
          }
        });
      }
    });
  }

  const defs = [
    {
      name: 'memory_write',
      description: '保存一条归档记忆，跨所有会话持久。内容要自包含（未来会话看不到当前对话）。保存后立刻进入索引，可用 memory_search 检索；GitHub 后端会自动提交推送。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '简短标题（用于文件名与检索）' },
          content: { type: 'string', description: '记忆正文，自包含，可多行 Markdown' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
        },
        required: ['title', 'content'],
      },
      output: outputText,
      async execute(args) {
        const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
        const content = typeof args.content === 'string' ? args.content : '';
        if (!title || !content.trim()) return '保存失败：title 和 content 均不能为空。';
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
          : [];
        try {
          const dupes = config.dedupeHint === false
            ? []
            : similarNotes(p, title, content);
          return await enqueue(() => {
            ensureDirs(p);
            const notes = loadIndex(p);
            const ids = new Set(notes.map((n) => n.id));
            const id = makeId(title, ids);
            const now = new Date().toISOString();
            const meta = { id, title, tags, created: now, updated: now, size: 0 };
            const text = noteFileText(meta, content);
            meta.size = Buffer.byteLength(text);
            atomicWrite(join(p.notes, `${id}.md`), text);
            saveIndex(p, [meta, ...notes]);
            const sync = afterWrite('memory_write');
            const hint = dupes.length
              ? '\n注意：和已有归档高度相似，考虑改用 memory_update：\n'
                + dupes.map((d) => `- ${d.id}  ${d.title}（相似度 ${(d.score * 100).toFixed(0)}%）`).join('\n')
              : '';
            return `已保存 [${id}] ${title}${tags.length ? ' #' + tags.join(' #') : ''}。${sync}${hint}`;
          });
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_core',
      description: '编辑核心记忆 MEMORY.md——它在每个会话的系统提示里常驻注入，务必保持精炼。action=append 追加到分节末尾；replace 整体替换分节；remove 删除分节。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['append', 'replace', 'remove'] },
          section: { type: 'string', description: '分节名（MEMORY.md 里的 ## 标题），如：用户 / 环境 / 项目' },
          text: { type: 'string', description: '要写入的内容（append/replace 时必填）' },
        },
        required: ['action', 'section'],
      },
      output: outputText,
      async execute(args) {
        const action = args.action;
        if (!['append', 'replace', 'remove'].includes(action)) return 'action 必须是 append / replace / remove。';
        const section = typeof args.section === 'string' ? args.section.trim() : '';
        if (!section) return 'section 不能为空。';
        const text = typeof args.text === 'string' ? args.text : '';
        if (action !== 'remove' && !text.trim()) return `${action} 需要提供 text。`;
        try {
          return await enqueue(() => {
            ensureDirs(p);
            const r = editCore(p, config, action, section, text);
            if (!r.ok) return r.message;
            return r.message + afterWrite('memory_core');
          });
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_search',
      description: '按关键词检索归档记忆（标题/标签/正文），返回相关度排序的摘要。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索关键词，可用空格分隔多个' },
          limit: { type: 'integer', description: '最多返回条数，默认 8' },
        },
        required: ['query'],
      },
      output: outputText,
      async execute(args) {
        try {
          const hits = searchNotes(p, args.query, args.limit);
          if (!hits.length) return `没有找到与「${args.query}」相关的记忆。`;
          return hits
            .map((h) => `- [${h.note.id}] ${h.note.title}${(h.note.tags ?? []).length ? '  #' + h.note.tags.join(' #') : ''}\n  ${h.snippet}`)
            .join('\n');
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_read',
      description: '按 id 读取一条归档记忆的完整内容。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '记忆 id（可带 .md 后缀，支持唯一前缀）' } },
        required: ['id'],
      },
      output: outputText,
      async execute(args) {
        try {
          const want = String(args.id ?? '').replace(/\.md$/, '').trim();
          if (!want) return 'id 不能为空。';
          const notes = loadIndex(p);
          const exact = notes.find((n) => n.id === want);
          const prefixed = exact ? [] : notes.filter((n) => n.id.startsWith(want));
          const target = exact || (prefixed.length === 1 ? prefixed[0] : null);
          if (!target) {
            if (prefixed.length > 1) {
              return `「${want}」匹配到 ${prefixed.length} 条，请给更长的前缀：\n` + prefixed.map((n) => `- ${n.id}  ${n.title}`).join('\n');
            }
            return `没有找到 id 为「${want}」的记忆。`;
          }
          return readTextSafe(join(p.notes, `${target.id}.md`), '（文件缺失）');
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_list',
      description: '列出归档记忆（新→旧），可按标签过滤。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 20' },
          tag: { type: 'string', description: '可选：只列带此标签的记忆' },
        },
      },
      output: outputText,
      async execute(args) {
        try {
          const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
          const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
          let notes = loadIndex(p);
          if (tag) notes = notes.filter((n) => (n.tags ?? []).includes(tag));
          if (!notes.length) return tag ? `没有带标签「${tag}」的记忆。` : '记忆库还没有归档记忆。';
          const shown = notes.slice(0, limit);
          const lines = shown.map((n) => `- [${n.id}] ${n.title}${(n.tags ?? []).length ? '  #' + n.tags.join(' #') : ''}`);
          const head = `归档记忆共 ${notes.length} 条${tag ? `（标签 ${tag}）` : ''}${notes.length > limit ? `，显示前 ${limit} 条` : ''}：`;
          return [head, ...lines].join('\n');
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_update',
      description: '修改一条已有归档记忆（title / tags / content 三选一或多选）。id 支持唯一前缀。修改后 updated 时间会刷新，GitHub 后端会自动提交推送。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id，支持唯一前缀' },
          title: { type: 'string', description: '新标题（可选）' },
          content: { type: 'string', description: '新正文（可选，整体替换）' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签列表（可选，整体替换）' },
        },
        required: ['id'],
      },
      output: outputText,
      async execute(args) {
        try {
          return await enqueue(() => {
            const found = findNote(p, args.id);
            if (found.error) return found.error;
            const note = found.note;
            const file = join(p.notes, `${note.id}.md`);
            const parsed = parseNoteFile(readTextSafe(file));
            const oldContent = parsed.content ?? '';
            const nextMeta = {
              id: note.id,
              title: typeof args.title === 'string' && args.title.trim() ? args.title.replace(/\s+/g, ' ').trim() : note.title,
              tags: Array.isArray(args.tags)
                ? args.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
                : (note.tags ?? []),
              created: note.created,
              updated: new Date().toISOString(),
            };
            const nextContent = typeof args.content === 'string' ? args.content : oldContent;
            if (!nextContent.trim()) return '更新失败：content 不能为空。';
            const text = noteFileText(nextMeta, nextContent);
            atomicWrite(file, text);
            const notes = found.notes.map((n) => (n.id === note.id
              ? { ...n, title: nextMeta.title, tags: nextMeta.tags, updated: nextMeta.updated, size: Buffer.byteLength(text) }
              : n));
            saveIndex(p, notes);
            const sync = afterWrite('memory_update');
            return `已更新 [${note.id}] ${nextMeta.title}。${sync}`;
          });
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_forget',
      description: '处理一条不再需要的归档记忆。mode=archive（默认）移到 notes/archive/ 保留可回滚；mode=delete 直接从 notes/ 删除文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id，支持唯一前缀' },
          mode: { type: 'string', enum: ['archive', 'delete'], description: '默认 archive' },
        },
        required: ['id'],
      },
      output: outputText,
      async execute(args) {
        try {
          return await enqueue(() => {
            const found = findNote(p, args.id);
            if (found.error) return found.error;
            const note = found.note;
            const mode = args.mode === 'delete' ? 'delete' : 'archive';
            const file = join(p.notes, `${note.id}.md`);
            if (mode === 'delete') {
              if (existsSync(file)) unlinkSync(file);
            } else {
              archiveNoteFile(p, note.id);
            }
            saveIndex(p, found.notes.filter((n) => n.id !== note.id));
            const sync = afterWrite(`memory_forget:${mode}`);
            return `已${mode === 'delete' ? '删除' : '归档'} [${note.id}] ${note.title}。${sync}`;
          });
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_stats',
      description: '记忆库概况：归档条数、总大小、标签分布、核心记忆长度、后端与最近更新时间。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: outputText,
      async execute() {
        try {
          const notes = loadIndex(p);
          const tags = new Map();
          let bytes = 0;
          for (const n of notes) {
            bytes += n.size ?? 0;
            for (const t of n.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
          }
          const core = readCore(p);
          const lines = [
            `目录：${p.dir}`,
            `归档：${notes.length} 条，共 ${(bytes / 1024).toFixed(1)} KB`,
            `核心记忆：${core.trim() ? `${core.length} 字符` : '空'}`,
            `后端：${config.backend}${githubMode ? `（${config.remote || '未设 remote'} · ${config.branch}）` : ''}`,
            `最近更新：${notes[0]?.updated ?? '—'}`,
          ];
          if (tags.size) {
            lines.push(`标签：${[...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}(${c})`).join(' ')}`);
          }
          return lines.join('\n');
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_history',
      description: '看记忆库的提交历史（仅 GitHub 后端）。返回最近若干次提交的 hash 与信息，用来追溯某条记忆是什么时候、被哪个工具写进来的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', description: '条数，默认 10' } },
      },
      output: outputText,
      async execute(args) {
        if (!githubMode) return '当前是 local 后端，没有提交历史。';
        try {
          const n = Math.max(1, Math.min(Number(args.limit) || 10, 100));
          const r = git(p, config, ['log', `-${n}`, '--pretty=format:%h  %ad  %s', '--date=short']);
          if (r.status !== 0) return `读取历史失败：${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`;
          return (r.stdout || '').trim() || '还没有提交记录。';
        } catch (e) {
          return errText(e);
        }
      },
    },
    {
      name: 'memory_sync',
      description: 'GitHub 后端专用：action=status 看仓库状态，pull 拉取远端，push 提交并推送本地改动。local 后端调用会提示未启用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'pull', 'push'], description: '默认 status' },
          message: { type: 'string', description: 'push 时的提交信息，可选' },
        },
      },
      output: outputText,
      async execute(args) {
        const action = args.action || 'status';
        if (!githubMode) return '当前是 local 后端（config.backend=local），没有 git 同步。';
        try {
          if (!gitAvailable(config)) return '找不到 git 可执行文件（config.gitBin）。';
          if (!isRepo(p)) return `目录还不是 git 仓库：${p.dir}\n先 git clone 或在配置里给 remote。`;
          if (action === 'pull') {
            const r = doPull();
            return `拉取${r.ok ? '成功' : '失败'}：${r.message}`;
          }
          if (action === 'push') {
            if (config.readOnly) return '只读模式（readOnly: true）不允许 push。';
            const r = doPush(String(args.message || config.commitMessage).replace('{tool}', 'memory_sync'));
            return r.message;
          }
          const st = git(p, config, ['status', '--porcelain'], { allowFail: true });
          const counts = git(p, config, ['rev-list', '--left-right', '--count', `origin/${config.branch}...HEAD`], { allowFail: true });
          const last = git(p, config, ['log', '-1', '--pretty=%h %s'], { allowFail: true });
          return [
            `目录：${p.dir}`,
            `远端：${(git(p, config, ['remote', 'get-url', 'origin'], { allowFail: true }).stdout || '').trim() || '（未设置）'}`,
            `分支：${config.branch}`,
            `最近提交：${(last.stdout || '').trim() || '（还没有提交）'}`,
            `未提交改动：${st.stdout.trim() ? st.stdout.trim().split('\n').length + ' 个文件' : '无'}`,
            `与远端差异（左=远端独有 右=本地独有）：${counts.stdout.trim() || '未知'}`,
          ].join('\n');
        } catch (e) {
          return errText(e);
        }
      },
    },
  ];

  const WRITE_TOOLS = new Set(['memory_write', 'memory_core', 'memory_update', 'memory_forget']);
  const registered = [];
  for (const def of defs) {
    if (readOnly && WRITE_TOOLS.has(def.name)) continue;
    ctx.tools.register(def);
    registered.push(def.name);
  }
  console.log(`[dsh-memory-github] 已加载：backend=${config.backend} dir=${p.dir} 工具=${registered.join(',')}`);
}
