/* v4.2.13 回归：Enter 不再漏给宿主 + 新建按钮与笔记卡片严格对齐 */
const fs = require('fs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL - ' + msg); }
}

const E = fs.readFileSync('EaglePDFReader/js/editor.js', 'utf8');
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

console.log('== 2. 笔记正文 Enter 整键吞掉（不漏宿主）==');
ok(/普通 Enter 在这里整个吞掉/.test(E), '编辑器有 plain-Enter 吞键处理（v4.2.13 注释在位）');
/* 提取吞键 handler 做行为沙箱 */
const fm = /ta\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Enter' \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;([\s\S]*?)\n    \}\);/.exec(E);
ok(!!fm, '吞键 handler 可提取');
if (fm) {
  const body = fm[0];
  ok(body.includes('isComposing') && body.includes('229'), '输入法选词的 Enter 让给输入法');
  ok(body.includes("wpop && !wpop.hidden") , '[[ 补全弹窗开着时让 wikiKey 先认领');
  ok(body.includes('e.preventDefault()') && body.includes('e.stopPropagation()'), 'preventDefault + stopPropagation 双保险（与 Esc/Delete 同一套吞键模式）');
  /* 行为沙箱：手工换行 + 光标 + input 事件 */
  const impl = /const s = ta\.selectionStart[\s\S]*?dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);/.exec(body);
  ok(!!impl, '换行手工补（preventDefault 杀默认行为后不丢换行）');
  if (impl) {
    let val = 'abcd', sPos = 2, ePos = 2, cursor = null;
    const calls = [];
    const ta = {
      get value() { return val; }, set value(v) { val = v; },
      get selectionStart() { return sPos; }, set selectionStart(v) { sPos = v; cursor = v; },
      get selectionEnd() { return ePos; }, set selectionEnd(v) { ePos = v; },
      dispatchEvent(ev) { calls.push(ev.type + (ev.bubbles ? ':bubbles' : '')); },
    };
    new Function('ta', 'Event', impl[0])(ta, function (t, o) { this.type = t; this.bubbles = o.bubbles; });
    ok(val === 'ab\ncd' && cursor === 3, 'Enter 在光标处插入换行且光标移到新行');
    ok(calls.indexOf('input:bubbles') >= 0, '手工换行后派发 input（预览调度/落盘防抖照常）');
  }
  ok(!/if \(e\.key !== 'Enter'[^]*?e\.shiftKey/.test(fm[0]), 'Shift+Enter 与普通 Enter 同路径（均为换行）');
}

console.log('== 3. 其他 Enter 入口同样堵上 ==');
ok(/function noteSearchSwallowEnter/.test(A), '笔记搜索框 Enter 有专属吞键函数');
ok(/on\('#noteSearch', 'keydown', noteSearchSwallowEnter\)/.test(A), '笔记搜索框绑定吞键');
ok(/e\.stopPropagation\(\);\s*\n\s*\}\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(e\.key === 'ArrowDown'/.test(E) || /空结果[\s\S]{0,200}stopPropagation/.test(E), '[[ 弹窗空结果分支 Enter 也 stopPropagation');
ok(!/if \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp' \|\| e\.key === 'Enter' \|\| e\.key === 'Tab'\) e\.preventDefault\(\);\s*\n\s*return;/.test(E), '旧的「只 preventDefault 不 stopPropagation」写法已移除');
/* Ctrl+Enter 保存 / wikiKey 确认不受影响 */
ok(/k === 'enter'/.test(E) || /"enter"/.test(E), 'Ctrl+Enter 保存路径保留');
ok(/else if \(e\.key === 'Enter' \|\| e\.key === 'Tab'\) \{\s*e\.preventDefault\(\); e\.stopPropagation\(\);\s*wikiPick/.test(E), '[[ 补全 Enter 确认路径保留');

console.log('== 4. 新建按钮与笔记卡片严格对齐 ==');
ok(/function syncNoteNewWidth/.test(A), 'app.js 有 syncNoteNewWidth');
ok(/syncNoteNewWidth\(listEl\);/.test(A), 'renderNotes 渲染时同步按钮宽度');
ok(/addEventListener\('resize'[\s\S]{0,200}syncNoteNewWidth/.test(A), '窗口缩放时跟随同步');
ok(/if \(!w\) return;/ .test(A), '面板隐藏（clientWidth=0）时不把按钮写成 0 宽');
ok(/margin: 10px 10px 16px;/.test(C), 'margin 不再 auto 居中（左缘与卡片重合）');
ok(!/margin: 10px auto 16px;/.test(C), '旧居中写法已移除');
const wBody = (/  function syncNoteNewWidth\(listEl\) \{([\s\S]*?)\n  \}/.exec(A) || [])[1];
ok(!!wBody, 'syncNoteNewWidth 函数体可提取');
if (wBody) {
  const el = { style: {} };
  new Function('$', 'listEl', wBody)(function (id) { return id === '#btnNoteNew' ? el : null; }, { clientWidth: 316 });
  ok(el.style.width === '296px', '行为沙箱：列表 clientWidth 316 → 按钮宽 296px（两侧各 10px 内边距）');
  const hidden = { style: {} };
  new Function('$', 'listEl', wBody)(function () { return hidden; }, { clientWidth: 0 });
  ok(!hidden.style.width, '行为沙箱：clientWidth=0（面板隐藏）不写宽度');
}
ok(/v4\.2\.13/.test(C), 'CSS 注释标注 v4.2.13');

console.log('== 5. README 记录 ==');
ok(/## 更新记录 · 4\.2\.13/.test(README), 'README 有 4.2.13 更新记录');
ok(/用默认软件打开/.test(README) && /严格对齐/.test(README), '两项修复都有记录');

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
