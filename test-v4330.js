/* v4.3.3 回归：OB 文件夹整理 + Ctrl+N 新建笔记
   ─────────────────────────────────
   需求：① 用户在 Obsidian 里按自己的文件夹树整理笔记（移动/F2 改名），
   插件要能重新认领 —— 回读照常、写盘跟新位置走、不长重复文件、图片引用不裂；
   ② 插件内 Ctrl+N 新建笔记。
   ① projection.js：detectMoves 认领（锚点优先/文件名兜底/同名多份放弃）
      + fixAssetLinks 按深度重写 assets 引用 + fileOf 跟文件夹 + 写盘 mkdir/相对路径
   ② 行为沙箱：真实临时目录走 移动/改名/挪回/同名歧义 四分支
   ③ app.js：Ctrl+N 绑定 + 草稿守卫
   ④ 版本联动 4.3.3 + README 更新记录 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const P = R('EaglePDFReader/js/projection.js');
const A = R('EaglePDFReader/js/app.js');
const M1 = JSON.parse(R('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(R('EagleNoteWorkbench/manifest.json'));
const RD = R('EaglePDFReader/README.md');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL - ' + msg); }
}
const has = (s, k) => s.indexOf(k) >= 0;

console.log('—— ① projection.js：认领机制 ——');
ok(has(P, 'function detectMoves'), 'detectMoves 认领入口存在');
ok(has(P, 'function listVaultMd'), '递归扫描 listVaultMd');
ok(has(P, 'function fixAssetLinks'), 'assets 引用按深度重写 fixAssetLinks');
ok(has(P, "ent.name === 'assets'") && has(P, "test(ent.name)"), '扫描跳过 assets/ 与点开头目录（.obsidian 不进笔记树）');
ok(/\\\.orphan-\|\\\.conflict-\|\\\.tmp\$/.test(P), '孤儿/冲突/临时文件不认领');
ok(has(P, "eagle:\\s*\"([^\"]+)\"") || /eagle:\\s\*"\(\[\^"\]\+\)"/.test(P), '按 frontmatter eagle: "<条目id>" 锚点认领');
ok(/byAnchor\[id3\] && byAnchor\[id3\]\.length === 1/.test(P), '锚点命中且唯一才认领');
ok(/cands && cands\.length === 1/.test(P), '文件名兜底同样要求唯一（同名多份放弃，绝不认错）');
ok(has(P, 'if (n) { markManifest(); wikiCache = null; }'), '认领成功才落 manifest（无改动零写入）');
ok(/!force && now - lastMoveCheck < 3000/.test(P), '3s 节流（writeNow 每次保存都过这里，全量 rebuild 只真扫一次）');
ok(/detectMoves\(\);\s*\/\/ v4\.3\.3[^]*?const ids = externallyChanged\(\)/.test(P), 'syncExternal 先认领再回读（顺序正确）');
ok(/const prev = manifest\[id\] \|\| \{\};[^]*?detectMoves\(\);[^]*?const file = fileOf\(meta, data\);/.test(P), 'writeNow 写前先认领（防老位置长重复文件）');
ok(has(P, 'file: relFile,'), 'manifest 存相对路径（可能带子文件夹）');
ok(has(P, "pathMod.relative(root, file).split(pathMod.sep).join('/')"), '路径统一 posix 风格');
ok(has(P, 'fs.mkdirSync(pathMod.dirname(file), { recursive: true })'), '写盘前确保子文件夹存在');
ok(has(P, 'if (prev.file && prev.file !== relFile)'), '旧文件按相对路径比较删除（旧位置可能在子文件夹）');
ok(/const dirPart = \(prev && prev\.file\) \? pathMod\.dirname\(prev\.file\) : '\.';/.test(P), 'fileOf：改名/重算文件名跟着已认领的文件夹走');
ok(has(P, "detectMoves,\n    fixAssetLinks,"), 'detectMoves/fixAssetLinks 导出（可测可查）');

console.log('—— ② 行为沙箱：真实临时目录四分支 ——');
{
  /* 提取三个函数，注入真实 fs/path 跑真实文件系统 */
  const grab = (name) => {
    const re = new RegExp('  (function ' + name + '\\([\\s\\S]*?\\n  \\})');
    const m = re.exec(P);
    return m ? m[1] : null;
  };
  const srcList = grab('listVaultMd');
  const srcFix = grab('fixAssetLinks');
  let srcMoves = grab('detectMoves');
  ok(!!srcList && !!srcFix && !!srcMoves, '三个函数都能提取');
  if (srcList && srcFix && srcMoves) {
    /* wikiCache/root/manifest 是闭包变量，沙箱里换成可注入参数 */
    srcMoves = srcMoves.replace('wikiCache = null;', '__wiki.v = null;')
      .replace('let lastMoveCheck = 0;\n  ', '').replace('let lastMoveCheck = 0;', '');
    const factory = new Function('fs', 'pathMod', 'U', 'markManifest', '__wiki', 'root', 'manifest',
      srcList + '\n' + srcFix + '\n' + 'let lastMoveCheck = 0;\n' + srcMoves +
      '\nreturn { detectMoves, fixAssetLinks, listVaultMd };');
    const U = { hashKey: (s) => require('crypto').createHash('md5').update(String(s)).digest('hex').slice(0, 10) };
    let marked = 0;
    const wiki = { v: 'x' };
    const mk = (root, man) => factory(fs, path, U, () => { marked++; }, wiki, root, man);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4330-'));
    const md = (t) => '---\neagle: "ITEM01"\ntitle: "测试书"\n---\n\n# 测试书\n\n![](assets/ITEM01/pic.png)\n\n' + t;
    const reset = () => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.mkdirSync(tmpRoot, { recursive: true });
      marked = 0; wiki.v = 'x';
    };

    /* 分支1：挪进子文件夹 → 认领 + ../ 前缀 */
    reset();
    fs.writeFileSync(path.join(tmpRoot, '书.md'), md('正文'), 'utf8');
    const man = { ITEM01: { file: '书.md', title: '测试书', hash: 'x', at: 0 } };
    fs.mkdirSync(path.join(tmpRoot, '论文'));
    fs.renameSync(path.join(tmpRoot, '书.md'), path.join(tmpRoot, '论文', '书.md'));
    const n1 = mk(tmpRoot, man).detectMoves(true);
    ok(n1 === 1, '分支1：挪进子文件夹被认领（1 条）');
    ok(man.ITEM01.file === '论文/书.md', 'manifest 更新为相对子路径');
    const t1 = fs.readFileSync(path.join(tmpRoot, '论文', '书.md'), 'utf8');
    ok(has(t1, '](../assets/ITEM01/pic.png)'), '图片引用补 ../ 前缀');
    ok(marked === 1, '认领成功落 manifest');

    /* 分支2：挪走 + F2 改名 → 锚点认领 */
    reset();
    const man2 = { ITEM01: { file: '旧名.md', title: '测试书', hash: 'x', at: 0 } };
    fs.writeFileSync(path.join(tmpRoot, '旧名.md'), md('正文'), 'utf8');
    fs.mkdirSync(path.join(tmpRoot, 'a'));
    fs.renameSync(path.join(tmpRoot, '旧名.md'), path.join(tmpRoot, 'a', '新名.md'));
    const n2 = mk(tmpRoot, man2).detectMoves(true);
    ok(n2 === 1 && man2.ITEM01.file === 'a/新名.md', '分支2：挪走+改名按锚点认领');

    /* 分支3：挪回根目录 → 前缀剥掉 */
    reset();
    const man3 = { ITEM01: { file: 'deep/书.md', title: '测试书', hash: 'x', at: 0 } };
    fs.mkdirSync(path.join(tmpRoot, 'deep'));
    fs.writeFileSync(path.join(tmpRoot, 'deep', '书.md'), md('正文'), 'utf8');
    fs.renameSync(path.join(tmpRoot, 'deep', '书.md'), path.join(tmpRoot, '书.md'));
    mk(tmpRoot, man3).detectMoves(true);
    ok(man3.ITEM01.file === '书.md', '分支3：挪回根目录认领为根路径');
    const t3 = fs.readFileSync(path.join(tmpRoot, '书.md'), 'utf8');
    ok(has(t3, '](assets/ITEM01/pic.png)') && !has(t3, '../assets'), '图片引用剥掉 ../');

    /* 分支4：同名两份（无法判定哪份是真的）→ 放弃认领 */
    reset();
    const man4 = { ITEM01: { file: '书.md', title: '测试书', hash: 'x', at: 0 } };
    fs.writeFileSync(path.join(tmpRoot, 'x1.md'), md('A'), 'utf8');
    fs.mkdirSync(path.join(tmpRoot, 'b'));
    fs.writeFileSync(path.join(tmpRoot, 'b', 'x2.md'), md('B'), 'utf8');
    const n4 = mk(tmpRoot, man4).detectMoves(true);
    ok(n4 === 0 && man4.ITEM01.file === '书.md', '分支4：锚点/文件名都无法唯一定位 → 不认领不猜');

    /* 附件：fixAssetLinks 不碰非 assets 链接 */
    const fixed = mk(tmpRoot, {}).fixAssetLinks('[片段：a.mp4](E:/v/a.mp4) ![](assets/i/p.png)', 'd1/d2/x.md');
    ok(has(fixed, '(E:/v/a.mp4)') && has(fixed, '(../../assets/i/p.png)'), '视频片段绝对路径不动，仅 assets 重写');

    /* 节流：非 force 连续调用跳过 */
    reset();
    fs.writeFileSync(path.join(tmpRoot, '书.md'), md('正文'), 'utf8');
    const man5 = { ITEM01: { file: '书.md', title: '测试书', hash: 'x', at: 0 } };
    fs.renameSync(path.join(tmpRoot, '书.md'), path.join(tmpRoot, '书2.md'));
    const m5 = mk(tmpRoot, man5);
    const nA = m5.detectMoves(false);
    const nB = m5.detectMoves(false);
    ok(nA === 1 && nB === 0, '节流生效：3s 内第二次调用直接跳过');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

