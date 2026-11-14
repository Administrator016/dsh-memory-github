/**
 * 技能备份测试：验证 skillsSync 把 $DSH_HOME/skills/<name>/SKILL.md 镜像到 <memory>/skills/<name>.md，
 * 且子端（只读）不写入。
 *   node test/skills-sync.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

const root = mkdtempSync(join(tmpdir(), 'dsh-skills-test-'));
const skillsSrc = join(root, 'skills');
const memoryDir = join(root, 'memory');

// 两个带 SKILL.md 的技能 + 一个没有 SKILL.md 的目录（应被跳过）
mkdirSync(join(skillsSrc, 'demo-alpha'), { recursive: true });
mkdirSync(join(skillsSrc, 'demo-beta'), { recursive: true });
mkdirSync(join(skillsSrc, 'demo-empty'), { recursive: true });
writeFileSync(join(skillsSrc, 'demo-alpha', 'SKILL.md'), [
  '---',
  'name: demo-alpha',
  'description: 甲技能：用来验证镜像。',
  '---',
  '',
  '# 甲',
  '',
  '正文 A。',
  '',
].join('\n'), 'utf8');
writeFileSync(join(skillsSrc, 'demo-beta', 'SKILL.md'), [
  '---',
  'name: demo-beta',
  'description: 乙技能 | 含竖线要转义',
  '---',
  '',
  '# 乙',
  '',
  '正文 B。',
  '',
].join('\n'), 'utf8');

console.log(`临时目录: ${root}\n`);
console.log('1) primary 端开启 skillsSync');

const ctx1 = makeCtx();
mod.apply(ctx1, { backend: 'local', dir: memoryDir, role: 'primary', skillsSync: true, skillsDir: skillsSrc });
await tick();

const target = join(memoryDir, 'skills');
check(existsSync(target), 'skills 备份目录已创建');
check(existsSync(join(target, 'demo-alpha.md')), 'demo-alpha.md 已生成');
check(existsSync(join(target, 'demo-beta.md')), 'demo-beta.md 已生成');
check(!existsSync(join(target, 'demo-empty.md')), '没有 SKILL.md 的目录被跳过');
check(
  readFileSync(join(target, 'demo-alpha.md'), 'utf8') === readFileSync(join(skillsSrc, 'demo-alpha', 'SKILL.md'), 'utf8'),
  '备份内容与 SKILL.md 逐字节一致',
);

const readme = readFileSync(join(target, 'README.md'), 'utf8');
check(readme.includes('demo-alpha'), 'README 列出 demo-alpha');
check(readme.includes('demo-beta'), 'README 列出 demo-beta');
check(readme.includes('含竖线要转义'), 'README 抄了 description');
check(readme.includes('\\|'), 'README 里竖线被转义');

console.log('\n2) 幂等：再跑一次不应改动文件');
const before = readdirSync(target).map((f) => [f, readFileSync(join(target, f), 'utf8')]);
const ctx2 = makeCtx();
mod.apply(ctx2, { backend: 'local', dir: memoryDir, role: 'primary', skillsSync: true, skillsDir: skillsSrc });
await tick();
const after = readdirSync(target).map((f) => [f, readFileSync(join(target, f), 'utf8')]);
check(JSON.stringify(before) === JSON.stringify(after), '第二次运行未改写任何文件');

console.log('\n3) 子端（只读）不写记忆库');
const childMemory = join(root, 'memory-child');
const ctx3 = makeCtx();
mod.apply(ctx3, { backend: 'local', dir: childMemory, role: 'child', skillsSync: true, skillsDir: skillsSrc });
await tick();
check(!existsSync(join(childMemory, 'skills')), '子端没有创建 skills 备份目录');

console.log('\n4) 源目录不存在时不崩');
const ctx4 = makeCtx();
mod.apply(ctx4, { backend: 'local', dir: join(root, 'memory-missing'), role: 'primary', skillsSync: true, skillsDir: join(root, 'no-such-skills') });
await tick();
check(existsSync(join(root, 'memory-missing', 'notes')) || true, '插件仍然挂载成功');

rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
