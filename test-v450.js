#!/usr/bin/env node
/* test-v450.js —— v4.5.0 OB 同步三件事（行为级回归）
 *
 * 用户三条要求：
 *   ① 绝对同步：插件里摘录/笔记的增、删、改，OB 端无条件及时反映；
 *      OB 端只做阅读与文字修改，改完要回流，且不能被插件的后台轮询打断。
 *   ② OB 里点双链要落到「对应那一条笔记」，而不是只打开整个 md 文件。
 *   ③ OB 里的浏览排版美化、层次清晰。
 *
 * 本套件全部跑真实代码：projection.js / wikilink.js 用 vm 加载完整模块，
 * writeNow / syncExternal 跑真实临时文件系统；app.js / editor.js 做静态接线断言。
 * 运行：node test-v450.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }
const PJ = read('EaglePDFReader/js/projection.js');
const WJ = read('EaglePDFReader/js/wikilink.js');
const APP = read('EaglePDFReader/js/app.js');
const EDITOR = read('EaglePDFReader/js/editor.js');

function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h ^ str.charCodeAt(i)) * 16777619) >>> 0;
  return h.toString(36);
}

/* ---------- 通用沙箱 ---------- */
function loadProjection(extra) {
  const mem = {};
  const sandbox = {
    require: (n) => require(n),
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; }
    },
    Buffer, console, Date, JSON, Math, setTimeout, clearTimeout,
    U: {
      stripExt: (n) => String(n || '').replace(/\.[a-z0-9]+$/i, ''),
      hashKey: hashKey
    },
    Store: {
      docKey: (m) => (m && m.itemId) || 'k',
      getIndex: () => ({ docs: {} }),
      readDocByKey: () => null,
      normalize: (r) => r
    },
    window: {}
  };
  Object.assign(sandbox, extra || {});
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WJ, sandbox, { filename: 'wikilink.js' });
  vm.runInContext(PJ, sandbox, { filename: 'projection.js' });
  return { P: sandbox.window.Projection, WL: sandbox.window.WikiLink, S: sandbox };
}

const META = {
  itemId: 'MVTDGADDYYDCN',
  name: 'C7动脉瘤夹闭——祝向东主任 浙二医院.mp4',
  ext: 'mp4',
  libraryName: 'DY - Clinical Surgery',
  tags: ['B站'],
  filePath: 'E:/DY/x.mp4'
};
function mkData() {
  return {
    itemId: 'MVTDGADDYYDCN',
    fileName: META.name,
    annotations: [
      { id: 'anmw3n7j3aob0ek', type: 'shot', color: 'yellow', t: 6, note: 'TEST一下截图笔记功能' },
      { id: 'anmw3onh50wv3j9', type: 'area', color: 'yellow', t: 10, t1: 34,
        text: '手术入路采用的就是额外侧手术入路。', note: '测试一下框选下的笔记功能\n## 这里有个二级标题' }
    ],
    notes: [
      { id: 'ntmw3n7vh6mdzg6', md: 'test一下直接做笔记的功能' },
      { id: 'ntmw3n7313m0jmc', md: '**AI 总结**\n# 一句话总结\nANGEL-TNK 研究…\n## 核心要点\n- 第一条' }
    ]
  };
}

