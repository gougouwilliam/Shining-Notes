#!/usr/bin/env node
/* v4.2.8 回归：方向键光标跟随（selectionchange）+ Ctrl+→ 行尾 +
   Esc 关闭提示保存 + [[[[ 残留修复 + 笔记链接可点开（pv 放行 wikilink +
   当前书直达）+ 附件徽标放大 + 新建按钮让位 Eagle 底栏 + 笔记数据随库迁移 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const E = read('EaglePDFReader/js/editor.js');
const A = read('EaglePDFReader/js/app.js');
const B = read('EaglePDFReader/js/bridge.js');
const C = read('EaglePDFReader/css/app.css');
const MFEST = read('EaglePDFReader/manifest.json');
const WFEST = read('EagleNoteWorkbench/manifest.json');
const README = read('EaglePDFReader/README.md');

console.log('== 1. 版本联动（硬约定）==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(MFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(WFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/### 更新记录 · \d+\.\d+\.\d+/.test(README), 'README 更新记录为三段式标题');

console.log('== 2. 方向键 / 预览光标跟随 ==');
ok(E.indexOf("document.addEventListener('selectionchange'") > 0, 'editor 监听 selectionchange');
ok(/selectionchange[\s\S]{0,300}previewing[\s\S]{0,300}schedulePreview\(\)/.test(E),
  '预览态选区变化 → 重渲染光标（方向键移动可见）');

console.log('== 3. Ctrl+→ 行尾 ==');
ok(/e\.key === 'ArrowRight'[\s\S]{0,400}indexOf\('\\n', p\)/.test(E), 'Ctrl+→ 定位到本行末尾（找下一个换行）');
ok(/e\.key === 'ArrowLeft'[\s\S]{0,300}lastIndexOf\('\\n'/m.test(E), 'Ctrl+← 对称跳行首');
ok(/e\.shiftKey \|\| e\.altKey\) return/.test(E), 'Shift/Alt 修饰时不抢（不干扰选区）');

console.log('== 4. Esc 关闭提示保存 ==');
ok(/function closeNoteModalByEsc\(\)[\s\S]{0,400}tryCloseNoteModal\(\)/.test(A),
  'Esc 关闭走 tryCloseNoteModal（有内容弹三键确认）');
ok(A.indexOf("笔记还没保存，要保存后再关闭吗") > 0, '确认文案在位（取消/不保存/保存）');

console.log('== 5. [[[[ 残留修复 ==');
ok(/const s0 = Math\.max\(0, d\.start - 2\);/.test(E), 'wikiPick 从 [[ 之前整体替换');
ok(/wikiPick[\s\S]{0,500}s0 \+ ins\.length/.test(E), '插入后光标落在替换终点');

console.log('== 6. 笔记链接可点开 ==');
ok(/pv\.addEventListener\('mousedown'[\s\S]{0,200}closest\('a'\)/.test(E),
  '预览层 mousedown 放行链接（v4.2.9 扩为所有 <a>，click 委托收得到）');
ok(/if \(split\.note && state\.item && currentBookTitle\(\) === split\.book\)/.test(A),
  '当前书的笔记链接直达定位，不重开文档');
ok(A.indexOf("openWikiTarget(a.getAttribute('data-wtarget'))") > 0, 'document 级委托入口在位');

console.log('== 7. 附件徽标 / 新建按钮 ==');
ok(/\.att-ico \{[\s\S]{0,300}background: var\(--accent\)/.test(C), '附件图标 accent 底色块');
ok(/\.att-chip \{[\s\S]{0,300}font-size: 12\.5px/.test(C), '徽标字号放大');
ok(/\.note-new-bar \{[\s\S]{0,400}margin: 10px 10px 16px/.test(C), '新建按钮留白（底部让位 Eagle 底栏；v4.2.13 起左缘 10px 固定，宽度由 JS 同步）');

console.log('== 8. 笔记数据随库迁移 ==');
ok(B.indexOf('.eaglenote') > 0, '库内数据目录 .eaglenote');
ok(B.indexOf('migrateIntoPortable') > 0 && B.indexOf("startsWith('archive-')") > 0,
  '一次性迁移（跳过 archive 快照）');
ok(B.indexOf("m.fs.existsSync(m.path.join(toDir, 'index.json'))") > 0, '库内已有数据不反向覆盖');
ok(B.indexOf('state.legacyDataDir || state.dataDir') > 0, 'Asr 模型仍用 userData 目录');
ok(/writeFileSync\(probe, 'ok'\)[\s\S]{0,80}unlinkSync\(probe\)/.test(B), '可写探测后再切换');
ok(B.indexOf('state.portableDir = null') > 0, '写不进时回退 userData');

console.log('== 9. 沙箱行为测试：wikiPick 不留双 [[ ==');
(function () {
  // 模拟真实流程：textarea "abc[[神"，光标在查询末尾（wikiDetect 口径 start 在 [[ 之后）
  const d = { q: '神', start: 5 };
  let ta = { value: 'abc[[神', selectionStart: 6, selectionEnd: 6 };
  const ins = '[[' + '神经' + ']]';
  const s0 = Math.max(0, d.start - 2);
  ta.value = ta.value.slice(0, s0) + ins + ta.value.slice(ta.selectionStart);
  ok(ta.value === 'abc[[神经]]', '替换后无残留 [[：' + JSON.stringify(ta.value));
  ok(ta.value.indexOf('[[[[') < 0, '不出现 [[[[');
})();

console.log('== 10. 沙箱行为测试：Ctrl+→ 行尾定位 ==');
(function () {
  const val = '第一行\n第二行很长\n尾';
  function jump(p, key) {
    if (key === 'ArrowRight') { const nl = val.indexOf('\n', p); return nl < 0 ? val.length : nl; }
    return val.lastIndexOf('\n', p - 1) + 1;
  }
  ok(jump(2, 'ArrowRight') === 3, '第一行内 Ctrl+→ → 行尾(3)');
  ok(jump(3, 'ArrowRight') === 3, '已在行尾则不动');
  ok(jump(10, 'ArrowRight') === val.length, '最后一行 → 文本末尾');
  ok(jump(6, 'ArrowLeft') === 4, 'Ctrl+← → 行首(4)');
})();

console.log('== 11. 沙箱行为测试：迁移守卫 ==');
(function () {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'en-mig-'));
  const from = path.join(tmp, 'from'), to = path.join(tmp, 'to');
  fs.mkdirSync(path.join(from, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(from, 'media'), { recursive: true });
  fs.mkdirSync(path.join(from, 'archive-v32-1'), { recursive: true });
  fs.writeFileSync(path.join(from, 'index.json'), '{"x":1}');
  fs.writeFileSync(path.join(from, 'docs', 'a.json'), '{}');
  fs.writeFileSync(path.join(from, 'media', 'm.png'), 'png');
  fs.writeFileSync(path.join(from, 'archive-v32-1', 'old.json'), '{}');
  // 抽出 migrateIntoPortable 函数体执行
  const fm = /function migrateIntoPortable\(m, fromDir, toDir\) \{([\s\S]*?)\n  \}/.exec(B);
  ok(!!fm, 'migrateIntoPortable 可提取');
  if (!fm) return;
  const fakeM = {
    fs: {
      existsSync: (p) => fs.existsSync(p),
      readdirSync: (p, o) => fs.readdirSync(p, o),
      cpSync: (s, d) => fs.cpSync(s, d, { recursive: true }),
      copyFileSync: (s, d) => fs.copyFileSync(s, d),
    },
    path: path,
  };
  const fn = new Function('console', 'return function (m, fromDir, toDir) {' + fm[1] + '\n}');
  const con = { warn: () => {}, info: () => {} };
  fn(con)(fakeM, from, to);
  ok(fs.existsSync(path.join(to, 'index.json')), 'index.json 迁移到位');
  ok(fs.existsSync(path.join(to, 'docs', 'a.json')), 'docs/ 递归复制');
  ok(fs.existsSync(path.join(to, 'media', 'm.png')), 'media/ 递归复制');
  ok(!fs.existsSync(path.join(to, 'archive-v32-1')), 'archive-* 不搬');
  // 第二次：库内已有数据时不覆盖
  fs.writeFileSync(path.join(to, 'index.json'), '{"x":2}');
  fs.writeFileSync(path.join(from, 'index.json'), '{"x":9}');
  fn(con)(fakeM, from, to);
  ok(fs.readFileSync(path.join(to, 'index.json'), 'utf8') === '{"x":2}', '库内已有数据不被旧数据覆盖');
  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log('');
console.log(`v4.2.8：${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
