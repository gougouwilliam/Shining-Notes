#!/usr/bin/env node
/* v4.2.5 回归：新建按钮醒目化 / 预览同窗切换 / [[ 侧窗等高 /
   「还有 N 条」展开按钮 / 笔记栏顶部三层搜索 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = read('EaglePDFReader/index.html');
const E = read('EaglePDFReader/js/editor.js');
const A = read('EaglePDFReader/js/app.js');
const C = read('EaglePDFReader/css/app.css');

console.log('== 1. 新建笔记按钮蓝底白字 ==');
ok(C.indexOf('.note-new-bar') > 0 && /background: var\(--accent\);/.test(C.slice(C.indexOf('.note-new-bar'), C.indexOf('.note-new-bar') + 600)),
  '新建按钮蓝底（accent 实心）');
ok(/\.note-new-bar \{[^}]*color: #fff/.test(C), '白字');
ok(!/1\.5px dashed var\(--border-strong\)[^}]*\n\.note-new-bar/.test(C), '虚线幽灵样式退役');

console.log('== 2. Markdown 预览同窗切换 ==');
ok(E.indexOf("body.classList.add('editing')") > 0, '默认编辑态');
ok(/function showEdit\(\)/.test(E) && /function showPreview\(\)/.test(E), 'showEdit / showPreview 双态函数');
ok(E.indexOf('pvTimer = setTimeout') > 0 && E.indexOf(', 800)') > 0, '停手 800ms 自动切渲染');
ok(E.indexOf("pv.addEventListener('mousedown'") > 0, '点渲染区返回编辑');
ok(/\.ne-body\.previewing \.ne-preview \{/.test(C) && /\.ne-body\.previewing \.ne-input \{[^}]*opacity: 0/.test(C),
  'CSS：预览态显示渲染层、输入框透明压底（v4.2.6 改为不失焦 overlay）');
ok(/\.modal-editor \.ne-input \{ height: 340px; \}/.test(C), '弹窗输入框加高（原左右双栏 300px）');
ok(!/\.modal-editor \.ne-body \{ flex-direction: row; \}/.test(C), '左右双栏布局退役');
ok(/content: "✎ 点击返回编辑"/.test(C), '渲染态底部提示');
ok((E.match(/showEdit\(\);/g) || []).length >= 6, '工具栏插入 / setValue / clear / focus 都先回编辑态');
ok(E.indexOf('if (wpop && !wpop.hidden) return;') > 0, '[[ 补全开着时不切预览');

console.log('== 3. [[ 侧窗与输入窗等高 ==');
ok(E.indexOf('Math.min(box.height, window.innerHeight - 16)') > 0, '弹层高度 = 笔记弹窗高度（v4.2.6 加大）');
ok(E.indexOf('wpop.style.top = Math.max(8, box.top)') > 0, '顶对齐弹窗');
ok(/\.ne-wikipop\.side \{ display: flex; flex-direction: column; \}/.test(C), '侧窗纵向弹性布局');
ok(/\.ne-wikipop\.side \.ne-wiki-list \{ flex: 1; min-height: 0; max-height: none; \}/.test(C), '列表吃满剩余空间');

console.log('== 4. 「还有 N 条」→ 展开按钮 ==');
ok(E.indexOf('ne-wiki-more-btn') > 0 && E.indexOf('点击展开全部') > 0, '展开按钮（原来是不许点的提示行）');
ok(E.indexOf('let wikiExpand = false') > 0 && E.indexOf('wikiExpand = true') > 0, '展开态维护');
ok(E.indexOf('if (d.q !== wikiLastQ) { wikiExpand = false;') > 0, '换查询自动收回展开态');
ok(/const cap = wikiExpand \? rows\.length : WIKI_CAP/.test(E), '展开后不封顶');
ok(/'共 ' \+ wikiTotal \+ ' 条结果/.test(E), '按钮显示总命中数');

console.log('== 5. 打分函数模块级 + 导出（笔记栏搜索复用）==');
ok((E.match(/function scoreOne/g) || []).length === 1, 'scoreOne 只定义一次（提到模块级）');
ok(E.indexOf('matchScore: matchScore') > 0, 'NoteEditor.matchScore 导出');

console.log('== 6. 笔记栏顶部三层搜索 ==');
ok(H.indexOf('id="noteSearch"') > 0 && H.indexOf('btnNoteSearchClear') > 0, '搜索框 + 清空键');
ok(A.indexOf('noteSearchLayer1') > 0 && A.indexOf('noteSearchLayer2') > 0 && A.indexOf('noteSearchLayer3') > 0,
  '三层搜索函数（资料内 / 全局笔记 / Eagle 数据库）');
ok(A.indexOf('NoteEditor.matchScore') > 0, '复用 [[ 补全同一套相关度打分');
/* v4.2.17：noteSearch 自己的 keydown 收不到 Esc（全局捕获层 stopPropagation），
   清空由全局 Escape 分支统一处理 —— 断言锚点换到全局层 */
