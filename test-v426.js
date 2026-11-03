#!/usr/bin/env node
/* v4.2.6 回归：改名闪灵 / 搜索框放大 / tab 蓝线对齐 / Esc 清空 /
   四项标签 / [[ 侧窗等高弹窗 / 空查询最近笔记 / 预览不失焦 overlay /
   工具栏对齐+视频 / 粘贴贴图 / 单击定位双击阅读 */
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
const MD = read('EaglePDFReader/js/markdown.js');
const WB = read('EagleNoteWorkbench/workbench.html');

console.log('== 1. 改名：闪灵笔记 / 闪灵面板 ==');
ok(read('EaglePDFReader/manifest.json').indexOf('"name": "闪灵笔记"') > 0, '主插件名 → 闪灵笔记');
ok(read('EagleNoteWorkbench/manifest.json').indexOf('"name": "闪灵面板"') > 0, '工作台名 → 闪灵面板');
ok(H.indexOf('<title>闪灵笔记</title>') > 0 && H.indexOf('Eagle 笔记管理') < 0, '主窗口标题与 UI 改名');
ok(WB.indexOf('闪灵面板') > 0 && WB.indexOf('笔记工作台') < 0, '工作台 UI 改名');

console.log('== 2. 笔记搜索框放大 ==');
ok(/\.note-search-row \.text-input \{[^}]*padding: 12px/.test(C), '搜索框与新建按钮一个量级');
ok(/\.note-search-row \.text-input:focus \{ border-color: var\(--accent\)/.test(C), '聚焦高亮');

console.log('== 3. 面板标签蓝线对齐 ==');
ok(/\.panel-tabs \{[^}]*justify-content: center/.test(C), '标签组居中');
ok(/\.panel-tab \{[^}]*flex: 0 0 auto/.test(C), '标签内容宽（蓝线 = 文字宽度）');

console.log('== 4. Esc 清空搜索 ==');
ok(A.indexOf('Esc 一律直接清空') > 0 && A.indexOf('noteSearch.layer -= 1') < 0, 'Esc 直接清空（不再逐层绕）');

console.log('== 5. 四项结果标签 ==');
ok(/\[0, '全部', all\.length\]/.test(A) && /\[1, '资料内笔记'/.test(A) && /\[2, '全局笔记'/.test(A) && /\[3, 'Eagle 数据库'/.test(A),
  '全部 / 资料内笔记 / 全局笔记 / Eagle 数据库 四项（v4.2.15 改名）');
ok(A.indexOf('const all = noteSearch.res[1].concat(noteSearch.res[2], l3)') > 0, '「全部」三层合流');

console.log('== 6. [[ 侧窗与整个弹窗等高 ==');
ok(E.indexOf("root.closest('.ov-card')") > 0 && E.indexOf('Math.min(box.height, window.innerHeight - 16)') > 0,
  '侧窗高度 = 笔记弹窗高度');

console.log('== 7. 空查询显示最近笔记 ==');
ok(A.indexOf('function renderRecentNotes()') > 0, 'renderRecentNotes');
ok(A.indexOf("if (input && !input.value.trim()) renderRecentNotes()") > 0, '空查询聚焦 → 最近笔记');
ok(/it\.addEventListener\('dblclick', \(\) => \{ openNoteReader\(n\); \}\);/.test(A), '最近笔记双击进阅读页');

console.log('== 8. 预览切换永不失焦 ==');
ok(/\.ne-body\.previewing \.ne-input \{[^}]*opacity: 0/.test(C) && !/\.ne-body\.previewing \.ne-input \{ display: none; \}/.test(C),
  'previewing 用 opacity 压底（display:none 会丢焦点）');
ok(/\.ne-body\.previewing \.ne-input \{[^}]*pointer-events: none/.test(C), '透明输入框不吃点击');
ok(E.indexOf('/* 预览态里打字不再切回编辑 —— 就让渲染层实时跟着变 */') > 0, '预览态打字实时渲染');
ok(E.indexOf('showEdit();   // v4.2.6：预览态里敲出 [[') > 0, '敲 [[ 自动回编辑态弹补全');
ok(E.indexOf('ta.addEventListener(\'paste\'') > 0 && E.indexOf('readAsDataURL') > 0, 'Ctrl+V 贴图（dataURL 内嵌，4MB 上限）');

console.log('== 9. 工具栏：对齐 + 视频 ==');
/* v4.2.7：对齐 / 视频按钮换 SVG 图标，按 data-md 键断言 */
ok(E.indexOf("['alignleft', svgIcon(ICONS.alignleft), '左对齐']") > 0 && E.indexOf("['aligncenter', svgIcon(ICONS.aligncenter), '居中']") > 0,
  '左中右对齐按钮（SVG 图标）');
ok(E.indexOf("wrap('<div style=\"text-align:center\">', '</div>', '居中内容')") > 0, '对齐写入 text-align div');
ok(E.indexOf("'插入视频（预览时变成可直接播放的窗口）'") > 0 && E.indexOf("@[视频](在这里粘贴视频链接或本地路径)") > 0,
  '视频链接按钮 + 模板');
ok(MD.indexOf('function videoTag') > 0 && MD.indexOf("open(' src=\"' + u + '\"'") > 0, 'markdown 渲染内嵌播放窗口');
ok(MD.indexOf('function safeSrc') > 0 && MD.indexOf('data:image\\/') > 0 && MD.indexOf('data:video\\/') > 0,
  '媒体地址白名单（仅 http/data/file/盘符，防注入）');

console.log('== 10. markdown 行为沙箱 ==');
try {
  let src = MD.replace(/try \{ window\.Markdown[\s\S]*?\} catch \(e\) \{[^}]*\}/, '');
  const Ux = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  const M = new Function('U', src + '\nreturn Markdown;')(Ux);
  ok(M.render('@[a](file:///d/x.mp4)').includes('<video'), '视频语法渲染 <video>');
  ok(M.render('![贴图](data:image/png;base64,AAA)').includes('<img'), 'dataURL 图片渲染');
  ok(M.render('<div style="text-align:center">**x**</div>').includes('<strong>'), '对齐块内行内语法递归渲染');
  ok(!M.render('![x](javascript:alert(1))').includes('<img'), 'javascript: 拒收');
  ok(M.render('![v](D:\\a b\\c.mp4)').includes('file:///D:/a%20b/c.mp4'), '带空格本地路径 → file:/// URL');
} catch (err) { ok(false, 'markdown 沙箱：' + err.message); }

console.log('== 11. 单击定位 / 双击阅读 ==');
ok(/clearTimeout\(card\._clickT\);[\s\S]{0,200}260\)/.test(A), '单击延时 260ms（区分双击）');
ok(A.indexOf("on('#notesList', 'dblclick'") > 0 && A.indexOf("on('#excerptList', 'dblclick'") > 0, '笔记/摘录双击 → 阅读页');
ok(A.indexOf('function openNoteReader(n)') > 0 && A.indexOf('function openAnnReader(ann)') > 0, '阅读页（笔记 / 摘录）');
ok(H.indexOf('id="nmRead"') > 0 && H.indexOf('id="btnNmEdit"') > 0, '弹窗阅读区 + 编辑按钮');
ok(A.indexOf('on(\'#btnNmEdit\', \'click\'') > 0, '阅读页「✎ 编辑」→ 进编辑器');
ok(A.indexOf('readerPartsReset();          // v4.2.6：阅读页态也要还原成编辑器态') > 0, '关弹窗还原阅读态');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
