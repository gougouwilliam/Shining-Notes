/* test-v449.js —— v4.4.9「快捷键隔离：确认送达 + 生命周期自愈」专项回归
 *
 * 用户需求（2026-11-07 复述）：
 *   ① 打开插件 → 关掉 Eagle 自己的快捷键，避免与插件冲突；
 *   ② 关闭插件 → 立刻恢复；
 *   ③ 开着插件直接关 Eagle、再开 Eagle → Eagle 快捷键必须恢复。
 *
 * 4.4.6 已经用 webContents.setIgnoreMenuShortcuts(true/false) 实现了这套
 * 机制（现场 debug.log 里每次打开是 false→true、退出是 false），但它是
 * 「发出就算」：没有回执、失败不重试、退出时和宿主 Exit 抢跑；第 ③ 条
 * 在「关窗口到托盘、主窗口 webContents 还活着」时可能残留 true。
 *
 * v4.4.9 三层加固：
 *   ① setHostShortcuts 带 shortcuts.ok/err 回执 + 失败补发一次，并提供
 *      shortcutsSettled(ms) 供启动/退出等待落地（带超时，绝不卡死）；
 *   ② 启动 false→true 串行；退出先等 false 落地、显式下线宿主桥、再发 Exit；
 *   ③ 宿主 ESC 桥兼任看门狗：插件 webview 一消失，主窗口自己补发 false，
 *      remove(0/1/2) 三档避免「切条目时误伤刚启动的新 guest」。
 * 全程零 BrowserWindow 方法、ESC 仍不交还宿主、状态运行时不写盘。
 *
 * 本套件用 vm 真跑 bridge.js 与注入主窗口的脚本，不靠静态字符串自欺。
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
const RD = read('EaglePDFReader/README.md');
const VF = read('verify-features.js');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));

/* 用 vm 加载完整 bridge.js */
function loadBridge(invokeImpl) {
  const calls = [], logs = [];
  const ipc = {
    on: () => {},
    invoke: (ch, params) => {
      calls.push([ch, params]);
      return invokeImpl ? invokeImpl(ch, params, calls.length) : Promise.resolve('ok');
    }
  };
  const ctx = {
    console, Promise, Number, isFinite, setTimeout,
    window: { windowID: 8 }, document: { hasFocus: () => false },
    require: (m) => m === 'electron' ? { ipcRenderer: ipc } : (() => { throw new Error('no ' + m); })(),
    Dbg: { log: (k, v) => logs.push([k, v]) }
  };
  vm.createContext(ctx);
  const B = vm.runInContext(BR + '\n;Bridge', ctx);
  return { B, calls, logs };
}

/* 主窗口 mock：webview 列表、焦点、DOM 存活状态、定时器、IPC 都可切换 */
function mockHost() {
  const wv = {
    getWebContentsId: () => 8,
    getURL: () => 'file:///C:/Users/me/Eagle/Plugins/LB7PDFRDK3QM/index.html?id=abc',
    offsetParent: {},
    focus() { this.focused = true; },
    send: (...a) => sent.push(a)
  };
  const sent = [], listeners = {}, restores = [];
  let webviews = [wv], contained = true, timerFn = null, cleared = 0;
  const document = {
    querySelectorAll: () => webviews,
    activeElement: wv,
    contains: () => contained,
    addEventListener: (t, h) => { listeners[t] = h; },
    removeEventListener: (t) => { delete listeners[t]; }
  };
  const ctx = {
    console, Promise, setTimeout,
    setInterval: (fn) => { timerFn = fn; return 77; },
    clearInterval: () => { cleared++; },
    require: (m) => {
      if (m !== 'electron') return null;
      return { ipcRenderer: { invoke: (ch, params) => { restores.push([ch, params]); return Promise.resolve('ok'); } } };
    },
    document,
    window: {}
  };
  vm.createContext(ctx);
  return {
    ctx, wv, sent, listeners, restores,
    run: (code) => vm.runInContext(code, ctx),
    setWebviews: (v) => { webviews = v; },
    setContained: (v) => { contained = v; },
    tick: () => { if (timerFn) timerFn(); },
    get cleared() { return cleared; },
    get state() { return ctx.window.__eaglenoteShortcutRestore; }
  };
}

