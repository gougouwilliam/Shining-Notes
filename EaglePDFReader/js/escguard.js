/* escguard.js —— ESC 动作决策（v3.22，纯函数）
 *
 * 把「这一下 ESC 该干什么」从 onKeyDown 里抽出来，便于对不同窗口形态做行为级测试。
 * 浏览器里挂 window.EscGuard，Node 里 module.exports。
 *
 * 背景：预览扩展不是跑在 Eagle 主窗口的 document 里，而是 Eagle 用 openPreview
 * 创建的独立 BrowserWindow（app.asar 里 dom-ready 会注入 window.windowID / window.parentID）。
 * 因此预览窗口里按 ESC，事件冒泡不到主窗口的 escHandler/quicklook。
 */
(function (global) {
  'use strict';

  /* 逐级退出的优先级（v4.4.0：ESC 最后一级 = 关闭插件）：
   *   1) 有浮层 → 弹栈顶（后开的先关）。
   *   2) 搜索框有字 → 只清搜索。
   *   3) 正在输入 → 失焦（留给输入法）。
   *   4) 其余 → exit-plugin：关掉插件窗口（与顶栏 ✕ / Ctrl+W 同一条出口）。
   *
   * 历史（v3.22 / v3.31 为什么删过这一档）
   * ────────────────────────────
   * 当年「ESC 关窗口」被**三处**兜底叠着：① 这里返回 exit-plugin；② app.js 里
   * 「连按两次没进展就强退」；③ index.html 一段独立脚本 900ms 没被认领就 IPC 关窗。
   * 任何一处判偏，一次「想关个框」的 ESC 就变成「退出插件」（连 Eagle 一起收走的
   * 事故也出过）。所以 v3.22 把这一档整条拿掉，ESC 只往回收。
   * v4.4.0 用户明确要求恢复「ESC 关闭插件」。恢复的前提是三个兜底只剩一个：
   * ②③ 已删，决策点只有这里的 escapeAction，且 app.js 对 ESC **无条件**
   * preventDefault + stopPropagation（事件绝不会漏给 Eagle 宿主）。
   * 于是 noop 这一档重新变成明确的 exit-plugin——单一决策点，行为可测。
   * v4.4.1：用户实测「ESC 连同 Eagle 一起最小化」。根因不在这个判定，而在
   * exitPlugin() 的关窗动作可能作用到 Eagle 主窗口（预览 webview 形态）。
 * 于是把守卫下沉到关窗层（js/winguard.js + Bridge.closeVerdict）：
 * ESC 仍返回 exit-plugin，但 exitPlugin 拿不到「自己是独立窗口」的证明时
 * 一个窗口 API 都不碰，只提示。决策点依旧唯一，且多了一道身份闸门。
 *
 * v4.4.4 结论（最终形态，别再改动本文件的决策）
 * ────────────────────────────────────────────
 * 预览是独立 BrowserWindow（windowID≠parentID），不是主窗口里的 webview。
 * 这里的 escapeAction 保持 exit-plugin 不变；关窗可靠性全在 exitPlugin：
 * 先摘 beforeunload，再走主进程按 sender 定向的 close/destroy。
 * 之前「点过页面后 ESC 失效」是 window.close() 被 Chromium 的
 * beforeunload + sticky activation 拦住，不是这里的分级判错。 */
  function escapeAction(env) {
    env = env || {};
    if (env.depth > 0) return 'pop-layer';
    if (env.searchActive) return 'clear-search';
    if (env.typing) return 'blur';
    return 'exit-plugin';
  }

  const mod = { escapeAction };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.EscGuard = mod; } catch (e) { /* ignore */ }
})(typeof window !== 'undefined' ? window : globalThis);
