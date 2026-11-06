#!/usr/bin/env node
/* test-v441.js —— 修复「ESC 连带 Eagle 一起最小化」（v4.4.1）
 * 根因：预览形态下插件跑在 Eagle 主窗口的 <webview> 里，remote.getCurrentWindow()
 * 和 IPC 的 BrowserWindow.fromWebContents(sender) 都可能指回主窗口；对它 close()
 * 会被 Eagle 的「关闭到托盘」拦成 minimize，插件视图与主界面一起收走。
 * 修复：winguard.closeVerdict 身份裁决 → 关窗链路全过守卫 → 宿主 restore/show 兜底。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const WG = require('./EaglePDFReader/js/winguard.js');
const PJ = read('EaglePDFReader/js/winguard.js');
const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const FW = read('EaglePDFReader/js/framewin.js');
const HTML = read('EaglePDFReader/index.html');
const EG = require('./EaglePDFReader/js/escguard.js');

console.log('—— ① 守卫纯函数：拒绝所有可能关到主窗口的形态 ——');
const denyCases = [
  [{}, 'unknown-mode', '空参数 → 拒绝（形态未知不给关）'],
  [{ mode: 'browser' }, 'browser-mode', '浏览器调试形态 → 拒绝'],
  [{ mode: 'window', selfIsHost: true, selfId: 2, allIds: [1, 2] }, 'flagged-host', '调用方明确标记 selfIsHost → 一票否决'],
  [{ mode: 'preview', parentID: 1, windowID: 1, selfId: 2, allIds: [1, 2] }, 'windowID-is-parent', 'windowID === parentID（跑在主窗口里）→ 拒绝'],
  [{ mode: 'preview', parentID: 1, windowID: 5 }, 'no-self-id', 'webview 形态拿不到 selfId → 拒绝'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 1, allIds: [1, 2] }, 'self-is-parent', 'selfId === parentID（remote 拿到的是主窗口）→ 拒绝'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2 }, 'window-list-unknown', '窗口列表取不到 → 拒绝'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1] }, 'single-window', '系统里只有一个窗口 → 拒绝'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1, 3] }, 'self-not-in-list', 'selfId 不在窗口列表里 → 拒绝'],
  [{ mode: 'preview' }, 'preview-no-self', '预览形态无 parentID 且无 selfId → 拒绝'],
  [{ mode: 'preview', selfId: 2 }, 'preview-unproven', '预览形态无窗口列表佐证 → 拒绝'],
  [{ mode: 'window', selfId: 2, allIds: [1] }, 'single-window', '独立窗口形态但只查到一个窗口 → 拒绝']
];
denyCases.forEach(([env, code, msg]) => {
  const v = WG.closeVerdict(env);
  ok(!v.allow && v.code === code, msg + '（' + v.code + '）');
});

console.log('—— ② 守卫纯函数：能证明是独立窗口才放行 ——');
[
  [{ mode: 'window' }, 'standalone-window', '独立窗口（无 parentID，常规形态）→ 放行'],
  [{ mode: 'window', selfId: 2, allIds: [1, 2] }, 'standalone-window', '独立窗口 + 两个窗口 + selfId 明确 → 放行'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1, 2] }, 'own-window', '预览但确实是独立 BrowserWindow → 放行'],
  [{ mode: 'preview', selfId: 2, allIds: [1, 2] }, 'preview-own-window', '预览形态有窗口列表佐证 → 放行']
].forEach(([env, code, msg]) => {
  const v = WG.closeVerdict(env);
  ok(v.allow && v.code === code, msg + '（' + v.code + '）');
});
ok(WG.idOf('7') === 7 && WG.idOf(0) === null && WG.idOf('') === null && WG.idOf(null) === null,
  'idOf 归一化：数字字符串可转，0/空/null 一律视为未知');
ok(/module\.exports/.test(PJ) && /global\.WinGuard/.test(PJ), '守卫同时挂 window 与 module.exports（可测）');

console.log('—— ③ 加载顺序与取证 ——');
ok(HTML.indexOf('js/winguard.js') > 0 && HTML.indexOf('js/winguard.js') < HTML.indexOf('js/bridge.js'),
  'winguard.js 在 bridge.js 之前加载');
ok(/function windowIdentity\(\)/.test(BR), 'Bridge 有窗口身份取证函数');
ok(/out\.parentID = \(typeof window !== 'undefined'\) \? \(window\.parentID \|\| null\)/.test(BR), '取证 parentID');
ok(/out\.windowID = \(typeof window !== 'undefined'\) \? \(window\.windowID \|\| null\)/.test(BR), '取证 windowID');
ok(/out\.allIds\.push\(all\[i\]\.webContents\.id\)/.test(BR), '取证所有窗口 id');
ok(/out\.selfIsHost = true;/.test(BR), 'selfId === parentID 时标记 selfIsHost');
ok(/return \{ allow: false, code: 'guard-missing' \};/.test(BR), '守卫模块缺失时保守拒绝');
ok(/closeVerdict,\s*\n\s*windowIdentity,/.test(BR), 'closeVerdict / windowIdentity 已导出');

console.log('—— ④ 关窗链路全部过守卫 ——');
ok(/function closeSelf\(\) \{[\s\S]{0,400}?const v = closeVerdict\(\);[\s\S]{0,300}?if \(!v\.allow\)/.test(BR),
  'closeSelf 先过守卫');
ok(/function destroySelf\(\) \{[\s\S]{0,400}?const v = closeVerdict\(\);[\s\S]{0,300}?if \(!v\.allow\)/.test(BR),
  'destroySelf 先过守卫');
ok(/if \(!v\.allow\) \{\s*\n\s*try \{ if \(typeof Dbg !== 'undefined'\) Dbg\.log\('exit\.guard\.deny', v\.code\);/.test(BR),
  '拒绝时写 debug.log（现场可定位）');
ok(/return false;\s*\n\s*\}\s*\n\s*const w = selfWindow\(\);/.test(BR),
  '拒绝分支直接 return false，不碰任何窗口对象');
ok(/function focusParent\(opts\)/.test(BR), 'focusParent 支持 opts');
ok(/\(\!opts \|\| opts\.focus !== false\) && win\.focus/.test(BR),
  'opts.focus === false 时只 restore/show，不抢焦点');
ok(/if \(\!win\) \{\s*\n\s*for \(let i = 0; i < all\.length; i\+\+\)/.test(BR),
  'parentID 找不到宿主时从窗口列表兜底（跳过自己）');
ok(/if \(win\.isMinimized && win\.isMinimized\(\)\) win\.restore\(\);/.test(BR) &&
   /if \(win\.isVisible && \!win\.isVisible\(\)\) win\.show\(\);/.test(BR),
  '恢复动作只有 restore / show，绝不 minimize / hide');

console.log('—— ⑤ exitPlugin：守卫拒绝时零窗口操作 ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const j = APP.indexOf('let verdict = { allow: true', i);
  const k = APP.indexOf("if (!verdict.allow) {", j);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  ok(i > 0 && j > i && k > j && end > k, '能定位到 exitPlugin 的守卫分支');
  const deny = APP.slice(k, end);
  ok(deny.indexOf('closeSelf') < 0 && deny.indexOf('destroySelf') < 0 && deny.indexOf('window.close') < 0,
    '拒绝分支里没有 closeSelf / destroySelf / window.close');
  ok(/Bridge\.focusParent\(\{ focus: false \}\)/.test(deny), '拒绝分支只恢复宿主可见性（不抢焦点）');
  ok(/U\.toast\('当前是 Eagle 预览视图/.test(deny), '拒绝分支给明确提示（不是静默失败）');
  ok(/exiting = false;/.test(deny + 'exiting = false;'), '拒绝后复位 exiting，不会卡住后续退出');
}
ok(/dbg\('exit\.guard', verdict\)/.test(APP), '裁决结果写入 debug.log');
ok(/\[120, 420\]\.forEach\(\(ms\) => setTimeout/.test(APP), '关窗后 120/420ms 两次补恢复');
ok(/setTimeout\(\(\) => \{\s*\n\s*try \{ if \(Bridge\.focusParent\) Bridge\.focusParent\(\{ focus: false \}\);/.test(APP),
  '补恢复只 restore/show，不抢焦点');
ok(/② 老办法一起发[\s\S]{0,220}?只在守卫通过时才发/.test(APP), 'window.close() 只在守卫通过后执行');

console.log('—— ⑥ ESC：政策不变，出口加闸门 ——');
ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '有浮层仍只收浮层');
ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索有字仍先清字');
ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '输入中仍先失焦');
ok(EG.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈仍返回 exit-plugin（用户要求的 ESC 关闭）');
ok(/closeVisibleOverlay\(\)\) return;[\s\S]{0,1400}?exitPlugin\(\);/.test(APP),
  'ESC 兜底关完浮层仍走 exitPlugin（契约不变）');
ok(/}, 260\);\s*\n\s*exitPlugin\(\);/.test(APP), 'ESC 后 260ms 补一次宿主恢复');
ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(
  APP.slice(APP.indexOf("if (e.key === 'Escape') {", 6000), APP.indexOf("if (e.key === 'Escape') {", 6000) + 3000)
), 'ESC 依旧无条件吞掉，不漏给 Eagle 宿主');

console.log('—— ⑦ framewin 兜底链路也不绕过守卫 ——');
ok(/let v = null;[\s\S]{0,300}?global\.Bridge\.closeVerdict\(\)[\s\S]{0,300}?if \(v && \!v\.allow\) \{ log\(\{ act: 'close', blocked: v\.code \}\); return false; \}/
  .test(FW), 'act(close)/window.close 之前先过守卫，拒绝即放弃');
ok(/if \(act\('close'\)\)/.test(FW), '原有兜底链路保留（守卫通过时行为不变）');

console.log('—— ⑧ 版本号与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本一致且三段式（' + M1.version + '）');
const RD = read('EaglePDFReader/README.md');
ok(/当前版本 \*\*4\.4\.1\*\*/.test(RD), 'README 当前版本 4.4.1');
ok(/更新记录 · 4\.4\.1（修复 ESC 连带 Eagle 一起最小化）/.test(RD), 'README 有 4.4.1 更新记录');
ok(/winguard\.js/.test(RD) && /canSelfClosePreview/.test(RD), 'README 记录了守卫与历史回归点');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