async function main() {
  console.log('—— ① setHostShortcuts：回执、失败补发、超时保护 ——');
  {
    /* 第一次 reject，第二次 resolve */
    let n = 0;
    const env = loadBridge((ch, params, seq) => {
      n++;
      return n === 1 ? Promise.reject(new Error('IPC lost')) : Promise.resolve('ok');
    });
    ok(env.B.setHostShortcuts(true) === true, '同步返回 true 的旧契约不变（含义＝已发出）');
    const settled = await env.B.shortcutsSettled(500);
    ok(settled === true, 'shortcutsSettled 在补发成功后 resolve(true)');
    ok(env.calls.length === 2 && env.calls.every(c => c[1].method === 'setIgnoreMenuShortcuts' && c[1].value === true),
      '失败只补发一次，两次都发同一个 method/value');
    ok(env.logs.some(([k]) => k === 'shortcuts.set'), '发出写 shortcuts.set');
    ok(env.logs.some(([k, v]) => k === 'shortcuts.err' && /IPC lost/.test(v.error)), '失败写 shortcuts.err（带错误文本）');
    ok(env.logs.some(([k]) => k === 'shortcuts.retry'), '失败自动补发并写 shortcuts.retry');
    ok(env.logs.some(([k]) => k === 'shortcuts.ok'), '落地写 shortcuts.ok 回执');
    ok(env.logs.filter(([k]) => k === 'shortcuts.ok').length === 1, '回执不重复');
  }
  {
    const env = loadBridge(() => Promise.resolve());
    env.B.setHostShortcuts(false);
    const t0 = Date.now();
    const r = await env.B.shortcutsSettled(500);
    ok(r === true && Date.now() - t0 < 400, '正常路径立刻落地，不等满超时');
  }
  {
    /* 永不 resolve 的 IPC：退出/启动都不能被拖死 */
    const env = loadBridge(() => new Promise(() => {}));
    env.B.setHostShortcuts(true);
    const t0 = Date.now();
    const r = await env.B.shortcutsSettled(60);
    ok(r === false && Date.now() - t0 < 400, 'IPC 失联时带超时返回 false，绝不卡住启动/退出');
  }
  {
    const env = loadBridge(() => Promise.reject(new Error('no electron')));
    env.B.restoreHostShortcuts();
    await env.B.shortcutsSettled(500);
    ok(env.calls.every(c => c[1].value === false), 'restoreHostShortcuts 恒发 false');
    ok(/pending\.catch/.test(BR), 'pending.catch 兜底吞掉未等待的 rejection');
  }

  console.log('—— ② app.js 启动/退出顺序：恢复必须先于隔离、先于 Exit ——');
  {
    const iso = APP.indexOf("await step('快捷键隔离'");
    const seg = APP.slice(iso, iso + 420);
    const a = seg.indexOf('setHostShortcuts(false)');
    const b = seg.indexOf('shortcutsSettled');
    const c = seg.indexOf('setHostShortcuts(true)');
    ok(iso > 0 && a >= 0 && b > a && c > b,
      '★ 启动串行：先发 false → 等回执落地 → 再发 true（杜绝乱序覆盖）');
    ok(/setIgnoreMenuShortcuts 是 webContents 运行时状态/.test(APP) || /运行时状态/.test(APP),
      '注释保留「运行时状态、不写盘，Eagle 重启自动复位」');
  }
  {
    const i = APP.indexOf('async function exitPlugin()');
    const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
    const end = APP.indexOf('exiting = false;\n      return;', k);
    const seg = APP.slice(k, end);
    const a = seg.indexOf('setHostShortcuts(false)');
    const b = seg.indexOf('shortcutsSettled(200)');
    const c = seg.indexOf('installHostEscBridge(false)');
    const d = seg.indexOf('Bridge.hostExit()');
    ok(i > 0 && k > i && end > k, '能定位到预览退出分支');
    ok(a >= 0 && b > a && c > b && d > c,
      '★ 退出顺序：发 false → 等落地 → 下线宿主桥 → 最后才发 Exit');
    ok(!/closeCurrent|closeSelf|destroySelf|ipcWindow|\.destroy\(|\.close\(/.test(seg),
      '★ 分支内零窗口 API、零渲染层自关（不重演销毁主窗口）');
  }
  {
    const unload = APP.indexOf("addEventListener('beforeunload'");
    const seg = APP.slice(unload, unload + 600);
    ok(/setHostShortcuts\(false\)/.test(seg) && /installHostEscBridge\(false\)/.test(seg) && /pagehide/.test(seg),
      'beforeunload / pagehide 仍是恢复 + 显式下线桥（覆盖直接关 Eagle）');
  }

  console.log('—— ③ 宿主看门狗：vm 真跑注入主窗口的脚本 ——');
  {
    const env = loadBridge();
    const installCode = env.B.hostEscBridgeCode(8, true);
    const offCode = env.B.hostEscBridgeCode(8, false);
    new Function('return ' + installCode);
    new Function('return ' + offCode);
    ok(true, '安装/卸载脚本语法合法');
    ok(/setIgnoreMenuShortcuts/.test(installCode) && /value: false/.test(installCode),
      '看门狗恢复走官方 webContents 通道、值恒为 false');
    ok(!/BrowserWindow|\.destroy\(|\.close\(|['"]plugin\.window\.['"]/.test(installCode),
      '注入脚本零窗口 API');
    ok(/remove\(2\)/.test(offCode), '显式卸载用 remove(2)：无条件恢复');
  }
  {
    /* 场景 A：插件还在，看门狗不动 */
    const h = mockHost();
    const env = loadBridge();
    ok(h.run(env.B.hostEscBridgeCode(8, true)) === 'installed:ipc',
      '桥安装返回 installed:ipc（现场日志可判主窗口看门狗是否真兜底）');
    h.tick();
    ok(h.restores.length === 0, '插件 webview 仍在时，看门狗不恢复（不干扰隔离）');
    let prevented = 0;
    h.ctx.document.activeElement = {};
    h.listeners.keydown({ key: 'Escape', keyCode: 27, preventDefault: () => prevented++, stopImmediatePropagation: () => {} });
    ok(h.sent.length === 1 && h.sent[0][0] === 'eaglenote:esc' && prevented === 1,
      'ESC 转发桥未回退：焦点在主窗口时转给 guest 并拦截');

    /* 场景 B：webview 消失 → 主窗口自己补发 false，并摘监听/清定时器 */
    h.setContained(false);
    h.setWebviews([]);
    h.tick();
    ok(h.restores.length === 1 && h.restores[0][1].method === 'setIgnoreMenuShortcuts' && h.restores[0][1].value === false,
      '★ 插件消失（关 Eagle 到托盘 / 点 ✕ / 切走）→ 主窗口补发 false');
    ok(!h.listeners.keydown && h.cleared >= 1, '看门狗自清理：摘 keydown、清 interval');
    ok(h.state === 'sent' || h.state === 'ok', '恢复结果写入 window.__eaglenoteShortcutRestore 供排查');
  }
  {
    /* 场景 C：切条目时仍有其它插件 webview → 不误伤新 guest 的 true */
    const h = mockHost();
    const env = loadBridge();
    h.run(env.B.hostEscBridgeCode(8, true));
    const nextWv = Object.assign({}, h.wv, { getWebContentsId: () => 9 });
    h.setContained(false);
    h.setWebviews([nextWv]);
    h.tick();
    ok(h.restores.length === 0 && h.state === 'skipped:plugin-alive',
      '★ 新插件 webview 已就位时跳过恢复（不把新 guest 的 true 冲成 false）');
  }
  {
    /* 场景 D：新桥覆盖旧桥 = remove(0)，不得恢复 */
    const h = mockHost();
    const env = loadBridge();
    h.run(env.B.hostEscBridgeCode(8, true));
    h.run(env.B.hostEscBridgeCode(9, true));
    ok(h.restores.length === 0, '新桥覆盖旧桥只摘监听，绝不误恢复');
  }
  {
    /* 场景 E：插件主动退出 = remove(2)，即使 webview 还在也无条件恢复 */
    const h = mockHost();
    const env = loadBridge();
    h.run(env.B.hostEscBridgeCode(8, true));
    h.run(env.B.hostEscBridgeCode(8, false));
    ok(h.restores.length === 1 && h.restores[0][1].value === false,
      '★ 显式下线桥无条件恢复（退出时 webview 尚未被卸载也不漏）');
    h.setContained(false);
    h.setWebviews([]);
    h.tick();
    ok(h.restores.length === 1, '已下线的桥不会重复恢复（幂等）');
  }
  {
    /* 场景 F：主窗口没有 require 时静默降级，不抛错 */
    const h = mockHost();
    h.ctx.require = undefined;
    const env = loadBridge();
    h.run(env.B.hostEscBridgeCode(8, true));
    h.setContained(false);
    h.setWebviews([]);
    h.tick();
    ok(h.state === 'no-ipc', '主窗口未暴露 ipcRenderer 时标记 no-ipc，静默降级');
  }

  console.log('—— ④ 红线与版本文档 ——');
  ok(/IPC_WINDOW_DENY/.test(BR) && /close|destroy|hide|minimize/.test(BR),
    'IPC_WINDOW_DENY 硬拦截仍在（永不再碰主窗口生命周期）');
  ok(/setIgnoreMenuShortcuts/.test(BR) && !/\.setIgnoreMenuShortcuts\(true\)\s*;\s*[\s\S]{0,80}window\.state/.test(BR),
    '快捷键是 webContents 运行时开关，不写任何磁盘状态');
  ok(M1.version === M2.version && M1.version === '4.4.9' && /^\d+\.\d+\.\d+$/.test(M1.version),
    '双 manifest 同步 4.4.9（' + M1.version + ' / ' + M2.version + '）');
  ok(/## 更新记录 · 4\.4\.9/.test(RD), 'README 有 4.4.9 更新记录');
  ok(/看门狗|自愈|shortcuts\.ok/.test(RD), 'README 说明看门狗与回执');
  ok(/shortcutsSettled|看门狗/.test(VF), 'verify-features 有对应自查项');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
