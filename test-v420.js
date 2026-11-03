/* test-v420.js —— v4.2 双链笔记级引用 + 补全层级选择器 + shell 误开修复
   跑法：node test-v420.js。全绿输出「PASS n FAIL 0」。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, 'EaglePDFReader');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n[' + t + ']'); }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function memStore() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}
function baseSandbox(extra) {
  const sb = {
    console, Date, JSON, Math, setTimeout, clearTimeout, TextDecoder, Event,
    localStorage: memStore(),
    fetch: () => Promise.reject(new Error('no fetch in test')),
    window: {}
  };
  Object.assign(sb, extra || {});
  sb.global = sb;
  vm.createContext(sb);
  return sb;
}
function loadFile(sb, rel) {
  vm.runInContext(read(rel), sb, { filename: rel });
}

/* ===== 1. WikiLink 笔记级语法层 ===== */
section('WikiLink v4.2：splitTarget / bookOf / noteTitle');
const W = (() => {
  const sb = baseSandbox({});
  loadFile(sb, 'js/wikilink.js');
  return sb.window.WikiLink;
})();

ok(!!W && typeof W.splitTarget === 'function' && typeof W.noteTitle === 'function', 'v4.2 新接口已导出');

{
  const s = W.splitTarget('书名#笔记标题');
  ok(s.book === '书名' && s.note === '笔记标题', '[[书#笔记]] 拆成书名与笔记');
  const s2 = W.splitTarget('只有书');
  ok(s2.book === '只有书' && s2.note === '', '无 # → note 为空（文档级）');
  const s3 = W.splitTarget('书#笔#记');
  ok(s3.book === '书' && s3.note === '笔#记', '第一个 # 之后全算笔记标题');
  ok(W.splitTarget('  书 # 笔记 ').book === '书' && W.splitTarget('  书 # 笔记 ').note === '笔记', '拆分时去首尾空格');
  ok(W.bookOf('书#笔记') === '书', 'bookOf 取书名段');
}

{
  ok(W.noteTitle('# 标题行\n第二行') === '标题行', 'noteTitle 取第一行并剥标题记号');
  ok(W.noteTitle('**加粗** 开头') === '加粗 开头', '剥强调记号');
  ok(W.noteTitle('> 引用一句') === '引用一句', '剥引用记号');
  ok(W.noteTitle('带 [[某书]] 的行') === '带 某书 的行', '剥双链语法壳保留文字');
  ok(W.noteTitle('[链接文字](http://x) 后文') === '链接文字 后文', '剥 md 链接留文字');
  ok(W.noteTitle('   \n\n第二行才是正文') === '第二行才是正文', '跳过开头空行');
  ok(W.noteTitle('x'.repeat(100)).length === 60 && W.noteTitle('x'.repeat(100)).endsWith('…'), '超 60 字截断加省略号');
  ok(W.noteTitle('') === '' && W.noteTitle(null) === '', '空输入 → 空标题');
}

{
  /* 笔记级链接也算指向书（反链上下文） */
  const ctx = W.linkContexts('重点是 [[深度学习#反向传播]] 这一节', '深度学习', 20);
  ok(ctx.length === 1 && ctx[0].alias === '深度学习#反向传播', 'linkContexts 按书名段匹配笔记级链接');
  const raw = W.distinctTargets('[[B#n1]] [[B#n2]] [[B]]');
  ok(JSON.stringify(raw) === JSON.stringify(['B#n1', 'B#n2', 'B']), 'distinctTargets 保留笔记级目标原文');
}

/* ===== 2. Markdown 渲染 ===== */
section('Markdown 笔记级双链渲染');
{
  const sb = baseSandbox({});
  vm.runInContext('const U = { escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };', sb);
  loadFile(sb, 'js/markdown.js');
  const MD = vm.runInContext('Markdown', sb);

  const html = MD.render('见 [[深度学习#反向传播]] 一节');
  ok(html.indexOf('data-wtarget="深度学习#反向传播"') > 0, 'data-wtarget 保留完整 书#笔记 目标');
  ok(html.indexOf('深度学习 › 反向传播</a>') > 0, '无别名时显示「书 › 笔记」');
  ok(html.indexOf('的笔记「反向传播」') > 0, '悬浮提示注明目标笔记');

  const html2 = MD.render('[[深度学习#反向传播|简称]]');
  ok(html2.indexOf('>简称</a>') > 0, '别名优先显示');

  ok(MD.plain('[[A|别名]] 和 [[B#n]]') === '别名 和 B#n', 'plain() 笔记级链接留目标文字');
}

