/* 工作台 · 知识库 · 回收站

   工作台 = 打开资料库的门面：时钟、每日笔记、最近阅读、统计、年度热力图、维护入口。
   知识库 = 便利贴卡片墙，点卡片直接在插件内打开原文（溯源）。
   回收站 = 删除的摘录/笔记保留 30 天。

   关于「能不能在 Eagle 界面上放一个实体按钮」：
   Eagle 4.0 没有向插件开放左侧边栏/工具栏的扩展点（app.asar 里检索
   manifest.sidebar / sidebarPlugins / plugin.sidebar / pluginModule.sidebar 均无命中），
   所以工作台只能是插件首屏 + 顶栏入口，无法插进「全部 / 未分类」上方。 */
const Workbench = (function () {
  let loading = false;
  let clockTimer = null;
  let dailyTimer = null;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function open(force) {
    const v = document.getElementById('wbView');
    if (!v) return;
    v.hidden = false;
    refreshCloseBtn();
    if (typeof Esc !== 'undefined') Esc.push('workbench', escBack);
    startClock();
    if (!force && v.dataset.loaded === '1') { fillDaily(); return; }
    render();
  }

  /* 工作台背后是否还开着一篇文档（从摘录 / 笔记界面点进来时 itemId 在）。
     没有文档 → 工作台就是这扇窗唯一的内容（置顶启动器 / 顶栏图标打开），
     这时「返回」应当关掉整扇窗，回到 Eagle 资料库。 */
  function hasDocBehind() {
    return !!(window.AppState && window.AppState.doc);
  }

  /* 根据打开位置刷新「返回」按钮的文案与提示：
     · 背后有文档 → 「返回刚才的摘录笔记界面」（只收起工作台）
     · 背后没有文档（置顶启动器 / 顶栏图标）→ 「返回资料库」（关窗回到 Eagle） */
  function refreshCloseBtn() {
    const btn = document.getElementById('btnWbClose');
    if (!btn) return;
    if (hasDocBehind()) {
      btn.textContent = '返回刚才的摘录笔记界面';
      btn.title = '回到刚才的 PDF 摘录 / 笔记界面';
    } else {
      btn.textContent = '返回资料库';
      btn.title = '关闭工作台，回到 Eagle 资料库';
    }
  }

  /* 「返回」按钮的终点：有文档在背后就只收起工作台，否则直接关窗。
     关窗走 framewin 的 closeSelf（App.exit → Bridge.closeSelf → IPC → window.close 兜底），
     和标题栏 ✕ 同一条路，保证在 Eagle 插件窗里真能关掉。 */
  function returnToLibrary() {
    if (!hasDocBehind()) {
      if (typeof FrameWin !== 'undefined' && FrameWin.closeSelf) {
        try { FrameWin.closeSelf(); return; } catch (e) { /* 落到下面收起 */ }
      }
    }
    close();
  }

  /* ESC 的落点（v3.41.2，用户拍板：置顶栏场景三个出口行为一致）：
     · 背后有文档（摘录 / 笔记界面点进来）→ 收起工作台，回到摘录笔记界面；
     · 背后没有文档（置顶启动器 / 顶栏图标）→ 直接关窗回 Eagle 资料库，
       走 returnToLibrary（App.exit 存草稿 → closeSelf），和「返回资料库」按钮同一条路。
     历史：v3.3 曾因为「ESC 直接关窗」被用户当成误关插件而改成只收起；
     现在只对「背后无文档」的窗口恢复关窗 —— 那种窗口里工作台就是全部内容，
     收起到一个空的插件界面没有意义。有文档时 ESC 仍然只收起，铁律不变。 */
  function escBack() {
    if (!hasDocBehind()) { returnToLibrary(); return; }
    close();
  }

  /* 收起工作台：只把界面藏起来，不碰窗口。 */
  function close() {
    const v = document.getElementById('wbView');
    if (v) v.hidden = true;
    stopClock();
    /* 按钮是用鼠标点的，焦点会一直留在它身上 —— 浏览器那圈默认焦点环就跟着
       一直挂在「工作台」上（v3.14）。退出时把焦点收回去，鼠标用户不该看到焦点环。 */
    const btn = document.getElementById('btnWorkbench');
    if (btn && document.activeElement === btn) {
      try { btn.blur(); } catch (err) { /* ignore */ }
    }
    if (typeof Esc !== 'undefined') Esc.remove('workbench');
  }

  function isOpen() {
    const v = document.getElementById('wbView');
    return !!(v && !v.hidden);
  }

  /* ---------- 时钟 ---------- */
  function tick() {
    const t = document.getElementById('wbTime');
    const d = document.getElementById('wbDate');
    const now = new Date();
    if (t) t.textContent = U.fmtClock(now);
    if (d) d.textContent = U.fmtDateCN(now) + ' · ' + now.getFullYear();
  }
  function startClock() {
    tick();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
  }
  function stopClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  /* ---------- 每日笔记 ---------- */
  function dailyKey() { return U.dateKey(); }

  function fillDaily() {
    const box = document.getElementById('wbDaily');
    const dateEl = document.getElementById('wbDailyDate');
    const stat = document.getElementById('wbDailyStat');
    const key = dailyKey();
    if (dateEl) dateEl.textContent = key;
    if (box && box.dataset.key !== key) {
      box.dataset.key = key;
      box.value = Store.getDaily(key) || '';
    }
    if (stat) {
      const n = (box && box.value.trim().length) || 0;
      stat.textContent = n ? (n + ' 字 · 已自动保存') : '还没写，今天的第一条想法？';
    }
  }

  function bindDaily() {
    const box = document.getElementById('wbDaily');
    if (!box || box.dataset.bound === '1') return;
    box.dataset.bound = '1';
    box.addEventListener('input', () => {
      const stat = document.getElementById('wbDailyStat');
      if (stat) stat.textContent = (box.value.trim().length || 0) + ' 字 · 保存中…';
      if (dailyTimer) clearTimeout(dailyTimer);
      dailyTimer = setTimeout(() => {
        Store.saveDaily(box.dataset.key || dailyKey(), box.value);
        Store.rebuildIndex();
        const s2 = document.getElementById('wbDailyStat');
        if (s2) s2.textContent = (box.value.trim().length || 0) + ' 字 · 已自动保存';
      }, 600);
    });
  }

  function fmtNo(n) {
    const x = Number(n) || 0;
    if (x >= 10000) return (x / 10000).toFixed(1) + ' 万';
    return String(x);
  }

  async function render() {
    if (loading) return;
    loading = true;
    const sub = document.getElementById('wbSub');
    if (sub) sub.textContent = '正在统计…';

    const cards = document.getElementById('wbCards');
    const types = document.getElementById('wbTypes');
    const heat = document.getElementById('wbHeat');
    const recent = document.getElementById('wbRecent');
    const pathEl = document.getElementById('wbPath');
    const docsBox = document.getElementById('wbRecentDocs');

    let idx = null;
    try { idx = Store.getIndex(); } catch (e) { idx = null; }
    const entries = (idx && idx.entries) || [];
    const docs = (idx && idx.docs) || {};

    let items = [];
    let total = 0;
    if (typeof Bridge !== 'undefined' && Bridge.hasEagle) {
      try { items = await Bridge.getAllItems(); } catch (e) { items = []; }
      total = items.length;
      if (!total) { try { total = await Bridge.countItems(); } catch (e) { total = 0; } }
    }

    const exCount = entries.filter((e) => e.kind === 'excerpt').length;
    const ntCount = entries.filter((e) => e.kind === 'note').length;
    const docCount = Object.keys(docs).length;
    const pdfCount = items.filter((it) => (it.ext || '').toLowerCase() === 'pdf').length;

    /* ---------- 顶部数字卡（可点击跳知识库） ---------- */
    if (cards) {
      cards.innerHTML = '';
      const list = [
        { k: '资料库文件', v: fmtNo(total || items.length), s: 'Eagle 内的全部条目', go: null },
        { k: 'PDF 文档', v: fmtNo(pdfCount), s: '可被本插件阅读', go: null },
        { k: '已批注文档', v: fmtNo(docCount), s: '点开看全部卡片', go: 'all' },
        { k: '摘要', v: fmtNo(exCount), s: '点开只摘要', go: 'excerpt' },
        { k: '笔记', v: fmtNo(ntCount), s: '点开只笔记', go: 'note' }
      ];
      list.forEach((c) => {
        const card = el('div', 'wb-card' + (c.go ? ' clickable' : ''));
        card.appendChild(el('div', 'wb-card-k', c.k));
        card.appendChild(el('div', 'wb-card-v', c.v));
        card.appendChild(el('div', 'wb-card-s', c.s));
        if (c.go) card.addEventListener('click', () => KnowledgeBase.open(c.go));
        cards.appendChild(card);
      });
    }

    /* ---------- 最近阅读（点一下直接在插件内打开） ---------- */
    if (docsBox) {
      const hist = Store.getHistory();
      const seen = new Set();
      const rows = [];
      hist.forEach((h) => {
        if (!h.itemId || seen.has(h.itemId)) return;
        seen.add(h.itemId);
        rows.push({ itemId: h.itemId, name: h.name, page: h.page, at: h.at });
      });
      Object.keys(docs).forEach((k) => {
        if (seen.has(k)) return;
        const d = docs[k];
        if (!d || !d.updatedAt) return;
        rows.push({ itemId: k, name: d.name, page: null, at: d.updatedAt });
      });
      const top = rows.slice(0, 8);
      if (!top.length) {
        docsBox.innerHTML = '<div class="wb-empty">还没有阅读记录。在 Eagle 里选中 PDF 按空格打开即可。</div>';
      } else {
        docsBox.innerHTML = '';
        top.forEach((r) => {
          const row = el('div', 'wb-doc');
          row.appendChild(el('span', 'wb-doc-name', U.stripExt(r.name || '未命名')));
          row.appendChild(el('span', 'wb-doc-time', U.relTime(r.at)));
          if (r.page) row.appendChild(el('span', 'wb-doc-page', 'p.' + r.page));
          row.title = '在插件内打开';
          row.addEventListener('click', () => openDoc(r));
          docsBox.appendChild(row);
        });
      }
    }

    /* ---------- 类型分布 ---------- */
    if (types) {
      const map = new Map();
      items.forEach((it) => {
        const ext = (it.ext || 'other').toLowerCase();
        map.set(ext, (map.get(ext) || 0) + 1);
      });
      const arr = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const max = arr.length ? arr[0][1] : 1;
      if (!arr.length) {
        types.innerHTML = '<div class="wb-empty">' + (Bridge.hasEagle ? '资料库统计暂不可用' : '当前不在 Eagle 中运行') + '</div>';
      } else {
        types.innerHTML = '';
        arr.forEach(([ext, n]) => {
          const row = el('div', 'wb-type');
          row.appendChild(el('span', 'wb-type-name', ext.toUpperCase()));
          const bar = el('div', 'wb-type-bar');
          const fill = el('i');
          fill.style.width = Math.max(4, Math.round(n / max * 100)) + '%';
          bar.appendChild(fill);
          row.appendChild(bar);
          row.appendChild(el('span', 'wb-type-n', String(n)));
          types.appendChild(row);
        });
      }
    }

    /* ---------- 年度活动热力图（13.3：攒一年才有成就感） ----------
       v3.25：改成「一月一行」—— 以前是 7 行 × 53 列的全年长条，
       能看出哪天忙，但看不出哪个月忙（月份只能靠数格子）。
       分行之后横向是 1..31 日，纵向是 12 个月，月份之间的疏密一眼可读。 */
    if (heat) {
      const year = new Date().getFullYear();
      const yEl = document.getElementById('wbYear');
      if (yEl) yEl.textContent = String(year);
      const buckets = new Map();
      let total = 0;
      entries.forEach((e) => {
        if (!e.at) return;
        const d = new Date(e.at);
        if (d.getFullYear() !== year) return;
        const key = U.dateKey(d);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        total++;
      });
      let maxN = 1;
      buckets.forEach((v) => { if (v > maxN) maxN = v; });

      heat.innerHTML = '';
      for (let m = 0; m < 12; m++) {
        const row = document.createElement('div');
        row.className = 'wb-heat-row';

        const label = document.createElement('span');
        label.className = 'wb-heat-m';
        label.textContent = (m + 1) + '月';
        row.appendChild(label);

        const days = new Date(year, m + 1, 0).getDate();   // 这个月有几天
        for (let d = 1; d <= 31; d++) {
          const i = document.createElement('i');
          if (d > days) { i.className = 'pad'; row.appendChild(i); continue; }
          const key = U.dateKey(new Date(year, m, d));
          const n = buckets.get(key) || 0;
          const lv = n === 0 ? 0 : Math.min(4, Math.ceil(n / maxN * 4));
          i.className = 'l' + lv;
          i.title = key + ' · ' + n + ' 条';
          row.appendChild(i);
        }
        heat.appendChild(row);
      }
      const tot = document.getElementById('wbHeatTotal');
      if (tot) tot.textContent = year + ' 年共 ' + total + ' 条';
    }

    /* ---------- 最近条目 ---------- */
    if (recent) {
      const latest = entries.slice(0, 10);
      if (!latest.length) {
        recent.innerHTML = '<div class="wb-empty">还没有摘要或笔记，打开一篇 PDF 拖选文字试试</div>';
      } else {
        recent.innerHTML = '';
        latest.forEach((e) => {
          const row = el('div', 'wb-recent-row');
          const kindLabel = e.kind === 'note' ? '笔记' : (e.kind === 'daily' ? '每日' : '摘要');
          row.appendChild(el('span', 'wb-recent-kind ' + e.kind, kindLabel));
          row.appendChild(el('span', 'wb-recent-doc', e.docName || ''));
          row.appendChild(el('span', 'wb-recent-text', U.truncate(e.md || e.text || '', 70)));
          row.appendChild(el('span', 'wb-recent-time', U.relTime(e.at)));
          row.addEventListener('click', () => {
            if (e.kind === 'daily') { KnowledgeBase.open('daily'); return; }
            KnowledgeBase.open('all', e);
          });
          recent.appendChild(row);
        });
      }
    }

    if (pathEl) pathEl.textContent = Store.getDataDir() || '（尚未建立索引目录：需要在 Eagle 中运行）';

    /* Markdown 知识库：根目录 + 当前库子目录 + 开关状态。
       不可用时（纯浏览器调试）禁用掉，别给假开关。 */
    refreshPath();

    const v = document.getElementById('wbView');
    if (v) v.dataset.loaded = '1';
    if (sub) {
      sub.textContent = Bridge.hasEagle
        ? ('资料库：' + (Bridge.state.libraryName || '当前资料库'))
        : '当前不在 Eagle 中运行，仅显示本地索引数据';
    }
    loading = false;
    bindDaily();
    fillDaily();
  }

  /* 在插件内打开某个条目（溯源） */
  async function openDoc(r) {
    if (!r || !r.itemId) return;
    const nav = document.getElementById('wbView');
    if (nav) nav.hidden = true;
    stopClock();
    try {
      const it = await Bridge.getItemById(r.itemId);
      if (it && window.AppOpenItem) {
        const ok = await window.AppOpenItem(it);
        if (ok && r.page && window.AppViewer) {
          setTimeout(() => { try { window.AppViewer().goToPage(r.page); } catch (e) { /* ignore */ } }, 120);
        }
        if (ok) return;
      }
      U.toast('无法在插件内打开该文档', 'err');
      if (nav) nav.hidden = false;
      startClock();
    } catch (err) {
      U.toast('打开失败：' + (err.message || err), 'err');
      if (nav) nav.hidden = false;
      startClock();
    }
  }

  /* 立刻落盘：日常是 600ms 防抖自动保存，Ctrl+Enter 走这里跳过等待，
     写完就能关机/切库。返回当前字数，调用方拿去写提示。 */
  function flushDaily() {
    const box = document.getElementById('wbDaily');
    if (!box) return 0;
    const key = box.dataset.key || dailyKey();
    if (dailyTimer) { clearTimeout(dailyTimer); dailyTimer = null; }
    Store.saveDaily(key, box.value);
    Store.rebuildIndex();
    const n = box.value.trim().length;
    const stat = document.getElementById('wbDailyStat');
    if (stat) stat.textContent = n ? (n + ' 字 · 已保存') : '还没写，今天的第一条想法？';
    return n;
  }

  /* 数据目录那行：v4.3.0 起显示 Obsidian vault（.eaglenote 下随库走，v4.3.2 按库名命名） */
  function projText() {
    let dir = null;
    try { dir = (typeof Projection !== 'undefined') ? Projection.dirOf() : null; } catch (e) { dir = null; }
    if (!dir) return '—';
    return dir + '　（Obsidian vault · 随库走）';
  }

  let obsBound = false;
  function refreshPath() {
    const projEl = document.getElementById('wbProjPath');
    const ok = typeof Projection !== 'undefined' && Projection.available();
    if (projEl) projEl.textContent = ok ? projText() : '（不可用：需要在 Eagle 资料库中运行）';
    /* v4.3.0：Obsidian 双向同步开关。开启时立即 rebuildAll 把已有笔记铺进 vault。 */
    const chk = document.getElementById('chkObsSync');
    if (chk && !obsBound) {
      obsBound = true;
      chk.addEventListener('change', () => {
        try {
          if (typeof Projection === 'undefined' || !Projection.setEnabled) return;
          Projection.setEnabled(!!chk.checked);
          if (chk.checked && Projection.rebuildAll) {
            const r = Projection.rebuildAll(false);
            if (r && r.ok) U.toast('Obsidian 同步已开启，vault 已铺 ' + (r.written || 0) + ' 篇', '', 3200);
          } else if (!chk.checked) {
            U.toast('Obsidian 同步已关闭（vault 文件保留，可随时再开）', '', 3200);
          }
        } catch (e) { /* ignore */ }
      });
    }
    if (chk) {
      let on = false;
      try { on = (typeof Projection !== 'undefined' && Projection.isOn) ? Projection.isOn() : false; } catch (e) { on = false; }
      chk.checked = !!on;
    }
  }

  return { open, close, escBack, isOpen, render, openDoc, stopClock, flushDaily, refreshPath, projText, returnToLibrary, refreshCloseBtn };
})();

