/**
 * 0.4.6 新能力自测：inbox 提醒
 *   node --test test/inbox-nudge.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);

function boot(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-inbox-'));
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  const sections = [];
  const ctx = {
    tools: { register() {} },
    systemPrompt: { section(s) { sections.push(s); } },
    on() {},
  };
  mod.apply(ctx, { backend: 'local', dir, coreLimit: 3000, ...extra });
  const section = sections.find((s) => s.name === 'dsh-memory-github:inbox');
  return { dir, sections, section };
}

test('有 inbox 文件时注入提醒，处理后消失', () => {
  const { dir, section } = boot();
  assert.ok(section, '可写端应注册 inbox 提醒 section');
  assert.equal(section.text(), '', '空 inbox 不该有内容');

  writeFileSync(join(dir, 'inbox', 'pc-20261125-测试留言.md'), '# hi\n');
  const text = section.text();
  assert.match(text, /inbox 待整理/);
  assert.match(text, /pc-20261125-测试留言/);

  rmSync(join(dir, 'inbox', 'pc-20261125-测试留言.md'));
  assert.equal(section.text(), '', '删掉后应恢复为空');

  rmSync(dir, { recursive: true, force: true });
});

test('inbox/done 与 README 不算待整理', () => {
  const { dir, section } = boot();
  mkdirSync(join(dir, 'inbox', 'done'), { recursive: true });
  writeFileSync(join(dir, 'inbox', 'README.md'), 'readme\n');
  writeFileSync(join(dir, 'inbox', 'done', 'pc-旧留言.md'), '# old\n');
  assert.equal(section.text(), '');
  rmSync(dir, { recursive: true, force: true });
});

test('只读子端不注册 inbox 提醒', () => {
  const { sections } = boot({ role: 'child' });
  assert.equal(sections.filter((s) => s.name === 'dsh-memory-github:inbox').length, 0);
});