/* ===== 3. projection.js 笔记级索引（静态） ===== */
section('Projection v4.2（静态）');
{
  const P = read('js/projection.js');
  ok(/WL\.noteTitle\(a\.note\)/.test(P) && /WL\.noteTitle\(n\.md\)/.test(P),
    'writeNow 从摘录批注与自由笔记收标题');
  ok(/nt: noteTitles,/.test(P), 'manifest[id].nt 落盘字段');
  ok(P.indexOf('JSON.stringify(prev.nt) !== JSON.stringify(noteTitles)') > 0,
    'hash 未变时也补齐老条目的 nt 字段（升级自愈）');
  ok((P.match(/wikiCache = null/g) || []).length >= 2, '写盘后与补齐后都使补全缓存失效');
  ok(P.indexOf('WL.normalize(WL.bookOf(t))') > 0, 'backlinksOf 按书名段对账（笔记级链接也算反链）');
  ok(/function wikiTree\(exclude\)/.test(P) && /function applyWikiExclude/.test(P) && /function noteTitlesFromStore/.test(P),
    'wikiTree / applyWikiExclude / Store 惰性回填齐备');
  ok(P.indexOf('wikiTree,') > 0, 'wikiTree 已导出');
  ok(P.indexOf('15') > 0 && /Date\.now\(\) - wikiCache\.at < 15000/.test(P), '补全树 15s 缓存');
  ok(P.indexOf("splitTarget: (t) =>") > 0 && P.indexOf('noteTitle: () =>') > 0, 'WL 替身补齐 v4.2 接口');
  ok(/\.filter\(\(t\) => WL\.normalize\(t\.book\) !== nEx \|\| \(t\.notes && t\.notes\.length\)\)/.test(P),
    '当前书：书级候选排除、有笔记时保留（笔记互链）');
}

/* ===== 4. editor.js 层级选择器（静态） ===== */
section('Editor 层级补全选择器（静态）');
{
  const E = read('js/editor.js');
  ok(E.indexOf('opts.wikiTree') > 0, '数据源优先用 opts.wikiTree');
  ok(E.indexOf('opts.wikiTitles') > 0, '老接口 wikiTitles 作兜底');
  ok(/const WIKI_CAP = \d+/.test(E), '候选行数封顶常量');
  ok(E.indexOf('ne-wiki-group') > 0 && E.indexOf('ne-wiki-more') > 0 && /sub: true/.test(E),
    '分组行 / 截断提示 / 笔记缩进项齐备');
  ok(/let wikiAll = \[\]/.test(E) && /let wikiRows = \[\]/.test(E), '渲染行与导航行分离（分组不参与键盘导航）');
  ok(/q\.indexOf\('#'\)/.test(E), '查询支持 书#笔记 两级');
  ok(E.indexOf("node.book + '#' + t") > 0, '选中笔记级候选写入 [[书#笔记]]');
  ok(E.indexOf("wikiRows[wikiIdx].value") > 0, 'Enter/Tab 取当前行的 value');
  ok(E.indexOf("node.self") > 0, '当前书标记 self（书级候选排除）');
}

/* ===== 5. app.js 接线（静态） ===== */
section('app.js v4.2 接线（静态）');
{
  const A = read('js/app.js');
  ok(/function locateNoteByTitle\(title\)/.test(A), 'locateNoteByTitle 笔记定位函数');
  ok(A.indexOf('WikiLink.splitTarget') > 0, '跳转前先拆 书/笔记');
  ok((A.match(/if \(split\.note\) locateNoteByTitle\(split\.note\)/g) || []).length === 2,
    'manifest 命中与搜索兜底两条路都会定位笔记');
  ok(A.indexOf("switchTab('notes')") > 0 && A.indexOf('scrollIntoView') > 0, '定位 = 切笔记页 + 滚进视野');
  ok(A.indexOf('wikiTree: wikiTreeOpt') > 0, '编辑器注入层级候选');
  ok((A.match(/wikiTree: wikiTreeOpt/g) || []).length >= 1, '编辑器注入（v4.2.4 起只有大窗一个编辑器）');
  ok(A.indexOf('b.id !== state.item.id') > 0, '反链面板过滤自身（笔记级自链不算反链）');
  ok(A.indexOf("contains('wikilink')") > 0, '#panel 外链委托跳过双链（v4.1.1 红条修复）');
}

/* ===== 6. bridge.js openExternal 防呆（静态） ===== */
section('bridge openExternal 防呆（静态）');
{
  const B = read('js/bridge.js');
  ok(/\/\^\(https\?|mailto\):\/i\.test\(url\)/.test(B), '只放行 http/https/mailto（js: 之类不再进 shell）');
}

/* ===== 7. CSS ===== */
section('CSS（静态）');
{
  const C = read('css/app.css');
  ok(/\.ne-wiki-list \{[^}]*max-height: 260px/.test(C), '补全列表限高 260px 内部滚动（v4.2.2 搜索框钉顶）');
  ok(/\.ne-wiki-group \{/.test(C) && /\.ne-wiki-item\.sub \{/.test(C) && /\.ne-wiki-more \{/.test(C),
    '分组行 / 缩进项 / 截断提示样式齐备');
  ok(/\.pop-subs \{ width: 320px/.test(C), '字幕弹窗收窄到 320px');
}

console.log('\nPASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
