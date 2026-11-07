/* test-v423.js —— v4.2.3 修弹窗自冒 + 拼音搜索 + 空态提示 + 全库候选与改名断链
   跑法：node test-v423.js。全绿输出「PASS n FAIL 0」。 */
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

/* ===== 1. 修：弹窗随笔记栏自冒（hidden 初始化） ===== */
section('弹窗 hidden 初始化（静态）');
{
  const E = read('js/editor.js');
  ok(/const wpop = el\('div', 'ne-wikipop'\);[\s\S]{0,900}wpop\.hidden = true;/.test(E),
    'wpop 创建后立刻 hidden（重构时丢掉的那行回来了）');
}

/* ===== 2. 拼音搜索 ===== */
section('拼音搜索（静态 + vendor 真跑）');
{
  const E = read('js/editor.js');
  ok(E.indexOf('window.pinyinPro') > 0 && /function scoreOne\(hay, token\)/.test(E),
    'scoreOne：子串不中且带拉丁字母时走拼音匹配（v4.2.4 改打分制）');
  ok(/HAS_LATIN = \/\[a-z\]\/i/.test(E), '纯中文词跳过拼音匹配（性能）');
  ok(/function matchScore\(hay, tokens\)/.test(E) && E.indexOf('if (sc < 0) return null') > 0,
    '多关键词 AND 语义保留（打分制）');
  ok(E.indexOf('CHAR_ESC') > 0 && /marks\[i \+ k\] = true/.test(E) && /pm\(s, t\)/.test(E),
    '高亮按下标合并（拼音命中的字也能亮）');
  ok(E.indexOf('支持拼音') > 0, '搜索框占位文案标注拼音能力');

  const H = read('index.html');
  /* v4.5.1：pinyin-pro 不再阻塞首屏，改由 js/vendorload.js 空闲加载。
     断言换成「不能是同步 script + 必须挂进懒加载清单」，语义（编辑器之前就绪）不变。 */
  const VL = read('js/vendorload.js');
  ok(H.indexOf('js/vendorload.js') > 0 && H.indexOf('<script src="vendor/pinyin-pro.js"') < 0,
    'index.html 不再同步加载 pinyin-pro（v4.5.1 懒加载）');
  ok(VL.indexOf('vendor/pinyin-pro.js') > 0 && VL.indexOf('window.pinyinPro') > 0,
    'vendorload 负责按需加载 pinyin-pro，并就绪后自动生效');
  ok(fs.existsSync(path.join(ROOT, 'vendor', 'pinyin-pro.js')), 'vendor/pinyin-pro.js 存在');

  /* vendor 库真跑一遍（就是插件里那份文件） */
  const py = require(path.join(ROOT, 'vendor', 'pinyin-pro.js'));
  ok(Array.isArray(py.match('撒旦', 'sa')), '全拼：sa → 撒');
  ok(Array.isArray(py.match('历史', 'ls')), '首字母：ls → 历史');
  ok(Array.isArray(py.match('历史笔记', 'biji')), '全拼多字：biji → 笔记');
  ok(Array.isArray(py.match('历史笔记', '笔记')), '中文子串照常命中');
  ok(py.match('历史', 'xyz') === null, '不相关词不硬凑');
}

