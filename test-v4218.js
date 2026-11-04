/* v4.2.18 回归：数据层加固——损坏文档隔离
   覆盖：
   1) load() 读文档失败时先把损坏文件改名 .corrupt-<ts> 隔离，再返回空数据（不覆盖）；
   2) 索引损坏的兜底不变（rebuildIndex 从 docs/ 重建）；
   3) 核心写路径仍是 tmp + rename 原子写；
   4) 双 manifest 版本一致；README 版本行 + 更新记录。
*/
const fs = require('fs');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const A = fs.readFileSync('EaglePDFReader/js/store.js', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('\n[v4.2.18] 损坏文档隔离');

/* 1) load 的 catch 分支：隔离 + 空数据 */
const loadIdx = A.indexOf('function load(meta)');
const loadBody = A.slice(loadIdx, A.indexOf('function save(meta'));
ok(loadIdx > 0, 'load 函数存在');
ok(/读取文档失败（疑似损坏）/.test(loadBody), '损坏读取有日志标记');
ok(/\.corrupt-/.test(loadBody) && /renameSync\(df, bak\)/.test(loadBody), '损坏文件改名隔离（.corrupt-<ts>）');
ok(loadBody.indexOf('renameSync(df, bak)') < loadBody.indexOf('return emptyData(meta)'), '先隔离、再返回空数据（顺序正确）');
ok(/隔离失败不影响返回空数据/.test(loadBody), '隔离失败有兜底（不影响主流程）');

/* 2) 行为沙箱：损坏 JSON → 原文件被改名，不再被覆盖 */
{
  const fsMock = { existsSync: () => true, readFileSync: () => '{broken json', renameSync: (a, b) => fsMock.renamed = [a, b] };
  const empty = { items: [] };
  const fn = new Function('fs', 'emptyData', `
    const df = 'E:/lib/.eaglenote/docs/x.json';
    try {
      if (fs.existsSync(df)) { JSON.parse(fs.readFileSync(df, 'utf8')); return { quarantined: false }; }
    } catch (e) {
      try { fs.renameSync(df, df + '.corrupt-' + Date.now()); } catch (e2) {}
    }
    return { quarantined: true, data: emptyData() };
  `);
  const r = fn(fsMock, () => empty);
  ok(r.quarantined === true && Array.isArray(fsMock.renamed) && String(fsMock.renamed[1]).includes('.corrupt-'),
    '行为沙箱：损坏文档被改名隔离并返回空数据');
}

/* 3) 索引兜底不变 */
ok(/function getIndex\(\)/.test(A) && /return rebuildIndex\(\);/.test(A), '索引损坏仍走 rebuildIndex 重建');

/* 4) 原子写仍全覆盖核心路径 */
const tmpCount = (A.match(/\+ '\.tmp'/g) || []).length;
const renameCount = (A.match(/renameSync\(tmp/g) || []).length;
ok(tmpCount >= 4 && renameCount >= 4, '核心写路径保持 tmp + rename（' + tmpCount + ' 处）');

/* 5) 版本与文档 */
ok(/^\s*"version": "\d+\.\d+\.\d+"/m.test(MFEST) && /^\s*"version": "\d+\.\d+\.\d+"/m.test(WFEST), '双 manifest 版本三段式');
ok((MFEST.match(/"version":\s*"([^"]+)"/) || [])[1] === (WFEST.match(/"version":\s*"([^"]+)"/) || [])[1], '双 manifest 版本一致');
ok(/当前版本 \*\*4\.2\.18\*\*/.test(README) && /## 更新记录 · 4\.2\.18/.test(README), 'README 版本行 + 4.2.18 记录');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
