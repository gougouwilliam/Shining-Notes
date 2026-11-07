/* test-v446.js —— v4.4.6 事故修复专项回归
 *
 * 事故：v4.4.4 / v4.4.5 通过 plugin.window. 发 bw.close() / bw.destroy()，
 * 实际销毁的是 Eagle 主窗口（预览页跑在主窗口 <webview> 里，
 * BrowserWindow.fromWebContents(event.sender) 返回宿主窗口）。
 * 现场：debug.log [env] {"bw":"max"}；log.log 连续
 * "TypeError: Object has been destroyed at MenuItem.click"；
 * 用户「一起退出」「最小化后双击打不开」。
 *
 * 本套件把「永不再碰主窗口」做成可执行断言，并覆盖用户要求的
 * 快捷键隔离（开启即关、退出即恢复、重启后自愈）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const FW = read('EaglePDFReader/js/framewin.js');
const WG = read('EaglePDFReader/js/winguard.js');
const EG = read('EaglePDFReader/js/escguard.js');
const HTML = read('EaglePDFReader/index.html');
const RD = read('EaglePDFReader/README.md');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));

/* 从 bridge.js 里抠出一个完整的具名函数源码，供 new Function 真跑 */
function extractFn(src, name) {
  const start = src.indexOf('  function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

console.log('—— ① 硬事实：预览是主窗口 webview，不是独立窗口 ——');
ok(/webview\.getWebContentsId\(\)/.test(BR) || /<webview>/.test(WG),
  '代码写明 windowID 来自 webview.getWebContentsId()');
ok(/BrowserWindow\.fromWebContents\(event\.sender\)/.test(BR) && /Eagle 主窗口/.test(BR),
  '代码写明 sender 定位返回的是 Eagle 主窗口');
ok(/"bw":"max"/.test(WG) && /Object has been destroyed/.test(WG),
  '注释保留现场证据：bw:"max" 与托盘菜单报错');
ok(/v4\.4\.3 的判断是错的/.test(WG), 'v4.4.3 的事实误判已被明确作废');
ok(/v4\.4\.6 事实更正/.test(EG), 'escguard 同步更正，避免再次误导');

console.log('—— ② 红线：关闭类 IPC 在 bridge 层硬拦截（行为级） ——');
{
  const denyLine = BR.slice(BR.indexOf('const IPC_WINDOW_DENY'), BR.indexOf('\n', BR.indexOf('const IPC_WINDOW_DENY')));
  const fnSrc = extractFn(BR, 'ipcWindow');
  ok(!!fnSrc && /IPC_WINDOW_DENY\.test/.test(fnSrc), 'ipcWindow 里有硬拦截判断');
  const calls = [];
  const ipc = { invoke: (ch, params) => { calls.push([ch, params]); return Promise.resolve(); } };
  const req = () => ({ ipcRenderer: ipc });
  const Dbg = { log() {} };
  const fn = new Function('Dbg', 'require', denyLine + '\n' + fnSrc + '\nreturn ipcWindow;')(Dbg, req);
  const dangerous = ['close', 'destroy', 'hide', 'minimize', 'maximize', 'unmaximize',
    'show', 'showInactive', 'focus', 'restore', 'setFullScreen', 'setAlwaysOnTop'];
  let blocked = 0;
  for (const m of dangerous) { if (fn(m) === false && calls.length === 0) blocked++; }
  ok(blocked === dangerous.length, '12 个窗口生命周期/可见性方法一律拒绝且不发 IPC（' + blocked + '/' + dangerous.length + '）');
  ok(fn('isMaximized') === true && calls.length === 1 && calls[0][1].method === 'isMaximized',
    '只读探测 isMaximized 仍放行（环境自检不被误伤）');
}

console.log('—— ③ 四条历史关窗通道全部退役 ——');
{
  const cs = extractFn(BR, 'closeSelf') || '';
  const ds = extractFn(BR, 'destroySelf') || '';
  ok(/return false;/.test(cs) && !/w\.close\(\)/.test(cs),
    'closeSelf 恒 false，函数体内已无 w.close()');
  ok(/return false;/.test(ds) && !/w\.destroy\(\)/.test(ds),
    'destroySelf 恒 false，函数体内已无 w.destroy()');
}
ok(/function closeCurrent\(method\) \{[\s\S]{0,320}?return false;/.test(BR),
  'closeCurrent 恒 false，不再转发 destroy/close');
ok(/function closeWindow\(\) \{[\s\S]{0,220}?return false;/.test(BR) && !/eagle\.window\.hide/.test(BR),
  'closeWindow 恒 false，不再调 eagle.window.hide');
ok(!/Bridge\.closeSelf\(\)/.test(APP) && !/Bridge\.destroySelf\(\)/.test(APP) &&
   !/closeCurrent\('destroy'\)/.test(APP), 'app.js 退出流程零关窗 API 调用');
ok(!/br\.closeSelf\(\)/.test(FW) && !/br\.destroySelf\(\)/.test(FW) &&
   !/if \(act\('close'\)\)/.test(FW) && !/global\.close\(\)/.test(FW),
  'framewin 兜底链路已清空，只剩 App.exit / hostExit');

console.log('—— ④ hostExit：用 Eagle 官方 "Exit" 消息退出（行为级） ——');
{
  const fnSrc = extractFn(BR, 'hostExit');
  const evalSrc = extractFn(BR, 'hostRendererEval');
  ok(!!fnSrc && /postMessage\('Exit', '\*'\)/.test(fnSrc), '发给宿主的正是 "Exit"');
  ok(!!evalSrc && /executeJavaScript/.test(evalSrc) && /plugin\.window\.webContents\./.test(evalSrc),
    'v4.4.7：无宿主引用时走主窗口 executeJavaScript 通道');
  /* 把 hostRendererEval 作为可注入桩，行为级真跑 hostExit */
  const mk = (win, evalCalls) => new Function('window', 'Dbg', 'hostRendererEval',
    fnSrc + '\nreturn hostExit;')(
      win, { log() {} }, (code, tag) => { evalCalls.push([code, tag]); return true; });
  const calls = [];
  const parent = { postMessage: (...a) => calls.push(a) };
  const evalCalls = [];
  const fn = mk({ parent: parent, top: parent, opener: null }, evalCalls);
  ok(fn() === true && calls.length === 1 && calls[0][0] === 'Exit' && calls[0][1] === '*',
    'parent 有效时只发一条 Exit 给宿主，不重复发');
  ok(evalCalls.length === 0, 'parent 可达时不走 executeJavaScript（不并发）');
  const calls2 = [];
  const p2 = { postMessage: (...a) => calls2.push(a) };
  const fn2 = mk({ parent: p2, top: p2, opener: p2 }, []);
  ok(fn2() === true && calls2.length === 1, 'parent/top/opener 指向同一对象时去重，不并发');
  /* ★ 现场形态：guest 顶层文档，parent/top/opener 全为空（14:02 targets:0） */
  const evalCalls3 = [];
  const fn3 = mk({ parent: null, top: null, opener: null }, evalCalls3);
  ok(fn3() === true && evalCalls3.length === 1,
    '★ 现场 targets:0 时不再返回 false，改为请主窗口自己派发 Exit');
  ok(/window\.postMessage\('Exit','\*'\)/.test(evalCalls3[0][0]) &&
     /eaglenote-exit-ok/.test(evalCalls3[0][0]),
    '执行的是官方 Exit 消息，并带可验证的返回值哨兵');
  ok(evalCalls3[0][1] === 'exit.host', '结果写入 exit.host.ok / exit.host.err 便于现场定位');
  ok(/e\.data === "Exit"/.test(BR) && /leaveDetailMode/.test(BR),
    '注释写明宿主侧 message==="Exit" → leaveDetailMode()');
}

console.log('—— ⑤ 快捷键隔离：开启即关、退出即恢复、启动自愈 ——');
{
  const fnSrc = extractFn(BR, 'setHostShortcuts');
  ok(!!fnSrc && /setIgnoreMenuShortcuts/.test(fnSrc), '走官方 webContents.setIgnoreMenuShortcuts');
  ok(/plugin\.window\.webContents\./.test(fnSrc), '走 plugin.window.webContents. 通道（非窗口生命周期）');
  const calls = [];
  const ipc = { invoke: (ch, params) => { calls.push([ch, params]); return Promise.resolve(); } };
  const fn = new Function('Dbg', 'require', fnSrc + '\nreturn setHostShortcuts;')(
    { log() {} }, () => ({ ipcRenderer: ipc }));
  ok(fn(true) === true && calls[0][1].method === 'setIgnoreMenuShortcuts' && calls[0][1].value === true,
    '插件开启 → ignored=true（关掉 Eagle 菜单快捷键）');
  ok(fn(false) === true && calls[1][1].value === false,
    '插件关闭 → ignored=false（恢复 Eagle 快捷键）');
  ok(/pending\.catch/.test(fnSrc), 'IPC reject 被吞掉，不制造 UnhandledRejection');
  const bootIdx = APP.indexOf("await step('连接 Eagle'");
  const isoIdx = APP.indexOf("await step('快捷键隔离'");
  ok(bootIdx > 0 && isoIdx > bootIdx, '启动流程里连接 Eagle 后立刻做快捷键隔离');
  const isoSeg = APP.slice(isoIdx, isoIdx + 420);
  ok(isoSeg.indexOf('setHostShortcuts(false)') < isoSeg.indexOf('setHostShortcuts(true)'),
    '先无条件恢复一次（自愈上次残留），再开启隔离');
  ok(/运行时状态/.test(BR) && (/不持久化|不写盘/.test(BR)),
    '注释写明这是运行时状态、不持久化（Eagle 重启自动复位）');
  ok(/pagehide/.test(APP) && /setHostShortcuts\(false\)/.test(APP.slice(APP.indexOf("addEventListener('beforeunload'"), APP.indexOf("addEventListener('beforeunload'") + 600)),
    'beforeunload / pagehide 都恢复，覆盖「插件界面里直接退出 Eagle」');
}
{
  const i = APP.indexOf('async function exitPlugin()');
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  const seg = APP.slice(k, end);
  ok(i > 0 && k > i && end > k, '能定位到预览退出分支');
  ok(/Bridge\.setHostShortcuts\(false\)/.test(seg), '退出第一件事就是恢复 Eagle 快捷键');
  ok(/Bridge\.hostExit\(\)/.test(seg), '主路径是宿主 Exit 消息');
  ok(!/closeCurrent|closeSelf|destroySelf|ipcWindow/.test(seg), '分支内零窗口 API');
  ok(/}, 600\);/.test(seg) && /dbg\('exit\.host\.retry'/.test(seg) &&
     !/window\.close\(\)/.test(seg), 'v4.4.7：600ms 串行补发 hostExit，删掉无效的 window.close() 兜底');
  ok(!/window\.closed|!alive\(\)/.test(seg), '兜底不再被 window.closed 短路');
  ok(/dbg\('exit\.hostclose'/.test(seg) && /dbg\('exit\.stillalive'/.test(seg), '退出结果写入 debug.log');
}

console.log('—— ⑥ ESC 策略与数据保护未回退 ——');
ok(EG.indexOf('不把 ESC 交还宿主') > -1, 'ESC 仍无条件吞掉，绝不交还宿主');
ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(APP), 'app.js 仍 preventDefault + stopPropagation');
const EGmod = require('./EaglePDFReader/js/escguard.js');
ok(EGmod.escapeAction({ depth: 1 }) === 'pop-layer', '浮层优先');
ok(EGmod.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈仍走 exit-plugin');
ok(/persist\(true\)/.test(APP) && /detachUnloadPersist\(\)/.test(APP), '退出前落盘 + 摘 beforeunload 仍在');
ok(/flushDrafts\(\)/.test(APP), '草稿保存未回退');
const WGmod = require('./EaglePDFReader/js/winguard.js');
ok(WGmod.closeVerdict({ mode: 'preview', parentID: 2, windowID: 9, selfId: null, allIds: null, selfIsHost: false }).allow === false,
  '现场形态的 allow 仍为 false（守卫契约不变）');
ok(WGmod.closeVerdict({ mode: 'preview', parentID: 2, windowID: 2 }).allowWindowClose === false,
  '主窗口形态三级全拒');
ok(HTML.indexOf('js/winguard.js') < HTML.indexOf('js/bridge.js'), 'winguard 先于 bridge 加载');

console.log('—— ⑦ 版本与文档 ——');
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version),
  '双插件版本一致且三段式（' + M1.version + '）');
ok(/v4\.4\.6|4\.4\.6/.test(RD), 'README 有 4.4.6 更新记录');
ok(/setIgnoreMenuShortcuts|快捷键/.test(RD), 'README 说明快捷键隔离行为');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
