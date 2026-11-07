/* winguard.js —— 窗口形态裁决（纯函数）
 *
 * ⚠️ v4.4.6 事实更正：v4.4.3 的判断是错的，别再照抄
 * ────────────────────────────────────────────────────────────
 * 本插件的预览页跑在 Eagle 主窗口的 <webview> 里。app.asar @1542729
 * 注入的是：
 *   window.parentID = 主窗口 webContents.id
 *   window.windowID = webview.getWebContentsId()
 * 所以 `windowID !== parentID` 只说明「我不是主窗口 webContents」，
 * **不等于**「我是独立 BrowserWindow」。pluginModule.openPreview 里那条
 * new BrowserWindow 路径属于别的预览器，不是本插件。
 *
 * 致命后果：主进程 plugin.window. handler 用
 *   BrowserWindow.fromWebContents(event.sender)
 * 定位，在 webview 形态下拿到的是 **Eagle 主窗口**。现场
 * [env] {"bw":"max"} 正是主窗口最大化（window-state.json isMaximized:true），
 * 不是「预览窗口最大化」。v4.4.4 发 bw.close()、v4.4.5 发 bw.destroy()，
 * 关掉/销毁的都是主窗口：用户「一起退出」「最小化后双击打不开」，
 * log.log 连续 "TypeError: Object has been destroyed at MenuItem.click"。
 *
 * 于是本模块的三档裁决**只用于描述形态，不再用于放行任何 close/destroy**：
 * 所有窗口关闭类方法已在 bridge.js 的 IPC_WINDOW_DENY 硬拦截；退出统一
 * 走 hostExit() —— parent.postMessage('Exit','*') 触发 Eagle 自己的
 * leaveDetailMode()。destroy 不触发 'close' 事件、不跑 beforeunload、
 * 不受 sticky activation 影响，这些只是历史备注，本插件永不再调用。
 *
 * 三档许可的取值契约保持兼容旧回归套件：
 *   allow            → 严格证明自己是独立窗口（selfId + 窗口列表双重佐证）
 *   allowWindowClose → 当前 renderer 可用 window.close()（只关自己）
 *   allowSenderClose → 形态证据（windowID≠parentID 或独立 window）
 * 只在 windowID===parentID / selfIsHost / browser / unknown-mode 时三级全拒。
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
   * 返回 { allow, allowWindowClose, allowSenderClose, code }；code 用于
   * debug.log 现场定位。allow / allowWindowClose / code 的取值与 v4.4.3
   * 完全一致（旧回归套件契约不变），v4.4.4 只新增 allowSenderClose。 */
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

    /* v4.4.4：第三级许可 —— 允许「按 sender 定位」的主进程关窗。
       ipcRenderer.invoke('plugin.window.', { method: 'close' | 'destroy' })
       在 Eagle 主进程里是 BrowserWindow.fromWebContents(event.sender)，
       作用对象只能是发出这条消息的 webContents 所在窗口，不会跨窗口误伤。
       但 destroy 会绕过 beforeunload，比 window.close() 强硬，所以证据要更严：
         ① Eagle 明确注入了独立窗口身份（parentID + windowID 且两者不同）；或
         ② 压根没有 parentID / windowID、且 mode='window' 的独立窗口形态。
       「有 parentID 却拿不到 windowID」这种身份不明的形态一律不给 ——
       那正是 v4.4.1 担心「IPC 可能指回主窗口」的情形。 */
    const separateWindow = windowID !== null && parentID !== null && windowID !== parentID;
    const standalone = parentID === null && windowID === null && mode === 'window';
    const allowSenderClose = allowWindowClose && (separateWindow || standalone);

    const deny = (code) => ({
      allow: false,
      allowWindowClose: allowWindowClose,
      allowSenderClose: allowSenderClose,
      code: code
    });
    const grant = (code) => ({
      allow: true, allowWindowClose: true, allowSenderClose: true, code: code
    });

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
