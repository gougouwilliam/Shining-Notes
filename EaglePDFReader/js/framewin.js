/* framewin.js —— 无边框窗口的自绘标题栏（v3.20，v3.34 修「三个按钮都点不动」）
 *
 * 背景：Eagle 的插件窗口一律 `frame: true`，Windows 会用系统主题给它们画标题栏。
 * 查 Eagle 源码（app.asar）确认它从不设置 nativeTheme.themeSource，
 * 所以浅色系统下所有插件窗口都是白标题栏——插件代码改不了原生边框的颜色。
 * 唯一能做出「和 Eagle 一样的深色窗口」的办法：manifest 里 `frame: false` 去掉原生边框，
 * 自己画一条深色标题栏 + 三个按钮（最小化 / 最大化 / 关闭）。
 *
 * 只在「闪灵面板」启动器打开的窗口里启用（URL 带 launcher=1），
 * 直接打开的主窗口保持原生边框，行为与以前一致。
 *
 * ── v3.34 的两个坑（用户实测：✕ / 最小化 / 最大化 全都点不动）──────
 * 1) **handler 一个都没绑上**。init() 以前要求 `isLauncher() && eagle.window 都在`，
 *    而 isLauncher() 读的是 `Bridge.state.query.launcher` —— 那个对象要等
 *    Bridge.ready()（异步、最多等 1 秒 Eagle）跑完才被赋值，而 init() 在同步启动段
 *    就执行完了。于是判断永远为假、init 直接 return false，三个按钮全是死的。
 *    界面上那条标题栏之所以还在，是 index.html 里那段内联脚本按 location.search
 *    把 .frameless / hidden 打开了 —— 看得见、点不动，正好就是这个现象。
 *    现在：判据直接读 location.search（和那段内联脚本同一个正则），
 *    并且**不再要求 eagle.window 存在**（它同样可能晚到）。
 * 2) **关窗不能用 window.close()**。Eagle 的插件窗口对 close 有拦截（v3.28 查出来的），
 *    而 Ctrl+W 能关是因为它走 exitPlugin()：Bridge.closeSelf() → 400ms 后 destroySelf()。
 *    ✕ 现在复用同一条路（App.exit），最小化/最大化走 @electron/remote 直连。
 */