/* ===== 3. 空态提示 ===== */
section('空态提示（静态）');
{
  const E = read('js/editor.js');
  ok(/ne-wiki-empty/.test(E) && E.indexOf('换个关键词试试') > 0,
    '没搜到显示空态行而不是收弹层');
  ok(/if \(!wikiRows\.length\) \{\s*\n\s*if \(e\.key === 'ArrowDown'/.test(E),
    '空结果时方向键/回车不动作（不会把提示行当候选、不会插出 [[]]）');
  ok(/if \(!d\) \{ wikiClose\(\); return; \}/.test(E),
    '不在 [[ 模式才真关弹层');
  const C = read('css/app.css');
  ok(/\.ne-wiki-empty \{/.test(C), '空态行样式');
}

/* ===== 4. 全库候选 + 改名不断链（动态沙箱） ===== */
section('全库索引 libSync（动态）');
const U_STUB = 'const U = { stripExt: (s) => String(s||"").replace(/\\.[a-z0-9]+$/i, ""), hashKey: (s) => { let h = 5381; const t = String(s||""); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return "h" + h.toString(16); }, toast: () => {}, el: () => ({}) };';
{
  const files = {};
  const dirs = new Set();
  const norm = (p) => String(p).replace(/\//g, '\\');
  const memfs = {
    existsSync: (p) => { const k = norm(p); return Object.prototype.hasOwnProperty.call(files, k) || dirs.has(k.replace(/[\\/]+$/, '')); },
    statSync: (p) => { const k = norm(p); if (!Object.prototype.hasOwnProperty.call(files, k)) throw new Error('ENOENT'); return { size: files[k].length, mtimeMs: 0, isDirectory: () => false }; },
    readFileSync: (p) => { const k = norm(p); if (!Object.prototype.hasOwnProperty.call(files, k)) throw new Error('ENOENT'); return files[k]; },
    writeFileSync: (p, c) => { const k = norm(p); files[k] = typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); const i = k.lastIndexOf('\\'); if (i > 0) dirs.add(k.slice(0, i)); },
    renameSync: (a, b) => { const ka = norm(a), kb = norm(b); files[kb] = files[ka]; delete files[ka]; },
    unlinkSync: (p) => { const k = norm(p); if (!Object.prototype.hasOwnProperty.call(files, k)) throw new Error('ENOENT'); delete files[k]; },
    copyFileSync: (a, b) => { const ka = norm(a), kb = norm(b); files[kb] = files[ka]; },
    mkdirSync: (p) => { dirs.add(norm(p).replace(/[\\/]+$/, '')); },
    readdirSync: (p) => { const k = norm(p).replace(/[\\/]+$/, ''); const pre = k + '\\'; const out = new Set(); Object.keys(files).forEach((f) => { if (f.indexOf(pre) === 0) out.add(f.slice(pre.length).split('\\')[0]); }); dirs.forEach((d) => { if (d.indexOf(pre) === 0) out.add(d.slice(pre.length).split('\\')[0]); }); return Array.from(out); },
    rmdirSync: (p) => { dirs.delete(norm(p).replace(/[\\/]+$/, '')); }
  };

  const sb = baseSandbox({});
  sb.require = (name) => (name === 'fs' ? memfs : name === 'path' ? path : (name === 'os' ? { homedir: () => 'H:' } : null));
  vm.runInContext(U_STUB, sb);
  loadFile(sb, 'js/wikilink.js');
  loadFile(sb, 'js/projection.js');

  const P = vm.runInContext('Projection', sb);
  ok(!!P, 'projection 在 memfs 沙箱里加载成功');
  ok(P.setRoot('E:\\hub\\lib') === true, 'setRoot 初始化成功');

  /* ① 全库清单入库：未打开过的条目进候选、可解析 */
  const n1 = P.libSync([
    { id: 'L1', name: '神经网络入门.pdf', ext: 'pdf' },
    { id: 'L2', name: '手术演示.mp4', ext: 'mp4' }
  ]);
  ok(n1 === 2, '两条全库条目收录');
  const tree = P.wikiTree('');
  ok(tree.some((t) => t.book === '神经网络入门' && t.notes.length === 0), '未打开过的书出现在补全候选里');
  ok(P.idByTitle('神经网络入门') === 'L1', '[[未打开过的书]] 按现名解析到条目 id');
  ok(P.idByTitle('手术演示') === 'L2', '视频条目同样可解析');

  /* ② 改名：同 id 换名 → 旧名进别名，[[旧名]] 依旧解析 */
  const n2 = P.libSync([{ id: 'L1', name: '深度学习入门.pdf', ext: 'pdf' }]);
  ok(n2 >= 1, '改名被识别为变化');
  ok(P.idByTitle('深度学习入门') === 'L1', '新名直接解析');
  ok(P.idByTitle('神经网络入门') === 'L1', '【核心】[[旧名]] 经 lib 别名仍解析到同一条目（Eagle 改名不断链）');
  const n3 = P.libSync([{ id: 'L1', name: '深度学习入门.pdf', ext: 'pdf' }]);
  ok(n3 === 0, '名字没变时零写入');

  /* ③ 别名落盘：flush 后 lib 文件在盘上，且带旧名 */
  P.flush();
  ok(Object.keys(files).some((f) => f.indexOf('.eaglenote-lib.json') >= 0), 'lib 索引落盘（.eaglenote-lib.json）');
  const libRaw = JSON.parse(files[norm('E:\\hub\\lib\\.eaglenote-lib.json')]);
  ok(libRaw.L1 && libRaw.L1.aliases.indexOf('神经网络入门') >= 0, '旧名在落盘的 aliases 里');

  /* ④ 重开 root（模拟重启）后别名仍有效 */
  P.setRoot(null);
  P.setRoot('E:\\hub\\lib');
  ok(P.idByTitle('神经网络入门') === 'L1', '重启后旧名照常解析（持久化生效）');
  ok(P.wikiTree('').some((t) => t.book === '深度学习入门'), '重启后候选用新名');

  /* ⑤ manifest 里的书与 lib 不重复：writeNow 收编后候选只有一份 */
  P.writeNow(
    { itemId: 'L1', name: '深度学习入门.pdf', filePath: 'E:\\src\\dl.pdf', ext: 'pdf' },
    { itemId: 'L1', notes: [{ id: 'x1', md: '第一章', quote: '' }], annotations: [] }, true);
  P.flush();
  const tree2 = P.wikiTree('');
  ok(tree2.filter((t) => t.book === '深度学习入门').length === 1, '同一本书在候选里只出现一次');
  ok(tree2.find((t) => t.book === '深度学习入门').notes.length === 1, '收编后候选带笔记');
  ok(P.idByTitle('神经网络入门') === 'L1', 'lib 别名让旧名依然解析（manifest 优先，lib 兜底）');
}

/* ===== 5. Bridge 全库扫描（静态） ===== */
section('Bridge.listLibraryItems（静态）');
{
  const B = read('js/bridge.js');
  ok(/async function listLibraryItems\(exts, max\)/.test(B), 'listLibraryItems 定义存在');
  ok(B.indexOf('e.item.get({ ext: want })') > 0 && B.indexOf('e.item.get({})') > 0,
    'Eagle API 逐级降级（ext 过滤 → 全量本地筛）');
  ok(/id: it\.id,\s*\n\s*name: it\.name \|\| '',\s*\n\s*ext:/.test(B), '只取 id + 名字 + 扩展名（不存路径，移动文件夹不断链）');
  ok(/listLibraryItems,/.test(B), '已导出');

  const A = read('js/app.js');
  ok(A.indexOf('maybeRefreshLib') > 0 && A.indexOf('Bridge.listLibraryItems') > 0 && A.indexOf('Projection.libSync') > 0,
    'app.js 接线：候选取数时节流触发全库同步');
  ok(/now - libSyncAt < 60000/.test(A), '60s 节流（不卡输入）');
}

/* ===== 6. 版本与文档 ===== */
section('版本与文档');
{
  const m1 = JSON.parse(read('manifest.json'));
  const m2 = JSON.parse(read('../EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '主插件三段式版本号，实际 ' + m1.version);
  ok(m1.version === m2.version, '双插件版本同步');
  const rd = read('README.md');
  ok(/### 更新记录 · 4\.2\.3/.test(rd), 'README 有 4.2.3 更新记录');
  ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(rd), 'README 标注当前版本');
}

console.log('\nPASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
