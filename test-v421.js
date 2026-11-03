/* test-v421.js —— v4.2.1 引用弹框搜索 + 字幕后台就绪 + 四方同步审计修复 + 稳定性优化
   跑法：node test-v421.js。全绿输出「PASS n FAIL 0」。 */
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

/* ===== 1. editor.js 引用弹框搜索（静态） ===== */
section('Editor 引用弹框搜索（静态）');
{
  const E = read('js/editor.js');
  ok(/function matchScore\(hay, tokens\)/.test(E), '多关键词 AND 匹配函数（v4.2.4 起打分制）');
  ok(/qBook\.split\(\/\\s\+\//.test(E) || /split\(\/\\s\+\//.test(E), '空格分词');
  ok(/function hi\(label, tokens\)/.test(E) && /marks\[i \+ k\] = true/.test(E), '命中高亮（按下标区间打 mark）');
  ok(E.indexOf('CHAR_ESC') > 0, '高亮前逐字符转义（用户输入不进 HTML）');
  ok(E.indexOf('ne-wiki-hint') > 0, '空查询提示行');
  ok(E.indexOf('nHits') > 0 && E.indexOf('matchScore(t, tBook)') > 0, '无 # 时笔记标题直接参与搜索');
  ok(E.indexOf('r.hl') > 0, '渲染行带命中词用于高亮');

  const C = read('css/app.css');
  ok(C.indexOf('.ne-wiki-hint') > 0, '提示行样式');
  ok(/\.ne-wiki-item mark/.test(C), '高亮 mark 样式');
}

/* ===== 1b. v4.2.2 补全弹层真搜索框（静态） ===== */
section('v4.2.2 补全弹层搜索框（静态）');
{
  const E = read('js/editor.js');
  ok(/el\('input', 'ne-wiki-search'\)/.test(E), '弹层自带真搜索输入框');
  ok(E.indexOf("wsearch.placeholder") > 0 && E.indexOf('空格分隔多词') > 0, '搜索框占位文案保留多词提示');
  ok(E.indexOf('wsearch.addEventListener') > 0 && E.indexOf('ta.value.slice(0, d.start)') > 0,
    '搜索框打字回写 textarea 的 [[ 后（一份查询两个入口）');
  ok(/setTimeout\(\(\) => \{ if \(!wpop\.contains\(document\.activeElement\)\) wikiClose\(\); \}, 120\)/.test(E),
    'blur 收起前先看焦点是否在弹层内（点搜索框不再关框）');
  ok(E.indexOf('function wikiKey(e)') > 0 && E.indexOf('wsearch.addEventListener(\'keydown\', wikiKey)') > 0,
    '键盘导航 textarea / 搜索框共用');
  ok(E.indexOf('document.activeElement !== wsearch') > 0, '焦点在搜索框时不被镜像回写打断');

  const C = read('css/app.css');
  ok(/\.ne-wiki-search \{/.test(C) && /\.ne-wiki-list \{/.test(C), '搜索框 / 列表区样式齐备');
  ok(/\.ne-wikipop \{[^}]*min-width: 240px/.test(C), '弹层加宽到 240px');
}

/* ===== 2. 字幕后台就绪（静态） ===== */
section('字幕后台自动开启加固（静态）');
{
  const S = read('js/subtitle.js');
  ok(S.indexOf("video.addEventListener('playing', retry)") > 0 && S.indexOf('!running && !busy) start(false, true)') > 0,
    'attach 未接上时在视频首次 playing 补试一次');
  ok(S.indexOf("pop.classList.toggle('live'") > 0 && S.indexOf('btnPopSubs') > 0,
    '顶栏字幕键同步转写状态');
  ok(S.indexOf('setAutoEnabled(false)') > 0, '手动暂停仍然记忆（下一个视频不自动开）保留');
  ok(/autoEnabled\(\) && st\.engine === 'ready' && st\.model === 'ready'/.test(S),
    '自动开启仍然只对「引擎+模型已就绪」生效（绝不偷偷下载）');

  const C = read('css/app.css');
  ok(/\.tool-btn\.live::after/.test(C) && C.indexOf('--ok') > 0, '运行中小绿点样式');
}

/* ===== 3. videoview 稳定性 / 提速（静态） ===== */
section('VideoView 稳定性（静态）');
{
  const V = read('js/videoview.js');
  ok(V.indexOf('fs.readFile(path0') > 0 && V.indexOf('fs.readFileSync(current.filePath)') < 0,
    'blob 源改异步读（不再冻 UI）');
  ok(/let blobReading = false/.test(V), '在飞保护（error 事件与看门狗双触发不重复读）');
  ok(V.indexOf("current.filePath !== path0") > 0, '读取途中切视频作废旧任务');
  ok(/video\.preload = 'auto'/.test(V), 'preload=auto（打开期间预取数据）');
  ok(V.indexOf('blobReading = true') > 0 && V.indexOf('blobReading = false') > 0, '在飞标志成对维护');
}

/* ===== 3b. v4.2.2 打开即播（静态） ===== */
section('v4.2.2 打开视频自动播放（静态）');
{
  const V = read('js/videoview.js');
  ok(/const p = video\.play\(\);/.test(V), 'open() 里主动调 play()（打开即播）');
  ok(/p\.catch\(\(\) => \{[\s\S]{0,160}loadeddata[\s\S]{0,120}video\.play\(\)/.test(V),
    'play() 被内核拒绝时等首帧到了补播一次');
}

/* ===== 4. app.js 打开视频提速（静态） ===== */
section('openVideoItem 提速（静态）');
{
  const A = read('js/app.js');
  ok(/setTimeout\(\(\) => \{[\s\S]{0,200}token === state\.loadToken[\s\S]{0,80}Projection\.writeNow/.test(A),
    '投影写盘延后到 UI 之后，loadToken 守卫快速切换');
}

/* ===== 5. projection 四方同步：动态沙箱（memfs） ===== */
section('四方同步审计（动态）');
const U_STUB = 'const U = { stripExt: (s) => String(s||"").replace(/\\.[a-z0-9]+$/i, ""), hashKey: (s) => { let h = 5381; const t = String(s||""); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return "h" + h.toString(16); }, toast: () => {}, el: () => ({}) };';
{
  /* 迷你 memfs：只实现 projection 用到的子集 */
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

  /* 第一本书 A：写一次（记录书名「旧书」），再改名「新书」→ aliases 应记下旧名 */
  const w1 = P.writeNow(
    { itemId: 'A1', name: '旧书.pdf', filePath: 'E:\\src\\a.pdf', ext: 'pdf' },
    { itemId: 'A1', notes: [{ id: 'n1', md: '正文，引用 [[乙书]]', quote: '' }], annotations: [] }, true);
  ok(w1 && w1.ok, '首本书写入成功');
  ok(P.idByTitle('旧书') === 'A1', '按书名对账到条目');
  ok(P.flush().ok, '清单落盘');

  const w2 = P.writeNow(
    { itemId: 'A1', name: '新书.pdf', filePath: 'E:\\src\\a.pdf', ext: 'pdf' },
    { itemId: 'A1', notes: [{ id: 'n1', md: '正文，引用 [[乙书]]', quote: '' }], annotations: [] }, true);
  ok(w2 && w2.ok, '改名后重写成功');
  ok(P.idByTitle('新书') === 'A1', '新名直接可解析');
  ok(P.idByTitle('旧书') === 'A1', '【核心】旧名经 aliases 仍解析到同一条目（改名不断链）');
  P.flush();

  /* 第二本书乙：里面写的 [[旧书]] 指向 A 改名前的名字 */
  P.writeNow(
    { itemId: 'B2', name: '乙书.pdf', filePath: 'E:\\src\\b.pdf', ext: 'pdf' },
    { itemId: 'B2', notes: [{ id: 'm1', md: '参见 [[旧书]] 的第三章', quote: '' }], annotations: [] }, true);
  P.flush();

  const bl = P.backlinksOf('新书');
  ok(bl.some((x) => x.id === 'B2'), '【核心】反链按别名对账：[[旧书]] 算作指向「新书」');
  const blRec = bl.filter((x) => x.id === 'B2')[0];
  ok(blRec && blRec.contexts.length === 1 && blRec.contexts[0].alias === '旧书', '别名链接的上下文摘录也能取到');

  /* 孤儿文件保护：manifest 没有记录的磁盘同名 md，覆盖前先备份 */
  memfs.writeFileSync('E:\\hub\\lib\\丙书.md', '用户手写的重要内容\n', 'utf8');
  P.writeNow(
    { itemId: 'C3', name: '丙书.pdf', filePath: 'E:\\src\\c.pdf', ext: 'pdf' },
    { itemId: 'C3', notes: [{ id: 'k1', md: '插件里的新内容', quote: '' }], annotations: [] }, true);
  P.flush();
  const orphans = Object.keys(files).filter((f) => /丙书\.md\.orphan-/.test(f) || f.indexOf('丙书.orphan-') >= 0);
  ok(orphans.length === 1, '【核心】覆盖无认领的同名 md 前先落 .orphan 备份');
  ok(orphans.length === 1 && files[orphans[0]].indexOf('用户手写的重要内容') >= 0, '备份内容就是原文件');
  ok(Object.keys(files).some((f) => f.indexOf('丙书.md') >= 0), '原路径照常写成新版');
}

/* ===== 6. 版本与文档 ===== */
section('版本与文档');
{
  const m1 = JSON.parse(read('manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '主插件三段式版本号，实际 ' + m1.version);
  const rd = read('README.md');
  ok(/### 更新记录 · 4\.2\.1/.test(rd), 'README 有 4.2.1 更新记录');
  ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(rd), 'README 标注当前版本');
}

console.log('\nPASS ' + pass + '  FAIL ' + fail);
process.exit(fail ? 1 : 0);
