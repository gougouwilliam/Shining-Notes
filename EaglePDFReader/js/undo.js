/* 撤销栈（v3.6）

   只记录「会改数据」的动作：新增 / 修改 / 删除摘录，新增 / 修改 / 删除笔记。
   翻页、缩放、换颜色这类视图状态不算「上一步操作」，不进栈 —— 按 Ctrl+Z 却
   只是把页码退回去，会让人以为撤销坏了。

   设计要点：
   1) 每条记录只带一个 undo 函数（闭包捕获旧值），不存整份快照 —— 数据里有图片
      base64，存快照几十步就是几十 MB。
   2) 撤销执行期间 `muted` 不为 0，被 undo 顺带触发的 addAnnotation / updateAnnotation
      不会再次入栈，否则按一次 Ctrl+Z 能弹出三四层。
   3) 栈深 60，够覆盖一次阅读里手滑的密度，又不至于把内存吃满。 */
const Undo = (function () {
  const LIMIT = 60;
  const stack = [];
  const redoStack = [];
  let muted = 0;

  function push(label, undoFn, redoFn) {
    if (muted || typeof undoFn !== 'function') return;
    stack.push({ label: label || '操作', undo: undoFn, redo: typeof redoFn === 'function' ? redoFn : null });
    if (stack.length > LIMIT) stack.shift();
    redoStack.length = 0;
  }

  function size() { return stack.length; }

  function run(fn) {
    muted++;
    try { return fn(); } finally { muted--; }
  }

  /* 返回 { ok, label }：ok=false 表示栈空，调用方可以提示「没有可撤销的操作」 */
  function undo() {
    const rec = stack.pop();
    if (!rec) return { ok: false, label: '' };
    try {
      run(rec.undo);
    } catch (e) {
      console.warn('[Undo] 撤销 «' + rec.label + '» 失败', e);
    }
    if (rec.redo) redoStack.push(rec);
    return { ok: true, label: rec.label };
  }

  function redo() {
    const rec = redoStack.pop();
    if (!rec) return { ok: false, label: '' };
    try {
      run(rec.redo);
    } catch (e) {
      console.warn('[Undo] 重做 «' + rec.label + '» 失败', e);
    }
    stack.push(rec);
    return { ok: true, label: rec.label };
  }

  /* 换文档时必须清空：撤销一步跨文档的删除，会把内容塞进另一份文件里 */
  function clear() {
    stack.length = 0;
    redoStack.length = 0;
  }

  return { push, undo, redo, clear, size, run };
})();

try { window.Undo = Undo; } catch (e) { /* ignore */ }
