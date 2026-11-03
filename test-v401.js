/* test-v401.js —— v4.0 双链笔记：语法层 / 渲染层 / 索引挂接 / 静态接线
   跑法：node test-v401.js。全绿输出「PASS n FAIL 0」。 */
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

/* ---------- 沙箱基建 ---------- */
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

/* ===== 1. WikiLink 解析 ===== */
section('WikiLink 语法解析');
const W = (() => {
  const sb = baseSandbox({});
  loadFile(sb, 'js/wikilink.js');
  return sb.window.WikiLink;
})();

ok(!!W && typeof W.parseLinks === 'function', 'WikiLink 模块加载并导出 parseLinks');

let ls = W.parseLinks('详见 [[注意力机制]] 一节');
ok(ls.length === 1 && ls[0].target === '注意力机制' && ls[0].alias === '', '基本 [[目标]] 解析');

ls = W.parseLinks('[[注意力机制|self-attention]] 和 [[Transformer]]');
ok(ls.length === 2 && ls[0].alias === 'self-attention' && ls[1].target === 'Transformer', '别名 + 多链接');

ls = W.parseLinks('[[]] 和 [[  |别名]] 和 [[正常书]]');
ok(ls.length === 1 && ls[0].target === '正常书', '空目标 / 纯别名目标被丢弃');

ls = W.parseLinks('代码里 `[[-not-a-link-]]` 与 ```\n[[block]]\n``` 都不算');
ok(ls.length === 0, '行内代码 / 代码块里的 [[..]] 不算链接（索引与渲染同口径）');

ok(W.parseLinks('[[A]] [[b]] [[a]]').length === 3, '解析保留重复出现（去重是 distinctTargets 的事）');

/* ===== 2. 去重 / 归一化 / 排除自身 ===== */
section('distinctTargets 与归一化');
ok(JSON.stringify(W.distinctTargets('[[B]] [[b]] [[C]] [[B]]')) === JSON.stringify(['B', 'C']),
  '归一化去重（大小写不敏感、保序）');
ok(JSON.stringify(W.distinctTargets('[[自己]] [[别的书]]', '自己')) === JSON.stringify(['别的书']),
  'exclude 排除自链');
ok(JSON.stringify(W.distinctTargets('没有链接')) === '[]', '无链接 → 空数组');

/* ===== 3. 上下文摘录 ===== */
section('linkContexts 反链上下文');
{
  const text = '前文铺垫。这里说到 [[深度学习]] 的兴起，以及后续影响。第二次提到 [[深度学习|DL]] 在结尾。';
  const ctx = W.linkContexts(text, '深度学习', 20);
  ok(ctx.length === 2, '两处引用都摘到');
  ok(ctx[0].before === '前文铺垫。这里说到' && ctx[0].after.indexOf('的兴起') === 0, 'before/after 按宽度截取');
  ok(ctx[1].alias === 'DL', '别名上下文带 alias');
  ok(ctx[0].before.indexOf('[[') < 0 && ctx[0].after.indexOf(']]') < 0, '摘录里不含语法符号');
}
ok(W.linkContexts('[[别的书]]', '没有的书').length === 0, '无引用 → 空');

/* ===== 4. markdown 渲染层 ===== */
section('Markdown 双链渲染');
{
  const sb = baseSandbox({});
  /* markdown.js 用到词法全局 U —— 只需 escapeHtml，等价实现替代 */
  vm.runInContext('const U = { escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };', sb);
  loadFile(sb, 'js/markdown.js');
  /* const 声明不进 sandbox 对象 —— 显式取一次词法引用（v3.41 的老坑） */
  const MD = vm.runInContext('Markdown', sb);

  const html = MD.render('看 [[注意力机制]] 和 [[B|别名书]]，代码里 `[[不算]]`');
  ok(html.indexOf('<a class="wikilink"') > 0, '渲染成 a.wikilink');
  ok(html.indexOf('data-wtarget="注意力机制"') > 0, 'data-wtarget 带目标');
  ok(html.indexOf('>别名书</a>') > 0, '别名优先显示');
  ok(html.indexOf('href="javascript:void(0)"') > 0, '无真实 href（点击走委托）');
  ok(html.indexOf('<code>[[不算]]</code>') > 0, '行内代码里的 [[..]] 保持字面');

  const esc = MD.render('[[<script>alert(1)</script>]]');
  ok(esc.indexOf('<script>') < 0, '目标里的 HTML 被转义（无注入）');

  ok(MD.plain('[[A|别名]] 和 [[B]]') === '别名 和 B', 'plain() 双链留显示文字');
}

