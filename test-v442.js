#!/usr/bin/env node
/* test-v442.js —— Eagle 已删条目 → Obsidian 残留 md 自动回收（v4.4.2）
 * 现场：视频在 Eagle 里删了，OB 里 md 还在，「重建全部」也清不掉。
 * 根因：投影层只遍历自己的 docs/*.json，从不反查 Eagle 条目是否还存在；
 *       「只有注释、没进 docs」的条目成了 manifest 里的死账。
 * 修复：全库 id 对账 → 逐条复核 → 备份到 vault 外 → 回收 md/清单/别名 → 墓碑防复活。
 * 本套件用真实 projection.js + 内存文件系统跑完整链路，不是纯文本断言。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const PJ = read('EaglePDFReader/js/projection.js');
const APP = read('EaglePDFReader/js/app.js');
const HTML = read('EaglePDFReader/index.html');
const RD = read('EaglePDFReader/README.md');

/* ---------------- 内存文件系统 + 真实 projection.js 沙箱 ---------------- */
function makeSandbox() {
  const files = Object.create(null);
  const dirs = new Set();
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const key = (p) => String(p).replace(/[\\/]+$/, '');
  const addParents = (p) => {
    let d = path.dirname(key(p));
    for (let i = 0; i < 12 && d && d !== path.dirname(d); i++) {
      dirs.add(d);
      d = path.dirname(d);
    }
    if (d) dirs.add(d);
  };
  const memfs = {
    existsSync: (p) => has(files, key(p)) || dirs.has(key(p)),
    statSync: (p) => {
      const k = key(p);
      if (has(files, k)) return { size: files[k].length, isDirectory: () => false };
      if (dirs.has(k)) return { size: 0, isDirectory: () => true };
      throw new Error('ENOENT ' + k);
    },
    readFileSync: (p) => {
      const k = key(p);
      if (!has(files, k)) throw new Error('ENOENT ' + k);
      return files[k];
    },
    writeFileSync: (p, c) => { const k = key(p); files[k] = String(c); addParents(k); },
    renameSync: (a, b) => {
      const ka = key(a), kb = key(b);
      if (!has(files, ka)) throw new Error('ENOENT ' + ka);
      files[kb] = files[ka]; delete files[ka]; addParents(kb);
    },
    copyFileSync: (a, b) => {
      const ka = key(a), kb = key(b);
      if (!has(files, ka)) throw new Error('ENOENT ' + ka);
      files[kb] = files[ka]; addParents(kb);
    },
    unlinkSync: (p) => { delete files[key(p)]; },
    mkdirSync: (p) => { const k = key(p); dirs.add(k); addParents(k); },
    rmdirSync: (p) => { dirs.delete(key(p)); },
    readdirSync: (p) => {
      const pre = key(p) + path.sep;
      const out = new Set();
      Object.keys(files).forEach((f) => {
        if (f.indexOf(pre) === 0) out.add(f.slice(pre.length).split(/[\\/]/)[0]);
      });
      dirs.forEach((d) => {
        if (d.indexOf(pre) === 0) out.add(d.slice(pre.length).split(/[\\/]/)[0]);
      });
      return Array.from(out);
    }
  };

  const store = Object.create(null);
  const sb = {
    console, Date, JSON, Math, RegExp, String, Object, Array, Error, Promise, parseInt, parseFloat,
    setTimeout: () => 1,                       // 定时器不执行；flush* 手动落盘
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (has(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    U: {
      hashKey: (s) => 'h:' + String(s == null ? '' : s),
      stripExt: (s) => String(s == null ? '' : s).replace(/\.[a-z0-9]+$/i, '')
    },
    Store: {
      docKey: () => 'local_x',
      getIndex: () => ({ docs: {} }),
      normalize: (r) => r,
      readDocByKey: () => null
    },
    window: {}
  };
  sb.global = sb;
  sb.require = (n) => (n === 'fs' ? memfs : n === 'path' ? path : n === 'os' ? { homedir: () => '' } : null);
  vm.createContext(sb);
  vm.runInContext(read('EaglePDFReader/js/wikilink.js'), sb);
  vm.runInContext(read('EaglePDFReader/js/projection.js'), sb);
  const P = vm.runInContext('Projection', sb);
  return { P, memfs, files, dirs, key };
}

const S = makeSandbox();
const P = S.P;
const ROOT = path.join('E:\\lib\\.eaglenote', '闪灵笔记 - Test');
const PARENT = path.dirname(ROOT);
const MF = path.join(ROOT, '.eaglenote-manifest.json');
const LF = path.join(ROOT, '.eaglenote-lib.json');
const TOMB = path.join(PARENT, '.eaglenote-deleted.json');
const BDIR = path.join(PARENT, 'deleted-md');
const mdA = '---\neagle: A1\n---\n# 甲书\n';
const mdB = '---\neagle: B2\n---\n# 乙书\n\n<!-- eagle:ec:B2 -->\nUP主：被窝聊电影\n<!-- /eagle:ec:B2 -->\n';
const mdC = '---\neagle: C3\n---\n# 丙书\n\n## 手记（不会被插件覆盖）\n用户手写内容\n';
const mdD = '---\neagle: D4\n---\n# 丁书\n';

S.memfs.mkdirSync(ROOT);
S.memfs.writeFileSync(MF, JSON.stringify({
  A1: { file: '甲.md', title: '甲书', hash: 'h1', items: {}, hand: '', images: [], nt: [], aliases: [] },
  B2: { file: '乙.md', title: '乙书', hash: 'h2', items: {}, hand: '', images: [], nt: [], aliases: [] },
  C3: { file: '丙.md', title: '丙书', hash: 'h3', items: {}, hand: '', images: [], nt: [], aliases: [] }
}));
S.memfs.writeFileSync(LF, JSON.stringify({ A1: { name: '甲书' }, B2: { name: '乙书' }, C3: { name: '丙书' } }));
S.memfs.writeFileSync(path.join(ROOT, '甲.md'), mdA);
S.memfs.writeFileSync(path.join(ROOT, '乙.md'), mdB);
S.memfs.writeFileSync(path.join(ROOT, '丙.md'), mdC);
ok(P.setRoot(ROOT), '沙箱：setRoot 成功（真实 projection.js 在内存 FS 上运行）');

console.log('—— ① 孤儿识别：只认「vault 有账、Eagle 已无」——');
let c = P.orphanCandidates(['A1', 'C3']);
ok(c.length === 1 && c[0].id === 'B2', '全库剩 A1/C3 → 只把 B2 判成孤儿');
ok(c[0].file === '乙.md' && c[0].title === '乙书' && c[0].hand === false,
  '候选带 manifest 的文件名/标题/手记标记');
ok(P.orphanCandidates(['A1', 'B2.info', 'C3']).length === 0, '.info 后缀归一化，不误判已存在条目');
ok(P.orphanCandidates([{ id: 'A1' }, { id: 'C3' }]).length === 1, '允许传官方 API 的 { id } 对象');
ok(P.orphanCandidates([]).length === 0, '全库清单为空（API 失败/空库）→ 零候选，绝不误删');
ok(P.orphanCandidates(null).length === 0, '未传清单 → 零候选');
ok(P.orphanCandidates(['A1', 'B2', 'C3']).length === 0, '条目都还在 → 零候选');
const c2 = P.orphanCandidates(['A1']);
ok(c2.some((x) => x.id === 'C3' && x.hand === true), '含非空「手记」的候选被标出来（自动轮要绕开）');

console.log('—— ② 回收：先备份，再删 md / 清单 / 别名 / 写墓碑 ——');
let r = P.pruneOrphans(['B2']);
ok(r.ok && r.removed === 1 && r.backed.length === 1, '回收 1 条，返回备份清单');
ok(!S.memfs.existsSync(path.join(ROOT, '乙.md')), 'vault 里的 md 已移走（OB 里不再显示）');
const backupPath = r.backed[0].backup;
ok(backupPath.indexOf(BDIR) === 0, '备份落在 vault 之外（<库>\\.eaglenote\\deleted-md\\）');
ok(S.memfs.readFileSync(backupPath) === mdB, '备份内容与原 md 一字不差（可随时找回）');
ok(!/B2/.test(JSON.stringify(JSON.parse(S.memfs.readFileSync(MF)))), 'manifest 已清掉 B2');
ok(!/B2/.test(JSON.stringify(JSON.parse(S.memfs.readFileSync(LF)))), '全库别名索引已清掉 B2');
ok(S.memfs.existsSync(TOMB) && !!JSON.parse(S.memfs.readFileSync(TOMB)).B2, '墓碑文件已写入 B2');
ok(JSON.parse(S.memfs.readFileSync(TOMB)).B2.file === '乙.md', '墓碑记下原文件名，便于排查');
ok(S.memfs.readFileSync(path.join(ROOT, '甲.md')) === mdA, '仍在 Eagle 的条目 md 完全不动');

console.log('—— ③ 防复活：writeNow / rebuildAll / syncExternal 都拦墓碑 ——');
ok(P.isTombstoned('B2') === true, 'isTombstoned(B2) = true');
const w = P.writeNow({ itemId: 'B2', name: '乙书', filePath: '', ext: 'mp4' },
  { annotations: [], notes: [] }, true);
ok(!!w && w.tombstoned === true && w.skipped === true,
  'writeNow 撞墓碑直接跳过（重建全部不会把删掉的 md 写回来）');
ok(!S.memfs.existsSync(path.join(ROOT, '乙.md')), '跳过之后磁盘上仍无 md');
ok(/if \(isTombstoned\(id\)\) return \{ ok: false, skipped: true, tombstoned: true \};/.test(PJ),
  'writeNow 源码里有墓碑闸门');
ok(/if \(isTombstoned\(id\)\) return;/.test(PJ) && /if \(isTombstoned\(iid\)\) return;/.test(PJ),
  'rebuildAll / syncExternal 也显式跳过墓碑条目');

console.log('—— ④ 从 Eagle 回收站恢复：墓碑自动解除 ——');
const revived = P.syncAliveIds(['A1', 'B2', 'C3']);
ok(revived.revived === 1, 'B2 重新出现在全库 → 解除 1 条墓碑');
ok(P.isTombstoned('B2') === false, '解除后 isTombstoned(B2) = false');
ok(revived.candidates.length === 0, '恢复轮不产生任何待清理候选');
const w2 = P.writeNow({ itemId: 'B2', name: '乙书', filePath: '', ext: 'mp4' },
  { annotations: [], notes: [] }, true);
ok(!!w2 && !w2.tombstoned, '恢复后 writeNow 不再被拦（投影可正常回来）');
ok(P.syncAliveIds([]).revived === 0, '空清单不解除任何墓碑（防 API 抖动）');

console.log('—— ⑤ 手记保护、备份失败、幂等 ——');
const rSkip = P.pruneOrphans(['C3'], { skipHand: true });
ok(rSkip.removed === 0 && rSkip.skipped.indexOf('C3') >= 0, 'skipHand：含手记的条目自动轮跳过');
ok(S.memfs.readFileSync(path.join(ROOT, '丙.md')) === mdC, '跳过后原件完好');
const rManual = P.pruneOrphans(['C3'], { skipHand: false });
ok(rManual.removed === 1 && !S.memfs.existsSync(path.join(ROOT, '丙.md')),
  '手动确认（不 skipHand）照样回收，且已备份');
ok(S.memfs.readFileSync(rManual.backed[0].backup) === mdC, '含手记的原件备份内容一致');
ok(P.pruneOrphans(['B2']).removed === 0, '重复清理同一 id 幂等（清单已无记录就不动）');
ok(P.pruneOrphans([]).removed === 0, '空 id 列表什么都不做');

/* 备份写不进去时，原件一个字节都不能动。
   单开一个沙箱：manifest 必须在 setRoot 时就含 D4（内存态与磁盘一致），
   不能绕过 Projection 直接改磁盘文件。 */
const S2 = makeSandbox();
const ROOT2 = path.join('E:\\lib2\\.eaglenote', '闪灵笔记 - Test2');
S2.memfs.mkdirSync(ROOT2);
S2.memfs.writeFileSync(path.join(ROOT2, '.eaglenote-manifest.json'), JSON.stringify({
  D4: { file: '丁.md', title: '丁书', hash: 'h4', items: {}, hand: '', images: [], nt: [], aliases: [] }
}));
S2.memfs.writeFileSync(path.join(ROOT2, '丁.md'), mdD);
ok(S2.P.setRoot(ROOT2), '沙箱 2：setRoot 成功（备份失败场景）');
const origCopy = S2.memfs.copyFileSync;
S2.memfs.copyFileSync = () => { throw new Error('disk full'); };
const rFail = S2.P.pruneOrphans(['D4']);
S2.memfs.copyFileSync = origCopy;
ok(rFail.removed === 0 && rFail.failed.length === 1 && rFail.failed[0].why === 'backup-failed',
  '备份失败 → 明确记账、不删原件');
ok(S2.memfs.readFileSync(path.join(ROOT2, '丁.md')) === mdD, '备份失败后原 md 仍在');
ok(!!JSON.parse(S2.memfs.readFileSync(path.join(ROOT2, '.eaglenote-manifest.json'))).D4,
  '备份失败后 manifest 记录仍在');
ok(!S2.memfs.existsSync(path.join(path.dirname(ROOT2), '.eaglenote-deleted.json')),
  '备份失败不写墓碑（不会误拦后续投影）');

/* 同步关闭时不许做任何清理 */
P.setEnabled(false);
ok(P.orphanCandidates(['A1']).length === 0 && P.pruneOrphans(['A1']).ok === false,
  'Obsidian 同步关闭 → 识别与回收都不执行');
P.setEnabled(true);

console.log('—— ⑥ 调用层：API 复核、防误删、按钮与自动轮 ——');
ok(/async function reconcileDeleted\(opts\)/.test(APP), 'app.js 有 reconcileDeleted');
ok(/Bridge\.getAllItems\(\['id', 'name'\]\)/.test(APP), '走官方 API 拉全库 id');
ok(/if \(!items \|\| !items\.length\)[\s\S]{0,220}?empty-library/.test(APP),
  '拿不到全库清单时不清理（防误删）');
ok(/Bridge\.getItemById\(c\.id\)/.test(APP) && /if \(!it\) confirmed\.push\(c\)/.test(APP),
  '逐条 getById 复核，取不到才认定已删');
ok(/catch \(e\) \{ \/\* 保守跳过 \*\/ \}/.test(APP), '单条复核报错保守跳过');
ok(/todo = confirmed\.filter\(\(c\) => !c\.hand\)/.test(APP), '静默轮跳过含手记的候选');
ok(/confirmDialog\('清理已删除条目'/.test(APP), '手动轮有确认框');
ok(/Projection\.pruneOrphans\(todo\.map\(\(c\) => c\.id\), \{ skipHand: false \}\)/.test(APP),
  '确认后才调用回收');
ok(/on\('#btnWbPruneOrphans', 'click'/.test(APP), '工作台按钮已绑定');
ok(/id="btnWbPruneOrphans"/.test(HTML), 'index.html 有「清理已删条目…」按钮');
ok(/\}, 8000\);/.test(APP) && /\}, 300000\);/.test(APP), '启动 8 秒静默对账 + 每 5 分钟一轮');
ok(/reconcileDeleted\(\{ silent: true \}\)/.test(APP), '自动轮走静默模式');
ok(/Projection\.syncAliveIds\(aliveIds\)/.test(APP), '每轮对账先解除复活墓碑');

console.log('—— ⑦ 文档与发版 ——');
ok(/\| Eagle 里删除条目 \|/.test(PJ), 'vault README 表格说明删除回收与备份位置');
ok(/orphanCandidates,\s*\n\s*syncAliveIds,\s*\n\s*pruneOrphans,\s*\n\s*isTombstoned/.test(PJ),
  'Projection 导出了对账四件套');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本号一致且三段式');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(/更新记录 · 4\.4\.2（Eagle 删除条目后/.test(RD), 'README 有 4.4.2 更新记录小节');

console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
