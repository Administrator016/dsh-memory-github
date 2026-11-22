/**
 * 0.4.4 新能力自测：related / isolatedReason / supersededBy
 *   node --test test/supersede.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);

function makeCtx() {
  const tools = new Map();
  return {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    on() {},
    _tools: tools,
  };
}

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-supersede-'));
  const ctx = makeCtx();
  mod.apply(ctx, { backend: 'local', dir, coreLimit: 3000 });
  return { dir, ctx, tool: (n) => ctx._tools.get(n) };
}

const idOf = (text) => /\[([^\]]+)\]/.exec(text)?.[1] ?? null;

test('memory_write 支持 related + supersedes（旧笔记自动归档并反向挂链）', async () => {
  const { dir, ctx, tool } = boot();
  const write = tool('memory_write');
  const stats = tool('memory_stats');
  assert.ok(write && stats, '应注册 memory_write / memory_stats');

  const first = await write.execute({ title: '旧结论：改引擎 CSS 有用', content: '旧内容', tags: ['kind/pitfall'] });
  const oldId = idOf(first);
  assert.ok(oldId, first);

  const second = await write.execute({
    title: '新结论：改引擎 CSS 无效，要插件注入',
    content: '新内容',
    tags: ['kind/pitfall'],
    related: [oldId],
    supersedes: oldId,
  });
  const newId = idOf(second);
  assert.ok(newId && newId !== oldId, second);

  const newText = readFileSync(join(dir, 'notes', `${newId}.md`), 'utf8');
  assert.match(newText, /^related: .*旧结论/m);
  assert.match(newText, new RegExp(`supersedes: ${oldId}`));

  assert.equal(existsSync(join(dir, 'notes', `${oldId}.md`)), false, '旧笔记应离开 notes/');
  const archived = join(dir, 'notes', 'archive', `${oldId}.md`);
  assert.ok(existsSync(archived), '旧笔记应进 archive/');
  assert.match(readFileSync(archived, 'utf8'), new RegExp(`superseded_by: ${newId}`));

  const s = await stats.execute({});
  assert.match(s, /取代/, s);
  rmSync(dir, { recursive: true, force: true });
});

test('isolatedReason 写成 isolated: true + isolated_reason', async () => {
  const { dir, ctx, tool } = boot();
  const r = await tool('memory_write').execute({ title: '孤立条目', content: 'x', isolatedReason: '临时草稿，暂无关联' });
  const id = idOf(r);
  assert.ok(id, r);
  const text = readFileSync(join(dir, 'notes', `${id}.md`), 'utf8');
  assert.match(text, /^isolated: true$/m);
  assert.match(text, /^isolated_reason: 临时草稿/m);
  rmSync(dir, { recursive: true, force: true });
});

test('memory_update 也能补 related 与 supersedes', async () => {
  const { dir, ctx, tool } = boot();
  const write = tool('memory_write');
  const update = tool('memory_update');
  const a = idOf(await write.execute({ title: 'A 旧笔记', content: 'a' }));
  const b = idOf(await write.execute({ title: 'B 新笔记', content: 'b' }));
  const r = await update.execute({ id: b, supersedes: a, related: [a] });
  assert.match(r, /已更新/);
  const archived = join(dir, 'notes', 'archive', `${a}.md`);
  assert.ok(existsSync(archived), '被取代的 A 应进 archive/');
  assert.match(readFileSync(archived, 'utf8'), new RegExp(`superseded_by: ${b}`));
  assert.equal(existsSync(join(dir, 'notes', `${b}.md`)), true, 'B 应仍在 notes/');
  rmSync(dir, { recursive: true, force: true });
});
