/* Esc 逐级退出（v3.3 重做）

   旧版是在 onKeyDown 里手写一串 if：确认框 → 翻译 → 搜索 → 回收站 → 知识库 → 工作台 → …
   顺序靠人肉维护，任何一层忘了写、或者某层「关闭时会顺手关窗口」（比如没有文档时
   关工作台会直接 closeWindow），用户就会觉得「按 Esc 直接退出插件了」。

   现在改成显示栈：谁被打开，谁就把自己的关闭函数压进来；Esc 永远只弹栈顶。
   好处：
   1) 顺序天然等于「打开的先后」，后开的先关，符合直觉；
   2) 任何一层关闭都只关自己，不可能顺手把插件关掉；
   3) 测试里可以直接断言栈的内容。 */
const Esc = (function () {
  const stack = [];
  let seq = 0;

  function push(name, fn, opts) {
    if (!name || typeof fn !== 'function') return;
    remove(name);                       // 同一个东西重复打开时只留最新的一份
    stack.push({ name, fn, seq: ++seq, sticky: !!(opts && opts.sticky) });
    return name;
  }

  function remove(name) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) stack.splice(i, 1);
    }
  }

  function has(name) { return stack.some((l) => l.name === name); }
  function depth() { return stack.length; }
  function top() { return stack.length ? stack[stack.length - 1] : null; }
  function names() { return stack.map((l) => l.name); }

  /* 弹出并执行栈顶；返回 true 表示「这次 Esc 被界面吃掉了」 */
  function handle() {
    const layer = top();
    if (!layer) return false;
    try {
      layer.fn();
    } catch (e) {
      console.warn('[Esc] 关闭 «' + layer.name + '» 失败', e);
    }
    /* 关闭函数理应自己 pop；万一它忘了，这里兜底，避免下一次 Esc 卡在同一层 */
    if (top() === layer) remove(layer.name);
    return true;
  }

  /* v3.23：按「真实可见性」清理失效层。
     某一层如果在关闭路径上漏了 Esc.remove，或者它的 DOM 被别处直接收起来，
     栈就会一直比界面「多一层」—— 于是每次按 ESC 都在弹一个看不见的层，
     用户看到的现象就是「按 ESC 没反应、退不出去」。
     keep(name) 明确返回 false 的层才移除；返回 true / 抛错 / 未知层一律保留
     （宁可多按一次，也绝不能越过确认框把插件关掉）。 */
  function prune(keep) {
    if (typeof keep !== 'function') return 0;
    let n = 0;
    for (let i = stack.length - 1; i >= 0; i--) {
      let alive = true;
      try { alive = keep(stack[i].name) !== false; } catch (e) { alive = true; }
      if (!alive) { stack.splice(i, 1); n++; }
    }
    return n;
  }

  function clear() { stack.length = 0; }

  return { push, remove, has, depth, top, names, handle, prune, clear };
})();

try { window.Esc = Esc; } catch (e) { /* ignore */ }
