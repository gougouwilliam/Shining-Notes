/*!
 * 插件「被运行」事件的分诊（v3.20.1）
 *
 * 背景：Eagle 每次创建插件窗口，会往 webContents 发两次 plugin-run ——
 *   ① create() 内部：did-finish-load 后 100ms（send('plugin-create'); send('plugin-run')）
 *   ② create() 的 .then()：窗口 show() 之后又发一次（webContents.send('plugin-run', {args, ...plugin})）
 * 这两次都不是「用户在 Eagle 里又点了这个插件」，但形式上完全一样，没有可区分的字段。
 * 主插件原先收到 plugin-run 就去读「资源库当前选中项」并打开，
 * 于是从图钉打开工作台时，窗口刚落地就被带走去看那篇恰好选中的 PDF。
 *
 * 判定规则（纯函数，便于测试）：
 *   · 启动器窗口（?launcher=1）→ 这个窗口的语义就是「工作台入口」，
 *     任何 plugin-run 都只回到工作台，绝不去抢文档。
 *   · 普通窗口：既没打开文档、用户也还没碰过我们的界面
 *     → 判定为创建期的伪触发，忽略。
 *   · 其余情况（已有文档，或用户已在窗口里操作过）→ 按老语义打开选中项。
 *
 * 返回值：'workbench' | 'ignore' | 'open-selected'
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RunGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function verdict(o) {
    o = o || {};
    if (o.launcher) return 'workbench';
    if (!o.hasDoc && !o.touched) return 'ignore';
    return 'open-selected';
  }

  return { verdict: verdict };
});
