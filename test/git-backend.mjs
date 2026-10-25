/**
 * GitHub 后端冒烟测试：用**本地裸仓库**模拟远端，验证 clone / 自动 push / pull。
 * 不联网、不碰真实 GitHub。
 *
 *   node test/git-backend.mjs
 *   GIT_BIN=C:\path\git.exe node test/git-backend.mjs
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GIT = process.env.GIT_BIN || 'git';
const mod = await import(pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);

let pass = 0;
let fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
};
const git = (cwd, args) => {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
};
const makeCtx = () => {
  const tools = new Map();
  const sections = [];
  return { tools: { register: (d) => tools.set(d.name, d) }, systemPrompt: { section: (s) => sections.push(s) }, _tools: tools };
};

const root = mkdtempSync(join(tmpdir(), 'dsh-mem-git-'));
const bare = join(root, 'remote.git');
const dev1 = join(root, 'dev1');
const dev2 = join(root, 'dev2');

try {
  console.log(`临时目录: ${root}\n`);
  git(root, ['--version']);
  check(true, 'git 可用');

  // 建裸仓库 + 首个提交
  spawnSync(GIT, ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  git(root, ['clone', bare, dev1]);
  spawnSync(GIT, ['-C', dev1, 'checkout', '-b', 'main'], { encoding: 'utf8' });
  writeFileSync(join(dev1, 'README.md'), '# memory\n');
  git(dev1, ['add', '-A']);
  git(dev1, ['commit', '-m', 'init']);

  console.log('1) 设备 A：写入并自动推送');
  const ctxA = makeCtx();
  mod.apply(ctxA, { backend: 'github', dir: dev1, remote: bare, branch: 'main', autoPush: true, gitBin: GIT });
  const w = await ctxA._tools.get('memory_write').execute({ title: '设备 A 的一条记忆', content: '这条应该被推送到远端。', tags: ['sync'] });
  check(w.includes('已保存'), 'memory_write 成功', w);
  check(!w.includes('同步失败'), '自动推送没有报错', w);

  const countAfter = git(bare, ['rev-list', '--count', 'main']);
  check(Number(countAfter) >= 2, `裸仓库收到提交（现在 ${countAfter} 个）`);

  console.log('\n2) 设备 B：克隆后自动拉取并读到 A 的记忆');
  git(root, ['clone', bare, dev2]);
  const ctxB = makeCtx();
  mod.apply(ctxB, { backend: 'github', dir: dev2, branch: 'main', autoPull: true, readOnly: true, gitBin: GIT });
  const listB = await ctxB._tools.get('memory_list').execute({ limit: 10 });
  check(listB.includes('设备 A 的一条记忆'), 'B 读到了 A 的归档记忆', listB.split('\n')[0]);
  check(!ctxB._tools.has('memory_write'), 'B 是只读模式，没有写工具');

  console.log('\n3) memory_sync 状态与手动推送');
  const st = await ctxB._tools.get('memory_sync').execute({ action: 'status' });
  check(st.includes('分支：main'), 'status 显示分支');
  check(st.includes('远端：'), 'status 显示远端');

  const ctxC = makeCtx();
  mod.apply(ctxC, { backend: 'github', dir: dev1, branch: 'main', autoPush: false, gitBin: GIT });
  await ctxC._tools.get('memory_write').execute({ title: '第二条', content: '自动推送关掉时应该只在本地。' });
  const beforePush = Number(git(bare, ['rev-list', '--count', 'main']));
  const pushed = await ctxC._tools.get('memory_sync').execute({ action: 'push', message: '手动同步' });
  const afterPush = Number(git(bare, ['rev-list', '--count', 'main']));
  check(pushed.includes('已提交'), 'memory_sync push 执行了提交', pushed);
  check(afterPush === beforePush + 1, `推送后远端多一个提交（${beforePush} → ${afterPush}）`);

  console.log('\n4) 无仓库时的容错');
  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  const ctxD = makeCtx();
  mod.apply(ctxD, { backend: 'github', dir: plain, autoPull: false, gitBin: GIT });
  const st2 = await ctxD._tools.get('memory_sync').execute({ action: 'status' });
  check(st2.includes('还不是 git 仓库'), '非仓库目录给出明确提示', st2);
  const w2 = await ctxD._tools.get('memory_write').execute({ title: '离线记忆', content: '没有 git 也能写本地。' });
  check(w2.includes('已保存') && w2.includes('同步失败'), '写本地成功、并提示同步失败', w2.split('\n')[0]);
} catch (e) {
  fail++;
  console.log(`\n异常: ${e instanceof Error ? e.message : e}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
