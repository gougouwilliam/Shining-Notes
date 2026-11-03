/* 标注渲染层
   注意：高亮/框选渲染在文字层之下（.hlLayer），这样绝不会挡住鼠标选字——
   旧版本把高亮放在文字层之上，导致「拖选到已有高亮处就选不动」，是高亮不全的主因。 */
const AnnColors = [
  { id: 'yellow', hl: '#f5c542', solid: '#e0a800', label: '黄' },
  { id: 'green', hl: '#4cc38a', solid: '#2f9e6b', label: '绿' },
  { id: 'blue', hl: '#4a90e2', solid: '#2f6fbf', label: '蓝' },
  { id: 'pink', hl: '#e26ba5', solid: '#bf4a80', label: '粉' },
  { id: 'purple', hl: '#9b7bd4', solid: '#7357b3', label: '紫' }
];

/* 显示名统一叫「摘录」：面板叫摘录、筛选叫摘录、卡片类型也叫摘录，
   同一件事不再出现「高亮 / 摘录」两种说法（底层 type 仍是 highlight，不动数据） */
const AnnTypeLabel = { highlight: '摘录', area: '框选', note: '锚点' };

function colorOf(ann) {
  return AnnColors.find((c) => c.id === ann.color) || AnnColors[0];
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '#f5c542').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* 清空一个层。用 replaceChildren 而不是 innerHTML=''：
   高亮块带 mix-blend-mode（要和下面的纸面混合），在 Chromium 里这种子元素被
   innerHTML 一次性清掉时偶尔不会触发整层重绘，画面上留下没有 DOM 的色块，
   直到页面因为别的原因重排（翻页 / 重开文档）才消失。replaceChildren 会走
   「移除节点」的正常路径，配合下面的 sweep 双保险。 */
function clearLayer(layer) {
  if (!layer) return;
  /* 先复位显示状态：forceRepaint 用 display:none 让浏览器重画一帧，
     万一那一帧的恢复没跑到（切页 / 窗口隐藏），下次重绘必须能把它显示回来 */
  layer.style.display = '';
  layer.style.visibility = '';
  if (typeof layer.replaceChildren === 'function') layer.replaceChildren();
  else layer.innerHTML = '';
}

/* 换一个全新的层节点（v3.12 修「删了摘录、色块还留在 PDF 上」）
   ──────────────────────────────────────────────────────────
   mix-blend-mode 的子元素在 Chromium 里会被提升成独立的 RenderSurface。
   把子元素从 DOM 里删掉，只算是「层内容变了」；合成器那边贴图被缓存复用时，
   那一块就可能继续留在画面上，直到页面整体重排（= 重开文档）才清掉。
   3.9.1 试过 replaceChildren + display:none 强制重绘，覆盖掉了大部分情况，
   但只要这一页还有别的摘录（层不空，forceRepaint 不触发），就仍会复现。

   彻底的做法是连层节点一起换掉：旧节点从文档树里移除，它背后的 RenderSurface
   也随之释放，没有任何贴图能被复用。成本只是每页每次重绘新建一个空 div。 */
function freshLayer(pageEl, sel) {
  const old = pageEl.querySelector(sel);
  if (!old) return null;
  const node = document.createElement('div');
  node.className = old.className;
  old.replaceWith(node);
  return node;
}

/* 层被清空后强制它重画一帧。
   mix-blend-mode 的色块留在画面上的最后一道保险：DOM 已经删了、层也空了，
   个别机器（CEF / 老 Chromium）仍可能把那一块留在合成层里。把空层藏掉、下一帧再放出来，
   等于强制它重新合成；此时层本来就该是空的，所以视觉上没有变化。 */
function forceRepaint(layer) {
  if (!layer || layer.childElementCount) return;
  layer.style.display = 'none';
  void layer.offsetHeight;                 // 同步一次布局，让「隐藏」真的落到画面上
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { layer.style.display = ''; });
  } else {
    layer.style.display = '';
  }
}