(function (global) {
  'use strict';

  /* 和 index.html 里那段尽早打 frameless 的内联脚本保持同一个判据 */
  const LAUNCH_RE = /(?:\?|&)launcher=1(?:&|#|$)/;
  let bound = false;

  function log(data) {
    try { if (typeof global.Dbg !== 'undefined') global.Dbg.log('framewin', data); } catch (e) { /* ignore */ }
  }

  function winApi() {
    return (global.eagle && global.eagle.window) || null;
  }

  /* v4.5.1 安全绳：URL 里带 id / path 就是「打开某个条目」的预览页。
     预览页跑在 Eagle 主窗口的 <webview> 里，此时 @electron/remote /
     plugin.window. 都指向**主窗口** —— 最小化/最大化/关闭会作用到 Eagle 本身。
     所以只要出现 id / path，一律不当启动器，一个窗口 API 都不碰。 */
  function isPreviewUrl() {
    try {
      const s = global.location.search || '';
      return /(?:\?|&)(?:id|path)=/.test(s);
    } catch (e) { return false; }
  }

  function isLauncher() {
    if (isPreviewUrl()) return false;
    try { if (LAUNCH_RE.test(global.location.search || '')) return true; } catch (e) { /* ignore */ }
    /* 兜底：Bridge 已经把 query 解析出来了（晚一点的调用路径会走到这里） */
    try {
      const q = (global.Bridge && global.Bridge.state && global.Bridge.state.query) || {};
      if (q.id || q.path) return false;
      return q.launcher === '1' || q.launcher === 1 || q.launcher === true;
    } catch (e) { return false; }
  }

  /* ---------- 真正干活的窗口对象 ----------
     @electron/remote 直连：同步、有返回值，Ctrl+W 能关窗走的就是它；
     eagle.window 只当第二选择（有些版本里 isMaximized 是异步的）；
     两条都没有才退回 `plugin.window.` 的 IPC 转发。 */
  function remoteWin() {
    try {
      if (typeof require !== 'function') return null;
      const r = require('@electron/remote');
      return (r && typeof r.getCurrentWindow === 'function') ? r.getCurrentWindow() : null;
    } catch (e) { return null; }
  }

  function ipcWindow(method) {
    try {
      if (typeof require !== 'function') return false;
      const ipc = require('electron').ipcRenderer;
      if (!ipc || typeof ipc.invoke !== 'function') return false;
      ipc.invoke('plugin.window.', { method: method, value: undefined });
      return true;
    } catch (e) { return false; }
  }

  /* minimize / maximize / unmaximize / close 都走这里 */
  function act(method) {
    const w = remoteWin();
    if (w && typeof w[method] === 'function') {
      try { w[method](); log({ act: method, via: 'remote' }); return true; } catch (e) { log({ act: method, remoteErr: String(e && e.message || e) }); }
    }
    const api = winApi();
    if (api && typeof api[method] === 'function') {
      try { api[method](); log({ act: method, via: 'eagle.window' }); return true; } catch (e) { log({ act: method, apiErr: String(e && e.message || e) }); }
    }
    const okIpc = ipcWindow(method);
    log({ act: method, via: okIpc ? 'ipc' : 'none' });
    return okIpc;
  }

  async function isMaxNow() {
    const w = remoteWin();
    if (w && typeof w.isMaximized === 'function') {
      try { return !!w.isMaximized(); } catch (e) { /* 落到 eagle.window */ }
    }
    const api = winApi();
    if (api && typeof api.isMaximized === 'function') {
      try { return !!(await api.isMaximized()); } catch (e) { /* ignore */ }
    }
    return false;
  }

  function paintState(bar, maximized) {
    if (!bar) return;
    bar.classList.toggle('is-max', !!maximized);
    const btn = bar.querySelector('#winMax');
    if (btn) btn.title = maximized ? '还原' : '最大化';
  }

  async function refresh(bar) {
    const el = bar || document.getElementById('winBar');
    if (!el) return;
    paintState(el, await isMaxNow());
  }

  async function toggleMax(bar) {
    const max = await isMaxNow();
    act(max ? 'unmaximize' : 'maximize');
    /* 先按「点完应该是什么样」把图标切过去 —— 等窗口动画那 200ms 里图标还是旧的话，
       用户会以为没点上。后面再对两次，以真实状态为准。 */
    paintState(bar, !max);
    setTimeout(() => refresh(bar), 80);
    setTimeout(() => refresh(bar), 260);
  }

  /* 关窗（v4.4.6）：✕ 和 Ctrl+W 必须同一条路，且只剩一条路。
     预览插件跑在 Eagle 主窗口的 webview 里，任何 remote / IPC 的
     close|destroy 都会经 BrowserWindow.fromWebContents(sender) 落到主窗口上。
     原来的 closeSelf → destroySelf → act('close') → window.close 四层兜底
     全部删除，统一交给 App.exit()（内部走宿主的 "Exit" 消息）。 */
  function closeSelf() {
    const app = global.App;
    if (app && typeof app.exit === 'function') {
      try { app.exit(); log({ act: 'close', via: 'App.exit' }); return true; } catch (e) { /* ignore */ }
    }
    /* 极端情况 App 还没挂上：只通知宿主，绝不碰窗口 API */
    try {
      if (global.Bridge && typeof global.Bridge.hostExit === 'function') {
        global.Bridge.hostExit();
        log({ act: 'close', via: 'Bridge.hostExit' });
        return true;
      }
    } catch (e) { /* ignore */ }
    log({ act: 'close', blocked: 'no-safe-exit' });
    return false;
  }

  function init() {
    /* 非启动器窗口 → 什么都不做（原生边框自己带着三个按钮） */
    if (!isLauncher()) return false;

    const bar = document.getElementById('winBar');
    if (!bar) return false;

    document.body.classList.add('frameless');
    bar.hidden = false;

    /* 幂等：Bridge 连上之后会再调一次 init()，不能重复绑定 */
    if (bound) { refresh(bar); return true; }
    bound = true;

    const min = document.getElementById('winMin');
    const max = document.getElementById('winMax');
    const close = document.getElementById('winClose');

    if (min) min.addEventListener('click', () => { act('minimize'); });
    if (max) max.addEventListener('click', () => { toggleMax(bar); });
    if (close) close.addEventListener('click', () => { closeSelf(); });

    /* 双击标题栏空白处 = 最大化 / 还原（Windows 习惯） */
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      toggleMax(bar);
    });

    /* 窗口尺寸变化（含用户拖边、Win+↑）后同步按钮图标 */
    global.addEventListener('resize', () => refresh(bar));
    refresh(bar);
    log({ init: 'ok', hasRemote: !!remoteWin(), hasEagle: !!winApi(), hasApp: !!(global.App && global.App.exit) });
    return true;
  }

  global.FrameWin = { init, refresh, isLauncher, closeSelf, act, toggleMax };
})(window);
