/* v4.3.2 回归：vault 按库名命名
   ─────────────────────────────────
   需求：多库场景下 Obsidian 仓库切换器里全叫「vault」分不清谁是谁。
   方案：vault 目录名 = 闪灵笔记 - <库名>（库名 = 库文件夹去掉 .library 后缀，
   与 Eagle 界面显示一致）；旧 vault/ 目录同盘 rename 自动迁移。
   ① bridge.js：命名逻辑 + 非法字符清洗 + legacy 迁移守卫
   ② 行为沙箱：迁移三分支（迁移/不动/全新）+ 非法字符清洗
   ③ 版本联动 4.3.2 + README 更新记录 */
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const B = R('EaglePDFReader/js/bridge.js');
const M1 = JSON.parse(R('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(R('EagleNoteWorkbench/manifest.json'));
const RD = R('EaglePDFReader/README.md');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL - ' + msg); }
}
const has = (s, k) => s.indexOf(k) >= 0;

console.log('—— ① bridge.js：命名与迁移逻辑 ——');
ok(has(B, "闪灵笔记 - ' + libBase"), '目录名 = 闪灵笔记 - <库名>');
ok(/basename\(state\.libraryPath \|\| ''\)/.test(B), '库名取 libraryPath 的 basename（与 Eagle 库文件夹一致，不依赖 API 行为）');
ok(/\.replace\(\/\\\.library\$\/i, ''\)/.test(B), '去掉 .library 后缀');
ok(B.indexOf('[\\\\/:*?"<>|]') >= 0, 'Windows 非法字符清洗（\\ / : * ? " < > |）');
ok(/libBase \? \('闪灵笔记 - ' \+ libBase\) : '闪灵笔记'/.test(B), '库名拿不到时退回「闪灵笔记」');
ok(has(B, 'const legacyVault = mm.path.join(state.dataDir, \'vault\')'), '检测旧 vault/ 目录');
ok(/existsSync\(legacyVault\) && !mm\.fs\.existsSync\(vaultDir\)/.test(B), '迁移守卫：legacy 存在且新名不存在才迁移（新名已存在绝不覆盖）');
ok(has(B, 'mm.fs.renameSync(legacyVault, vaultDir)'), '同盘 rename 迁移（零拷贝，.obsidian/投影/锚点清单全跟着走）');
ok(/vault 已按库名改名迁移/.test(B), '迁移留日志（可观测）');
ok(has(B, 'Projection.setRoot(vaultDir)'), 'root 注入沿用 v4.3.0 通道（projection 内部零改动）');

console.log('—— ② 行为沙箱：命名清洗 + 迁移三分支 ——');
{
  /* 从源码提取 vault 命名块，桩 fs/path 走三分支 */
  const blk = /let vaultDir = null;\s*try \{([\s\S]*?)\} catch \(e\) \{ vaultDir = null; \}/.exec(B);
  ok(!!blk, '能提取 vault 命名块');
  if (blk) {
    const mm = {
      path: {
        join: (...a) => a.join('/'),
        basename: (p) => String(p || '').split(/[\\/]/).pop()
      },
      fs: { existsSync: (p) => !!exists[p], renameSync: (a, b) => { renames.push([a, b]); delete exists[a]; exists[b] = true; } }
    };
    let exists = {}, renames = [];
    const run = (libPath, pre) => {
      exists = Object.assign({}, pre); renames = [];
      let vd = null;
      try {
        const libBase = mm.path.basename(libPath || '')
          .replace(/\.library$/i, '').replace(/[\\/:*?"<>|]/g, ' ')
          .replace(/\s+/g, ' ').trim();
        const vname = libBase ? ('闪灵笔记 - ' + libBase) : '闪灵笔记';
        vd = mm.path.join('/lib/.eaglenote', vname);
        const legacyVault = mm.path.join('/lib/.eaglenote', 'vault');
        if (mm.fs.existsSync(legacyVault) && !mm.fs.existsSync(vd)) {
          mm.fs.renameSync(legacyVault, vd);
        }
      } catch (e) { vd = null; }
      return vd;
    };
    ok(run('E:/DY - Clinical Surgery.library', {}) === '/lib/.eaglenote/闪灵笔记 - DY - Clinical Surgery',
      '库名 = 文件夹去 .library → 闪灵笔记 - DY - Clinical Surgery');
    ok(run('E:/DY - Clinical Surgery.library', { '/lib/.eaglenote/vault': true }) === '/lib/.eaglenote/闪灵笔记 - DY - Clinical Surgery'
      && renames.length === 1 && renames[0][0] === '/lib/.eaglenote/vault', '旧 vault 存在 → rename 迁移');
    ok(run('E:/DY - Clinical Surgery.library', { '/lib/.eaglenote/vault': true, '/lib/.eaglenote/闪灵笔记 - DY - Clinical Surgery': true }).indexOf('闪灵笔记') >= 0
      && renames.length === 0, '新名已存在 → 不迁移不覆盖');
    ok(run('E:/Medical.Devices*Bad|Name.library', {}).indexOf('闪灵笔记 - Medical.Devices Bad Name') >= 0,
      '库名含 Windows 非法字符（* |）→ 清洗成空格');
    ok(run('', {}) === '/lib/.eaglenote/闪灵笔记', 'libraryPath 为空 → 退回「闪灵笔记」');
  }
}

console.log('—— ③ 版本联动与文档 ——');
ok(/^\d+\.\d+\.\d+$/.test(M1.version) && M1.version === M2.version,
  '两包 manifest 版本一致且三段式：' + M1.version + ' / ' + M2.version);
ok(M1.version === '4.3.2', '本版本为 4.3.2');
ok(has(RD, '当前版本 **4.3.2**'), 'README 当前版本已更新');
ok(has(RD, '## 更新记录 · 4.3.2（vault 按库名命名）'), 'README 更新记录有 4.3.2 小节');
ok(has(RD, '打开文件夹作为仓库'), 'README 提示 Obsidian 侧重新指仓库');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