console.log('—— ③ app.js：Ctrl+N ——');
ok(/\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'n'/.test(A), 'Ctrl / ⌘ + N 绑定存在');
ok(/const ov = \$\('#noteModal'\);\s*if \(ov && !ov\.hidden\) \{ if \(modalEditor\) modalEditor\.focus\(\); return; \}/.test(A), '弹窗已开只聚焦编辑器（防重置草稿丢字）');
ok(/openComposer\('free', null, 'modal'\)/.test(A), '与「✎ 新建笔记」按钮同一入口（居中大窗）');
ok(/e\.preventDefault\(\);\s*const ov = \$\('#noteModal'\)/.test(A), 'preventDefault 挡掉系统新建窗口手势');

console.log('—— ③b 按钮标注 Ctrl+N ——');
const HTML = R('EaglePDFReader/index.html');
const CSS = R('EaglePDFReader/css/app.css');
ok(/btnNoteNew[^>]*>✎ 新建笔记 <span class="kbd-hint">Ctrl\+N<\/span>/.test(HTML), '新建笔记按钮带 Ctrl+N 键帽标注');
ok(has(HTML, '快捷键 Ctrl+N'), '按钮 tooltip 也写明快捷键');
ok(has(CSS, '.note-new-bar .kbd'), '键帽按按钮配色适配（浅色底白字）');

console.log('—— ④ 版本联动 + README ——');
ok(M1.version === '4.3.3' && M2.version === '4.3.3', '双插件版本号一致 4.3.3');
ok(/^\d+\.\d+\.\d+$/.test(M1.version), '版本三段式');
ok(has(RD, '当前版本 **4.3.3**'), 'README 当前版本已更新');
ok(has(RD, '更新记录 · 4.3.3'), 'README 更新记录存在');
ok(has(RD, '文件夹移动') || has(RD, '重新认领'), 'README 描述文件夹认领');
ok(has(RD, 'Ctrl+N'), 'README 描述 Ctrl+N');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
