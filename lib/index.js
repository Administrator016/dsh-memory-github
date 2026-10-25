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
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const name = 'dsh-memory-github';
export const inject = ['systemPrompt', 'tools'];

const DEFAULTS = {
  backend: 'local',        // local | github
  dir: '',                 // 空 = $DSH_HOME/memory
  readOnly: false,
  coreLimit: 3000,
  remote: '',              // github 后端：git remote（ssh 或 https）
  branch: 'main',
  autoPull: true,          // 启动时 pull
  autoPush: true,          // 写入后 commit+push
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

// ---------------------------------------------------------------- core 记忆

function coreLimit(config) {
  const n = Number(config.coreLimit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3000;
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

function outputText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function errText(e) {
  return `操作失败：${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, config0) {
  const config = { ...DEFAULTS, ...(config0 ?? {}) };
  const p = makePaths(config);
  try { ensureDirs(p); } catch { /* 目录建不了就在工具里报 */ }

  const githubMode = config.backend === 'github';

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
          const r = gitPull(p, config);
          console.log(`[dsh-memory-github] 启动拉取：${r.ok ? '成功' : '失败'} ${r.message.split('\n')[0]}`);
        }
      } catch (e) {
        console.warn(`[dsh-memory-github] 启动拉取异常：${e instanceof Error ? e.message : e}`);
      }
    }, 0);
  }

  // 每轮注入核心记忆
  ctx.systemPrompt.section({
    name: 'dsh-memory-github:core',
    order: 60,
    text: () => coreSection(readCore(p), coreLimit(config)),
  });

  const afterWrite = (tool) => {
    if (!githubMode || !config.autoPush) return '';
    const r = gitPush(p, config, String(config.commitMessage).replace('{tool}', tool));
    return r.ok ? '' : `\n（GitHub 同步失败：${r.message.split('\n')[0]}）`;
  };

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
            return `已保存 [${id}] ${title}${tags.length ? ' #' + tags.join(' #') : ''}。${sync}`;
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
            const r = gitPull(p, config);
            return `拉取${r.ok ? '成功' : '失败'}：${r.message}`;
          }
          if (action === 'push') {
            if (config.readOnly) return '只读模式（readOnly: true）不允许 push。';
            const r = gitPush(p, config, String(args.message || config.commitMessage).replace('{tool}', 'memory_sync'));
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

  const WRITE_TOOLS = new Set(['memory_write', 'memory_core']);
  const registered = [];
  for (const def of defs) {
    if (config.readOnly && WRITE_TOOLS.has(def.name)) continue;
    ctx.tools.register(def);
    registered.push(def.name);
  }
  console.log(`[dsh-memory-github] 已加载：backend=${config.backend} dir=${p.dir} 工具=${registered.join(',')}`);
}
