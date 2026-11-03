/* v4.2.14 回归：页签 Esc 蓝圈根治（点完页签交还焦点）+ 笔记搜索默认「全部」 */
const fs = require('fs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL - ' + msg); }
}

const A = fs.readFileSync('EaglePDFReader/js/app.js', 'utf8');
const C = fs.readFileSync('EaglePDFReader/css/app.css', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('== 1. 版本联动（硬约定）==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(MFEST.split('\n').find(l => l.includes('"version"'))), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(WFEST.split('\n').find(l => l.includes('"version"'))), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/## 更新记录 · \d+\.\d+\.\d+/.test(README), 'README 更新记录为三段式标题');
ok(/"version": "\d+\.\d+\.\d+"/.test(MFEST) && /"version": "\d+\.\d+\.\d+"/.test(WFEST), '本轮发版版本号三段式（双 manifest 一致，不随版本号追改）');

console.log('== 2. 页签蓝圈根治 ==');
/* 提取页签 click 绑定做行为沙箱 */
const m = /onAll\('#panelTabs \.panel-tab', 'click', \(e\) => \{([\s\S]*?)\n    \}\);/.exec(A);
ok(!!m, '页签 click 绑定可提取');
if (m) {
  const body = m[1];
  ok(body.includes('switchTab(e.currentTarget.dataset.tab)'), '切页逻辑保留');
  ok(body.includes('blur()'), '点完页签交还焦点（blur）');
  /* 行为沙箱：click 后 blur 被调用 */
  let switched = 0, blurred = 0;
  const ev = {
    currentTarget: {
      dataset: { tab: 'notes' },
      blur() { blurred++; },
    },
  };
  new Function('e', 'switchTab', body)(ev, () => { switched++; });
  ok(switched === 1 && blurred === 1, '行为沙箱：一次 click = 一次切页 + 一次 blur');
}
ok(/\.panel-tabs button:focus-visible \{/.test(C), '键盘 Tab 的焦点圈保留（:focus-visible 规则未删）');
ok(/onAll\('#panelTabs \.panel-tab', 'click', \(e\) => switchTab/.test(A) === false, '旧的「切页不留焦点管理」单行绑定已替换');

console.log('== 3. 笔记搜索默认「全部」==');
ok(/layer: 0,\s*\/\/ v4\.2\.14：默认「全部」/.test(A), 'noteSearch.layer 默认 0（全部）');
ok(/noteSearch\.layer = 0;\s*\/\/ v4\.2\.14：重置回「全部」/.test(A), 'noteSearchReset 重置回 0');
ok(/\[\[0, '全部', all\.length\]/.test(A), '结果标签「全部」仍为首项（layer 0 对应全部）');
/* 行为沙箱：搜索→清空→层回 0 */
(function () {
  const body = /function noteSearchReset\(\) \{([\s\S]*?)\n  \}/.exec(A)[1];
  const ns = { res: null, layer: 3 };
  new Function('noteSearch', body)(ns);
  ok(ns.layer === 0 && ns.res && ns.res[1].length === 0, '行为沙箱：reset 后 layer=0 且结果清空');
})();

console.log('== 4. README 记录 ==');
ok(/## 更新记录 · 4\.2\.14/.test(README), 'README 有 4.2.14 更新记录');
ok(/蓝色框体/.test(README) && /「全部」/.test(README), '两项修复都有记录');

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
