#!/usr/bin/env node
/* test-v445.js —— 预览窗口 ESC 只发一条 destroy（v4.4.5）
 * 现场（08:32 / 08:33 debug.log）：v4.4.4 的 exit.senderclose {"sent":true}
 * 证明 IPC close 发出去了，但窗口没关，同一个 windowID=9 被连按十几次；
 * 而 exit.senderdestroy / exit.stillalive 一行都没有。
 * 根因：主进程 bw.close() 与 renderer 的 window.close() **并发**互相打断，
 *       结果在「宿主一起收走」和「卡住没反应」之间摇摆；且 window.close()
 *       一发出 Chromium 就把 window.closed 提前置 true，exitPlugin 里所有
 *       if (!alive()) 兜底全被短路，硬兜底根本没机会发。
 * 修复：预览分支只发 Bridge.closeCurrent('destroy')（+320ms 补一次防丢包），
 *       不发 window.close / IPC close；兜底 timer 不再用 window.closed 判断；
 *       IPC 的 ok/err 写进 debug.log，不再静默吞失败。
 * 依据：Eagle app.asar 的 ipcMain.handle('plugin.window.') 用
 *       BrowserWindow.fromWebContents(event.sender)，destroy 只作用于发消息的
 *       预览窗口，且不触发 'close' 事件 → 不会触发宿主收起界面的回调。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WG = require('./EaglePDFReader/js/winguard.js');
const EG = require('./EaglePDFReader/js/escguard.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const WG_SRC = read('EaglePDFReader/js/winguard.js');
const EG_SRC = read('EaglePDFReader/js/escguard.js');
const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const ASR = read('EaglePDFReader/js/asr.js');
const RD = read('EaglePDFReader/README.md');

console.log('—— ① 现场裁决不变（v4.4.4 的三级许可完全保留）——');
{
  const live = { mode: 'preview', parentID: 2, windowID: 9, selfId: null, allIds: null, selfIsHost: false };
  const v = WG.closeVerdict(live);
  ok(v.allow === false && v.code === 'no-self-id', 'remote / selfId 通道仍封死');
  ok(v.allowWindowClose === true && v.allowSenderClose === true, '当前窗口与 sender 定向通道放行');
  const host = WG.closeVerdict({ mode: 'preview', parentID: 2, windowID: 2 });
  ok(host.allow === false && host.allowWindowClose === false && host.allowSenderClose === false,
    'windowID === parentID（主窗口）三级全拒');
}

console.log('—— ② 失败复盘写进注释，防止再走回头路 ——');
ok(/v4\.4\.5 复盘/.test(WG_SRC) && /并发/.test(WG_SRC),
  'winguard 记录「close 并发」事故根因');
ok(/window\.closed/.test(WG_SRC) && /短路/.test(WG_SRC),
  'winguard 记录 window.closed 把兜底短路');
ok(/只有 destroy 是/.test(WG_SRC), 'winguard 明确结论：只有 destroy 是出口');
ok(/不把 ESC 交还宿主/.test(EG_SRC), 'escguard 记下 v3.31 放行 ESC 会把整个界面收走');

console.log('—— ③ 预览分支：单一出口，零并发 ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  ok(i > 0 && k > i && end > k, '能定位到预览分支');
  const seg = APP.slice(k, end);

  ok(!/window\.close\(\);/.test(seg), '★ 不再调用 window.close()（干扰源 + window.closed 欺骗源）');
  ok(!/Bridge\.closeCurrent\('close'\)/.test(seg), '★ 不再发 IPC close');
  ok(!/if \(!alive\(\)\) return;/.test(seg), '★ 兜底不再被 window.closed 短路');
  ok((seg.match(/Bridge\.closeCurrent\('destroy'\)/g) || []).length >= 2,
    '主路径 + 320ms 补发共两次 sender destroy（防 IPC 丢包）');
  ok(/}, 320\);/.test(seg) && /}, 900\);/.test(seg), '320ms 补发、900ms 提示的节奏保留');
  ok(/now - exitSentAt < 1200/.test(seg), '连按 ESC 1.2s 防抖');
  ok(/\[120, 420\]\.forEach/.test(seg), '宿主 restore/show 兜底保留（不抢焦点）');
  ok(!/Bridge\.(closeSelf|destroySelf)\(/.test(seg) && !/\.destroy\(\)/.test(seg),
    '不碰 remote 的 closeSelf / destroySelf');
  ok(/dbg\('exit\.destroy'/.test(seg) && /dbg\('exit\.destroy\.retry'/.test(seg) &&
     /dbg\('exit\.stillalive'/.test(seg), 'destroy / retry / stillalive 三级诊断齐全');
  ok(/窗口未关闭，请按空格或点 Eagle 的返回退出预览/.test(seg), '极端情况仍有可执行提示');
  ok(/destroy 不触发/.test(WG_SRC) && /beforeunload/.test(WG_SRC),
    'winguard 注释写明 destroy 绕过 close 事件与 beforeunload');
}

console.log('—— ④ Bridge：IPC 真实结果落盘 ——');
{
  ok(/function ipcWindow\(method, tag\)/.test(BR), 'ipcWindow 支持可选日志 tag');
  ok(/tag \+ '\.ok'/.test(BR) && /tag \+ '\.err'/.test(BR),
    '★ 成功与失败都写 debug.log（v4.4.4 是静默吞掉）');
  ok(/return ipcWindow\(method === 'destroy' \? 'destroy' : 'close', 'exit\.ipc'\);/.test(BR),
    'closeCurrent 带 exit.ipc tag');
  ok(/if \(!v\.allow && !v\.allowSenderClose\) \{/.test(BR), 'closeCurrent 双闸门不变');
  ok(/fromWebContents\(event\.sender\)/.test(BR), '注释保留主进程 sender 定位依据');
}

console.log('—— ⑤ ESC 策略与数据保护不变 ——');
{
  ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '浮层优先');
  ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索优先');
  ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '输入优先');
  ok(EG.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈仍走 exit-plugin');
  ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(
    APP.slice(APP.indexOf("if (e.key === 'Escape') {", 6000), APP.indexOf("if (e.key === 'Escape') {", 6000) + 3000)
  ), '★ ESC 仍无条件吞掉，绝不交还宿主（v3.31 事故）');
  ok(/const onUnloadPersist = \(\) => \{ persist\(true\); \};/.test(APP) &&
     /window\.removeEventListener\('beforeunload', onUnloadPersist\)/.test(APP),
    'beforeunload 摘钩仍在，退出前先落盘');
  ok(!/if \(onProgress\) onProgress\(/.test(ASR), 'ASR 进度回调 typeof 防御未回退');
}

console.log('—— ⑥ 版本与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本一致且三段式');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(/更新记录 · 4\.4\.5（/.test(RD), 'README 有 4.4.5 更新记录小节');
ok(/更新记录 · 4\.4\.4（/.test(RD), 'README 保留 4.4.4 历史小节');
ok(/senderclose/.test(RD) && /并发/.test(RD), 'README 记录现场日志复盘');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
