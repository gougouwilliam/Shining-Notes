/* v4.2.17 回归：框选笔记不进 PDF 阅读区 + 代码巡检
   覆盖：
   1) annotations.js 渲染 area 时不再内嵌 .ann-tag（笔记前 16 字不画进阅读区）；
   2) 悬停提示 showTip 仍能看笔记（内容没丢，只是不常驻画面）；
   3) app.js 不再有 onNoteSearchKey（死代码清除），noteSearchSwallowEnter 仍在；
   4) viewer.css 不再有 .ann-tag；窗口 resize 时搜索面板重定位监听存在；
   5) 双 manifest 版本一致；README 版本行 + 更新记录。
*/
const fs = require('fs');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const A = fs.readFileSync('EaglePDFReader/js/app.js', 'utf8');
const ANN = fs.readFileSync('EaglePDFReader/js/annotations.js', 'utf8');
const CSS = fs.readFileSync('EaglePDFReader/css/viewer.css', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('\n[v4.2.17] 框选笔记不进阅读区');

/* 1) area 渲染分支：不再 append ann-tag（先剥注释再查，v4.2.17 注释里会提到旧名） */
const areaIdx = ANN.indexOf("} else if (ann.type === 'area')");
const areaSegRaw = ANN.slice(areaIdx, ANN.indexOf("} else if (ann.type === 'note')"));
const areaSeg = areaSegRaw.replace(/\/\*[\s\S]*?\*\//g, '');
ok(areaIdx > 0, 'area 渲染分支存在');
ok(areaSeg.indexOf('ann-tag') === -1, 'area 分支不再内嵌 .ann-tag（笔记不画进阅读区）');
ok(areaSeg.indexOf("'--area-color'") > 0 && areaSeg.indexOf("class: 'ann-area'") > 0, '框选标记本身照常渲染');

/* 2) showTip 仍在：笔记内容走悬停提示 */
ok(/showTip\(ann, anchor\)/.test(ANN) && /ann\.note \|\| ann\.text/.test(ANN),
  '悬停提示保留（ann.note 优先展示）');

/* 3) 死代码清除 + 活代码保留 */
ok(A.indexOf('onNoteSearchKey') === -1, 'onNoteSearchKey 死代码已删');
ok(/function noteSearchSwallowEnter/.test(A) && /on\('#noteSearch', 'keydown', noteSearchSwallowEnter\)/.test(A),
  'noteSearchSwallowEnter 仍挂载（typing 态 Enter 只有人认领才不会漏给宿主）');

/* 4) 样式与重定位 */
ok(CSS.indexOf('.ann-tag') === -1, 'viewer.css 的 .ann-tag 死样式已删');
ok(A.indexOf('.ann-tag') === -1, 'app.js 无 ann-tag 残留');
ok(/addEventListener\('resize'[\s\S]{0,160}showSearchPane\(\)/.test(A.replace(/\n/g, ' ')),
  '窗口 resize 时搜索面板重定位监听存在');
ok(/v4\.2\.17：窗口缩放时已打开的结果面板跟着重定位/.test(A), '重定位监听带 v4.2.17 注释锚点');

/* 5) 行为沙箱：area 渲染（有笔记的框选也不出标签，无笔记的一样出标记） */
{
  const seg = areaSeg;
  const hasTagCond = /ann\.note/.test(seg.replace(/\/\*[\s\S]*?\*\//g, ''));
  ok(!hasTagCond, '行为：area 渲染代码路径与 ann.note 无关（有笔记无笔记渲染一致）');
}

/* 6) 版本与文档 */
ok(/^\s*"version": "\d+\.\d+\.\d+"/m.test(MFEST) && /^\s*"version": "\d+\.\d+\.\d+"/m.test(WFEST), '双 manifest 版本三段式');
ok((MFEST.match(/"version":\s*"([^"]+)"/) || [])[1] === (WFEST.match(/"version":\s*"([^"]+)"/) || [])[1], '双 manifest 版本一致');
ok(/当前版本 \*\*4\.2\.17\*\*/.test(README) && /## 更新记录 · 4\.2\.17/.test(README), 'README 版本行 + 4.2.17 记录');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
