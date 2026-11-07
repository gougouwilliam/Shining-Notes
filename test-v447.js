/* test-v447.js —— v4.4.7「ESC 完全无感」专项回归
 *
 * 现场（14:02/14:03 debug.log）：
 *   exit.host {"sent":0,"targets":0}   ← parent.postMessage 一个目标都没有
 *   exit.hostclose {"sent":false}
 *   exit.rendererclose {}              ← 600ms 的 window.close() 执行了
 *   exit.stillalive {"sent":false}     ← 但页面还在
 * 用户：「打开插件，无论是否操作，esc 都没作用」。
 *
 * 根因：预览页是 Eagle 主窗口 <webview> 的 **guest 顶层文档**，
 * parent === top === window、opener=null，v4.4.6 的 Exit 消息发不出去；
 * 而 Chromium 只允许脚本关闭「脚本自己打开」的窗口，guest 的
 * window.close() 是空操作。两条出口全断。
 *
 * v4.4.7：主进程 @22653580 的 'plugin.window.webContents.' handler
 * 用 BrowserWindow.fromWebContents(event.sender).webContents 拿到的正是
 * **Eagle 主窗口 webContents**；调它的 executeJavaScript，让主窗口自己
 * window.postMessage('Exit','*')，命中宿主 @1644768 的
 * e.data === 'Exit' → leaveDetailMode()。零窗口 API、不依赖菜单快捷键。
 *
 * 本套件行为级真跑这条链，并把「不许回退到窗口 API」钉成断言。
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
const WG = read('EaglePDFReader/js/winguard.js');
const EG = read('EaglePDFReader/js/escguard.js');
const RD = read('EaglePDFReader/README.md');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));

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

(async function run() {
console.log('—— ① 现场事实：guest 顶层文档，parent/top/opener 全不可达 ——');
ok(/"targets":0/.test(BR) && /"sent":0/.test(BR), '注释记录 14:02 的 targets:0 现场证据');
ok(/顶层/.test(BR) && /parent === top === window/.test(BR), '注释写明 guest 是顶层 browsing context');
ok(/Chromium 只允许/.test(BR), '注释写明渲染层自关为何是空操作');
ok(/window\.close\(\)/.test(BR) === false || /已删除/.test(APP), 'v4.4.6 的无效兜底已被删除');

console.log('—— ② 新通道：主窗口 executeJavaScript（行为级） ——');
{
  const evalSrc = extractFn(BR, 'hostRendererEval');
  ok(!!evalSrc, 'bridge.js 新增 hostRendererEval');
  ok(/plugin\.window\.webContents\./.test(evalSrc) && /executeJavaScript/.test(evalSrc),
    '走 plugin.window.webContents. 的 executeJavaScript，不是 plugin.window. 窗口方法');
  ok(/IPC_WINDOW_DENY/.test(BR), '窗口生命周期方法仍被硬拦截，新通道没绕过红线');

  const calls = [], logs = [];
  let resolveFn, rejectFn;
  const ipc = {
    invoke: (ch, params) => {
      calls.push([ch, params]);
      return new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    }
  };
  const fn = new Function('Dbg', 'require', evalSrc + '\nreturn hostRendererEval;')(
    { log: (k, v) => logs.push([k, v]) },
    () => ({ ipcRenderer: ipc }));
  ok(fn("window.postMessage('Exit','*'); 'eaglenote-exit-ok';", 'exit.host') === true,
    '同步返回 true（已发出），不阻塞退出流程');
  ok(calls.length === 1 && calls[0][0] === 'plugin.window.webContents.' &&
     calls[0][1].method === 'executeJavaScript',
    'invoke 的 channel 与 method 正确');
  ok(/window\.postMessage\('Exit','\*'\)/.test(calls[0][1].value),
    '注入主窗口的代码是 Eagle 官方 Exit 消息');
  resolveFn('eaglenote-exit-ok');
  await Promise.resolve();
  ok(logs.some(([k, v]) => k === 'exit.host.ok' && v.result === 'eaglenote-exit-ok'),
    '★ 返回值哨兵写进 exit.host.ok —— 现场能证明代码真在主窗口执行过');

  const logs2 = [];
  const ipc2 = { invoke: () => Promise.reject(new Error('no handler')) };
  const fn2 = new Function('Dbg', 'require', evalSrc + '\nreturn hostRendererEval;')(
    { log: (k, v) => logs2.push([k, v]) },
    () => ({ ipcRenderer: ipc2 }));
  fn2('x', 'exit.host');
  await Promise.resolve(); await Promise.resolve();
  ok(logs2.some(([k]) => k === 'exit.host.err'),
    'IPC 失败写 exit.host.err，不再静默吞掉（上版只有 sent:true 无法定位）');
}

console.log('—— ③ hostExit 双形态路由（行为级） ——');
{
  const fnSrc = extractFn(BR, 'hostExit');
  ok(!!fnSrc && /postMessage\('Exit', '\*'\)/.test(fnSrc), '发给宿主的消息仍是 "Exit"');
  const mk = (win, evalCalls, logs) => new Function('window', 'Dbg', 'hostRendererEval',
    fnSrc + '\nreturn hostExit;')(
      win, { log: (k, v) => logs && logs.push([k, v]) },
      (code, tag) => { evalCalls.push([code, tag]); return true; });

  /* 形态 A：iframe / 独立窗口，parent 可达 —— 只走旧路，不并发新路 */
  const callsA = [], evalA = [];
  const p = { postMessage: (...a) => callsA.push(a) };
  ok(mk({ parent: p, top: p, opener: null }, evalA, [])() === true &&
     callsA.length === 1 && callsA[0][0] === 'Exit' && evalA.length === 0,
    'parent 可达时只发一条 Exit，不并发 executeJavaScript');

  /* 形态 B：现场 webview guest，targets:0 —— 必须改走新路 */
  const evalB = [], logsB = [];
  const guest = { parent: null, top: null, opener: null };
  ok(mk(guest, evalB, logsB)() === true && evalB.length === 1,
    '★ 现场 targets:0 不再返回 false，改请主窗口自己派发 Exit');
  ok(/window\.postMessage\('Exit','\*'\)/.test(evalB[0][0]) &&
     /eaglenote-exit-ok/.test(evalB[0][0]),
    '执行代码含官方 Exit 消息与返回值哨兵');
  ok(evalB[0][1] === 'exit.host', '结果日志 tag 为 exit.host');
  ok(logsB.some(([k, v]) => k === 'exit.host' && v.via === 'executeJavaScript' && v.targets === 0),
    'exit.host 行记录 via=executeJavaScript / targets=0，现场可判通道');

  /* 形态 C：IPC 完全不可用 —— 诚实返回 false，不假装关掉 */
  const fnC = new Function('window', 'Dbg', 'hostRendererEval', fnSrc + '\nreturn hostExit;')(
    { parent: null, top: null, opener: null }, { log() {} }, () => false);
  ok(fnC === false || fnC() === false, '通道不可用时返回 false，交给 1200ms 提示兜底');
}