/* ===== 5. projection.js 索引挂接（静态） ===== */
section('Projection 出链索引 / 入链聚合（静态）');
{
  const P = read('js/projection.js');
  ok(P.indexOf('const WL = (typeof WikiLink') > 0, 'WikiLink 缺席时的安全替身');
  ok(P.indexOf('WL.distinctTargets(out.text, myTitle)') > 0, 'writeNow 从投影文本解析出链');
  ok(/manifest\[id\] = \{[\s\S]{0,400}?links: outLinks,/.test(P), 'manifest[id].links 落盘字段');
  ok(P.indexOf('JSON.stringify(prev.links) !== JSON.stringify(outLinks)') > 0,
    'hash 未变时也补齐老条目的 links 字段（升级自愈）');
  ok(/function ensureLinks\(rec\)/.test(P), '老条目惰性读盘补算');
  ok(/function backlinksOf\(title\)/.test(P) && /function wikiTitles\(exclude\)/.test(P) && /function idByTitle\(title\)/.test(P),
    'backlinksOf / wikiTitles / idByTitle 三查询齐备');
  ok(P.indexOf('backlinksOf,') > 0 && P.indexOf('wikiTitles,') > 0 && P.indexOf('idByTitle,') > 0, '三个查询已导出');
  ok(P.indexOf('WL.linkContexts(text, n)') > 0 && P.indexOf('names.indexOf(WL.normalize(WL.bookOf(t)))') > 0,
    '入链带上下文摘录（v4.2.1 按新名+别名逐个对账）');
}

/* ===== 6. index.html 挂载顺序 ===== */
section('index.html 挂载顺序');
{
  const html = read('index.html');
  const w = html.indexOf('js/wikilink.js');
  const p = html.indexOf('js/projection.js');
  ok(w > 0 && p > w, 'wikilink.js 在 projection.js 之前加载（词法全局依赖）');
}

/* ===== 7. app.js 跳转 / 委托 / 反链面板 / 补全注入（静态） ===== */
section('app.js 接线（静态）');
{
  const A = read('js/app.js');
  ok(/async function openWikiTarget\(target\)/.test(A), 'openWikiTarget 存在');
  ok(A.indexOf('Projection.idByTitle(split.book)') > 0, '跳转先走 manifest 书名对账（改名不断链）；v4.2 目标先拆书/笔记');
  ok(A.indexOf('Bridge.searchItems(split.book, 20)') > 0, '未投影的书走资料库搜索兜底');
  ok(A.indexOf("closest('a.wikilink')") > 0 && A.indexOf("getAttribute('data-wtarget')") > 0,
    '全局点击委托 .wikilink → data-wtarget');
  ok(A.indexOf('renderBacklinks(listEl)') > 0, '笔记列表挂反链面板');
  ok(A.indexOf('Projection.backlinksOf(currentBookTitle())') > 0, '反链数据源正确');
  ok((A.match(/wikiTitles: wikiTitlesOpt/g) || []).length >= 1, '编辑器注入补全数据源（v4.2.4 起只有大窗一个编辑器）');
  ok(A.indexOf('资料库里没有《') > 0, '跳不到时给出可读提示（不静默）');
}

/* ===== 8. 编辑器补全（静态） ===== */
section('NoteEditor [[ 补全（静态）');
{
  const E = read('js/editor.js');
  ok(E.indexOf('opts.wikiTitles') > 0, '补全数据源经 opts 注入（组件不依赖投影）');
  ok(E.indexOf("('\\[\\[([^\\[\\]\\n]*)$'") >= 0 || E.indexOf('\\[\\[([^\\[\\]\\n]*)$') > 0, '光标前 [[ 前缀触发检测');
  ok(E.indexOf('ne-wikipop') > 0 && E.indexOf('ne-wiki-item') > 0, '补全下拉 DOM');
  ok(E.indexOf("wikiPick(") > 0 && E.indexOf("'[[' + value + ']]'") > 0, '选中替换为 [[目标]]（v4.2 目标可为 书 或 书#笔记）');
  ok(/Escape[\s\S]{0,120}stopPropagation\(\)/.test(E), '补全的 ESC 只关下拉，不往全局 Esc 栈漏');
  ok(E.indexOf("wikiRows[wikiIdx]") > 0 && E.indexOf("'ArrowDown'") > 0, '↑↓ 键选择');
}

/* ===== 9. CSS ===== */
section('CSS');
{
  const C = read('css/app.css');
  ok(C.indexOf('a.wikilink {') > 0, 'wikilink 链接样式');
  ok(C.indexOf('.ne-wikipop {') > 0 && C.indexOf('.ne-wiki-item') > 0, '补全下拉样式');
  ok(C.indexOf('.bl-box {') > 0 && C.indexOf('.bl-item {') > 0, '反链面板样式');
}

/* ===== 10. 版本 ===== */
section('版本');
{
  const m1 = JSON.parse(read('manifest.json'));
  const m2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'EagleNoteWorkbench/manifest.json'), 'utf8'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '主插件三段式版本号，实际 ' + m1.version);
  ok(/^\d+\.\d+\.\d+$/.test(m2.version), '启动器三段式版本号，实际 ' + m2.version);
  const rd = read('README.md');
  ok(rd.indexOf('### 更新记录 · 4.') > 0, 'README 有 4.x 更新记录');
}

console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
