/* 阅读视图：连续分页渲染、文字层、缩放、虚拟化、框选与选区几何 */
class PdfViewer {
  constructor(opts) {
    this.viewportEl = opts.viewport;
    this.pagesEl = opts.pages;
    this.onPageChange = opts.onPageChange || function () {};
    this.onPageRendered = opts.onPageRendered || function () {};
    this.onAreaRect = opts.onAreaRect || function () {};
    this.onNotePoint = opts.onNotePoint || function () {};
    this.onPageClick = opts.onPageClick || function () {};
    this.onImagePick = opts.onImagePick || function () {};
    this.onLinkPick = opts.onLinkPick || function () {};
    this.getAnnotations = opts.getAnnotations || function () { return []; };

    this.doc = null;
    this.zoom = 1;
    this.zoomMode = 'fit-width';
    this.sizes = [];
    this.pageEls = [];
    this.offsets = [];
    this.current = 1;
    this.tool = 'select';
    this.pending = new Map();
    this.tasks = new Map();
    this.intersecting = new Set();
    this.io = null;
    this._destroyed = false;
    this._thumbTasks = new Map();
    this._imgs = new Map();     // page → [{x,y,w,h}]（归一化坐标）
    this._links = new Map();    // page → [{x,y,w,h,url,dest}]
    this._marks = new Map();    // page → [{rects, index}]（搜索命中的临时标记，不写进 PDF）
    this._markEls = [];         // [{page, index, node}]，切 active 只改 class
    this._activeMark = -1;
    this._hoverRect = null;
    this._selecting = false;   // 鼠标按下到抬起：正在划词（v3.21，见 _bindSelectGuard）
    this._dragBand = null;     // v3.22：本次拖选实际经过的视口矩形 {l,t,r,b,x,y,lineH}
    this._bandRaf = 0;         // 拖选中画柔和条带的 rAF 句柄
    this._bandEls = [];        // 当前已画的条带节点，清空时统一移除
    /* v3.23：本次拖选涉及的文本节点几何缓存（按页惰性建立）。
       getClientRects() 直接作用在跨多个绝对定位 span 的 Range 上时，Chromium
       会给回「整块包围盒」——那正是用户看到的「像框选一样的一个大矩形」。
       改成按单个文本节点取矩形再按行合并，才会得到「一行一行跟着走」的效果。 */
    this._dragNodes = null;
    this._dragNodePages = null;

    this._onScroll = U.rafThrottle(() => this.updateCurrentPage());
    this._onResize = U.debounce(() => this.handleResize(), 180);

    this.viewportEl.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
    this._bindAreaDrag();
    this._bindClick();
    this._bindSelectGuard();
    this._bindHover();
  }

  get pageCount() { return this.sizes.length; }

  /* ---------------- 初始化文档 ---------------- */
  setDocument(doc, reading) {
    this.cancelRenders();
    this.doc = doc;
    this.sizes = doc.sizes;
    this.pageEls = [];
    this.pending.clear();
    this.intersecting.clear();
    this._appliedZoom = null;
    this._thumbTasks.clear();
    this._imgs.clear();
    this._links.clear();
    this._marks.clear();
    this._markEls = [];
    this._bandEls = [];
    this._dragBand = null;
    this._dragNodes = null;
    this._dragNodePages = null;
    this._activeMark = -1;
    if (this.io) { this.io.disconnect(); this.io = null; }
    this.pagesEl.innerHTML = '';

    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.sizes.length; i++) {
      const pageEl = U.el('div', { class: 'page', 'data-page': String(i + 1) });
      pageEl.innerHTML =
        '<div class="page-skeleton"></div>' +
        '<canvas></canvas>' +
        '<div class="searchLayer"></div>' +
        '<div class="hlLayer"></div>' +
        '<div class="selBandLayer"></div>' +
        '<div class="textLayer"></div>' +
        '<div class="pinLayer"></div>' +
        '<div class="page-num">' + (i + 1) + '</div>';
      frag.appendChild(pageEl);
      this.pageEls.push(pageEl);
    }
    this.pagesEl.appendChild(frag);

    const r = reading || {};
    this.zoomMode = r.zoomMode || 'fit-width';
    this.applyLayout(typeof r.zoom === 'number' ? r.zoom : null);

    this.current = U.clamp(r.page || 1, 1, this.pageCount || 1);
    this.observe();
    this.renderVisible();
    this.updateCurrentPage(true);

