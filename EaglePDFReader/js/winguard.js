/* winguard.js —— 关窗前的窗口身份判定（v4.4.3 修订，纯函数）
 *
 * v4.4.1 的初衷：ESC 恢复关窗后，用户实测「按 ESC 会把 Eagle 一起最小化」，
 * 所以加一道守卫：只有能证明「自己不是 Eagle 主窗口」才允许关窗。
 *
 * v4.4.3 的事实更正（翻 Eagle 4.0 app.asar 的 pluginModule.openPreview）
 * ────────────────────────────────────────────────────────────────
 *   openPreview: (plugin, item) => {
 *     let win = new BrowserWindow({ show: true, frame: true, ... });
 *     win.webContents.on('dom-ready', () => {
 *       window.parentID = 主窗口 webContents.id;
 *       window.windowID = win.webContents.id;
 *     });
 *   }
 * 预览视图其实是**独立的 BrowserWindow**，不是主窗口里的 <webview>。
 * 所以 `windowID !== parentID` 恰恰证明「我不是主窗口」。
 *
 * v4.4.1 把「有 parentID」一律当成「跑在主窗口里」，又要求必须拿到
 * remote.getCurrentWindow().webContents.id 才放行；而预览窗口里
 * @electron/remote 经常不可用（现场日志 43 次裁决全是 no-self-id），
 * 结果连自己的预览窗口都不敢关 —— 用户一操作抢到焦点，ESC 就只弹提示。
 *
 * 两级许可（这是本版的核心）
 * ────────────────────────────
 *   allow            → 能否对 remote.getCurrentWindow() / IPC 拿到的窗口对象
 *                      执行 close()/destroy()。这些 API 有可能指回主窗口，
 *                      证据必须最严（selfId + 窗口列表双重佐证）。
 *   allowWindowClose → 能否调用 window.close()。它只作用于**当前 renderer
 *                      所在的窗口**，天然不会跨窗口误伤；只有当当前 JS
 *                      确实跑在主窗口 webContents 里（windowID===parentID，
 *                      或调用方标记 selfIsHost）时才禁止。
 *
 * 于是预览窗口的正确做法：allow=false（封死 remote/IPC），
 * allowWindowClose=true（用 window.close() 关自己）。既不误关 Eagle，
 * 也不会「按了 ESC 只弹一句提示」。
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
   *   windowID    window.windowID —— 本预览/插件窗口的 webContents.id
   *   selfId      remote.getCurrentWindow().webContents.id
   *   allIds      remote.BrowserWindow.getAllWindows() 里各窗口的 webContents.id
   *   selfIsHost  调用方已明确判定「selfWindow 就是宿主主窗口」
   *
   * 返回 { allow, allowWindowClose, code }；code 用于 debug.log 现场定位。
   * allow / code 的取值与 v4.4.1 完全一致（旧回归套件契约不变）。 */
  function closeVerdict(env) {
    env = env || {};
    const parentID = idOf(env.parentID);
    const windowID = idOf(env.windowID);
    const selfId = idOf(env.selfId);
    const allIds = Array.isArray(env.allIds)
      ? env.allIds.map(idOf).filter((x) => x !== null)
      : null;
    const mode = String(env.mode || '');

    /* 当前 JS 与 Eagle 主窗口共用同一个 webContents —— 这才是唯一真正
       「关自己会连累主窗口」的形态。 */
    const sameWebContentsAsHost =
      (windowID !== null && parentID !== null && windowID === parentID);
    let allowWindowClose = !!mode && mode !== 'browser'
      && env.selfIsHost !== true && !sameWebContentsAsHost;

    const deny = (code) => ({ allow: false, allowWindowClose: allowWindowClose, code: code });
    const grant = (code) => ({ allow: true, allowWindowClose: true, code: code });

    /* ⓪ 形态都不知道 —— remote 一律不给；window.close 也不给（保守） */
    if (!mode) return deny('unknown-mode');

    /* ⓪b 浏览器调试形态：连 Eagle 都不在，任何窗口操作都不该做。
       放在最前面，免得伪造的 parentID / windowID 把它带进 ③ 的分支里，
       裁决码却报成 self-is-parent 之类（穷举测试抓到过这个边界）。 */
    if (mode === 'browser') return deny('browser-mode');

    /* ① 调用方已明确知道拿到的是宿主窗口 —— 一票否决 */
    if (env.selfIsHost === true) return deny('flagged-host');

    /* ② windowID 与 parentID 相同 = 这段 JS 就跑在主窗口里 —— 全拒 */
    if (sameWebContentsAsHost) return deny('windowID-is-parent');

    /* ③ 有 parentID：可能是独立预览窗口，也可能是内嵌视图。
       window.close() 只关自己所在窗口，上面已排除「同 webContents」，可以放行；
       remote/IPC 那条路仍必须证明拿到的窗口不是主窗口。 */
    if (parentID !== null) {
      if (selfId === null) return deny('no-self-id');
      if (selfId === parentID) return deny('self-is-parent');
      if (!allIds) return deny('window-list-unknown');
      if (allIds.length < 2) return deny('single-window');
      if (allIds.indexOf(selfId) < 0) return deny('self-not-in-list');
      return grant('own-window');
    }

    /* ④ 没有 parentID：独立窗口形态（eagleplugin://<id>/index.html） */
    if (mode === 'preview') {
      if (selfId === null) return deny('preview-no-self');
      if (!allIds || allIds.length < 2) return deny('preview-unproven');
      if (allIds.indexOf(selfId) < 0) return deny('self-not-in-list');
      return grant('preview-own-window');
    }
    if (selfId !== null && allIds && allIds.length < 2) return deny('single-window');
    return grant('standalone-window');
  }

  const mod = { closeVerdict, idOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.WinGuard = mod; } catch (e) { /* vm 沙箱里没有 window */ }
})(typeof window !== 'undefined' ? window : globalThis);
