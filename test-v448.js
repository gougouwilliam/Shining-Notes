/* test-v448.js —— v4.4.8「必须点一下界面才能用 ESC」专项回归
 *
 * 现场（14:18~14:19 debug.log，4.4.7 部署后）：
 *   退出成功的每一次都有
 *     exit.hostclose {sent:true} → exit.host {via:"executeJavaScript"}
 *     → exit.host.ok {result:"eaglenote-exit-ok"}
 *   但用户「用插件直接打开，按 ESC 还是没反应」时 guest 里**一行日志都没有**。
 *   而「必须先点一次插件的界面」才生效 —— 点一下触发 pointerdown 里的
 *   window.focus()，焦点才落到 webview guest。
 *
 * 根因：预览页是 Eagle 主窗口 <webview> 的 guest。刚打开时键盘焦点仍在
 * 主窗口，ESC 不进 guest；插件启动时 setIgnoreMenuShortcuts(true) 又把宿主
 * 菜单快捷键屏蔽了，于是这一下 ESC 谁都没处理。4.4.7 的退出通道本身是对的，
 * 断的是「按键根本没送到」。
 *
 * v4.4.8 两条修复，都只走 'plugin.window.webContents.' 的 executeJavaScript
 * （主窗口 DOM 层），零 BrowserWindow 方法：
 *   ① focusGuest()：主窗口对自己的 <webview> 调 focus()，启动后分 5 次重试；
 *   ② 宿主 ESC 转发桥：焦点仍在主窗口时，捕获 ESC 并用 webview.send 转给
 *      guest → 合成 keydown → 照旧走 escguard 分级 + exitPlugin() 落盘退出。
 *      绝不直接 postMessage('Exit') 绕过落盘，绝不把 ESC 交还宿主。
 *
 * 本套件用 vm 真跑 bridge.js 生成的注入脚本，不靠静态字符串自欺。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const EG = read('EaglePDFReader/js/escguard.js');
const RD = read('EaglePDFReader/README.md');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));

/* 用 vm 加载完整 bridge.js，拿到真实的 Bridge 对象与 ipcRenderer mock */
function loadBridge(overrides) {
  const o = overrides || {};
  const calls = [], handlers = {}, logs = [], dispatched = [];
  const ipc = {
    on: (ch, fn) => { handlers[ch] = fn; },
    invoke: (ch, params) => {
      calls.push([ch, params]);
      return o.invoke ? o.invoke(ch, params) : Promise.resolve('ok');
    }
  };
  function KeyboardEvent(type, init) { this.type = type; Object.assign(this, init || {}); }
  const win = {
    windowID: 8,
    dispatchEvent: (e) => { dispatched.push(e); return true; },
    focus() { this.focused = true; }
  };
  const doc = { hasFocus: () => false, documentElement: { dataset: {} } };
  const ctx = {
    console, Promise, Number, isFinite, setTimeout,
    window: win, document: doc, KeyboardEvent,
    require: (m) => {
      if (m === 'electron') return { ipcRenderer: ipc };
      throw new Error('no module ' + m);
    },
    Dbg: { log: (k, v) => logs.push([k, v]) }
  };
  vm.createContext(ctx);
  const B = vm.runInContext(BR + '\n;Bridge', ctx);
  return { B, calls, handlers, logs, dispatched, win, doc, ipc };
}

/* 主窗口 mock：一个承载本插件的 <webview> */
function mockHost() {
  const sent = [], Ls = {};
  const wv = {
    getWebContentsId: () => 8,
    getURL: () => 'file:///C:/Users/me/Eagle/Plugins/LB7PDFRDK3QM/index.html?id=abc',
    offsetParent: {},
    focus() { this.focused = true; },
    send: (...a) => sent.push(a)
  };
  const document = {
    querySelectorAll: () => [wv],
    activeElement: wv,
    contains: (x) => x === wv,
    addEventListener: (t, h) => { Ls[t] = h; },
    removeEventListener: (t) => { delete Ls[t]; }
  };
  return { sent, Ls, wv, document, window: {}, ctx: null, makeCtx() { return { document: document, window: this.window }; } };
}
const mkEvent = () => {
  const e = { key: 'Escape', keyCode: 27, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } };
  return e;
};