class AnnotationManager {
  constructor(opts) {
    this.viewer = opts.viewer;
    this.getAnnotations = opts.getAnnotations;
    this.onSelect = opts.onSelect || function () {};
    this.onEdit = opts.onEdit || function () {};
    this.activeId = null;
    this._tip = null;
    this._bindGlobal();
  }

  _bindGlobal() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest ? e.target.closest('[data-ann-id]') : null;
      if (target) {
        this.setActive(target.dataset.annId);
        this.onSelect(this.find(target.dataset.annId), target);
      }
    });
    document.addEventListener('dblclick', (e) => {
      const target = e.target.closest ? e.target.closest('[data-ann-id]') : null;
      if (target) {
        const ann = this.find(target.dataset.annId);
        if (ann) this.onEdit(ann, target);
      }
    });
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest ? e.target.closest('[data-ann-id]') : null;
      if (!target) { this.hideTip(); return; }
      const ann = this.find(target.dataset.annId);
      if (ann) this.showTip(ann, target);
    });
    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest ? e.target.closest('[data-ann-id]') : null;
      if (target) this.hideTip();
    });
    this.viewer.viewportEl.addEventListener('scroll', () => this.hideTip(), { passive: true });
  }

  find(id) {
    return this.getAnnotations().find((a) => a.id === id) || null;
  }

  setActive(id) {
    this.activeId = id;
    U.$$('.ann-hl.active, .ann-area.active, .ann-pin.active').forEach((el) => el.classList.remove('active'));
    if (!id) return;
    U.$$(`[data-ann-id="${id}"]`).forEach((el) => el.classList.add('active'));
  }

  /* ---------- 渲染 ---------- */
  renderAll() {
    for (let i = 0; i < this.viewer.pageEls.length; i++) this.renderPage(i + 1);
  }

  renderVisible() {
    const vp = this.viewer.viewportEl;
    const top = vp.scrollTop - 400;
    const bottom = vp.scrollTop + vp.clientHeight + 400;
    this.viewer.pageEls.forEach((el, i) => {
      const y = this.viewer.offsets[i] || 0;
      if (y + el.offsetHeight >= top && y <= bottom) this.renderPage(i + 1);
    });
  }

  /* 数据 → 画面 的对账（v3.9.1）
     局部重绘只负责「被改动的那一页」，可现实里色块会留在别的页上：
       · 一条摘录的 page 与它 rects 实际所在页对不上（跨页选中时记录过页码）；
       · 重绘正好撞上「页面重新渲染 / 缩放」，那一次 append 被打断；
       · 页面在屏幕外，renderVisible 的可见判定没覆盖到它。
     结果就是用户看到的「右栏删了、Eagle 注释也清了，PDF 上那块还亮着，
     非得重开文档才没」。这里做一次兜底：凡是页面上带 data-ann-id、但数据里
     已经找不到的色块/锚点，一律摘掉；整页数据为空就直接清层。
     成本很低（只遍历已经渲染出来的几十个节点），每次数据变更都跑一遍。 */
  sweep() {
    const all = this.getAnnotations() || [];
    const live = new Set(all.map((a) => String(a.id)));
    const dirty = new Set();

    /* 页面上带 data-ann-id、数据里却已经找不到的 → 这一页整页重绘。
       不满足于「把那个节点删掉」：删节点只是层内容变化，合成贴图仍可能被复用
       （见 freshLayer 的说明）。整页重绘会换掉层节点，是唯一确定能清干净的做法。 */
    this.viewer.pageEls.forEach((el, i) => {
      el.querySelectorAll('[data-ann-id]').forEach((n) => {
        if (!live.has(String(n.dataset.annId))) dirty.add(i + 1);
      });
    });

    /* 整页已经没有任何标注，hlLayer 里却还有东西（没带 id 的旧产物 / 被打断的半成品）
       → 同样算脏。pinLayer 不在此列：框选拖拽中的 .area-rubber 也挂在那儿。 */
    const byPage = new Set(all.map((a) => String(a.page)));
    this.viewer.pageEls.forEach((el, i) => {
      if (byPage.has(String(i + 1))) return;
      const hl = el.querySelector('.hlLayer');
      if (hl && hl.childElementCount) dirty.add(i + 1);
    });

    dirty.forEach((n) => {
      this.renderPage(n);
      /* 重绘后如果这一页刚好空了，再补一次「藏一帧再放出来」——
         这是老机器上唯一还能做的动作，代价只在删除发生的那一次。 */
      const el = this.viewer.pageEls[n - 1];
      const hl = el && el.querySelector('.hlLayer');
      if (hl) forceRepaint(hl);
    });
  }

  renderPage(pageNum) {
    const pageEl = this.viewer.pageEls[pageNum - 1];
    if (!pageEl) return;
    /* 高亮层整节点替换（不是清空）：见 freshLayer 的说明 —— 删掉的色块之所以
       会留在画面上，就是因为旧层背后的合成贴图还能被复用。 */
    let hlLayer = freshLayer(pageEl, '.hlLayer');
    const pinLayer = pageEl.querySelector('.pinLayer');
    if (!hlLayer || !pinLayer) return;
    hlLayer = hlLayer || pageEl.querySelector('.hlLayer');
    clearLayer(pinLayer);
    const w = pageEl.offsetWidth;
    const h = pageEl.offsetHeight;
    if (!w || !h) return;

    const list = this.getAnnotations().filter((a) => a.page === pageNum);
    for (const ann of list) {
      const c = colorOf(ann);
      if (ann.type === 'highlight') {
        (ann.rects || []).forEach((r) => {
          const node = U.el('div', {
            class: 'ann-hl' + (ann.id === this.activeId ? ' active' : ''),
            'data-ann-id': ann.id
          });
          node.style.left = (r.x * w) + 'px';
          node.style.top = (r.y * h) + 'px';
          node.style.width = Math.max(2, r.w * w) + 'px';
          node.style.height = Math.max(2, r.h * h) + 'px';
          node.style.background = hexToRgba(c.hl, ann.note ? 0.52 : 0.38);
          hlLayer.appendChild(node);
        });
      } else if (ann.type === 'area') {
        const r = (ann.rects && ann.rects[0]) || { x: 0, y: 0, w: 0.2, h: 0.1 };
        const node = U.el('div', {
          class: 'ann-area' + (ann.id === this.activeId ? ' active' : ''),
          'data-ann-id': ann.id
        });
        node.style.left = (r.x * w) + 'px';
        node.style.top = (r.y * h) + 'px';
        node.style.width = Math.max(4, r.w * w) + 'px';
        node.style.height = Math.max(4, r.h * h) + 'px';
        node.style.setProperty('--area-color', c.solid);
        /* v4.2.17：笔记内容不再画进阅读区（此前 ann.note 会内嵌 .ann-tag
           显示前 16 个字）—— 阅读区只留框选标记本身，笔记内容走右栏卡片
           和悬停提示（showTip）。 */
        hlLayer.appendChild(node);
      } else if (ann.type === 'note') {
        const p = ann.point || { x: 0.08, y: 0.08 };
        const node = U.el('div', {
          class: 'ann-pin' + (ann.id === this.activeId ? ' active' : ''),
          'data-ann-id': ann.id,
          text: '✎'
        });
        node.style.left = (p.x * w) + 'px';
        node.style.top = (p.y * h) + 'px';
        node.style.setProperty('--pin-color', c.hl);
        pinLayer.appendChild(node);
      }
    }
  }

  /* ---------- 悬停提示 ---------- */
  showTip(ann, anchor) {
    const body = ann.note || ann.text || '';
    if (!body) return;
    this.hideTip();
    const tip = U.el('div', { class: 'ann-tip' });
    tip.textContent = U.truncate(body, 220);
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const left = U.clamp(r.left, 8, window.innerWidth - tr.width - 8);
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    this._tip = tip;
  }

  hideTip() {
    if (this._tip) { this._tip.remove(); this._tip = null; }
  }
}

/* classic script 的 class / const 不会挂到 window 上，测试与调试需要显式挂一次 */
try { window.AnnotationManager = AnnotationManager; window.AnnColors = AnnColors; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnnotationManager, freshLayer, clearLayer, forceRepaint, AnnColors };
}