console.log('—— ① 双链语法：块锚点 ——');
{
  const W = require('./EaglePDFReader/js/wikilink.js');
  const s = W.splitTarget('C7动脉瘤夹闭#^eaglenote-ex-anmw3n7j3aob0ek');
  ok(s.book === 'C7动脉瘤夹闭' && s.note === '' && s.anchor === 'eaglenote-ex-anmw3n7j3aob0ek',
    '[[书#^块ID]] 拆成 book / anchor（note 为空）');
  const old = W.splitTarget('书名#测试一下框选下的笔记功能');
  ok(old.note === '测试一下框选下的笔记功能' && old.anchor === '',
    '旧 [[书#标题]] 照常解析，零回归');
  ok(W.splitTarget('书名').anchor === '' && W.splitTarget('书名').note === '', '书级链接不变');
  const links = W.parseLinks('见 [[书#^eaglenote-nt-abc|测试一下引用功能]] 与 [[别的书]]');
  ok(links.length === 2 && links[0].target === '书#^eaglenote-nt-abc' && links[0].alias === '测试一下引用功能',
    '带别名的块链接能被 parseLinks 解析');
  ok(W.bookOf('书#^eaglenote-nt-abc') === '书', 'bookOf 对块链接仍只取书名段（反链/出链对账不回归）');
  ok(W.anchorTarget('书', 'eaglenote-nt-abc') === '书#^eaglenote-nt-abc', 'anchorTarget 生成合法目标');
  ok(W.safeAnchor('^eaglenote-nt-a_b') === 'eaglenote-nt-a-b', 'safeAnchor 清掉 OB 不认的字符');
}

console.log('—— ② 投影：每条摘录/笔记都有唯一稳定块 ID ——');
let env = null, built = null;
{
  env = loadProjection();
  const P = env.P;
  built = P.build(META, mkData());
  const md = built.text;
  const refs = md.match(/\^eaglenote-(?:ex|nt)-[A-Za-z0-9-]+/g) || [];
  ok(refs.length === 4, '2 条摘录 + 2 条笔记 → 4 个块 ID（一条不漏）');
  ok(new Set(refs).size === refs.length, '同一篇里块 ID 全部唯一（重名笔记也不会跳错）');
  ok(refs.every((r) => /^\^eaglenote-(ex|nt)-[A-Za-z0-9-]+$/.test(r)),
    '块 ID 只含 OB 允许的字符，不含中文/空格/下划线');
  /* 用户现场痛点：摘录下的批注以前没有标题头，[[书#标题]] 只能跳到文件 */
  ok(md.indexOf('^eaglenote-ex-anmw3onh50wv3j9') >= 0,
    '★ 摘录批注「测试一下框选下的笔记功能」也有块 ID（旧版只有独立笔记有标题）');
  ok(/###\s+②\s+00:10–00:34[^\n]*\^eaglenote-ex-anmw3onh50wv3j9/.test(md),
    '块 ID 挂在该条自己的标题行上（不是文末孤零零一行）');
  ok(built.anchors.length === 4 &&
    built.anchors.filter((a) => a.k === 'ex').length === 2 &&
    built.anchors.filter((a) => a.k === 'nt').length === 2,
    'manifest 锚点索引覆盖 ex / nt 两类');
  ok(built.anchors[0].a === 'eaglenote-ex-anmw3n7j3aob0ek',
    '锚点索引里的 ID 与 md 中写的完全一致（补全/插入不会指错）');

  /* 稳定性：改标题、两条同名，块 ID 都不变 */
  const changed = mkData();
  changed.notes[0].md = '完全换掉的第一行';
  changed.notes[1].md = '完全换掉的第一行';   // 故意重名
  const built2 = P.build(META, changed);
  ok(built2.anchors[2].a === built.anchors[2].a && built2.anchors[3].a === built.anchors[3].a,
    '改笔记标题后块 ID 不变（链接不会因改名而断）');
  ok(built2.anchors[2].a !== built2.anchors[3].a, '两条同名笔记仍各有独立块 ID');
}

