/* v3.36.2 回归：代码体检（功能与交互规范对照）后的三件收口
 *
 * 1. Undo 模块此前在 FEATURES 里一直挂 🟡（有实现、无测试），而它管着
 *    「Ctrl+Z 撤销删错数据」—— 上一版还精简过它的导出面。
 *    这里用 vm 真跑：基本环 / 防重入 / 栈深 / 清栈 / 抛错不崩，一条不落。
 * 2. 全库索引 index.json 补成 tmp+rename 原子写（P2），断言写入顺序。
 * 3. 交互铁律静态断言（对应 deliverables/插件功能与交互规范.md §3）：
 *    ESC 不关窗、输入法保护、keyup 兜底、视频顶栏隐藏清单、顶栏假出口不复活。
 *
 * 运行：node test-v338.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ============ 1. Undo 模块 vm 真跑 ============ */
console.log('\n[1] Undo 模块真跑');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
try {
  vm.runInContext(read('EaglePDFReader/js/undo.js'), sandbox, { filename: 'undo.js' });
  const U = sandbox.window.Undo;
  ok(typeof U === 'object' && U, 'undo.js 在 vm 里求值成功并挂到 window.Undo');
  ok(typeof U.push === 'function' && typeof U.undo === 'function' && typeof U.redo === 'function', '导出 push/undo/redo 齐全');
  ok(typeof U.clear === 'function' && typeof U.size === 'function' && typeof U.run === 'function', '导出 clear/size/run 齐全');

  /* 精简后的公开面：早期那批 canUndo/canRedo/lastLabel/isMuted 必须不在 */
  const exported = ['push', 'undo', 'redo', 'clear', 'size', 'run'];
  ok(Object.keys(U).length === exported.length && exported.every((k) => k in U),
    '公开面收敛为 ' + exported.join('/') + '（无 isMuted 等残留）');

  ok(U.size() === 0, '初始栈空');
  let r = U.undo();
  ok(r && r.ok === false, '空栈 undo 返回 {ok:false}');

  let log = [];
  U.push('加一条',
    () => log.push('undo:加一条'),
    () => log.push('redo:加一条'));
  ok(U.size() === 1, 'push 后栈深 1');
  r = U.undo();
  ok(r.ok === true && r.label === '加一条', 'undo 返回 ok 与 label');
  ok(log.join(',') === 'undo:加一条', 'undo 执行了闭包');
  r = U.redo();
  ok(r.ok === true, 'redo ok');
  ok(log.join(',') === 'undo:加一条,redo:加一条', 'redo 执行了闭包');

  /* push 必须清空 redo 栈：撤销后做了新动作，重做线作废 */
  U.clear();
  log = [];
  U.push('a', () => log.push('ua'), () => log.push('ra'));
  U.undo();
  U.push('b', () => log.push('ub'), () => log.push('rb'));
  r = U.redo();
  ok(r.ok === false, 'push 之后 redo 栈已被清空（{ok:false}）');
  ok(log.join(',') === 'ua', 'redo 没有执行任何闭包');

  /* muted：撤销执行期间 push 不入栈（防一次 Ctrl+Z 弹出多层） */
  U.clear();
  U.run(() => {
    U.push('nested', () => {}, () => {});
  });
  ok(U.size() === 0, 'run() 期间 push 被静音，不入栈');

  /* 栈深 60：第 61 条把最早的挤出去 */
  U.clear();
  for (let i = 0; i < 65; i++) U.push('op' + i, () => {}, () => {});
  ok(U.size() === 60, '超过 LIMIT=60 后栈深停在 60');
  r = U.undo();
  ok(r.label === 'op64', '弹出的是最新一条 op64');
  let drained = 0;
  while (U.undo().ok) drained++;
  ok(drained === 59 && U.size() === 0, '剩余 59 条全部可撤销，op0～op4 已被挤出');

  /* clear：换文档必须清栈（防跨文档回写） */
  for (let i = 0; i < 3; i++) U.push('x' + i, () => {}, () => {});
  U.clear();
  ok(U.size() === 0 && U.undo().ok === false, 'clear 后栈空、undo 无效');

  /* 闭包抛错不崩：失败只 warn，栈照常前进 */
  U.clear();
  U.push('boom', () => { throw new Error('x'); });
  r = U.undo();
  ok(r && r.ok === true, 'undo 闭包抛错也不崩，仍返回 ok');

  /* 换文档清栈的应用侧接线 */
  const app = read('EaglePDFReader/js/app.js');
  ok((app.match(/Undo\.clear\(\)/g) || []).length >= 3, 'app.js 换文档路径调用 Undo.clear() ≥3 处');
} catch (e) {
  ok(false, 'Undo vm 真跑抛错: ' + e.message);
}