ok(A.indexOf('noteSearch.layer -= 1') < 0 && /e\.target\.id === 'noteSearch'[\s\S]{0,120}noteSearchClear\(\)/.test(A),
  'Esc 直接清空（v4.2.6 取消逐层绕；v4.2.17 起由全局捕获层承担）');
/* v4.2.15：自动选层下线 —— 永远停在「全部」，用户要求默认第一屏就是合流结果 */
ok(/noteSearch\.layer = 0;/.test(A) && !/noteSearch\.layer = noteSearch\.res/.test(A),
  '搜索后固定停「全部」（v4.2.15 自动选层已删）');
ok(A.indexOf("Bridge.listLibraryItems(['pdf', 'mp4', 'mkv', 'mov', 'avi', 'webm']") > 0, '第三层扫 Eagle 全库');
ok(A.indexOf('600000') > 0, '库清单 10 分钟缓存（不每次输入都全库扫）');
ok(A.indexOf("openWikiTarget(r.book + '#' + r.note)") > 0, '全局笔记结果点击直接跳书定位笔记');
ok(A.indexOf('ns-tabs') > 0 && A.indexOf('ns-tab') > 0 && C.indexOf('.ns-tab.active') > 0, '层标签 UI 可手动切换');
ok(/if \(noteSearch\.q\.trim\(\)\) \{ noteSearchClear\(\); \}/.test(A), '换文档自动清搜索（旧结果不残留）');

console.log('== 7. 打分行为回归（模块搬家后语义不变）==');
/* 与 test-v424 相同的提取方式：SEP_CHARS → CHAR_ESC 之间是 scoreOne + matchScore */
try {
  /* v4.5.1：pinyin-pro 改为空闲加载，editor.js 里是惰性取值 pinyinMatch()，
     所以切块起点跟到 pinyinMatch 定义处，并把 window 喂进沙箱。 */
  const i0 = E.indexOf('function pinyinMatch()');
  const i1 = E.indexOf('const CHAR_ESC');
  const pp = require('./EaglePDFReader/vendor/pinyin-pro.js');
  const f = new Function('window', E.slice(i0, i1) + '\nreturn { scoreOne, matchScore };');
  const { scoreOne, matchScore } = f({ pinyinPro: { match: pp.match || pp.default } });
  ok(scoreOne('历史', '历史') === 80, '全文子串开头命中 = 80');
  ok(scoreOne('历史', 'lishi') === 75, '拼音全拼开头命中 = 75');
  ok(matchScore('撒哈拉的故事', ['sa']) && !matchScore('撒哈拉的故事', ['sa']).weak, '拼音「sa」搜「撒」强命中');
  const w = matchScore('Clinical', ['c']);
  ok(w && w.weak === false && w.score === 70, '单字符开头命中是强命中（70）');
} catch (err) {
  ok(false, '打分行为沙箱执行：' + err.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