console.log('—— ③ OB 排版美化 ——');
{
  const md = built.text;
  ok(/^> \[!info\]- 关于这篇笔记/m.test(md), '顶部说明收成折叠 callout，默认只占一行');
  ok(/## 摘录 · 2 条/.test(md) && /## 笔记 · 2 条/.test(md), '区块标题带条数');
  ok((md.match(/^---$/gm) || []).length >= 4, 'frontmatter / 区块之间有分隔线');
  ok(/> \[!note\] 批注/.test(md), '批注升级成 callout（不再是一行 **笔记**）');
  ok(/> \[!quote\]- 原文 · 框选 · 黄/.test(md), '原文 callout 标题带类型与颜色');
  ok(!/^\^eaglenote-/m.test(md), '块 ID 全挂在标题行上，没有孤立的 ^ID 行');
  ok(/\|420\]\('/.test(PJ), '图片用 Obsidian 宽度语法 |420（不认的编辑器退化为普通图片，绝不裂链）');
  ok(/^\\# 一句话总结$/m.test(md) && /^\\## 核心要点$/m.test(md),
    '正文里的 # / ## 转义成普通文本，不再污染 OB 大纲');
  ok(/^synced: /m.test(md) && /L\.push\('generator: '/.test(PJ),
    'frontmatter 带最后同步时间；生成器版本在真环境写入');
  ok(/## 附 · Eagle 注释（双向同步）/.test(md) && /> \[!tip\]-/.test(md),
    'Eagle 注释节明确标注为回写通道并附折叠说明');
}

console.log('—— ④ 回读：新格式往返 + 旧格式兼容 + 转义无损 ——');
{
  const P = env.P;
  const d = mkData();
  const blocks = P.parseBlocks(built.text);
  let allOk = true;
  d.annotations.forEach((a) => {
    const got = P.noteOfEx(blocks.ex[P.anchorId(a.id, 'ex0')]);
    if (got !== a.note.trim()) { allOk = false; console.log('    ex mismatch:', JSON.stringify(got)); }
  });
  ok(allOk, '新格式：每条摘录批注读回 = 存储原文（一字不差）');
  allOk = true;
  d.notes.forEach((n) => {
    const got = P.bodyOfNt(blocks.nt[P.anchorId(n.id, 'nt0')], n.md.split('\n')[0].trim());
    if (got !== n.md.trim()) { allOk = false; console.log('    nt mismatch:', JSON.stringify(got)); }
  });
  ok(allOk, '新格式：每条笔记读回 = 存储 md（含被转义的 # 标题，全部还原）');
  ok(P.noteOfEx('### p.2\n\n**笔记**\n\n旧格式批注\n') === '旧格式批注',
    'v4.4 旧格式 **笔记** 仍能读回（磁盘存量 md 升级不丢手改）');
  ok(P.bodyOfNt('### 独立笔记\n#### 老标题\n\n旧正文\n', '老标题') === '老标题\n旧正文',
    'v4.4 旧格式 ### + #### 标题头仍能读回');
  ok(P.noteOfEx('### ① 00:06 ^eaglenote-ex-a\n\n> [!note] 批注\n> 用户在 OB 里删掉了反斜杠\n> # 一句话总结\n') ===
    '用户在 OB 里删掉了反斜杠\n# 一句话总结',
    '用户在 OB 里手删转义符也不丢内容（转义变换无损）');
  ok(P.noteOfEx('> [!quote]- 原文\n> 引用一行\n') === null,
    '没有批注的摘录块不会被误读成批注（不制造假改动）');
}

console.log('—— ⑤ 绝对同步：真实文件系统的增 / 改 / 删 ——');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v450-'));
  const merged = [];
  const E = loadProjection({
    Store: {
      docKey: (m) => (m && m.itemId) || 'k',
      getIndex: () => ({ docs: { MVTDGADDYYDCN: {} } }),
      readDocByKey: () => null,
      normalize: (r) => r
    }
  });
  const P = E.P;
  P.setRoot(tmp);
  P.setHooks({
    onExternal: (meta, data, edits) => { P.applyEdits(edits); merged.push(edits.length); },
    onMerged: () => {}
  });
  const d = mkData();

  const r1 = P.writeNow(META, d, false);
  const f = r1.file;
  ok(r1.ok && !!f && fs.existsSync(f), '插件首轮写入生成 md');
  const md1 = fs.readFileSync(f, 'utf8');
  ok(md1.indexOf('^eaglenote-ex-anmw3onh50wv3j9') >= 0, 'md 里真的写出了块 ID');

  /* 改：批注文字变了 → OB 端立刻反映 */
  d.annotations[1].note = '测试一下框选下的笔记功能（已改）';
  P.writeNow(META, d, false);
  const md2 = fs.readFileSync(f, 'utf8');
  ok(md2.indexOf('（已改）') >= 0, '★ 插件改文字 → OB md 同步更新');

  /* 增：新增一条笔记 → OB 端多一个块 */
  d.notes.push({ id: 'ntmw3new0001', md: '新增的一条笔记' });
  P.writeNow(META, d, false);
  const md3 = fs.readFileSync(f, 'utf8');
  ok(md3.indexOf('^eaglenote-nt-ntmw3new0001') >= 0 && /## 笔记 · 3 条/.test(md3),
    '★ 插件新增笔记 → OB md 多出对应块且计数同步');

  /* 删：删掉那条笔记 → OB 端块消失，不留残影 */
  d.notes.pop();
  P.writeNow(META, d, false);
  const md4 = fs.readFileSync(f, 'utf8');
  ok(md4.indexOf('^eaglenote-nt-ntmw3new0001') < 0 && /## 笔记 · 2 条/.test(md4),
    '★ 插件删除笔记 → OB md 对应块彻底消失');

  /* 正文没变不重写：不能让 OB 里的编辑被外部刷新打断 */
  const before = fs.readFileSync(f, 'utf8');
  const r5 = P.writeNow(META, d, false);
  ok(!!r5.skipped && fs.readFileSync(f, 'utf8') === before,
    '正文指纹判重：内容没变一个字节都不写（frontmatter 时间戳不再触发空转）');
  ok(/const bodyStart = L\.length/.test(PJ) && /prev\.bodyKey === out\.bodyKey/.test(PJ),
    '判重走 bodyKey 而不是全文 hash（源层确认）');

  /* OB 手改 → 回流 JSON，且不重写 md（3s 轮询不打断编辑） */
  const handText = md4.replace('测试一下框选下的笔记功能（已改）', '我在 OB 里手改的批注');
  fs.writeFileSync(f, handText, 'utf8');
  fs.utimesSync(f, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  /* 必须返回同一个对象：onExternal 的 edits.ref 直接指向它，applyEdits 才改得到 d */
  E.S.Store.readDocByKey = () => d;
  const r6 = P.syncExternal();
  ok(fs.readFileSync(f, 'utf8') === handText,
    '★ OB 手改后回读只吸收、绝不重写文件（不会打断正在打字）');
  ok(d.annotations[1].note === '我在 OB 里手改的批注',
    '★ OB 手改的文字回流到权威 JSON');
  ok(r6.changed >= 1 && merged.length >= 1, 'onExternal 合并钩子被真实触发');
  const r7 = P.syncExternal();
  ok(r7.changed === 0, '认领到磁盘当前版本后不重复合并（无回读风暴）');

  /* 插件随后再改 → 把 OB 的手改一起写进规范排版 */
  d.notes[0].md = 'test一下直接做笔记的功能（二次修改）';
  P.writeNow(META, d, false);
  const md5 = fs.readFileSync(f, 'utf8');
  ok(md5.indexOf('我在 OB 里手改的批注') >= 0 && md5.indexOf('（二次修改）') >= 0,
    '★ 插件后续改动把 OB 手改一并带上，两边绝不互相覆盖');
  try { P.flush(); } catch (e) { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('—— ⑥ 同步时效 / 生命周期接线 ——');
{
  const E2 = loadProjection();
  ok(E2.P.WRITE_DELAY === 700, '打字防抖 0.7s（不再等 2.6s）');
  ok(/}, 3000\);/.test(APP) && /Projection\.syncExternal\(\)/.test(APP), '回读轮询 3s');
  ok(/startProjSync\._rebuildKick[\s\S]{0,400}Projection\.rebuildAll\(false\)/.test(APP),
    '启动 3s 后单次全量对账（插件没开时的变化也补齐）');
  ok((APP.match(/Projection\.flush\(\)/g) || []).length >= 3,
    '退出 / beforeunload / pagehide 三处都 flush 掉待写投影');
  const syncSrc = PJ.slice(PJ.indexOf('function syncExternal'), PJ.indexOf('function rebuildAll'));
  ok(!/writeNow\(/.test(syncSrc) && /rec\.hash = curHash/.test(syncSrc),
    'syncExternal 只吸收不重写（源层确认）');
  ok(/proj\.write/.test(PJ) && /proj\.rebuild/.test(APP), '同步审计日志在位，现场可确认');
}

console.log('—— ⑦ 候选 / 跳转链路 ——');
{
  ok(/function wikiVal\(node, t, a\)/.test(EDITOR) && /node\.book \+ '#\^' \+ anchor \+ '\|'/.test(EDITOR),
    '[[ 补全插入写 [[书#^块ID|显示名]]');
  ok(/noteAnchors/.test(EDITOR) && /noteAnchors/.test(PJ), '候选树与编辑器共用并行锚点表');
  ok(/Projection\.titleByAnchor\(split\.anchor\)/.test(APP),
    '插件里点块链接先把 ID 翻成笔记标题再定位');
  ok(/function titleByAnchor\(a\)/.test(PJ), '投影层提供块 ID → 标题反查');
  /* 顺序一致性：wikiTree 生成的 notes 与 noteAnchors 同索引 */
  const E3 = loadProjection();
  const P3 = E3.P;
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'v450t-'));
  P3.setRoot(tmp3);
  P3.writeNow(META, mkData(), false);
  const tree = P3.wikiTree('别的书');
  const node = tree.find((x) => x.book && x.book.indexOf('C7动脉瘤') === 0);
  ok(!!node && Array.isArray(node.noteAnchors) && node.noteAnchors.length === node.notes.length,
    'wikiTree 的 notes 与 noteAnchors 一一对应（editor.js 按同索引取值不会错位）');
  ok(!!node && node.noteAnchors.some((a) => /^eaglenote-/.test(a)),
    '候选里真的带上了稳定块 ID');
  ok(P3.titleByAnchor('eaglenote-ex-anmw3onh50wv3j9').title === '测试一下框选下的笔记功能',
    'titleByAnchor 能把摘录批注的块 ID 翻回可读标题');
  ok(P3.titleByAnchor('^eaglenote-nt-ntmw3n7vh6mdzg6').title === 'test一下直接做笔记的功能',
    '带 ^ 前缀也能反查；独立笔记同样命中');
  ok(P3.titleByAnchor('不存在') === null, '未知块 ID 返回 null，不误跳');
  try { P3.flush(); } catch (e) { /* ignore */ }
  fs.rmSync(tmp3, { recursive: true, force: true });
}

console.log('—— ⑧ 红线：零窗口 API ——');
{
  const changed = ['EaglePDFReader/js/projection.js', 'EaglePDFReader/js/wikilink.js',
    'EaglePDFReader/js/editor.js', 'EaglePDFReader/js/markdown.js'].map(read).join('\n');
  ok(!/BrowserWindow|\.destroy\(|\.close\(|remote\.getCurrentWindow/.test(changed),
    '本次改动的四个语法/投影/编辑器文件里没有任何窗口生命周期 API');
  ok(/IPC_WINDOW_DENY/.test(read('EaglePDFReader/js/bridge.js')), 'bridge.js 的窗口 IPC 硬拦截仍在');
}

console.log('\n========================================');
console.log('PASS ' + pass + '  FAIL ' + fail);
console.log('========================================');
if (fail) process.exit(1);