/* ==================== 知识库：便利贴卡片墙 ==================== */
const KnowledgeBase = (function () {
  let filter = 'all';
  let query = '';
  let focusEntry = null;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function open(f, entry) {
    const ov = document.getElementById('kbOverlay');
    if (!ov) return;
    if (f) {
      filter = f;
      document.querySelectorAll('#kbFilters .chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.kf === filter);
      });
    }
    focusEntry = entry || null;
    if (focusEntry && focusEntry.kind !== 'daily') {
      // 从工作台点某条进来：直接定位到那条所属的原文
      gotoEntry(focusEntry);
      focusEntry = null;
      return;
    }
    ov.hidden = false;
    if (typeof Esc !== 'undefined') Esc.push('kb', close);
    render();
    const s = document.getElementById('kbSearch');
    if (s) s.value = query;
  }

  function close() {
    const ov = document.getElementById('kbOverlay');
    if (ov) ov.hidden = true;
    if (typeof Esc !== 'undefined') Esc.remove('kb');
  }

  function isOpen() {
    const ov = document.getElementById('kbOverlay');
    return !!(ov && !ov.hidden);
  }

  function setFilter(f) {
    filter = f || 'all';
    document.querySelectorAll('#kbFilters .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.kf === filter);
    });
    render();
  }

  function allEntries() {
    let idx = null;
    try { idx = Store.getIndex(); } catch (e) { idx = null; }
    return (idx && idx.entries) || [];
  }

  /* 便利贴配色：按卡片序号轮转 */
  const TAPE = ['#f5c542', '#4cc38a', '#4a90e2', '#e26ba5', '#9b7bd4', '#f0913a'];

  function render() {
    const grid = document.getElementById('kbGrid');
    const status = document.getElementById('kbStatus');
    if (!grid) return;
    const s = document.getElementById('kbSearch');
    query = s ? s.value.trim() : query;

    const all = allEntries();
    let list = all;
    if (filter !== 'all') list = list.filter((e) => e.kind === filter);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((e) => (e.md || '').toLowerCase().indexOf(q) >= 0
        || (e.text || '').toLowerCase().indexOf(q) >= 0
        || (e.docName || '').toLowerCase().indexOf(q) >= 0);
    }

    if (status) status.textContent = list.length + ' 张卡片' + (query ? '（筛选自 ' + all.length + '）' : '');

    if (!list.length) {
      grid.innerHTML = '<div class="kb-empty">还没有内容。打开一篇 PDF，拖选文字或点选图片后点「摘录」或「摘录并笔记」。</div>';
      return;
    }

    grid.innerHTML = '';
    ensureKbMs();
    list.forEach((e, i) => {
      const card = el('article', 'kbn ' + e.kind);
      card.dataset.id = e.id;                 // 多选（Ctrl/Shift/Ctrl+A）靠它认卡片
      card.style.setProperty('--tape', TAPE[i % TAPE.length]);
      card.style.setProperty('--tilt', ((i % 5) - 2) * 0.35 + 'deg');

      const head = el('div', 'kbn-head');
      head.appendChild(el('span', 'kbn-kind', e.kind === 'note' ? '笔记' : (e.kind === 'daily' ? '每日' : '摘要')));
      head.appendChild(el('span', 'kbn-doc', U.stripExt(e.docName || '')));
      if (typeof e.t === 'number') {
        const label = VideoView && VideoView.fmt ? VideoView.fmt(e.t) + (typeof e.t1 === 'number' ? '–' + VideoView.fmt(e.t1) : '') : (e.t + 's');
        head.appendChild(el('span', 'kbn-page', '⏱ ' + label));
      } else if (e.page) {
        head.appendChild(el('span', 'kbn-page', 'p.' + e.page));
      }
      card.appendChild(head);

      if (e.image || e.imagePath) {
        const img = el('img', 'kbn-img');
        img.loading = 'lazy';
        img.draggable = false;               // v3.28：别让卡片里的图被拖出去
        card.appendChild(img);
        if (e.image) img.src = e.image;
        else if (typeof ImgCache !== 'undefined') {
          /* 新记录只存路径：按路径读图（缩略图缓存，见 js/imgcache.js） */
          ImgCache.url(e.imagePath, { trim: e.type !== 'highlight' }).then((u) => {
            if (u && img.parentNode) img.src = u;
            else if (img.parentNode) img.remove();
          });
        } else {
          img.remove();
        }
      }

      if (e.kind === 'note') {
        if (e.md) card.appendChild(el('div', 'kbn-body md-body', Markdown.render(e.md)));
        if (e.text) card.appendChild(el('div', 'kbn-quote', '「' + U.truncate(e.text, 160) + '」'));
      } else if (e.kind === 'daily') {
        card.appendChild(el('div', 'kbn-body md-body', Markdown.render(e.md || e.text || '')));
      } else {
        if (e.text) card.appendChild(el('div', 'kbn-text', e.text));
        if (e.md) card.appendChild(el('div', 'kbn-note md-body', Markdown.render(e.md)));
      }

      const foot = el('div', 'kbn-foot');
      foot.appendChild(el('span', 'kbn-time', U.relTime(e.at)));
      foot.appendChild(el('span', 'kbn-spacer'));
      if (e.kind !== 'daily' && e.docId && e.docId !== 'unknown') {
        const btnGoto = el('button', 'ec-btn', '溯源');
        btnGoto.title = '在插件内打开原文并定位';
        btnGoto.addEventListener('click', (ev) => { ev.stopPropagation(); gotoEntry(e); });
        foot.appendChild(btnGoto);
      }
      const btnDel = el('button', 'ec-btn', '删除');
      btnDel.addEventListener('click', (ev) => { ev.stopPropagation(); removeEntry(e); });
      foot.appendChild(btnDel);
      card.appendChild(foot);

      card.addEventListener('click', () => { if (e.kind !== 'daily') gotoEntry(e); else openDaily(e); });
      grid.appendChild(card);
    });
    if (kbMs) kbMs.sync();               // 重渲染后把还活着的选中态点亮
  }

  /* ---------- 知识库多选 + 批量操作（v3.15） ---------- */
  let kbMs = null;

  function ensureKbMs() {
    if (kbMs || typeof MultiSelect === 'undefined') return;
    const grid = document.getElementById('kbGrid');
    if (!grid) return;
    kbMs = MultiSelect.create({
      root: grid,
      bar: document.getElementById('kbBulk'),
      itemSel: '.kbn',
      keyOf: (n) => n.dataset.id,
      actions: [
        { label: '复制', title: '把选中的卡片合成一段 Markdown 复制走', run: (ids) => copyEntries(ids) },
        { label: '删除', danger: true, title: '把选中的卡片移入回收站（保留 30 天）', run: (ids) => removeEntries(ids) }
      ]
    });
  }

  function entriesByIds(ids) {
    const set = new Set(ids || []);
    return allEntries().filter((e) => set.has(e.id));
  }

  function copyEntries(ids) {
    const list = entriesByIds(ids);
    if (!list.length) return;
    const md = list.map((e) => {
      const head = '#### ' + (e.kind === 'note' ? '笔记' : (e.kind === 'daily' ? '每日' : '摘要'))
        + ' · ' + U.stripExt(e.docName || '');
      return head + '\n\n' + String(e.md || e.text || '').trim();
    }).filter(Boolean).join('\n\n---\n\n');
    U.copyText(md).then((ok) => {
      U.toast(ok ? ('已复制 ' + list.length + ' 张卡片') : '复制失败', ok ? 'ok' : 'err', 1800);
      if (kbMs) kbMs.clear();
    });
  }

  /* 批量删除：先都改完数据，最后重建一次索引、刷一次界面 ——
     逐条调 removeEntry 的话，删 20 张卡就重建 20 次索引。 */
  async function removeEntries(ids) {
    const list = entriesByIds(ids);
    if (!list.length) return;
    const ask = (typeof window !== 'undefined' && window.AppConfirm) ? window.AppConfirm : null;
    if (!ask) return;
    const r = await ask('删除 ' + list.length + ' 张卡片',
      '它们会进回收站，30 天内可以还原。', [
        { label: '取消', value: 'cancel' },
        { label: '删除', value: 'ok', danger: true }
      ]);
    if (r !== 'ok') return;
    list.forEach((e) => {
      if (e.kind === 'daily') { Store.saveDaily(e.dayKey || '', ''); return; }
      const data = Store.readDocByKey(e.docKey) || { annotations: [], notes: [] };
      let rec = null;
      if (e.kind === 'note') {
        const n = (data.notes || []).find((x) => x.id === e.noteId);
        if (n) {
          rec = { kind: 'note', docId: e.docId, docKey: e.docKey, docName: e.docName, payload: n };
          data.notes = data.notes.filter((x) => x.id !== e.noteId);
        }
      } else if (e.annId) {
        const a = (data.annotations || []).find((x) => x.id === e.annId);
        if (a) {
          rec = { kind: 'excerpt', docId: e.docId, docKey: e.docKey, docName: e.docName, payload: a };
          data.annotations = data.annotations.filter((x) => x.id !== e.annId);
        }
      }
      if (rec) Store.pushTrash(Object.assign({ id: U.uid('tr') }, rec));
      Store.writeDocByKey(e.docKey, data);
    });
    Store.rebuildIndex();
    if (window.AppRefreshAfterKb) window.AppRefreshAfterKb();
    if (kbMs) kbMs.clear();
    render();
    U.toast('已删除 ' + list.length + ' 张（可在回收站还原）', 'ok', 2400);
  }

  async function openDaily(e) {
    close();
    Workbench.open(true);
    const box = document.getElementById('wbDaily');
    if (box) { box.value = e.md || e.text || ''; box.focus(); }
  }

  /* 溯源：在插件内打开这篇 PDF 并跳到对应页 */
  async function gotoEntry(e) {
    if (!e || !e.docId) return;
    close();
    try {
      const it = await Bridge.getItemById(e.docId);
      if (it && window.AppOpenItem) {
        const ok = await window.AppOpenItem(it);
        if (!ok) { U.toast('无法打开原文（条目可能已被删除）', 'err', 3000); return; }
        const v = window.AppViewer && window.AppViewer();
        if (v && e.page) v.goToPage(e.page);
        if (v && e.annId && window.AppFocusAnn) {
          setTimeout(() => { try { window.AppFocusAnn(e.annId); } catch (err) { /* ignore */ } }, 220);
        }
        return;
      }
      U.toast('无法打开原文（条目可能已被删除）', 'err', 3000);
    } catch (err) {
      U.toast('打开失败：' + (err.message || err), 'err');
    }
  }

  async function removeEntry(e) {
    if (!e) return;
    if (e.kind === 'daily') {
      Store.saveDaily(e.dayKey || '', '');
      Store.rebuildIndex();
      U.toast('已删除这条每日笔记', 'ok', 1400);
      render();
      return;
    }
    const data = Store.readDocByKey(e.docKey) || { annotations: [], notes: [] };
    let rec = null;
    if (e.kind === 'note') {
      const n = (data.notes || []).find((x) => x.id === e.noteId);
      if (n) {
        rec = { kind: 'note', docId: e.docId, docKey: e.docKey, docName: e.docName, payload: n };
        data.notes = data.notes.filter((x) => x.id !== e.noteId);
      }
    } else if (e.annId) {
      const a = (data.annotations || []).find((x) => x.id === e.annId);
      if (a) {
        rec = { kind: 'excerpt', docId: e.docId, docKey: e.docKey, docName: e.docName, payload: a };
        data.annotations = data.annotations.filter((x) => x.id !== e.annId);
      }
    }
    if (rec) Store.pushTrash(Object.assign({ id: U.uid('tr') }, rec));
    Store.writeDocByKey(e.docKey, data);
    Store.rebuildIndex();
    if (window.AppRefreshAfterKb) window.AppRefreshAfterKb();
    U.toast('已移入回收站（保留 30 天）', 'ok', 1800);
    render();
  }

  return { open, close, isOpen, render, setFilter, gotoEntry, removeEntry };
})();

