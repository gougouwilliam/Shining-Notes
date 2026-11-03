/* 列表多选 + 批量操作（v3.15）

   摘录、笔记、知识库卡片、回收站四处都要「按住 Ctrl 点、Ctrl+A 全选、然后一起删」。
   四处的底层数据结构完全不同（标注对象 / 笔记对象 / 索引条目 / 回收站记录），
   但**交互**是同一套，所以把交互抽出来，各列表只需要告诉它：
     去哪个容器里找条目（root + itemSel）
     条目的唯一键是什么（keyOf）
     选中之后能做什么（actions）

   为什么不各自写一遍：四个列表都会重渲染（innerHTML 清空重建），
   「选中态怎么在重渲染后活下来」「Ctrl+A 该作用于哪个列表」这类细节，
   写四遍就会长出四种不一致的行为。 */
const MultiSelect = (function () {

  /* 当前「活跃」的列表：鼠标最近在哪个列表里点过。
     Ctrl+A 是全局快捷键，必须知道该作用于谁 —— 否则在摘录列表里按 Ctrl+A
     会连笔记一起选上（而用户根本看不到笔记列表）。 */
  let active = null;

  function typing(el) {
    if (!el) return false;
    const t = (el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || el.isContentEditable;
  }

  function create(opts) {
    const o = opts || {};
    const root = o.root;
    const bar = o.bar || null;
    const itemSel = o.itemSel || '[data-key]';
    const keyOf = o.keyOf || ((node) => node.dataset.key || node.dataset.id);
    const actions = o.actions || [];
    const sel = new Set();
    let anchor = null;
    let node = null;

    function items() {
      if (!root) return [];
      return Array.prototype.slice.call(root.querySelectorAll(itemSel));
    }

    function keyOfNode(n) { try { return keyOf(n); } catch (e) { return null; } }

    function paint() {
      items().forEach((n) => {
        const k = keyOfNode(n);
        n.classList.toggle('ms-on', !!k && sel.has(k));
      });
    }

    function renderBar() {
      if (!bar) return;
      const n = sel.size;
      bar.hidden = n === 0;
      if (!n) { bar.innerHTML = ''; return; }
      bar.innerHTML = '';
      const count = document.createElement('span');
      count.className = 'ms-count';
      count.textContent = '已选 ' + n + ' 项';
      bar.appendChild(count);
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      bar.appendChild(spacer);
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.className = 'ec-btn' + (a.danger ? ' danger' : '');
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        b.addEventListener('click', () => {
          if (a.run) a.run(selList());
        });
        bar.appendChild(b);
      });
      const cancel = document.createElement('button');
      cancel.className = 'ec-btn';
      cancel.textContent = '取消选择';
      cancel.addEventListener('click', () => clear());
      bar.appendChild(cancel);
    }

    function changed() {
      paint();
      renderBar();
      if (o.onChange) { try { o.onChange(selList()); } catch (e) { /* ignore */ } }
    }

    function selList() { return Array.from(sel); }

    function toggle(k) {
      if (k == null) return;
      if (sel.has(k)) sel.delete(k); else sel.add(k);
      anchor = k;
      changed();
    }

    function only(k) {
      sel.clear();
      if (k != null) sel.add(k);
      anchor = k;
      changed();
    }

    function range(k) {
      const all = items().map(keyOfNode);
      const a = all.indexOf(anchor);
      const b = all.indexOf(k);
      if (a < 0 || b < 0) { only(k); return; }
      const from = Math.min(a, b), to = Math.max(a, b);
      sel.clear();
      for (let i = from; i <= to; i++) if (all[i] != null) sel.add(all[i]);
      changed();
    }

    function all() {
      sel.clear();
      items().forEach((n) => { const k = keyOfNode(n); if (k != null) sel.add(k); });
      changed();
    }

    function clear() {
      if (!sel.size) return;
      sel.clear();
      anchor = null;
      changed();
    }

    /* 列表重渲染之后：把「还存在的键」重新点亮，已经不在列表里的自然丢掉 */
    function sync() {
      const live = new Set(items().map(keyOfNode));
      let dropped = false;
      Array.from(sel).forEach((k) => { if (!live.has(k)) { sel.delete(k); dropped = true; } });
      if (dropped || sel.size) changed();
      else { paint(); renderBar(); }
    }

    /* 捕获阶段处理：带修饰键的点击不该再触发卡片自己的「定位 / 打开」，
       否则多选一次就把视图跳走一次。 */
    function onDown(e) {
      if (!root) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const item = t.closest(itemSel);
      if (!item || !root.contains(item)) return;
      if (t.closest('button') && !e.ctrlKey && !e.metaKey && !e.shiftKey) return;  // 卡片上的小按钮照旧
      active = api;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        toggle(keyOfNode(item));
      } else if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        range(keyOfNode(item));
      } else if (sel.size) {
        /* 普通点击且当前有多选 —— 先清空，再让卡片自己的逻辑接手 */
        clear();
      }
    }

    function onKey(e) {
      if (!root || !root.offsetParent) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'escape' && sel.size && active === api) { clear(); return; }
      if (!(e.ctrlKey || e.metaKey) || k !== 'a') return;
      if (typing(e.target)) return;                 // 在输入框里 Ctrl+A 是全选文字
      if (active !== api) return;
      e.preventDefault();
      all();
    }

    if (root) root.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);

    const api = {
      root,
      selected: selList,
      has: () => sel.size > 0,
      count: () => sel.size,
      clear, all, sync, paint,
      focus: () => { active = api; },
      destroy: () => {
        if (root) root.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey);
        if (active === api) active = null;
      }
    };
    node = api;
    return api;
  }

  return { create, current: () => active };
})();

try { window.MultiSelect = MultiSelect; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = MultiSelect;