    if (this.current > 1) {
      requestAnimationFrame(() => this.goToPage(this.current, { instant: true }));
    }
  }

  /* ---------------- 布局与缩放 ---------------- */
  applyLayout(explicitZoom) {
    if (!this.pageCount) return;
    /* 缩放 / 重排后旧的节点矩形全部作废，拖选缓存必须重建 */
    if (this._invalidateDragNodes) this._invalidateDragNodes();
    if (this.zoomMode === 'fit-width') {
      const avail = Math.max(200, this.viewportEl.clientWidth - 44);
      const maxW = this.sizes.reduce((m, s) => Math.max(m, s.w), 0);
      this.zoom = avail / maxW;
    } else if (this.zoomMode === 'fit-page') {
      const availW = Math.max(200, this.viewportEl.clientWidth - 44);
      const availH = Math.max(200, this.viewportEl.clientHeight - 40);
      const first = this.sizes[this.current - 1] || this.sizes[0];
      this.zoom = Math.min(availW / first.w, availH / first.h);
    } else if (typeof explicitZoom === 'number') {
      this.zoom = explicitZoom;
    }
    this.zoom = U.clamp(this.zoom, 0.15, 6);

    const prev = this._appliedZoom;
    if (prev != null && Math.abs(prev - this.zoom) < 0.002 && this.pageEls.length && this.pageEls[0].style.width) {
      this.recalcOffsets();
      return;
    }
    this._appliedZoom = this.zoom;
    this.cancelRenders();
    this.layoutPages();
  }

  cancelRenders() {
    for (const task of this.tasks.values()) {
      try { task.cancel(); } catch (e) { /* ignore */ }
    }
    this.tasks.clear();
    this.pending.clear();
  }

  layoutPages() {
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i];
      const s = this.sizes[i];
      const w = Math.max(40, Math.round(s.w * this.zoom));
      const h = Math.max(40, Math.round(s.h * this.zoom));
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      const canvas = el.querySelector('canvas');
      if (canvas && canvas.width > 0) {
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      const tl = el.querySelector('.textLayer');
      if (tl) tl.style.opacity = '0';
      el.dataset.renderedZoom = '';
    }
    this.recalcOffsets();
  }

  recalcOffsets() {
    this.offsets = this.pageEls.map((el) => el.offsetTop);
  }

  setZoom(value, mode) {
    this.zoomMode = mode || 'custom';
    this.applyLayout(value);
    this.renderVisible();
    return this.zoom;
  }

  zoomIn() { return this.setZoom(this.zoom * 1.15, 'custom'); }
  zoomOut() { return this.setZoom(this.zoom / 1.15, 'custom'); }
  fitWidth() { return this.setZoom(1, 'fit-width'); }
  fitPage() { return this.setZoom(1, 'fit-page'); }

  handleResize() {
    if (this._destroyed) return;
    if (this.zoomMode === 'fit-width' || this.zoomMode === 'fit-page') {
      this.applyLayout();
      this.renderVisible();
    } else {
      this.recalcOffsets();
    }
    this.updateCurrentPage(true);
  }

  /* ---------------- 虚拟化渲染 ---------------- */
  observe() {
    if (this.io) this.io.disconnect();
    if (typeof IntersectionObserver !== 'function') {
      this.pageEls.forEach((el, i) => this.ensureRendered(i + 1));
      return;
    }
    this.io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const n = parseInt(entry.target.dataset.page, 10);
        if (entry.isIntersecting) {
          this.intersecting.add(n);
          this.ensureRendered(n);
        } else {
          this.intersecting.delete(n);
          this.maybeRelease(n);
        }
      }
    }, { root: this.viewportEl, rootMargin: '1400px 0px' });
    this.pageEls.forEach((el) => this.io.observe(el));
  }

  renderVisible() {
    if (!this.pageCount) return;
    this.recalcOffsets();
    const scrollTop = this.viewportEl.scrollTop;
    const bottom = scrollTop + this.viewportEl.clientHeight + 1400;
    const top = Math.max(0, scrollTop - 600);
    for (let i = 0; i < this.offsets.length; i++) {
      const y = this.offsets[i];
      const h = this.pageEls[i].offsetHeight;
      if (y + h >= top && y <= bottom) this.ensureRendered(i + 1);
    }
  }

  ensureRendered(n) {
    const el = this.pageEls[n - 1];
    if (!el) return;
    if (el.dataset.renderedZoom === String(this.zoom)) return;
    if (this.pending.get(n) === this.zoom) return;
    const myZoom = this.zoom;
    this.pending.set(n, myZoom);
    this.renderPage(n)
      .catch((e) => console.warn('[Viewer] 渲染第 ' + n + ' 页失败', e))
      .finally(() => { if (this.pending.get(n) === myZoom) this.pending.delete(n); });
  }

  async renderPage(n) {
    const el = this.pageEls[n - 1];
    if (!el || !this.doc) return;
    const zoomAtStart = this.zoom;
    const page = await this.doc.proxy.getPage(n);
    if (this._destroyed) return;

    const prevTask = this.tasks.get(n);
    if (prevTask) { try { prevTask.cancel(); } catch (e) { /* ignore */ } }

    const vp = page.getViewport({ scale: zoomAtStart });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const w = Math.floor(vp.width * dpr);
    const h = Math.floor(vp.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = Math.round(vp.width) + 'px';
    canvas.style.height = Math.round(vp.height) + 'px';

    let task = null;
    try {
      task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      });
      this.tasks.set(n, task);
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('[Viewer] canvas 渲染异常', e);
    } finally {
      if (task && this.tasks.get(n) === task) this.tasks.delete(n);
    }

    el.classList.add('page-rendered');
    el.dataset.renderedZoom = String(zoomAtStart);

    if (this.zoom !== zoomAtStart) {
      this.ensureRendered(n);
      return;
    }

    await this.renderTextLayer(n, page, vp, el);
    this.renderSearchMarksForPage(n);
    // 图片 / 链接的命中区域与缩放无关，按页缓存一次即可（后台进行，不阻塞渲染）
    this.ensureOverlays(n);
    this.onPageRendered(n, el);
  }

  /* ---------------- 图片与链接的几何（用于选中、摘录、打开） ----------------
     不用 DOM 覆盖层，改用坐标命中：覆盖层会挡住文字选择，
     而扫描件、图表页恰恰是「既要选文字又要选图」的地方。 */
  async ensureOverlays(n) {
    if (!this.doc) return;
    if (this._imgs.has(n)) return;
    this._parsing = this._parsing || new Set();
    if (this._parsing.has(n)) return;      // 同一页不要并发解析
    this._parsing.add(n);
    this._links = this._links || new Map();
    if (!this._links.has(n)) this._links.set(n, []);
    const out = [];
    const links = [];
    let page;
    try { page = await this.doc.proxy.getPage(n); } catch (e) { this._parsing.delete(n); return; }
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width;
    const H = vp.height;
    if (!W || !H) { this._parsing.delete(n); return; }

    /* ---- 图片：跟踪操作符里的变换矩阵 ---- */
    try {
      const lib = window.pdfjsLib;
      const OPS = lib && lib.OPS;
      if (OPS) {
        const ops = await page.getOperatorList();
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const IMG_OPS = new Set([
          OPS.paintImageXObject, OPS.paintInlineImageXObject,
          OPS.paintImageMaskXObject, OPS.paintJpegXObject,
          OPS.paintImageMaskXObjectRepeat, OPS.paintImageXObjectRepeat,
          OPS.paintSolidColorImageMask
        ].filter((v) => v !== undefined));
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === OPS.save) { stack.push(ctm); ctm = ctm.slice(); continue; }
          if (fn === OPS.restore) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
          if (fn === OPS.transform) {
            try { ctm = lib.Util.transform(ctm, ops.argsArray[i]); } catch (e) { /* ignore */ }
            continue;
          }
          /* 表单 XObject：PDF.js 把表单内容展开在同一个操作符流里，
             表单矩阵在 paintFormXObjectBegin 的 args[0]，必须叠进 CTM，
             否则表单内画的图位置会算错（报表、图表页大量使用表单）。 */
          if (OPS.paintFormXObjectBegin !== undefined && fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm.slice());
            const mtx = ops.argsArray[i] && ops.argsArray[i][0];
            if (mtx) { try { ctm = lib.Util.transform(ctm, mtx); } catch (e) { /* ignore */ } }
            continue;
          }
          if (OPS.paintFormXObjectEnd !== undefined && fn === OPS.paintFormXObjectEnd) {
            ctm = stack.pop() || ctm;
            continue;
          }
          if (!IMG_OPS.has(fn)) continue;
          let m;
          try { m = lib.Util.transform(vp.transform, ctm); } catch (e) { continue; }
          const p1 = lib.Util.applyTransform([0, 0], m);
          const p2 = lib.Util.applyTransform([1, 1], m);
          const x = Math.min(p1[0], p2[0]);
          const y = Math.min(p1[1], p2[1]);
          const w = Math.abs(p2[0] - p1[0]);
          const h = Math.abs(p2[1] - p1[1]);
          if (w < 10 || h < 10) continue;
          const ratio = (w * h) / (W * H);
          if (ratio < 0.0012 || ratio > 0.97) continue;   // 太小的装饰、整页底图都不要
          out.push({
            x: +U.clamp01(x / W).toFixed(5),
            y: +U.clamp01(y / H).toFixed(5),
            w: +U.clamp01(w / W).toFixed(5),
            h: +U.clamp01(h / H).toFixed(5)
          });
          if (out.length >= 120) break;
        }
      }
    } catch (e) {
      console.warn('[Viewer] 解析页面图片失败', n, e);
    }

    /* ---- 链接 ---- */
    try {
      const annots = await page.getAnnotations({ intent: 'display' });
      (annots || []).forEach((a) => {
        if (!a || a.subtype !== 'Link') return;
        const rect = a.rect;
        if (!rect || rect.length < 4) return;
        let vr;
        try { vr = vp.convertToViewportRectangle(rect); } catch (e) { vr = null; }
        if (!vr) return;
        const x1 = Math.min(vr[0], vr[2]);
        const y1 = Math.min(vr[1], vr[3]);
        const x2 = Math.max(vr[0], vr[2]);
        const y2 = Math.max(vr[1], vr[3]);
        if (x2 - x1 < 2 || y2 - y1 < 2) return;
        links.push({
          x: +U.clamp01(x1 / W).toFixed(5),
          y: +U.clamp01(y1 / H).toFixed(5),
          w: +U.clamp01((x2 - x1) / W).toFixed(5),
          h: +U.clamp01((y2 - y1) / H).toFixed(5),
          url: a.url || a.unsafeUrl || '',
          dest: a.dest || null
        });
      });
    } catch (e) {
      console.warn('[Viewer] 解析页面链接失败', n, e);
    }

    /* 解析完成才写缓存；异常时不写，下次点击还能重试 */
    this._imgs.set(n, out);
    this._links.set(n, links);
    this._parsing.delete(n);
  }

  /* 命中测试：后画的在上层，所以倒序找第一个包含点的元素
     padX / padY 是归一化的容差，给「点边缘差几个像素」留余量 */
  findImageAt(page, x, y, padX, padY) {
    const list = this._imgs.get(page) || [];
    const px = padX || 0;
    const py = padY || 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (x >= r.x - px && x <= r.x + r.w + px && y >= r.y - py && y <= r.y + r.h + py) return r;
    }
    return null;
  }

  /* v3.31：点中 PDF 里的图片时，给它描一圈框。
     用户报「点一下图片就弹工具条，但我不知道点的是哪一张」——
     尤其页面上并排几张图、或者图和文字很接近时。
     框画在 .pinLayer 里（inset:0、pointer-events:none、百分比定位）：
     跟着页面缩放走，也不会挡住后续的点击与选字。 */
  markImage(pageEl, rect) {
    this.clearImageMark();
    if (!pageEl || !rect) return;
    const layer = pageEl.querySelector('.pinLayer') || pageEl;
    const box = U.el('div', { class: 'img-pick' });
    box.style.left = (rect.x * 100).toFixed(3) + '%';
    box.style.top = (rect.y * 100).toFixed(3) + '%';
    box.style.width = (rect.w * 100).toFixed(3) + '%';
    box.style.height = (rect.h * 100).toFixed(3) + '%';
    layer.appendChild(box);
    this._imgPick = box;
  }

  clearImageMark() {
    const b = this._imgPick;
    this._imgPick = null;
    if (!b) return;
    try { b.remove(); } catch (e) { /* ignore */ }
  }

  findLinkAt(page, x, y, padX, padY) {
    const list = this._links.get(page) || [];
    const px = padX || 0;
    const py = padY || 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (x >= r.x - px && x <= r.x + r.w + px && y >= r.y - py && y <= r.y + r.h + py) return r;
    }
    return null;
  }

  /* 点击点是否落在「当前文字选区」里：用来区分「点空白清选中」和「点图片」，
     不能简单用 selection 是否为空来判断——选完字再点图片时选区往往还没塌陷。 */
  _pointInSelection(clientX, clientY) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return false;
      const pad = 3;
      return clientX >= r.left - pad && clientX <= r.right + pad
        && clientY >= r.top - pad && clientY <= r.bottom + pad;
    } catch (e) { return false; }
  }

  /* 拖选守卫（v3.21）
     鼠标按下到抬起这段时间算「正在划词」。这期间必须停掉两件会反复强制布局/重绘的事：
       ① app.js 的 selectionchange 几何快照（每 140ms 一次，逐文本节点 getClientRects）；
       ② 下面 _bindHover 里的链接/图片悬停框（带蓝底蓝边，跟着鼠标出现又消失，
          看着就像「一片区域忽闪着变蓝」）。
     少了这道闸，选区就会跟不上鼠标、并且整片蓝色来回闪。
     mouseup 用 capture 先复位，app.js 的 onDocumentMouseUp（冒泡 + 10ms 延时）
     随后取一次完整快照，几何结果一点不少。 */
  _bindSelectGuard() {
    const down = (e) => {
      if (e.button !== 0) return;
      this._selecting = !!(e.target && e.target.closest && e.target.closest('.page'));
      if (this._selecting) {
        this._setHover(null, null);
        this.clearSelBand();
        /* 行高用来当「容差单位」：同一个常数不能同时适配 100% 和 250% 缩放 */
        let lh = 14;
        try {
          const sp = e.target.closest && e.target.closest('.textLayer span');
          if (sp) { const h = sp.getBoundingClientRect().height; if (h > 3) lh = h; }
        } catch (err) { /* ignore */ }
        this._dragBand = {
          l: e.clientX, r: e.clientX, t: e.clientY, b: e.clientY,
          x: e.clientX, y: e.clientY,
          startX: e.clientX, startY: e.clientY, moved: false,
          lineH: Math.max(9, Math.min(lh, 120))
        };
        /* 先把按下这一页的文本几何缓存住（只一页，代价可控），
           拖到别的页时再按需补缓存。 */
        this._invalidateDragNodes();
        this._downCaret = null;
        if (e.target.closest) this._cacheDragNodes(e.target.closest('.page'));
        /* v3.28：记下按下点最近的字。拖到行间空白时浏览器会把起点吸附到整段开头，
           有它就能把起点钉回来（见 _snapRange）。 */
        try {
          const SB = window.SelBand;
          if (SB && SB.pickCaret) {
            this._downCaret = SB.pickCaret(this._textNodesNearBand(this._dragBand), e.clientX, e.clientY);
          }
        } catch (err) { this._downCaret = null; }
      } else {
        this._dragBand = null;
        this._invalidateDragNodes();
      }
    };
    const move = (e) => {
      if (!this._selecting || !this._dragBand) return;
      const b = this._dragBand;
      b.l = Math.min(b.l, e.clientX); b.r = Math.max(b.r, e.clientX);
      b.t = Math.min(b.t, e.clientY); b.b = Math.max(b.b, e.clientY);
      b.x = e.clientX; b.y = e.clientY;
      if (!b.moved) {
        b.moved = Math.abs(e.clientX - b.startX) + Math.abs(e.clientY - b.startY) > 3;
      }
      if (!this._bandRaf && typeof requestAnimationFrame === 'function') {
        this._bandRaf = requestAnimationFrame(() => this._paintLiveBand());
      }
    };
    const up = () => {
      if (!this._selecting) return;
      this._selecting = false;
      if (this._bandRaf) { cancelAnimationFrame(this._bandRaf); this._bandRaf = 0; }
      /* 先修数据再让 app.js 取快照：app.js 的 onDocumentMouseUp 延时 10ms，
         这里同步改 range 完全来得及，摘录 / 翻译拿到的就是真实拖过的文字。 */
      this._clampSelection();
      this._downCaret = null;
    };
    document.addEventListener('mousedown', down, { capture: true, passive: true });
    document.addEventListener('mousemove', move, { capture: true, passive: true });
    document.addEventListener('mouseup', up, { capture: true, passive: true });
    document.addEventListener('pointercancel', up, { capture: true, passive: true });
    /* 拖到窗口外松手 / 切走焦点：别让 _selecting 卡成 true */
    window.addEventListener('blur', up);
  }

  isSelecting() { return !!this._selecting; }

  /* ---------------- v3.22：柔和选区条带 + 吸附修正 ---------------- */

  /* 只取当前可见页的矩形，避免每帧对几百页做 getBoundingClientRect */
  _pageRects(band) {
    const idx = new Set(this.intersecting || []);
    idx.add(this.current);
    const out = [];
    idx.forEach((n) => {
      const el = this.pageEls[n - 1];
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (band && (r.bottom < band.t - 60 || r.top > band.b + 60)) return;
      out.push({ page: n, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    });
    return out;
  }

  /* ---------------- 拖选期间的文本几何缓存（v3.23） ----------------
     一页几百个文本节点，每个取一次矩形是「按下时一次性」的开销，可以接受；
     换来的是拖动过程中每帧只需要对落在拖拽带里的十几个节点算几何。 */

  _invalidateDragNodes() {
    this._dragNodes = null;
    this._dragNodePages = null;
  }

  _cacheDragNodes(pageEl) {
    if (!pageEl || !pageEl.dataset) return;
    const page = parseInt(pageEl.dataset.page, 10);
    if (!page) return;
    if (!this._dragNodes) this._dragNodes = [];
    if (!this._dragNodePages) this._dragNodePages = new Set();
    if (this._dragNodePages.has(page)) return;
    this._dragNodePages.add(page);
    const layer = pageEl.querySelector('.textLayer');
    if (!layer || !layer.firstChild) return;
    let walker, node;
    try { walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null); } catch (e) { return; }
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      let rr;
      try {
        const rg = document.createRange();
        rg.selectNodeContents(node);
        rr = rg.getBoundingClientRect();
      } catch (e) { continue; }
      if (!rr || (!rr.width && !rr.height)) continue;
      this._dragNodes.push({ node: node, page: page, left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom });
    }
  }

  _ensureDragNodes(band) {
    const rects = this._pageRects(band);
    for (let i = 0; i < rects.length; i++) {
      const el = this.pageEls[rects[i].page - 1];
      if (el) this._cacheDragNodes(el);
    }
  }

  /* 逐文本节点取「本次选区实际覆盖的那一段」矩形。
     不能用 range.getClientRects() 一把梭 —— 跨多个绝对定位 span 时它会给回
     整块包围盒，看起来就是一个大方框。逐个节点 selectNodeContents +
     setStart/setEnd 才能拿到真实的半行 / 整行。 */
  _liveRects(range, band) {
    const out = [];
    const nodes = this._dragNodes || [];
    if (!band) return out;
    const lh = band.lineH || 14;
    /* v3.28：窗口从「3 行 + 40px」收到「不到一行」。
       以前浏览器把选区吸附到整段时，这个宽窗口会把整段的行都算进条带，
       于是一帧之内整段蓝一下 —— 用户看到的就是「闪烁」。
       真正的上下界由 _snapRange 修正；这里只是最后一道过滤。 */
    const T = band.t - lh * 0.7;
    const B = band.b + lh * 0.7;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.bottom < T || n.top > B) continue;
      let hit = false;
      try { hit = range.intersectsNode(n.node); } catch (e) { continue; }
      if (!hit) continue;
      const len = (n.node.nodeValue || '').length;
      let nr;
      try {
        nr = document.createRange();
        nr.selectNodeContents(n.node);
        if (n.node === range.startContainer) nr.setStart(n.node, Math.min(range.startOffset, len));
        if (n.node === range.endContainer) nr.setEnd(n.node, Math.min(range.endOffset, len));
      } catch (e) { continue; }
      if (nr.collapsed) continue;
      let list;
      try { list = nr.getClientRects(); } catch (e) { continue; }
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        if (r.width <= 0.5 || r.height <= 0.5) continue;
        out.push({ page: n.page, left: r.left, top: r.top, width: r.width, height: r.height });
      }
    }
    return out;
  }

  /* 拖拽过程中画的条带：真实行矩形，不裁横向宽度。
     用户从段落中间往下拖时，首行从按下处开始、末行到抬起处结束、中间整行 ——
     这正是「每一行跟着一起选中」的观感，而不是一个方框。 */
  _paintLiveBand() {
    this._bandRaf = 0;
    const SB = window.SelBand;
    const band = this._dragBand;
    if (!SB || !band || !this._selecting) return;
    let sel;
    try { sel = window.getSelection(); } catch (e) { return; }
    if (!SB.canPaint(this.tool, sel && sel.rangeCount, !sel || sel.isCollapsed)) return;
    let range;
    try { range = sel.getRangeAt(0); } catch (e) { return; }
    /* v3.28：每帧先修一次选区。
       鼠标走到行与行之间的空白时，Chromium 的命中测试会退回父级 .textLayer，
       把「起点 → 该父级末尾」整段算成选区。以前只在 mouseup 时修，
       于是拖动过程中会闪出一帧「整段被选中」。现在同一帧里就把它钉回真实范围，
       用户根本看不到那一帧。 */
    if (band.moved) {
      try { if (this._snapRange(sel, range, band)) range = sel.getRangeAt(0); } catch (e) { /* ignore */ }
    }

    this._ensureDragNodes(band);
    const raw = this._liveRects(range, band);
    if (!raw.length) { this.clearSelBand(); return; }

    const pmap = new Map();
    const prects = this._pageRects(band);
    for (let i = 0; i < prects.length; i++) pmap.set(prects[i].page, prects[i]);

    const byPage = new Map();
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      let arr = byPage.get(r.page);
      if (!arr) { arr = []; byPage.set(r.page, arr); }
      arr.push(r);
    }

    this.clearSelBand();
    const lh = band.lineH || 14;
    const tol = Math.max(4, lh * 0.9);
    byPage.forEach((list, page) => {
      const p = pmap.get(page);
      if (!p) return;
      const merged = U.mergeLineRects(list, tol);
      for (let i = 0; i < merged.length; i++) {
        const m = merged[i];
        this._drawBand({
          page: page,
          left: m.left - p.left,
          top: m.top - p.top,
          width: m.width,
          height: Math.min(m.height, lh * 1.8)
        });
      }
    });
  }

  /* mouseup 之后由 app.js 用 snapshotSelection 的精确行矩形重画一次 */
  paintSelection(info) {
    this.clearSelBand();
    if (!info || !info.groups) return;
    for (const g of info.groups) {
      const pageEl = this.pageEls[g.page - 1];
      if (!pageEl) continue;
      const w = pageEl.offsetWidth, h = pageEl.offsetHeight;
      if (!w || !h) continue;
      for (const r of (g.rects || [])) {
        this._drawBand({ page: g.page, left: r.x * w, top: r.y * h, width: Math.max(3, r.w * w), height: Math.max(6, r.h * h) });
      }
    }
  }

  _drawBand(m) {
    const el = this.pageEls[m.page - 1];
    if (!el) return;
    const layer = el.querySelector('.selBandLayer');
    if (!layer) return;
    const n = U.el('div', { class: 'sel-band' });
    n.style.left = m.left + 'px';
    n.style.top = m.top + 'px';
    n.style.width = Math.max(3, m.width) + 'px';
    n.style.height = Math.max(5, m.height) + 'px';
    layer.appendChild(n);
    this._bandEls.push(n);
  }

  clearSelBand() {
    const els = this._bandEls || [];
    for (let i = 0; i < els.length; i++) {
      try { els[i].remove(); } catch (e) { /* ignore */ }
    }
    this._bandEls = [];
  }

  /* 拖选结束的吸附修正（mouseup 之后仍要走一次：最后一帧可能落在空白处） */
  _clampSelection() {
    const band = this._dragBand;
    if (!band) return false;
    let sel;
    try { sel = window.getSelection(); } catch (e) { return false; }
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    let r;
    try { r = sel.getRangeAt(0); } catch (e) { return false; }
    return this._snapRange(sel, r, band);
  }

  /* 把被浏览器「吸附放大」的选区钉回真实拖过的范围（v3.28）
     ─────────────────────────────────────────────
     用「按下点最近的字」当锚、「指针最近的字」当焦点，重建一次选区。
     用 collapse + extend 而不是 setStart/setEnd：extend 自己会处理方向，
     从下往上拖时也不会把起止搞反。 */
  _snapRange(sel, range, band) {
    const SB = window.SelBand;
    if (!SB || !band || !sel || !range) return false;
    let sr;
    try { sr = range.getBoundingClientRect(); } catch (e) { return false; }
    if (!sr || (!sr.width && !sr.height)) return false;
    if (!SB.isSuspicious(sr, band, band.lineH)) return false;
    const nodes = this._textNodesNearBand(band);
    const focus = SB.pickCaret(nodes, band.x, band.y);
    const anchor = this._downCaret || SB.pickCaret(nodes, band.startX, band.startY);
    if (!focus || !anchor) return false;
    try {
      sel.collapse(anchor.node, anchor.offset);
      sel.extend(focus.node, focus.offset);
      return true;
    } catch (e) { return false; }
  }

  /* 拖拽带附近的候选文本节点（复用同一份缓存，不再重复遍历 DOM） */
  _textNodesNearBand(band) {
    const out = [];
    const lh = band.lineH || 14;
    const T = band.t - lh * 2, B = band.b + lh * 2;
    this._ensureDragNodes(band);
    const nodes = this._dragNodes || [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.bottom < T || n.top > B) continue;
      out.push({ node: n.node, left: n.left, top: n.top, right: n.right, bottom: n.bottom });
    }
    return out;
  }

  /* 链接 / 图片的悬停反馈：光标变成手型，并画一个细框 */
  _bindHover() {
    const move = U.rafThrottle((e) => {
      if (this._selecting) { this._setHover(null, null); return; }
      if (this.tool !== 'select') { this._setHover(null, null); return; }
      const pageEl = e.target.closest ? e.target.closest('.page') : null;
      if (!pageEl) { this._setHover(null, null); return; }
      const rect = pageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const page = parseInt(pageEl.dataset.page, 10);
      // 悬停时就顺手把这一页的图片几何解析好，点击才不会有「第一次没反应」
      if (!this._imgs.has(page)) this.ensureOverlays(page);
      const link = this.findLinkAt(page, x, y, 3 / rect.width, 3 / rect.height);
      if (link) { this._setHover(pageEl, link); return; }
      const img = this.findImageAt(page, x, y, 3 / rect.width, 3 / rect.height);
      this._setHover(img ? pageEl : null, img || null);
    });
    this.pagesEl.addEventListener('mousemove', move, { passive: true });
    this.pagesEl.addEventListener('mouseleave', () => this._setHover(null, null));
    this._hoverMove = move;
  }

  _setHover(pageEl, rect) {
    if (!pageEl || !rect) {
      if (this._hoverRect) { this._hoverRect.remove(); this._hoverRect = null; }
      this.pagesEl.style.cursor = '';
      return;
    }
    this.pagesEl.style.cursor = 'pointer';
    const w = pageEl.offsetWidth;
    const h = pageEl.offsetHeight;
    if (!w || !h) return;
    if (!this._hoverRect || this._hoverRect.parentNode !== pageEl) {
      if (this._hoverRect) this._hoverRect.remove();
      this._hoverRect = U.el('div', { class: 'link-hover' });
      pageEl.appendChild(this._hoverRect);
    }
    this._hoverRect.style.left = (rect.x * w) + 'px';
    this._hoverRect.style.top = (rect.y * h) + 'px';
    this._hoverRect.style.width = Math.max(2, rect.w * w) + 'px';
    this._hoverRect.style.height = Math.max(2, rect.h * h) + 'px';
  }

  async renderTextLayer(n, page, vp, el) {
    const pdfjsLib = window.pdfjsLib;
    const layer = el.querySelector('.textLayer');
    if (!layer || !pdfjsLib) return;
    let textContent;
    try {
      textContent = await page.getTextContent();
    } catch (e) {
      return;
    }
    if (this._destroyed) return;
    layer.innerHTML = '';
    layer.style.setProperty('--scale-factor', String(vp.scale));
    layer.style.width = Math.round(vp.width) + 'px';
    layer.style.height = Math.round(vp.height) + 'px';
    try {
      const task = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: layer,
        viewport: vp,
        textDivs: []
      });
      await (task.promise || task);
    } catch (e) {
      console.warn('[Viewer] 文字层渲染失败', e);
    }
    layer.style.opacity = '1';
    /* 文字层整层重建，旧节点已脱离文档，几何缓存必须作废 */
    this._invalidateDragNodes();
  }

  maybeRelease(n) {
    if (Math.abs(n - this.current) <= 8) return;
    if (this.intersecting.has(n)) return;
    const el = this.pageEls[n - 1];
    if (!el || el.dataset.renderedZoom !== String(this.zoom)) return;
    const canvas = el.querySelector('canvas');
    if (canvas && canvas.width > 0) {
      canvas.width = 0;
      canvas.height = 0;
      el.classList.remove('page-rendered');
      el.dataset.renderedZoom = '';
      const layer = el.querySelector('.textLayer');
      if (layer) { layer.innerHTML = ''; layer.style.opacity = '0'; }
    }
  }

  /* ---------------- 导航 ---------------- */
  updateCurrentPage(force) {
    if (!this.pageCount) return;
    const y = this.viewportEl.scrollTop + Math.min(140, this.viewportEl.clientHeight * 0.25);
    let lo = 0;
    let hi = this.offsets.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid] <= y) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const n = idx + 1;
    if (n !== this.current || force) {
      this.current = n;
      this.onPageChange(n, this.pageCount);
    }
    this.maybeRelease(Math.max(1, n - 10));
    this.maybeRelease(Math.min(this.pageCount, n + 10));
  }

  /* jsdom / 老内核没有 scrollTo，量一下兜底，免得一个 API 差异就把流程打断 */
  _scrollTo(top, smooth) {
    const box = this.viewportEl;
    if (!box) return;
    const y = Math.max(0, top);
    if (typeof box.scrollTo === 'function') {
      try { box.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' }); return; } catch (e) { /* 落到下面 */ }
    }
    box.scrollTop = y;
  }

  goToPage(n, opts) {
    opts = opts || {};
    n = U.clamp(Math.round(n), 1, this.pageCount || 1);
    const top = this.offsets[n - 1];
    if (typeof top !== 'number') return;
    this._scrollTo(top - 8, !opts.instant);
    this.current = n;
    this.onPageChange(n, this.pageCount);
    this.ensureRendered(n);
    if (opts.instant) this.renderVisible();
  }

  focusAnnotation(ann) {
    const el = this.pageEls[ann.page - 1];
    if (!el) return;
    const h = el.offsetHeight;
    let target = this.offsets[ann.page - 1] || 0;
    if (ann.rects && ann.rects.length) target += ann.rects[0].y * h;
    else if (ann.point) target += ann.point.y * h;
    this._scrollTo(target - this.viewportEl.clientHeight * 0.32, true);
    this.flashAnn(ann);
  }

  /* 定位反馈（v3.14 重做）
     ────────────────────────────
     旧做法是给整页盖一层 `--accent-soft` 再淡出：点一条摘录，整个阅读区泛一下蓝。
     问题不只是难看 —— 它和高亮用的是同一个色系，很多人第一反应是「高亮又出问题了」。
     而且这层是铺在页面上的合成层，和之前修过的「删了摘录色块还在」是同一类隐患。

     改成只在这条摘录自己的矩形上描一圈、闪一下就走：
       ① 信息更准 —— 闪的就是目标本身，眼睛不用再找；
       ② 不再整页泛蓝 —— 蓝色只剩细细一圈描边，和「选中」是同一套视觉语言。 */
  flashAnn(ann) {
    const el = this.pageEls[ann.page - 1];
    if (!el || !ann) return;
    const w = el.clientWidth || el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const boxes = [];
    if (ann.rects && ann.rects.length) {
      ann.rects.forEach((r) => boxes.push(r));
    } else if (ann.point) {
      boxes.push({ x: ann.point.x - 0.02, y: ann.point.y - 0.02, w: 0.09, h: 0.05 });
    }
    boxes.forEach((r) => {
      const n = U.el('div', { class: 'ann-flash' });
      n.style.left = Math.max(0, r.x * w - 3) + 'px';
      n.style.top = Math.max(0, r.y * h - 3) + 'px';
      n.style.width = Math.max(8, r.w * w + 6) + 'px';
      n.style.height = Math.max(8, r.h * h + 6) + 'px';
      el.appendChild(n);
      setTimeout(() => { try { n.remove(); } catch (e) { /* ignore */ } }, 780);
    });
  }


  /* ---------------- 工具 ---------------- */
  setTool(tool) {
    this.tool = tool;
    this.pagesEl.className = 'pages tool-' + tool;
    this.clearSelBand();
    if (tool !== 'select') this.clearSelection();
  }

  clearSelection() {
    try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
    this.clearSelBand();
  }

  /* ---------------- 选区 → 几何（重点：准确性） ---------------- */

  /**
   * 逐「文本节点」取矩形，再按行合并。
   * 这样能避免 Range.getClientRects 在 justify 排版、跨 span、跨页时给出的
   * 粗略矩形（旧实现漏亮/错位的主要来源）。
   */
  _pageRange(range, layer) {
    const r = range.cloneRange();
    try {
      if (!layer.contains(r.startContainer)) r.setStart(layer, 0);
      if (!layer.contains(r.endContainer)) r.setEnd(layer, layer.childNodes.length);
    } catch (e) { /* ignore */ }
    if (r.collapsed) return null;
    return r;
  }

  _rectsForRange(r, pageRect) {
    const raw = [];
    const root = r.commonAncestorContainer;
    const container = root && root.nodeType === 3 ? root.parentNode : root;
    if (!container) return [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      try { if (!r.intersectsNode(node)) continue; } catch (e) { continue; }
      const nr = document.createRange();
      try {
        nr.selectNodeContents(node);
        if (node === r.startContainer) nr.setStart(node, r.startOffset);
        if (node === r.endContainer) nr.setEnd(node, r.endOffset);
      } catch (e) { continue; }
      if (nr.collapsed) continue;
      let list;
      try { list = nr.getClientRects(); } catch (e) { continue; }
      for (const rect of list) {
        if (rect.width <= 0.5 || rect.height <= 0.5) continue;
        // 只保留页面内的部分，并裁剪到页面边界
        const left = Math.max(rect.left, pageRect.left);
        const right = Math.min(rect.right, pageRect.right);
        const top = Math.max(rect.top, pageRect.top);
        const bottom = Math.min(rect.bottom, pageRect.bottom);
        if (right - left <= 0.5 || bottom - top <= 0.5) continue;
        raw.push({ left, top, width: right - left, height: bottom - top });
      }
    }
    return raw;
  }

  /**
   * 返回 { groups:[{page, rects, text, clientRect}], text }
   * 跨页选择会被拆成多组，交由上层生成多条标注。
   */
  snapshotSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const fullText = U.normalizeText(sel.toString());
    if (!fullText) return null;

    const groups = [];
    for (const pageEl of this.pageEls) {
      const layer = pageEl.querySelector('.textLayer');
      if (!layer || !layer.firstChild) continue;
      let hit = false;
      try { hit = range.intersectsNode(layer); } catch (e) { hit = false; }
      if (!hit) continue;

      const pr = this._pageRange(range, layer);
      if (!pr) continue;
      const pageRect = pageEl.getBoundingClientRect();
      if (!pageRect.width || !pageRect.height) continue;

      const raw = this._rectsForRange(pr, pageRect);
      if (!raw.length) continue;

      // 行高估算 → 行内合并容差（避免把分栏之间的空白也连成一条）
      const heights = raw.map((r) => r.height).sort((a, b) => a - b);
      const medianH = heights[Math.floor(heights.length / 2)] || 12;
      const merged = U.mergeLineRects(raw, Math.max(4, medianH * 0.9));
      if (!merged.length) continue;

      const rects = merged.map((r) => ({
        x: +U.clamp01((r.left - pageRect.left) / pageRect.width).toFixed(5),
        y: +U.clamp01((r.top - pageRect.top - 0.5) / pageRect.height).toFixed(5),
        w: +Math.max(0.002, r.width / pageRect.width).toFixed(5),
        h: +Math.max(0.002, (r.height + 1) / pageRect.height).toFixed(5)
      }));

      const last = merged[merged.length - 1];
      const first = merged[0];
      groups.push({
        page: parseInt(pageEl.dataset.page, 10),
        rects,
        text: U.normalizeText(pr.toString()) || fullText,
        clientRect: {
          left: first.left,
          top: first.top,
          right: last.left + last.width,
          bottom: Math.max(first.top + first.height, last.top + last.height)
        }
      });
    }

    if (!groups.length) return null;
    return { groups, text: fullText };
  }

  /* ---------------- 点击命中（高亮在文字层下方，靠坐标反查） ---------------- */
  _bindClick() {
    this.pagesEl.addEventListener('click', (e) => {
      if (this.tool !== 'select') return;
      if (e.target.closest && e.target.closest('.ann-pin')) return;
      // 刚刚由 mousedown 判定为「点中图片」，这次 click 不再重复处理
      if (this._imgPickedAt && Date.now() - this._imgPickedAt < 500) return;
      // 点在文字选区内部 → 这是选字动作的余波，不当成点击
      if (this._pointInSelection(e.clientX, e.clientY)) return;
      const pageEl = e.target.closest ? e.target.closest('.page') : null;
      if (!pageEl) return;
      const rect = pageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const page = parseInt(pageEl.dataset.page, 10);
      const padX = 4 / rect.width;
      const padY = 4 / rect.height;

      // 1) 链接优先：点链接不该被当成「点空白」而清掉选中
      const link = this.findLinkAt(page, x, y, padX, padY);
      if (link) { this.onLinkPick(link, pageEl); return; }

      // 2) 已有标注
      const hits = [];
      this.getAnnotations().forEach((a) => {
        if (a.page !== page) return;
        if (a.type === 'note') {
          const p = a.point;
          if (p && Math.abs(p.x - x) * rect.width < 12 && Math.abs(p.y - y) * rect.height < 12) hits.push(a);
          return;
        }
        (a.rects || []).forEach((r) => {
          const pad = 2 / rect.height;
          if (x >= r.x - 1 / rect.width && x <= r.x + r.w + 1 / rect.width &&
              y >= r.y - pad && y <= r.y + r.h + pad) hits.push(a);
        });
      });
      if (hits.length) { this.onPageClick(hits[hits.length - 1], pageEl); return; }

      // 3) 图片：点中图片就当成选中这张图（可摘录 / 复制）
      const img = this.findImageAt(page, x, y, padX, padY);
      if (img) { this.onImagePick({ page, rect: img }, pageEl); return; }

      /* 这一页还没解析过图片几何（首次渲染后才异步解析）：
         先解析再重试一次，避免「第一次点图没反应，第二次才有」 */
      if (!this._imgs.has(page)) {
        this.ensureOverlays(page).then(() => {
          const again = this.findImageAt(page, x, y, padX, padY);
          if (again) this.onImagePick({ page, rect: again }, pageEl);
          else this.onPageClick(null, pageEl);
        }).catch(() => this.onPageClick(null, pageEl));
        return;
      }

      // 4) 都没命中 → 通知外层取消选中（去掉高亮边框）
      this.onPageClick(null, pageEl);
    });
  }

  /* ---------------- 框选 / 锚点 ---------------- */
  _bindAreaDrag() {
    let drag = null;
    const onDown = (e) => {
      if (e.button !== 0) return;
      const pageEl = e.target.closest ? e.target.closest('.page') : null;
      if (!pageEl) return;

      if (this.tool === 'note') {
        const r = pageEl.getBoundingClientRect();
        this.onNotePoint({
          page: parseInt(pageEl.dataset.page, 10),
          point: {
            x: +(((e.clientX - r.left) / r.width).toFixed(5)),
            y: +(((e.clientY - r.top) / r.height).toFixed(5))
          }
        });
        return;
      }

      /* 选择模式下按下时先记「可能点到图片」：
         用 mousedown/up 而不是 click，因为 PDF 的文字层会吃掉 click，
         而且选完文字后选区没塌陷时 click 会被判断成「还在选字」。 */
      if (this.tool === 'select') {
        const r = pageEl.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const page = parseInt(pageEl.dataset.page, 10);
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        const img = this.findImageAt(page, x, y, 4 / r.width, 4 / r.height);
        this._imgPress = img ? { page, rect: img, pageEl, sx: e.clientX, sy: e.clientY } : null;
        return;
      }

      if (this.tool !== 'area') return;

      const r = pageEl.getBoundingClientRect();
      drag = { pageEl, startX: e.clientX, startY: e.clientY, rect: r, rubber: null };
      e.preventDefault();
    };

    const onMove = (e) => {
      if (this._imgPress) {
        const p = this._imgPress;
        if (Math.abs(e.clientX - p.sx) > 6 || Math.abs(e.clientY - p.sy) > 6) this._imgPress = null;
      }
      if (!drag) return;
      const x1 = Math.min(drag.startX, e.clientX);
      const y1 = Math.min(drag.startY, e.clientY);
      const w = Math.abs(e.clientX - drag.startX);
      const h = Math.abs(e.clientY - drag.startY);
      if (!drag.rubber && w < 4 && h < 4) return;
      if (!drag.rubber) {
        drag.rubber = U.el('div', { class: 'area-rubber' });
        drag.pageEl.querySelector('.pinLayer').appendChild(drag.rubber);
      }
      drag.rubber.style.left = (x1 - drag.rect.left) + 'px';
      drag.rubber.style.top = (y1 - drag.rect.top) + 'px';
      drag.rubber.style.width = w + 'px';
      drag.rubber.style.height = h + 'px';
    };

    const onUp = (e) => {
      // 图片：按下与抬起几乎同一点 → 认定是「点选图片」，立刻弹工具条
      if (this._imgPress && !drag) {
        const p = this._imgPress;
        this._imgPress = null;
        if (Math.abs(e.clientX - p.sx) <= 6 && Math.abs(e.clientY - p.sy) <= 6) {
          this._imgPickedAt = Date.now();
          this.onImagePick({ page: p.page, rect: p.rect }, p.pageEl);
          return;
        }
      }
      this._imgPress = null;
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.rubber) d.rubber.remove();
      const x1 = Math.min(d.startX, e.clientX);
      const y1 = Math.min(d.startY, e.clientY);
      const x2 = Math.max(d.startX, e.clientX);
      const y2 = Math.max(d.startY, e.clientY);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w < 8 || h < 8) return;
      this.onAreaRect({
        page: parseInt(d.pageEl.dataset.page, 10),
        /* v3.28.3：顺手带上「屏幕上的位置」。正常走 pdf.js 重渲染不需要它，
           但万一那条路失败，可以用窗口截屏兜底 —— 这时要的是视口坐标。 */
        client: { x: x1, y: y1, w: w, h: h },
        rect: {
          x: +U.clamp01((x1 - d.rect.left) / d.rect.width).toFixed(5),
          y: +U.clamp01((y1 - d.rect.top) / d.rect.height).toFixed(5),
          w: +U.clamp01(w / d.rect.width).toFixed(5),
          h: +U.clamp01(h / d.rect.height).toFixed(5)
        }
      });
    };

    this.pagesEl.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    this._dragCleanup = () => {
      this.pagesEl.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }

  /* ---------------- 搜索命中的临时标记 ----------------
     和「真高亮」完全分开：这一层只活在内存里，绝不写进 PDF，
     清空关键字 / 退出插件就没了。放在 hlLayer 下面，不挡选字。

     v3.3.2：切「当前命中」只改 class，不重建 DOM。之前每跳一次都把每一页
     的 searchLayer 清空重画（几百页 = 几百次 innerHTML），再加一次 720ms 的
     翻页闪白，整个阅读区就在闪。 */
  setSearchMarks(hits, activeIndex) {
    const before = new Set(this._marks.keys());
    this._marks.clear();
    this._markEls = [];
    (hits || []).forEach((h, i) => {
      if (!h || !h.rects || !h.rects.length) return;
      const page = h.page || 1;
      if (!this._marks.has(page)) this._marks.set(page, []);
      this._marks.get(page).push({ rects: h.rects, index: i });
    });
    const after = new Set(this._marks.keys());
    this._activeMark = -1;                       // 重建后强制重刷一次 active
    const touch = new Set([...before, ...after]); // 只重画受影响的页
    touch.forEach((p) => this.renderSearchMarksForPage(p));
    this.setActiveMark(activeIndex);
  }

  clearSearchMarks() {
    const pages = [...this._marks.keys()];
    this._marks.clear();
    this._markEls = [];
    this._activeMark = -1;
    pages.forEach((p) => this.renderSearchMarksForPage(p));
  }

  hasSearchMarks() { return this._marks.size > 0; }

  renderSearchMarks() {
    for (let i = 0; i < this.pageEls.length; i++) this.renderSearchMarksForPage(i + 1);
  }

  renderSearchMarksForPage(n) {
    const pageEl = this.pageEls[n - 1];
    if (!pageEl) return;
    const layer = pageEl.querySelector('.searchLayer');
    if (!layer) return;
    layer.innerHTML = '';
    /* 这一页的旧节点先摘掉，免得 _markEls 里留下死引用 */
    if (this._markEls && this._markEls.length) {
      this._markEls = this._markEls.filter((m) => m.page !== n);
    } else {
      this._markEls = [];
    }
    const list = this._marks.get(n);
    if (!list || !list.length) return;
    const w = pageEl.offsetWidth;
    const h = pageEl.offsetHeight;
    if (!w || !h) return;
    list.forEach((m) => {
      (m.rects || []).forEach((r) => {
        const node = U.el('div', { class: 'search-mark' + (m.index === this._activeMark ? ' active' : '') });
        node.style.left = (r.x * w) + 'px';
        node.style.top = (r.y * h) + 'px';
        node.style.width = Math.max(2, r.w * w) + 'px';
        node.style.height = Math.max(2, r.h * h) + 'px';
        layer.appendChild(node);
        this._markEls.push({ page: n, index: m.index, node });
      });
    });
  }

  /* 只切 class —— O(标记数)，不碰布局，不触发重绘 */
  setActiveMark(i) {
    if (this._activeMark === i) return;
    this._activeMark = i;
    (this._markEls || []).forEach((m) => {
      m.node.classList.toggle('active', m.index === i);
    });
  }

  /* 滚到某个命中的确切位置（不是只翻到那一页）。
     用瞬时滚动：平滑滚动会一路触发惰性渲染，看起来就是一串闪白。 */
  focusSearchMark(hit) {
    if (!hit) return;
    const n = hit.page || 1;
    const pageEl = this.pageEls[n - 1];
    const base = this.offsets[n - 1] || 0;
    let target = base;
    const r = hit.rects && hit.rects[0];
    if (pageEl && r) target = base + r.y * pageEl.offsetHeight;
    if (this.current !== n) {
      this.current = n;
      this.onPageChange(n, this.pageCount);
    }
    this.ensureRendered(n);
    this._scrollTo(target - this.viewportEl.clientHeight * 0.3, false);
  }

  /* ---------------- 缩略图 ---------------- */
  async renderThumb(pageNum, canvas, width) {
    if (!this.doc || !canvas) return;
    const page = await this.doc.proxy.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(0.05, width / base.width);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    canvas.style.width = Math.round(vp.width) + 'px';
    canvas.style.height = Math.round(vp.height) + 'px';
    const prev = this._thumbTasks.get(pageNum);
    if (prev) { try { prev.cancel(); } catch (e) { /* ignore */ } }
    const task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    });
    this._thumbTasks.set(pageNum, task);
    try {
      await task.promise;
    } catch (e) {
      if (!e || e.name !== 'RenderingCancelledException') console.warn('[Viewer] 缩略图渲染失败', pageNum, e);
    }
  }

  destroy() {
    this._destroyed = true;
    this.cancelRenders();
    if (this.io) this.io.disconnect();
    this._onScroll && this.viewportEl.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    if (this._dragCleanup) this._dragCleanup();
    if (this.doc && this.doc.proxy) {
      try { this.doc.proxy.destroy(); } catch (e) { /* ignore */ }
    }
  }
}
