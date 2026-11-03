/* v3.36 回归：点了「清除插件数据」，E 盘知识库里还剩着 md
 *
 * 现场：`E:\Notes Collection from Eagle\` 下有
 *   DY - Clinical Surgery\  ← 两篇 md 真在这儿
 *   Eagle\                  ← 只有清单和空 assets，是程序凭空造的
 * 清除时 root 指向 `Eagle`，认领清单一比对，那边一个文件都没有 → 什么都没删掉。
 *
 * 两个毛病：
 *   1. 库名拿不到时用 `|| 'Eagle'` 兜底 → 造出假目录；
 *   2. clearAll 只清「当前 root」→ 换过库 / root 走偏，旧目录的副本全留盘上。
 *
 * 这里用真文件系统验证：整个知识库根下的副本都要清掉，用户自己放的文件一个不许动。
 *
 * 运行：node test-v337.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h ^ str.charCodeAt(i)) * 16777619) >>> 0;
  return h.toString(36);
}

function memStore() {
  const m = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}

function loadProjection(seed) {
  const code = fs.readFileSync(path.join(ROOT, 'EaglePDFReader/js/projection.js'), 'utf8');
  const ls = memStore();
  Object.keys(seed || {}).forEach((k) => ls.setItem(k, seed[k]));
  const sandbox = {
    require: (n) => require(n),
    localStorage: ls,
    Buffer, console, Date, JSON, Math,
    setTimeout, clearTimeout, setInterval, clearInterval,
    U: { stripExt: (n) => String(n || '').replace(/\.[a-z0-9]+$/i, ''), hashKey },
    Store: {
      docKey: (m) => (m && m.itemId) || 'k',
      getIndex: () => ({ docs: {} }),
      readDocByKey: () => null,
      normalize: (r) => r
    },
    window: {}
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'projection.js' });
  return sandbox.Projection || sandbox.window.Projection;
}

const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p + '-'));
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

/* 造一个「库子目录」：一篇 md + 一张 assets 图 + 清单 */
function mkLibDir(hub, name, opts) {
  opts = opts || {};
  const dir = path.join(hub, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = opts.id || 'ITEM1';
  const file = '书名.md';
  fs.writeFileSync(path.join(dir, file), '# 标题\n\n正文\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'assets', id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', id, 'a1.png'), 'x');
  fs.writeFileSync(path.join(dir, '.eaglenote-manifest.json'), JSON.stringify({
    [id]: { file, title: '书名', hash: 'h1', items: {}, hand: '', rev: 1, images: ['a1.png'], at: Date.now() }
  }), 'utf8');
  if (opts.extra) fs.writeFileSync(path.join(dir, opts.extra), '用户自己写的\n', 'utf8');
  return dir;
}

console.log('\n[1] 清除：知识库根下每个库的副本都要清掉（不止当前那个）');
{
  const hub = mkTmp('hub');
  const P = loadProjection({});
  P.setHub(hub);
  const A = mkLibDir(hub, 'DY - Clinical Surgery', { id: 'AA1' });
  const B = mkLibDir(hub, 'Eagle', { id: 'BB2' });

  P.setLibrary('E:\\DY - Clinical Surgery.library', 'DY - Clinical Surgery');
  P.setRoot(A);                                  // 当前 root 指向 A
  ok(fs.existsSync(path.join(A, '书名.md')), '前置：A 里有 md');

  const n = P.clearAll();
  ok(n >= 2, 'clearAll 删掉了不止一个文件（实际 ' + n + '）');
  ok(!fs.existsSync(path.join(A, '书名.md')), 'A 的 md 被清掉');
  ok(!fs.existsSync(path.join(B, '书名.md')), 'B（当前 root 之外）的 md 也被清掉');
  ok(!fs.existsSync(A), 'A 清空后目录一起收掉，不留空壳');
  ok(!fs.existsSync(B), 'B 同样收掉（那个「Eagle」假目录就是这么来的）');
  ok(fs.existsSync(path.join(hub, 'README.md')), 'README 是说明文件，不清（删了也会重建）');
  rmrf(hub);
}

