/* winguard.js —— 关窗前的窗口身份判定（v4.4.1，纯函数）
 *
 * 为什么需要它
 * ────────────────────────────
 * v4.4.0 把 ESC 空栈恢复成「关闭插件」后，用户实测：按 ESC 会把 Eagle 一起最小化。
 * 翻 Eagle 4.0 的 app.asar 拿到硬事实：
 *   · 预览形态的插件跑在 Eagle 主窗口的 <webview> 里，dom-ready 注入
 *       window.parentID = 主窗口 webContents.id
 *       window.windowID = webview.getWebContentsId()
 *   · 这种形态下 require('@electron/remote').getCurrentWindow()，以及主进程
 *       BrowserWindow.fromWebContents(event.sender)（plugin.window. IPC 的实现）
 *     都可能指回 **Eagle 主窗口**；对主窗口 close() 会被 Eagle 的「关闭到托盘」
 *     拦成 minimize/hide —— 插件视图和整个 Eagle 一起收走，就是用户看到的现象。
 *   · Eagle 官方 API 的 hide() / minimize() 在预览形态下同样作用于主窗口
 *     （bridge.js closeWindow() 的注释里早就记过这个坑）。
 *
 * v3.22 曾有一道 canSelfClosePreview()（windowID === parentID 时拒绝关窗），
 * v3.31 因为「ESC 永不关窗口」把它连同三层兜底一起删了；v4.4.0 恢复 ESC 关窗
 * 却没恢复这道守卫 —— 这次事故的根因。
 *
 * 原则：**只有能证明「自己是另一个窗口」时才允许关窗**。拿不到身份证明，
 * 宁可不关（关不掉可以提示，误关 Eagle 是不可接受的数据/体验损失）。
 *
 * 浏览器里挂 window.WinGuard，Node 里 module.exports（测试直接 require）。
 */
(function (global) {
  'use strict';

  function idOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /* env 字段（都允许缺省，缺省 = 不知道，按保守处理）：
   *   mode        'window' | 'preview' | 'browser'（Bridge.state.mode）
   *   parentID    window.parentID —— Eagle 主窗口 webContents.id
   *   windowID    window.windowID —— 本 webview 的 webContents.id
   *   selfId      remote.getCurrentWindow().webContents.id
   *   allIds      remote.BrowserWindow.getAllWindows() 里各窗口的 webContents.id
   *   selfIsHost  调用方已明确判定「selfWindow 就是宿主主窗口」
   *
   * 返回 { allow, code }；code 用于 debug.log 现场定位。 */
  function closeVerdict(env) {
    env = env || {};
    const parentID = idOf(env.parentID);
    const windowID = idOf(env.windowID);
    const selfId = idOf(env.selfId);
    const allIds = Array.isArray(env.allIds)
      ? env.allIds.map(idOf).filter((x) => x !== null)
      : null;
    const mode = String(env.mode || '');
    const deny = (code) => ({ allow: false, code: code });

    /* ⓪ 形态都不知道 —— 不给关（守卫只在 Bridge 就绪后调用，正常不会命中） */
    if (!mode) return deny('unknown-mode');

    /* ① 调用方已明确知道拿到的是宿主窗口 —— 一票否决 */
    if (env.selfIsHost === true) return deny('flagged-host');

    /* ② windowID 与 parentID 相同 = 这一段 JS 就跑在主窗口里 */
    if (windowID !== null && parentID !== null && windowID === parentID) {
      return deny('windowID-is-parent');
    }

    /* ③ 有 parentID 说明处于 webview（主窗口内）形态：
     *    必须能证明 selfId 是另一个窗口，且系统里确实不止一个窗口。 */
    if (parentID !== null) {
      if (selfId === null) return deny('no-self-id');
      if (selfId === parentID) return deny('self-is-parent');
      if (!allIds) return deny('window-list-unknown');
      if (allIds.length < 2) return deny('single-window');
      if (allIds.indexOf(selfId) < 0) return deny('self-not-in-list');
      return { allow: true, code: 'own-window' };
    }

    /* ④ 没有 parentID：独立窗口形态（eagleplugin://<id>/index.html）。
     *    预览模式若连 parentID 都没有，说明形态不明 —— 必须有窗口列表佐证。 */
    if (env.mode === 'preview') {
      if (selfId === null) return deny('preview-no-self');
      if (!allIds || allIds.length < 2) return deny('preview-unproven');
      if (allIds.indexOf(selfId) < 0) return deny('self-not-in-list');
      return { allow: true, code: 'preview-own-window' };
    }
    if (env.mode === 'browser') return deny('browser-mode');
    if (selfId !== null && allIds && allIds.length < 2) return deny('single-window');
    return { allow: true, code: 'standalone-window' };
  }

  const mod = { closeVerdict, idOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.WinGuard = mod; } catch (e) { /* vm 沙箱里没有 window */ }
})(typeof window !== 'undefined' ? window : globalThis);