console.log('—— ④ 退出分支：零窗口 API、串行补发、快捷键恢复 ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  const seg = APP.slice(k, end);
  ok(i > 0 && k > i && end > k, '能定位到预览退出分支');
  ok(/Bridge\.setHostShortcuts\(false\)/.test(seg), '退出第一件事仍是恢复 Eagle 快捷键');
  ok(/Bridge\.hostExit\(\)/.test(seg), '主路径仍是宿主 Exit');
  ok(!/closeCurrent|closeSelf|destroySelf|ipcWindow|\.destroy\(\)/.test(seg),
    '分支内零窗口 API（绝不重演销毁主窗口）');
  ok(!/window\.close\(\)/.test(seg) && !/window\.closed/.test(seg),
    '删掉无效的渲染层自关兜底，也不依赖浏览器关闭标志');
  ok(/}, 600\);/.test(seg) && /dbg\('exit\.host\.retry'/.test(seg),
    '600ms 串行补发一条（幂等，防 IPC 丢包），不与主路径并发');
  ok(/}, 1200\);/.test(seg) && /dbg\('exit\.stillalive'/.test(seg),
    '1200ms 才给可执行提示');
  ok(/dbg\('exit\.hostclose'/.test(seg), '退出结果写入 debug.log');
}

console.log('—— ⑤ 快捷键隔离不回退（用户要求） ——');
{
  const boot = APP.indexOf("await step('快捷键隔离'");
  const iso = APP.slice(boot, boot + 420);
  ok(boot > 0 && iso.indexOf('setHostShortcuts(false)') < iso.indexOf('setHostShortcuts(true)'),
    '启动先 false 自愈再 true 隔离');
  ok(/setIgnoreMenuShortcuts/.test(BR) && /plugin\.window\.webContents\./.test(BR),
    '仍走官方 webContents 快捷键开关，不碰窗口生命周期');
  ok(/pagehide/.test(APP) && /beforeunload/.test(APP), '卸载/切页都恢复快捷键');
  ok(!/交还宿主/.test(EG) || /不把 ESC 交还宿主/.test(EG), 'ESC 仍由插件吞掉，分级策略不变');
}

console.log('—— ⑥ 文档与版本 ——');
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version),
  '双插件版本一致且三段式（' + M1.version + '）');
ok(/4\.4\.7/.test(RD), 'README 有 4.4.7 更新记录');
ok(/executeJavaScript/.test(RD), 'README 说明新的宿主退出通道');
ok(/"targets":0/.test(WG) && /"sent":0/.test(BR), '注释保留现场证据');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