/* ==================== 回收站 ==================== */
const Trash = (function () {
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function open() {
    const ov = document.getElementById('trashOverlay');
    if (!ov) return;
    ov.hidden = false;
    if (typeof Esc !== 'undefined') Esc.push('trash', close);
    render();
  }

  function close() {
    const ov = document.getElementById('trashOverlay');
    if (ov) ov.hidden = true;
    if (typeof Esc !== 'undefined') Esc.remove('trash');
  }

  function isOpen() {
    const ov = document.getElementById('trashOverlay');
    return !!(ov && !ov.hidden);
  }

  function daysLeft(it) {
    const used = (Date.now() - (it.deletedAt || 0)) / 86400000;
    return Math.max(0, Math.ceil(Store.TRASH_DAYS - used));
  }

  function render() {
    const list = document.getElementById('trashList');
    const status = document.getElementById('trashStatus');
    if (!list) return;
    const items = Store.purgeTrash();
    if (status) status.textContent = items.length ? (items.length + ' 项 · 到期自动清除') : '回收站是空的';
    if (!items.length) {
      list.innerHTML = '<div class="kb-empty">回收站是空的。<br>删除的摘录与笔记会在这里保留 30 天。</div>';
      return;
    }
    list.innerHTML = '';
    ensureTrashMs();
    items.forEach((it) => {
      const row = el('div', 'trash-row');
      row.dataset.id = it.id;               // 多选（Ctrl/Shift/Ctrl+A）靠它认行
      const payload = it.payload || {};
      row.appendChild(el('span', 'trash-kind ' + it.kind, it.kind === 'note' ? '笔记' : '摘要'));
      const main = el('div', 'trash-main');
      main.appendChild(el('div', 'trash-text', U.truncate(payload.note || payload.md || payload.text || (payload.image ? '［图片］' : '（空）'), 90)));
      main.appendChild(el('div', 'trash-sub', (it.docName || '未知文档') + ' · 删除于 ' + U.fmtTime(it.deletedAt) + ' · 剩余 ' + daysLeft(it) + ' 天'));
      row.appendChild(main);
      const btnBack = el('button', 'ec-btn', '还原');
      btnBack.addEventListener('click', () => restore(it));
      row.appendChild(btnBack);
      const btnDel = el('button', 'ec-btn', '彻底删除');
      btnDel.addEventListener('click', () => {
        Store.dropTrash(it.id);
        render();
        U.toast('已彻底删除', 'ok', 1200);
      });
      row.appendChild(btnDel);
      list.appendChild(row);
    });
    if (trMs) trMs.sync();               // 重渲染后把还活着的选中态点亮
  }

  /* ---------- 回收站多选 + 批量操作（v3.15） ---------- */
  let trMs = null;

  function ensureTrashMs() {
    if (trMs || typeof MultiSelect === 'undefined') return;
    const list = document.getElementById('trashList');
    if (!list) return;
    trMs = MultiSelect.create({
      root: list,
      bar: document.getElementById('trashBulk'),
      itemSel: '.trash-row',
      keyOf: (n) => n.dataset.id,
      actions: [
        { label: '还原', title: '把选中的条目放回原处', run: (ids) => restoreItems(ids) },
        { label: '彻底删除', danger: true, title: '立即清除，无法恢复', run: (ids) => dropItems(ids) }
      ]
    });
  }

  function itemsByIds(ids) {
    const set = new Set(ids || []);
    return Store.purgeTrash().filter((it) => set.has(it.id));
  }

  function restoreItems(ids) {
    const list = itemsByIds(ids);
    if (!list.length) return;
    list.forEach((it) => {
      const data = Store.readDocByKey(it.docKey) || { itemId: it.docId, annotations: [], notes: [] };
      if (!Array.isArray(data.annotations)) data.annotations = [];
      if (!Array.isArray(data.notes)) data.notes = [];
      if (it.kind === 'note') data.notes.unshift(it.payload);
      else data.annotations.unshift(it.payload);
      data.fileName = data.fileName || it.docName || '';
      data.itemId = data.itemId || it.docId || null;
      Store.writeDocByKey(it.docKey, data);
      Store.dropTrash(it.id);
    });
    Store.rebuildIndex();
    if (window.AppRefreshAfterKb) window.AppRefreshAfterKb();
    if (trMs) trMs.clear();
    render();
    U.toast('已还原 ' + list.length + ' 项', 'ok', 1600);
  }

  function dropItems(ids) {
    const list = itemsByIds(ids);
    if (!list.length) return;
    const ask = (typeof window !== 'undefined' && window.AppConfirm) ? window.AppConfirm : null;
    if (!ask) return;
    ask('彻底删除 ' + list.length + ' 项', '将立即清除，无法恢复。', [
      { label: '取消', value: 'cancel' },
      { label: '彻底删除', value: 'ok', danger: true }
    ]).then((r) => {
      if (r !== 'ok') return;
      list.forEach((it) => Store.dropTrash(it.id));
      if (trMs) trMs.clear();
      render();
      U.toast('已彻底删除 ' + list.length + ' 项', 'ok', 1600);
    });
  }

  function restore(it) {
    const data = Store.readDocByKey(it.docKey) || { itemId: it.docId, annotations: [], notes: [] };
    if (!Array.isArray(data.annotations)) data.annotations = [];
    if (!Array.isArray(data.notes)) data.notes = [];
    if (it.kind === 'note') data.notes.unshift(it.payload);
    else data.annotations.unshift(it.payload);
    data.fileName = data.fileName || it.docName || '';
    data.itemId = data.itemId || it.docId || null;
    Store.writeDocByKey(it.docKey, data);
    Store.dropTrash(it.id);
    Store.rebuildIndex();
    if (window.AppRefreshAfterKb) window.AppRefreshAfterKb();
    U.toast('已还原', 'ok', 1400);
    render();
  }

  function emptyAll() {
    Store.emptyTrash();
    render();
    U.toast('回收站已清空', 'ok', 1400);
  }

  return { open, close, isOpen, render, restore, emptyAll };
})();

/* 挂到 window 便于调试与自动化验收（classic script 的 const 不会自动上 window） */
try {
  window.Workbench = Workbench;
  window.KnowledgeBase = KnowledgeBase;
  window.Trash = Trash;
} catch (e) { /* ignore */ }
