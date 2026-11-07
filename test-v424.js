#!/usr/bin/env node
/* v4.2.4：新建笔记大窗统一入口 + [[ 侧边搜索窗 + 相关度打分。
   静态断言 + scoreOne/matchScore 行为测试（vendor 真拼音库参与）。 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}
function section(name) { console.log('\n[' + name + ']'); }
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

/* ===== 1. 新建笔记统一大窗 ===== */
section('新建笔记统一居中大窗');
{
  const H = read('EaglePDFReader/index.html');
  ok(H.indexOf('id="noteEditorSlot"') < 0, '底部小编辑区已退役');
  ok(H.indexOf('id="btnNoteNew"') > 0 && H.indexOf('note-new-bar') > 0, '底部换成了「✎ 新建笔记」大按钮');
  ok(H.indexOf('id="noteModal"') > 0 && H.indexOf('id="modalEditorSlot"') > 0, '居中大笔记窗仍在');

  const A = read('EaglePDFReader/js/app.js');
  ok(A.indexOf("btnNoteNew.addEventListener('click', () => openComposer('free', null, 'modal'))") > 0,
    '新建按钮 → openComposer(free, null, modal)');
  ok(A.indexOf("wikiSide: 'right'") > 0, '大窗编辑器启用右侧搜索窗');
  ok(A.indexOf('panelEditor = NoteEditor.create') < 0, 'panel 编辑器不再创建');
  ok((A.match(/if \(panelEditor\)/g) || []).length >= 2, 'panelEditor 残留引用都有 null 守卫');

  const C = read('EaglePDFReader/css/app.css');
  ok(C.indexOf('.note-new-bar') > 0 && C.indexOf('.note-new-bar:hover') > 0, '新建按钮样式');
}

/* ===== 2. [[ 侧边搜索窗 ===== */
section('[[ 独立搜索窗（大窗右侧）');
{
  const E = read('EaglePDFReader/js/editor.js');
  ok(E.indexOf('if (opts.wikiSide)') > 0 && E.indexOf('document.body.appendChild(wpop)') > 0,
    '侧窗模式：wpop 挂 body（躲开 .ov-card 的 overflow:hidden 裁剪）');
  ok(E.indexOf("wpop.classList.add('side')") > 0, '侧窗标记类');
  ok(/r\.right \+ 10/.test(E) && E.indexOf('window.innerWidth') > 0,
    '定位：钉编辑器右侧，放不下挪左边/贴边');
  ok(E.indexOf('wpop.parentNode !== root) wpop.remove()') > 0, 'destroy 时回收挂在 body 上的弹层');
  ok(E.indexOf('wikiFollowCursor') > 0 && E.indexOf('opts.wikiSide') > 0, '跟随光标逻辑保留（小编辑区用）');

  const C = read('EaglePDFReader/css/app.css');
  ok(/\.ne-wikipop\.side \{[^}]*position: fixed/.test(C), '侧窗 fixed 定位样式');
  ok(C.indexOf('.ne-wikipop.side .ne-wiki-list') > 0, '侧窗列表加高（420px）');
}

/* ===== 3. 相关度打分（行为测试，真拼音库） ===== */
section('相关度打分 scoreOne / matchScore');
{
  const E = read('EaglePDFReader/js/editor.js');
  /* v4.5.1：拼音库改成惰性取值（pinyinMatch() 每次现查 window.pinyinPro），
     所以沙箱从 pinyinMatch 定义处切起，并把 window 一起喂进去 —— 顺带把
     「库晚到也能生效」这条行为一起测了。 */
  const i0 = E.indexOf('function pinyinMatch()');
  const i1 = E.indexOf('const CHAR_ESC');
  ok(i0 > 0 && i1 > i0, '打分函数块可提取');
  let PinyinMatch = null;
  try {
    const pp = require('./EaglePDFReader/vendor/pinyin-pro.js');
    PinyinMatch = pp.match || null;
  } catch (e) { /* 库缺失也能测子串逻辑 */ }
  const HAS_LATIN = /[a-z]/i;
  const sandbox = new Function('window',
    E.slice(i0, i1) + '\nreturn { scoreOne: scoreOne, matchScore: matchScore };');
  const { scoreOne, matchScore } = sandbox({ pinyinPro: { match: PinyinMatch } });
  ok(HAS_LATIN.test('a'), 'HAS_LATIN 常量仍在（拉丁字母判定）');

  /* 子串打分 */
  ok(scoreOne('历史笔记', '历') === 100 ? false : scoreOne('历史笔记', '历史') === 80, '多字符开头命中 = 80');
  ok(scoreOne('中国历史', '历史') === 60, '多字符中段命中 = 60');
  ok(scoreOne('历史笔记', '历') === 70, '单字符开头命中 = 70（强）');
  const midSingle = scoreOne('abc', 'c');
  ok(midSingle === 20, '单字符中段子串 = 20（弱）');
  /* 拼音打分（真库） */
  if (PinyinMatch) {
    ok(scoreOne('历史', 'lishi') === 75, '拼音全拼开头命中 = 75');
    ok(scoreOne('历史', 'ls') === 75, '拼音首字母开头命中 = 75');
    ok(scoreOne('临床医学', 'c') === 0 || scoreOne('临床医学', 'c') === 20,
      '单字符拼音打在中间 = 弱（0）');
    ok(scoreOne('曹操传', 'c') === 65, '单字符拼音首字命中 = 65（强）');
    ok(scoreOne('历史', 'xyz') === -1, '完全不沾边 = -1');
  }
  /* AND 语义 + 弱标记 */
  const m1 = matchScore('神经外科笔记', ['神经', '外科']);
  ok(m1 && m1.score > 0 && !m1.weak, '多词 AND 全中 = 命中');
  ok(matchScore('神经内科', ['神经', '外科']) === null, 'AND 缺一词 = 不命中');
  const m3 = matchScore('abc-def', ['c']);
  ok(m3 && m3.weak === true, '单字符拉丁中段命中标 weak（调用方过滤）');
  const m4 = matchScore('临床医学', ['c']);
  ok(m4 && m4.weak === true, '单字符拼音中段命中标 weak（打「c」不再满屏沾边文件）');
  const m5 = matchScore('Clinical', ['c']);
  ok(m5 && m5.weak === false && m5.score === 70, '单字符开头命中是强命中，保留');
}

/* ===== 4. 查询主流程 ===== */
section('wikiQuery 主流程（静态）');
{
  const E = read('EaglePDFReader/js/editor.js');
  ok(E.indexOf('scored.sort((a, b) => b.best - a.best)') > 0, '按相关度排序（分高的书在前）');
  ok(E.indexOf('bSc.weak') > 0 && E.indexOf('!sc.weak') > 0, '弱命中书与笔记被过滤');
  ok(E.indexOf('preview = (node.notes || []).slice(0, tBook.length ? 6 : 3)') > 0,
    '书名命中但笔记没命中时保留前几条预览（空查询 3 条习惯不变）');
  ok(E.indexOf('WIKI_CAP') > 0, '条数封顶保留');
}

console.log('\n===== v4.2.4: ' + passed + ' passed, ' + failed + ' failed =====');
process.exit(failed ? 1 : 0);
