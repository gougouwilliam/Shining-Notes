/* v4.2.12 回归：md 投影下线 + 别名索引随库（root = .eaglenote）+ 旧位置迁移 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL - ' + msg); }
}

const P = fs.readFileSync('EaglePDFReader/js/projection.js', 'utf8');
const B = fs.readFileSync('EaglePDFReader/js/bridge.js', 'utf8');
const A = fs.readFileSync('EaglePDFReader/js/app.js', 'utf8');
const W = fs.readFileSync('EaglePDFReader/js/workbench.js', 'utf8');
const H = fs.readFileSync('EaglePDFReader/index.html', 'utf8');
const C = fs.readFileSync('EaglePDFReader/css/app.css', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('== 1. 版本联动（硬约定）==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(MFEST.split('\n').find(l => l.includes('"version"'))), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?\s*$/.test(WFEST.split('\n').find(l => l.includes('"version"'))), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/### 更新记录 · \d+\.\d+\.\d+/.test(README), 'README 更新记录为三段式标题');
ok(/"version": "\d+\.\d+\.\d+"/.test(MFEST) && /"version": "\d+\.\d+\.\d+"/.test(WFEST), '本轮发版版本号三段式（双 manifest 一致，不随版本号追改）');

console.log('== 2. md 投影下线 ==');
ok(/if \(v === 'off'\) enabled = false;/.test(P), 'v4.3.0 Obsidian 同步默认开：显式存过 off 才关');
ok(!/if \(v === 'on'\) enabled = true;/.test(P), 'v4.2.12「默认关」逻辑已移除');
ok(!A.includes('chkMdProj'), 'app.js 不再引用 md 开关');
ok(!H.includes('chkMdProj') && !H.includes('btnWbRebuild') && !H.includes('btnWbSyncProj') && !H.includes('btnWbOpenHub') && !H.includes('btnWbChangeProj'), '工作台设置区 md 开关/按钮已删');
ok(!A.includes('installProjHooks') || A.indexOf('installProjHooks') === A.lastIndexOf('installProjHooks'), '同步钩子函数已删（仅剩墓碑注释）');
ok(!/setInterval\(function \(\) \{\s*try \{\s*if \(typeof Projection === 'undefined' \|\| !Projection\.isOn\(\)\) return;\s*syncFromDisk/.test(A), '45 秒磁盘轮询已删');
ok(!/rebuildAll\(false\)/.test(A), '启动时历史补齐已删');

console.log('== 3. 别名索引随库（bridge 决策）==');
ok(/migrateLegacyIndex\(state\.dataDir\)/.test(B), 'bridge 启动时把旧位置索引迁入 dataDir');
ok(/mm\.path\.join\(state\.dataDir, 'vault'\)/.test(B), 'vault 根 = <库>\\.eaglenote\\vault（随库走）');
ok(!B.includes('setPortableRoot'), 'bridge 不再调用 v4.2.11 的 md 根逻辑');
ok(!/setHub\(state\.query\.mdroot\)/.test(B) && !/setHub\(null\)/.test(B), 'bridge 不再走盘根 hub 回退');
ok(/state\.projectionHub = null;/.test(B), 'projectionHub 恒空（无 hub 概念）');
ok(P.includes('libReady'), 'projection 导出 libReady');
ok(/Projection\.libReady\(\)/.test(A) && !/Projection\.isOn\(\)\s*\|\|\s*typeof Bridge/.test(A), '[[ 候选改由 libReady 把关（不依赖 md 开关）');

console.log('== 4. migrateLegacyIndex 行为沙箱 ==');
(function () {
  const fm = /function migrateLegacyIndex\(targetDir\) \{([\s\S]*?)\n  \}\n\n  \/\* v4\.2\.11/.exec(P);
  ok(!!fm, '函数体可提取');
  if (!fm) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enmig-'));
  const dataDir = path.join(tmp, 'MyLib.library', '.eaglenote');
  const oldHubSub = path.join(tmp, 'Notes Collection from Eagle', 'MyLib');
  const oldMd = path.join(dataDir, 'md');           // v4.2.11 过渡位置：<库>\.eaglenote\md
  fs.mkdirSync(oldHubSub, { recursive: true });
  fs.mkdirSync(oldMd, { recursive: true });
  fs.writeFileSync(path.join(oldHubSub, '.eaglenote-lib.json'), JSON.stringify({ i1: { name: '旧名', aliases: [] } }));
  fs.writeFileSync(path.join(oldMd, '.eaglenote-manifest.json'), '{}');

  const fakeFs = {
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    existsSync: (p) => fs.existsSync(p),
    copyFileSync: (s, d) => fs.copyFileSync(s, d),
  };
  const fakePath = { join: (...a) => path.join(...a) };
  const fn = new Function('node', 'fs', 'pathMod', 'libDirName', 'candidates', 'libPath', 'LIBFILE', 'MANIFEST', 'console',
    'return function migrateLegacyIndex(targetDir) {' + fm[1] + '\n}');
  const con = { info: () => {}, warn: () => {} };
  const r1 = fn(true, fakeFs, fakePath, () => 'MyLib', () => [path.join(tmp, 'Notes Collection from Eagle')], path.dirname(dataDir), '.eaglenote-lib.json', '.eaglenote-manifest.json', con)(dataDir);
  ok(r1 === true, '命中旧位置 → 返回 true');
  ok(fs.existsSync(path.join(dataDir, '.eaglenote-lib.json')), '盘根 hub 的别名索引已迁入 .eaglenote');
  ok(fs.existsSync(path.join(dataDir, '.eaglenote-manifest.json')), 'v4.2.11 md 目录的 manifest 也迁入');
  ok(JSON.parse(fs.readFileSync(path.join(dataDir, '.eaglenote-lib.json'), 'utf8')).i1.name === '旧名', '迁移内容完整');

  // 目标已有 → 不覆盖
  fs.writeFileSync(path.join(dataDir, '.eaglenote-lib.json'), '{"fresh":1}');
  fn(true, fakeFs, fakePath, () => 'MyLib', () => [path.join(tmp, 'Notes Collection from Eagle')], path.dirname(dataDir), '.eaglenote-lib.json', '.eaglenote-manifest.json', con)(dataDir);
  ok(fs.readFileSync(path.join(dataDir, '.eaglenote-lib.json'), 'utf8') === '{"fresh":1}', '库内已有索引不被旧数据覆盖');

  // node 不可用 → false
  ok(fn(false, fakeFs, fakePath, () => 'MyLib', () => [], null, '.eaglenote-lib.json', '.eaglenote-manifest.json', con)(dataDir) === false, '无 Node 环境 → false');

  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log('== 5. 工作台口径更新 ==');
ok(W.includes('Obsidian vault · 随库走'), '路径标签改为「Obsidian vault · 随库走」');
ok(!W.includes('chkMdProj'), 'workbench 不再引用 md 开关');
ok(H.includes('打开本库数据目录'), '「打开本库笔记」按钮改名「打开本库数据目录」');

console.log('== 6. v4.2.10 按钮对齐回归 ==');
ok(/\.note-new-bar \{[\s\S]{0,400}width: calc\(100% - 20px\)/.test(C), '新建按钮宽度与笔记列对齐（不回退，基础宽度仍收 20px）');

console.log(`v4.2.12：${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
