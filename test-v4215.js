/* v4.2.15 回归：搜索固定停「全部」+ 标签改名 + 搜索面板 fixed 定位 + 视频框选压暗 */
const fs = require('fs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL - ' + msg); }
}

const A = fs.readFileSync('EaglePDFReader/js/app.js', 'utf8');
const H = fs.readFileSync('EaglePDFReader/index.html', 'utf8');
const C = fs.readFileSync('EaglePDFReader/css/app.css', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('== 1. 版本联动（硬约定）==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(MFEST.split('\n').find(l => l.includes('"version"'))), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(WFEST.split('\n').find(l => l.includes('"version"'))), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/^\d+\.\d+\.\d+$/.test((MFEST.match(/"version":\s*"(\d+\.\d+\.\d+)"/) || [])[1] || '') &&
   (MFEST.match(/"version":\s*"(\d+\.\d+\.\d+)"/) || [])[1] === (WFEST.match(/"version":\s*"(\d+\.\d+\.\d+)"/) || [])[1],
  '双 manifest 版本一致（三段式）');

console.log('== 2. 搜索固定停「全部」==');
ok(/\/\* v4\.2\.15：默认停在「全部」[\s\S]{0,200}noteSearch\.layer = 0;/.test(A), '搜索后固定 layer=0（自动选层已删）');
ok(!/noteSearch\.layer = noteSearch\.res\[1\]\.length/.test(A), '「上层有结果停上层」逻辑已移除');
ok(/const all = noteSearch\.res\[1\]\.concat\(noteSearch\.res\[2\], l3\);/.test(A), '「全部」合流顺序：资料内 → 全局 → Eagle 数据库');

console.log('== 3. 标签改名 ==');
ok(/\[1, '资料内笔记'/.test(A) && /\[3, 'Eagle 数据库'/.test(A), '结果标签改名为 资料内笔记 / Eagle 数据库');
ok(!/\[1, '本笔记'/.test(A) && !/\[3, 'Eagle 库'/.test(A), '旧标签字符串已移除');
ok(H.includes('默认全部（资料内 / 全局 / Eagle 数据库）'), '搜索框占位符更新');
ok(!H.includes('Esc 逐层退'), '过时的「Esc 逐层退」占位符已移除');
ok(A.includes('搜索资料内 / 全局 / Eagle 数据库'), '结果提示行同步改名');

console.log('== 4. 搜索面板 fixed 定位 ==');
const fm = /function showSearchPane\(\) \{([\s\S]*?)\n    pane\.hidden = false;/.exec(A);
ok(!!fm, 'showSearchPane 可提取');
if (fm) {
  const body = fm[1];
  ok(body.includes("getBoundingClientRect().right"), '右缘取明暗切换键实测位置');
  ok(body.includes("pane.style.width") && body.includes("pane.style.left") && body.includes("pane.style.top"), '宽/左/顶三值由 JS 写入');
  ok(body.includes("r.bottom + 6"), '顶边贴搜索栏下方');
  /* 行为沙箱：searchBox.left=120, btnTheme.right=560 → 宽 440，left=120，top=box.bottom+6 */
  let hiddenVal;
  const pane = { style: {} };
  Object.defineProperty(pane, 'hidden', { set(v) { hiddenVal = v; }, get() { return hiddenVal; } });
  const $mock = (sel) => {
    if (sel === '#searchPane') return pane;
    if (sel === '#searchBox') return { hidden: false, getBoundingClientRect: () => ({ left: 120, right: 460, bottom: 44 }) };
    if (sel === '#btnTheme') return { hidden: false, getBoundingClientRect: () => ({ right: 560 }) };
    return null;
  };
  new Function('$', 'window', 'Esc', body + '\n pane.hidden = false;')(
    $mock, { innerWidth: 1000 }, { has: () => true, push: () => {} });
  ok(pane.style.left === '120px' && pane.style.top === '50px' && pane.style.width === '440px',
    '行为沙箱：面板左=搜索栏左缘120，宽=到明暗键右缘440，顶=栏下6px');
  delete global.document; delete global.window;
}
ok(/\.pop-search\s*\{[^}]*position: fixed/.test(C), 'CSS：.pop-search 改 fixed（不再撑宽布局）');

console.log('== 5. 视频框选压暗（框外暗、框内原样）==');
ok(/\.vs-sel-layer \{[^}]*background: transparent/.test(C), '层背景透明（框内不被垫暗）');
ok(/\.vs-sel-layer \{[^}]*overflow: hidden/.test(C), '层 overflow:hidden（阴影裁在画面内）');
ok(/\.vs-sel-box \{[^}]*background: transparent/.test(C), '选框背景透明 = 框内视频原样');
ok(/\.vs-sel-box \{[^}]*box-shadow: 0 0 0 9999px rgba\(0, 0, 0, 0\.55\)/.test(C), '选框大扩散阴影 = 框外压暗 55%');
ok(!/\.vs-sel-box \{[^}]*color-mix\(in srgb, var\(--accent\) 16%/.test(C), '旧的框内 16% 蓝色染色已移除');

console.log('== 6. README 记录 ==');
ok(/## 更新记录 · 4\.2\.1[4-9]/.test(README), 'README 有近期更新记录');
ok(/固定停在「全部」/.test(README) && /资料内笔记/.test(README) && /position: fixed/.test(README) && /压暗/.test(README), '四项修复都有记录');

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
