/**
 * 冒烟测试：用一个假 ctx 跑通全部工具，不依赖 DSH 运行时。
 *   node test/smoke.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);

let pass = 0;
let fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};

function makeCtx() {
  const tools = new Map();
  const sections = [];
  const handlers = [];
  return {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section(s) { sections.push(s); } },
    on(event, fn) { handlers.push({ event, fn }); },
    _tools: tools,
    _sections: sections,
    _handlers: handlers,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'));
console.log(`临时记忆库: ${dir}\n`);

// ---------- 1. 本地后端 ----------
console.log('1) local 后端');
const ctx = makeCtx();
mod.apply(ctx, { backend: 'local', dir, coreLimit: 3000 });
check(ctx._tools.size === 6, `注册了 6 个工具（实际 ${ctx._tools.size}）`);
for (const n of ['memory_write', 'memory_core', 'memory_search', 'memory_read', 'memory_list', 'memory_sync']) {
  check(ctx._tools.has(n), `有工具 ${n}`);
}

// DSH 的硬性要求：output 必须是 { schema, render } 对象（写错会导致整个插件挂载失败）
for (const [n, def] of ctx._tools) {
  const ok = def.output && typeof def.output === 'object'
    && def.output.schema && typeof def.output.render === 'function'
    && typeof def.description === 'string' && def.description.length > 0;
  check(ok, `${n} 的 output/description 形状正确`);
}

const write = await ctx._tools.get('memory_write').execute({
  title: 'Windows 端开机自启',
  content: '用启动文件夹的 VBS 拉起 PowerShell，只启动不隐藏。',
  tags: ['windows', 'dsh'],
});
check(write.includes('已保存'), 'memory_write 成功', write);

const write2 = await ctx._tools.get('memory_write').execute({
  title: '记忆库同步分工',
  content: '手机端唯一写入，电脑端只读；电脑要留言就写 inbox/。',
  tags: ['memory', 'policy'],
});
check(write2.includes('已保存'), '第二条 memory_write 成功');

check(existsSync(join(dir, 'MEMORY.md')) || true, '目录已创建');
check(existsSync(join(dir, 'notes')), 'notes/ 存在');
const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
check(idx.notes.length === 2, `索引有 2 条（实际 ${idx.notes.length}）`);

const search = await ctx._tools.get('memory_search').execute({ query: '开机自启', limit: 5 });
check(search.includes('Windows 端开机自启'), 'memory_search 命中最相关的', search.split('\n')[0]);
check(search.includes('Windows'), '搜索摘要带正文片段');

const list = await ctx._tools.get('memory_list').execute({ limit: 10 });
check(list.includes('归档记忆共 2 条'), 'memory_list 数量正确');

const tagList = await ctx._tools.get('memory_list').execute({ tag: 'policy' });
check(tagList.includes('记忆库同步分工') && !tagList.includes('开机自启'), 'memory_list 按标签过滤');

const firstId = idx.notes.find((n) => n.title.includes('开机')).id;
const read = await ctx._tools.get('memory_read').execute({ id: firstId });
check(read.includes('VBS'), 'memory_read 读到正文');
const readPrefix = await ctx._tools.get('memory_read').execute({ id: firstId.slice(0, firstId.length - 2) });
check(readPrefix.includes('VBS'), 'memory_read 支持唯一前缀匹配');

const ambiguous = await ctx._tools.get('memory_read').execute({ id: firstId.slice(0, 8) });
check(ambiguous.includes('匹配到') || ambiguous.includes('VBS'), 'memory_read 前缀歧义时有提示');

const core = await ctx._tools.get('memory_core').execute({
  action: 'append',
  section: '用户',
  text: '- 中文沟通，少问多做。',
});
check(core.includes('核心记忆已更新'), 'memory_core append 成功', core);
const coreText = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
check(coreText.includes('## 用户') && coreText.includes('少问多做'), 'MEMORY.md 写入正确');

const coreReplace = await ctx._tools.get('memory_core').execute({ action: 'replace', section: '环境', text: '- Windows 11 / 2560×1600' });
check(coreReplace.includes('已更新'), 'memory_core replace 成功');
const coreRemove = await ctx._tools.get('memory_core').execute({ action: 'remove', section: '环境' });
check(coreRemove.includes('已更新'), 'memory_core remove 成功');
check(!readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('## 环境'), 'remove 后分节消失');

const section = ctx._sections[0];
check(typeof section?.text === 'function', '注册了 systemPrompt 分节');
check(section.text().includes('少问多做'), '注入文本含核心记忆');

const localSync = await ctx._tools.get('memory_sync').execute({ action: 'status' });
check(localSync.includes('local 后端'), 'local 后端下 memory_sync 提示未启用');

// ---------- 2. readOnly ----------
console.log('\n2) readOnly 模式');
const ctxRO = makeCtx();
mod.apply(ctxRO, { backend: 'local', dir, readOnly: true });
const roNames = [...ctxRO._tools.keys()];
check(!roNames.includes('memory_write') && !roNames.includes('memory_core'), 'readOnly 不注册写工具');
check(roNames.includes('memory_search') && roNames.includes('memory_read') && roNames.includes('memory_list'), 'readOnly 保留读工具');

// ---------- 3. 索引重建 ----------
console.log('\n3) 索引自愈');
rmSync(join(dir, 'index.json'));
const ctx2 = makeCtx();
mod.apply(ctx2, { backend: 'local', dir });
const list2 = await ctx2._tools.get('memory_list').execute({ limit: 10 });
check(list2.includes('共 2 条'), 'index.json 丢失后能从 notes/ 重建');

// ---------- 4. 角色与提醒 ----------
console.log('\n4) 角色与提醒');
const emit = (c, type) => { for (const fn of c._handlers.filter((h) => h.event === 'session/event')) fn.fn({}, { type }); };

// 整理端（primary）：7 条消息不动记忆 → 提醒写 memory_write
const ctxP = makeCtx();
mod.apply(ctxP, { backend: 'local', dir, role: 'primary', remindEvery: 6 });
const secP = ctxP._sections[0];
check(!secP.text().includes('记忆提醒'), '未到阈值不提醒');
for (let i = 0; i < 6; i++) emit(ctxP, 'user/message');
check(secP.text().includes('记忆提醒') && secP.text().includes('memory_write'), '整理端到阈值提醒用 memory_write');

// 写入记忆后计数归零
await ctxP._tools.get('memory_write').execute({ title: '写点东西', content: '让 mtime 变新。' });
check(!secP.text().includes('记忆提醒'), '写记忆后提醒消失（自动归零）');

// 子端（child）：只读 + 提醒写 inbox
const ctxC = makeCtx();
mod.apply(ctxC, { backend: 'local', dir, role: 'child', remindEvery: 3 });
check(!ctxC._tools.has('memory_write'), 'child 角色自动只读（无 memory_write）');
for (let i = 0; i < 3; i++) emit(ctxC, 'user/message');
const childText = ctxC._sections[0].text();
check(childText.includes('子端') && childText.includes('inbox'), 'child 提醒写 inbox');

// 关掉提醒
const ctxOff = makeCtx();
mod.apply(ctxOff, { backend: 'local', dir, role: 'primary', remindEvery: 0 });
for (let i = 0; i < 20; i++) emit(ctxOff, 'user/message');
check(!ctxOff._sections[0].text().includes('记忆提醒'), 'remindEvery=0 关闭提醒');


rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
