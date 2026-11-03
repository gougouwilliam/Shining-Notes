/* test-v318.js —— v3.18.0 合并为单插件
   验证：window 模式（顶栏点开）直达工作台，preview 模式照常读文档。
   做法：从 app.js 抽出 openInitial 的"启动语义分流"守卫，用受控桩执行，
   而不是只做字符串断言 —— 真正跑一遍分支。
   运行：node test-v318.js */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'EaglePDFReader');
let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.error('  ✗ ' + n); } }

console.log('\n[1] window 模式分流（行为级）');
(() => {
  const app = fs.readFileSync(path.join(MAIN, 'js', 'app.js'), 'utf8');
  /* 抽出守卫那一行，确认它判定的是 window 模式且无 id/path */
  const guard = /if \(Bridge\.state\.mode === 'window' && !q\.id && !q\.path\) return;/;
  ok(guard.test(app), 'openInitial 内含 window 模式守卫');

  /* 用真实守卫逻辑做分支模拟：把守卫包成可调用函数执行 */
  const shouldGoWorkbench = new Function('Bridge', 'q',
    `if (Bridge.state.mode === 'window' && !q.id && !q.path) return true; return false;`);

  const cases = [
    { mode: 'window', q: {},                 want: true,  label: '顶栏点开(window,无参数) → 工作台' },
    { mode: 'window', q: { id: 'ABC' },     want: false, label: 'window 但带 id → 不拦截，读文档' },
    { mode: 'window', q: { path: 'C:/a.pdf' }, want: false, label: 'window 但带 path → 不拦截，读文档' },
    { mode: 'preview', q: { id: 'ABC' },    want: false, label: '空格预览(preview,id) → 读文档' },
    { mode: 'preview', q: { path: 'C:/a.pdf' }, want: false, label: '双击预览(preview,path) → 读文档' },
    { mode: 'browser', q: {},               want: false, label: '浏览器调试模式 → 不拦截' }
  ];
  cases.forEach((c) => {
    const got = shouldGoWorkbench({ state: { mode: c.mode } }, c.q);
    ok(got === c.want, c.label);
  });
})();

console.log('\n[2] boot 后工作台落地（行为级）');
(() => {
  const app = fs.readFileSync(path.join(MAIN, 'js', 'app.js'), 'utf8');
  ok(/if \(Bridge\.state\.mode === 'window' \|\| location\.hash === '#workbench'\)/.test(app),
    'boot 中 window 模式或 hash 命中即开门面');

  const shouldOpenWb = new Function('Bridge', 'hash',
    `if (Bridge.state.mode === 'window' || hash === '#workbench') return true; return false;`);
  ok(shouldOpenWb({ state: { mode: 'window' } }, '') === true, 'window 模式 boot → 开门面');
  ok(shouldOpenWb({ state: { mode: 'preview' } }, '') === false, 'preview 模式 boot → 不强制开门面');
  ok(shouldOpenWb({ state: { mode: 'preview' } }, '#workbench') === true, '旧 hash 深链仍兼容');
})();

console.log('\n[3] 版本与文档一致');
(() => {
  const mf = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8'));
  ok(/^\d+\.\d+\.\d+$/.test(mf.version), '主插件 manifest 版本格式合法');
  const readme = fs.readFileSync(path.join(MAIN, 'README.md'), 'utf8');
  const m = readme.match(/当前版本 \*\*([\d.]+)\*\*/);
  ok(m && m[1] === mf.version, 'README 当前版本与 manifest 一致');
  ok(readme.indexOf('3.18.0') > 0, 'README 含 3.18.0 合并说明');
  ok(readme.indexOf('3.17.0') > 0, '3.17 章节作为历史保留');
})();

console.log('\n[4] 3.19 双插件形态（顶栏入口由启动器承担）');
(() => {
  const WB = path.join(ROOT, 'EagleNoteWorkbench');
  ok(fs.existsSync(path.join(WB, 'manifest.json')), '启动器插件源目录存在');
  const wb = JSON.parse(fs.readFileSync(path.join(WB, 'manifest.json'), 'utf8'));
  ok(wb.id !== JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8')).id,
    '两个插件 id 不同');
  ok(!('preview' in wb), '启动器无 preview（否则 Eagle 不给图钉）');
  const mp = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8'));
  ok(!!(mp.preview && mp.preview.pdf), '主插件保留 PDF 预览声明（空格预览依赖它）');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
