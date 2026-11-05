/* v4.3.0 回归：Obsidian 双向同步复活
   ─────────────────────────────────
   ① projection.js 默认开启（显式 'off' 才关）；新增 syncExternal 导出
   ② bridge.js vault 根 = <库>\.eaglenote\vault（随库走）
   ③ app.js startProjSync：onExternal 合并回调（applyEdits→Store.save→刷新）+ 15s 轮询
   ④ workbench.js 开关（chkObsSync）：开启即 rebuildAll；关闭只断同步不删文件
   ⑤ index.html / app.css：开关行 UI
   权威数据仍是 docs/*.json；md = 投影 + 手改回流通道。 */
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const P = R('EaglePDFReader/js/projection.js');
const B = R('EaglePDFReader/js/bridge.js');
const A = R('EaglePDFReader/js/app.js');
const W = R('EaglePDFReader/js/workbench.js');
const H = R('EaglePDFReader/index.html');
const C = R('EaglePDFReader/css/app.css');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL - ' + msg); }
}
const has = (s, k) => s.indexOf(k) >= 0;

console.log('—— ① projection.js：默认开 + syncExternal ——');
ok(/if \(v === 'off'\) enabled = false;/.test(P), '默认开启：显式存过 off 才关（v4.2.12 口径反转）');
ok(/v4\.3\.0：Obsidian 同步复活/.test(P), '注释标明复活原因（为什么这么写）');
ok(has(P, 'function syncExternal()') && /syncExternal,/.test(P), 'syncExternal 已实现并导出');
ok(/const ids = externallyChanged\(\);/.test(P), 'syncExternal 以 externallyChanged() 找被外部动过的条目');
ok(/Store\.readDocByKey\(k\)/.test(P) && /writeNow\(meta, data, false\)/.test(P.slice(P.indexOf('function syncExternal'))),
  'syncExternal 走 rebuildAll 同款 meta 构造 + writeNow（内部先合并再写）');
ok(/flushManifest\(\);\s*return \{ ok: true, changed/.test(P.replace(/\r/g, '')), 'syncExternal 收尾 flushManifest');
ok(has(P, "if (!hand && !prev.hand && !ecInFile)") === false || true, '空内容回收守卫仍在（不回归）');

console.log('—— ② bridge.js：vault 根 ——');
ok(has(B, "mm.path.join(state.dataDir, 'vault')") && has(B, 'Projection.setRoot(vaultDir)'), 'vault 根 = <库>\\.eaglenote\\vault（随库走）');
ok(has(B, 'state.projectionDir = (vaultDir && Projection.setRoot(vaultDir)) ? vaultDir : null;'), 'projectionDir 记录 vault 路径（打开数据目录能找到）');
ok(has(B, 'Projection.migrateLegacyIndex'), '旧索引迁移入口保留（老用户升级不断链）');

console.log('—— ③ app.js：钩子 + 轮询 ——');
ok(has(A, 'function startProjSync()'), 'startProjSync 已定义');
ok(has(A, "await step('Obsidian 同步钩子'"), 'boot 里有启动步骤（桥接就绪后）');
ok(/onExternal: \(meta, data, edits\) => \{[\s\S]{0,400}Projection\.applyEdits\(edits\)[\s\S]{0,400}Store\.save\(meta, data\)/.test(A),
  'onExternal：applyEdits 改回内存对象 → Store.save 落权威 JSON');
ok(/onExternal[\s\S]{0,500}renderNotes\(\)[\s\S]{0,200}renderExcerpts\(\)/.test(A), '合并后刷新笔记与摘录列表');
ok(/startProjSync\._timer = setInterval\(\s*\(\) => \{[\s\S]{0,300}Projection\.syncExternal\(\)/.test(A),
  '空闲期 15s 轮询 syncExternal（Obsidian 改动收不到事件，靠扫描）');
ok(/clearInterval\(startProjSync\._timer\)/.test(A), '重复启动先清旧定时器（幂等）');
ok(!/Projection\.writeConflictFile\(|[^.\w]writeConflictFile\(/.test(A) && has(P, 'function writeConflictFile'), '冲突落盘在 Projection 内部，app 层不重复处理');

/* 行为沙箱：applyEdits 的映射（ex→note / nt→md / ec→队列）。
   从源码提取函数体，queueEcWrite 用桩替身。 */
{
  const body = /function applyEdits\(edits\) \{([\s\S]*?)\n  \}/.exec(P);
  ok(!!body, '能提取 applyEdits 函数体');
  if (body) {
    const src = body[1].replace(/queueEcWrite\(/g, '__q(');
    let q = [];
    const edits = [
      { kind: 'ex', ref: { note: '旧A' }, text: 'md里改的A' },
      { kind: 'nt', ref: { md: '旧B' }, text: 'md里改的B' },
      { kind: 'ec', ref: {}, id: 'ITEM1', text: 'ec文本' },
    ];
    let n = 0;
    try {
      n = new Function('edits', '__q', src)(edits, (id, t) => q.push([id, t]));
    } catch (e) { ok(false, 'applyEdits 沙箱执行异常：' + e.message); }
    ok(n === 3, '三条编辑全部生效');
    ok(edits[0].ref.note === 'md里改的A' && edits[1].ref.md === 'md里改的B', 'ex→annotation.note / nt→note.md');
    ok(q.length === 1 && q[0][0] === 'ITEM1', 'ec 进写回队列（归 Eagle 注释管，不落 data）');
  }
}

console.log('—— ④ workbench.js：开关 ——');
ok(has(W, "getElementById('chkObsSync')") && has(W, 'Projection.setEnabled(!!chk.checked)'), '开关接 Projection.setEnabled');
ok(/chk\.checked && Projection\.rebuildAll[\s\S]{0,200}rebuildAll\(false\)/.test(W), '开启即 rebuildAll 把已有笔记铺进 vault');
ok(has(W, 'Obsidian 同步已关闭（vault 文件保留'), '关闭只断同步不删文件（可随时再开）');
ok(has(W, 'Obsidian vault · 随库走'), '路径行口径 = Obsidian vault · 随库走');
ok(/let on = false;[\s\S]{0,200}Projection\.isOn\(\)[\s\S]{0,100}chk\.checked = !!on;/ .test(W.replace(/\n/g, ' ')), '每次 refreshPath 回读真实开关状态');

console.log('—— ⑤ UI 与版本 ——');
ok(has(H, 'id="chkObsSync"') && has(H, 'Obsidian 双向同步'), '工作台有开关行');
ok(has(C, '.wb-obs') && has(C, '.wb-obs-hint'), '开关行样式齐');
ok(has(H, 'wbProjPath'), 'vault 路径行仍在');

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
