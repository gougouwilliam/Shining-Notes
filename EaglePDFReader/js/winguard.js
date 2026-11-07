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
 * v4.4.4 的现场更正：window.close() 单独一条路并不可靠
 * ────────────────────────────────────────────────────
 * 用户实测「打开文档不操作 / 只滚轮 → ESC 能退出；鼠标点一下之后 → ESC 失效」。
 * app.js 在 window 上注册了 beforeunload（退出时 persist）。Chromium 的规定是：
 * 页面存在 beforeunload 监听器、且用户已产生 sticky activation（鼠标点击、
 * 键盘输入）时，脚本发起的 window.close() 会被拦下等待确认 / 静默拒绝；
 * 滚轮滚动不产生 activation，所以未点击时关得掉，一点击就关不掉。
 * 现场 debug.log 里 00:25 之后成片的 exit.selfclose 正是「按了、没关掉」。
 *
 * 出路是主进程按 sender 定向关窗：ipcRenderer.invoke('plugin.window.',
 * { method:'close'|'destroy' }) 在 Eagle 主进程里走
 * BrowserWindow.fromWebContents(event.sender)，作用对象只能是发出消息的
 * 那个窗口；destroy() 更是直接绕过 renderer 的 beforeunload。
 * 现场 [env] {"ipc":true,"bw":"max"} 已证明这条通道在预览窗口里可用且
 * 指向正确（isMaximized 返回 true 的正是被最大化的预览窗口）。
 * 因为 destroy 比 close 强硬，新增第三级许可 allowSenderClose，
 * 证据要求比 allowWindowClose 更严（见 closeVerdict 里的注释）。
 *
 * v4.4.5 复盘：close 也不是答案，只有 destroy 是
 * ────────────────────────────────────────────
 * 现场 08:32 / 08:33 日志：IPC close 已发出（sent:true），窗口却没关，
 * 同一个 windowID 被连按十几次；而 exit.senderdestroy / exit.stillalive
 * 一行都没有。两件事同时发生：
 *   ① 主进程 bw.close() 与 renderer 的 window.close() **并发**，互相打断 ——
 *      结果在「宿主一起收走」和「卡住没反应」之间摇摆；
 *   ② window.close() 一发出，Chromium 就把 window.closed 提前置为 true，
 *      exitPlugin 里所有 if (!alive()) 兜底全被短路，硬兜底根本没机会发。
 * 结论：预览窗口只发一条 closeCurrent('destroy')。destroy 不触发 'close'
 * 事件、不跑 beforeunload、不受 sticky activation 影响，且 sender 定位保证
 * 只作用于自己。allowWindowClose 仍作为「当前窗口可关闭」的形态证据保留，
 * 但不再真的调用 window.close()。
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
