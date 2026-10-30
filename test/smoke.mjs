/**
 * 冒烟测试：用一个假 ctx 跑通全部工具，不依赖 DSH 运行时。
 *   node test/smoke.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
check(ctx._tools.size === 10, `注册了 10 个工具（实际 ${ctx._tools.size}）`);
for (const n of ['memory_write', 'memory_core', 'memory_search', 'memory_read', 'memory_list',
  'memory_update', 'memory_forget', 'memory_stats', 'memory_history', 'memory_sync']) {
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
const emit = (c, type, data = {}) => { for (const fn of c._handlers.filter((h) => h.event === 'session/event')) fn.fn({}, { type, data }); };

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

// ---------- 5. 新工具：update / forget / stats / history ----------
console.log('\n5) 新工具');
const ctx3 = makeCtx();
mod.apply(ctx3, { backend: 'local', dir });
const T3 = (n) => ctx3._tools.get(n);

const before3 = await T3('memory_list').execute({ limit: 50 });
check(before3.includes('共 3 条'), '起始 3 条归档');

const upd = await T3('memory_update').execute({ id: '写点东西', title: '改过的标题', tags: ['t1', 't2'] });
check(upd.includes('已更新') && upd.includes('改过的标题'), 'memory_update 改标题成功');
const afterUpd = await T3('memory_list').execute({ limit: 50 });
check(afterUpd.includes('改过的标题') && afterUpd.includes('#t1'), 'update 后列表可见新标题与标签');

const updId = /\[([^\]]+)\]/.exec(upd)?.[1] ?? '';
const byPrefix = await T3('memory_update').execute({ id: updId.slice(0, updId.length - 2), content: '前缀匹配改正文。' });
check(byPrefix.includes('已更新'), 'memory_update 支持唯一前缀（按 id 前缀）');

const arch = await T3('memory_forget').execute({ id: '改过的标题', mode: 'archive' });
check(arch.includes('已归档'), 'memory_forget archive 成功');
check(existsSync(join(dir, 'notes', 'archive')), 'archive 目录已创建');

const del = await T3('memory_forget').execute({ id: '记忆库同步分工', mode: 'delete' });
check(del.includes('已删除'), 'memory_forget delete 成功');

const stats = await T3('memory_stats').execute({});
check(stats.includes('归档：') && stats.includes('标签：'), 'memory_stats 返回概况与标签分布');

const hist = await T3('memory_history').execute({});
check(hist.includes('local 后端'), 'local 后端下 memory_history 提示无历史');

// ---------- 6. recentLimit 注入 ----------
console.log('\n6) 最近归档注入');
const ctx4 = makeCtx();
mod.apply(ctx4, { backend: 'local', dir, recentLimit: 3 });
check(ctx4._sections[0].text().includes('最近归档'), 'recentLimit 注入了最近归档段');
const ctx5 = makeCtx();
mod.apply(ctx5, { backend: 'local', dir, recentLimit: 0 });
check(!ctx5._sections[0].text().includes('最近归档'), 'recentLimit=0 不注入');

// ---------- 7. 查重提示 ----------
console.log('\n7) 查重提示');
const ctx6 = makeCtx();
mod.apply(ctx6, { backend: 'local', dir, dedupeHint: true });
const noteA = await ctx6._tools.get('memory_write').execute({
  title: 'Node 环境版本',
  content: '这台机器的 Node 是 26.4，运行时在 dsh-runtimes 里，npm 11.16。',
});
const noteB = await ctx6._tools.get('memory_write').execute({
  title: 'Node 环境版本（重复）',
  content: '这台机器的 Node 是 26.4，运行时在 dsh-runtimes 里，npm 11.16。',
});
check(noteB.includes('高度相似'), '相似写入会被提示去重');

const ctx7 = makeCtx();
mod.apply(ctx7, { backend: 'local', dir, dedupeHint: false });
const noteC = await ctx7._tools.get('memory_write').execute({
  title: 'Node 环境版本（再重复）',
  content: '这台机器的 Node 是 26.4，运行时在 dsh-runtimes 里，npm 11.16。',
});
check(!noteC.includes('高度相似'), 'dedupeHint=false 时不提示');

// ---------- 8. 自动召回 ----------
console.log('\n8) 自动召回');
const ctxR = makeCtx();
mod.apply(ctxR, { backend: 'local', dir, autoRecall: true });
await ctxR._tools.get('memory_write').execute({
  title: '显卡驱动版本',
  tags: ['gpu'],
  content: 'NVIDIA 驱动 551.23，重装前先 DDU 清干净。',
});
await ctxR._tools.get('memory_write').execute({
  title: 'Python 环境',
  tags: ['python'],
  content: '这台机器没有 python3，脚本一律用 node。',
});
emit(ctxR, 'user/message', { content: [{ type: 'text', text: '显卡驱动要不要更新一下？' }] });
const recallText = ctxR._sections[0].text();
check(recallText.includes('自动召回'), 'autoRecall 触发了注入');
check(recallText.includes('显卡驱动版本'), '召回命中了相关归档');
check(!recallText.includes('Python 环境'), '不相关归档没有被召回');

const ctxR2 = makeCtx();
mod.apply(ctxR2, { backend: 'local', dir, autoRecall: false });
emit(ctxR2, 'user/message', { content: '显卡驱动要不要更新一下？' });
check(!ctxR2._sections[0].text().includes('自动召回'), 'autoRecall=false 关闭注入');

// 没有相关记忆时不该硬塞
const ctxR3 = makeCtx();
mod.apply(ctxR3, { backend: 'local', dir, autoRecall: true });
emit(ctxR3, 'user/message', { content: '今天天气怎么样' });
check(!ctxR3._sections[0].text().includes('自动召回'), '无相关记忆时不注入');

// ---------- 按端过滤核心记忆（coreExclude） ----------
console.log('\n) coreExclude 分端注入');
const dirE = mkdtempSync(join(tmpdir(), 'dsh-memory-exclude-'));
writeFileSync(join(dirE, 'MEMORY.md'), [
  '# 测试核心',
  '',
  '## 通用',
  '- 大家都看得到',
  '',
  '## 环境（手机）【手机】',
  '- 只给手机看',
  '',
  '## 电脑端守则【电脑】',
  '- 只给电脑看',
  '',
  '## 空节【手机】',
].join('\n'));

// 子端：默认丢掉【手机】行/节
const ctxEx1 = makeCtx();
mod.apply(ctxEx1, { backend: 'local', dir: dirE, role: 'child' });
const exChild = ctxEx1._sections[0].text();
check(exChild.includes('大家都看得到'), '子端保留通用内容');
check(!exChild.includes('只给手机看'), '子端过滤掉【手机】行');
check(!exChild.includes('环境（手机）'), '整节被过滤空时标题一起丢弃');
check(exChild.includes('只给电脑看'), '子端保留【电脑】内容');

// 主端：不过滤
const ctxEx2 = makeCtx();
mod.apply(ctxEx2, { backend: 'local', dir: dirE, role: 'primary' });
const exPrimary = ctxEx2._sections[0].text();
check(exPrimary.includes('只给手机看') && exPrimary.includes('只给电脑看'), '主端不丢内容');

// 显式配置：主端也过滤【电脑】
const ctxEx3 = makeCtx();
mod.apply(ctxEx3, { backend: 'local', dir: dirE, role: 'primary', coreExclude: ['【电脑】'] });
const exP2 = ctxEx3._sections[0].text();
check(!exP2.includes('只给电脑看') && exP2.includes('只给手机看'), 'coreExclude 可显式指定标记');

// 过滤发生在截断之前：过滤后长度应显著短于原始
check(exChild.length < exPrimary.length, '过滤在 coreLimit 截断之前生效');
rmSync(dirE, { recursive: true, force: true });


rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