/* ============ 2. index.json 原子写 ============ */
console.log('\n[2] index.json 原子写（P2 修复）');
{
  const s = read('EaglePDFReader/js/store.js');
  const i = s.indexOf("pathMod.join(dataDir, 'index.json')");
  ok(i >= 0, 'rebuildIndex 写 index.json 的位置存在');
  const seg = s.slice(Math.max(0, i - 120), i + 320);
  ok(/const f = pathMod\.join\(dataDir, 'index\.json'\);/.test(seg), '写入前先取 f');
  ok(seg.indexOf("const tmp = f + '.tmp';") >= 0, '先写 tmp');
  ok(/fs\.writeFileSync\(tmp, JSON\.stringify\(indexCache\)/.test(seg), 'writeFileSync 落在 tmp 上');
  ok(seg.indexOf('fs.renameSync(tmp, f);') > seg.indexOf("fs.writeFileSync(tmp,"), 'rename 在 write 之后（tmp+rename 原子替换）');
  ok(!/fs\.writeFileSync\(f,/.test(seg), '不再直接覆写目标文件');
}

/* ============ 3. 交互铁律静态断言 ============ */
console.log('\n[3] 交互铁律（规范 §3）');
{
  const app = read('EaglePDFReader/js/app.js');
  const esc = read('EaglePDFReader/js/esc.js');
  const html = read('EaglePDFReader/index.html');
  const fw = read('EaglePDFReader/js/framewin.js');
  const eg = read('EaglePDFReader/js/escguard.js');

  /* 3.1 ESC 永不关窗 —— 剥注释再查：历史说明里会提到 closeWindow/window.close 这些名字 */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const escCode = strip(esc), appCode = strip(app);
  ok(escCode.indexOf('closeWindow') < 0 && escCode.indexOf('exitPlugin') < 0 && escCode.indexOf('closeSelf') < 0,
    'esc.js 显示栈内无任何关窗出口（剥注释后 0 命中）');

  /* escguard 行为级真跑：四档判定，且不存在「退出插件」档 */
  const sb2 = { window: {}, module: { exports: {} } };
  vm.createContext(sb2);
  vm.runInContext(eg, sb2, { filename: 'escguard.js' });
  const EG = sb2.window.EscGuard;
  ok(EG && typeof EG.escapeAction === 'function', 'escguard.js 真跑成功（window.EscGuard）');
  ok(EG.escapeAction({ depth: 2 }) === 'pop-layer', '有浮层 → pop-layer（只弹栈顶）');
  ok(EG.escapeAction({ searchActive: true }) === 'clear-search', '搜索有字 → 只清搜索');
  ok(EG.escapeAction({ typing: true }) === 'blur', '正在输入 → 失焦');
  ok(EG.escapeAction({}) === 'exit-plugin', '其余 → exit-plugin（v4.4.0：ESC 关闭插件，用户要求恢复）');
  ok([EG.escapeAction({ depth: 1 }), EG.escapeAction({ searchActive: 1 }), EG.escapeAction({ typing: 1 }), EG.escapeAction({})]
    .every((v) => v !== 'close'), 'v4.4.0：四档只有最后一档允许 exit-plugin，无历史遗留的 close 档');

  const kdStart = appCode.indexOf('function onKeyDown');
  const kdEnd = appCode.indexOf('\n  function ', kdStart + 10);
  const kd = appCode.slice(kdStart, kdEnd > 0 ? kdEnd : undefined);
  ok(!/window\.close\(\)/.test(kd), 'ESC keydown 处理区内无 window.close()（剥注释）');

  /* 3.1-4 输入法保护 */
  ok((app.match(/isComposing \|\| e\.keyCode === 229/g) || []).length >= 2,
    'app.js 输入法保护（isComposing||229）≥2 处（Ctrl+Enter 兜底 + ESC）');

  /* 3.1-2 keyup 220ms 兜底 */
  ok(app.indexOf("document.addEventListener('keyup'") >= 0, 'keydown 被原生控件吞掉时 keyup 兜底存在');

  /* 3.2 退出通道唯一 */
  ok(app.indexOf('exit: exitPlugin') >= 0, 'App.exit 暴露给 ✕/framewin 复用（同一条路）');

  /* 2.2 视频模式顶栏隐藏清单（v3.38 加入 AI 总结按钮） */
  ok(app.indexOf("['#pageGroup', '#swatchBar', '#toolGroup', '#searchBox', '#btnAiSummary']") >= 0,
    'applyModeUI 视频模式隐藏 页码/色板/工具/搜索/AI总结');

  /* 2.1 顶栏假出口不复活 */
  ok(html.indexOf('id="btnQuit"') < 0, '顶栏没有假出口 ✕（v3.30 删除后不得回潮）');
  ok(html.indexOf('id="btnWorkbench"') >= 0 && html.indexOf('id="btnTheme"') >= 0,
    '顶栏右侧保留 工作台 / 明暗 两键');

  /* 2.4 启动器窗口三按钮 */
  ok(/getElementById\('winMin'\)/.test(fw) && /getElementById\('winMax'\)/.test(fw) && /getElementById\('winClose'\)/.test(fw),
    'framewin 绑定 最小化/最大化/关闭 三按钮');
  ok(fw.indexOf('if (bound)') >= 0, 'framewin init 幂等（bound 防重复绑定）');
  ok(fw.indexOf("setTimeout(() => refresh(bar), 80)") >= 0 && fw.indexOf("setTimeout(() => refresh(bar), 260)") >= 0,
    '最大化后 80/260ms 双重复核图标');

  /* 3.4 卡片图片不可拖 */
  ok(app.indexOf('draggable') >= 0 || /no-drag/.test(read('EaglePDFReader/css/app.css')),
    '卡片图片禁拖（draggable=false 或 no-drag）');

  /* 版本 */
  const mf = JSON.parse(read('EaglePDFReader/manifest.json'));
  const wb = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(mf.version) && /^\d+\.\d+\.\d+$/.test(wb.version), '两个插件版本均为合法三段式（版本无关）');
}

console.log('\n========================================');
console.log(`  PASS ${pass}  FAIL ${fail}  (test-v338)`);
console.log('========================================');
process.exit(fail ? 1 : 0);