(async function run() {
console.log('—— ① 现场归因与红线（绝不重演销毁主窗口） ——');
ok(/必须先点一下插件界面/.test(BR) && /键盘焦点仍在 Eagle 主窗口/.test(BR),
  'bridge.js 写明 v4.4.8 现场与焦点根因');
ok(/IPC_WINDOW_DENY/.test(BR) && /ipcWindow\.deny/.test(BR),
  '窗口生命周期方法仍被硬拦截');
ok(/closeSelf\.retired/.test(BR) && /destroySelf\.retired/.test(BR),
  '四条历史关窗通道仍全部退役');
ok(/function hostExit\(\)/.test(BR) && /window\.postMessage\('Exit','\*'\)/.test(BR),
  '4.4.7 的宿主 Exit 通道保留，没被新方案替换掉');
ok(/setIgnoreMenuShortcuts/.test(BR), '快捷键隔离不回退');

console.log('—— ② 注入脚本只走 executeJavaScript，零窗口 API ——');
{
  const { B } = loadBridge();
  const f = B.focusGuestCode(8);
  const b = B.hostEscBridgeCode(8, true);
  const off = B.hostEscBridgeCode(8, false);
  let parsed = true;
  try { new Function('return ' + f); new Function('return ' + b); new Function('return ' + off); }
  catch (e) { parsed = false; }
  ok(parsed, 'focus / install / remove 三段注入脚本语法合法');
  ok(!/plugin\.window\.'|BrowserWindow|\.destroy\(|\.close\(|\.minimize\(|\.hide\(/.test(f + b + off),
    '注入代码不含任何窗口生命周期方法');
  ok(/querySelectorAll\('webview'\)/.test(f) && /getWebContentsId\(\) === want/.test(f),
    '按 windowID 精确匹配本插件的 webview，不是随便抓第一个');
  ok(/LB7PDFRDK3QM/.test(f) && /EaglePDFReader/.test(f), 'windowID 缺失时按插件目录 URL 兜底');
  ok(/wv\.focus\(\)/.test(f), '主路径是 webview.focus()（DOM 层）');
  ok(b.indexOf("wv.send('eaglenote:esc')") > 0 &&
     b.indexOf("wv.send('eaglenote:esc')") < b.indexOf("postMessage('Exit'"),
    'ESC 主路径是转发给 guest，直接 Exit 仅作 send 失败后的最后兜底');
  ok(/stopImmediatePropagation/.test(b), '宿主自己的 ESC 处理被挡下（不绕过插件落盘）');
}

console.log('—— ③ focusGuest 行为级：真的把焦点交给 webview ——');
{
  const h = mockHost();
  const { B } = loadBridge();
  const res = vm.runInNewContext(B.focusGuestCode(8), h.makeCtx());
  ok(res === 'focused:true' && h.wv.focused === true,
    '★ 注入主窗口后 webview.focus() 被调用且 activeElement 落在该 webview');

  const { B: B2, calls, logs } = loadBridge({ invoke: () => Promise.resolve('focused:true') });
  const p = B2.focusGuest('focus.host');
  ok(p && typeof p.then === 'function', 'focusGuest 返回 Promise 供上层判据');
  ok(calls.length === 1 && calls[0][0] === 'plugin.window.webContents.' &&
     calls[0][1].method === 'executeJavaScript',
    '走官方 webContents.executeJavaScript 通道，不是 plugin.window.');
  await p;
  await Promise.resolve();
  ok(logs.some(([k, v]) => k === 'focus.host.ok' && v.result === 'focused:true'),
    '宿主执行结果写 focus.host.ok，现场可判焦点是否到位');
}

console.log('—— ④ 宿主 ESC 转发桥行为级 ——');
{
  const h = mockHost();
  const { B } = loadBridge();
  const code = B.hostEscBridgeCode(8, true);
  ok(vm.runInNewContext(code, h.makeCtx()) === 'installed', '桥安装成功');
  ok(!!h.Ls.keydown && !!h.window.__eaglenoteEscBridge, 'keydown 捕获监听 + 幂等句柄都在');

  h.document.activeElement = {};              // 焦点仍在主窗口 = 现场形态
  const e1 = mkEvent();
  h.Ls.keydown(e1);
  ok(h.sent.length === 1 && h.sent[0][0] === 'eaglenote:esc',
    '★ 直接打开就按 ESC：转发一条给 guest（不再是「没反应」）');
  ok(e1.prevented === 1 && e1.stopped === 1,
    'ESC 被 preventDefault + stopImmediatePropagation，绝不交还宿主');

  h.sent.length = 0;
  h.document.activeElement = h.wv;           // 焦点已在 guest
  const e2 = mkEvent();
  h.Ls.keydown(e2);
  ok(h.sent.length === 0 && e2.prevented === 0,
    '点过界面后不重复转发（guest 自己处理，避免双触发）');

  h.sent.length = 0;
  h.document.activeElement = { tagName: 'WEBVIEW' };
  h.Ls.keydown(mkEvent());
  ok(h.sent.length === 0, 'activeElement 是 WEBVIEW 时同样不重复转发');

  h.document.contains = () => false;         // webview 已被宿主卸载
  const e3 = mkEvent();
  h.Ls.keydown(e3);
  ok(e3.prevented === 0 && !h.Ls.keydown && !h.window.__eaglenoteEscBridge,
    '★ 残留桥自清理且不拦截 Eagle 后续按键（不留副作用）');

  const h2 = mockHost();
  vm.runInNewContext(B.hostEscBridgeCode(8, true), h2.makeCtx());
  ok(vm.runInNewContext(B.hostEscBridgeCode(8, false), h2.makeCtx()) === 'removed' &&
     !h2.Ls.keydown, 'installHostEscBridge(false) 显式卸载桥');
}

console.log('—— ⑤ guest 接收器：合成 ESC 仍走插件原有分级与落盘 ——');
{
  const env = loadBridge();
  ok(!!env.handlers['eaglenote:esc'], '脚本加载即注册 eaglenote:esc 接收器（不等 boot）');
  env.handlers['eaglenote:esc']();
  ok(env.dispatched.length === 1 && env.dispatched[0].key === 'Escape' &&
     env.dispatched[0].cancelable === true,
    '★ 转成 cancelable 的合成 keydown，命中 app.js 的 window 捕获监听');
  ok(env.logs.some(([k]) => k === 'hostesc.recv'), '转发写 hostesc.recv 诊断');
  ok(/escguard/.test(APP) || /EscGuard/.test(APP), 'ESC 决策仍交给 escguard');
  ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(APP),
    'ESC 仍无条件吞掉（分级策略一行没改）');
  ok(/return 'exit-plugin'/.test(EG) || /'exit-plugin'/.test(EG), 'escguard 最后一档仍是 exit-plugin');
  ok(/exitPlugin\(\)/.test(APP) && /persist\(true\)/.test(APP),
    '落盘 → 退出链路不变（转发不是「直接关预览」）');
}

console.log('—— ⑥ app.js 接线时机 ——');
{
  const bootSync = APP.indexOf("sync('宿主 ESC 转发桥'");
  const readyAt = APP.indexOf("step('连接 Eagle'");
  ok(bootSync > 0 && bootSync < readyAt,
    '★ 桥在 boot 同步段就挂上，不等 Bridge.ready() 的异步等待');
  const focusAt = APP.indexOf("step('接管键盘焦点'");
  ok(focusAt > readyAt && focusAt < APP.indexOf("step('快捷键隔离'"),
    'ready 之后用精确 windowID 重挂桥并接管焦点，早于快捷键隔离');
  const seg = APP.slice(focusAt, focusAt + 1100);
  ok(/installHostEscBridge\(true\)/.test(seg), '重挂桥（幂等）');
  ok(/\[0, 150, 450, 1000, 2000\]/.test(seg) && /focusGuest\(/.test(seg),
    '5 次焦点重试，覆盖 webview 创建 / 主窗口抢回 / 首屏渲染');
  ok(/focus\.self/.test(seg) && /hasFocus/.test(seg), '每次把 hasFocus 与宿主返回值写日志');
  const unload = APP.indexOf('const onUnloadPersist');
  const unloadSeg = APP.slice(unload, unload + 700);
  ok(/installHostEscBridge\(false\)/.test(unloadSeg) && /pagehide/.test(unloadSeg),
    'beforeunload / pagehide 都卸载桥');
  ok(/Dbg\.log\('esc\.key'/.test(APP) && /isTrusted/.test(APP),
    'ESC 现场日志区分 real / host 来源');
}

console.log('—— ⑦ 退出分支没有回退到窗口 API ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  const seg = APP.slice(k, end);
  ok(i > 0 && k > i && end > k, '能定位预览退出分支');
  ok(/Bridge\.setHostShortcuts\(false\)/.test(seg) && /Bridge\.hostExit\(\)/.test(seg),
    '仍是恢复快捷键 → 宿主 Exit');
  ok(!/closeCurrent|closeSelf|destroySelf|ipcWindow|\.destroy\(\)|window\.close\(\)/.test(seg),
    '★ 分支内零窗口 API、零渲染层自关（绝不重演销毁主窗口）');
  ok(/dbg\('exit\.host\.retry'/.test(seg) && /}, 600\);/.test(seg),
    '600ms 串行补发保持');
}

console.log('—— ⑧ 文档与版本 ——');
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version),
  '双插件版本一致且三段式（' + M1.version + '）');
ok(/4\.4\.8/.test(RD), 'README 有 4.4.8 更新记录');
ok(/4\.4\.7/.test(RD), '4.4.7 事故审计记录保留（不重写历史）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