console.log('\n[2] 用户往里放的东西，一个都不许动');
{
  const hub = mkTmp('hub');
  const P = loadProjection({});
  P.setHub(hub);
  const C = mkLibDir(hub, 'My Lib', { id: 'CC3', extra: '我自己的笔记.md' });
  P.setRoot(C);
  P.clearAll();
  ok(!fs.existsSync(path.join(C, '书名.md')), '插件生成的 md 清了');
  ok(fs.existsSync(path.join(C, '我自己的笔记.md')), '用户手写的 md 原样保留');
  ok(fs.existsSync(C), '目录里还有用户文件 → 目录不删');
  ok(!fs.existsSync(path.join(C, '.eaglenote-manifest.json')), '清单撤掉（下次写入会重建）');
  rmrf(hub);
}

console.log('\n[3] 没有清单的目录不碰');
{
  const hub = mkTmp('hub');
  const P = loadProjection({});
  P.setHub(hub);
  const D = path.join(hub, '别人的笔记');
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, 'note.md'), 'x');
  P.clearAll();
  ok(fs.existsSync(path.join(D, 'note.md')), '没有我们的清单 = 不是我们建的，不删');
  rmrf(hub);
}

console.log('\n[4] 库子目录名：不再退成 "Eagle"');
{
  const P = loadProjection({});
  P.setLibrary('E:\\DY - Clinical Surgery.library', '');
  ok(P.libDirName() === 'DY - Clinical Surgery', 'name 缺失时从 <库>.library 反推目录名');

  const P2 = loadProjection({});
  P2.setLibrary('E:\\whatever.library', '临床外科');
  ok(P2.libDirName() === '临床外科', '有 name 就用 name');

  const P3 = loadProjection({});
  ok(P3.libDirName() === '', '两样都没有 → 空，不编一个名字出来');
}

console.log('\n[5] relocate：库名不明时宁可不建目录');
{
  const hub = mkTmp('hub');
  const P = loadProjection({});
  P.setLibrary('E:\\DY - Clinical Surgery.library', '');
  const dir = P.relocate(hub, '');
  ok(dir === path.join(hub, 'DY - Clinical Surgery'), 'relocate 落到真实库名：' + dir);
  ok(!fs.existsSync(path.join(hub, 'Eagle')), '没有凭空生出 Eagle 目录');

  const hub2 = mkTmp('hub2');
  const P2 = loadProjection({});
  ok(P2.relocate(hub2, '') === null, '库名完全不明 → 返回 null，什么都不写');
  const left = fs.readdirSync(hub2).filter((x) => x !== 'README.md');
  ok(left.length === 0, '目录里没有多出库子目录（只有 README）');
  rmrf(hub);
  rmrf(hub2);
}

console.log('\n[6] 源码契约：这两个坑不许回来');
{
  const PROJ = read('EaglePDFReader/js/projection.js');
  const BRIDGE = read('EaglePDFReader/js/bridge.js');
  const APP = read('EaglePDFReader/js/app.js');

  ok(!/safeName\(libName \|\| 'Eagle'\)/.test(PROJ), 'relocate 里不再有 || \'Eagle\' 兜底');
  ok(!/state\.libraryName \|\| 'Eagle'/.test(BRIDGE), 'bridge 里不再有 || \'Eagle\' 兜底');
  ok(/function libDirName\(/.test(PROJ) && /libDirName,/.test(PROJ), 'projection 导出 libDirName');
  /* v4.2.12：md 投影下线 —— 索引根直接是 dataDir，bridge 不再算库子目录 */
  ok(!/Projection\.libDirName/.test(BRIDGE), 'bridge 不再用 libDirName 算库子目录（索引随库，无 hub）');

  /* 清除那一行不能再看 isOn()：开关关着时残留最容易留 */
  const seg = APP.slice(APP.indexOf('function clearAllData'));
  ok(/Projection\.clearAll\(\)/.test(seg), '清空流程会调 Projection.clearAll()');
  ok(!/isOn\(\)\) Projection\.clearAll\(\)/.test(seg), '不再用 isOn() 拦着它（否则关掉开关就漏清）');

  ok(/function readManifestAt\(/.test(PROJ), '按目录读清单');
  ok(/for \(let i = 0; i < kids\.length; i\+\+\)/.test(PROJ) || /dirIsEmptyExceptAssets/.test(PROJ),
    '有「目录是否只剩空壳」的判据');
}

console.log('\n' + (fail === 0 ? 'PASS ' : 'FAIL ') + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
