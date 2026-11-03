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

  /* 逐级退出的优先级（v3.31：ESC 永不关窗口）：
   *   1) 有浮层 → 弹栈顶（后开的先关）。
   *   2) 搜索框有字 → 只清搜索。
   *   3) 正在输入 → 失焦（留给输入法）。
   *   4) 其余 → noop：什么都不做，只提示「退出请按 Ctrl+W」。
   *
   * 为什么没有「退出插件」这一档
   * ────────────────────────────
   * 用户实测两条：刚打开 PDF 按 ESC，Eagle 界面一起没了；另存为弹不出来，
   * 想按 ESC 把那个框关掉，结果又把 Eagle 退了一次。
   * 根子不在哪一次判断写错，而在「ESC 关窗口」这条规则本身 —— 它当时被**三处**
   * 兜底叠着：① 这里返回 exit-plugin；② app.js 里「连按两次没进展就强退」；
   * ③ index.html 里一段独立脚本，900ms 内没被认领就自己调 IPC 关窗。
   * 任何一处判偏，一次「想关个框」的 ESC 就变成了「退出插件」。
   * 所以这一档整条拿掉：ESC 只往回收，退出统一走 Ctrl+W（明确、不会被误触）。
   * 当初为兜底写的 isRepeat（连按两次判据）与 canSelfClosePreview 一并删除 ——
   * 没人调用、只被测试养着的函数，留着就是下一次误判的种子。
   */
  function escapeAction(env) {
    env = env || {};
    if (env.depth > 0) return 'pop-layer';
    if (env.searchActive) return 'clear-search';
    if (env.typing) return 'blur';
    return 'noop';
  }

  const mod = { escapeAction };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.EscGuard = mod; } catch (e) { /* ignore */ }
})(typeof window !== 'undefined' ? window : globalThis);
