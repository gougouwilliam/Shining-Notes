/* 应用主控：状态编排、界面事件、Eagle 读写 */
(function () {
  'use strict';

  const $ = U.$;
  const $$ = U.$$;

  /* v4.4.4：退出流程的两个模块级句柄。
     ① detachUnloadPersist —— beforeunload 监听器的摘钩函数。页面只要还挂着
        beforeunload，用户点过一下（sticky activation）之后 Chromium 就会
        拦下脚本发起的 window.close()；退出前必须先摘掉它。
     ② exitSentAt —— 连按 ESC 的防抖时间戳，避免对主进程重复发 close/destroy
        （现场 debug.log 里一秒能按出五六下）。 */
  let detachUnloadPersist = null;
  let exitSentAt = 0;

  const state = {
    item: null,
    doc: null,
    data: null,
    filter: 'all',
    tab: 'excerpts',
    leftTab: 'outline',
    pendingSelection: null,     // 文字选区 { groups, text }
    pendingImage: null,         // 图片选区 { page, rect }
    saving: new Set(),
    textIndex: null,
    searchHits: [],
    loadToken: 0,
    currentColor: 'yellow',
    editing: { kind: null, id: null },
    noteQuote: '',
    notePage: null,
    lastExcerptId: null,
    activeNoteKey: null,        // 右栏笔记栏里选中的那条（Delete 用）
    thumbObserver: null,
    thumbsBuilt: false,
    lastError: null,
    tr: null,                   // 翻译上下文
    linkTarget: null,
    escHint: 0,
    isVideo: false,             // 当前文档是视频
    video: null,                // 视频条目的备用信息
    vsClip: null,               // 片段选择中：{t0, withNote}
    vsZoom: 1,                  // 视频显示倍率
    openedAt: 0,                // 刚打开的时间戳（吞掉打开那一下的空格）
    rtTimer: null,              // 显存状态定时刷新
    pdfSync: { sig: null, ok: null, count: 0, reason: null, key: null }
  };

  /* 全文搜索的运行时状态（页面元素常驻，这里只管数据） */
  const searchState = { q: '', hits: [], idx: -1, docToken: null, rows: [] };

  let viewer = null;
  let annMgr = null;
  let popoverAnn = null;
  let dropBound = false;

  /* ==================== 启动 ==================== */
  const bootErrors = [];

  async function step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      console.error('[boot:' + name + ']', err);
      bootErrors.push(name + '：' + ((err && err.message) || err));
      return undefined;
    }
  }

  function on(sel, evt, fn, opts) {
    const node = $(sel);
    if (!node) {
      console.warn('[bind] 找不到节点', sel);
      return null;
    }
    node.addEventListener(evt, fn, opts);
    return node;
  }

  function onAll(sel, evt, fn, opts) {
    const nodes = $$(sel);
    if (!nodes || !nodes.length) {
      console.warn('[bind] 找不到节点', sel);
      return;
    }
    nodes.forEach((n) => n.addEventListener(evt, fn, opts));
  }

  function showFatal(msg) {
    try {
      const bar = $('#fatalBar');
      if (!bar) return;
      const t = bar.querySelector('.fb-text');
      if (t) t.textContent = msg;
      bar.hidden = false;
    } catch (e) { /* ignore */ }
  }

  function hideFatal() {
    try { if ($('#fatalBar')) $('#fatalBar').hidden = true; } catch (e) { /* ignore */ }
  }

  function sync(name, fn) {
    try {
      return fn();
    } catch (err) {
      console.error('[boot:' + name + ']', err);
      try { if (typeof Dbg !== 'undefined') Dbg.log('boot.' + name, err); } catch (e) { /* ignore */ }
      bootErrors.push(name + '：' + ((err && err.message) || err));
      return undefined;
    }
  }

  function boot() {
    window.__PDFWORK_BOOTED = true;

    try { if (typeof Dbg !== 'undefined') Dbg.hook(); } catch (e) { /* ignore */ }

    window.addEventListener('error', (e) => {
      console.error('[window.error]', e.error || e.message);
      showFatal('运行时错误：' + ((e.error && e.error.message) || e.message));
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      console.error('[unhandledrejection]', r);
      showFatal('异步异常：' + ((r && r.message) || r));
    });

    /* ---------- 第一段：同步，不碰 Eagle API ---------- */
    sync('应用主题', () => applyTheme(Store.getTheme() || 'dark'));
    sync('初始化阅读器', () => initViewer());
    sync('初始化视频区', () => VideoView.init({
      onMark: videoMark,
      onClipStart: (t) => U.toast('片段起点 A = ' + VideoView.fmt(t), '', 1600),
      onClip: videoClip,
      onFrame: (t) => videoFrameExcerpt(t, false),
      onMarkPick: pickVideoMark
    }));
    sync('工具键文案', () => updateVideoToolLabels());
    sync('初始化编辑器', () => initEditors());
    sync('绑定拖拽', () => bindDropZone());
    sync('绑定界面', () => bindUI());
    sync('列表多选', () => initMultiSelect());
    sync('字幕存笔记', () => { try { Subtitle.onSaveSelection(saveSubtitleGroups); } catch (e) { /* ignore */ } });
    /* v3.30：笔记的语音输入下线（initVoiceInputs 已删） */
    sync('自绘窗口条', () => { try { FrameWin.init(); } catch (e) { /* ignore */ } });
    sync('交互标记', () => markUserTouch());
    sync('环境检查绑定', () => bindOnboard());
    sync('色板', () => renderSwatches());
    sync('空态占位', () => { renderOutline(null); renderThumbs(); });

    /* ---------- 第二段：异步，连接 Eagle ---------- */
    (async () => {
      await step('初始化桥接', () => Bridge.initHooks());
      await step('连接 Eagle', () => Bridge.ready());
      await step('同步窗口底色', () => Bridge.syncWindowBg(document.documentElement.dataset.theme));

      /* v4.3.0：Obsidian 同步复活 —— 原「知识库同步钩子」步骤以双向形态回归。
         writeNow 写前自动「先吸外部手改再写」，这里只负责两件事：
         ① onExternal：把 md 手改写回权威 JSON 并刷新列表；
         ② 空闲期轮询 externallyChanged（Obsidian 的改动收不到事件，靠扫描发现）。 */
      await step('Obsidian 同步钩子', () => { try { startProjSync(); } catch (e) { console.warn('[ProjSync] 启动失败', e); } });

      /* v3.34：自绘标题栏要**等 Eagle 连上之后再对一次**。
         同步段那次 init() 已经能绑上按钮（判据改成读 location.search），
         但那时 eagle.window 可能还没注入、Bridge.query 也还是空的 ——
         这里补一次：幂等、只刷新按钮状态，不会重复绑定。
         用户报「✕ / 最小化 / 最大化 全点不动」，根因就是以前这个顺序问题。 */
      await step('自绘窗口条（补）', () => { try { FrameWin.init(); } catch (e) { /* ignore */ } });

      /* v3.28.3：把「这台机器上对话框/截屏通道到底通不通」记一笔。
         以后再有「截图存不下来」的反馈，先看这一行就够判断了。 */
      try {
        if (typeof Dbg !== 'undefined') {
          const env = await Bridge.windowProbe();
          Dbg.log('env', env);
        }
      } catch (e) { /* ignore */ }

      if (Bridge.state.mode === 'preview') await step('预览布局', () => applyPreviewLayout());

      /* v3.3：升版会清空上一版数据（用户要求），这里明确告诉用户一声 */
      const mg = Bridge.state.epochWiped;
      if (mg && mg.wiped) {
        setTimeout(() => {
          U.toast('v3.3 已清空旧版数据（笔记 / 摘录 / 历史 / 回收站）'
            + (mg.archived ? '，旧文件归档在 ' + mg.archived : ''), '', 6500);
        }, 900);
      }

      await step('载入初始文档', () => openInitial());

      /* v3.18：合并为单插件后，顶栏图标（window 模式）点开 = 直接进工作台。
         openInitial 已保证 window 模式不会去读选中项，这里显式开门面，
         不再依赖「碰巧没载入文档」这个间接条件。
         兼容保留 #workbench hash（v3.17 旧启动器的深链，若有人还留着也能用）。 */
      if (Bridge.state.mode === 'window' || location.hash === '#workbench') {
        try { Workbench.open(true); } catch (e) { /* ignore */ }
      }

      /* 本地模型：不管有没有打开文档，插件一起来就试着把它拉起。
         停在工作台里也该是「随时能用」的状态，而不是等用户点到 OCR 才发现没起。
         bootLocalAi 内部有并发锁与 30 秒失败冷却，和 openItem 里的那次调用不会打架。 */
      setTimeout(function () { try { bootLocalAi(); } catch (e) { /* ignore */ } }, 1500);

      /* 首次启动环境检查（v3.16）：等本地模型探测跑完（它要扫盘 / 连 11434），
         再判断缺什么、要不要弹 —— 所以排在 bootLocalAi 后面 3.5 秒。 */
      setTimeout(function () { try { maybeOnboard(); } catch (e) { /* ignore */ } }, 3500);

      /* v4.2.12：md 投影下线 —— 历史补齐与 45 秒磁盘轮询都随功能删除。
         权威数据一直在 .eaglenote\docs\*.json，md 需要时可显式重建。 */

      /* 见 js/rungate.js：Eagle 每次建窗会连发两次 plugin-run（100ms 时一次、show 之后再一次），
         那不是「用户又点了插件」。放在这里拦一下，否则刚落地的工作台会被选中项顶掉。 */
      Bridge.onRun(async () => {
        try {
          const q = Bridge.state.query || {};
          const v = (window.RunGate && RunGate.verdict)
            ? RunGate.verdict({ launcher: !!q.launcher, hasDoc: loaded(), touched: userTouched })
            : 'open-selected';
          if (v === 'ignore') return;
          if (v === 'workbench') { try { Workbench.open(true); } catch (e) { /* ignore */ } return; }
          const sel = await Bridge.getSelectedDocs();
          if (sel.length && (!state.item || sel[0].id !== state.item.id)) openItem(sel[0]);
        } catch (e) { /* ignore */ }
      });

      if (bootErrors.length) showFatal('部分功能初始化失败：' + bootErrors.join('；'));
    })();
  }

  /* 预览模式（Eagle 空格打开）：左右栏都固定显示，不再提供收起 */
  function applyPreviewLayout() {
    requestAnimationFrame(() => { try { viewer.handleResize(); } catch (e) { /* ignore */ } });
  }

  /* 「打开了没有」不能只看 state.doc —— 视频没有 doc，只有 isVideo。
     3.3.2 就是因为只判 state.doc，视频明明已经打开，却被判成失败，
     于是又盖上一层「未能载入：Eagle 条目 … 模式 preview」的报错。 */
  function loaded() { return !!(state.doc || state.isVideo); }

  /* 用户是否在我们这个窗口里操作过。
     用来区分「Eagle 建窗时连发的伪 plugin-run」和「用户真的又点了这个插件」（见 js/rungate.js）。 */
  let userTouched = false;
  function markUserTouch() {
    if (userTouched) return;
    const mark = () => { userTouched = true; };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
      try { window.addEventListener(ev, mark, { once: true, capture: true }); } catch (e) { /* ignore */ }
    });
  }

  async function openInitial() {
    const q = Bridge.state.query || {};
    const tried = [];
    const attempts = [];

    /* v3.18：合并为单插件 —— 顶栏图标（window 模式、未带 id/path）点开时直接落在工作台。
       旧逻辑会尝试打开「Eagle 当前选中项」，于是点顶栏图标时若库里恰好选中了某篇 PDF，
       就被带去读那篇文档、看不到工作台。合并后语义明确：
         · window 模式（顶栏/插件面板点开，无 id/path）→ 工作台门面，不读选中项
         · preview 模式（空格/双击带 id/path）→ 照常读文档
         · 插件已运行时在 Eagle 中再次触发 → 由 Bridge.onRun 读选中项（见下方 onRun）
       这样置顶这一个插件，点开就是工作台，彻底不需要第二个启动器插件。 */
    /* 启动器窗口（?launcher=1）的语义就是「工作台入口」：这个窗口绝不读 Eagle 选中项。 */
    if (q.launcher) return;
    if (Bridge.state.mode === 'window' && !q.id && !q.path) return;

    if (q.id) {
      attempts.push({
        label: 'Eagle 条目 ' + q.id,
        run: async () => {
          const it = await Bridge.getItemById(q.id);
          if (!it) return false;
          if (!it.filePath && q.path) it.filePath = q.path;
          if (await openItem(it)) return true;
          throw new Error('读取失败：' + (it.filePath || '无路径'));
        }
      });
    }

    if (q.path) {
      attempts.push({
        label: '路径 ' + q.path,
        run: async () => {
          if (!(await openItem(Bridge.localItem(q.path)))) throw new Error('无法读取该路径');
        }
      });
    }

    if (Bridge.hasEagle && Bridge.state.mode !== 'preview') {
      attempts.push({
        label: '资源库当前选中项',
        run: async () => {
          const sel = await Bridge.getSelectedDocs();
          if (!sel.length) return false;
          if (await openItem(sel[0])) return true;
          throw new Error('读取失败');
        }
      });
    }

    for (const a of attempts) {
      if (loaded()) return;
      const done = await step('打开 ' + a.label, a.run);
      if (loaded()) return;
      if (done === false) continue;
      tried.push(a.label);
    }

    if (loaded()) return;
    const expected = !!(q.id || q.path);
    showEmpty(expected
      ? ('未能载入：' + (state.lastError || tried.join(' / ') || '未知原因') + '　—　' + diagText())
      : '');
  }

  function diagText() {
    const b = Bridge.state || {};
    const q = b.query || {};
    const flag = (v) => (v ? 'ok' : '无');
    return [
      '模式 ' + (b.mode || '?'),
      'Eagle ' + (Bridge.hasEagle ? '有' : '无'),
      'create ' + (Bridge.isCreated && Bridge.isCreated() ? '已到' : '未到'),
      'id ' + (q.id || '无'),
      'path ' + (q.path ? (String(q.path).length > 42 ? '…' + String(q.path).slice(-42) : q.path) : '无'),
      '插件目录 ' + flag(b.pluginPath),
      '资源库 ' + flag(b.libraryPath)
    ].join(' · ');
  }

  /* ==================== 视图初始化 ==================== */
  function initViewer() {
    viewer = new PdfViewer({
      viewport: $('#viewport'),
      pages: $('#pages'),
      getAnnotations: () => (state.data ? state.data.annotations : []),
      onPageChange: (n, total) => onPageChanged(n, total),
      onPageRendered: (n) => { if (annMgr) annMgr.renderPage(n); },
      onAreaRect: handleAreaRect,
      onNotePoint: handleNotePoint,
      onPageClick: (ann) => selectAnnotation(ann),
      onImagePick: (payload, pageEl) => pickImage(payload, pageEl),
      onLinkPick: (link) => pickLink(link)
    });

    annMgr = new AnnotationManager({
      viewer,
      getAnnotations: () => (state.data ? state.data.annotations : []),
      onSelect: (ann) => { if (ann) { state.activeAnnId = ann.id; highlightCard(ann.id); } },
      onEdit: (ann, anchor) => openPopover(ann, anchor)
    });
  }

  /* ==================== 主题 ==================== */
  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    const bg = t === 'light' ? '#f3f4f6' : '#18191c';
    document.documentElement.style.setProperty('--eagle-bg', bg);
    try { Bridge.syncWindowBg(t); } catch (e) { /* ignore */ }
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(cur);
    Store.setTheme(cur);
    if (annMgr) annMgr.renderVisible();
  }

  /* ==================== 事件绑定 ==================== */
  const bindUI = () => {
    on('#btnFatalClose', 'click', hideFatal);
    on('#btnTheme', 'click', toggleTheme);

    /* v4.1：左栏移除，目录 / 缩略图 / 字幕改为顶栏弹出面板 */
    on('#btnPopOutline', 'click', () => toggleSidePop('outline'));
    on('#btnPopThumbs', 'click', () => toggleSidePop('thumbs'));
    on('#btnPopSubs', 'click', () => toggleSidePop('subs'));
    onAll('.side-pop [data-spclose]', 'click', (e) => toggleSidePop(e.currentTarget.dataset.spclose, false));
    /* 点面板外面就收起（入口键自己管开合，不算「外面」） */
    document.addEventListener('mousedown', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      Object.keys(SIDE_POPS).forEach((k) => {
        const el = $('#' + SIDE_POPS[k]);
        if (!el || el.hidden || el.contains(t)) return;
        const btn = sidePopBtn(k);
        if (btn && btn.contains(t)) return;
        toggleSidePop(k, false);
      });
    });

    // 分页 / 缩放
    on('#btnPrev', 'click', () => viewer.goToPage(viewer.current - 1));
    on('#btnNext', 'click', () => viewer.goToPage(viewer.current + 1));
    on('#pageInput', 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n)) viewer.goToPage(n);
      e.target.blur();
    });
    on('#pageInput', 'focus', (e) => e.target.select());

    on('#btnZoomIn', 'click', () => { if (state.isVideo) { vsZoomBy(0.1); return; } viewer.zoomIn(); updateZoomUI(); });
    on('#btnZoomOut', 'click', () => { if (state.isVideo) { vsZoomBy(-0.1); return; } viewer.zoomOut(); updateZoomUI(); });
    on('#btnFit', 'click', () => {
      if (state.isVideo) { vsZoomTo(1); return; }
      if (viewer.zoomMode === 'fit-width') viewer.fitPage(); else viewer.fitWidth();
      updateZoomUI();
    });
    on('#zoomLabel', 'click', () => {
      if (state.isVideo) { vsZoomTo(1); return; }
      viewer.setZoom(1, 'custom'); updateZoomUI();
    });

    /* 视频底部工具栏（v3.4）：截图 / 框选 / 片段，各带「并笔记」版本 */
    on('#btnVsShot', 'click', () => vsShot(false));
    on('#btnVsShotNote', 'click', () => vsShot(true));
    on('#btnVsArea', 'click', () => vsArea(false));
    on('#btnVsAreaNote', 'click', () => vsArea(true));
    on('#btnVsClip', 'click', () => vsClip(false));
    on('#btnVsClipNote', 'click', () => vsClip(true));
    /* v3.27：片段导出的取消（导出是实时录制的，必须随时能停） */
    on('#btnVsExpCancel', 'click', () => {
      if (typeof ClipExport !== 'undefined' && ClipExport.cancel()) U.toast('正在收尾…', '', 1200);
    });
    /* v3.30：顶栏那个 ✕ 删掉了 —— 它只会调 exitPlugin()，
       ESC 关不掉的时候它同样关不掉，留着反而是个「按了没反应」的假出口。 */
    onAll('#toolGroup .tool-btn', 'click', (e) => setTool(e.currentTarget.dataset.tool));

    // 右侧页签 / 筛选
    onAll('#panelTabs .panel-tab', 'click', (e) => {
      switchTab(e.currentTarget.dataset.tab);
      /* v4.2.14：点完页签把焦点交还 —— 页签按钮留着焦点时按 Esc，
         Chromium 会把「最后输入方式」翻转成键盘，:focus-visible 的蓝圈
         当场画在页签上（用户实锤）。鼠标点击不需要留焦点，键盘 Tab 照常。 */
      try { e.currentTarget.blur(); } catch (err) { /* ignore */ }
    });
    onAll('#excerptFilters .chip', 'click', (e) => {
      const chip = e.currentTarget;
      state.filter = chip.dataset.filter;
      $$('#excerptFilters .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderExcerpts();
    });

    on('#excerptList', 'click', onExcerptListClick);
    on('#notesList', 'click', onNoteListClick);
    on('#btnNotesExport', 'click', exportMarkdown);
    on('#btnNotesCopy', 'click', copyAllNotes);
    /* v4.2.5：笔记栏顶部搜索框 —— 本文献 → 全局笔记 → Eagle 库，Esc 逐层退 */
    on('#noteSearch', 'input', onNoteSearchInput);
    on('#noteSearch', 'keydown', noteSearchSwallowEnter);
    /* v4.2.6：空查询点搜索框 = 秀最近笔记；失焦没输东西就恢复列表 */
    on('#noteSearch', 'focus', () => {
      const input = $('#noteSearch');
      if (input && !input.value.trim()) renderRecentNotes();
      else if (input) input.select();
    });
    on('#noteSearch', 'blur', () => {
      setTimeout(() => {
        const input = $('#noteSearch');
        if (input && !input.value.trim() && !noteSearch.q.trim()) renderNotes();
      }, 160);   // 给「点最近笔记卡片」留一拍
    });
    on('#btnNoteSearchClear', 'click', () => { noteSearchClear(); renderNotes(); });
    /* v4.2.6：双击卡片 = 打开笔记阅读页（单击仍是定位原文，延时 260ms 区分） */
    on('#notesList', 'dblclick', (e) => {
      const card = e.target.closest && e.target.closest('.note-card');
      if (!card) return;
      const n = collectNotes().find((x) => x.key === card.dataset.key);
      if (!n) return;
      if (card._clickT) { clearTimeout(card._clickT); card._clickT = 0; }
      selectNoteCard(card.dataset.key);
      openNoteReader(n);
    });
    on('#excerptList', 'dblclick', (e) => {
      const card = e.target.closest && e.target.closest('.excerpt-card');
      if (!card || !state.data) return;
      const ann = state.data.annotations.find((a) => a.id === card.dataset.id);
      if (!ann) return;
      if (card._clickT) { clearTimeout(card._clickT); card._clickT = 0; }
      openAnnReader(ann);
    });

    on('#btnTopExcerpt', 'click', () => runCurrentExcerpt(false));
    on('#btnTopExcerptNote', 'click', () => runCurrentExcerpt(true));

    // 知识库 / 工作台 / 回收站
    on('#btnOpenKb', 'click', () => KnowledgeBase.open());
    on('#btnKbClose', 'click', () => KnowledgeBase.close());
    on('#kbSearch', 'input', U.debounce(() => KnowledgeBase.render(), 160));
    onAll('#kbFilters .chip', 'click', (e) => KnowledgeBase.setFilter(e.currentTarget.dataset.kf));

    on('#btnWorkbench', 'click', () => Workbench.open(true));
    on('#btnAiSummary', 'click', () => openAiSummary());
    on('#btnWbClose', 'click', () => Workbench.returnToLibrary());
    on('#btnWbRefresh', 'click', () => Workbench.open(true));
    on('#btnWbOpenDir', 'click', openDataDir);
    on('#btnWbOpenProj', 'click', openProjDir);
    on('#btnWbClear', 'click', () => clearAllData());
    on('#btnWbWipe', 'click', () => clearAllData({ wipe: true }));
    on('#btnWbAnnScan', 'click', annInspectAll);
    on('#btnWbPruneOrphans', 'click', () => reconcileDeleted({ silent: false }));
    on('#btnWbClearHistory', 'click', clearHistoryOnly);
    on('#btnDailyKb', 'click', () => KnowledgeBase.open('daily'));

    on('#btnTrash', 'click', () => Trash.open());
    on('#btnTrashClose', 'click', () => Trash.close());
    on('#btnTrashEmpty', 'click', async () => {
      if (!Store.getTrash().length) { U.toast('回收站已经是空的'); return; }
      const r = await confirmDialog('清空回收站', '里面的内容将被彻底删除，无法恢复。', [
        { label: '取消', value: 'cancel' },
        { label: '彻底删除', value: 'ok', danger: true }
      ]);
      if (r === 'ok') Trash.emptyAll();
    });

    // 大笔记框 / 附件选择器
    on('#btnNmClose', 'click', () => tryCloseNoteModal());
    /* v4.2.6：阅读页里的「✎ 编辑」→ 关阅读页、进编辑器 */
    on('#btnNmEdit', 'click', () => {
      const t = readerTarget;
      closeReader();
      if (t && t.kind) openComposer(t.kind, t.id, 'modal');
    });
    on('#btnPickClose', 'click', () => closePicker());
    on('#btnPickCancel', 'click', () => closePicker());
    on('#pickSearch', 'keydown', (e) => { if (e.key === 'Enter') runPickSearch(e.target.value); });
    on('#btnPickAdd', 'click', confirmPick);

    // 选区 → 浮动工具条
    document.addEventListener('mouseup', onDocumentMouseUp);
    document.addEventListener('selectionchange', U.debounce(onSelectionChange, 140));
    on('#selToolbar', 'mousedown', (e) => e.preventDefault());
    onAll('#selToolbar .sel-btn', 'click', (e) => onToolbarAction(e.currentTarget.dataset.act));

    // 翻译面板
    on('#btnTrClose', 'click', hideTr);
    on('#btnTrCopy', 'click', copyTranslation);
    on('#btnTrSave', 'click', saveTranslation);
    on('#btnTrLang', 'click', switchTrLang);
    on('#btnSubExport', 'click', exportSubs);
    on('#btnTrCfg', 'click', toggleTrCfg);
    on('#btnTrCfgSave', 'click', saveTrCfg);
    on('#btnTrCfgClear', 'click', () => {
      Translator.setLocal(null);
      ['#trCfgLocalModel', '#trCfgLocalExe'].forEach((sel) => {
        const el = $(sel);
        if (el) el.value = '';
      });
      const lu = $('#trCfgLocalUrl');
      if (lu) lu.value = 'http://127.0.0.1:11434';
      const gl = $('#trGloss');
      if (gl) gl.value = '';
      if (typeof Translator !== 'undefined' && Translator.setGlossary) Translator.setGlossary('');
      U.toast('已清除本地模型与术语表', '', 1800);
    });

    // 本地增强向导
    on('#btnEnvToggle', 'click', () => {
      setEnvOpenPref(!envOpenPref());
      renderEnvBar();
    });
    on('#btnEnvDownload', 'click', () => {
      const url = (typeof Translator !== 'undefined' && Translator.OLLAMA_SITE) || 'https://ollama.com/download';
      Bridge.openExternal(url);
    });
    on('#btnEnvCopyPull', 'click', async () => {
      const m = (typeof Translator !== 'undefined' && Translator.VISION_SUGGEST) || 'qwen2.5vl:7b';
      const line = 'ollama pull ' + m;
      const ok = await U.copyText(line);
      U.toast(ok ? '命令已复制：' + line : '复制失败，手动输入 ' + line, ok ? 'ok' : 'err', 2600);
    });
    on('#btnEnvRedetect', 'click', redetectEnv);
    on('#btnEnvExeSave', 'click', saveEnvExe);
    on('#btnEnvFind', 'click', findEnvExe);

    /* 「释放显存」：模型此刻在显存里就请出去，不用等 keep_alive 到点。
       释放完立刻重读 /api/ps，那一行会变成「未在显存」。 */
    on('#btnEnvUnload', 'click', async () => {
      const T = (typeof Translator !== 'undefined') ? Translator : null;
      const model = envState.hot || envState.vision;
      if (!T || !model) { U.toast('显存里没有加载中的模型', '', 2200); return; }
      const btn = $('#btnEnvUnload');
      if (btn) { btn.disabled = true; btn.textContent = '释放中…'; }
      const ok = await T.unload(model);
      if (btn) { btn.disabled = false; btn.textContent = '释放显存'; }
      await refreshRuntime();
      U.toast(ok ? '已释放 ' + model + ' 的显存' : '释放失败：本地服务没有响应', ok ? 'ok' : 'err', 2400);
    });

    /* 渠道条：点「本地模型」可以现场把服务拉起来（其余通道只是状态展示） */
    on('#trCh', 'click', async (e) => {
      const b = e.target.closest ? e.target.closest('[data-ch]') : null;
      if (!b) return;
      if (b.dataset.ch !== 'local') return;
      if (!b.classList.contains('off')) {
        U.toast('本地模型可用：下次翻译会优先走它', 'ok', 2200);
        return;
      }
      U.toast('正在试着拉起本地模型…', '', 1800);
      await bootLocalAi({ toast: true });
      renderTrChannels(state.tr && state.tr.result ? state.tr.result.provider : null);
    });
    on('#envExePath', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEnvExe(); }
    });

    // 批注浮层
    on('#npSave', 'click', savePopover);
    on('#npCancel', 'click', closePopover);
    on('#npDelete', 'click', deletePopoverAnn);
    on('#npText', 'keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); savePopover(); }
    });
    document.addEventListener('mousedown', (e) => {
      const pop = $('#notePopover');
      if (!pop || pop.hidden || pop.contains(e.target)) return;
      commitPopover();
    });

    on('#viewport', 'scroll', () => {
      const tb = $('#selToolbar');
      if (tb && !tb.hidden) hideToolbar();
      hideTr();
      closeLinkPop();
      /* 条带挂在页面本地坐标上，滚动后不重算就会错位；先收掉更干净 */
      if (viewer && viewer.clearSelBand) viewer.clearSelBand();
    }, { passive: true });

    // 搜索：输入框常驻顶栏，边输边搜（1 个字就触发，debounce 220ms）
    const searchDebounced = U.debounce((v) => { runSearch(v); }, 220);
    on('#searchInput', 'input', (e) => {
      const v = String(e.target.value || '');
      /* 一有字就入栈，不等 debounce 跑到 runSearch —— 否则「刚打完字马上按 Esc」
         的那几百毫秒里栈还是空的，Esc 会把插件关掉。 */
      if (v.trim()) { if (!Esc.has('search')) Esc.push('search', clearSearch); }
      else clearSearch();
      searchDebounced(v);
    });
    on('#searchInput', 'focus', () => { if (searchState.q) showSearchPane(); });
    on('#searchInput', 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        stepSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        /* 这一下只用来「清搜索」：必须 stopPropagation + preventDefault，
           否则冒泡到 document 后栈已经空了，会被当成「退出插件」。 */
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
        const i = $('#searchInput');
        if (i) i.blur();
      }
    });
    on('#searchInput', 'blur', () => { if (!searchState.q) hideSearchPane(); });
    on('#btnSearchPaneClose', 'click', clearSearch);
    on('#btnSearchNext', 'click', () => stepSearch(1));
    on('#btnSearchPrev', 'click', () => stepSearch(-1));
    on('#btnSearchClear', 'click', () => {
      clearSearch();
      const i = $('#searchInput');
      if (i) i.focus();
    });

    // 链接打开方式
    on('#btnLinkBrowser', 'click', () => runLinkAction('browser'));
    on('#btnLinkEagle', 'click', () => runLinkAction('eagle'));
    on('#btnLinkClose', 'click', closeLinkPop);

    // 空态
    on('#btnEmptyLibrary', 'click', () => Workbench.open(true));
    on('#btnEmptyRetry', 'click', () => { state.lastError = null; openInitial(); });

    /* 捕获阶段监听：先于任何元素（尤其是原生 <video controls>）拿到按键，
       否则空格会被浏览器当成「原生播放/暂停」，和我们的逻辑打两次架。
       v3.24：同时挂到 window 的捕获阶段。window 是事件链最外层，
       一定比 document 先拿到 keydown；document 这份覆盖早期版本的行为，
       两者用 __escSeen 去重，不会处理两次。
       之所以要这一层：焦点落在原生媒体控件、内嵌内容或某些可编辑元素时，
       只挂 document 曾出现过「按键根本不进我们的处理器」的情况。 */
    window.addEventListener('keydown', (e) => {
      if (e.__escSeen) return;
      e.__escSeen = true;
      onKeyDown(e);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.__escSeen) return;
      e.__escSeen = true;
      onKeyDown(e);
    }, true);
    /* 空格抬起也吞掉：Eagle 若在 keyup 上判「关预览」，这里同样拦得住。
       v3.25：ESC 的 keyup 兜底 —— 万一某个原生控件（如 <video controls>）
       把 keydown 吞在内部，keyup 通常还能出来；220ms 内已有 keydown 处理过则跳过。 */
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' && state.isVideo) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Escape' && Date.now() - escLastAt > 220) {
        onKeyDown(e);
      }
    }, true);
    /* 任何点击都把焦点留在插件内（Eagle 的父窗口抢到焦点后，空格就轮不到我们处理）。
       点阅读区时顺带把焦点落到 #viewport：←/→ 翻页也走同一条路。 */
    document.addEventListener('pointerdown', (e) => {
      try { window.focus(); } catch (err) { /* ignore */ }
      if (!state.isVideo && e.target.closest && e.target.closest('#viewport')) grabKeys();
    }, true);
    document.addEventListener('click', (e) => {
      const tb = $('#selToolbar');
      if (!tb || tb.hidden) return;
      if (tb.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.textLayer')) return;
      if (e.target.closest && e.target.closest('#trPanel')) return;
      hideToolbar();
      hideTr();
    });

    /* v3.28：图片一律不许拖。
       浏览器会把 <img> 当成「一个文件」拖，拖到阅读区就触发 drop 处理，
       于是弹出「只支持 PDF 文件」—— 用户以为插件在拒绝自己。
       摘录卡片、笔记引用、PDF 页面浮层里的图，全都在这里拦住。 */
    document.addEventListener('dragstart', (e) => {
      const t = e.target;
      if (!t) return;
      const img = (t.tagName === 'IMG') ? t : (t.closest ? t.closest('img') : null);
      if (img) { e.preventDefault(); return false; }
      return undefined;
    }, true);

    bindDropZone();
    /* v4.4.4：改成具名监听并留下摘钩句柄。原来那个匿名函数没法移除，
       而只要它还挂着，用户点过页面之后 window.close() 就会被 Chromium
       拦住（「不操作能退出、点一下就失效」）。exitPlugin 里已先
       flushDrafts + persist(true)，摘钩不会丢数据；用户点 Eagle 自己的 ✕
       退出时这条监听仍在，照常 persist。 */
    const onUnloadPersist = () => { persist(true); };
    window.addEventListener('beforeunload', onUnloadPersist);
    detachUnloadPersist = () => {
      try { window.removeEventListener('beforeunload', onUnloadPersist); } catch (e) { /* ignore */ }
      detachUnloadPersist = null;
    };

    // Markdown 里的外链交给系统浏览器
    // v4.2：双链 a.wikilink 也是 .md-body 里的 <a>，但它的跳转由 document 级
    // 委托（openWikiTarget）接管 —— 以前这里会把它的 href="javascript:void(0)"
    // 交给 shell.openExternal，每次点双链都白弹一条「Failed to open」红条。
    on('#panel', 'click', (e) => {
      const a = e.target.closest ? e.target.closest('.md-body a') : null;
      if (!a || a.classList.contains('wikilink')) return;
      e.preventDefault();
      Bridge.openExternal(a.getAttribute('href'));
    });
  };

  /* ==================== 拖拽打开 ==================== */
  function bindDropZone() {
    if (dropBound) return;
    dropBound = true;
    let depth = 0;
    const hintEl = () => $('#dropHint');
    const setHint = (show) => {
      const el = hintEl();
      if (el) el.hidden = !show;
    };

    const hasFiles = (e) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      try {
        const types = Array.from(dt.types || []);
        if (types.indexOf('Files') >= 0) return true;
        if (types.indexOf('text/uri-list') >= 0) return true;
        if (types.indexOf('text/plain') >= 0) return true;
        if (dt.items && Array.from(dt.items).some((it) => it.kind === 'file')) return true;
      } catch (err) { /* ignore */ }
      return false;
    };

    const onDragOver = (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
      if (hasFiles(e)) setHint(true);
    };
    const onDragEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setHint(true);
    };
    const onDragLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setHint(false);
    };
    const onDrop = async (e) => {
      const dt = e.dataTransfer;
      const hasPayload = hasFiles(e) || (dt && dt.files && dt.files.length);
      if (!hasPayload) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      setHint(false);
      try {
        console.info('[drop] 收到', {
          types: dt ? Array.from(dt.types || []) : [],
          files: dt && dt.files ? dt.files.length : 0
        });
        await handleDrop(dt);
      } catch (err) {
        console.error('[drop]', err);
        U.toast('打开失败：' + (err && err.message ? err.message : err), 'err', 3600);
      }
    };

    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      if (e.defaultPrevented) return;
      const dt = e.dataTransfer;
      if (!(dt && dt.files && dt.files.length)) return;
      e.preventDefault();
      handleDrop(dt).catch((err) => U.toast('打开失败：' + err.message, 'err', 3600));
    });
  }

  function fileUrlToPath(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    s = s.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function filePathOf(file) {
    if (!file) return null;
    try { if (file.path) return file.path; } catch (e) { /* ignore */ }
    try {
      if (typeof require === 'function') {
        const el = require('electron') || {};
        const wu = el.webUtils || (el.remote && el.remote.webUtils);
        if (wu && typeof wu.getPathForFile === 'function') {
          const p = wu.getPathForFile(file);
          if (p) return p;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function handleDrop(dt) {
    let files = [];
    try { files = Array.from(dt.files || []); } catch (e) { files = []; }

    if (!files.length && dt && dt.items) {
      try {
        files = Array.from(dt.items)
          .filter((it) => it && it.kind === 'file' && typeof it.getAsFile === 'function')
          .map((it) => it.getAsFile())
          .filter(Boolean);
      } catch (e) { /* ignore */ }
    }

    let file = files.find((f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf') || files[0];
    if (file) {
      if (!/\.pdf$/i.test(file.name || '') && file.type !== 'application/pdf') {
        U.toast('只支持 PDF 文件', 'err');
        return;
      }
      const realPath = filePathOf(file);
      try {
        const buffer = realPath ? Store.readFileBuffer(realPath) : await readFileAsArrayBuffer(file);
        if (!buffer) throw new Error('无法读取文件');
        await openItem({
          id: null,
          name: file.name || '拖入的文档.pdf',
          ext: 'pdf',
          folders: [],
          filePath: realPath,
          thumbnailPath: null,
          modifiedAt: Date.now(),
          annotation: '',
          tags: [],
          _buffer: buffer
        });
      } catch (err) {
        U.toast('打开失败：' + err.message, 'err', 3600);
      }
      return;
    }

    let uri = '';
    try { uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) { uri = ''; }
    const first = uri.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))[0];
    if (first && /\.pdf(\?|$)/i.test(first)) {
      const p = fileUrlToPath(first);
      const buffer = Store.readFileBuffer(p);
      if (buffer) {
        await openItem(Bridge.localItem(p));
        return;
      }
      try {
        const res = await fetch(U.toFileUrl(p));
        if (res.ok) {
          await openItem({
            id: null, name: String(p).split(/[\\/]/).pop(), ext: 'pdf', folders: [],
            filePath: p, thumbnailPath: null, modifiedAt: Date.now(), annotation: '', tags: [],
            _buffer: await res.arrayBuffer()
          });
          return;
        }
      } catch (e) { /* ignore */ }
    }
    U.toast('没有识别到 PDF 文件', 'err');
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  }

  /* ==================== 打开文档 ==================== */
  async function openItem(item) {
    if (!item) return false;
    if (state.item && item.id && state.item.id === item.id && (state.doc || state.isVideo)) return true;

    /* 切文档前把上一篇收尾：投影是延迟写的，不先落一次会丢最后那段编辑 */
    if (state.item) { try { persist(true); } catch (e) { /* ignore */ } }

    /* v3.3：视频走另一条路（<video> 而不是 pdf.js） */
    if (VideoView.isVideoItem(item)) return openVideoItem(item);

    const token = ++state.loadToken;
    showLoading('正在读取 PDF…');
    try {
      let target = item;
      if (Bridge.hasEagle && item.id && (!item.filePath || !Store.fileExists(item.filePath))) {
        const fresh = await Bridge.getItemById(item.id);
        if (fresh) target = Object.assign({}, item, fresh, { _buffer: item._buffer, _file: item._file });
      }

      const buffer = await readPdfBuffer(target);
      if (!buffer) throw new Error('无法读取文件内容');
      if (token !== state.loadToken) return !!state.doc;   // 被更新的载入取代：已有文档就算成功

      showLoading('正在解析文档结构…');
      const doc = await PdfDocument.open({ data: buffer }, (p, done, total) => {
        if (token !== state.loadToken) return;
        if (done && total) showLoading(`正在准备页面 ${done}/${total}`);
        else if (p && p < 1) showLoading(`正在加载 ${Math.round(p * 100)}%`);
      });
      if (token !== state.loadToken) return !!state.doc;

      const oldDoc = state.doc;
      state.item = Object.assign({}, target, { _buffer: null, _file: target._file || null });
      state.doc = doc;
      state.data = Store.load({
        itemId: state.item.id,
        name: state.item.name,
        filePath: state.item.filePath
      });
      /* 打开即落一份 Markdown：让「笔记目录里能看到这本书」这件事马上成立，
         而不是要等用户改一动才出现 */
      try {
        if (typeof Projection !== 'undefined' && Projection.isOn()) {
          Projection.writeNow(projMeta(), state.data, false);
        }
      } catch (e) { /* 投影失败不影响阅读 */ }
      state.textIndex = null;
      Search.reset();
      clearSearch();
      state.pdfSync = { sig: null, ok: false, count: 0, reason: null, key: null };
      state.activeAnnId = null;
      state.lastExcerptId = null;
      state.activeNoteKey = null;
      if (typeof Undo !== 'undefined') Undo.clear();   // 撤销栈不能跨文档
      state.pendingSelection = null;
      state.pendingImage = null;

      /* 从视频切回 PDF：把视频区收起，阅读区放出来 */
      if (VideoView.isOpen()) VideoView.close();      state.isVideo = false;
      state.video = null;
      const vpBox = $('#viewport');
      if (vpBox) vpBox.hidden = false;
      updateVideoToolLabels();
      state.vsClip = null;
      applyModeUI();                    // 视频留下的界面差异全部还原

      document.title = (U.stripExt(state.item.name) || '未命名') + ' · 闪灵笔记';
      $('#pageTotal').textContent = '/ ' + doc.numPages;
      $('#emptyState').hidden = true;

      viewer.setDocument(doc, state.data.reading);
      if (oldDoc && oldDoc.proxy) { try { oldDoc.proxy.destroy(); } catch (e) { /* ignore */ } }

      updateZoomUI();
      updatePageUI(viewer.current, doc.numPages);
      annMgr.renderVisible();
      renderOutline(doc.outline);
      state.thumbsBuilt = false;
      $('#thumbList').innerHTML = '';
      const tpPop = $('#thumbsPop');
      if (tpPop && !tpPop.hidden) renderThumbs();
      renderExcerpts();
      renderNotes();
      /* v3.27：打开即对账。注释可能是旧版本写的（只写笔记、不含摘录），
         也可能上一次写没落盘。本地有内容就以本地为准刷一遍；本地空的绝不写空串，
         免得把用户在 Eagle 里自己敲的注释抹掉。 */
      if (state.item && state.item.id && eagleAnnotationText()) {
        setTimeout(function () { try { syncNotesToEagle(true); } catch (e) { /* ignore */ } }, 800);
      }
      if (panelEditor) resetEditor(panelEditor, panelCtx);
      if (modalEditor) resetEditor(modalEditor, modalCtx);
      rememberHistory();
      hideLoading();
      maybeHealPdf();          // 外观格式升级：把旧文件里的错误注释整体重写一遍
      /* 本地模型：打开文档就把它叫起来（v3.9.2）
         3.9.0 为了不闪控制台窗口，改成「只探活、不拉服务」，结果装了 Ollama 但这次
         开机没起服务的机器，右栏一直挂着「未检测到 Ollama」，非得点一次 OCR 才拉 ——
         用户的感受就是「说好的自动运行呢」。现在恢复自动拉起，但只在后台静默做：
           · spawn 已经修好（Windows 不带 detached，windowsHide 才真的生效）；
           · 找不到 exe（没装 / 免安装版没指路）就安静失败，右栏照样给引导；
           · 失败后 30 秒内不再重试，不会反复拉进程。 */
      setTimeout(function () { try { bootLocalAi(); } catch (e) { /* ignore */ } }, 1200);
      /* 环境检测：没装 Ollama、或缺视觉模型时，右栏挂一条说明 + 三步引导。
         上架版必须让第一次用的人知道「OCR 为什么按不了」，而不是撞一句红字。
         先跑一次拿即时状态，bootLocalAi 起来后再 force 刷一次。 */
      setTimeout(function () { try { checkEnv(false); } catch (e) { /* ignore */ } }, 500);
      ensureRtTimer();
      state.lastError = null;
      /* 焦点抓进插件：不抓的话 ←/→ 会被 Eagle 当成「切上一张/下一张素材」 */
      setTimeout(grabKeys, 0);
      if (typeof Workbench !== 'undefined' && Workbench.isOpen()) Workbench.close();
      return true;
    } catch (err) {
      console.error(err);
      hideLoading();
      state.lastError = err && err.message ? err.message : String(err);
      showEmpty(state.lastError);
      U.toast('打开失败：' + state.lastError, 'err', 4200);
      return false;
    }
  }

  async function readPdfBuffer(item) {
    if (item._buffer) return item._buffer;
    if (item._file) return await readFileAsArrayBuffer(item._file);
    if (item.filePath) {
      const fromFs = Store.readFileBuffer(item.filePath);
      if (fromFs) return fromFs;
      try {
        const res = await fetch(U.toFileUrl(item.filePath));
        if (res.ok) return await res.arrayBuffer();
      } catch (e) { /* ignore */ }
      try {
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', U.toFileUrl(item.filePath));
          xhr.responseType = 'arraybuffer';
          xhr.onload = () => ((xhr.status === 200 || xhr.response) ? resolve(xhr.response) : reject(new Error('读取失败')));
          xhr.onerror = () => reject(new Error('读取失败'));
          xhr.send();
        });
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  /* ==================== 视频文档（v3.3） ====================
     数据模型和 PDF 共用，只是把「页码」换成「时间」：
       ann.t / ann.t1（秒），ann.page 固定 1 以便复用列表/知识库/同步的代码。 */
  async function openVideoItem(item) {
    const token = ++state.loadToken;
    showLoading('正在载入视频…');
    try {
      let target = item;
      if (Bridge.hasEagle && item.id && (!item.filePath || !Store.fileExists(item.filePath))) {
        const fresh = await Bridge.getItemById(item.id);
        if (fresh) target = Object.assign({}, item, fresh);
      }
      if (!target.filePath) throw new Error('找不到视频文件路径');
      if (token !== state.loadToken) return !!state.isVideo;

      if (state.doc && state.doc.proxy) { try { state.doc.proxy.destroy(); } catch (e) { /* ignore */ } }
      state.item = Object.assign({}, target, { _buffer: null, _file: null });
      state.doc = null;
      state.isVideo = true;
      state.data = Store.load({ itemId: state.item.id, name: state.item.name, filePath: state.item.filePath });
      /* v4.2.1 提速：投影写盘（读外部改动 + 组装 + 写文件）是同步 IO，
         放在打开路径里会拖慢视频首帧。挪到 UI 出来之后补跑；
         loadToken 守卫 —— 快速切换文档时旧任务作废。 */
      try {
        if (typeof Projection !== 'undefined' && Projection.isOn()) {
          const wMeta = projMeta();
          const wData = state.data;
          setTimeout(() => {
            try {
              if (token === state.loadToken) Projection.writeNow(wMeta, wData, false);
            } catch (e) { /* 投影失败不影响播放 */ }
          }, 200);
        }
      } catch (e) { /* 投影失败不影响播放 */ }
      state.textIndex = null;
      Search.reset();
      clearSearch();
      state.activeAnnId = null;
      state.lastExcerptId = null;
      state.activeNoteKey = null;
      if (typeof Undo !== 'undefined') Undo.clear();   // 撤销栈不能跨文档
      state.pendingSelection = null;
      state.pendingImage = null;

      document.title = (U.stripExt(state.item.name) || '未命名') + ' · 闪灵笔记';
      $('#emptyState').hidden = true;
      $('#pageTotal').textContent = '/ 1';
      $('#pageInput').value = '1';

      const vpBox = $('#viewport');
      if (vpBox) vpBox.hidden = true;
      const startAt = state.data.reading && typeof state.data.reading.t === 'number' ? state.data.reading.t : 0;

      VideoView.open(state.item, {
        startAt,
        onMark: videoMark,
        onClipStart: (t) => U.toast('片段起点 A = ' + VideoView.fmt(t), '', 1600),
        onClip: videoClip,
        onFrame: (t) => videoFrameExcerpt(t, false),
        onMarkPick: pickVideoMark,
        onState: () => {},
        onReady: () => hideLoading()
      });

      updateVideoToolLabels();
      state.vsClip = null;
      state.vsZoom = 1;
      state.openedAt = Date.now();      // 打开那一下的空格不算「播放」
      videoPause = null;
      applyModeUI();
      grabKeys();                       // 把键盘焦点从 Eagle 主窗口抢过来，空格才归我们管
      annMgr.renderVisible();
      renderOutline(null);
      renderExcerpts();
      renderNotes();
      /* v3.27：视频同样打开即对账（见 openItem 里的说明） */
      if (state.item && state.item.id && eagleAnnotationText()) {
        setTimeout(function () { try { syncNotesToEagle(true); } catch (e) { /* ignore */ } }, 900);
      }
      if (panelEditor) resetEditor(panelEditor, panelCtx);
      if (modalEditor) resetEditor(modalEditor, modalCtx);
      rememberHistory();
      hideLoading();
      state.lastError = null;
      /* 视频截图同样走视觉模型做 OCR，右栏那行状态在视频模式下也得是活的 */
      setTimeout(function () { try { checkEnv(false); } catch (e) { /* ignore */ } }, 400);
      ensureRtTimer();
      bindSubtitle();
      /* 实时字幕：换了视频就换一本字幕本子。v3.13 起每次打开都从头转写，
         不沿用上次的结果（旧版会把上次字幕摆出来、时间轴和当前播放位置对不上） */
      if (typeof Subtitle !== 'undefined') {
        try {
          Subtitle.setVideo($('#videoEl'));
          Subtitle.setDoc(state.item);
        } catch (e) { /* 字幕出问题不能影响视频播放 */ }
      }
      /* 焦点抓进插件：不抓的话 ←/→ 会被 Eagle 当成「切上一张/下一张素材」 */
      setTimeout(grabKeys, 0);
      if (typeof Workbench !== 'undefined' && Workbench.isOpen()) Workbench.close();
      return true;
    } catch (err) {
      console.error(err);
      hideLoading();
      state.lastError = err && err.message ? err.message : String(err);
      showEmpty(state.lastError);
      U.toast('打开视频失败：' + state.lastError, 'err', 4200);
      return false;
    }
  }

  /* 视频元素的几个事件只挂一次：
       timeupdate → 高亮当前这条字幕
       seeked     → 跳转后重置识别流（否则会把跳转前那半句接着读下去）
       ended      → 收尾最后没断句的半句
     音频上下文可能被系统挂起，播放时顺手唤醒一次。 */
  /* 字幕导出（v3.12）：把「视频里的声音」变成资料。
     Markdown 带时间戳（能回跳），音频落成 wav（换模型能重跑、能单独听）。
     优先写资料库的 _notes —— 和摘录投影放一处，搬库/备份时跟着走。 */
  function exportSubs() {
    if (typeof Subtitle === 'undefined' || !Subtitle.rows().length) {
      U.toast('还没有字幕内容，先开启实时字幕看一段', '', 2600);
      return;
    }
    let dir = null;
    try { dir = (typeof Projection !== 'undefined' && Projection.dirOf) ? Projection.dirOf() : null; } catch (e) { dir = null; }
    if (!dir) dir = Store.getDataDir();          // 没有资料库路径就退到数据目录
    if (!dir) { U.toast('还没有可写的目录（在 Eagle 里打开一个资料库再试）', 'err', 3200); return; }

    const res = Subtitle.exportAll(state.item, dir);
    if (!res.ok) { U.toast('导出失败：' + (res.error || '未知错误'), 'err', 3600); return; }
    const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';
    const parts = ['字幕 ' + Math.max(1, Math.round(res.mdSize / 1024)) + ' KB'];
    if (res.wav) parts.push('音频 ' + mb(res.wavSize));
    U.toast('已导出（' + parts.join(' · ') + '）→ ' + dir, 'ok', 4600);
    try { if (Bridge.showInFolder) Bridge.showInFolder(res.md); } catch (e) { /* ignore */ }
  }

  function bindSubtitle() {
    if (typeof Subtitle === 'undefined') return;
    const v = $('#videoEl');
    if (!v) return;
    if (v.dataset.subBound !== '1') {
      v.dataset.subBound = '1';
      v.addEventListener('timeupdate', function () {
        try { Subtitle.onTime(v.currentTime); } catch (e) { /* ignore */ }
      });
      v.addEventListener('seeked', function () {
        try {
          if (Subtitle.isRunning() && typeof Asr !== 'undefined') Asr.resetStream();
        } catch (e) { /* ignore */ }
      });
      v.addEventListener('ended', function () {
        try { if (Subtitle.isRunning()) Subtitle.stop(); } catch (e) { /* ignore */ }
      });
    }
    try { Subtitle.bind(); } catch (e) { /* ignore */ }
  }

  function videoMark(t) {
    if (!state.data) return;
    pauseForVideo();                     // 截图并笔记：先暂停，写完自动继续
    const ann = addAnnotation({
      type: 'note', page: 1, t: Math.max(0, t || 0), vt: 'mark',
      point: null, rects: [], text: '', color: state.currentColor
    });
    state.lastExcerptId = ann.id;
    /* v3.30：缩略图也走素材目录（与截图同一条路）。
       以前是 1200px JPEG 的 base64 直接塞索引 —— 几十个打点就能把 index.json 撑到几 MB，
       而且那条底部白边也原样带着。现在只留路径，整帧截图会自动裁掉白边。 */
    let img = '';
    try { img = VideoView.captureFrame(); } catch (e) { img = ''; }
    if (img) {
      const kept = keepImageLocally(img, fileTag(VideoView.fmt(ann.t)) + '-打点');
      if (kept.ok && annById(ann.id)) updateAnnotation(ann, { imagePath: kept.path }, { undo: false });
    }
    renderExcerpts();
    renderNotes();
    annMgr.renderPage(1);
    openComposer('ann', ann.id, 'modal', { fresh: true });
  }

  /* 片段（v3.30）：先记时间轴，需要文件时再录
     ─────────────────────────────────────────
     以前是「按第二次 → 弹另存为 → 实时录一遍 → 才建记录」。三个后果，用户全踩到了：
       · 弹框那几秒视频是停着的，看起来就像「第二次点片段，视频莫名暂停」；
       · 取消另存 → 右栏什么都没有，明明 A、B 都选好了；
       · 录制要按原速跑一遍（3 分钟的片段等 3 分钟），「并笔记」的输入框
         被这个 await 卡在后面，永远轮不到弹出。
     现在：A→B 一定，立刻建记录（预览图后台补），右栏马上有卡片；
     要文件的时候在卡片上点「另存为」，那时才真的录。 */
  function videoClip(t0, t1, withNote) {
    if (!state.data) return;
    const a = Math.max(0, t0);
    const b = Math.max(0, t1);
    if (!(b - a > 0.05)) {
      U.toast('这段太短了（不到 0.05 秒）', '', 2200);
      resumeVideo();
      return;
    }
    const ann = addAnnotation({
      type: 'area', page: 1, t: a, t1: b, vt: 'clip',
      rects: [], text: '', color: state.currentColor,
      image: '', imagePath: '', filePath: ''
    });
    state.lastExcerptId = ann.id;
    /* 预览图后台补：不挡笔记框，也不挡右栏 */
    attachClipPoster(ann, a);
    if (withNote) {
      openComposer('ann', ann.id, 'modal', { fresh: true });
    } else {
      U.toast('已记下片段 ' + VideoView.fmt(a) + ' → ' + VideoView.fmt(b)
        + ' · 卡片上可预览；要文件再点「另存为」', 'ok', 3600);
      resumeVideo();
    }
  }

  /* 片段预览图：取 A 点那一帧，裁掉底部白边，收进素材目录。
     没有它，右栏和笔记里都是一条光秃秃的时间 —— 用户根本认不出是哪一段。 */
  async function attachClipPoster(ann, at) {
    let img = '';
    try { img = await VideoView.captureNative(at, null); } catch (e) { img = ''; }
    if (!img) { try { img = VideoView.captureFrame(); } catch (e) { img = ''; } }
    if (!img) return;
    const kept = keepImageLocally(img, fileTag(VideoView.fmt(at)) + '-片段');
    if (!kept.ok) return;
    if (!annById(ann.id)) return;                 // 期间被删掉了
    updateAnnotation(ann, { imagePath: kept.path }, { undo: false });
  }

  /* 在视频窗口里预览这一段（v3.30）
     不调用系统播放器：原视频就在眼前，定位到 A 播到 B 就够了，
     既不产生文件，也不用等录制。 */
  function previewClip(ann) {
    if (!ann || typeof ann.t !== 'number' || typeof ann.t1 !== 'number') {
      U.toast('这条记录不是片段', 'err');
      return;
    }
    if (!state.isVideo) { U.toast('先打开这段视频，再预览片段', '', 2800); return; }
    VideoView.playRange(ann.t, ann.t1);
    U.toast('预览 ' + VideoView.fmt(ann.t) + ' → ' + VideoView.fmt(ann.t1) + '（到点自动停）', '', 2400);
  }

  /* 录一段并存到用户选的位置。
     返回 { ok, path, cancelled, reason } */
  async function saveClipAs(t0, t1, title) {
    if (!state.isVideo) return { ok: false, reason: '先打开这段视频' };
    if (typeof ClipExport === 'undefined' || !ClipExport.isSupported()) {
      return { ok: false, reason: '当前环境不支持录制（MediaRecorder 不可用）' };
    }
    if (ClipExport.isRunning()) return { ok: false, reason: '上一个片段还在导出' };
    const video = VideoView.element && VideoView.element();
    if (!video || !video.videoWidth) return { ok: false, reason: '视频还没准备好，等画面出来再试' };
    if (typeof SaveAs === 'undefined') return { ok: false, reason: '另存模块没加载' };

    /* 先问保存位置：扩容器取决于这台机器能不能出 mp4，所以要提前算 */
    const mime = ClipExport.pickMime();
    const ext = ClipExport.extOf(mime);
    const filters = ext === '.mp4'
      ? [{ name: 'MP4 视频', extensions: ['mp4'] }]
      : [{ name: 'WebM 视频', extensions: ['webm'] }];
    const tag = fileTag(VideoView.fmt(t0) + '-' + VideoView.fmt(t1));
    const def = SaveAs.defaultPath(state.item, '片段-' + tag, ext);
    const asked = typeof SaveAs.askEx === 'function'
      ? await SaveAs.askEx({ title: title || '片段另存为', defaultPath: def, filters: filters })
      : { kind: (await SaveAs.ask({ title: title || '片段另存为', defaultPath: def, filters: filters })) === '' ? 'cancel' : 'path' };
    try { if (typeof Dbg !== 'undefined') Dbg.log('clip.ask', asked.kind + (asked.reason ? ' / ' + asked.reason : '')); } catch (e) { /* ignore */ }
    if (asked.kind === 'cancel') return { ok: false, cancelled: true };

    let target = '';
    let note = '';
    if (asked.kind === 'path') {
      target = asked.path;
    } else {
      /* 对话框弹不出来：按默认名直接落在源文件旁边，别让用户白录一遍 */
      note = asked.reason || '这个窗口弹不出另存为';
      const dir = state.item && state.item.filePath ? Store.dirOf(state.item.filePath) : '';
      if (!dir) return { ok: false, reason: note };
      target = SaveAs.uniquePath(Store.joinPath(dir, SaveAs.baseName(def)));
    }

    const total = Math.max(0.1, t1 - t0);
    ClipExport.hud(true, '正在按原分辨率录制…', 0);
    Esc.push('clipExport', () => ClipExport.cancel());
    try {
      const res = await ClipExport.recordSegment({
        video: video,
        t0: t0,
        t1: t1,
        name: state.item && state.item.name,
        onProgress: (done, all) => {
          ClipExport.hud(true, '录制中 ' + VideoView.fmt(done) + ' / ' + VideoView.fmt(all), all ? done / all : 0);
        }
      });
      if (res.cancelled && (!res.blob || !res.blob.size)) return { ok: false, cancelled: true };
      if (!res.blob || !res.blob.size) return { ok: false, reason: '没有录到画面（视频可能被别的窗口占用）' };
      const buf = await res.blob.arrayBuffer();
      /* 用户可能把扩展名删了或改成别的，统一按实际容器补齐 */
      const real = SaveAs.ensureExt(target, [res.ext.replace('.', '')]);
      const saved = SaveAs.write(real, new Uint8Array(buf));
      if (!saved) return { ok: false, reason: '写不进这个位置（权限或磁盘）' };
      const muted = res.silent ? '（视频当时静音，文件没有音轨）' : '';
      return {
        ok: true, path: saved, width: res.width, height: res.height, muted: !!res.silent,
        fallback: asked.kind !== 'path', note: note
      };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    } finally {
      Esc.remove('clipExport');
      ClipExport.hud(false);
    }
  }

  /* 00:12 → 00-12：文件名里不能有冒号 */
  function fileTag(t) {
    return String(t || '').replace(/[:：]/g, '-').replace(/[\\/:*?"<>|]/g, '-');
  }

  /* ==================== 视频：原分辨率另存 / 片段导出（v3.27） ====================
     索引里的截图是宽 ≤1200 的 JPEG —— 用来回看够，用来做幻灯片、贴文档、投稿都不够。
     「节选出来的东西，应该能按原样另存」：
       · 截图 / 框选 → 按 videoWidth×videoHeight 回原视频重新取一帧（PNG）；
       · 片段 → 把 A→B 那一段按原分辨率重新录成 mp4（不支持 mp4 时出 webm）。
     两者都落在「源文件所在目录」，文件名带时间点，不会互相覆盖。 */
  function annTimeTag(ann) {
    if (typeof ann.t !== 'number') return 'p' + (ann.page || 1);
    return VideoView.fmt(ann.t).replace(/:/g, '-');
  }

  /* 卡片上的「另存原图」（v3.30：先复制已有原件，再考虑重新取帧）
     ────────────────────────────────────────────────
     顺序换了。以前是「视频记录一律先回原视频重新取一帧」，
     代价是一次离屏 seek（慢的时候好几秒），用户看到的就是
     「提示正在按原分辨率取帧…，然后没有下文」。
     可现在截图本身就是原分辨率、而且已经在盘上了 —— 直接按字节复制即可，
     瞬间完成，像素还是那一刻的，不会因为拖了一下进度条就取到别的帧。

       1. imagePath 存在 → 按字节复制（最快、最准）；
       2. 没有原件（老记录 / 文件被移走）+ 视频 → 回原视频取一帧；
       3. 只剩 base64 → dataURL 落盘。
     只有这一步弹「另存为」，位置由用户定。 */
  async function saveAnnImageNative(ann) {
    if (!ann) return;
    if (!state.item) { U.toast('请先打开文档', 'err'); return; }
    const dbg = (t, v) => { try { if (typeof Dbg !== 'undefined') Dbg.log(t, v); } catch (e) { /* ignore */ } };

    /* 1. 盘上有原件：按字节复制，不重新编码 */
    if (ann.imagePath && Store.fileExists(ann.imagePath)) {
      const res = await copyImageFileAs(ann.imagePath, annTimeTag(ann) + '-另存');
      if (res.ok) { toastSaved(res, '已另存原图'); return; }
      if (res.cancelled) return;
      dbg('save.copy.fail', res.reason || '');
      /* 复制失败（源盘只读、文件被挪走）继续往下试 */
    }

    /* 2. 视频且没有原件：回原视频取一帧原分辨率 */
    let dataUrl = '';
    if (state.isVideo && typeof ann.t === 'number') {
      U.toast('正在按原分辨率取帧…', '', 1200);
      try { dataUrl = await VideoView.captureNative(ann.t, ann.rect || null); } catch (e) { dataUrl = ''; }
      dbg('save.native', dataUrl ? ('ok ' + dataUrl.length + 'B') : 'empty');
    }

    /* 3. 老记录：内嵌 base64 / 从素材目录读回来 */
    if (!dataUrl) dataUrl = ann.image || '';
    if (!dataUrl && ann.imagePath && typeof ImgCache !== 'undefined') {
      dataUrl = await ImgCache.dataUrl(ann.imagePath);
    }
    if (!dataUrl) {
      U.toast(state.isVideo
        ? '取不到这一帧：视频可能已经切走，重新截一张更快'
        : '这条摘录没有图片', 'err', 3200);
      return;
    }
    const saved = await saveImageAsFile(dataUrl, annTimeTag(ann) + '-另存');
    if (!saved.ok) {
      if (!saved.cancelled) U.toast('另存失败：' + (saved.reason || '未知错误'), 'err', 3600);
      return;
    }
    toastSaved(saved, '已另存原图');
  }

  /* 把一个已经在盘上的图片文件「另存」到用户选的位置。
     复制而不是解码再编码：像素一模一样，大图也不用在内存里过一遍 base64。 */
  async function copyImageFileAs(src, tag) {
    const buf = Store.readFileBuffer ? Store.readFileBuffer(src) : null;
    if (!buf || !buf.byteLength) return { ok: false, reason: '源图读不到（文件被移走或没权限）' };
    const ext = (function () {
      const m = /\.([A-Za-z0-9]{1,5})$/.exec(src);
      return m ? m[1].toLowerCase() : 'png';
    })();
    const filters = [{ name: ext.toUpperCase() + ' 图片', extensions: [ext] }];
    const def = SaveAs.defaultPath(state.item, tag, '.' + ext);
    const asked = typeof SaveAs.askEx === 'function'
      ? await SaveAs.askEx({ title: '另存为图片', defaultPath: def, filters: filters })
      : { kind: (await SaveAs.ask({ title: '另存为图片', defaultPath: def, filters: filters })) === '' ? 'cancel' : 'path' };
    try { if (typeof Dbg !== 'undefined') Dbg.log('save.ask', asked.kind + (asked.reason ? ' / ' + asked.reason : '')); } catch (e) { /* ignore */ }
    if (asked.kind === 'cancel') return { ok: false, cancelled: true };

    let target = '';
    let note = '';
    if (asked.kind === 'path') target = asked.path;
    else {
      note = asked.reason || '这个窗口弹不出另存为';
      const dir = (state.item && state.item.filePath) ? Store.dirOf(state.item.filePath) : '';
      if (dir) target = SaveAs.uniquePath(Store.joinPath(dir, SaveAs.baseName(def)));
      if (!target) {
        const dd = (Store.getDataDir && Store.getDataDir()) || '';
        if (dd) target = SaveAs.uniquePath(Store.joinPath(Store.joinPath(dd, 'exports'), SaveAs.baseName(def)));
      }
    }
    if (!target) return { ok: false, reason: note || '拿不到保存位置' };
    const bytes = new Uint8Array(buf);
    const saved = SaveAs.write(target, bytes);
    if (!saved) return { ok: false, reason: '写不进这个位置（权限或磁盘）' };
    honorLateDialog(asked, bytes, null);
    return { ok: true, path: saved, fallback: asked.kind !== 'path', note };
  }

  /* 片段落成文件（v3.30）：只有点了「另存为 / 重新导出」才走这里。
     以前这里第一个分支是「已经有文件就用系统播放器打开」——
     用户明确说了不要：预览在视频窗口里做，这里只负责出文件。 */
  async function exportClipVideo(ann) {
    if (!ann || typeof ann.t !== 'number' || typeof ann.t1 !== 'number') {
      U.toast('这条记录不是片段', 'err');
      return;
    }
    if (!state.isVideo) { U.toast('先打开这段视频，再另存片段', '', 2800); return; }
    const res = await saveClipAs(ann.t, ann.t1, '片段另存为');
    if (!res.ok) {
      if (!res.cancelled) U.toast('片段没存下来：' + (res.reason || '未知错误'), 'err', 3600);
      return;
    }
    updateAnnotation(ann, { filePath: res.path });
    if (res.fallback) {
      U.toast('片段已存到：' + res.path + '（另存为框没弹出来：' + (res.note || '宿主不支持') + '）', '', 7000);
    } else {
      U.toast('已另存片段：' + res.path, 'ok', 3200);
    }
  }

  async function videoFrameExcerpt(t, withNote) {
    if (!state.data) return;
    if (withNote) pauseForVideo();
    const at = Math.max(0, t || 0);
    U.toast('正在按原分辨率取帧…', '', 1200);
    /* v3.29：取**原分辨率**（videoWidth×videoHeight）的 PNG，直接收进素材目录，
       索引里只记路径 —— 不再每截一张就弹一次另存为。
       索引里那张 1200px 的 JPEG 做幻灯片不够用，所以原图按需从盘上取
       （卡片「另存原图」会回原视频重新取帧）。 */
    let dataUrl = '';
    try { dataUrl = await VideoView.captureNative(at, null); } catch (e) { dataUrl = ''; }
    if (!dataUrl) dataUrl = VideoView.captureFrame();       // 兜底：至少有一张
    if (!dataUrl) {
      U.toast('这一帧没能取下来', 'err', 2400);
      if (withNote) resumeVideo();
      return;
    }
    const kept = keepImageLocally(dataUrl, fileTag(VideoView.fmt(at)) + '-截图');
    if (!kept.ok) {
      U.toast('图片没存下来：' + (kept.reason || '未知错误'), 'err', 3200);
      if (withNote) resumeVideo();
      return;
    }
    const ann = addAnnotation({
      type: 'area', page: 1, t: at, t1: null, vt: 'shot',
      rects: [], text: '', color: state.currentColor, image: '', imagePath: kept.path
    });
    state.lastExcerptId = ann.id;
    persist();
    renderExcerpts();
    renderNotes();
    annMgr.renderPage(1);
    if (withNote) openComposer('ann', ann.id, 'modal', { fresh: true });
    else {
      toastKept('截图 ' + VideoView.fmt(at));
      resumeVideo();
    }
  }

  /* ==================== 视频标注：暂停 → 完成 → 自动继续（v3.4） ====================
     用户在记录或框选时不想边写边播。规则：
       · 截图 / 节选片段取起点：不动播放状态
       · 截图并笔记、框选、框选并笔记、节选片段取终点：先暂停
       · 笔记框关闭（保存或不保存都算）、或动作被取消：恢复原来的播放状态
     videoPause 用 null 表示「没在暂停流程里」，避免连续调用把「之前在播」覆盖成 false。 */
  let videoPause = null;

  function pauseForVideo() {
    if (!state.isVideo) return;
    const nowPlaying = VideoView.playing();
    if (videoPause !== null) {
      /* 已经在暂停流程里：只纠正「其实还在播」的残留（比如上一个笔记框被跳过） */
      if (nowPlaying) { videoPause = true; VideoView.pause(); }
      return;
    }
    videoPause = nowPlaying;
    if (nowPlaying) VideoView.pause();
  }

  function resumeVideo() {
    if (!state.isVideo) { videoPause = null; return; }
    const was = videoPause;
    videoPause = null;
    if (was) VideoView.play();
  }

  /* 截图：写笔记就暂停，纯截图不打断观看 */
  function vsShot(withNote) {
    if (!state.isVideo) return;
    if (withNote) pauseForVideo();
    videoFrameExcerpt(VideoView.time(), withNote);
    if (!withNote) resumeVideo();
  }

  /* 框选：一定暂停（要拖框），取消或完成都恢复 */
  function vsArea(withNote) {
    if (!state.isVideo) return;
    if (VideoView.areaActive()) return;
    const pressedId = withNote ? 'btnVsAreaNote' : 'btnVsArea';
    pauseForVideo();
    Esc.push('vsArea', () => VideoView.cancelArea());   // 取消收尾在 onCancel 里做
    const ok = VideoView.beginArea({
      onDone: async (dataUrl, rect) => {
        Esc.remove('vsArea');
        setAreaButtons(false);
        if (!dataUrl) { resumeVideo(); return; }
        const at = VideoView.time();
        /* v3.29：按框在原始画面里的像素位置，回原视频取一张原分辨率的裁切，
           直接收进素材目录（不弹另存为），右栏立刻能看到。 */
        let native = '';
        try { native = await VideoView.captureNative(at, rect || null); } catch (e) { native = ''; }
        const kept = keepImageLocally(native || dataUrl, fileTag(VideoView.fmt(at)) + '-框选');
        if (!kept.ok) {
          U.toast('图片没存下来：' + (kept.reason || '未知错误'), 'err', 3200);
          resumeVideo();
          return;
        }
        const ann = addAnnotation({
          type: 'area', page: 1, t: at, t1: null, vt: 'area',
          rects: [], text: '', color: state.currentColor, image: '',
          rect: rect || null, imagePath: kept.path
        });
        state.lastExcerptId = ann.id;
        persist();
        renderExcerpts();
        renderNotes();
        annMgr.renderPage(1);
        if (withNote) {
          openComposer('ann', ann.id, 'modal', { fresh: true });
        } else {
          toastKept('框选 ' + VideoView.fmt(at));
          resumeVideo();
        }
      },
      onCancel: () => { Esc.remove('vsArea'); setAreaButtons(false); resumeVideo(); }
    });
    if (ok) setAreaButtons(true, pressedId);     // 按键变红闪烁：正在框选
    else { Esc.remove('vsArea'); setAreaButtons(false); resumeVideo(); }
  }

  /* 片段：第一次按只记 A（继续播并开始计时），第二次按记 B 并暂停收尾 */
  /* v3.27：「正在节选」必须看得见。
     节选片段是两段式动作（先 A、播到终点再按 B），中间没有任何模态框，
     状态只活在内存里 —— 不把按键点亮，用户切个窗口回来就不知道自己还在录。
     按下的那颗变红闪烁，另一颗「并笔记」版亮一道红边（提示两条路都能收尾）。 */
  const VS_CLIP_LABEL = { clip: ['节选片段', '按一次取起点 A，播到终点再按一次'],
    clipNote: ['节选片段并笔记', '节选 A→B 片段并写笔记'] };
  const VS_AREA_LABEL = { area: ['框选', '在画面上框选一块区域截成图片'],
    areaNote: ['框选并笔记', '框选一块区域并写笔记'] };

  function paintVsButton(btn, rec, labelKey, recText) {
    if (!btn) return;
    btn.classList.toggle('rec', rec);
    const base = labelKey === 'clipNote' ? 'clipNote' : (labelKey === 'clip' ? 'clip' : (labelKey === 'areaNote' ? 'areaNote' : 'area'));
    const dict = (base === 'clip' || base === 'clipNote') ? VS_CLIP_LABEL : VS_AREA_LABEL;
    btn.textContent = rec ? recText : dict[base][0];
    btn.title = rec ? '再按一次收尾（Esc 取消）' : dict[base][1];
  }

  function setClipButtons(on, pressedId) {
    const a = $('#btnVsClip');
    const b = $('#btnVsClipNote');
    if (!a && !b) return;
    const pressed = pressedId === 'btnVsClipNote' ? b : a;
    const other = pressed === a ? b : a;
    paintVsButton(a, on && pressed === a, 'clip', '● 节选中…');
    paintVsButton(b, on && pressed === b, 'clipNote', '● 节选中…');
    if (on) {
      if (other) other.classList.add('armed');
    } else {
      if (a) a.classList.remove('armed');
      if (b) b.classList.remove('armed');
    }
  }

  function setAreaButtons(on, pressedId) {
    const a = $('#btnVsArea');
    const b = $('#btnVsAreaNote');
    if (!a && !b) return;
    const pressed = pressedId === 'btnVsAreaNote' ? b : a;
    const other = pressed === a ? b : a;
    paintVsButton(a, on && pressed === a, 'area', '● 框选中…');
    paintVsButton(b, on && pressed === b, 'areaNote', '● 框选中…');
    if (on) { if (other) other.classList.add('armed'); }
    else {
      if (a) a.classList.remove('armed');
      if (b) b.classList.remove('armed');
    }
  }

  function clearVsActionState() {
    setClipButtons(false);
    setAreaButtons(false);
  }

  function vsClip(withNote) {
    if (!state.isVideo) return;
    const pressedId = withNote ? 'btnVsClipNote' : 'btnVsClip';
    if (!state.vsClip) {
      const t0 = VideoView.time();
      state.vsClip = { t0, withNote: !!withNote, pressedId };
      VideoView.setClip(t0);            // 画面左上角开始从 00:00 计时
      setClipButtons(true, pressedId);  // 按键变红闪烁：正在节选
      VideoView.setTip('片段起点 A = ' + VideoView.fmt(t0) + '，拖时间轴或按 → 快进找终点，再点一次确定');
      Esc.push('vsClip', () => {
        Esc.remove('vsClip');
        state.vsClip = null;
        VideoView.setClip(null);
        setClipButtons(false);
        VideoView.setTip('已取消片段选择');
      });
      U.toast('已记下起点 ' + VideoView.fmt(t0) + '，拖时间轴或用 → 快进找终点', '', 2600);
      return;
    }
    const c = state.vsClip;
    state.vsClip = null;
    Esc.remove('vsClip');
    VideoView.setClip(null);
    setClipButtons(false);
    /* v3.30：不再 pauseForVideo()。
       现在收尾只是「记下 A、B 两个时间点」，不需要停住画面去录制，
       停了反而让人以为「第二次点片段会把视频弄暂停」。 */
    videoClip(c.t0, VideoView.time(), withNote || c.withNote);
  }

  function updateVideoToolLabels() {
    const a = $('[data-tool="area"]');
    const n = $('[data-tool="note"]');
    if (a) a.textContent = state.isVideo ? '片段' : '框选';
    if (n) n.textContent = state.isVideo ? '打点' : '锚点';
    if (a) a.title = state.isVideo ? '连续按两次：截取 A→B 片段' : '框选区域摘录 (A)';
    if (n) n.title = state.isVideo ? '在当前时间放锚点并写笔记' : '在页面放置笔记锚点 (N)';
    /* v3.27：切文档 / 退出视频时把「正在节选」的按键状态一起复位，
       否则下次进来按键还是红的，看着像卡住了 */
    clearVsActionState();
  }

  /* 卡片上的位置标签：视频显示时间，PDF 显示页码 */
  function placeLabel(ann) {
    if (ann && typeof ann.t === 'number') {
      const t = VideoView.fmt(ann.t);
      return ann.t1 != null ? t + '–' + VideoView.fmt(ann.t1) : t;
    }
    return 'p.' + (ann && ann.page ? ann.page : 1);
  }

  function showEmpty(msg) {
    $('#emptyState').hidden = false;
    $('#pages').innerHTML = '';
    $('#pageTotal').textContent = '/ 0';
    $('#pageInput').value = '1';
    $('#excerptList').innerHTML = '';
    $('#notesList').innerHTML = '';
    $('#excerptCount').textContent = '0';
    $('#notesCount').textContent = '0';
    state.item = null;
    state.doc = null;
    state.data = null;
    state.isVideo = false;
    state.thumbsBuilt = false;
    if (VideoView.isOpen()) VideoView.close();
    /* 字幕的采集与识别要跟着停：留着 ScriptProcessor 会一直占着音频线程 */
    if (typeof Subtitle !== 'undefined') {
      try { Subtitle.detach(); } catch (e) { /* ignore */ }
    }
    const vpBox = $('#viewport');
    if (vpBox) vpBox.hidden = false;
    updateVideoToolLabels();
    Search.reset();
    clearSearch();
    document.title = '闪灵笔记';

    renderOutline(null);
    renderThumbs();

    const box = $('#emptyMsg');
    if (box) {
      const text = msg || state.lastError || '';
      box.textContent = text;
      box.hidden = !text;
    }
    const retry = $('#btnEmptyRetry');
    if (retry) retry.hidden = !(Bridge.state.query && (Bridge.state.query.id || Bridge.state.query.path));
  }

  function showLoading(text) {
    $('#loadingMask').hidden = false;
    if (text) $('#loadingText').textContent = text;
  }
  function hideLoading() { $('#loadingMask').hidden = true; }

  /* ==================== 分页与缩放 ==================== */
  function onPageChanged(n, total) {
    updatePageUI(n, total);
    updateActiveThumb(n);
    if (state.data) {
      state.data.reading = state.data.reading || { page: 1, zoomMode: 'fit-width', zoom: 1 };
      state.data.reading.page = n;
      persistLater();
    }
    historyLater(n);
  }

  function updatePageUI(n, total) {
    const input = $('#pageInput');
    if (document.activeElement !== input) input.value = n;
    if (total) $('#pageTotal').textContent = '/ ' + total;
  }

  function updateZoomUI() {
    const label = $('#zoomLabel');
    if (!label) return;
    label.textContent = state.isVideo
      ? Math.round((state.vsZoom || 1) * 100) + '%'
      : Math.round(viewer.zoom * 100) + '%';
  }

  /* 视频显示倍率：0.5×–2×，适宽 = 100% */
  function vsZoomTo(z) {
    state.vsZoom = VideoView.setZoom(z);
    updateZoomUI();
  }
  function vsZoomBy(d) {
    vsZoomTo((state.vsZoom || 1) + d);
  }

  /* 视频模式与 PDF 模式的界面差异（v3.4）
     视频要的是「一块播放器 + 下面一排标注键」，不需要翻页、色板、PDF 的框选/锚点、全文搜索：
       · 顶栏：翻页组 / 色板 / 四个动作键 / 搜索框 全部收起，缩放组自然落到最左
       · 左栏：目录与缩略图整块收起，只留历史记录并撑满
     改回 PDF 时全部还原。 */
  /* 视频模式下右栏的筛选语义完全不同：截图 / 框选 / 片段。
     同一批 chip 复用，只改文案与 data-filter，免得两套 DOM 打架。 */
  const PDF_FILTERS = [['all', '全部'], ['highlight', '摘录'], ['area', '框选'], ['note', '锚点']];
  const VIDEO_FILTERS = [['all', '全部'], ['shot', '截图'], ['area', '框选'], ['clip', '片段']];

  function syncFilterChips() {
    const chips = $$('#excerptFilters .chip');
    if (!chips.length) return;
    const set = state.isVideo ? VIDEO_FILTERS : PDF_FILTERS;
    let valid = false;
    chips.forEach((c, i) => {
      const pair = set[i];
      if (!pair) return;
      c.dataset.filter = pair[0];
      c.textContent = pair[1];
      if (state.filter === pair[0]) valid = true;
    });
    if (!valid) state.filter = 'all';
    chips.forEach((c) => c.classList.toggle('active', c.dataset.filter === state.filter));
  }

  /* 把键盘焦点抓进插件。
     在 Eagle 里按空格是「关预览」、按 ←/→ 是「上一张/下一张素材」，这两下之所以
     会落到 Eagle 而不是插件，是因为焦点还在宿主窗口上 —— 键盘事件根本没送到本页面，
     preventDefault 也拦不住。所以打开文档 / 点阅读区时主动 focus 对应容器。 */
  function grabKeys() {
    try { window.focus(); } catch (e) { /* ignore */ }
    const target = state.isVideo ? $('#videoStage') : $('#viewport');
    if (target) {
      try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  function applyModeUI() {
    const v = !!state.isVideo;
    ['#pageGroup', '#swatchBar', '#toolGroup', '#searchBox', '#btnAiSummary'].forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = v;
    });
    /* 3：视频下色板不消失，只是挪到下方工具栏（#vsSwatches） */
    const vsSw = $('#vsSwatches');
    if (vsSw) vsSw.hidden = !v;
    const top = $('.topbar');
    if (top) top.classList.toggle('video-mode', v);
    /* v4.1：左栏已移除 —— `.app.video-mode` 只剩列宽一条规则（右栏在视频下同样宽） */
    const appEl = $('.app');
    if (appEl) appEl.classList.toggle('video-mode', v);
    /* v4.1：顶栏弹出面板入口 —— 目录 / 缩略图只在 PDF 模式，字幕只在视频模式。
       进入视频模式时自动弹出字幕面板（保持原左栏「字幕常驻」的使用习惯），
       切回 PDF 时全部收起。 */
    const bOut = $('#btnPopOutline');
    const bThu = $('#btnPopThumbs');
    const bSub = $('#btnPopSubs');
    if (bOut) bOut.hidden = v;
    if (bThu) bThu.hidden = v;
    if (bSub) bSub.hidden = !v;
    closeSidePops(v ? 'subs' : null);
    /* v4.2：进视频不再自动弹字幕面板 —— 用户点顶栏「字幕」键自己开。
       之前自动弹是为了引导发现功能，但实际用起来每次都挡画面。 */
    const tip = $('#vsTip');
    if (tip && v && !state.vsClip) {
      tip.textContent = '空格 播放/暂停 · ← → 前后 5 秒 · 拖时间轴定位 · 点色块选中后按 Delete 可删';
    }
    syncFilterChips();
    updateZoomUI();
  }

  function setTool(tool) {
    /* 视频模式下顶栏的框选/锚点键已收起，这里只做兜底（键盘 a / n 仍可用） */
    if (state.isVideo) {
      if (tool === 'note') { vsShot(true); return; }
      if (tool === 'area') { vsClip(false); return; }
      return;
    }
    viewer.setTool(tool);
    $$('#toolGroup .tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    hideToolbar();
    if (tool === 'highlight') U.toast('拖选文字即高亮，颜色看右侧色板', '', 1600);
    if (tool === 'area') U.toast('在页面上拖出矩形即可框选摘录', '', 1600);
    if (tool === 'note') U.toast('在页面上点一下即可放置笔记锚点', '', 1600);
  }

  /* ==================== 选区 → 浮动工具条 ==================== */
  function onSelectionChange() {
    if (!state.doc) return;
    if (viewer.tool === 'area' || viewer.tool === 'note') return;
    /* v3.21：拖选中不要算几何。snapshotSelection 会遍历所有页、对命中页逐文本节点
       getClientRects()，每 140ms 一次全文档强制同步布局 —— 这正是「蓝色闪烁」和
       「选区跟不上鼠标」的来源。mouseup 后 onDocumentMouseUp 会取一次完整快照。 */
    if (viewer.isSelecting && viewer.isSelecting()) return;
    const info = viewer.snapshotSelection();
    /* v3.22：用精确的行矩形重画柔和条带；选区塌陷时把条带一起收掉。
       拖选过程中由 viewer._paintLiveBand 画近似条带，这里只负责 mouseup 后的定稿。 */
    if (info) {
      state.pendingSelection = info;
      if (viewer.paintSelection) viewer.paintSelection(info);
    } else if (viewer.clearSelBand) {
      viewer.clearSelBand();
    }
  }

  function onDocumentMouseUp(e) {
    if (!state.doc) return;
    if (e.target.closest && (e.target.closest('#panel') || e.target.closest('.left') || e.target.closest('#selToolbar')
      || e.target.closest('#notePopover') || e.target.closest('#trPanel'))) return;
    if (!(e.target.closest && e.target.closest('.page'))) return;

    setTimeout(() => {
      const info = viewer.snapshotSelection();
      // 图片选区是 mousedown 判定的，这时没有文字选区，别把图片工具条顺手关掉
      if (!info) { if (!state.pendingImage) hideToolbar(); return; }
      state.pendingImage = null;
      state.pendingSelection = info;

      if (viewer.tool === 'highlight') {
        const created = createHighlights(info, state.currentColor);
        viewer.clearSelection();
        hideToolbar();
        toastCreated(created);
        return;
      }
      showToolbar(info.groups[info.groups.length - 1].clientRect, 'text');
      // 实时翻译：选完就开始在后台翻，点「翻译」时通常已经有结果
      const text = String(info.text || '').trim();
      if (text.length >= 2 && typeof Translator !== 'undefined') {
        try { Translator.prefetch(text, Translator.guessTarget(text)); } catch (e) { /* ignore */ }
      }
    }, 10);
  }

  function toastCreated(created) {
    if (!created.length) { U.toast('这段文字未取到坐标，请重新拖选', 'err', 2600); return; }
    const lines = created.reduce((n, a) => n + (a.rects ? a.rects.length : 0), 0);
    const tip = created.length > 1 ? `已摘录 ${lines} 行（跨 ${created.length} 页）` : `已摘录 ${lines} 行`;
    U.toast(tip, 'ok', 1500);
    annMgr.setActive(created[created.length - 1].id);
    /* 只在这几条新摘录的矩形上描一圈（整页泛蓝那版见 viewer.flashAnn 的说明） */
    if (viewer.flashAnn) viewer.flashAnn(created[created.length - 1]);
  }

  function createHighlights(info, color) {
    const created = [];
    (info.groups || []).forEach((g) => {
      /* 跨页选一段话会生成好几条记录，但它们对用户是「一次摘录」，
         撤销也应该一次退干净，所以这里逐条禁掉撤销、末尾合并成一步 */
      created.push(addAnnotation({
        type: 'highlight',
        page: g.page,
        rects: g.rects,
        text: U.normalizeText(g.text),
        color
      }, { undo: false, scroll: false }));
    });
    if (created.length) {
      const last = created[created.length - 1];
      state.lastExcerptId = last.id;
      Undo.push(created.length > 1 ? '新增 ' + created.length + ' 段摘录' : '新增摘录', () => {
        created.forEach((a) => detachAnn(a));
        refreshAnnotations();
      });
      scrollExcerptTo(last.id);
    }
    return created;
  }

  /* 浮动工具条：文字选区与图片选区共用
     - 文字：色板 + 摘录 + 摘录并笔记 + 翻译 + 复制
     - 图片：摘录 + 摘录并笔记 + 复制（没有色板，也没有翻译） */
  function showToolbar(rect, mode) {
    const tb = $('#selToolbar');
    if (!tb) return;
    const m = mode || 'text';
    tb.dataset.mode = m;
    tb.hidden = false;
    const isImage = m === 'image';
    $$('#selToolbar .sel-btn').forEach((b) => {
      if (b.dataset.act === 'translate') b.hidden = isImage;
    });
    const sw = $('#swatches');
    if (sw) sw.hidden = isImage;
    const r = rect || { left: 40, top: 40, right: 60, bottom: 60 };
    const tbr = tb.getBoundingClientRect();
    const left = U.clamp(r.right - tbr.width / 2, 10, window.innerWidth - tbr.width - 10);
    let top = r.top - tbr.height - 8;
    if (top < 8) top = r.bottom + 8;
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
    Esc.push('toolbar', () => {
      hideToolbar();
      try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
      if (viewer) { try { viewer.clearSelection(); } catch (e) { /* ignore */ } }
    });
  }

  function hideToolbar() {
    const tb = $('#selToolbar');
    if (tb) tb.hidden = true;
    state.pendingSelection = null;
    state.pendingImage = null;
    /* 工具条收掉，图片外那圈选中框也跟着收 */
    if (viewer && viewer.clearImageMark) viewer.clearImageMark();
    Esc.remove('toolbar');
    hideTr();
  }

  async function onToolbarAction(act) {
    if (act === 'copy') {
      if (state.pendingImage) { await copySelectedImage(); return; }
      const info = state.pendingSelection;
      if (!info) return;
      const ok = await U.copyText(info.text);
      U.toast(ok ? '已复制选中文字' : '复制失败', ok ? 'ok' : 'err');
      hideToolbar();
      return;
    }
    if (act === 'translate') { runTranslate(); return; }
    if (act === 'excerpt' || act === 'excerptNote') {
      if (state.pendingImage) runImageExcerpt(act === 'excerptNote');
      else runCurrentExcerpt(act === 'excerptNote');
    }
  }

  function renderSwatches() {
    ['#swatches', '#swatchBar', '#vsSwatches'].forEach((sel) => {
      const wrap = $(sel);
      if (!wrap) return;
      wrap.innerHTML = '';
      AnnColors.forEach((c) => {
        const b = U.el('button', { class: 'swatch' + (c.id === state.currentColor ? ' active' : ''), 'data-color': c.id, title: c.label });
        b.style.background = c.hl;
        b.style.color = c.solid;
        b.addEventListener('click', () => setColor(c.id));
        wrap.appendChild(b);
      });
    });
  }

  function setColor(id) {
    state.currentColor = id;
    $$('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === id));
  }

  /* ==================== 框选 / 锚点 / 图片 ==================== */
  async function handleAreaRect(payload) {
    if (!state.doc) return;
    setTool('select');
    /* v3.29：框选 → 渲染成 PNG → **直接收进右栏**（素材目录），不再弹另存为。
       想拿独立文件，点卡片上的「另存原图」。
       v3.25 起三种摘录统一走大笔记框，标题按类型区分（见 openComposer 的 NOTE_TITLE）。

       v3.28.3：这一段以前是「裸 await」，任何一跳抛错都会变成一个静默的
       unhandled rejection —— 用户看到的就是「框画出来了，但截不了图」。
       现在每一步都记日志、都有兜底，失败也一定说话。 */
    const dbg = (tag, v) => { try { if (typeof Dbg !== 'undefined') Dbg.log(tag, v); } catch (e) { /* ignore */ } };
    dbg('area.begin', { page: payload.page, rect: payload.rect, client: payload.client });

    let image = '';
    try {
      image = await captureRegion(payload.page, payload.rect);
    } catch (e) {
      dbg('area.capture.err', e);
      console.warn('[area] 页面重渲染失败，改走窗口截屏', e);
    }
    dbg('area.capture', image ? ('ok ' + image.length + 'B') : 'empty');

    /* 兜底：pdf.js 那条路没出图，就直接从窗口上截这块。
       清晰度略差（屏幕分辨率），但「框了就一定拿得到图」更重要。 */
    if (!image && payload.client && Bridge.captureWindow) {
      const c = payload.client;
      image = await Bridge.captureWindow({ x: c.x, y: c.y, width: c.w, height: c.h });
      dbg('area.capture.window', image ? ('ok ' + image.length + 'B') : 'empty');
    }

    if (!image) {
      U.toast('这块区域没能取到图，换个位置再框一次（详情见 debug.log）', 'err', 3200);
      return;
    }
    const kept = keepImageLocally(image, 'p' + payload.page + '-框选');
    if (!kept.ok) {
      U.toast('图片没存下来：' + (kept.reason || '未知错误'), 'err', 3200);
      return;
    }
    const ann = addAnnotation({
      type: 'area', page: payload.page, rects: [payload.rect], text: '',
      color: state.currentColor, image: '', imagePath: kept.path
    });
    state.lastExcerptId = ann.id;
    persist();
    renderExcerpts();
    renderNotes();
    annMgr.renderPage(payload.page);
    toastKept('p.' + payload.page);
    openComposer('ann', ann.id, 'modal', { fresh: true });
  }

  function handleNotePoint(payload) {
    if (!state.doc) return;
    const ann = addAnnotation({
      type: 'note', page: payload.page, point: payload.point,
      rects: [{ x: payload.point.x, y: payload.point.y, w: 0.01, h: 0.01 }],
      text: '', color: state.currentColor
    });
    state.lastExcerptId = ann.id;
    setTool('select');
    /* 2.1：放下锚点就直接弹大笔记框，想写就写，不想写 Esc / ✕ 关掉即可 */
    openComposer('ann', ann.id, 'modal', { fresh: true });
  }

  /* 点中页面里的图片 → 像文字一样出工具条 */
  function pickImage(payload, pageEl) {
    if (!state.doc) return;
    // 选图片时把残留的文字选区清掉，免得两套选中状态打架
    try {
      const s = window.getSelection();
      if (s && !s.isCollapsed) s.removeAllRanges();
    } catch (e) { /* ignore */ }
    state.pendingSelection = null;
    state.pendingImage = payload;
    const r = pageEl.getBoundingClientRect();
    const rect = payload.rect;
    /* v3.31：先把选中框画出来，再弹工具条 —— 让用户看清点的是哪张图 */
    if (viewer.markImage) viewer.markImage(pageEl, rect);
    showToolbar({
      left: r.left + rect.x * r.width,
      top: r.top + rect.y * r.height,
      right: r.left + (rect.x + rect.w) * r.width,
      bottom: r.top + (rect.y + rect.h) * r.height
    }, 'image');
  }

  /* 把页面的一块区域渲染成 PNG（摘录图片 / 框选缩略图都用它）
     v3.3：固定「2 像素 / PDF 点」渲染，展示时按 1 像素 / 点显示 ——
     这样不论框多大，图里的文字大小都一致，不会一张大一张小。 */
  async function captureRegion(pageNum, r) {
    if (!state.doc) return '';
    const page = await state.doc.proxy.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const regionW = Math.max(8, r.w * base.width);
    const regionH = Math.max(8, r.h * base.height);
    const MAXPX = 2400;                                   // 防止超大框选把画布撑爆
    const scale = Math.max(0.5, Math.min(2, MAXPX / regionW, MAXPX / regionH));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const sx = Math.max(0, Math.floor(r.x * canvas.width));
    const sy = Math.max(0, Math.floor(r.y * canvas.height));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.floor(r.w * canvas.width)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.floor(r.h * canvas.height)));
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    try { return out.toDataURL('image/png'); } catch (e) { return ''; }
  }

  /* 图片在卡片里的展示尺寸：截图是 2px/点，这里换算回 1px/点，
     再交给 CSS 的 max-width:100% 兜住窄卡片（小图等比缩小，不拉伸）。 */
  /* 把渲染好的图片「另存为」（v3.28 / v3.28.3 加固）
     ─────────────────────────────────
     顺序很重要：**先让用户选位置，选好了才写**。取消就什么都不留 ——
     不留半条空摘录，也不偷偷写一份到源文件旁边。

     但「对话框弹不出来」和「用户主动取消」必须区别对待：
     前者是宿主环境问题（Eagle 的 dialog IPC 拿不到父窗口就回 undefined），
     把它当取消处理，用户看到的就是「框画出来了，什么都没发生」。
     所以 'unavailable' 时直接落盘到源文件旁边（再退到插件数据目录），
     用 toast 说清楚「对话框没弹出来，已经直接存这儿了」。

     返回 { ok, path, cancelled, reason, fallback, note } */
  async function saveImageAsFile(dataUrl, tag) {
    if (!dataUrl) return { ok: false, reason: '没有图片' };
    if (!state.item) return { ok: false, reason: '没有打开文档' };
    if (typeof SaveAs === 'undefined') return { ok: false, reason: '另存模块没加载' };
    const dbg = (t, v) => { try { if (typeof Dbg !== 'undefined') Dbg.log(t, v); } catch (e) { /* ignore */ } };

    const isPng = /^data:image\/png/i.test(dataUrl);
    const ext = isPng ? '.png' : '.jpg';
    const filters = isPng
      ? [{ name: 'PNG 图片', extensions: ['png'] }]
      : [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }];
    const def = SaveAs.defaultPath(state.item, tag, ext);

    const asked = typeof SaveAs.askEx === 'function'
      ? await SaveAs.askEx({ title: '另存为图片', defaultPath: def, filters: filters })
      : { kind: (await SaveAs.ask({ title: '另存为图片', defaultPath: def, filters: filters })) === '' ? 'cancel' : 'path' };
    dbg('save.ask', asked.kind + (asked.reason ? ' / ' + asked.reason : '') + (asked.path ? ' / ' + asked.path : ''));

    if (asked.kind === 'cancel') return { ok: false, cancelled: true };

    let target = '';
    let note = '';
    if (asked.kind === 'path') {
      target = asked.path;
    } else {
      /* 没有对话框：绝不丢图。源文件旁边 → 插件数据目录 assets/ */
      note = asked.reason || '这个窗口弹不出另存为';
      const dir = (state.item && state.item.filePath) ? Store.dirOf(state.item.filePath) : '';
      if (dir) target = Store.joinPath(dir, SaveAs.baseName(def));
      else {
        const dd = (Store.getDataDir && Store.getDataDir()) || '';
        if (dd) target = Store.joinPath(Store.joinPath(dd, 'assets'), SaveAs.baseName(def));
      }
      target = target ? SaveAs.uniquePath(target) : '';
    }
    if (!target) return { ok: false, reason: note || '拿不到保存位置' };

    let saved = SaveAs.writeDataUrl(target, dataUrl);
    if (!saved && asked.kind !== 'path') {
      /* 源目录写不进去（只读盘 / 权限）：再退到插件数据目录 */
      const dd = (Store.getDataDir && Store.getDataDir()) || '';
      if (dd) {
        const alt = SaveAs.uniquePath(Store.joinPath(Store.joinPath(dd, 'assets'), SaveAs.baseName(def)));
        saved = SaveAs.writeDataUrl(alt, dataUrl);
      }
    }
    if (!saved) {
      dbg('save.write.err', target);
      return { ok: false, reason: '写不进这个位置（权限或磁盘）' };
    }
    dbg('save.write', saved);
    /* 已经先落了盘，但那个「没出现」的另存为框有可能迟到 ——
       真弹出并选了位置的话，按用户选的再写一份（不是覆盖，是多一份）。 */
    honorLateDialog(asked, dataUrlBytesOf(dataUrl), dbg);
    return { ok: true, path: saved, fallback: asked.kind !== 'path', note };
  }

  /* 迟到的另存为结果：用户真的选了位置就照办，并明确说一句。 */
  function honorLateDialog(asked, bytes, dbg) {
    if (!asked || !asked.pending || !bytes) return;
    asked.pending.then((r) => {
      try {
        if (!r || r.canceled) return;
        const p = r.filePath || (Array.isArray(r.filePaths) && r.filePaths[0]) || '';
        if (!p) return;
        if (SaveAs.write(p, bytes)) {
          U.toast('另存为框后来出现了，已按你选的位置也存了一份：' + p, 'ok', 5200);
        }
      } catch (e) { /* ignore */ }
    }).catch(() => { /* ignore */ });
  }

  function dataUrlBytesOf(dataUrl) {
    try { return (typeof SaveAs !== 'undefined' && SaveAs.dataUrlBytes) ? SaveAs.dataUrlBytes(dataUrl) : null; } catch (e) { return null; }
  }

  /* 保存结果的统一提示：走没走兜底要说清楚，别让用户以为对话框坏了还不知道图存哪了 */
  function toastSaved(saved, label) {
    if (!saved || !saved.ok) return;
    if (saved.fallback) {
      U.toast((label || '已保存') + '：' + saved.path
        + '（另存为框没弹出来：' + (saved.note || '宿主不支持') + '，已直接存）', '', 7000);
    } else {
      U.toast((label || '已另存') + '：' + saved.path, 'ok', 2600);
    }
  }

  /* 摘录下来的图先落进插件自己的素材目录（v3.29）
     ─────────────────────────────────────────
     为什么又改回来：3.28 把「截图 / 框选 / 内嵌图片」全改成先弹另存为，
     但用户的用法是**先把东西收进右栏**，需要独立文件时再说。
     每点一次「摘录」就拦一道系统对话框，等于把「收集」打断成「归档」。

     现在的分工：
       · 摘录动作（图片摘录 / 框选 / 视频截图 / 视频框选）→ **不弹框**，
         直接写进 <dataDir>/media/，索引里只记路径，右栏立刻能看；
       · 卡片上的「另存原图」/「片段另存为」→ 这时才弹框，用户自己选位置。
     两边都不把图片塞进索引（仍只存路径），所以「清数据」也清得掉。 */
  function keepImageLocally(dataUrl, tag) {
    if (!dataUrl) return { ok: false, reason: '没有图片' };
    if (typeof SaveAs === 'undefined') return { ok: false, reason: '另存模块没加载' };
    const dd = (typeof Store !== 'undefined' && Store.getDataDir) ? (Store.getDataDir() || '') : '';
    if (!dd) return { ok: false, reason: '拿不到插件数据目录' };
    const isPng = /^data:image\/png/i.test(dataUrl);
    const ext = isPng ? '.png' : '.jpg';
    const docName = (state.item && state.item.name) ? SaveAs.stripExt(state.item.name) : '';
    const fname = SaveAs.safeName((docName ? docName + '-' : '') + (tag || '图片'), '素材') + ext;
    const target = SaveAs.uniquePath(Store.joinPath(Store.joinPath(dd, 'media'), fname));
    const saved = SaveAs.writeDataUrl(target, dataUrl);
    if (!saved) return { ok: false, reason: '写不进插件素材目录' };
    try { if (typeof Dbg !== 'undefined') Dbg.log('keep.image', saved); } catch (e) { /* ignore */ }
    return { ok: true, path: saved };
  }

  /* 收进右栏之后统一说一句 —— 用户得知道「原图在哪儿、怎么拿出去」 */
  function toastKept(tag) {
    U.toast('已收进右栏' + (tag ? '（' + tag + '）' : '')
      + ' · 要独立文件点卡片上的「另存原图」', 'ok', 3000);
  }

  function fitImageSize(img, perPoint) {
    const apply = () => {
      const w = img.naturalWidth || 0;
      if (!w) return;
      img.style.width = Math.max(24, Math.round(w / (perPoint || 2))) + 'px';
    };
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener('load', apply, { once: true });
  }

  async function runImageExcerpt(withNote) {
    const pk = state.pendingImage;
    if (!pk) { U.toast('先点选页面中的图片', '', 2000); return; }
    hideToolbar();
    U.toast('正在截取图片…', '', 1200);
    let image = '';
    try { image = await captureRegion(pk.page, pk.rect); } catch (e) { console.warn(e); }
    if (!image) { U.toast('这张图没能截取下来', 'err', 2400); return; }
    const kept = keepImageLocally(image, 'p' + pk.page + '-图片');
    if (!kept.ok) { U.toast('图片没存下来：' + (kept.reason || '未知错误'), 'err', 3200); return; }
    const ann = addAnnotation({
      type: 'area', page: pk.page, rects: [pk.rect], text: '',
      color: state.currentColor, image: '', imagePath: kept.path
    });
    state.lastExcerptId = ann.id;
    state.pendingImage = null;
    persist();
    renderExcerpts();
    renderNotes();
    annMgr.setActive(ann.id);
    if (withNote) openComposer('ann', ann.id, 'modal', { fresh: true });
    else toastKept('p.' + pk.page);
  }

  async function copySelectedImage() {
    const pk = state.pendingImage;
    if (!pk) return;
    try {
      const image = await captureRegion(pk.page, pk.rect);
      if (image && Bridge.copyImageDataUrl(image)) {
        U.toast('图片已复制到剪贴板', 'ok');
        hideToolbar();
        return;
      }
    } catch (e) { console.warn(e); }
    U.toast('复制图片失败（可用「摘录」保存后再复制）', 'err', 3000);
  }

  /* ==================== PDF 链接 ==================== */
  async function pickLink(link) {
    if (!link) return;
    // 内部跳转：直接翻页
    if (!link.url && link.dest) {
      const page = await resolveDest(link.dest);
      if (page) { viewer.goToPage(page); return; }
      U.toast('无法定位该内部链接', 'err');
      return;
    }
    if (!link.url) return;
    state.linkTarget = link;
    const pop = $('#linkPop');
    if (!pop) { Bridge.openExternal(link.url); return; }
    $('#lpUrl').textContent = link.url;
    $('#lpUrl').title = link.url;
    const eagleBtn = $('#btnLinkEagle');
    if (eagleBtn) {
      eagleBtn.hidden = !Bridge.hasEagle;
      eagleBtn.textContent = '在 Eagle 中打开';
    }
    pop.hidden = false;
    const r = pop.getBoundingClientRect();
    pop.style.left = U.clamp(window.innerWidth / 2 - r.width / 2, 12, window.innerWidth - r.width - 12) + 'px';
    pop.style.top = U.clamp(window.innerHeight / 2 - r.height / 2, 60, window.innerHeight - r.height - 20) + 'px';
    Esc.push('link', closeLinkPop);
  }

  async function resolveDest(dest) {
    if (!state.doc) return null;
    try {
      let d = dest;
      if (typeof d === 'string') d = await state.doc.proxy.getDestination(d);
      if (Array.isArray(d) && d.length) {
        const ref = d[0];
        if (ref && typeof ref === 'object') return (await state.doc.proxy.getPageIndex(ref)) + 1;
        if (typeof ref === 'number') return ref + 1;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function runLinkAction(kind) {
    const link = state.linkTarget;
    if (!link || !link.url) { closeLinkPop(); return; }
    const url = link.url;
    closeLinkPop();
    if (kind === 'browser') {
      Bridge.openExternal(url);
      return;
    }
    U.toast('正在存入 Eagle…', '', 1400);
    const id = await Bridge.addUrlToLibrary(url, url.replace(/^https?:\/\//, '').slice(0, 60));
    if (id) {
      U.toast('已存入 Eagle 资料库', 'ok', 2000);
      try { await Bridge.openItem(id); } catch (e) { /* ignore */ }
      return;
    }
    U.toast('当前 Eagle 版本不支持存入链接，已用默认浏览器打开', '', 3000);
    Bridge.openExternal(url);
  }

  function closeLinkPop() {
    const pop = $('#linkPop');
    if (pop) pop.hidden = true;
    state.linkTarget = null;
    Esc.remove('link');
  }

  /* ==================== 划词翻译 ====================
     从 PDF 里拖出来的「一段」，其实是排版后的若干行：行末带换行，长单词被连字符切开。
     直接交给翻译引擎，等于让它读一段被打碎的文字 —— 句子边界错、单词被拆成两半，
     译文会跟着乱。所以翻译前先 U.reflow 把它拼回正常的段落。
     这一步只影响「送进去翻什么」，不动摘录本身存的原文。 */
  function runTranslate() {
    const info = state.pendingSelection;
    if (!info || !String(info.text || '').trim()) { U.toast('先选中一段文字', '', 2000); return; }
    const raw = String(info.text).trim();
    const text = U.reflow(raw);
    state.tr = { text, raw, target: Translator.guessTarget(text), result: null, busy: false };
    const panel = $('#trPanel');
    if (!panel) return;
    panel.hidden = false;
    $('#trSrc').textContent = U.truncate(text, 220);
    $('#trMeta').textContent = '';
    $('#trNote').textContent = '';
    const cfg = $('#trCfg');
    if (cfg) cfg.hidden = true;
    setTrBusy(true);
    updateTrLangBtn();
    positionTrPanel();
    Esc.push('tr', hideTr);
    renderTrChannels(null);   // 先把「哪条能用」摆出来，别让人干等结果
    doTranslate();
  }

  function updateTrLangBtn() {
    const b = $('#btnTrLang');
    if (!b || !state.tr) return;
    b.textContent = state.tr.target === 'en' ? 'EN' : '中';
    b.title = '目标语言：' + (state.tr.target === 'en' ? '英语（点击切换为中文）' : '中文（点击切换为英文）');
  }

  function positionTrPanel() {
    const panel = $('#trPanel');
    const tb = $('#selToolbar');
    if (!panel) return;
    const pr = panel.getBoundingClientRect();
    const base = tb && !tb.hidden ? tb.getBoundingClientRect() : { left: window.innerWidth / 2, top: 120, bottom: 150 };
    const left = U.clamp(base.left, 12, window.innerWidth - pr.width - 12);
    let top = base.bottom + 8;
    if (top + pr.height > window.innerHeight - 12) top = Math.max(12, base.top - pr.height - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  /* 翻译没完成之前，复制 / 存入笔记都不可点（2.6） */
  function setTrBusy(busy) {
    const copy = $('#btnTrCopy');
    const save = $('#btnTrSave');
    if (copy) copy.disabled = !!busy;
    if (save) save.disabled = !!busy;
  }

  /* ---------- 翻译渠道状态条（3.9.3）----------
     划词 / 摘录翻译时最常被问的两件事：「这次到底是谁翻的」「本地模型能不能用」。
     这里把候选渠道全列出来：能用的点亮，已经在显存里的本地模型加实心点，
     这次实际用的那条打「本次」。点一下本地模型那格可以试着把它拉起来。 */
  async function renderTrChannels(activeId) {
    const box = $('#trCh');
    if (!box) return;
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    if (!T || !T.channels) { box.hidden = true; return; }
    let snap = null;
    try { snap = await T.channels(); } catch (e) { snap = null; }
    if (!snap || !snap.list || !snap.list.length) { box.hidden = true; return; }

    /* 打开面板时还没有结果，先把「哪条能用」画出来；翻完再带 provider 重画一次 */
    const used = activeId || (state.tr && state.tr.result && state.tr.result.provider) || '';
    const chips = snap.list.map((c) => {
      const on = !!used && (used === c.id || (c.id === 'google' && used.indexOf('google') === 0));
      const cls = ['ch-chip'];
      if (!c.ok) cls.push('off');
      else if (c.hot) cls.push('hot');
      if (c.failed) cls.push('stale');
      if (on) cls.push('used');
      const tip = c.label + ' · ' + c.detail
        + (c.lastMs ? ' · 上次 ' + c.lastMs + 'ms' : '')
        + (c.lastErr ? ' · 上次失败（' + c.lastErr + '）' : '')
        + (!c.ok && c.id === 'local' ? ' · 点一下试着启动' : '');
      return '<button class="' + cls.join(' ') + '" data-ch="' + U.escapeHtml(c.id) + '" title="'
        + U.escapeHtml(tip) + '"><i></i>' + U.escapeHtml(c.label)
        + (on ? '<em>本次</em>' : '') + '</button>';
    }).join('');

    box.hidden = false;
    box.innerHTML = '<span class="tr-ch-lb">渠道</span>' + chips;
  }

  /* 划词翻译的上下文（v3.12）
     「dissection」单拎出来是「解剖」，放在血管外科的句子里是「夹层」；
     通用引擎只会给最常见的那一个。取选区所在文字层的前后文交给本地模型，
     由它在语境里选 —— 在线接口没有这个能力，所以只有本地模型吃得到。
     取 480 字左右：够消歧，又不至于把 7b 模型的注意力拖散。 */
  function contextAround(txt, layer, pad) {
    if (!layer) return '';
    const all = String(layer.textContent || '').replace(/\s+/g, ' ');
    /* 同样压掉空白再比对：正文里一个换行就能让 indexOf 落空 */
    const probe = String(txt || '').replace(/\s+/g, ' ').slice(0, 24);
    const at = probe ? all.indexOf(probe) : -1;
    if (at < 0) return all.slice(0, (pad || 240) * 2);
    return all.slice(Math.max(0, at - (pad || 240)), at + String(txt || '').length + (pad || 240)).trim();
  }

  function selectionContext(txt) {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return '';
      const n = sel.getRangeAt(0).startContainer;
      const el = n && n.nodeType === 1 ? n : (n && n.parentElement);
      const layer = el && el.closest ? el.closest('.textLayer') : null;
      return contextAround(txt, layer);
    } catch (e) { return ''; }
  }

  function pageContext(pageNum, txt) {
    try {
      const el = viewer && viewer.pageEls[Number(pageNum) - 1];
      const layer = el && el.querySelector('.textLayer');
      return contextAround(txt, layer);
    } catch (e) { return ''; }
  }

  async function doTranslate() {
    if (!state.tr) return;
    const tr = state.tr;
    const out = $('#trOut');
    const meta = $('#trMeta');
    if (out) out.innerHTML = '<span class="tr-loading">正在翻译…</span>';
    if (meta) meta.textContent = '';
    tr.busy = true;
    tr.result = null;
    setTrBusy(true);
    const ctx = tr.context || selectionContext(tr.text);
    tr.context = ctx;
    const res = await Translator.translate(tr.text, { target: tr.target, context: ctx });
    if (state.tr !== tr) return;
    tr.busy = false;
    if (!res.ok) {
      if (out) {
        out.innerHTML = '<span class="tr-err">' + U.escapeHtml(res.error || '翻译失败') + '</span>'
          + (res.hint ? '<div class="tr-hint">' + U.escapeHtml(res.hint) + '</div>' : '');
      }
      if (meta) meta.textContent = '不可用';
      setTrBusy(true);
      const note = $('#trNote');
      if (note) note.textContent = '可点 ⚙ 配置本地模型（Ollama）后重试';
      renderTrChannels(null);      // 失败原因已经记进各通道，重画一次让「哪条挂了」可见
      return;
    }
    tr.result = res;
    if (out) out.textContent = res.text;
    if (meta) {
      meta.textContent = (res.src ? res.src + ' → ' : '') + res.target
        + ' · ' + Translator.providerLabel(res.provider)
        + (res.cached ? ' · 缓存' : (res.ms ? ' · ' + res.ms + 'ms' : ''));
    }
    setTrBusy(false);
    const note = $('#trNote');
    if (note) note.textContent = '';
    renderTrChannels(res.provider);
  }

  function switchTrLang() {
    if (!state.tr) return;
    state.tr.target = state.tr.target === 'en' ? 'zh-CN' : 'en';
    updateTrLangBtn();
    doTranslate();
  }

  function hideTr() {
    const panel = $('#trPanel');
    if (panel) panel.hidden = true;
    state.tr = null;
    Esc.remove('tr');
  }

  /* 2.5：复制译文不关框；存入笔记才关 */
  async function copyTranslation() {
    if (!state.tr || !state.tr.result) { U.toast('还没有译文'); return; }
    const ok = await U.copyText(state.tr.result.text);
    const note = $('#trNote');
    if (note) note.textContent = ok ? '已复制译文（面板不关闭）' : '复制失败';
    U.toast(ok ? '译文已复制' : '复制失败', ok ? 'ok' : 'err', 1400);
  }

  /* 翻译设置面板（本地模型 / 术语表）开合与回填 */
  function toggleTrCfg() {
    const box = $('#trCfg');
    if (!box) return;
    const willShow = box.hidden;
    box.hidden = !willShow;
    if (willShow) {
      const local = (typeof Translator !== 'undefined' && Translator.getLocal()) || { url: '', model: '' };
      const lu = $('#trCfgLocalUrl');
      const lm = $('#trCfgLocalModel');
      const le = $('#trCfgLocalExe');
      if (lu) lu.value = local.url || 'http://127.0.0.1:11434';
      if (lm) lm.value = local.model || '';
      if (le) le.value = local.exe || '';
      const gl = $('#trGloss');
      if (gl && typeof Translator !== 'undefined' && Translator.getGlossary) {
        try {
          gl.value = Translator.getGlossary().map((g) => g.from + ' = ' + g.to).join('\n');
        } catch (e) { /* ignore */ }
      }
      /* 顺手探一下本地模型在不在，省得用户猜 */
      if (typeof Translator !== 'undefined' && Translator.probeLocal) {
        Translator.probeLocal(true, true).then((ok) => {
          /* ok 现在表示「服务可达」，模型列表可能是空的（刚装好还没 pull）——
             这种情况下没有模型名可回填，别硬塞一个空字符串给用户看 */
          if (!ok || !ok.model) return;
          const n = (ok.models || []).length;
          const more = n > 1 ? '（本机共 ' + n + ' 个）' : '';
          const cur = lm ? lm.value.trim() : '';
          if (lm && !cur) {
            /* 装了 Ollama 但没填过模型名：直接回填，用户只要点保存 */
            lm.value = ok.model;
            U.toast('检测到本地模型 ' + ok.model + more + '，已自动填入', 'ok', 2600);
          } else if (cur && !(ok.models || []).includes(cur)) {
            U.toast('本机没有 ' + cur + '，可用：' + ok.model + more, 'warn', 3000);
          } else if (cur) {
            U.toast('本地模型就绪：' + cur + more, 'ok', 1800);
          }
        }).catch(() => {});
      }
      if (lm) lm.focus();
    }
  }

  function saveTrCfg() {
    const lu = $('#trCfgLocalUrl');
    const lm = $('#trCfgLocalModel');
    const le = $('#trCfgLocalExe');
    const model = lm ? lm.value.trim() : '';
    const url = lu ? lu.value.trim() : '';
    const exe = le ? le.value.trim() : '';

    /* 模型名可以留空（探测时自动回填），地址可以留默认 ——
       所以「要不要保存本地配置」不能只看 model：只填了 exe 也要存下来，
       否则免安装版用户填了路径、一保存又被清掉，等于白填。 */
    if (model || exe || (url && url !== 'http://127.0.0.1:11434')) {
      Translator.setLocal({ url: url || 'http://127.0.0.1:11434', model, exe });
    } else {
      Translator.setLocal(null);
    }
    /* 术语表一动，缓存的译文就不作数了（缓存键里带术语表指纹），不用手动清 */
    const gEl = $('#trGloss');
    let gN = 0;
    if (gEl && typeof Translator !== 'undefined' && Translator.setGlossary) {
      try { gN = Translator.setGlossary(gEl.value).length; } catch (e) { gN = 0; }
    }

    const parts = [];
    if (gN) parts.push('术语 ' + gN + ' 条');
    if (model) parts.push('本地模型 ' + model);
    U.toast(parts.length ? '已保存：' + parts.join(' + ') + '，正在重新翻译' : '已清除翻译配置', 'ok', 1800);

    const box = $('#trCfg');
    if (box) box.hidden = true;
    /* 保存的是本地模型配置（地址 / 模型 / exe）：立刻按新配置拉一次服务，
       不然用户改完路径还得等下一次开文档才生效。 */
    if (model || exe) setTimeout(() => { try { bootLocalAi(); } catch (e) { /* ignore */ } }, 300);
    if (state.tr) doTranslate();
  }

  /* ==================== 本地增强向导 ====================
     上架版绕不开的现实：模型 10 GB 级别，打不进 4.9 MB 的插件包，只能让用户自己装。
     那就把「缺什么、怎么补」直接写在右栏，而不是等用户点了 OCR 才弹一句红字，
     更不应该在文案里写开发者本机的路径 —— 别人机器上没有那个文件。
     三条原则：
       1. 透明 —— 翻译不需要本地模型，界面上要说明白，别让人以为插件坏了；
       2. 可达 —— 下载链接、可复制的命令、重新检测按钮，全在同一处；
       3. 不打扰 —— 只占一行，展开才看详情。

     3.9.3 起这一行**常驻**，不再「就绪就整条收起」：用户要知道的是
     「OCR 现在能不能用、视觉模型是加载着还是已经关掉了」，
     而模型什么时候被卸出显存，光看「就绪」两个字是看不出来的。 */
  const envState = {
    serve: false, vision: '', models: [], youdao: false, at: 0, starting: false,
    /* finding：正在本机查找 ollama.exe（扫盘那几秒要说一声，别让人以为卡住了）
       found：找到的路径，用来把「解压即用版」也自动填进输入框 */
    finding: false, found: '',
    /* 运行时（显存）状态：hot = 正在显存里的视觉模型，hotTrans = 对话模型 */
    hot: '', hotTrans: '', vram: 0, until: '', rtAt: 0
  };
  let envBusy = false;
  let rtBusy = false;
  /* /api/ps 连续问不到几次才认定「服务挂了」：
     本地回环上偶尔一次 1.2s 超时不代表服务没了，一次就降级会让右栏闪红。 */
  let rtFails = 0;

  /* 只读 /api/ps：谁在显存里、占多少、什么时候到期。
     不动 /api/tags（那是 checkEnv 的活），也不发推理请求 —— 状态刷新要是把
     模型顶热，keep_alive 永远到不了点，显存放不出去。 */
  async function refreshRuntime() {
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    if (!T || !T.psInfo || rtBusy) return envState;
    rtBusy = true;
    try {
      const ps = await T.psInfo();
      if (!ps.queried) {
        /* 连 /api/ps 都问不到：服务多半已经不在了。降级掉「OCR 就绪」，
           别让人以为还能用、点下去才撞报错。 */
        rtFails++;
        if (rtFails >= 2) {
          envState.serve = false;
          envState.hot = '';
          envState.hotTrans = '';
          envState.vram = 0;
          envState.until = '';
          envState.rtAt = Date.now();
        }
      } else {
        rtFails = 0;
        envState.hot = ps.vision || '';
        envState.hotTrans = ps.chat || '';
        envState.vram = (ps.models || []).reduce((s, m) => s + (m.vram || 0), 0);
        const v = (ps.models || []).filter((m) => m.name === envState.hot)[0];
        envState.until = (v && v.until) || '';
        envState.rtAt = Date.now();
      }
    } catch (e) { /* 保留上一次的结果，别把界面刷成空白 */ }
    rtBusy = false;
    renderEnvBar();
    return envState;
  }

  /* ==================== 首次启动环境检查（v3.16） ====================
     分享给别人 / 上架插件库：装完插件第一次打开，把「还缺什么」一次说清。
     三种处理方式，按「能不能在插件内解决」分：
       · 能下载的（识别引擎、语音模型、精修模型）→ 插件内直接下（带进度）
       · 要装本体的（Ollama）→ 打开官方下载页，装完点「重新检测」
       · 本体已装、只缺模型的（视觉模型）→ 代跑 ollama pull，不用开终端
     「稍后再说」= 不再自动弹；翻译设置里留了「环境检查」入口随时重开。 */
  const LS_ONBOARD = 'eaglenote:onboard';
  let onboardOpen = false;
  let onboardRows = null;

  function onboardSeen() {
    try { return localStorage.getItem(LS_ONBOARD) === '1'; } catch (e) { return true; }
  }
  function setOnboardSeen() {
    try { localStorage.setItem(LS_ONBOARD, '1'); } catch (e) { /* ignore */ }
  }

  async function buildOnboardRows() {
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    const A = (typeof Asr !== 'undefined') ? Asr : null;
    const st = (A && A.probe) ? A.probe() : { engine: 'none', model: 'none' };
    let refine = { ready: false };
    try { if (A && A.refineProbe) refine = A.refineProbe(); } catch (e) { /* ignore */ }
    await checkEnv(true);
    const rows = [];

    const downloadAsr = async (row) => {
      row.busy = true;
      row.stat = '正在下载…';
      renderOnboard();
      const ok = await A.prepare({
        onProgress: (p) => {
          row.stat = p && p.name ? (p.name + ' ' + Math.round((p.loaded || 0) / 1048576) + ' / '
            + Math.round((p.total || 0) / 1048576) + ' MB') : '正在下载…';
          renderOnboard();
        }
      });
      row.busy = false;
      row.stat = ok ? '装好了' : ('下载失败：' + ((A.status().error) || '网络问题'));
      const nst = A.probe();
      row.state = (nst.engine === 'ready' && nst.model === 'ready') ? 'ok' : 'missing';
      renderOnboard();
    };
    const downloadRefine = async (row) => {
      row.busy = true;
      row.stat = '正在下载…';
      renderOnboard();
      try {
        await A.ensureRefine((p) => {
          row.stat = p && p.name ? (p.name + ' ' + Math.round((p.loaded || 0) / 1048576) + ' / '
            + Math.round((p.total || 0) / 1048576) + ' MB') : '正在下载…';
          renderOnboard();
        });
        row.state = 'ok';
        row.stat = '装好了';
      } catch (e) {
        row.stat = '下载失败：' + ((e && e.message) || e);
      }
      row.busy = false;
      renderOnboard();
    };
    const pullVision = async (row) => {
      if (!T) return;
      row.busy = true;
      row.stat = '正在连接 Ollama…';
      renderOnboard();
      const up = await T.ensureServe({ toast: false });
      if (!up) {
        row.busy = false;
        row.stat = 'Ollama 没在运行 —— 先把上面 Ollama 那步做完';
        renderOnboard();
        return;
      }
      const model = T.VISION_SUGGEST || 'qwen2.5vl:7b';
      row.stat = 'ollama pull ' + model + '（几个 GB，视网速而定）';
      renderOnboard();
      const ok = await T.pullModel(model, (line) => {
        /* pull 的进度行长这样："pulling manifest"、"65%" —— 只留最新的 */
        row.stat = (line.length > 60 ? line.slice(-60) : line);
        renderOnboard();
      });
      row.busy = false;
      if (ok) {
        row.state = 'ok';
        row.stat = '装好了';
      } else {
        row.stat = '拉取没成功 —— 终端里跑 ollama pull ' + model + ' 也行';
      }
      renderOnboard();
    };

    rows.push({
      key: 'asr', title: '语音识别（字幕 / 语音输入）',
      desc: (st.engine === 'ready' && st.model === 'ready') ? '引擎与模型已就绪'
        : '识别引擎 + 中英双语模型，约 210 MB，插件内直接下',
      state: (st.engine === 'ready' && st.model === 'ready') ? 'ok' : 'missing',
      run: (A && A.prepare) ? downloadAsr : null
    });
    rows.push({
      key: 'refine', title: '字幕精修模型（可选）',
      desc: refine.ready ? '已就绪 —— 每句字幕自动重听一遍，带标点'
        : '约 239 MB，非必装：没有它字幕也能用，只是没标点、稍差一点',
      state: refine.ready ? 'ok' : 'opt',
      run: (A && A.ensureRefine) ? downloadRefine : null
    });
    rows.push({
      key: 'ollama', title: 'Ollama（本地大模型底座）',
      desc: envState.serve ? '已安装并在运行'
        : 'OCR 和离线翻译靠它。到 ollama.com/download 下载安装（约 1 GB），装完回来点「重新检测」',
      state: envState.serve ? 'ok' : 'missing',
      run: (!envState.serve && T && Bridge && Bridge.openExternal) ? (async (row) => {
        Bridge.openExternal(T.OLLAMA_SITE || 'https://ollama.com/download');
      }) : null
    });
    rows.push({
      key: 'vision', title: 'OCR 视觉模型',
      desc: envState.vision ? ('已就绪：' + envState.vision)
        : (envState.serve ? ('缺模型。点「自动拉取」我替你跑 ollama pull ' + (T ? T.VISION_SUGGEST : 'qwen2.5vl:7b')
          + '（约 6 GB，也可以自己在终端跑同样的命令）')
          : '先装好 Ollama 再装它'),
      state: envState.vision ? 'ok' : (envState.serve ? 'missing' : 'wait'),
      run: (!envState.vision && envState.serve && T && T.pullModel) ? pullVision : null
    });
    return rows;
  }

  function renderOnboard() {
    if (!onboardRows) return;
    const box = $('#onboardList');
    if (!box) return;
    box.innerHTML = '';
    let okCount = 0;
    let actCount = 0;
    onboardRows.forEach((row) => {
      if (row.state === 'ok') okCount++;
      if (row.state !== 'ok' && row.state !== 'opt') actCount++;
      const el = U.el('div', 'onboard-row st-' + row.state + (row.busy ? ' busy' : ''));
      const ico = U.el('span', 'on-ico', row.state === 'ok' ? '✓' : (row.state === 'opt' ? '·' : '!'));
      el.appendChild(ico);
      const main = U.el('div', 'on-main');
      main.appendChild(U.el('div', 'on-title', row.title));
      main.appendChild(U.el('div', 'on-desc', row.stat || row.desc));
      el.appendChild(main);
      if (row.busy) {
        el.appendChild(U.el('span', 'on-dot'));
      } else if (row.state !== 'ok' && row.run) {
        const b = U.el('button', 'ec-btn on-act', row.state === 'opt' ? '下载' : '处理');
        b.addEventListener('click', () => { row.run(row); });
        el.appendChild(b);
      }
      box.appendChild(el);
    });
    /* 头部摘要：一眼看出「还差几步」；全齐时给一句收尾话 */
    const sum = $('#onboardSum');
    if (sum) {
      if (actCount === 0) {
        sum.textContent = okCount + ' / ' + onboardRows.length + ' 项就绪，环境没有缺口。';
        sum.classList.add('all-ok');
        sum.hidden = false;
      } else {
        sum.textContent = '还差 ' + actCount + ' 步：';
        sum.classList.remove('all-ok');
        sum.hidden = false;
      }
    }
  }

  async function openOnboard() {
    onboardOpen = true;
    const ov = $('#onboardOverlay');
    if (ov) ov.hidden = false;
    onboardRows = await buildOnboardRows();
    renderOnboard();
  }
  function closeOnboard(mark) {
    onboardOpen = false;
    const ov = $('#onboardOverlay');
    if (ov) ov.hidden = true;
    if (mark) setOnboardSeen();
  }

  /* boot 尾部调一次：全齐或用户已经说「稍后再说」就不弹。
     延迟 1.2 秒 —— 别跟首屏渲染抢主线程，也别让人以为是弹窗广告。 */
  async function maybeOnboard() {
    if (onboardSeen() || onboardOpen) return;
    await new Promise((r) => setTimeout(r, 1200));
    if (onboardSeen()) return;
    const rows = await buildOnboardRows();
    const blocking = rows.some((r) => r.state === 'missing');
    if (!blocking) { setOnboardSeen(); return; }
    openOnboard();
  }

  function bindOnboard() {
    on('#btnOnboardDone', 'click', () => closeOnboard(true));
    on('#btnOnboardSkip', 'click', () => closeOnboard(true));
    on('#btnOnboardRecheck', 'click', async () => {
      onboardRows = await buildOnboardRows();
      renderOnboard();
    });
    on('#btnOnboardOpen', 'click', () => openOnboard());
  }

  /* 显存状态是会自己变的（模型闲置 5 分钟就被卸载，也可能被别的程序挤掉）。
     每 20 秒重读一次 /api/ps 只做界面刷新 —— 只读，不发推理请求，
     否则模型永远闲不下来，keep_alive 到点也放不掉。窗口藏起来时不刷。 */
  function ensureRtTimer() {
    if (state.rtTimer) return state.rtTimer;
    state.rtTimer = setInterval(function () {
      try {
        if (document.hidden) return;
        if (!envState.serve && !envState.starting) return;
        refreshRuntime();
      } catch (e) { /* ignore */ }
    }, 20000);
    return state.rtTimer;
  }

  function envOpenPref() {
    try { return localStorage.getItem('eaglenote:envopen') === '1'; } catch (e) { return false; }
  }
  function setEnvOpenPref(v) {
    try { localStorage.setItem('eaglenote:envopen', v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* force=true 才绕过 30 秒探测缓存：用户刚装完点「检测」，必须真去问一次。
     自己维护时间戳是因为 probeLocal 失败时不写缓存 —— 没装 Ollama 的机器
     每次开文档都会真去连一次（1.5s 超时），没必要。 */
  async function checkEnv(force) {
    if (envBusy) return envState;
    if (!force && envState.at && Date.now() - envState.at < 30000) return envState;
    envBusy = true;
    try {
      const T = (typeof Translator !== 'undefined') ? Translator : null;
      if (!T) return envState;
      const cfg = await T.probeLocal(!!force, true);
      envState.serve = !!cfg;
      envState.models = (cfg && cfg.models) || [];
      envState.vision = '';
      if (cfg) {
        try { envState.vision = await T.pickVisionModel(cfg); } catch (e) { envState.vision = ''; }
      }
      envState.at = Date.now();
      /* 探测成功顺手回填模型名：用户不用在设置里手打 qwen2.5vl:7b。
         ⚠ setLocal 是全量写入，exe 必须一起带上 —— 少传一个字段就会把
         「免安装版的 ollama.exe 路径」悄悄抹掉，用户填了也白填。 */
      if (cfg && cfg.model && T.getLocal && !(T.getLocal().model || '').trim()) {
        const cur = T.getLocal();
        T.setLocal({ url: cur.url, model: cfg.model, exe: cur.exe });
      }
    } catch (e) { /* 探测失败就当没有，界面照常可用 */ }
    envBusy = false;
    /* checkEnv 只回答「装没装、有没有视觉模型」；「模型此刻在不在显存」
       得看 /api/ps，顺手补上，右栏那一行才是完整状态。 */
    await refreshRuntime();
    renderEnvBar();
    return envState;
  }

  function fmtVram(n) {
    if (!n) return '';
    const gb = n / 1073741824;
    return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB';
  }

  /* expires_at 是 Ollama 给的绝对时间，换算成「还有几分钟」才看得懂 */
  function minsLeft(iso) {
    const t = Date.parse(iso || '');
    if (!t) return 0;
    return Math.max(0, Math.round((t - Date.now()) / 60000));
  }

  function renderEnvBar() {
    const bar = $('#envBar');
    if (!bar) return;

    /* 3.9.3：这条现在是常驻的。以前「就绪就整条收起」，结果用户看不到
       OCR 到底能不能用、模型是加载着还是已经被卸出显存了。 */
    bar.hidden = false;

    const T = (typeof Translator !== 'undefined') ? Translator : null;
    const big = (T && T.VISION_SUGGEST) || 'qwen2.5vl:7b';
    const sum = $('#envSum');
    const lead = $('#envLead');
    const detail = $('#envDetail');
    const cmd = $('#envPullCmd');
    const dot = $('#envDot');
    const ready = !!(envState.serve && envState.vision);
    const hot = !!envState.hot;

    let tone = 'err';
    let sumTxt = '';
    let detTxt = '';
    if (envState.finding) {
      tone = 'wait';
      sumTxt = '正在本机查找 Ollama…';
      if (lead) lead.textContent = '查 PATH、正在运行的进程、安装记录，再按预算扫一遍常见目录。找到就用它，不用你手填路径。';
    } else if (envState.starting && !envState.serve) {
      /* 正在后台拉服务：别在这几秒里先写「未检测到 Ollama」，用户会以为没自动跑 */
      tone = 'wait';
      sumTxt = '正在启动本地模型…';
      if (lead) lead.textContent = '正在本机找 Ollama 并把它拉起来（设置 / PATH / 运行中的进程 / 安装记录 / 常见目录）。'
        + '装好之后每次打开插件它都会自己起来，不用手动开。';
    } else if (!envState.serve) {
      sumTxt = 'OCR 不可用 · 未检测到 Ollama';
      if (lead) lead.textContent = '翻译不装也能用，会自动走在线通道。OCR 要认图片里的字，必须在本机装一次（只做一次，之后离线可用）：';
    } else if (!envState.vision) {
      tone = 'warn';
      sumTxt = 'OCR 缺视觉模型';
      if (lead) lead.textContent = '本地服务通了，但没找到能看图的模型。OCR 和视频截图识别要用到它，跑一条命令就好：';
    } else {
      tone = 'ok';
      sumTxt = 'OCR 就绪';
      /* 已加载 / 未在显存 —— 这两个状态差别很大：后者第一次识别要多等几秒 */
      detTxt = envState.vision + (hot ? ' · 已加载' : ' · 未在显存');
      if (lead) lead.textContent = '本地增强已就绪：OCR 与离线翻译都在本机跑，图片和文字不出网。';
    }
    if (sum) sum.textContent = sumTxt;
    if (detail) { detail.textContent = detTxt; detail.title = detTxt; }
    if (dot) {
      dot.classList.toggle('ok', tone === 'ok');
      dot.classList.toggle('warn', tone === 'warn');
      dot.classList.toggle('err', tone === 'err');
    }
    if (cmd) cmd.textContent = 'ollama pull ' + big;

    /* 显存里现在有什么、还剩多久到期。想立刻收回显存就点「释放」，
       不用等 keep_alive 到点，也不用关插件。 */
    const vram = $('#envVram');
    const vsum = $('#envVramSum');
    if (vram) {
      if (hot) {
        vram.hidden = false;
        if (vsum) {
          const parts = [];
          if (envState.vram) parts.push('显存占用 ' + fmtVram(envState.vram));
          parts.push(envState.hot);
          const left = minsLeft(envState.until);
          if (left) parts.push('约 ' + left + ' 分钟后释放');
          vsum.textContent = parts.join(' · ');
        }
      } else {
        vram.hidden = true;
      }
    }

    $$('#envSteps li').forEach((li) => {
      const k = li.dataset.step;
      const done = (k === 'serve' && envState.serve) || (k === 'model' && !!envState.vision);
      li.classList.toggle('done', !!done);
    });

    /* 实在找不到（绿色版 / 装在奇怪的目录）时，给两条路：
       一条是「自动查找」—— 让插件自己在本机扫一遍，找到就直接用；
       一条是手填路径。默认给前者，手填只当后备。 */
    const findRow = $('#envFindRow');
    const exeRow = $('#envExeRow');
    const exeInput = $('#envExePath');
    const findBtn = $('#btnEnvFind');
    if (findRow) findRow.hidden = !!envState.serve;
    if (exeRow) exeRow.hidden = !!envState.serve;
    if (findBtn) {
      findBtn.disabled = !!envState.finding || (!!envState.starting && !envState.serve);
      findBtn.textContent = envState.finding ? '查找中…' : '自动查找';
    }
    if (exeInput && document.activeElement !== exeInput) {
      const cur = (T && T.getLocal) ? T.getLocal().exe : '';
      const known = cur || (T && T.exeHint ? T.exeHint() : '');
      if (known && !exeInput.value) exeInput.value = known;
    }

    const open = envOpenPref();
    const body = $('#envBody');
    if (body) body.hidden = !open;
    const tg = $('#btnEnvToggle');
    if (tg) tg.textContent = open ? '收起' : (ready ? '详情' : '设置');
  }

  /* 启动本地模型：探活 → 起服务 → 预热 → 刷新右栏。
     全程静默 —— 找不到 ollama.exe（没装 / 免安装版没指路）就安静失败，
     右栏的引导条自己会说明缺什么；失败后 30 秒内不再重试，不会反复拉进程。 */
  let localAiBusy = false;

  async function bootLocalAi(opts) {
    if (localAiBusy) return envState.serve;
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    if (!T || !T.ensureServe) return false;
    localAiBusy = true;
    if (!envState.serve && !envState.starting) { envState.starting = true; renderEnvBar(); }
    const o = opts || {};
    try {
      /* auto：开机流程自己找的，24 小时内扫过且没扫到就不重复扫盘；
         用户亲手点的（带 toast）不受这个限制。 */
      await T.ensureServe({ auto: !o.toast, budget: o.budget });
      /* checkEnv 有并发保护：另一次探测正在跑就直接返回旧状态，
         刚拉起来的服务就反映不到界面上。等它结束再问一次。 */
      if (envBusy) await new Promise((r) => setTimeout(r, 400));
      await checkEnv(true);
      if (envState.serve && envState.vision && T.warmup) {
        try { await T.warmup(); } catch (e) { /* 预热失败不影响功能 */ }
      }
      if (o.toast) {
        if (!envState.serve) U.toast('没找到本机的 ollama.exe —— 可能确实还没装。装好后点「检测」，或用「自动查找」再扫一遍', 'err', 4600);
        else if (!envState.vision) U.toast('Ollama 已在运行，还差视觉模型（第 2 步）', '', 3600);
        else U.toast('本地模型已就绪：' + envState.vision, 'ok', 2600);
      }
      return envState.serve;
    } catch (e) {
      return false;
    } finally {
      envState.starting = false;
      localAiBusy = false;
      renderEnvBar();
    }
  }

  /* 「自动查找」：让插件自己在本机把 ollama.exe 找出来。
     路径、PATH、运行中的进程、安装记录、常见目录全走一遍，找到就记住并立刻用它启动 ——
     用户一次都不用打字。找不到才提示去装（这才是「确实没有」该有的说法）。 */
  async function findEnvExe() {
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    if (!T || !T.findOllamaExe || envState.finding) return;
    envState.finding = true;
    renderEnvBar();
    let hit = null;
    try {
      if (T.resetServeHint) T.resetServeHint();   // 手动查找：清掉冷却与「扫过没找到」的记忆
      hit = await T.findOllamaExe({ budget: 9000 });
    } catch (e) { hit = null; }
    envState.finding = false;
    if (!hit) {
      envState.found = '';
      renderEnvBar();
      U.toast('本机没找到 ollama.exe —— 大概率还没装，点上面第 1 步的「下载」', 'err', 4600);
      return;
    }
    envState.found = hit.path;
    const input = $('#envExePath');
    if (input) input.value = hit.path;
    U.toast('找到了（' + hit.source + '）：' + hit.path, 'ok', 3800);
    await bootLocalAi({ toast: true });
  }

  /* 手填 ollama.exe 路径后立刻用它启动：免安装版的唯一出路 */
  async function saveEnvExe() {
    const input = $('#envExePath');
    const btn = $('#btnEnvExeSave');
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    if (!T || !T.setLocal) return;
    const exe = input ? String(input.value || '').trim() : '';
    if (!exe) { U.toast('先填 ollama.exe 的完整路径，例如 D:\\ollama\\ollama.exe', '', 3200); return; }
    const cur = T.getLocal();
    T.setLocal({ url: cur.url, model: cur.model, exe });   // setLocal 会顺手清掉节流
    if (btn) { btn.disabled = true; btn.textContent = '启动中'; }
    const ok = await bootLocalAi({ toast: true });
    if (btn) { btn.disabled = false; btn.textContent = '用它启动'; }
    if (!ok && input) input.focus();
  }

  async function redetectEnv() {
    const btn = $('#btnEnvRedetect');
    if (btn) { btn.disabled = true; btn.textContent = '检测中'; }
    const T = (typeof Translator !== 'undefined') ? Translator : null;
    /* 用户亲手点「检测」= 明确要我再拉一次：把失败后的 30 秒冷却清掉，
       否则刚装好 / 刚填完路径的人会在这里干等半分钟才看到变化。 */
    if (T && T.resetServeHint) T.resetServeHint();
    if (T && T.ensureServe) { try { await T.ensureServe({ auto: false }); } catch (e) { /* ignore */ } }
    await checkEnv(true);
    if (btn) { btn.disabled = false; btn.textContent = '检测'; }
    if (envState.serve && envState.vision) {
      U.toast('本地增强已就绪：' + envState.vision, 'ok', 2800);
      /* 就绪后 2 秒把面板合上，让位给摘录列表 */
      setTimeout(() => { setEnvOpenPref(false); renderEnvBar(); }, 2000);
    } else if (envState.serve) {
      U.toast('Ollama 通了，但还没找到视觉模型，第 2 步做完再点一次', '', 3200);
    } else {
      U.toast('还是连不上 Ollama：确认它已装好；如果你用的是解压即用的版本，在下面填 ollama.exe 路径', 'err', 4200);
    }
  }

  /* 「存入笔记」：确保这段文字已经有摘录，再把译文写进它的笔记 */
  async function saveTranslation() {
    if (!state.tr || !state.tr.result) return;
    if (!state.data) { U.toast('请先打开一个 PDF', 'err'); return; }
    const tr = state.tr;
    const note = $('#trNote');
    if (note) note.textContent = '保存中…';

    let ann = null;
    if (state.lastExcerptId) {
      ann = state.data.annotations.find((a) => a.id === state.lastExcerptId);
      if (ann && ann.text && U.normalizeText(ann.text) !== U.normalizeText(tr.text)) ann = null;
    }
    if (!ann && state.pendingSelection) {
      const created = createHighlights(state.pendingSelection, state.currentColor);
      ann = created[created.length - 1] || null;
    }
    if (!ann) {
      // 选区已经没了：退化成一条独立笔记，原文作为引用
      state.data.notes = state.data.notes || [];
      const n = {
        id: U.uid('nt'),
        md: '**译文**\n\n' + tr.result.text,
        quote: tr.text,
        page: null,
        annId: null,
        image: '',
        attachments: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      state.data.notes.push(n);
      persist();
      renderNotes();
      syncLater();
      if (note) note.textContent = '已存为独立笔记';
      U.toast('译文已存入笔记', 'ok', 1600);
      hideTr();                       // 2.5：存入笔记后关闭翻译框
      return;
    }

    const block = '**译文**\n\n' + tr.result.text;
    const next = ann.note && ann.note.trim() ? (ann.note.trim() + '\n\n' + block) : block;
    updateAnnotation(ann, { note: next });
    syncLater();
    if (note) note.textContent = '已存入这条摘录的笔记';
    U.toast('译文已存入笔记', 'ok', 1600);
    hideTr();                         // 2.5：存入笔记后关闭翻译框
  }

  /* ==================== 把高亮写进 PDF 文件（v3.3） ====================
     触发点：新增 / 修改 / 删除高亮。删除不需要特殊处理 —— 同步是「先清掉所有带
     我们指纹的注释，再按当前数据重写」，所以插件里删了，文件里自然就没了。 */
  const pdfSyncDebounced = U.debounce(() => { syncPdfFile(); }, 900);

  function docStorageKey() {
    if (!state.item) return null;
    return Store.docKey({
      itemId: state.item.id,
      filePath: state.item.filePath,
      name: state.item.name
    });
  }

  function highlightSig() {
    const list = (state.data && state.data.annotations) ? state.data.annotations : [];
    return list
      .filter((a) => a.type === 'highlight' && (a.rects || []).length)
      .map((a) => [
        a.id, a.page, a.color || '',
        (a.rects || []).map((r) => [r.x, r.y, r.w, r.h].map((v) => Number(v).toFixed(4)).join(',')).join(';'),
        String(a.note || '').length
      ].join('|'))
      .join('\n');
  }

  function schedulePdfSync() {
    if (!state.doc || state.isVideo || !state.item || !state.item.filePath) return;
    if (!PdfWrite.available()) return;
    if (state.pdfSync.reason === 'encrypted' && state.pdfSync.key === docStorageKey()) return;
    pdfSyncDebounced();
  }

  /* 外观格式版本戳。3.3.1 修了两个外观 bug（BBox 用了整页导致色块压扁成实心条、整页共用
     一个流导致颜色串页）。老文件里躺着的是错的注释，光「不写」是修不好它们的——
     打开文档时把版本戳比对一次，不一致就补一次同步，把旧注释整体改写掉。每个版本只做一次。 */
  const PDFW_STAMP = 'eaglenote:pdfw:v';

  function markPdfwVersion() {
    try { localStorage.setItem(PDFW_STAMP, String(PdfWrite.VERSION)); } catch (e) { /* ignore */ }
  }

  function maybeHealPdf() {
    if (!state.doc || state.isVideo || !state.item || !state.item.filePath) return;
    if (!PdfWrite.available()) return;
    const has = (state.data.annotations || [])
      .some((a) => a.type === 'highlight' && (a.rects || []).length);
    if (!has) return;                       // 没高亮就没什么可修的，别去动人家的文件
    let seen = null;
    try { seen = localStorage.getItem(PDFW_STAMP); } catch (e) { seen = null; }
    if (seen === String(PdfWrite.VERSION)) return;
    schedulePdfSync();
  }

  async function syncPdfFile() {
    if (!state.doc || state.isVideo || !state.item || !state.item.filePath) return;
    if (!PdfWrite.available()) return;
    const key = docStorageKey();
    if (state.pdfSync.reason === 'encrypted' && state.pdfSync.key === key) return;

    const sig = highlightSig();
    if (state.pdfSync.ok && state.pdfSync.sig === sig) return;   // 没变化就别动文件

    const items = (state.data.annotations || [])
      .filter((a) => a.type === 'highlight' && (a.rects || []).length)
      .map((a) => ({ id: a.id, page: a.page, rects: a.rects, color: a.color, note: a.note, text: a.text }));

    const proxy = state.doc.proxy;
    const token = state.loadToken;
    const geomFor = async (n) => {
      const p = await proxy.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      return { transform: vp.transform, width: vp.width, height: vp.height };
    };
    const dir = Store.getDataDir();
    const backupPath = dir ? dir + '/pdfbak/' + key + '.pdf' : null;

    const res = await PdfWrite.sync({
      filePath: state.item.filePath,
      items,
      geomFor,
      backupPath
    });
    if (token !== state.loadToken) return;    // 同步期间换了文档，结果丢掉

    if (!res.ok) {
      state.pdfSync = { sig, ok: false, count: 0, reason: res.reason, key };
      if (res.reason === 'encrypted') {
        U.toast('这个 PDF 已加密，高亮只保存在插件里（无法写入文件）', '', 3600);
      } else if (res.reason === 'no-fs' || res.reason === 'no-lib' || res.reason === 'no-path') {
        /* 浏览器调试环境或本地无路径：静默 */
      } else {
        U.toast('写入 PDF 失败：' + (res.detail || res.reason), 'err', 3800);
      }
      return;
    }
    state.pdfSync = { sig, ok: true, count: res.count, reason: null, key };
    markPdfwVersion();
    U.toast(res.count ? `已写入 PDF（${res.count} 处高亮）` : '已从 PDF 移除插件写入的高亮', 'ok', 1500);
  }

  /* ==================== 标注数据 ====================
     v3.6：所有增删改都必须走 refreshAnnotations() 这一扇门。
     以前各写各的 —— 有的只重画 PDF 标注层、有的只刷右栏、有的忘了同步 PDF 文件，
     于是出现「右栏删了高亮还在」「清空后台 PDF 里还留着」这类三处不一致。 */
  /* 笔记 → Eagle 条目的「注释」自动同步（防抖 1.2 秒，避免连写把 IPC 打满）。
     放这么靠前是为了让 refreshAnnotations 能直接调：笔记的增删改也走那扇门，
     否则「删除笔记」只刷新了界面、注释里还留着旧文字。 */
  const syncLater = U.debounce(() => { syncNotesToEagle(true); }, 1200);

  function refreshAnnotations(page) {
    if (annMgr) {
      if (page) annMgr.renderPage(page);
      else annMgr.renderVisible();
      /* v3.9.1：局部重绘只管「改动的那一页」，实测会出现色块留在别的页上
         （page 与实际 rects 所在页不一致 / 重绘撞上页面重渲染），表现为
         「右栏删了、注释也清了，PDF 上那块还亮着，得重开文档」。这里补一次对账。 */
      annMgr.sweep();
      /* v3.12：sweep 之后再来一次。删除动作会连带触发 Eagle 注释同步、PDF 文件重写，
         中间任何一步让页面重绘一帧，都可能把刚清掉的色块重新画回来（旧截图 / 旧合成层）。
         等这些异步动作落定再对一次账，成本只是一次节点遍历。 */
      setTimeout(() => {
        try { if (annMgr && state.data) annMgr.sweep(); } catch (e) { /* ignore */ }
      }, 220);
    }
    renderExcerpts();
    renderNotes();
    persist();
    schedulePdfSync();
    syncTrackMarks();
    /* 数据变了就把 Eagle 注释也重算一遍：新增 / 修改 / 删除 / 撤销，
       四条路都从这里过，注释不会再落后于插件里的内容。 */
    syncLater();
  }

  /* 从数据里摘掉，不写回收站、不记撤销 —— 供撤销 / 取消回滚等内部流程使用 */
  function detachAnn(ann) {
    if (!state.data || !ann) return -1;
    const i = state.data.annotations.indexOf(ann);
    if (i >= 0) state.data.annotations.splice(i, 1);
    if (state.activeAnnId === ann.id) {
      state.activeAnnId = null;
      if (annMgr) annMgr.setActive(null);
    }
    if (i >= 0) syncLater();      // 摘录没了，注释里对应那一段也要跟着走
    return i;
  }

  function pushAnnTrash(ann) {
    Store.pushTrash({
      id: U.uid('tr'),
      kind: 'excerpt',
      docId: state.item && state.item.id,
      docKey: Store.docKey({ itemId: state.item && state.item.id, filePath: state.item && state.item.filePath, name: state.item && state.item.name }),
      docName: state.item ? state.item.name : '',
      payload: ann
    });
  }

  function addAnnotation(partial, opts) {
    const ann = Object.assign({
      id: U.uid('an'), type: 'highlight', page: 1, color: state.currentColor,
      rects: [], point: null, text: '', note: '', image: '', translation: '',
      createdAt: Date.now(), updatedAt: Date.now()
    }, partial);
    state.data.annotations.push(ann);
    refreshAnnotations(ann.page);
    /* v3.27：摘录本身就是注释的一部分 —— 只摘不写字的条目，Eagle 注释里也要看得到。
       以前只在「保存笔记」的路径上同步，于是纯摘录永远不会进注释。 */
    if (!(opts && opts.silentSync)) syncLater();
    const o = opts || {};
    if (o.undo !== false) {
      /* 撤销「新增」= 真的删掉（不进回收站）：用户按 Ctrl+Z 的意思是「这次记录不算数」 */
      Undo.push('新增' + typeLabel(ann), () => {
        detachAnn(ann);
        refreshAnnotations(ann.page);
      }, () => {
        state.data.annotations.push(ann);
        refreshAnnotations(ann.page);
      });
    }
    if (o.scroll !== false) scrollExcerptTo(ann.id);
    return ann;
  }

  function updateAnnotation(ann, patch, opts) {
    const o = opts || {};
    const old = {};
    Object.keys(patch || {}).forEach((k) => { old[k] = ann[k]; });
    Object.assign(ann, patch, { updatedAt: Date.now() });
    refreshAnnotations(ann.page);
    syncLater();
    if (o.undo !== false) {
      Undo.push('修改' + typeLabel(ann), () => {
        Object.assign(ann, old);
        refreshAnnotations(ann.page);
      }, () => {
        Object.assign(ann, patch, { updatedAt: Date.now() });
        refreshAnnotations(ann.page);
      });
    }
  }

  /* 删除 = 进回收站（30 天内可还原） */
  function removeAnnotation(ann, silent, opts) {
    if (!ann || !state.data) return;
    const o = opts || {};
    const idx = detachAnn(ann);
    if (idx < 0) return;
    if (o.trash !== false) pushAnnTrash(ann);
    if (o.undo !== false) {
      /* 撤销删除：插回原来的位置（列表顺序稳定，用户找得到刚复原的那条） */
      Undo.push('删除' + typeLabel(ann), () => {
        state.data.annotations.splice(Math.min(idx, state.data.annotations.length), 0, ann);
        refreshAnnotations(ann.page);
        U.toast('已撤销删除', 'ok', 1500);
      }, () => {
        detachAnn(ann);
        refreshAnnotations(ann.page);
      });
    }
    refreshAnnotations(ann.page);
    if (!silent) U.toast('已移入回收站（保留 30 天）', 'ok', 1800);
    /* 这条摘录可能带着笔记，删掉就等于从注释里撤走一段文字 —— 同样立刻写 */
    syncLater.cancel();
    syncNotesToEagle(true);
  }

  function selectAnnotation(ann) {
    if (!ann) { clearSelection(); return; }
    state.activeAnnId = ann.id;
    state.activeNoteKey = null;
    $$('#notesList .note-card').forEach((el) => el.classList.remove('active'));
    annMgr.setActive(ann.id);
    highlightCard(ann.id);
    syncTrackMarks();
  }

  function clearSelection() {
    state.activeAnnId = null;
    if (annMgr) annMgr.setActive(null);
    highlightCard(null);
    syncTrackMarks();
  }

  /* ==================== 摘录列表 ==================== */
  /* 视频下按「做了什么」分类，而不是按底层 type（截图/框选/片段底层都是 area） */
  const VT_LABEL = { shot: '截图', area: '框选', clip: '片段', mark: '打点', sub: '字幕' };

  function annVt(ann) {
    if (ann.vt) return ann.vt;
    if (typeof ann.t !== 'number') return '';
    return ann.t1 != null ? 'clip' : 'shot';
  }

  function typeLabel(ann) {
    const vt = annVt(ann);
    if (vt) return VT_LABEL[vt] || '摘录';
    return AnnTypeLabel[ann.type] || '摘录';
  }

  function matchFilter(a) {
    const f = state.filter;
    if (f === 'all') return true;
    const vt = annVt(a);
    if (vt) return vt === f;
    return a.type === f;
  }

  /* 长文折叠：超过阈值就先截断，给一个「展开全文」。
     阈值按「会不会被样式截断」来定，宁可早一点给按钮，也不要截了却没法展开。 */
  function addExpandable(card, node, text, moreCls, min) {
    if (!node || !text) return;
    const s = String(text);
    const need = typeof min === 'number' ? min : 150;
    if (s.length < need && s.split('\n').length < 6) return;
    node.classList.add('is-clamped');
    const b = U.el('button', { class: 'ec-more' + (moreCls ? ' ' + moreCls : ''), 'data-act': 'expand', text: '展开全文' });
    b._target = node;
    card.appendChild(b);
  }

  /* 这条摘录有没有图（老记录存 dataURL，新记录只存路径） */
  function annHasImage(ann) {
    return !!(ann && (ann.image || ann.imagePath));
  }

  /* 卡片里的图。
     新记录只有路径：按路径读盘、缩成小图、缓存在内存里（js/imgcache.js）。
     读不到（文件被挪走/删掉）就把 <img> 摘掉，不留一个破图占位。 */
  function appendCardImage(card, ann) {
    const img = U.el('img', { class: 'ec-img' });
    img.alt = '摘录图片';
    img.draggable = false;                 // v3.28：别让它被拖进阅读区（会被当成文件拖入）
    img.setAttribute('draggable', 'false');
    card.appendChild(img);
    if (ann.image) {
      img.src = ann.image;
      fitImageSize(img, 2);
      return;
    }
    img.classList.add('ec-img-loading');
    if (typeof ImgCache === 'undefined') { img.remove(); return; }
    /* 视频整帧 / 片段封面：底边常常拖着一条纯白（录屏的进度条），
       缩略图里裁掉；另存的原图不动。 */
    const trim = ann.vt === 'shot' || ann.vt === 'clip';
    ImgCache.url(ann.imagePath, { trim: trim }).then((u) => {
      if (!img.parentNode) return;
      if (!u) { img.remove(); return; }
      img.classList.remove('ec-img-loading');
      img.src = u;
      img.title = ann.imagePath;
      fitImageSize(img, 2);
    });
  }

  /* 片段卡片：一条「▶ 00:12 → 00:35 · 23.0s」。
     v3.30 起片段不再一建就录文件，所以这里不能写「还没另存」当文件名，
     时间区间才是这条记录的本体；有文件了再把文件名补在下面一行。 */
  function appendClipFile(card, ann) {
    const box = U.el('div', { class: 'ec-clip' });
    box.appendChild(U.el('span', { class: 'ec-clip-dot', text: '●' }));
    box.appendChild(U.el('span', { text: VideoView.fmt(ann.t) + ' → ' + VideoView.fmt(ann.t1) }));
    if (typeof ann.t1 === 'number' && typeof ann.t === 'number') {
      box.appendChild(U.el('span', { class: 'ec-clip-sep', text: '·' }));
      box.appendChild(U.el('span', { text: (ann.t1 - ann.t).toFixed(1) + 's' }));
    }
    box.title = ann.filePath ? SaveAs.baseName(ann.filePath) : '还没导出成文件（点「另存为」才录）';
    card.appendChild(box);
    if (ann.filePath) {
      card.appendChild(U.el('div', { class: 'ec-clip-name', text: SaveAs.baseName(ann.filePath) }));
    }
  }

  function renderExcerpts() {
    const listEl = $('#excerptList');
    if (!listEl) return;
    if (!state.data) {
      listEl.innerHTML = '<div class="pane-empty">尚未打开文档<br>打开 PDF 后在此列出摘录</div>';
      $('#excerptCount').textContent = '0';
      return;
    }
    const all = state.data.annotations;
    $('#excerptCount').textContent = String(all.length);

    const list = all
      .filter(matchFilter)
      /* 8：新生成的在上，早期的往下排（原来按页码排，找刚摘的东西要翻半天） */
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!list.length) {
      listEl.innerHTML = '<div class="lib-empty" style="padding:24px 8px;text-align:center;color:var(--muted);font-size:12px;line-height:1.8">'
        + (all.length ? '该类型下暂无摘录' : '还没有摘录<br>拖选文字或点选图片，再点「摘录」') + '</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ann of list) {
      const c = colorOf(ann);
      const card = U.el('div', {
        class: 'excerpt-card' + (ann.id === state.activeAnnId ? ' active' : ''),
        'data-id': ann.id
      });
      card.style.setProperty('--bar', c.hl);

      const head = U.el('div', { class: 'ec-head' });
      head.appendChild(U.el('span', { class: 'ec-type', text: typeLabel(ann) }));
      head.appendChild(U.el('span', { class: 'ec-page', text: placeLabel(ann) }));
      head.appendChild(U.el('span', { class: 'ec-time', text: U.fmtTime(ann.createdAt) }));
      card.appendChild(head);

      /* 图片：老记录里是 dataURL，新记录里只有 imagePath（见 js/imgcache.js）。
         片段另有一条时间区间 —— 有预览图就都显示，图在上、区间在下。 */
      const hasImg = annHasImage(ann);
      if (hasImg) appendCardImage(card, ann);
      if (ann.vt === 'clip') appendClipFile(card, ann);

      // 2.2：锚点只是标位置，不显示「未提取到文字」这一行
      const bodyText = (hasImg || ann.vt === 'clip')
        ? (ann.text || '')                 // 图片摘录跑过 OCR 之后把文字也显示出来
        : (ann.type === 'area'
          ? (ann.text || '［页面区域］')
          : (ann.type === 'note' ? (ann.text || '') : (ann.text || '［未提取到文字］')));
      if (bodyText) {
        const textNode = U.el('div', { class: 'ec-text', text: bodyText });
        card.appendChild(textNode);
        addExpandable(card, textNode, bodyText, '');
      }
      if (ann.note) {
        const noteNode = U.el('div', { class: 'ec-note md-body', html: Markdown.render(ann.note) });
        card.appendChild(noteNode);
        addExpandable(card, noteNode, ann.note, '');
      }
      /* 译文：放在摘录正文下面、笔记上面。摘录是原文，译文是辅助，笔记是自己的想法，
         这个顺序符合「先看原文，再看译文，最后看自己写的」。 */
      if (ann.translation) {
        const trBox = U.el('div', { class: 'ec-tr' });
        trBox.appendChild(U.el('span', { class: 'ec-tr-tag', text: '译文' }));
        /* 这条译文是谁翻的：本地模型还是在线通道。摘自不同文档时靠它判断
           质量差异是不是渠道造成的（本地模型和免密钥有道的译文风格不同）。 */
        if (ann.translationVia && typeof Translator !== 'undefined') {
          const via = Translator.providerLabel(ann.translationVia);
          if (via) trBox.appendChild(U.el('span', { class: 'ec-tr-via', text: via }));
        }
        const trNode = U.el('div', { class: 'ec-tr-text', text: ann.translation });
        trBox.appendChild(trNode);
        card.appendChild(trBox);
        addExpandable(card, trNode, ann.translation, '');
      }

      const foot = U.el('div', { class: 'ec-foot' });
      const acts = [['goto', '定位'], ['writenote', '写笔记']];
      /* v3.30：素材类摘录的「拿走」——
         · 片段：预览（在视频窗口里按 A→B 播，不出文件）+ 另存为（这时才录）
         · 图片：另存原图（直接复制素材目录里的原件，不重新取帧） */
      if (ann.vt === 'clip' && typeof ann.t1 === 'number') {
        acts.push(['previewclip', '预览片段']);
        acts.push(['saveclip', ann.filePath ? '重新导出' : '另存为']);
      } else if (hasImg) {
        acts.push(['saveimg', '另存原图']);
      }
      /* 图片摘录（视频截图 / 框选 / 粘贴的图）可以就地 OCR，把画面里的文字提出来复用 */
      if (hasImg) acts.push(['ocr', ann.text ? '重新识别' : 'OCR']);
      /* 文字摘录：就地翻译 —— 读外文文献时不必再选中一次、也不用离开右栏 */
      if (!hasImg && String(ann.text || '').trim()) {
        acts.push(['trans', ann.translation ? '重新翻译' : '翻译']);
      }
      /* 8：复制要分清复制的是什么 —— 摘录是摘录，笔记是笔记 */
      acts.push(['copyex', '复制摘录']);
      if (ann.note) acts.push(['copynote', '复制笔记']);
      acts.forEach(([act, label]) => {
        foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': act, text: label }));
      });
      foot.appendChild(U.el('span', { class: 'ec-spacer' }));
      foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': 'del', text: '删除' }));
      card.appendChild(foot);
      frag.appendChild(card);
    }
    listEl.innerHTML = '';
    listEl.appendChild(frag);
    if (msExcerpt) msExcerpt.sync();     // 重渲染后把还活着的选中态点亮
    syncTrackMarks();
  }

  /* ==================== 列表多选 + 批量操作（v3.15） ====================
     摘录和笔记一多起来，「一条一条删」是最磨人的操作。
     所以四个列表（摘录 / 笔记 / 知识库 / 回收站）统一支持：
       Ctrl / ⌘ + 点 = 加选，Shift + 点 = 连选，Ctrl + A = 全选，Esc = 取消
     选好之后列表上方浮出一条操作条，给批量删除 / 复制。
     交互本身在 multiselect.js 里，这里只提供「能做哪些动作」。 */
  let msExcerpt = null;
  let msNotes = null;

  function initMultiSelect() {
    if (typeof MultiSelect === 'undefined') return;
    msExcerpt = MultiSelect.create({
      root: $('#excerptList'),
      bar: $('#excerptBulk'),
      itemSel: '.excerpt-card',
      keyOf: (n) => n.dataset.id,
      actions: [
        { label: '复制', title: '把选中的摘录合成一段 Markdown 复制走', run: (ids) => copyExcerpts(ids) },
        { label: '删除', danger: true, title: '移入回收站（保留 30 天）', run: (ids) => deleteExcerpts(ids) }
      ]
    });
    msNotes = MultiSelect.create({
      root: $('#notesList'),
      bar: $('#notesBulk'),
      itemSel: '.note-card',
      keyOf: (n) => n.dataset.key,
      actions: [
        { label: '复制', title: '把选中的笔记合成一段 Markdown 复制走', run: (keys) => copyNotes(keys) },
        { label: '删除', danger: true, title: '移入回收站（保留 30 天）', run: (keys) => deleteNotes(keys) }
      ]
    });
  }

  /* 语音输入（v3.15）：所有能写笔记的输入框都配一支麦克风。
     复用字幕那套本地 ASR + 精修 + 语境校对 —— 同一份模型，多一处用途，不额外下载。 */
  /* v3.30：整块下线（用户要求删掉「笔记的语音记录」）。
     删的是「挂麦克风」这件事，不是语音能力本身 —— 视频转字幕仍在用同一套 ASR。
     留这段注释是为了下次别再有人把它加回来当新功能。 */

  function annById(id) {
    if (!state.data) return null;
    return state.data.annotations.find((a) => a.id === id) || null;
  }

  function copyExcerpts(ids) {
    const list = (ids || []).map(annById).filter(Boolean);
    if (!list.length) return;
    const md = list.map((a) => {
      const head = '#### ' + placeLabel(a) + ' · ' + typeLabel(a);
      const body = String(a.text || '').trim();
      const note = String(a.note || '').trim();
      return head + '\n\n' + (body || '［图片］') + (note ? '\n\n' + note : '');
    }).join('\n\n---\n\n');
    U.copyText(md).then((ok) => {
      U.toast(ok ? ('已复制 ' + list.length + ' 条摘录') : '复制失败', ok ? 'ok' : 'err', 1800);
      if (msExcerpt) msExcerpt.clear();
    });
  }

  async function deleteExcerpts(ids) {
    const list = (ids || []).map(annById).filter(Boolean);
    if (!list.length) return;
    const r = await confirmDialog('删除 ' + list.length + ' 条摘录',
      '它们会进回收站，30 天内可以还原。', [
        { label: '取消', value: 'cancel' },
        { label: '删除', value: 'ok', danger: true }
      ]);
    if (r !== 'ok') return;
    const redo = () => { renderExcerpts(); renderNotes(); Store.rebuildIndex(); };
    list.forEach((a) => removeAnnotation(a, true, { undo: false }));
    /* 批量删除也要能一次撤回：Ctrl+Z 之后这些卡片该回到原来的位置 */
    Undo.push('批量删除 ' + list.length + ' 条摘录', () => {
      list.forEach((a) => { if (state.data) state.data.annotations.push(a); refreshAnnotations(a.page); });
      redo();
    }, () => {
      list.forEach((a) => detachAnn(a));
      redo();
    });
    redo();
    if (msExcerpt) msExcerpt.clear();
    U.toast('已删除 ' + list.length + ' 条（可在回收站还原）', 'ok', 2400);
  }

  function copyNotes(keys) {
    const set = new Set(keys || []);
    const list = collectNotes().filter((n) => set.has(n.key));
    if (!list.length) return;
    const md = list.map((n) => String(n.md || '').trim()).filter(Boolean).join('\n\n---\n\n');
    U.copyText(md).then((ok) => {
      U.toast(ok ? ('已复制 ' + list.length + ' 条笔记') : '复制失败', ok ? 'ok' : 'err', 1800);
      if (msNotes) msNotes.clear();
    });
  }

  async function deleteNotes(keys) {
    const set = new Set(keys || []);
    const list = collectNotes().filter((n) => set.has(n.key));
    if (!list.length) return;
    const r = await confirmDialog('删除 ' + list.length + ' 条笔记',
      '它们会进回收站，30 天内可以还原。', [
        { label: '取消', value: 'cancel' },
        { label: '删除', value: 'ok', danger: true }
      ]);
    if (r !== 'ok') return;
    list.forEach((n) => removeNoteEntry(n, true));
    Store.rebuildIndex();
    renderNotes();
    renderExcerpts();
    if (msNotes) msNotes.clear();
    U.toast('已删除 ' + list.length + ' 条笔记', 'ok', 2400);
  }

  /* ==================== 字幕 → 笔记（v3.15） ====================
     字幕里最值钱的是「哪句话配哪个画面」。
     所以存笔记时按连续段分组，每段抓它**开头那一帧**一起存进去 ——
     中间断开了说明话题换了，硬塞进同一张图是骗人，断处各自再截一张。 */
  async function saveSubtitleGroups(groups) {
    if (!state.data || !state.isVideo) {
      U.toast('只有视频才有字幕笔记', 'err', 2200);
      return;
    }
    let n = 0;
    let shots = 0;
    for (const g of groups) {
      /* 用离屏播放器定位，不动正在播的那个 —— 否则存一次笔记就把播放位置弄丢了 */
      let img = '';
      try { img = await VideoView.captureFrameAt(g.t0); } catch (e) { img = ''; }
      if (img) shots++;
      const plain = g.rows.map((r) => r.text).join('');
      addAnnotation({
        type: 'area', page: 1,
        t: Math.max(0, g.t0), t1: Math.max(g.t0, g.t1),
        vt: 'sub',
        rects: [], text: plain, note: subGroupMarkdown(g), image: img,
        color: state.currentColor
      }, { scroll: n === 0, undo: false });
      n++;
    }
    if (!n) return;
    persist();
    renderExcerpts();
    renderNotes();
    Store.rebuildIndex();
    switchTab('notes');
    try { Subtitle.clearSelection(); } catch (e) { /* ignore */ }
    U.toast('已存 ' + n + ' 条字幕笔记' + (shots ? '（各附一张对应画面）' : '（画面没截到）'), 'ok', 2800);
  }

  function subGroupMarkdown(g) {
    const out = [];
    if (g.rows.length > 1) {
      out.push('⏱ ' + VideoView.fmt(g.t0) + ' – ' + VideoView.fmt(g.t1) + '　·　' + g.rows.length + ' 句');
      out.push('');
    }
    g.rows.forEach((r) => {
      out.push('**' + VideoView.fmt(r.t) + '**　' + r.text);
      if (r.zh) out.push('> ' + r.zh);
      out.push('');
    });
    return out.join('\n').trim();
  }

  /* 把已记录的截图 / 框选 / 片段画到时间轴上，颜色用各自的标记色 */
  function syncTrackMarks() {
    if (typeof VideoView === 'undefined' || !VideoView.setMarks) return;
    if (!state.isVideo || !state.data) { VideoView.setMarks([]); return; }
    const list = state.data.annotations
      .filter((a) => typeof a.t === 'number')
      .map((a) => ({
        id: a.id, t: a.t, t1: a.t1, color: colorOf(a).hl,
        kind: typeLabel(a), active: a.id === state.activeAnnId
      }));
    VideoView.setMarks(list);
  }

  /* 点时间轴上的色块：选中那条记录（右栏同步高亮），让它成为 Delete 的对象。
     定位（seek）由时间轴自己做，这里只管「选中」。 */
  function pickVideoMark(id) {
    if (!state.data || !id) return;
    const ann = state.data.annotations.find((a) => a.id === id);
    if (!ann) return;
    selectAnnotation(ann);
  }

  /* ==================== 知识库页签（右栏） ==================== */
  function renderKbPanel() {
    const sum = $('#kbSummary');
    const recent = $('#kbRecent');
    if (!sum) return;
    let idx = null;
    try { idx = Store.getIndex(); } catch (e) { idx = null; }
    const entries = (idx && idx.entries) || [];
    const docs = (idx && idx.docs) || {};
    const docCount = Object.keys(docs).length;
    const ex = entries.filter((e) => e.kind === 'excerpt').length;
    const nt = entries.filter((e) => e.kind === 'note').length;

    sum.innerHTML = ''
      + '<div class="kbs-row"><b>' + docCount + '</b><span>篇文档</span></div>'
      + '<div class="kbs-row"><b>' + ex + '</b><span>条摘要</span></div>'
      + '<div class="kbs-row"><b>' + nt + '</b><span>条笔记</span></div>';

    if (!recent) return;
    const latest = entries.slice(0, 6);
    if (!latest.length) {
      recent.innerHTML = '<div class="pane-empty" style="padding:16px 0">还没有任何摘要或笔记</div>';
      return;
    }
    recent.innerHTML = '';
    latest.forEach((e) => {
      const row = U.el('div', { class: 'kbr-row' });
      row.appendChild(U.el('span', { class: 'kbr-doc', text: e.docName || '' }));
      row.appendChild(U.el('span', { class: 'kbr-text', text: U.truncate(e.md || e.text || '', 60) }));
      row.appendChild(U.el('span', { class: 'kbr-time', text: U.relTime(e.at) }));
      row.addEventListener('click', () => KnowledgeBase.open('all', e));
      recent.appendChild(row);
    });
  }

  function highlightCard(id) {
    $$('#excerptList .excerpt-card').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
    const active = $('#excerptList .excerpt-card.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  /* 新摘录生成后把右栏滚到它那里 —— 一篇文章几十条时，新加的东西在列表顶端，
     但用户当时的滚动位置可能还在底下，不滚过去就像「没生效」。 */
  function scrollExcerptTo(id) {
    if (!id) return;
    switchTab('excerpts');
    const el = $('#excerptList .excerpt-card[data-id="' + id + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function scrollNoteTo(key) {
    if (!key) return;
    switchTab('notes');
    const el = $('#notesList .note-card[data-key="' + key + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /* 笔记栏选中：Delete 认这个 key，点空白处清除 */
  function selectNoteCard(key) {
    state.activeNoteKey = key || null;
    if (state.activeNoteKey) {
      state.activeAnnId = null;
      if (annMgr) annMgr.setActive(null);
      highlightCard(null);
    }
    $$('#notesList .note-card').forEach((el) => el.classList.toggle('active', el.dataset.key === state.activeNoteKey));
    if (state.activeNoteKey) {
      const el = $('#notesList .note-card.active');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  /* 定位到一条标注：PDF 翻页 + 滚动，视频跳到时间点 */
  function focusAnn(ann) {
    if (!ann) return;
    if (state.isVideo) {
      VideoView.seek(typeof ann.t === 'number' ? ann.t : 0);
      return;
    }
    if (viewer) viewer.focusAnnotation(ann);
  }

  async function onExcerptListClick(e) {
    const card = e.target.closest('.excerpt-card');
    if (!card) return;
    const ann = state.data && state.data.annotations.find((a) => a.id === card.dataset.id);
    if (!ann) return;
    const act = e.target.dataset && e.target.dataset.act;

    /* v4.2.6：单击延时 260ms（定位原文），双击打开阅读页时取消掉 */
    if (!act) {
      clearTimeout(card._clickT);
      card._clickT = setTimeout(() => {
        card._clickT = 0;
        selectAnnotation(ann);
        focusAnn(ann);
      }, 260);
      return;
    }
    if (act === 'goto') {
      state.activeAnnId = ann.id;
      annMgr.setActive(ann.id);
      highlightCard(ann.id);
      focusAnn(ann);
    } else if (act === 'writenote') {
      openComposer('ann', ann.id, 'modal');
    } else if (act === 'copyex' || act === 'copy') {
      /* 复制摘录：只复制摘录本身（原文 / 图片），不含后来写的笔记 */
      /* v3.28：图片可能只在盘上，先读回 dataURL 再进剪贴板 */
      let imgData = ann.image || '';
      if (!imgData && ann.imagePath && !ann.text && typeof ImgCache !== 'undefined') {
        imgData = await ImgCache.dataUrl(ann.imagePath);
      }
      const ok = imgData && !ann.text
        ? (Bridge.copyImageDataUrl(imgData) || await copyImageFallback(ann))
        : await U.copyText(ann.text || buildExcerptText(ann));
      U.toast(ok ? '已复制摘录内容' : '复制失败', ok ? 'ok' : 'err');
    } else if (act === 'copynote') {
      const ok = await U.copyText(ann.note || '');
      U.toast(ok ? '已复制笔记内容' : '复制失败', ok ? 'ok' : 'err');
    } else if (act === 'expand') {
      const node = e.target._target;
      if (node) {
        const openNow = node.classList.toggle('expanded');
        e.target.textContent = openNow ? '收起' : '展开全文';
      }
    } else if (act === 'ocr') {
      ocrAnn(ann);
    } else if (act === 'saveimg') {
      saveAnnImageNative(ann);
    } else if (act === 'previewclip') {
      previewClip(ann);
    } else if (act === 'saveclip') {
      exportClipVideo(ann);
    } else if (act === 'openclip') {
      /* 旧版卡片上的「打开片段」：文件在就打开，没了就转成预览，
         免得老记录点一下毫无反应。 */
      if (ann.filePath && Store.fileExists(ann.filePath)) {
        if (!Bridge.openPath(ann.filePath)) Bridge.showInFolder(ann.filePath);
      } else previewClip(ann);
    } else if (act === 'trans') {
      translateAnn(ann);
    } else if (act === 'del') {
      removeAnnotation(ann);
    }
  }

  /* 摘录卡片就地翻译。
     与划词翻译走同一条链路（本地模型优先，失败才降级联网），译文存进 ann.translation，
     下次打开文档直接显示，不必再算一遍。 */
  const transBusy = new Set();

  async function translateAnn(ann) {
    /* 摘录里的文字同样是从 PDF 复制出来的，先重排再翻（理由见 runTranslate） */
    const text = U.reflow(String(ann.text || ''));
    if (!ann || !text || transBusy.has(ann.id)) return;
    if (typeof Translator === 'undefined' || !Translator.translate) {
      U.toast('翻译模块没加载', 'err');
      return;
    }
    transBusy.add(ann.id);
    const btn = document.querySelector('.excerpt-card[data-id="' + ann.id + '"] .ec-btn[data-act="trans"]');
    if (btn) { btn.textContent = '翻译中…'; btn.disabled = true; }
    const t0 = Date.now();
    try {
      const target = Translator.guessTarget(text);
      /* 摘录翻译时选区早就没了，改从它所在页的文字层取上下文 */
      const res = await Translator.translate(text, { target, context: pageContext(ann.page, text) });
      if (!res || !res.ok) {
        throw new Error((res && (res.error || res.detail)) || '翻译失败');
      }
      updateAnnotation(ann, {
        translation: String(res.text || '').trim(),
        translationVia: res.provider || '',
        translationAt: Date.now()
      });
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      U.toast('已翻译（' + (Translator.providerLabel(res.provider) || '引擎') + ' · ' + secs + 's）', 'ok', 2000);
    } catch (e) {
      U.toast('翻译失败：' + (e && e.message ? e.message : e), 'err', 4200);
      const b2 = document.querySelector('.excerpt-card[data-id="' + ann.id + '"] .ec-btn[data-act="trans"]');
      if (b2) { b2.disabled = false; b2.textContent = ann.translation ? '重新翻译' : '翻译'; }
    } finally {
      transBusy.delete(ann.id);
    }
  }

  /* 图片 OCR：把画面里的文字提出来（讲课视频的板书 / 幻灯片最有用）。
     走本机 Ollama 的视觉模型，整张图不出本机；没有视觉模型就明说缺什么，不偷偷联网。 */
  const ocrBusy = new Set();

  async function ocrAnn(ann) {
    if (!ann || !annHasImage(ann) || ocrBusy.has(ann.id)) return;
    if (typeof Translator === 'undefined' || !Translator.ocrImage) {
      U.toast('OCR 模块没加载', 'err');
      return;
    }
    ocrBusy.add(ann.id);
    const btn = document.querySelector('.excerpt-card[data-id="' + ann.id + '"] .ec-btn[data-act="ocr"]');
    if (btn) { btn.textContent = '识别中…'; btn.disabled = true; }
    const t0 = Date.now();
    try {
      /* v3.28：图片只存了路径 → 先从盘上读回原图（OCR 越清晰越准） */
      let src = ann.image || '';
      if (!src && ann.imagePath && typeof ImgCache !== 'undefined') {
        src = await ImgCache.dataUrl(ann.imagePath);
      }
      if (!src) { U.toast('读不到这张图（文件可能被移动或删掉了）', 'err', 3200); return; }
      const text = await Translator.ocrImage(src);
      if (!text) {
        U.toast('这张图里没识别到文字', '', 2200);
        return;
      }
      ann.text = text;
      ann.ocrAt = Date.now();
      updateAnnotation(ann, { text, ocrAt: Date.now() });
      U.toast('已识别 ' + text.length + ' 字（' + Math.round((Date.now() - t0) / 100) / 10 + 's）', 'ok', 2000);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      /* 缺环境（没装 Ollama / 没视觉模型）时，别只甩一句长报错：
         toast 说人话，同时把右栏向导展开，步骤就在眼前。 */
      if (/Ollama|视觉模型/.test(msg)) {
        U.toast('OCR 需要本地视觉模型，已在右栏展开设置', 'err', 3600);
        setEnvOpenPref(true);
        checkEnv(true);
      } else {
        U.toast('OCR 失败：' + msg, 'err', 4200);
      }
    } finally {
      ocrBusy.delete(ann.id);
      const b2 = document.querySelector('.excerpt-card[data-id="' + ann.id + '"] .ec-btn[data-act="ocr"]');
      if (b2) { b2.disabled = false; }
      /* 识别这一下会把视觉模型加载进显存（也可能刚刚失败），
         右栏那行状态跟着变，别让它停在「未在显存」。 */
      refreshRuntime();
    }
  }

  async function copyImageFallback(ann) {
    // 剪贴板写图失败时退化为复制文字说明
    const ok = await U.copyText(buildExcerptText(ann) || '［图片摘录］');
    return ok;
  }

  function buildExcerptText(ann) {
    const parts = [];
    if (ann.text) parts.push('「' + ann.text + '」');
    else if (annHasImage(ann)) parts.push('［图片摘录］');
    if (ann.note) parts.push('笔记：' + Markdown.plain(ann.note));
    parts.push(`——《${U.stripExt(state.item ? state.item.name : '')}》第 ${ann.page} 页`);
    return parts.join('\n\n');
  }

  /* ==================== 笔记列表 ==================== */
  function collectNotes() {
    if (!state.data) return [];
    const out = [];

    state.data.annotations.forEach((a) => {
      if (!a.note || !a.note.trim()) return;
      out.push({
        kind: 'ann',
        key: 'ann:' + a.id,
        annId: a.id,
        md: a.note,
        quote: (a.type === 'highlight' || a.vt === 'sub') ? (a.text || '') : '',
        quoteLabel: a.vt === 'sub' ? '视频字幕'
          : (a.vt === 'clip' ? '视频片段'
            : (a.vt === 'shot' ? '视频截图'
              : (a.vt === 'area' ? '框选区域' : (a.type === 'note' ? '页面锚点' : '')))),
        image: a.image || '',
        imagePath: a.imagePath || '',
        vt: a.vt || '',
        page: a.page,
        t: typeof a.t === 'number' ? a.t : null,
        t1: typeof a.t1 === 'number' ? a.t1 : null,
        atts: (a.attachments || []).length,
        createdAt: a.createdAt || a.updatedAt || 0
      });
    });

    (state.data.notes || []).forEach((n) => {
      if ((!n.md || !n.md.trim()) && !(n.attachments || []).length && !n.image && !n.imagePath) return;
      out.push({
        kind: 'free',
        key: 'note:' + n.id,
        noteId: n.id,
        md: n.md || '',
        quote: n.quote || '',
        quoteLabel: '',
        image: n.image || '',
        imagePath: n.imagePath || '',
        vt: n.vt || '',
        page: n.page || null,
        t: typeof n.t === 'number' ? n.t : null,
        t1: null,
        atts: (n.attachments || []).length,
        createdAt: n.createdAt || n.updatedAt || 0
      });
    });

    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  /* 卡片结构：笔记在上（正文字号大），来源摘录在下（斜体、字号小、最多两行） */
  /* v4.2.13：新建按钮宽度跟笔记卡片严格对齐。
     卡片在 .notes-list（padding 左右各 10px）里，列表出滚动条时还再被吃掉 10px ——
     静态 CSS 算不准滚动条，直接抄 clientWidth（已扣滚动条）减两侧内边距，实测实准。 */
  function syncNoteNewWidth(listEl) {
    const btn = $('#btnNoteNew');
    if (!btn) return;
    const w = listEl.clientWidth;
    if (!w) return;                     // 面板隐藏时 clientWidth 是 0，别把按钮写成 0 宽
    btn.style.width = Math.max(0, w - 20) + 'px';
  }
  window.addEventListener('resize', () => {
    const listEl = $('#notesList');
    if (listEl) syncNoteNewWidth(listEl);
  });

  function renderNotes() {
    const listEl = $('#notesList');
    if (!listEl) return;
    syncNoteNewWidth(listEl);
    /* v4.2.5：搜索态下文档被换 / 列表被刷新 → 搜索结果已是旧文档的，直接清掉 */
    if (noteSearch.q.trim()) { noteSearchClear(); }
    if (!state.data) {
      listEl.innerHTML = '<div class="pane-empty">尚未打开文档<br>打开 PDF 后在此列出笔记</div>';
      $('#notesCount').textContent = '0';
      return;
    }
    const notes = collectNotes();
    $('#notesCount').textContent = String(notes.length);

    if (!notes.length) {
      listEl.innerHTML = '<div class="lib-empty" style="padding:24px 8px;text-align:center;color:var(--muted);font-size:12px;line-height:1.8">'
        + '本 PDF 还没有笔记<br>点下方「✎ 新建笔记」写一条，或拖选文字后点「摘录并笔记」' + '</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const n of notes) {
      const card = U.el('div', {
        class: 'note-card' + (n.key === state.activeNoteKey ? ' active' : ''),
        'data-key': n.key
      });
      const head = U.el('div', { class: 'nc-head' });
      head.appendChild(U.el('span', { class: 'nc-tag', text: n.quote ? '摘录笔记' : '笔记' }));
      if (n.t != null) head.appendChild(U.el('span', { class: 'nc-time-badge', text: placeLabel(n) }));
      else if (n.page) head.appendChild(U.el('span', { class: 'nc-page', text: 'p.' + n.page }));
      if (n.atts) head.appendChild(U.el('span', { class: 'nc-atts', text: '⧉ ' + n.atts }));
      head.appendChild(U.el('span', { class: 'nc-time', text: U.fmtTime(n.createdAt) }));
      card.appendChild(head);

      if (n.md) {
        const bodyNode = U.el('div', { class: 'nc-body md-body', html: Markdown.render(n.md) });
        card.appendChild(bodyNode);
        addExpandable(card, bodyNode, n.md, 'nc-more');
      } else if (!n.image && !n.imagePath) {
        card.appendChild(U.el('div', { class: 'nc-body nc-body-empty', text: '（只有附件）' }));
      }

      // 5：笔记栏里的框选图片小一号
      if (n.image || n.imagePath) {
        const img = U.el('img', { class: 'nc-img' });
        img.draggable = false;
        img.setAttribute('draggable', 'false');
        img.loading = 'lazy';
        card.appendChild(img);
        if (n.image) {
          img.src = n.image;
          fitImageSize(img, 2);
        } else if (typeof ImgCache !== 'undefined') {
          /* v3.30：视频笔记的预览图以前完全没有 —— collectNotes 只带了 image，
             新记录里图片只有 imagePath，于是笔记栏永远是空的。 */
          const trim = n.vt === 'shot' || n.vt === 'clip';
          ImgCache.url(n.imagePath, { trim: trim }).then((u) => {
            if (!u) { img.remove(); return; }
            img.src = u;
            img.title = n.imagePath;
            fitImageSize(img, 2);
          });
        } else {
          img.remove();
        }
      }
      /* 片段的笔记也要看得出「是哪一段」 */
      if (n.vt === 'clip' && n.t != null && n.t1 != null) {
        const pill = U.el('div', { class: 'nc-clip' });
        pill.appendChild(U.el('span', { class: 'nc-clip-dot', text: '●' }));
        pill.appendChild(U.el('span', { text: VideoView.fmt(n.t) + ' → ' + VideoView.fmt(n.t1) }));
        card.appendChild(pill);
      }

      if (n.quote) {
        const src = U.el('div', { class: 'nc-source' });
        src.appendChild(U.el('span', {
          class: 'nc-source-label',
          text: n.t != null ? '摘自 ' + placeLabel(n) : (n.page ? '摘自第 ' + n.page + ' 页' : '摘自摘录')
        }));
        const quoteNode = U.el('div', { class: 'nc-source-text', text: n.quote });
        src.appendChild(quoteNode);
        card.appendChild(src);
        addExpandable(card, quoteNode, n.quote, 'nc-more', 36);
      } else if (n.quoteLabel) {
        card.appendChild(U.el('div', { class: 'nc-source nc-source-slim', text: '来源：' + n.quoteLabel }));
      }

      const foot = U.el('div', { class: 'nc-foot' });
      foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': 'edit', text: '编辑' }));
      foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': 'copy', text: '复制笔记' }));
      /* 只要这条笔记知道自己从哪来（引用的摘录 / 页码 / 视频时间点），就给「定位」 */
      if (n.page || n.t != null || n.annId) {
        foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': 'goto', text: '定位' }));
      }
      foot.appendChild(U.el('span', { class: 'ec-spacer' }));
      foot.appendChild(U.el('button', { class: 'ec-btn', 'data-act': 'del', text: '删除' }));
      card.appendChild(foot);
      frag.appendChild(card);
    }
    listEl.innerHTML = '';
    listEl.appendChild(frag);
    renderBacklinks(listEl);
    if (msNotes) msNotes.sync();
  }

  /* ===== v4.2.5 笔记栏顶部搜索：本文献 → 全局笔记 → Eagle 资料库 =====
     三层优先级自动下沉：本文献有结果就停在本层，没有才看全局，
     全局也没有才扫 Eagle 库。Esc 逐层退回（库 → 全局 → 本文献 → 清空）。
     排序复用 NoteEditor.matchScore —— 和 [[ 补全同一套相关度口径。 */
  const noteSearch = {
    q: '',
    layer: 0,                  // v4.2.14：默认「全部」（三层合流）—— 之前默认本笔记，用户要求默认全部
    res: { 1: [], 2: [], 3: [] },
    lib: null,                 // Eagle 库清单缓存（10 分钟），不在每次输入都全库扫
    libAt: 0,
    timer: 0
  };

  function noteSearchTokens() {
    return noteSearch.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }
  /* 与 [[ 补全同一套打分：返回 null = 不命中/弱命中 */
  function noteSearchScore(hay, tokens) {
    if (typeof NoteEditor !== 'undefined' && NoteEditor.matchScore) {
      const sc = NoteEditor.matchScore(String(hay || ''), tokens);
      return (sc && !sc.weak) ? sc.score : null;
    }
    const s = String(hay || '').toLowerCase();
    return tokens.every((t) => s.indexOf(t) >= 0) ? 50 : null;
  }

  function noteSearchLayer1(tokens) {
    const titleOf = (n) => (typeof WikiLink !== 'undefined' && WikiLink.noteTitle && n.md)
      ? WikiLink.noteTitle(n.md) : '';
    return collectNotes()
      .map((n) => {
        const sc = Math.max(
          noteSearchScore(n.md, tokens) == null ? -1 : noteSearchScore(n.md, tokens),
          noteSearchScore(n.quote, tokens) == null ? -1 : noteSearchScore(n.quote, tokens)
        );
        if (sc < 0) return null;
        const title = titleOf(n) || String(n.quote || '').slice(0, 60) || '（无标题笔记）';
        return { kind: 'doc', key: n.key, score: sc, title: title, tag: n.quote ? '摘录笔记' : '笔记' };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  function noteSearchLayer2(tokens) {
    if (typeof Projection === 'undefined' || !Projection.isOn()) return [];
    let tree = [];
    try { tree = Projection.wikiTree(currentBookTitle()) || []; } catch (e) { return []; }
    const out = [];
    tree.forEach((node) => {
      const bSc = noteSearchScore(node.book, tokens);
      (node.notes || []).forEach((t) => {
        const nSc = noteSearchScore(t, tokens);
        const best = Math.max(nSc == null ? -1 : nSc, bSc == null ? -1 : bSc);
        if (best < 0) return;
        out.push({ kind: 'wiki', book: node.book, note: t, score: best });
      });
    });
    return out.sort((a, b) => b.score - a.score).slice(0, 80);
  }

  async function noteSearchLayer3(tokens) {
    if (noteSearch.lib && Date.now() - noteSearch.libAt < 600000) {
      return noteSearchFilterLib(tokens);
    }
    try {
      noteSearch.lib = (await Bridge.listLibraryItems(['pdf', 'mp4', 'mkv', 'mov', 'avi', 'webm'], 3000)) || [];
    } catch (e) { noteSearch.lib = []; }
    noteSearch.libAt = Date.now();
    return noteSearchFilterLib(tokens);
  }
  function noteSearchFilterLib(tokens) {
    return (noteSearch.lib || [])
      .map((it) => {
        const sc = noteSearchScore(U.stripExt(it.name || ''), tokens);
        return sc == null ? null : { kind: 'lib', item: it, score: sc };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 80);
  }

  function onNoteSearchInput() {
    const input = $('#noteSearch');
    noteSearch.q = input ? input.value : '';
    if ($('#btnNoteSearchClear')) $('#btnNoteSearchClear').hidden = !noteSearch.q.trim();
    if (noteSearch.timer) clearTimeout(noteSearch.timer);
    if (!noteSearch.q.trim()) { noteSearchReset(); renderNotes(); return; }
    noteSearch.timer = setTimeout(() => { noteSearch.timer = 0; noteSearchRun(); }, 220);
  }

  function noteSearchRun() {
    const tokens = noteSearchTokens();
    if (!tokens.length) { noteSearchClear(); return; }
    noteSearch.res[1] = noteSearchLayer1(tokens);
    noteSearch.res[2] = noteSearchLayer2(tokens);
    noteSearch.res[3] = null;                       // L3 异步，先占位
    /* v4.2.15：默认停在「全部」—— 之前按「第一层有结果就跳第一层」自动选层，
       结果 本笔记 0 条时直接跳到 全局笔记，用户截图实锤（截图里高亮的是全局笔记）。
       「全部」永远第一屏，三层合流，想看单层自己点标签。 */
    noteSearch.layer = 0;
    noteSearchRender();
    noteSearchLayer3(tokens).then((l3) => {
      noteSearch.res[3] = l3;
      if (noteSearch.q.trim()) noteSearchRender();  // 库扫完补一次渲染（用户还在搜索态才刷）
    });
  }

  function noteSearchReset() {
    noteSearch.res = { 1: [], 2: [], 3: [] };
    noteSearch.layer = 0;      // v4.2.14：重置回「全部」，与默认层一致
  }

  function noteSearchClear() {
    if (noteSearch.timer) { clearTimeout(noteSearch.timer); noteSearch.timer = 0; }
    noteSearch.q = '';
    noteSearchReset();
    const input = $('#noteSearch');
    if (input) input.value = '';
    const btn = $('#btnNoteSearchClear');
    if (btn) btn.hidden = true;
  }

  /* v4.2.13：笔记搜索框里的 Enter 也得有人认领 —— 之前放任不管，
     Eagle 把漏过去的 Enter 当成「用默认软件打开当前文档」。
     搜索是边输边出的，Enter 没有本地职责，直接整键吞掉。
     （Esc 清空由全局捕获层的 noteSearch 分支处理，这里不再重复挂——
     捕获层 stopPropagation 之后目标层的 keydown 根本收不到。） */
  function noteSearchSwallowEnter(e) {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function noteSearchRender() {
    const listEl = $('#notesList');
    if (!listEl) return;
    /* v4.2.6：四个标签 —— 全部（三层结果合流）/ 资料内笔记 / 全局笔记 / Eagle 数据库
       v4.2.15：「本笔记」改名「资料内笔记」、「Eagle 库」改名「Eagle 数据库」 */
    const l3 = noteSearch.res[3] == null ? [] : noteSearch.res[3];
    const all = noteSearch.res[1].concat(noteSearch.res[2], l3);
    const box = U.el('div', { class: 'ns-results' });
    const tabs = U.el('div', { class: 'ns-tabs' });
    [[0, '全部', all.length],
     [1, '资料内笔记', noteSearch.res[1].length],
     [2, '全局笔记', noteSearch.res[2].length],
     [3, 'Eagle 数据库', noteSearch.res[3] == null ? null : noteSearch.res[3].length]].forEach(([lv, label, cnt]) => {
      const b = U.el('button', {
        class: 'ns-tab' + (noteSearch.layer === lv ? ' active' : ''),
        text: label + ' · ' + (cnt == null ? '…' : cnt)
      });
      b.title = '查看「' + label + '」的搜索结果';
      b.addEventListener('click', () => { noteSearch.layer = lv; noteSearchRender(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);
    const hint = U.el('div', { class: 'ns-hint', text: 'Esc 清空搜索 · 点击结果直接打开' });
    box.appendChild(hint);

    const rows = noteSearch.layer === 0 ? all : (noteSearch.res[noteSearch.layer] || []);
    if (!rows.length) {
      box.appendChild(U.el('div', {
        class: 'ns-empty',
        text: '「' + noteSearch.q.trim() + '」在这一层没有匹配 · 点其他标签，或按 Esc 清空'
      }));
    }
    rows.forEach((r) => {
      const it = U.el('div', { class: 'ns-item ns-' + r.kind });
      if (r.kind === 'doc') {
        it.appendChild(U.el('span', { class: 'ns-tag', text: r.tag }));
        it.appendChild(U.el('span', { class: 'ns-title', html: U.escapeHtml(r.title) }));
        it.addEventListener('click', () => {
          state.activeNoteKey = r.key;
          noteSearchClear();
          renderNotes();
          try {
            const card = $('#notesList [data-key="' + (window.CSS && CSS.escape ? CSS.escape(r.key) : r.key) + '"]');
            if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } catch (err) { /* 滚不了就停在高亮 */ }
        });
      } else if (r.kind === 'wiki') {
        it.appendChild(U.el('span', { class: 'ns-tag', text: '《' + r.book + '》' }));
        it.appendChild(U.el('span', { class: 'ns-title', html: U.escapeHtml(r.note) }));
        it.addEventListener('click', () => {
          noteSearchClear();
          openWikiTarget(r.book + '#' + r.note);
        });
      } else {
        it.appendChild(U.el('span', { class: 'ns-tag', text: (r.item.ext || '').toUpperCase() || '文件' }));
        it.appendChild(U.el('span', { class: 'ns-title', text: U.stripExt(r.item.name || '') }));
        it.addEventListener('click', async () => {
          noteSearchClear();
          try {
            const fresh = await Bridge.getItemById(r.item.id);
            if (fresh) await openItem(Object.assign({ id: r.item.id, ext: r.item.ext }, fresh));
            else U.toast('这条在 Eagle 里打不开了（可能已删除）', '', 2400);
          } catch (err) { U.toast('打开失败：' + err.message, '', 2400); }
        });
      }
      box.appendChild(it);
    });
    listEl.innerHTML = '';
    listEl.appendChild(box);
  }

  /* v4.2.6：空查询点搜索框 → 最近笔记（输入/生成时间倒序，前 10 条）。
     单击定位原文，双击打开阅读页 —— 和下面的卡片同一个习惯。 */
  function renderRecentNotes() {
    const listEl = $('#notesList');
    if (!listEl) return;
    const box = U.el('div', { class: 'ns-results' });
    box.appendChild(U.el('div', { class: 'ns-tabs' }, '<span class="ns-tab active">最近笔记</span>'));
    box.appendChild(U.el('div', { class: 'ns-hint', text: '单击定位原文 · 双击打开阅读页 · 输入关键词搜索资料内 / 全局 / Eagle 数据库' }));
    const notes = collectNotes().slice()
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, 10);
    if (!notes.length) {
      box.appendChild(U.el('div', { class: 'ns-empty', text: '还没有笔记 —— 点下方「✎ 新建笔记」写一条' }));
    }
    notes.forEach((n) => {
      const title = (typeof WikiLink !== 'undefined' && WikiLink.noteTitle && n.md)
        ? WikiLink.noteTitle(n.md)
        : (String(n.quote || '').slice(0, 50) || '（无标题笔记）');
      const it = U.el('div', { class: 'ns-item ns-doc' });
      it.appendChild(U.el('span', { class: 'ns-tag', text: n.quote ? '摘录笔记' : '笔记' }));
      it.appendChild(U.el('span', { class: 'ns-title', text: title }));
      it.appendChild(U.el('span', { class: 'ns-time', text: U.fmtTime(n.updatedAt || n.createdAt) }));
      it.addEventListener('click', () => {
        state.activeNoteKey = n.key;
        noteSearchClear();
        renderNotes();
        try {
          const card = $('#notesList [data-key="' + (window.CSS && CSS.escape ? CSS.escape(n.key) : n.key) + '"]');
          if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (err) { /* 滚不了就停在高亮 */ }
      });
      it.addEventListener('dblclick', () => { openNoteReader(n); });
      box.appendChild(it);
    });
    listEl.innerHTML = '';
    listEl.appendChild(box);
  }

  /* ===== v4.0 双链笔记 =====
     语法 [[书名]]（Obsidian 兼容）。三层各归其位：
     解析在 WikiLink（纯函数），索引在 Projection.manifest（出链）/运行时聚合（入链），
     这里只管跳转、补全数据源、反链面板——不碰 md 文件正文。 */
  function currentBookTitle() {
    return (state.item && state.item.name) ? U.stripExt(state.item.name) : '';
  }

  async function openWikiTarget(target) {
    const t = String(target || '').trim();
    if (!t) return false;
    /* v4.2：目标可带笔记级部分（[[书#笔记]]）。书负责打开，笔记负责定位。 */
    const split = (typeof WikiLink !== 'undefined' && WikiLink.splitTarget)
      ? WikiLink.splitTarget(t) : { book: t, note: '' };
    /* v4.2.8：目标就是当前书的笔记 → 直接定位到那条笔记（切笔记页+滚动高亮），
       不再把整本书重开一遍 —— 之前点本书的笔记链接会触发整个文档重载，又慢又晃。 */
    if (split.note && state.item && currentBookTitle() === split.book) {
      if (locateNoteByTitle(split.note)) return true;
    }
    /* ① manifest 对账：书名 → 条目 id → Eagle 拿全量条目 → 插件内打开。
       走 manifest 而不是直接搜资料库，是因为书名归一化对账在改名后仍成立。 */
    const id = (typeof Projection !== 'undefined') ? Projection.idByTitle(split.book) : '';
    if (id) {
      try {
        const fresh = await Bridge.getItemById(id);
        if (fresh && await openItem(Object.assign({ id: id, ext: 'pdf' }, fresh))) {
          if (split.note) locateNoteByTitle(split.note);
          return true;
        }
      } catch (e) { /* 落到搜索兜底 */ }
    }
    /* ② 资料库按名搜（书还没投影过也能跳）；先找精确同名的 PDF */
    try {
      const list = (await Bridge.searchItems(split.book, 20)) || [];
      const eq = (it) => U.stripExt(it.name || '').trim().toLowerCase() === split.book.toLowerCase();
      const hit = list.find((it) => eq(it) && it.ext === 'pdf') || list.find(eq);
      if (hit && await openItem(hit)) {
        if (split.note) locateNoteByTitle(split.note);
        return true;
      }
    } catch (e) { /* 落到提示 */ }
    U.toast('资料库里没有《' + split.book + '》—— 链接先留着，书入库后就能点', '', 3000);
    return false;
  }

  /* v4.2：书打开后定位到标题匹配的那条笔记。
     v4.4.0：优先按 noteAnchorTitle（正文第一行原样 —— 与投影 md 的 #### 标题头、
     manifest rec.nt、[[ 补全插入完全同源）精确等值；再退 noteTitle 剥壳版
     （兼容 v4.3 时代写出的旧链接），连引用原文都搜一遍兜底。 */
  function locateNoteByTitle(title) {
    const want = String(title || '').trim().toLowerCase();
    if (!want || !state.data) return false;
    const notes = collectNotes();
    const anchorOf = (n) => (typeof WikiLink !== 'undefined' && WikiLink.noteAnchorTitle ? WikiLink.noteAnchorTitle(n.md) : '').toLowerCase();
    const titleOf = (n) => (typeof WikiLink !== 'undefined' && WikiLink.noteTitle ? WikiLink.noteTitle(n.md) : '').toLowerCase();
    const hit = notes.find((n) => anchorOf(n) === want)
      || notes.find((n) => titleOf(n) === want)
      || notes.find((n) => titleOf(n).indexOf(want) >= 0)
      || notes.find((n) => String(n.quote || '').toLowerCase().indexOf(want) >= 0);
    if (!hit) {
      U.toast('《' + currentBookTitle() + '》里没有笔记「' + title + '」—— 先留着，写出来就能点', '', 2800);
      return false;
    }
    switchTab('notes');
    state.activeNoteKey = hit.key;
    renderNotes();
    try {
      const list = $('#notesList');
      const card = list && list.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(hit.key) : hit.key) + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) { /* 滚不了就停在高亮 */ }
    return true;
  }

  /* Markdown 渲染出来的 .wikilink 没有真实 href，点击统一走这里（编辑器预览里也能点） */
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a.wikilink') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    openWikiTarget(a.getAttribute('data-wtarget'));
  });

  /* v4.2.9：网页视频卡片 / 媒体兜底提示条 —— 系统浏览器打开。
     markdown.js 只管把链接放进 data-href，打开动作统一在这里。 */
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a.md-webvideo, a.md-media-tip') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('data-href');
    if (href) {
      try { Bridge.openExternal(href); } catch (err) { U.toast('浏览器打开失败', 'err', 1600); }
    }
  });

  /* 反链面板：当前书的笔记列表底部，列出「谁链接了这本书」+ 首条上下文。
     数据来自 Projection.backlinksOf（运行时聚合，改名字段在 manifest 层对账）。 */
  function renderBacklinks(listEl) {
    if (!state.item || typeof Projection === 'undefined' || !Projection.isOn()) return;
    let bl = [];
    try { bl = Projection.backlinksOf(currentBookTitle()) || []; } catch (e) { bl = []; }
    /* 自己链自己的笔记级链接（[[本书#笔记]]）不算反链 */
    bl = bl.filter((b) => !state.item.id || b.id !== state.item.id);
    if (!bl.length) return;
    const box = U.el('div', { class: 'bl-box' });
    box.appendChild(U.el('div', { class: 'bl-head', text: '⟲ 反向链接 · ' + bl.length + ' 篇' }));
    for (const b of bl.slice(0, 12)) {
      const card = U.el('div', { class: 'bl-item', 'data-wtarget': b.title });
      card.appendChild(U.el('div', { class: 'bl-title', text: '《' + b.title + '》' }));
      const ctx = (b.contexts && b.contexts[0]) || null;
      if (ctx) {
        const sn = U.el('div', { class: 'bl-snip' });
        if (ctx.before) sn.appendChild(U.el('span', { class: 'bl-dim', text: '…' + ctx.before }));
        sn.appendChild(U.el('span', { class: 'bl-hit', text: ctx.alias }));
        if (ctx.after) sn.appendChild(U.el('span', { class: 'bl-dim', text: ctx.after + '…' }));
        card.appendChild(sn);
      }
      box.appendChild(card);
    }
    if (bl.length > 12) box.appendChild(U.el('div', { class: 'bl-more', text: '…还有 ' + (bl.length - 12) + ' 篇' }));
    box.addEventListener('click', (e) => {
      const it = e.target && e.target.closest ? e.target.closest('.bl-item') : null;
      if (it) openWikiTarget(it.getAttribute('data-wtarget'));
    });
    listEl.appendChild(box);
  }

  /* 定位到一条笔记的来源。返回值表示「真的跳过去了」——
     没有引用的自由笔记只写了一段想法，它不属于任何一页，硬要找地方跳是骗人，
     所以干脆说明白，而不是点了没反应。 */
  function jumpToNote(n) {
    if (!n || !state.data) return false;
    const ann = n.annId ? state.data.annotations.find((a) => a.id === n.annId) : null;
    if (ann) {
      state.activeAnnId = ann.id;
      if (annMgr) annMgr.setActive(ann.id);
      highlightCard(ann.id);
      focusAnn(ann);
      return true;
    }
    if (state.isVideo && n.t != null) { VideoView.seek(n.t); return true; }
    if (!state.isVideo && n.page) { viewer.goToPage(n.page); return true; }
    return false;
  }

  function jumpToNoteOrTip(n) {
    if (jumpToNote(n)) return;
    U.toast('这条笔记没有引用摘录，也没有页码，无法定位', '', 2600);
  }

  /* 删一条笔记：挂在摘录上的只清笔记正文（摘录与图片留着），自由笔记整条删 */
  function removeNoteEntry(n) {
    if (!n || !state.data) return;
    const meta = {
      docId: state.item && state.item.id,
      docKey: Store.docKey({ itemId: state.item && state.item.id, filePath: state.item && state.item.filePath, name: state.item && state.item.name }),
      docName: state.item ? state.item.name : ''
    };
    if (n.kind === 'ann') {
      const ann = state.data.annotations.find((a) => a.id === n.annId);
      if (!ann) return;
      Store.pushTrash(Object.assign({ id: U.uid('tr'), kind: 'note' }, meta, {
        payload: {
          id: U.uid('nt'), md: ann.note || '', quote: ann.text || '',
          page: ann.page, image: ann.image || '', imagePath: ann.imagePath || '',
          filePath: ann.filePath || '', attachments: ann.attachments || []
        }
      }));
      /* 关键：不清 image。图片属于摘录本身，删笔记把人家的图一起删掉是越界 */
      updateAnnotation(ann, { note: '', attachments: [] });
    } else {
      const list = state.data.notes || [];
      const idx = list.findIndex((x) => x.id === n.noteId);
      const rec = idx >= 0 ? list[idx] : null;
      if (!rec) return;
      Store.pushTrash(Object.assign({ id: U.uid('tr'), kind: 'note' }, meta, { payload: rec }));
      list.splice(idx, 1);
      persist();
      renderNotes();
      Undo.push('删除笔记', () => {
        state.data.notes = state.data.notes || [];
        state.data.notes.splice(Math.min(idx, state.data.notes.length), 0, rec);
        persist();
        renderNotes();
        scrollNoteTo('note:' + rec.id);
        syncLater();                 // 撤销回来也要让 Eagle 注释跟着回来
      });
    }
    state.activeNoteKey = null;
    U.toast('已移入回收站（保留 30 天）', 'ok', 1800);
    /* 删除必须**立刻**落到 Eagle 注释上，不能等那 1.2 秒的防抖：
       用户很可能删完就关窗，拖过去的结果就是「插件里没了、注释里还在」。 */
    syncLater.cancel();
    syncNotesToEagle(true);
  }

  /* Delete 删「当前选中的那一块」。笔记栏优先于摘录栏：
     两栏的选中态互斥（点一边会清另一边），但保险起见按这个顺序取。 */
  function deleteSelection() {
    if (!state.data) return false;
    if (state.activeNoteKey) {
      const n = collectNotes().find((x) => x.key === state.activeNoteKey);
      if (n) { removeNoteEntry(n); return true; }
      state.activeNoteKey = null;
    }
    if (state.activeAnnId) {
      const ann = state.data.annotations.find((a) => a.id === state.activeAnnId);
      if (ann) { removeAnnotation(ann); return true; }
      state.activeAnnId = null;
    }
    return false;
  }

  async function onNoteListClick(e) {
    const card = e.target.closest('.note-card');
    if (!card) return;
    const key = card.dataset.key;
    const notes = collectNotes();
    const n = notes.find((x) => x.key === key);
    if (!n) return;
    const act = e.target.dataset && e.target.dataset.act;

    /* 点卡片本身 = 选中 + 跳到来源（以前只有「定位」按钮能跳，点正文没反应）。
       v4.2.6：单击延时 260ms —— 双击打开阅读页，双击时把这个延时点取消掉。 */
    if (!act) {
      clearTimeout(card._clickT);
      card._clickT = setTimeout(() => {
        card._clickT = 0;
        selectNoteCard(key);
        jumpToNoteOrTip(n);
      }, 260);
      return;
    }

    if (act === 'edit') {
      openComposer(n.kind, n.annId || n.noteId, 'modal');
    } else if (act === 'copy') {
      /* 笔记里的「复制」只复制笔记正文，不带原文引用 */
      const ok = await U.copyText(n.md || '');
      U.toast(ok ? '已复制笔记' : '复制失败', ok ? 'ok' : 'err');
    } else if (act === 'expand') {
      const node = e.target._target;
      if (node) {
        const openNow = node.classList.toggle('expanded');
        e.target.textContent = openNow ? '收起' : '展开全文';
      }
    } else if (act === 'goto') {
      selectNoteCard(key);
      jumpToNoteOrTip(n);
    } else if (act === 'del') {
      removeNoteEntry(n);
    }
  }

  /* ==================== 笔记编辑器 ==================== */
  function makeCtx() {
    return {
      kind: null, id: null, quote: '', page: null, annId: null, originalMd: '', originalAtts: [],
      /* 「摘录并笔记」先建记录再开框：这条路一旦被 Esc 取消，那条刚建的摘录要跟着回滚，
         否则用户看到的是「我取消了，右栏却多出一条空摘录」 */
      freshAnnId: null
    };
  }

  /* 有没有真的改过：Esc 只在「动了内容」时才弹确认，避免翻看笔记也被拦一下 */
  function editorDirty(editor, ctx) {
    if (!editor || !ctx) return false;
    const now = String(editor.getValue() || '');
    if (now !== String(ctx.originalMd || '')) return true;
    const sig = (list) => (list || []).map((a) => a && (a.kind + ':' + (a.itemId || a.path || a.name || ''))).join('|');
    return sig(editor.getAttachments()) !== sig(ctx.originalAtts);
  }

  let panelEditor = null;
  let modalEditor = null;
  const panelCtx = makeCtx();
  const modalCtx = makeCtx();

  function initEditors() {
    /* 双链补全候选（v4.2 层级树：书 → 笔记标题）。投影没开就给空表，
       编辑器组件自己处理空候选（不弹）。老接口 wikiTitles 仍注入作兜底。
       v4.2.3：候选范围扩到全库 —— 顺手（节流）后台同步一次 Eagle 资料库清单，
       新文件/改名进 lib 索引，下次敲字就是新数据；同步在后台跑，不卡输入。 */
    let libSyncAt = 0;
    let libSyncing = false;
    function maybeRefreshLib() {
      if (typeof Projection === 'undefined' || !Projection.libReady() || typeof Bridge === 'undefined') return;
      const now = Date.now();
      if (libSyncing || now - libSyncAt < 60000) return;
      libSyncAt = now;
      libSyncing = true;
      const EXTS = ['pdf', 'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', 'ogv'];
      Bridge.listLibraryItems(EXTS, 3000)
        .then((items) => { try { Projection.libSync(items || []); } catch (e) { /* 索引失败不影响搜索 */ } })
        .catch(() => {})
        .then(() => { libSyncing = false; });
    }
    const wikiTreeOpt = () => {
      maybeRefreshLib();
      return (typeof Projection !== 'undefined' && Projection.libReady())
        ? Projection.wikiTree(currentBookTitle()) : [];
    };
    const wikiTitlesOpt = () => (typeof Projection !== 'undefined' && Projection.libReady())
      ? Projection.wikiTitles(currentBookTitle()) : [];
    /* v4.2.4：底部小编辑区退役 —— 新建笔记统一走居中大窗（btnNoteNew）。
       panelEditor 不再创建（引用处都有 null 守卫，草稿自动保存等逻辑自然短路）。 */
    const btnNoteNew = $('#btnNoteNew');
    if (btnNoteNew) {
      btnNoteNew.addEventListener('click', () => openComposer('free', null, 'modal'));
    }
    const me = $('#modalEditorSlot');
    if (me && typeof NoteEditor !== 'undefined') {
      modalEditor = NoteEditor.create(me, {
        onSave: () => saveFrom(modalEditor, modalCtx, true),
        onCancel: () => tryCloseNoteModal(),
        onInsertQuote: (insert) => insertQuoteInto(modalEditor, modalCtx, insert),
        onAddLocal: pickAttachLocal,
        onAddEagle: pickAttachEagle,
        /* v4.2.7：粘贴图转存媒体库 —— 之前把 base64 长串直接塞进 md，
           编辑态看到一坨编码，原稿还容易把笔记文件撑爆。现在落盘 media/
           目录，笔记里只记 enmedia: 短引用，原稿删了也不丢图。 */
        onPasteImage: async (dataUrl) => {
          try { return Store.saveMediaDataUrl(dataUrl) || ''; } catch (e) { return ''; }
        },
        wikiTree: wikiTreeOpt,
        wikiTitles: wikiTitlesOpt,
        wikiSide: 'right'       // [[ 候选弹编辑器右侧的独立搜索窗
      });
    }
  }

  function resetEditor(editor, ctx) {
    if (!editor) return;
    ctx.kind = null; ctx.id = null; ctx.quote = ''; ctx.page = null; ctx.annId = null;
    ctx.originalMd = '';
    ctx.originalAtts = [];
    ctx.freshAnnId = null;
    editor.clear();
    editor.setHint('新建笔记 · 保存即写入 Eagle', false);
  }

  /* 三种「并笔记」入口的统一命名（v3.25）。
     文字摘录、框选区域、页面锚点最终都落成一条 annotation，
     但用户是从三个不同动作进来的，标题就该各自说清是哪一种。 */
  const NOTE_TITLE = { text: '摘录并笔记', area: '框选并笔记', note: '锚点并笔记' };
  const NOTE_TITLE_HINT = { text: '摘录笔记', area: '框选笔记', note: '锚点笔记' };

  function openComposer(kind, id, mode, opts) {
    if (!state.data) { U.toast('请先打开一个 PDF', 'err'); return; }
    readerPartsReset();   // v4.2.6：从阅读页点「编辑」过来时，先把阅读态还原成编辑态
    const useModal = mode === 'modal';
    const editor = useModal ? modalEditor : panelEditor;
    const ctx = useModal ? modalCtx : panelCtx;
    const o = opts || {};
    if (!editor) return;

    let md = '';
    let quote = '';
    let page = null;
    let atts = [];
    let annId = null;
    let hint = '新建笔记';
    let title = '新建笔记';

    if (kind === 'ann') {
      const ann = state.data.annotations.find((a) => a.id === id);
      if (!ann) { U.toast('找不到这条摘录', 'err'); return; }
      md = ann.note || '';
      quote = ann.text || '';
      page = ann.page;
      atts = (ann.attachments || []).slice();
      annId = ann.id;
      /* v3.25：三种来源统一命名，标题即「我在写哪一种」：
         框选 → 框选并笔记 / 摘录 → 摘录并笔记 / 锚点 → 锚点并笔记。
         已有内容时冠以「编辑」，避免让人以为又要新建一条。 */
      const base = NOTE_TITLE[ann.type] || NOTE_TITLE.text;
      title = md ? '编辑' + base.replace('并笔记', '笔记') : base;
      hint = '第 ' + ann.page + ' 页 · ' + (NOTE_TITLE_HINT[ann.type] || '摘录笔记');
    } else if (kind === 'free' && id) {
      const n = (state.data.notes || []).find((x) => x.id === id);
      if (!n) { U.toast('找不到这条笔记', 'err'); return; }
      md = n.md || '';
      quote = n.quote || '';
      page = n.page || null;
      atts = (n.attachments || []).slice();
      hint = '正在编辑已有笔记';
      title = '编辑笔记';
    }

    ctx.kind = kind || null;
    ctx.id = id || null;
    ctx.quote = quote;
    ctx.page = page;
    ctx.annId = annId;
    ctx.originalMd = md;
    ctx.originalAtts = atts.slice();
    ctx.freshAnnId = o.fresh ? (annId || null) : null;

    editor.setValue(md);
    editor.setAttachments(atts);
    editor.setHint(hint, true);

    if (useModal) {
      const t = $('#nmTitle');
      if (t) t.textContent = title;
      const meta = $('#nmMeta');
      if (meta) {
        meta.textContent = [page ? '第 ' + page + ' 页' : '', state.item ? U.stripExt(state.item.name) : '']
          .filter(Boolean).join(' · ') + (ctx.freshAnnId ? ' · 空着按 Esc 可取消这次摘录' : '');
      }
      const imgAnn = kind === 'ann' ? state.data.annotations.find((a) => a.id === id) : null;
      const q = $('#nmQuote');
      if (q) {
        const hasImg = !!(imgAnn && (imgAnn.image || imgAnn.imagePath));
        if (quote || hasImg) {
          q.hidden = false;
          q.innerHTML = (hasImg ? '<img class="nm-quote-img" alt="摘录图片">' : '')
            + '<span class="nm-quote-label">摘录原文</span>'
            + '<span class="nm-quote-text">' + U.escapeHtml(quote || '［图片摘录］') + '</span>';
          /* v3.28：图片可能只存了路径，异步读回来再贴上 */
          if (hasImg) {
            const im = q.querySelector('.nm-quote-img');
            if (imgAnn.image) { im.src = imgAnn.image; fitImageSize(im, 2); }
            else if (typeof ImgCache !== 'undefined') {
              ImgCache.url(imgAnn.imagePath, { trim: imgAnn.vt === 'shot' || imgAnn.vt === 'clip' })
                .then((u) => { if (u && im.parentNode) { im.src = u; fitImageSize(im, 2); } });
            }
          }
        } else {
          q.hidden = true;
          q.innerHTML = '';
        }
      }
      const ov = $('#noteModal');
      if (ov) ov.hidden = false;
      Esc.push('noteModal', () => closeNoteModalByEsc());
      setTimeout(() => editor.focus(), 60);
    } else {
      editor.focus();
      switchTab('notes');
    }
  }

  /* v3.27：ESC 关笔记框，不再弹「要不要保存」。
     ────────────────────────────────────────────
     那个确认框自己也会压一层 Esc，于是按键序列变成
     「弹框 → 关框 → 又弹框」，用户按多少下都退不出去。
     这就是「刚进插件 ESC 能退，写过笔记之后就退不出去」的真凶 ——
     笔记框一直在（用户没点保存也没点取消），确认框跟着一直在。
     草稿本来就是随打随存，这里静默保存后关闭，什么都不问；
     ✕ 按钮与点击外部仍然走 tryCloseNoteModal（那里问一句是对的，用户是主动关闭）。 */
  function closeNoteModalByEsc() {
    const ov = $('#noteModal');
    if (!ov || ov.hidden) { Esc.remove('noteModal'); return; }
    /* v4.2.8：Esc 不再静默自动保存 —— 有未保存内容时弹三键确认
       （取消 / 不保存 / 保存），和点 ✕、点取消走同一个 tryCloseNoteModal。
       阅读页态没有编辑器内容，照旧直接关。 */
    tryCloseNoteModal();
  }

  /* 关闭大笔记框：有内容时先问一句，避免误关丢字 */
  async function tryCloseNoteModal() {    const ov = $('#noteModal');
    if (!ov || ov.hidden) return;
    if (modalEditor && modalEditor.hasContent() && editorDirty(modalEditor, modalCtx) && !modalSaving) {
      const r = await confirmDialog('关闭笔记框', '笔记还没保存，要保存后再关闭吗？', [
        { label: '取消', value: 'cancel' },
        { label: '不保存', value: 'discard', danger: true },
        { label: '保存', value: 'save', primary: true }
      ]);
      if (r === 'cancel') return;
      if (r === 'save') { saveFrom(modalEditor, modalCtx, true); return; }
    }
    closeNoteModal(true);
  }

  let modalSaving = false;

  /* 「摘录并笔记」被取消：把这次操作顺带建出来的摘录一起撤掉。
     不进回收站、不记撤销 —— 这本来就等于没发生过。 */
  function rollbackFresh(ctx) {
    if (!ctx || !ctx.freshAnnId || !state.data) return false;
    const ann = state.data.annotations.find((a) => a.id === ctx.freshAnnId);
    ctx.freshAnnId = null;
    if (!ann) return false;
    detachAnn(ann);
    refreshAnnotations(ann.page);
    U.toast('已取消，这次摘录没有保留', '', 2000);
    return true;
  }

  function closeNoteModal(force) {
    const ov = $('#noteModal');
    if (ov) ov.hidden = true;
    Esc.remove('noteModal');
    readerPartsReset();          // v4.2.6：阅读页态也要还原成编辑器态
    rollbackFresh(modalCtx);     // 只有「还没保存 + 是本次新建」才会真的动手
    resetEditor(modalEditor, modalCtx);
    resumeVideo();               // 视频模式下：笔记写完/放弃后，接着播
    if (!force) return;
  }

  /* ===== v4.2.6 笔记阅读页（只读大窗）=====
     双击笔记/摘录卡片打开：渲染好的全文 + 原文引用；「✎ 编辑」进编辑器，Esc 关闭。
     与编辑器共用 noteModal 弹窗，靠隐藏编辑器槽位 / 显示阅读区切换。 */
  let readerTarget = null;
  function readerPartsReset() {
    const read = $('#nmRead');
    if (read) { read.hidden = true; read.innerHTML = ''; }
    const slot = $('#modalEditorSlot');
    if (slot) slot.hidden = false;
    const foot = $('#nmReadFoot');
    if (foot) foot.hidden = true;
    readerTarget = null;
  }
  function openReaderOverlay(title, metaText, html, target) {
    readerPartsReset();
    readerTarget = target;
    const t = $('#nmTitle');
    if (t) t.textContent = title;
    const meta = $('#nmMeta');
    if (meta) meta.textContent = metaText || '';
    const q = $('#nmQuote');
    if (q) { q.hidden = true; q.innerHTML = ''; }
    const slot = $('#modalEditorSlot');
    if (slot) slot.hidden = true;
    const read = $('#nmRead');
    if (read) { read.innerHTML = html; read.hidden = false; }
    const foot = $('#nmReadFoot');
    if (foot) foot.hidden = false;
    const ov = $('#noteModal');
    if (ov) ov.hidden = false;
    Esc.remove('noteModal');
    Esc.push('noteModal', () => closeReader());
  }
  function closeReader() {
    readerPartsReset();
    const ov = $('#noteModal');
    if (ov) ov.hidden = true;
    Esc.remove('noteModal');
    renderNotes();
  }
  function openNoteReader(n) {
    if (!n) return;
    const parts = [];
    if (n.quote) {
      parts.push('<div class="nc-source"><span class="nc-source-label">'
        + U.escapeHtml(n.t != null ? '摘自 ' + placeLabel(n) : (n.page ? '摘自第 ' + n.page + ' 页' : '摘录原文'))
        + '</span><div class="nc-source-text">' + U.escapeHtml(n.quote) + '</div></div>');
    }
    parts.push(n.md
      ? Markdown.render(n.md)
      : '<div class="ns-empty">这条笔记还没有正文 —— 点「✎ 编辑」写一条</div>');
    if (n.atts) parts.push('<div class="ns-hint">⧉ ' + n.atts + ' 个附件</div>');
    openReaderOverlay(
      n.quote ? '摘录笔记' : '笔记',
      [n.page ? '第 ' + n.page + ' 页' : '', state.item ? U.stripExt(state.item.name) : '']
        .filter(Boolean).join(' · '),
      parts.join('\n'),
      { kind: n.kind || 'free', id: n.annId || n.noteId || n.key }
    );
  }
  function openAnnReader(ann) {
    if (!ann) return;
    const parts = [];
    if (ann.text) {
      parts.push('<div class="nc-source"><span class="nc-source-label">摘录原文 · 第 ' + (ann.page || '?') + ' 页</span>'
        + '<div class="nc-source-text">' + U.escapeHtml(ann.text) + '</div></div>');
    } else if (ann.image || ann.imagePath) {
      parts.push('<div class="nc-source"><span class="nc-source-label">图片摘录 · 第 ' + (ann.page || '?') + ' 页</span>'
        + '<img class="nm-read-img" alt="摘录图片"></div>');
    }
    parts.push(ann.note
      ? Markdown.render(ann.note)
      : '<div class="ns-empty">这条摘录还没有笔记 —— 点「✎ 编辑」写一条</div>');
    openReaderOverlay(
      (ann.type && NOTE_TITLE[ann.type]) ? NOTE_TITLE[ann.type].replace('并笔记', '笔记') : '摘录',
      ['第 ' + (ann.page || '?') + ' 页', state.item ? U.stripExt(state.item.name) : '']
        .filter(Boolean).join(' · '),
      parts.join('\n'),
      { kind: 'ann', id: ann.id }
    );
    /* 图片摘录：路径异步读回 */
    if (!ann.text && (ann.image || ann.imagePath)) {
      const im = $('#nmRead .nm-read-img');
      if (im) {
        if (ann.image) { im.src = ann.image; fitImageSize(im, 2); }
        else if (typeof ImgCache !== 'undefined') {
          ImgCache.url(ann.imagePath, { trim: ann.vt === 'shot' || ann.vt === 'clip' })
            .then((u) => { if (u && im.parentNode) { im.src = u; fitImageSize(im, 2); } });
        }
      }
    }
  }

  function saveFrom(editor, ctx, isModal) {
    if (!state.data) { U.toast('请先打开一个 PDF', 'err'); return; }
    const md = String(editor.getValue() || '').trim();
    const atts = editor.getAttachments();
    if (!md && !atts.length) { U.toast('笔记内容为空', 'err'); return; }

    modalSaving = true;
    if (ctx.kind === 'ann' && ctx.id) {
      const ann = state.data.annotations.find((a) => a.id === ctx.id);
      if (ann) updateAnnotation(ann, { note: md, attachments: atts });
    } else if (ctx.kind === 'free' && ctx.id) {
      const n = (state.data.notes || []).find((x) => x.id === ctx.id);
      if (n) {
        const oldMd = n.md;
        n.md = md;
        n.attachments = atts;
        n.updatedAt = Date.now();
        persist();
        renderNotes();
        Undo.push('修改笔记', () => {
          n.md = oldMd;
          persist();
          renderNotes();
          syncLater();
        });
      }
    } else {
      state.data.notes = state.data.notes || [];
      const rec = {
        id: U.uid('nt'),
        md,
        quote: ctx.quote || '',
        page: ctx.page || null,
        annId: ctx.annId || null,
        image: '',
        attachments: atts,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      state.data.notes.push(rec);
      persist();
      renderNotes();
      scrollNoteTo('note:' + rec.id);
      Undo.push('新增笔记', () => {
        state.data.notes = (state.data.notes || []).filter((x) => x.id !== rec.id);
        persist();
        renderNotes();
        syncLater();
      });
    }

    ctx.originalMd = md;
    ctx.originalAtts = atts.slice();
    ctx.freshAnnId = null;       // 已经落到笔记里，关框时不能再回滚这条摘录
    U.toast('已保存到 Eagle', 'ok', 1200);
    if (isModal) closeNoteModal(true); else resetEditor(editor, ctx);
    modalSaving = false;
    syncLater();
  }

  function insertQuoteInto(editor, ctx, insert) {
    let quote = ctx.quote;
    let page = ctx.page;
    if (!quote && state.lastExcerptId && state.data) {
      const ann = state.data.annotations.find((a) => a.id === state.lastExcerptId);
      if (ann) { quote = ann.text || ''; page = ann.page; }
    }
    if (!quote) { U.toast('先在正文里拖选文字摘录，再引用', '', 2400); return; }
    const block = '> ' + quote.split('\n').join('\n> ')
      + (page ? '\n>\n> ——第 ' + page + ' 页' : '') + '\n\n';
    insert(block);
  }

  /* ==================== 附件（v4.2.7：本地文件先复制副本进媒体库） ====================
     之前只记录地址，原稿一删 / 一挪，笔记里的附件就断了 —— 用户明确要求
     「原始材料删除或位置转移后，不要影响笔记内容和引用内容」。
     现在选中的本地文件先 copyFileSync 进 <dataDir>/media/，笔记记副本路径；
     复制失败（盘符不可读等）才退回原路径。Eagle 条目本身在库里，不受此影响。 */
  async function pickAttachLocal() {
    if (!Bridge.hasEagle) { U.toast('附件需要在 Eagle 中使用', 'err'); return null; }
    const paths = await Bridge.pickAnyFile({ filters: [{ name: '所有文件', extensions: ['*'] }] });
    if (!paths || !paths.length) return null;
    return paths.map((p) => {
      const copy = Store.copyMedia(p);
      const finalPath = copy || p;
      return {
        kind: 'file',
        path: finalPath,
        name: String(p).split(/[\\/]/).pop(),
        ext: U.extOf(finalPath),
        copied: !!copy
      };
    });
  }

  async function pickAttachEagle() {
    if (!Bridge.hasEagle) { U.toast('请先连接 Eagle', 'err'); return null; }
    return openPicker();
  }

  let pickResolver = null;
  let pickChosen = new Map();

  function openPicker() {
    const ov = $('#eaglePicker');
    if (!ov) return null;
    ov.hidden = false;
    pickChosen = new Map();
    const list = $('#pickList');
    if (list) list.innerHTML = '<div class="pick-empty">输入名称或标签搜索资源库…</div>';
    const add = $('#btnPickAdd');
    if (add) add.disabled = true;
    const st = $('#pickStatus');
    if (st) st.textContent = '只记录条目地址，不复制文件';
    setTimeout(() => { const i = $('#pickSearch'); if (i) { i.value = ''; i.focus(); } }, 50);
    Esc.push('picker', () => closePicker());
    return new Promise((resolve) => { pickResolver = resolve; });
  }

  function closePicker(result) {
    const ov = $('#eaglePicker');
    if (ov) ov.hidden = true;
    Esc.remove('picker');
    const r = pickResolver;
    pickResolver = null;
    if (r) r(result || null);
  }

  async function runPickSearch(q) {
    const list = $('#pickList');
    const st = $('#pickStatus');
    const kw = String(q || '').trim();
    if (!kw) return;
    if (list) list.innerHTML = '<div class="pick-empty">搜索中…</div>';
    const items = await Bridge.searchItems(kw, 60);
    pickChosen = new Map();
    const add = $('#btnPickAdd');
    if (add) add.disabled = true;
    if (!items.length) {
      if (list) list.innerHTML = '<div class="pick-empty">没有匹配的条目（试试更短的关键词）</div>';
      if (st) st.textContent = '0 个结果';
      return;
    }
    if (st) st.textContent = items.length + ' 个结果';
    if (!list) return;
    list.innerHTML = '';
    items.forEach((it) => {
      const row = U.el('div', { class: 'pick-row', 'data-id': it.id });
      row.appendChild(U.el('span', { class: 'pick-ext', text: (it.ext || '?').toUpperCase() }));
      row.appendChild(U.el('span', { class: 'pick-name', text: it.name || it.id }));
      row.addEventListener('click', () => {
        if (pickChosen.has(it.id)) pickChosen.delete(it.id);
        else pickChosen.set(it.id, it);
        row.classList.toggle('on', pickChosen.has(it.id));
        if (add) {
          add.disabled = pickChosen.size === 0;
          add.textContent = pickChosen.size ? '添加所选 (' + pickChosen.size + ')' : '添加所选';
        }
      });
      list.appendChild(row);
    });
  }

  function confirmPick() {
    if (!pickChosen.size) return;
    const list = Array.from(pickChosen.values()).map((it) => ({
      kind: 'eagle',
      itemId: it.id,
      name: it.name || it.id,
      ext: it.ext || ''
    }));
    closePicker(list);
  }

  /* ==================== 摘录动作 ==================== */
  function currentSelectionInfo() {
    if (!viewer) return null;
    const live = viewer.snapshotSelection();
    if (live && (live.groups || []).length) return live;
    return state.pendingSelection || null;
  }

  /* 顶栏两个按钮：文字优先，没有文字时看图片选区 */
  function runCurrentExcerpt(withNote) {
    if (state.isVideo) { videoFrameExcerpt(VideoView.time(), withNote); return; }
    if (!state.doc) { U.toast('请先打开一个 PDF', 'err'); return; }
    if (state.pendingImage) { runImageExcerpt(withNote); return; }
    runExcerptAction(withNote);
  }

  function runExcerptAction(withNote) {
    if (!state.doc) { U.toast('请先打开一个 PDF', 'err'); return; }
    const info = currentSelectionInfo();
    if (!info || !(info.groups || []).length) {
      U.toast('先在正文里拖选一段文字', '', 2200);
      return;
    }
    const created = createHighlights(info, state.currentColor);
    hideToolbar();
    try { viewer.clearSelection(); } catch (e) { /* ignore */ }
    if (!created.length) { U.toast('未取到坐标，请重新拖选', 'err'); return; }
    const ann = created[created.length - 1];
    annMgr.setActive(ann.id);
    if (withNote) openComposer('ann', ann.id, 'modal', { fresh: true });
    else toastCreated(created);
  }

  /* ==================== 笔记导出 / 同步 ==================== */
  function notesAsMarkdown() {
    const notes = collectNotes();
    if (!notes.length) return '';
    return notes.slice().reverse().map((n) => {
      const head = [n.page ? `第 ${n.page} 页` : '笔记', n.quote ? '摘录笔记' : ''].filter(Boolean).join(' · ');
      return `### ${head}\n\n` + (n.quote ? '> ' + n.quote.split('\n').join('\n> ') + '\n\n' : '') + n.md;
    }).join('\n\n');
  }

  async function copyAllNotes() {
    if (!state.data) return;
    const md = notesAsMarkdown();
    if (!md) { U.toast('还没有笔记'); return; }
    const ok = await U.copyText(md);
    U.toast(ok ? '笔记已复制（Markdown）' : '复制失败', ok ? 'ok' : 'err');
  }

  async function exportMarkdown() {
    if (!state.data) return;
    const md = Exporter.buildMarkdown(state.item, state.data);
    const base = U.stripExt(state.item.name || 'PDF') + '-工作笔记-' + U.todayStamp() + '.md';
    const dir = Store.dirOf(state.item.filePath);
    const written = dir ? Store.writeTextFile(dir, base, md) : null;
    if (written) U.toast('已导出：' + written, 'ok', 3200);
    else { Store.downloadText(base, md); U.toast('已导出 Markdown', 'ok'); }
  }

  /* ==================== Eagle 注释：三方统一（v3.27） ====================
     原则（用户明确要求）：Eagle 条目的注释、PDF 文件里的标注、
     插件索引里的摘录/笔记，必须是同一份内容。

     旧实现只把「笔记正文」写进注释，于是出现两种用户看得见的错：
       · 只摘录、没写字的条目 → 注释里空空如也（「PDF 的笔记没进注释」）；
       · 清空之后注释还在（写空串那条路静默失败，没人核对）。
     现在统一由 eagleAnnotationTextFrom() 生成：摘录原文 + 挂在摘录上的笔记 +
     独立笔记，按时间顺序排。写的时候 setAnnotation 会读回核对，不成就重试，
     三次仍不成会告诉用户（不再假装成功）。 */
  let syncFailing = false;
  let syncRetryTimer = null;
  let syncRetryLeft = 0;

  function eagleAnnotationTextFrom(data) {
    if (!data) return '';
    const vtLabel = { shot: '截图', area: '框选', clip: '片段', mark: '打点', sub: '字幕' };
    return AnnText.buildAnnotationText(data, {
      typeLabel: (a) => (a.vt && vtLabel[a.vt]) ? vtLabel[a.vt] : (AnnTypeLabel[a.type] || '摘录'),
      fmtTime: (sec) => ((typeof VideoView !== 'undefined' && VideoView.fmt) ? VideoView.fmt(sec) : String(sec)),
      plain: (md) => Markdown.plain(md)
    });
  }

  function eagleAnnotationText() {
    return eagleAnnotationTextFrom(state.data, {
      itemName: state.item ? state.item.name : '',
      isVideo: !!state.isVideo
    });
  }

  async function syncNotesToEagle(silent) {
    if (!state.data) return;
    if (!state.item || !state.item.id) {
      if (!silent) U.toast('本地文件没有 Eagle 条目，笔记只保存在插件索引里', '', 3000);
      return;
    }
    if (!Bridge.hasEagle) {
      if (!silent) U.toast('当前不在 Eagle 中运行，无法写入注释', 'err');
      return;
    }
    const id = state.item.id;
    const text = eagleAnnotationText();
    try {
      await Bridge.setAnnotation(id, text);
      syncFailing = false;
      syncRetryLeft = 0;
      if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
    } catch (err) {
      console.warn('[sync] 写注释失败', err, { id, len: text.length });
      if (!silent) {
        U.toast('写入 Eagle 注释失败：' + (err.message || err), 'err', 4000);
      } else if (!syncFailing) {
        syncFailing = true;
        U.toast('笔记没能写进 Eagle 注释，正在自动重试', 'err', 3200);
      }
      /* 自动重试：Eagle 的 IPC 在刚启动/刚入库时会短暂不可用，
         隔几秒再写往往就成了。最多 3 次，不无限骚扰。 */
      if (syncRetryLeft < 3 && !syncRetryTimer) {
        syncRetryLeft++;
        syncRetryTimer = setTimeout(() => {
          syncRetryTimer = null;
          syncNotesToEagle(true);
        }, 2500 * syncRetryLeft);
      }
    }
  }

  /* ==================== 批注浮层 ==================== */
  function openPopover(ann, anchor) {
    popoverAnn = ann;
    const pop = $('#notePopover');
    pop.hidden = false;
    $('#npMeta').textContent = `第 ${ann.page} 页 · ${AnnTypeLabel[ann.type] || ''}`;
    $('#npText').value = ann.note || '';

    const pr = pop.getBoundingClientRect();
    let left = window.innerWidth - pr.width - 40;
    let top = 90;
    if (anchor) {
      if (anchor.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        left = r.left + r.width / 2 - pr.width / 2;
        top = r.bottom + 8;
      } else if (typeof anchor.x === 'number') {
        left = anchor.x - pr.width / 2;
        top = anchor.y + 12;
      }
    }
    left = U.clamp(left, 12, window.innerWidth - pr.width - 12);
    top = U.clamp(top, 56, window.innerHeight - pr.height - 12);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    Esc.push('popover', () => commitPopover());
    setTimeout(() => $('#npText').focus(), 30);
  }

  function closePopover() {
    $('#notePopover').hidden = true;
    popoverAnn = null;
    Esc.remove('popover');
  }

  function savePopover() {
    if (!popoverAnn) return;
    const text = $('#npText').value.trim();
    if (!text && popoverAnn.type === 'note') {
      removeAnnotation(popoverAnn, true);
      closePopover();
      U.toast('空白锚点已移除');
      return;
    }
    updateAnnotation(popoverAnn, { note: text });
    closePopover();
    U.toast('笔记已保存', 'ok', 1400);
    syncLater();
  }

  function commitPopover() {
    if (!popoverAnn) return;
    const text = $('#npText').value.trim();
    if (text === (popoverAnn.note || '')) { closePopover(); return; }
    if (!text && popoverAnn.type === 'note') { removeAnnotation(popoverAnn, true); closePopover(); return; }
    updateAnnotation(popoverAnn, { note: text });
    closePopover();
  }

  function deletePopoverAnn() {
    if (!popoverAnn) return;
    removeAnnotation(popoverAnn);
    closePopover();
  }

  /* ==================== 页签 / 左栏 ==================== */
  function switchTab(tab) {
    state.tab = tab;
    $$('#panelTabs .panel-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.panel-body').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'notes') renderNotes();
    if (tab === 'kb') renderKbPanel();
  }

  /* ==================== 顶栏弹出面板（v4.1，原左栏） ====================
     目录 / 缩略图 / 字幕三块内容从常驻左栏改为顶栏按键的弹出面板。
     互斥：打开一个先收起其它；ESC 栈各占一个条目，按 ESC 逐层收。 */
  const SIDE_POPS = { outline: 'outlinePop', thumbs: 'thumbsPop', subs: 'subPane' };

  function sidePopBtn(which) {
    return $('#btnPop' + (which === 'subs' ? 'Subs' : which.charAt(0).toUpperCase() + which.slice(1)));
  }
  function syncSidePopBtns() {
    Object.keys(SIDE_POPS).forEach((k) => {
      const el = $('#' + SIDE_POPS[k]);
      const btn = sidePopBtn(k);
      if (btn && el) btn.classList.toggle('active', !el.hidden);
    });
  }
  function closeSidePops(except) {
    Object.keys(SIDE_POPS).forEach((k) => {
      if (k === except) return;
      const el = $('#' + SIDE_POPS[k]);
      if (el && !el.hidden) {
        el.hidden = true;
        Esc.remove('sidepop:' + k);
      }
    });
    syncSidePopBtns();
  }
  function toggleSidePop(which, force) {
    const el = which ? $('#' + SIDE_POPS[which]) : null;
    if (!el) return;
    const open = typeof force === 'boolean' ? force : el.hidden;
    closeSidePops(which);
    if (!open) {
      el.hidden = true;
      Esc.remove('sidepop:' + which);
      syncSidePopBtns();
      return;
    }
    el.hidden = false;
    if (which === 'outline') state.leftTab = 'outline';
    if (which === 'thumbs') {
      state.leftTab = 'thumbs';
      renderThumbs();
    }
    if (!Esc.has('sidepop:' + which)) Esc.push('sidepop:' + which, () => toggleSidePop(which, false));
    syncSidePopBtns();
  }

  function renderOutline(outline) {
    const wrap = $('#outlineList');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.doc) {
      wrap.innerHTML = '<div class="pane-empty">尚未打开文档<br>打开 PDF 后在此显示目录</div>';
      return;
    }
    if (!outline || !outline.length) {
      wrap.innerHTML = '<div class="pane-empty">此文档没有内嵌目录<br>可用缩略图或页码跳转</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const node of outline) {
      const row = U.el('div', { class: 'ol-item depth-' + node.depth });
      row.appendChild(U.el('span', { text: node.title }));
      if (node.page) {
        row.appendChild(U.el('span', { class: 'ol-page', text: 'p.' + node.page }));
        row.addEventListener('click', () => viewer.goToPage(node.page));
      }
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
  }

  function renderThumbs() {
    const list = $('#thumbList');
    if (!list) return;
    if (!state.doc) {
      list.innerHTML = '<div class="pane-empty">尚未打开文档<br>打开 PDF 后在此显示页面缩略图</div>';
      return;
    }
    /* v4.1：缩略图面板的 DOM 常驻（弹窗开关只切 hidden），
       已经建过就只同步当前页高亮，不整列重画。换文档时 thumbsBuilt 会被清掉。 */
    if (state.thumbsBuilt && list.childElementCount) {
      updateActiveThumb(viewer.current);
      return;
    }

    if (state.thumbObserver) { state.thumbObserver.disconnect(); state.thumbObserver = null; }
    const pane = $('#thumbPane');
    const width = Math.max(80, (pane.clientWidth || 200) - 22);
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= state.doc.numPages; i++) {
      const item = U.el('div', { class: 'thumb-item', 'data-page': String(i) });
      item.appendChild(U.el('canvas'));
      item.appendChild(U.el('span', { class: 'thumb-num', text: String(i) }));
      item.addEventListener('click', () => viewer.goToPage(i));
      frag.appendChild(item);
    }
    list.appendChild(frag);
    state.thumbsBuilt = true;
    updateActiveThumb(viewer.current);

    if (typeof IntersectionObserver !== 'function') {
      U.$$('.thumb-item', list).forEach((el) => {
        viewer.renderThumb(+el.dataset.page, el.querySelector('canvas'), width).catch(() => {});
      });
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const el = en.target;
        io.unobserve(el);
        if (el.dataset.rendered === '1') return;
        el.dataset.rendered = '1';
        viewer.renderThumb(+el.dataset.page, el.querySelector('canvas'), width)
          .catch(() => { el.dataset.rendered = ''; });
      });
    }, { root: pane, rootMargin: '500px 0px' });
    U.$$('.thumb-item', list).forEach((el) => io.observe(el));
    state.thumbObserver = io;
  }

  function updateActiveThumb(n) {
    $$('#thumbList .thumb-item').forEach((el) => {
      el.classList.toggle('active', +el.dataset.page === n);
    });
  }

  /* v4.1：阅读历史仍照常记入 Store（工作台「最近阅读」用同一份数据），
     只是左栏那块常驻 UI 随左栏一起移除了，不再有渲染函数。 */
  function rememberHistory() {
    if (!state.item || !state.item.id) return;
    Store.pushHistory({
      itemId: state.item.id || null,
      name: state.item.name || '',
      filePath: state.item.filePath || null,
      page: (viewer && viewer.current) || 1
    });
  }

  const historyLater = U.debounce((page) => {
    if (!state.item) return;
    Store.pushHistory({
      itemId: state.item.id || null,
      name: state.item.name || '',
      filePath: state.item.filePath || null,
      page
    });
  }, 2500);

  /* ==================== 全文搜索（v3.3） ====================
     输入框常驻顶栏 → 边输边搜 → 结果列表弹在搜索框下方 → 阅读区打临时标记 → Enter 逐个跳。
     临时标记只活在内存里，和「真正写进 PDF 的高亮」是两套东西。

     v3.3.2 的两处改动，都是对着「用起来难受」去的：
       1. 结果从右下浮层挪到搜索框正下方 —— 浮层会盖住正文，锚定搜索框看得见来源；
       2. 逐个跳不再重建 DOM、不再平滑滚动 —— 之前每跳一次都把每一页的
          searchLayer 全部 innerHTML 清空重建 + 触发一次 720ms 的翻页闪白，
          看起来就是整个阅读区在闪。现在只切 active 类，滚动改瞬时。
     v4.1：结果列表从左栏改为弹出面板（#searchPane 锚在搜索框下方）。 */
  function focusSearchInput() {
    const i = $('#searchInput');
    if (!i) return;
    i.focus();
    i.select();
  }

  /* 搜索期间：结果面板弹在搜索框下方（v4.1）
     v4.2.15：改 position:fixed + 精确测宽 —— 之前 absolute 锚 .main，坐标体系
     和 getBoundingClientRect（视口系）不一致，面板位置漂、还把布局撑宽
     （用户实锤：点搜索栏 PDF 左移、面板半截出屏）。
     宽度 = 搜索栏左缘 → 明暗切换键（#btnTheme）右缘，按用户口径。 */
  function showSearchPane() {
    const pane = $('#searchPane');
    if (!pane) return;
    const box = $('#searchBox');
    if (box && !box.hidden) {
      const r = box.getBoundingClientRect();
      const theme = $('#btnTheme');
      const rightEdge = (theme && !theme.hidden)
        ? theme.getBoundingClientRect().right
        : Math.min(r.right, window.innerWidth - 12);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 300));
      const w = Math.max(300, Math.min(Math.round(rightEdge - left), window.innerWidth - 16));
      pane.style.left = Math.round(left) + 'px';
      pane.style.top = Math.round(r.bottom + 6) + 'px';
      pane.style.width = w + 'px';
    }
    pane.hidden = false;
    closeSidePops();
    /* 3.3.3：Esc 在搜索期间只退出搜索，绝不能冒泡到「关插件」那一层。
       所以一进入搜索态就入栈，不等有没有命中 —— 之前只在「有结果」时才入栈，
       于是「无结果」时按 Esc 直接退出了插件。
       已经在栈里就不重复压：每敲一个字都重压会把「搜索」顶到别的浮层之上。 */
    if (!Esc.has('search')) Esc.push('search', clearSearch);
  }

  /* v4.2.17：窗口缩放时已打开的结果面板跟着重定位 —— fixed 坐标是算出来的
     一次性快照，窗口变了就不对位了。面板隐藏时不动。 */
  window.addEventListener('resize', () => {
    const pane = $('#searchPane');
    if (pane && !pane.hidden) showSearchPane();
  });

  /* 退出搜索：收起结果面板 */
  function hideSearchPane() {
    const pane = $('#searchPane');
    if (pane) pane.hidden = true;
  }

  function searchOpen() {
    const p = $('#searchPane');
    return !!(p && !p.hidden);
  }

  async function runSearch(raw) {
    const q = String(raw == null ? '' : raw).trim();
    searchState.q = q;
    if (!q) { clearSearch(); return; }
    if (!state.doc || state.isVideo) { setSearchCount(''); return; }

    showSearchPane();
    const title = $('#searchPaneTitle');
    if (title) title.textContent = '正在搜索…';

    /* 索引按「当前载入的文档」缓存，换文档才重建 */
    if (!Search.ready() || searchState.docToken !== state.loadToken) {
      setSearchCount('索引中');
      if (title) title.textContent = '正在建立全文索引…';
      try {
        await Search.build({
          numPages: state.doc.numPages,
          getPage: (n) => state.doc.proxy.getPage(n)
        }, state.loadToken, (i, n) => {
          if (title) title.textContent = `正在建立全文索引 ${i}/${n}`;
        });
        searchState.docToken = state.loadToken;
      } catch (e) {
        if (title) title.textContent = '索引失败：' + (e.message || e);
        return;
      }
    }

    const hits = Search.find(q);
    hits.forEach((h) => { h.rects = Search.rectsFor(h); });
    searchState.hits = hits;
    searchState.idx = hits.length ? 0 : -1;
    renderSearchResults();
    updateSearchCount();
    /* 只打标记，不自动滚走 —— 边打字边整页跳会让人失去位置感 */
    if (viewer) viewer.setSearchMarks(hits, searchState.idx);
  }

  function stepSearch(dir) {
    if (!searchState.hits.length) {
      const v = $('#searchInput');
      if (v && v.value.trim()) runSearch(v.value);
      return;
    }
    const n = searchState.hits.length;
    searchState.idx = (searchState.idx + (dir >= 0 ? 1 : -1) + n) % n;
    updateSearchCount();
    markActiveRow();
    focusSearchHit(searchState.idx);
  }

  function focusSearchHit(i) {
    const hit = searchState.hits[i];
    if (!hit || !viewer) return;
    viewer.setActiveMark(i);
    viewer.focusSearchMark(hit);
  }

  function setSearchCount(text, isHit) {
    const el = $('#searchCount');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hit', !!isHit);
    ['#btnSearchPrev', '#btnSearchNext', '#btnSearchClear'].forEach((sel) => {
      const b = $(sel);
      if (b) b.hidden = !text;
    });
  }

  function updateSearchCount() {
    const n = searchState.hits.length;
    if (!searchState.q) { setSearchCount(''); return; }
    if (!n) { setSearchCount('无结果'); return; }
    setSearchCount((searchState.idx + 1) + '/' + n, true);
  }

  function clearSearch() {
    searchState.q = '';
    searchState.hits = [];
    searchState.idx = -1;
    searchState.rows = [];
    const input = $('#searchInput');
    if (input && input.value) input.value = '';
    if (viewer) viewer.clearSearchMarks();
    hideSearchPane();
    setSearchCount('');
    const box = $('#searchList');
    if (box) box.innerHTML = '';
    const title = $('#searchPaneTitle');
    if (title) title.textContent = '搜索结果';
    Esc.remove('search');
  }

  /* 结果列表只在「搜索词变了」时重建；逐个跳只切 .on，不碰 DOM 结构 */
  function renderSearchResults() {
    const box = $('#searchList');
    if (!box) return;
    box.innerHTML = '';
    searchState.rows = [];
    const total = searchState.hits.length;
    const title = $('#searchPaneTitle');
    if (title) title.textContent = total ? `${total} 处结果` : '没有结果';

    if (!total) {
      box.appendChild(U.el('div', {
        class: 'lsp-empty',
        text: searchState.q ? '没有匹配「' + searchState.q + '」的内容' : '输入关键字开始搜索'
      }));
      return;
    }

    const frag = document.createDocumentFragment();
    const LIMIT = 400;
    searchState.hits.slice(0, LIMIT).forEach((h, i) => {
      const row = U.el('div', { class: 'sr-item' + (i === searchState.idx ? ' on' : '') });
      row.appendChild(U.el('div', { class: 'sr-page', text: 'p.' + h.page }));
      row.appendChild(U.el('div', {
        class: 'sr-text',
        html: U.escapeHtml(U.truncate(h.before, 40)) +
          '<mark>' + U.escapeHtml(h.match) + '</mark>' +
          U.escapeHtml(U.truncate(h.after, 60))
      }));
      row.addEventListener('click', () => {
        searchState.idx = i;
        updateSearchCount();
        markActiveRow();
        focusSearchHit(i);
      });
      searchState.rows[i] = row;
      frag.appendChild(row);
    });
    if (total > LIMIT) {
      frag.appendChild(U.el('div', { class: 'lsp-empty', text: `只列出前 ${LIMIT} 处，用回车继续往后跳` }));
    }
    box.appendChild(frag);
  }

  /* 把当前命中那一行标出来，并滚进可视区（只动类名，不重建列表） */
  function markActiveRow() {
    const rows = searchState.rows || [];
    rows.forEach((r, i) => { if (r) r.classList.toggle('on', i === searchState.idx); });
    const cur = rows[searchState.idx];
    if (cur && typeof cur.scrollIntoView === 'function') {
      try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    }
  }

  /* ==================== 持久化 ==================== */
  const persistLater = U.debounce(() => persist(), 1200);

  /* 投影层的元信息：条目 id / 书名 / 类型 / 标签 / 所在库名。
     标签和库名只用于 MD 头部的 frontmatter —— 让外部工具（Obsidian、RAG）
     不必再回头查 Eagle 就能知道这条笔记属于哪本书、哪个库。 */
  /* ---------- v4.3.0 Obsidian 双向同步 ----------
     vault = <库>\.eaglenote\闪灵笔记 - <库名>\（v4.3.2 按库名命名，随库迁移）。
     JSON 永远是权威数据；
     md 是投影 + 手改回流通道。用户承诺不两边同时改，冲突兜底策略：
     md 为准、被覆盖的旧值落 .conflict 文件（writeConflictFile），绝不静默丢。 */
  function startProjSync() {
    if (typeof Projection === 'undefined' || !Projection.setHooks) return;
    Projection.setHooks({
      /* writeNow 写前发现 md 被手改 → 在这里落回权威 JSON。
         Projection 内部 inExternal 守卫保证嵌套 writeNow 不会再触发合并，无循环风险。 */
      onExternal: (meta, data, edits) => {
        let n = 0;
        try { n = Projection.applyEdits(edits) || 0; } catch (e) { n = 0; }
        if (n > 0) {
          try { Store.save(meta, data); } catch (e) { console.warn('[ProjSync] 合并落盘失败', e); }
          try { renderNotes(); } catch (e) { /* 无列表场景忽略 */ }
          try { renderExcerpts(); } catch (e) { /* ignore */ }
        }
      },
      onMerged: (meta, data, edits) => {
        try { U.toast('已从 Obsidian 吸回 ' + edits.length + ' 处修改', '', 2400); } catch (e) { /* ignore */ }
      }
    });
    /* 空闲期扫描：15s 一轮，只 stat 清单里认领过的文件，代价可忽略。
       与当前打开哪本文档无关 —— Obsidian 里改哪本都能吸回来。 */
    if (startProjSync._timer) clearInterval(startProjSync._timer);
    startProjSync._timer = setInterval(() => {
      try {
        if (typeof Projection === 'undefined' || !Projection.isOn || !Projection.isOn()) return;
        Projection.syncExternal();
      } catch (e) { /* ignore */ }
    }, 15000);
    /* v4.4.2：删除对账 —— 启动 8s 后跑一次，之后每 5 分钟一轮。
       全库 item.get 有成本，不塞进 15s 的同步循环；复核 + 备份双保险，
       静默轮自动跳过含手记的 md（交给工作台按钮手动确认）。 */
    if (startProjSync._reconcileKick) clearTimeout(startProjSync._reconcileKick);
    if (startProjSync._reconcileTimer) clearInterval(startProjSync._reconcileTimer);
    startProjSync._reconcileKick = setTimeout(() => {
      try { reconcileDeleted({ silent: true }); } catch (e) { /* ignore */ }
    }, 8000);
    startProjSync._reconcileTimer = setInterval(() => {
      try { reconcileDeleted({ silent: true }); } catch (e) { /* ignore */ }
    }, 300000);
  }

  function projMeta() {
    const it = state.item || {};
    let libraryName = '';
    try { libraryName = (Bridge.state && Bridge.state.libraryName) || ''; } catch (e) { libraryName = ''; }
    return {
      itemId: it.id || null,
      name: it.name || '',
      filePath: it.filePath || '',
      ext: it.ext || '',
      tags: Array.isArray(it.tags) ? it.tags : [],
      libraryName: libraryName
    };
  }

  /* ===== v3.38 AI 总结全文 =====
   * 弹窗、模型通道、流式渲染都在 AiSummary 模块里；这里只负责三件事：
   * 给它文档标题、给它全文提取通道、给它「存成独立笔记」的回调。 */

  function addAiNote(md, quote) {
    state.data.notes = state.data.notes || [];
    const rec = {
      id: U.uid('nt'),
      md: String(md || ''),
      quote: String(quote || ''),
      page: null,
      annId: null,
      image: '',
      attachments: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    state.data.notes.push(rec);
    persist(true);
    renderNotes();
    scrollNoteTo('note:' + rec.id);
    Undo.push('新增笔记(AI 总结)', () => {
      state.data.notes = state.data.notes.filter((x) => x.id !== rec.id);
      persist(true);
      renderNotes();
      syncLater();
    });
    U.toast('已存入笔记', 'ok', 1400);
    syncLater();
  }

  async function extractAllPages(onProgress) {
    /* 已建过搜索索引就直接复用（同一次提取，零成本）；没建过再现场抽 */
    try {
      if (typeof Search !== 'undefined' && Search.ready() && Search.pages().length) {
        return Search.pages().map((p, i) => ({ page: i + 1, text: String(p.text || '') }));
      }
    } catch (e) { /* 索引不可用就走下面的现场提取 */ }
    const n = Number(state.doc && state.doc.proxy && state.doc.proxy.numPages) || 0;
    const out = [];
    for (let i = 1; i <= n; i++) {
      try {
        const pg = await state.doc.proxy.getPage(i);
        const tc = await pg.getTextContent();
        out.push({
          page: i,
          text: (tc.items || []).map((it) => (typeof it.str === 'string' ? it.str : '')).join(' ').trim()
        });
      } catch (e) {
        out.push({ page: i, text: '' });
      }
      if (onProgress && (i % 4 === 0 || i === n)) onProgress(i, n);
    }
    return out;
  }

  function openAiSummary() {
    if (typeof AiSummary === 'undefined' || !AiSummary) {
      U.toast('AI 总结模块未加载', 'err', 2400);
      return;
    }
    AiSummary.open({
      title: state.item && state.item.name ? SaveAs.stripExt(state.item.name) : '',
      getPageTexts: extractAllPages,
      addNote: addAiNote
    });
  }

  function persist(immediate) {
    if (!state.item || !state.data) return;
    if (viewer) {
      state.data.reading = {
        page: viewer.current,
        zoomMode: viewer.zoomMode,
        zoom: viewer.zoom
      };
    }
    const res = Store.save({
      itemId: state.item.id,
      name: state.item.name,
      filePath: state.item.filePath
    }, state.data);
    if (!res.ok) U.toast('保存失败：' + (res.error || '未知错误'), 'err', 3600);

    /* Markdown 投影（v3.11）：打字时攒着晚点写，明确保存时立刻写。
       失败绝不打断阅读 —— 权威数据已经在 JSON 里了，投影丢了下次重建即可。 */
    try {
      if (typeof Projection !== 'undefined' && Projection.isOn()) {
        if (immediate) Projection.writeNow(projMeta(), state.data, false);
        else Projection.schedule(projMeta(), state.data);
      }
    } catch (e) { console.warn('[persist] 投影失败', e); }
  }

  /* ==================== 数据维护 ==================== */
  function openDataDir() {
    const dir = Store.getDataDir();
    if (!dir) { U.toast('索引目录尚未建立（需要在 Eagle 中运行）', 'err', 2600); return; }
    if (!Bridge.showInFolder(dir)) U.toast(dir, '', 4000);
  }

  /* ---------- Markdown 副本（v3.11） ---------- */
  function projDir() {
    try { return (typeof Projection !== 'undefined' && Projection.dirOf()) || null; } catch (e) { return null; }
  }

  function openProjDir() {
    const dir = projDir();
    if (!dir) { U.toast('数据目录尚未建立（需要在 Eagle 资料库中运行）', 'err', 2600); return; }
    if (!Bridge.showInFolder(dir)) U.toast(dir, '', 4000);
  }

  /* v4.2.12：md 投影整体下线 —— openProjHub / changeProjRoot / syncFromDisk /
     installProjHooks / rebuildMarkdown / toggleMdProjection 随功能删除。
     权威数据是 .eaglenote\docs\*.json；别名索引保留在 <库>\.eaglenote。 */

  /* 把一个 PDF 文件里由本插件写入的高亮抹掉。
     清空索引时如果只删 JSON，用户拿别的阅读器打开还是满屏高亮 ——「清空」等于没清。
     先 countMarks 探一下，文件里本来就没有我们的东西就一个字节都不动。 */
  async function clearPdfMarksInFile(filePath) {
    if (!filePath || !PdfWrite.available()) return 0;
    let bytes = null;
    try { bytes = Store.readFileBuffer(filePath); } catch (e) { return 0; }
    if (!bytes) return 0;
    let n = 0;
    try { n = await PdfWrite.countMarks(bytes); } catch (e) { n = -1; }
    if (n <= 0) return 0;
    const dir = Store.getDataDir();
    /* 备份名按文件名固定：同一个 PDF 反复清空只留「清空前的那一份」，不会越堆越多 */
    const base = String(filePath).split(/[\\/]/).pop().replace(/[^\w.\-]/g, '_');
    const bak = dir ? dir + '/pdfbak/clear-' + base : null;
    try {
      const res = await PdfWrite.sync({ filePath, items: [], backupPath: bak });
      return res && res.ok ? n : 0;
    } catch (e) { return 0; }
  }

  /* 这条 Eagle 注释是不是我们写的？
     新版格式直接比对；旧版只写了笔记正文，那些行都能在「现在的正文」里找到，
     用「逐行包含」认回来。认不出的（用户自己敲的字）一律不动。 */
  function annLooksOurs(cur, mine) {
    const a = String(cur || '').trim();
    if (!a) return true;
    if (!mine) return false;
    if (Bridge.annSame(a, mine)) return true;
    const lines = a.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return true;
    return lines.every((l) => mine.indexOf(l) >= 0);
  }

  /* 清空 / 彻底清除（v3.28 增加 wipe 模式）
     clearAllData()            只清「内容」：索引里的摘录、笔记、历史、回收站，以及 PDF 高亮 / Eagle 注释
     clearAllData({wipe:true}) 连插件自己写下的目录一起删：docs/、pdfbak/、index.json、trash.json
     两种都**不动**：PDF 正文、用户自己另存的图片与片段、识别模型。 */
  async function clearAllData(opts) {
    const o = (opts && typeof opts === 'object' && !opts.target) ? opts : {};
    const deep = !!o.wipe;
    const r = await confirmDialog(
      deep ? '清除插件产生的数据' : '清空全部摘录与笔记',
      deep
        ? '会清空插件自己写下的全部内容：索引、每篇的摘录与笔记、阅读历史、回收站、'
          + '工作台的每日笔记、术语表、Markdown 副本、PDF 备份，'
          + '以及摘录时收进素材目录的图片（media/ 里的那些副本），'
          + '并把已写进 PDF 的高亮、Eagle 条目里的注释一并抹掉。\n\n'
          + '不会动：PDF 正文本身、你已经「另存原图 / 另存片段」出去的独立文件、识别模型。'
          + '无法恢复，确定吗？'
        : '会删除插件索引里的所有摘录、笔记、阅读历史与回收站内容，并把已写入 PDF 的高亮、'
          + 'Eagle 条目里的注释一并清空（PDF 正文本身不受影响）。无法恢复，确定吗？',
      [
        { label: '取消', value: 'cancel' },
        { label: deep ? '彻底清除' : '清空', value: 'ok', danger: true }
      ]
    );
    if (r !== 'ok') return;
    hideLoading();
    showLoading('正在清理 PDF 里的高亮…');

    /* 1) 先抹掉 PDF 文件里的注释。索引里的文档 id 就是 Eagle 条目 id，用它换文件路径 */
    const idx = (() => { try { return Store.getIndex(); } catch (e) { return null; } })();
    const ids = Object.keys((idx && idx.docs) || {}).filter((k) => k !== '__daily__');
    if (state.item && state.item.id && ids.indexOf(state.item.id) < 0) ids.push(state.item.id);

    /* v3.27：清空必须「三处一起清」。
       以前只抹 PDF 文件里的高亮、只清当前这一条的 Eagle 注释，
       于是用户在其它文档上看到「插件里空了、PDF 上还亮着、Eagle 注释里还在」。
       这里在删索引之前先记下每篇的预期注释文本，删完再逐条对账清空。 */
    const expected = new Map();
    ids.forEach((id) => {
      try { expected.set(id, eagleAnnotationTextFrom(Store.load({ itemId: id }))); } catch (e) { /* ignore */ }
    });

    let files = 0;
    for (const id of ids) {
      try {
        const it = await Bridge.getItemById(id);
        if (it && it.filePath && await clearPdfMarksInFile(it.filePath)) files++;
      } catch (e) { /* 条目可能已删，跳过 */ }
    }
    /* 本地文件没有 Eagle 条目 id，单独照顾当前这一份 */
    if (state.item && state.item.filePath && !state.item.id) {
      try { if (await clearPdfMarksInFile(state.item.filePath)) files++; } catch (e) { /* ignore */ }
    }

    /* 2) 清 Eagle 注释（先于删索引：text 已经从索引里读出来了） */
    let anns = 0;
    let annsFailed = 0;
    if (Bridge.hasEagle) {
      for (const id of ids) {
        try {
          const cur = await Bridge.getAnnotation(id);
          /* 只有「确实是我们写进去的」才动它：
             · 和新生效的格式完全一致；
             · 或者旧格式（只含笔记正文）—— 它的每一行都能在我们生成的正文里找到。
             用户在 Eagle 里自己敲的、对不上的文字不清 ——
             清空是清插件写进去的东西，不是清用户的字。 */
          const mine = expected.get(id) || '';
          if (!cur.trim()) continue;
          if (!annLooksOurs(cur, mine)) continue;
          await Bridge.setAnnotation(id, '');
          anns++;
        } catch (e) {
          annsFailed++;
          console.warn('[clear] 清 Eagle 注释失败', id, e);
        }
      }
    }

    /* 3) 再清索引与历史 */
    const n = Store.clearAll();
    /* 投影出来的 Markdown 一并撤掉：只删清单认领的文件，用户自己放的东西不动。
       不判 isOn() —— 开关关着时历史副本还躺在磁盘上，那才是最容易漏的残留。 */
    try {
      if (typeof Projection !== 'undefined' && Projection.clearAll) Projection.clearAll();
    } catch (e) { /* ignore */ }
    /* 彻底清除：连插件自己写下的目录一起删（docs/ pdfbak/ index.json trash.json）。
       识别模型（asr/）留着 —— 那是下载来的，删了要重下几百 MB。 */
    let wiped = 0;
    if (deep) {
      try { wiped = Store.wipeAll(); } catch (e) { console.warn('[wipe]', e); }
      try { if (typeof ImgCache !== 'undefined') ImgCache.clear(); } catch (e) { /* ignore */ }
    }
    Store.clearHistory();
    Undo.clear();
    state.data = state.item
      ? Store.load({ itemId: state.item.id, name: state.item.name, filePath: state.item.filePath })
      : null;
    state.activeAnnId = null;
    state.activeNoteKey = null;
    state.lastExcerptId = null;
    state.pdfSync = { sig: null, ok: null, count: 0, reason: null, key: null };
    if (annMgr) annMgr.renderAll();       // 整页重绘：只画可见区会留下上一页的高亮
    renderExcerpts();
    renderNotes();
    renderKbPanel();
    if (typeof Workbench !== 'undefined') Workbench.render();
    hideLoading();
    const parts = ['已清空 ' + n + ' 篇文档的索引'];
    if (deep && wiped) parts.push('删除 ' + wiped + ' 项插件数据文件');
    if (files) parts.push('抹掉 ' + files + ' 个 PDF 里的高亮');
    if (anns) parts.push('清掉 ' + anns + ' 条 Eagle 注释');
    if (annsFailed) parts.push(annsFailed + ' 条注释没清掉（Eagle 拒绝写入）');
    U.toast(parts.join('，'), annsFailed ? '' : 'ok', 4200);
  }

  /* ==================== Eagle 注释巡检（v4.3.1） ====================
     背景：Eagle 注释有三层存储——内存、library-caches 缓存、磁盘 metadata.json。
     插件的正常读写全走官方 API（setAnnotation），Eagle 自己同步三层，
     不会出现「改了还在」。但索引清空之后的注释残留插件自己就够不着了
     （clearAllData 靠索引定位条目）——本巡检不依赖索引，全库直接扫。
     走官方 API 执行，所以运行中就能清，清完界面实时生效。
     守卫：只认定「行首是【摘录|截图|框选|片段|打点|字幕|笔记|锚点 · 】标记」
     的注释为插件写入；用户手打的注释一行都不碰。 */
  function annMarkedOurs(a) {
    const re = /^【(摘录|截图|框选|片段|打点|字幕|笔记|锚点) · /;
    return String(a || '').split(/\r?\n/).some((l) => re.test(l.trim()));
  }

  async function annInspectAll() {
    if (!Bridge.hasEagle) {
      U.toast('不在 Eagle 环境里，注释巡检不可用', '', 4000);
      return;
    }
    U.toast('正在扫描全库注释…', '', 3000);
    const items = await Bridge.getAllItems(['id', 'name', 'annotation']);
    const suspects = (items || []).filter((it) => annMarkedOurs(it.annotation));
    if (!suspects.length) {
      U.toast('巡检完成：全库 ' + (items || []).length + ' 条，没有插件标记的注释残留', 'ok', 6000);
      return;
    }
    /* 复核：item.get 拿到的 annotation 可能是批量快照，逐条 getAnnotation 确认 */
    const confirmed = [];
    for (const it of suspects) {
      try {
        const cur = await Bridge.getAnnotation(it.id);
        if (annMarkedOurs(cur)) confirmed.push({ id: it.id, name: it.name });
      } catch (e) { /* 条目可能已删，跳过 */ }
    }
    if (!confirmed.length) {
      U.toast('巡检完成：批量扫描命中 ' + suspects.length + ' 条，逐条复核后都不是插件标记', 'ok', 6000);
      return;
    }
    const shown = confirmed.slice(0, 5).map((c) => '· ' + (c.name || c.id)).join('\n');
    const more = confirmed.length > 5 ? ('\n… 等共 ' + confirmed.length + ' 条') : '';
    const v = await confirmDialog('Eagle 注释巡检',
      '发现 ' + confirmed.length + ' 条带插件标记的注释：\n' + shown + more +
      '\n\n将走官方 API 清空（Eagle 界面实时生效，内存/缓存/磁盘三层自动同步）。'
      + '您手打的注释不受影响。确定执行？',
      [{ label: '取消', value: 'cancel' },
       { label: '清空这 ' + confirmed.length + ' 条', value: 'ok', danger: true, primary: true }]);
    if (v !== 'ok') return;
    let ok = 0, fail = 0;
    for (const c of confirmed) {
      try { await Bridge.setAnnotation(c.id, ''); ok++; }
      catch (e) { fail++; console.warn('[AnnInspect] 清注释失败', c.id, e); }
    }
    U.toast('巡检完成：扫描 ' + (items || []).length + ' 条，清空 ' + ok + ' 条'
      + (fail ? ('，失败 ' + fail + ' 条（可稍后再点一次重试）') : ''), fail ? '' : 'ok', 7000);
  }

  /* v4.4.2：Eagle 已删条目 → vault 残留 md 的存在性对账。
     现场：视频在 Eagle 里删了，OB 里那篇 md 还在。插件只按自己的 docs/*.json
     生成 md，从不反查 Eagle，于是「只有注释、没进 docs」的条目成了永久死账，
     连「重建全部」都看不见它（重建也只遍历 docs）。

     流程：官方 API 拉全库 id → Projection 找清单孤儿 → 逐条 getById 复核 →
     备份到 vault 外的 deleted-md/ → 回收 md / manifest / 别名 / 写墓碑。
     静默模式（启动空闲轮）自动跳过含「手记」的条目，留给手动按钮确认。
     任何一步 API 拿不到全库清单，都不许清理（防误删）。 */
  async function reconcileDeleted(opts) {
    const o = opts || {};
    if (typeof Projection === 'undefined' || !Projection.isOn || !Projection.isOn()) {
      if (!o.silent) U.toast('Obsidian 同步未开启，无需清理', '', 3000);
      return { ok: false, why: 'proj-off' };
    }
    if (!Bridge.hasEagle) {
      if (!o.silent) U.toast('不在 Eagle 环境里，无法核对资料库', '', 4000);
      return { ok: false, why: 'no-eagle' };
    }
    let items = [];
    try { items = await Bridge.getAllItems(['id', 'name']); } catch (e) { items = []; }
    if (!items || !items.length) {
      if (!o.silent) U.toast('没能读到资料库条目清单，本次不清理（防误删）', '', 4500);
      return { ok: false, why: 'empty-library' };
    }
    const aliveIds = items.map((it) => it && it.id).filter(Boolean);
    let snap;
    try { snap = Projection.syncAliveIds(aliveIds); }
    catch (e) { console.warn('[ProjReconcile] 对账失败', e); return { ok: false, why: 'sync-failed' }; }
    if (!snap || !Array.isArray(snap.candidates)) return { ok: false, why: 'no-candidates-api' };
    const cand = snap.candidates;
    if (!cand.length) {
      if (!o.silent) U.toast('核对完成：全库 ' + aliveIds.length + ' 条，vault 里没有已删条目的残留笔记', 'ok', 4500);
      return { ok: true, removed: 0, revived: snap.revived };
    }
    /* 全量清单可能带缓存或延迟 —— 逐条 getById 复核，取不到才认定真的删了。
       单条查询报错一律保守跳过（宁可留着，不可误删）。 */
    const confirmed = [];
    for (const c of cand) {
      try {
        const it = await Bridge.getItemById(c.id);
        if (!it) confirmed.push(c);
      } catch (e) { /* 保守跳过 */ }
    }
    if (!confirmed.length) {
      if (!o.silent) U.toast('核对完成：' + cand.length + ' 条候选逐条复核后都还在 Eagle 里', 'ok', 4500);
      return { ok: true, removed: 0, revived: snap.revived };
    }
    let todo = confirmed;
    if (o.silent) {
      todo = confirmed.filter((c) => !c.hand);
      if (!todo.length) return { ok: true, removed: 0, skippedHand: confirmed.length };
    } else {
      const shown = confirmed.slice(0, 6)
        .map((c) => '· ' + (c.title || c.id) + (c.hand ? '（含手记）' : '')).join('\n');
      const more = confirmed.length > 6 ? ('\n… 等共 ' + confirmed.length + ' 条') : '';
      const v = await confirmDialog('清理已删除条目',
        'Eagle 里已找不到 ' + confirmed.length + ' 个条目，但 Obsidian 里还留着它们的笔记：\n' + shown + more +
        '\n\n这些 md 会移出 vault，原件备份到 <库>\\.eaglenote\\deleted-md\\（可随时找回）；' +
        '插件清单、别名索引一并清理。确定执行？',
        [{ label: '取消', value: 'cancel' },
         { label: '清理这 ' + confirmed.length + ' 条', value: 'ok', danger: true, primary: true }]);
      if (v !== 'ok') return { ok: false, why: 'cancelled' };
    }
    let r;
    try { r = Projection.pruneOrphans(todo.map((c) => c.id), { skipHand: false }); }
    catch (e) { console.warn('[ProjReconcile] 回收失败', e); return { ok: false, why: 'prune-failed' }; }
    if (!o.silent || r.removed) {
      const tail = r.failed.length ? ('，' + r.failed.length + ' 条备份失败已保留原件') : '';
      U.toast('已回收 ' + r.removed + ' 篇已删条目的笔记（原件已备份）' + tail,
        r.failed.length ? '' : 'ok', 6000);
    }
    return r;
  }

  /* 只清「最近阅读」记录（工作台入口），摘录和笔记一条不动 */
  async function clearHistoryOnly() {
    const r = await confirmDialog('清空阅读历史', '「最近阅读」记录会清空，摘录与笔记不受影响。确定吗？', [
      { label: '取消', value: 'cancel' },
      { label: '清空', value: 'ok', danger: true }
    ]);
    if (r !== 'ok') return;
    Store.clearHistory();
    U.toast('已清空阅读历史', 'ok', 1600);
  }

  /* ==================== 通用确认框 ====================
     v3.3 修了两个问题：
     1) 按钮「看不见」—— U.el 的第二个参数是属性对象，以前传了字符串 class，
        结果 class 和文字都没落上，按钮就是个空壳；现在按 {class, text} 传。
     2) Esc 走显示栈，确认框永远是最上面一层，不会顺手把插件关掉。 */
  let cfResolve = null;

  function confirmDialog(title, text, actions) {
    const ov = $('#confirmOverlay');
    if (!ov) return Promise.resolve(null);
    $('#cfTitle').textContent = title || '确认';
    $('#cfText').textContent = text || '';
    const box = $('#cfActs');
    box.innerHTML = '';
    return new Promise((resolve) => {
      const done = (v) => {
        ov.hidden = true;
        cfResolve = null;
        Esc.remove('confirm');
        resolve(v);
      };
      cfResolve = done;
      (actions || [{ label: '确定', value: 'ok', primary: true }]).forEach((a) => {
        const cls = a.primary ? 'primary-btn sm' : (a.danger ? 'danger-btn sm' : 'ghost-btn sm');
        const b = U.el('button', { class: cls, text: a.label || '确定' });
        if (a.danger) b.dataset.danger = '1';
        b.addEventListener('click', () => done(a.value));
        box.appendChild(b);
      });
      ov.hidden = false;
      Esc.push('confirm', () => done('cancel'));
    });
  }

  /* ==================== 退出 ==================== */
  /* 退出前把「手头这一份」落盘。
     v3.24：这里不再弹「还有没保存的笔记」确认框。
     旧实现在退出路径上弹框，而那个框自己就压在 Esc 栈顶 —— 于是按键序列变成
     「按 ESC 弹框 → 再按一次只是把框关掉 → 第三次又重新弹框」。
     草稿一直在，框就一直弹，用户看到的永远是「按 ESC 什么也没发生、退不出去」。
     笔记本来就是随打随存（persist 有防抖），退出时只需要把编辑器里还没提交的
     那一份写进去，不必打断用户。 */
  function flushDrafts() {
    try {
      const modalOpen = (() => { const m = $('#noteModal'); return m && !m.hidden; })();
      const draftModal = modalOpen && modalEditor && modalEditor.hasContent() && editorDirty(modalEditor, modalCtx);
      const draftPanel = panelEditor && panelEditor.hasContent() && editorDirty(panelEditor, panelCtx);
      if (draftModal) saveFrom(modalEditor, modalCtx, true);
      if (draftPanel) saveFrom(panelEditor, panelCtx, false);
      return !!(draftModal || draftPanel);
    } catch (e) {
      console.warn('[exit] 退出前保存草稿失败', e);
      return false;
    }
  }

  /* ==================== 退出（v3.28 重写） ====================
     四次「ESC 还是不行」之后，翻 Eagle 的 app.asar 才找到真正的出口：
       ipcMain.handle('plugin.window.', (event, { method, value, value2 }) => {
         const bw = BrowserWindow.fromWebContents(event.sender);
         if (bw && bw[method]) return bw[method](value, value2);
       })
     主进程会把**任意** BrowserWindow 方法转发给「发出这条消息的那个窗口」。
     eagle.window 里没有 close（只有 show/hide/minimize…），以前只能退回 hide() ——
     而 hide() 只是把窗口藏起来，浏览器窗口还在，用户看到的就是「按 ESC 毫无反应」，
     连提示条都不会出现（因为代码认为「已经处理过了」）。这就是「没有提示条」的原因。
     现在直接走 IPC：close 走正常关闭流程；400ms 后还在就 destroy（无条件销毁）。
     两条都失败时，界面上给一条谁都看得见的横幅，而不是一个 3 秒就消失的 toast。 */
  function exitFailBanner(text) {
    let box = $('#exitFail');
    if (!box) {
      box = U.el('div', { class: 'exit-fail', id: 'exitFail' });
      box.innerHTML = '<span class="xf-text"></span>'
        + '<button class="ghost-btn xs" data-xf="retry">再试一次</button>'
        + '<button class="ghost-btn xs" data-xf="min">最小化</button>'
        + '<button class="ghost-btn xs" data-xf="hide">知道了</button>';
      document.body.appendChild(box);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-xf]');
        if (!b) return;
        const act = b.getAttribute('data-xf');
        if (act === 'retry') { box.hidden = true; exitPlugin(); return; }
        if (act === 'min') {
          try { window.eagle.window.minimize(); } catch (err) { /* ignore */ }
          return;
        }
        box.hidden = true;
      });
    }
    const t = box.querySelector('.xf-text');
    if (t) t.textContent = text || '没能关掉这个窗口';
    box.hidden = false;
  }

  let exiting = false;

  async function exitPlugin() {
    if (exiting) return;
    exiting = true;
    setTimeout(() => { exiting = false; }, 1500);
    const dbg = (t, v) => { try { if (typeof Dbg !== 'undefined') Dbg.log(t, v); } catch (e) { /* ignore */ } };

    try { flushDrafts(); } catch (e) { console.warn('[exit] 保存草稿失败', e); }
    try { persist(true); } catch (e) { console.warn('[exit] 保存失败', e); }
    /* v4.4.4：数据已落盘，摘掉自己注册的 beforeunload。留着它，Chromium
       会在用户点击过页面之后拦下 window.close()（sticky activation 规则）。
       只摘我们自己这一条，不影响 Eagle 宿主自己的卸载逻辑。 */
    try { if (detachUnloadPersist) detachUnloadPersist(); } catch (e) { /* ignore */ }
    /* 退出前把还没发出去的注释同步立刻发一次（debounce 还压着的那一次）。
       不 await —— 关窗不能被一次 IPC 拖住；写不进去下次打开会对账补上。 */
    try { syncLater.cancel(); syncNotesToEagle(true); } catch (e) { /* ignore */ }

    const alive = () => { try { return !window.closed; } catch (e) { return false; } };

    /* ⓪v4.4.1：关窗前先做身份裁决。
       预览形态下插件跑在 Eagle 主窗口的 <webview> 里，remote.getCurrentWindow()
       和 IPC 的 BrowserWindow.fromWebContents(sender) 都可能指回主窗口；
       对主窗口 close() 会被 Eagle 的「关闭到托盘」拦成最小化 —— 用户实测
       「按 ESC 连同 Eagle 一起最小化」。守卫不过就一个窗口 API 都不碰。 */
    let verdict = { allow: true, allowWindowClose: true, code: 'no-guard' };
    try {
      if (Bridge.closeVerdict) verdict = Bridge.closeVerdict();
      dbg('exit.guard', verdict);
      /* v4.4.3：把取证原始字段也落盘。上次只记裁决码，现场 43 行全是
         no-self-id，却看不出 mode / windowID / parentID，白排查一轮。 */
      if (Bridge.windowIdentity) dbg('exit.env', Bridge.windowIdentity());
    } catch (e) { dbg('exit.guard.err', e); }

    /* v4.4.4：预览窗口 ESC 的最终出口 —— 主进程按 sender 定向关窗。
       v4.4.3 只发 window.close()，实测「不操作 / 只滚轮能退出，点一下就失效」：
       页面注册的 beforeunload + 点击产生的 sticky activation 会让 Chromium
       拦下脚本关窗（现场 00:25 之后成片的 exit.selfclose 就是「按了没关掉」）。
       现在的组合是：
         ① 本函数开头已摘掉自己的 beforeunload 监听；
         ② Bridge.closeCurrent('close') 走主进程 IPC，sender 天然指向本窗口；
         ③ window.close() 降级为 renderer 兜底；
         ④ 320ms 还活着就 closeCurrent('destroy') 强制销毁（绕过一切拦截）；
         ⑤ 900ms 还活着才提示，并把现场裁决记进 debug.log。
       closeCurrent 内部有 closeVerdict 的 allow / allowSenderClose 双闸门：
       Eagle 主窗口、browser、身份不明形态一律拒绝，绝不重演「一起最小化」。
       全程不调用 closeSelf / destroySelf（它们依赖 remote，且可能指回主窗口）。 */
    if (!verdict.allow && verdict.allowWindowClose) {
      const now = Date.now();
      /* 连按 ESC 只发一轮关窗请求；1.2s 后可重试（兜底提示出现后仍按得动） */
      if (now - exitSentAt < 1200) { exiting = false; return; }
      exitSentAt = now;
      dbg('exit.selfclose', verdict);
      try { if (Bridge.focusParent) Bridge.focusParent({ focus: false }); } catch (e) { /* ignore */ }
      let sentIpc = false;
      try { sentIpc = !!(Bridge.closeCurrent && Bridge.closeCurrent('close')); } catch (e) { /* ignore */ }
      dbg('exit.senderclose', { sent: sentIpc, allowSenderClose: !!verdict.allowSenderClose });
      try { window.close(); } catch (e) { /* ignore */ }
      [120, 420].forEach((ms) => setTimeout(() => {
        try { if (Bridge.focusParent) Bridge.focusParent({ focus: false }); } catch (e) { /* ignore */ }
      }, ms));
      /* 主进程 close 被拦（宿主策略 / beforeunload）时的硬兜底 */
      setTimeout(() => {
        if (!alive()) return;
        let destroyed = false;
        try { destroyed = !!(Bridge.closeCurrent && Bridge.closeCurrent('destroy')); } catch (e) { /* ignore */ }
        dbg('exit.senderdestroy', { sent: destroyed });
      }, 320);
      /* 极个别环境连 IPC 都不可用：留一句可执行的兜底提示 */
      setTimeout(() => {
        if (!alive()) return;
        dbg('exit.stillalive', { sentIpc: sentIpc, allowSenderClose: !!verdict.allowSenderClose });
        U.toast('窗口未关闭，请按空格或点 Eagle 的返回退出预览', '', 3200);
      }, 900);
      exiting = false;
      return;
    }

    if (!verdict.allow) {
      /* 只做恢复，不做关闭：万一这一下 ESC 仍旧漏给了 Eagle、把主窗口收走，
         这里把它 restore+show 回来（不抢焦点，插件还开着）。 */
      try { if (Bridge.focusParent) Bridge.focusParent({ focus: false }); } catch (e) { /* ignore */ }
      U.toast('当前是 Eagle 预览视图，为保护主界面不执行关闭；请按空格或点 Eagle 的返回退出预览', '', 3600);
      exiting = false;
      return;
    }

    /* ⓪ v3.30：先把 Eagle 主窗口捞回来。
       用户报「偶发按 ESC 退出插件后，落到一个最小化的 Eagle」——
       不是被我们最小化了，而是 Eagle 本来就缩在托盘/任务栏，
       插件窗口一关，焦点交回去的就是那个最小化窗口，看起来像「被切走了」。
       所以关自己之前，把主窗口 restore → show → focus 一次。 */
    try { if (Bridge.focusParent) Bridge.focusParent(); } catch (e) { /* ignore */ }

    /* ① 主进程关窗（首选）：正常关闭流程，Eagle 能收到 closed 事件。
       Bridge.closeSelf() 内部还有同一道身份守卫，双保险。 */
    let tried = false;
    try { tried = !!(Bridge.closeSelf && Bridge.closeSelf()); } catch (e) { tried = false; }
    /* ② 老办法一起发：window.close() 在个别 Eagle 版本里仍然有效。
       只在守卫通过时才发 —— 预览 webview 形态下它可能触发宿主的收起逻辑。 */
    try { window.close(); } catch (e) { /* ignore */ }

    /* ②b v4.4.1：关窗之后再补两次恢复。任何把 Eagle 主窗口收走的副作用
       （Eagle 自己收到 ESC、预览窗口关闭触发的收起）都在这里被纠正回来。 */
    [120, 420].forEach((ms) => setTimeout(() => {
      try { if (Bridge.focusParent) Bridge.focusParent({ focus: false }); } catch (e) { /* ignore */ }
    }, ms));

    /* ③ 400ms 后还活着 → 无条件销毁。到这一步 close 已经确定被拦住了
       （beforeunload / 主进程策略），再等下去就是「按了没反应」。 */
    setTimeout(() => {
      if (!alive()) return;
      try { if (Bridge.destroySelf) Bridge.destroySelf(); } catch (e) { /* ignore */ }
    }, 400);

    /* ④ 1 秒后还在：把话说清楚，并给一个点得到的出口 */
    setTimeout(() => {
      if (!alive()) return;
      exitFailBanner(tried ? '窗口没能关闭（Eagle 拒绝了关闭请求）' : '窗口没能关闭：当前环境拿不到关窗接口');
    }, 1000);
  }

  /* ==================== 快捷键 ==================== */
  /* Ctrl+Enter 具体存哪一份？按「谁在最上面」排：
     模态（批注浮层 / 笔记大框）> 光标所在的编辑器 > 翻译面板 > 右栏编辑器。
     顺序错了就会「明明在写笔记，回车存进去的却是刚才那条译文」。 */
  function hotSaveTarget(e) {
    const tgt = e && e.target;

    /* 工作台的每日笔记：平时 600ms 防抖自动存，这里让它立刻落盘 */
    const wb = $('#wbDaily');
    if (wb && document.activeElement === wb) {
      return () => {
        const n = (typeof Workbench !== 'undefined' && Workbench.flushDaily) ? Workbench.flushDaily() : 0;
        U.toast(n ? '每日笔记已保存（' + n + ' 字）' : '每日笔记已保存', 'ok', 1600);
      };
    }

    const pop = $('#notePopover');
    if (pop && !pop.hidden) return () => savePopover();

    const nm = $('#noteModal');
    if (nm && !nm.hidden && modalEditor) return () => saveFrom(modalEditor, modalCtx, true);

    /* 光标就在右栏编辑器里：用户写的是这条，别去存翻译框里的译文 */
    if (panelEditor && panelEditor.root && tgt && panelEditor.root.contains(tgt) && panelEditor.hasContent()) {
      return () => saveFrom(panelEditor, panelCtx, false);
    }

    const tp = $('#trPanel');
    if (tp && !tp.hidden && state.tr && state.tr.result) return () => saveTranslation();

    if (panelEditor && panelEditor.hasContent()) return () => saveFrom(panelEditor, panelCtx, false);
    return null;
  }

  /* ==================== Esc 栈体检（v3.23） ====================
     只对「能一眼从 DOM 判断开没开」的层做体检。确认框 / 笔记大框 / 工作台
     这类会挡住数据操作的层故意不在这里判断 —— 未知层一律按「还开着」处理，
     宁可多按一次 ESC，也不能越过确认框把未保存的笔记一起关掉。 */
  const ESC_LAYER_ALIVE = {
    toolbar: () => { const el = $('#selToolbar'); return !!(el && !el.hidden); },
    search: () => {
      const i = $('#searchInput');
      const p = $('#searchPane');
      return !!((i && i.value) || (p && !p.hidden));
    },
    tr: () => { const el = $('#trPanel'); return !!(el && !el.hidden); },
    link: () => { const el = $('#linkPop'); return !!(el && !el.hidden); },
    popover: () => { const el = $('#notePopover'); return !!(el && !el.hidden); },
    picker: () => { const el = $('#eaglePicker'); return !!(el && !el.hidden); },
    /* v3.25：这三个之前漏了。工作台 / 知识库 / 回收站关闭后栈里还留着条目，
       于是每次 ESC 都弹一个已经不存在、看不见的层 —— 表现就是「按了没反应」。
       它们关闭都只改 DOM，栈条目要在这里按可见性回收。 */
    workbench: () => { const el = $('#wbView'); return !!(el && !el.hidden); },
    kb: () => { const el = $('#kbOverlay'); return !!(el && !el.hidden); },
    trash: () => { const el = $('#trashOverlay'); return !!(el && !el.hidden); },
    /* v3.27：这三个是「危险层」，之前**故意**不体检（怕越过确认框把未保存的笔记关掉），
       结果恰恰是它们把 ESC 卡死：笔记框关掉后栈里还留着 noteModal，
       于是每次 ESC 都被判成「有危险层 → 不许强退」，而那一层其实早就不可见了。
       现在按真实 DOM 体检 —— 可见就保留（确认框该被尊重），不可见就回收。 */
    noteModal: () => { const el = $('#noteModal'); return !!(el && !el.hidden); },
    confirm: () => { const el = $('#confirmOverlay'); return !!(el && !el.hidden); },
    clipExport: () => !!(typeof ClipExport !== 'undefined' && ClipExport.isRunning && ClipExport.isRunning()),
    vsArea: () => !!(typeof VideoView !== 'undefined' && VideoView.areaActive && VideoView.areaActive()),
    vsClip: () => !!(state && state.vsClip),
    /* v4.1：顶栏弹出面板（目录 / 缩略图 / 字幕）—— 按 DOM 可见性回收 */
    'sidepop:outline': () => { const el = $('#outlinePop'); return !!(el && !el.hidden); },
    'sidepop:thumbs': () => { const el = $('#thumbsPop'); return !!(el && !el.hidden); },
    'sidepop:subs': () => { const el = $('#subPane'); return !!(el && !el.hidden); }
  };

  function pruneEscLayers() {
    if (typeof Esc === 'undefined' || !Esc.prune) return;
    Esc.prune((name) => {
      const f = ESC_LAYER_ALIVE[name];
      if (!f) return true;
      try { return f(); } catch (e) { return true; }
    });
  }

  /* v3.27：ESC 的最后一道保险 —— 先把「用户眼前还开着的东西」关掉。
     v4.4.0：它排在 exit-plugin 之前 —— 栈可能少一层（某个浮层忘了 push），
     escapeAction 会判成 exit-plugin，先把真实可见的浮层关掉，用户想退还得再按一下。
     这样「关浮层」永远快于「关窗口」，不会一按 ESC 把还开着东西的窗口直接带走。 */
  const ESC_VISIBLE_CLOSERS = [
    ['confirmOverlay', () => { if (typeof cfResolve === 'function') cfResolve('cancel'); }],
    ['noteModal', () => closeNoteModalByEsc()],
    ['notePopover', () => closePopover()],
    ['linkPop', () => closeLinkPop()],
    ['eaglePicker', () => closePicker()],
    ['trPanel', () => hideTr()],
    ['kbOverlay', () => { if (typeof KnowledgeBase !== 'undefined') KnowledgeBase.close(); }],
    ['trashOverlay', () => { if (typeof Trash !== 'undefined') Trash.close(); }],
    ['wbView', () => { if (typeof Workbench !== 'undefined') (Workbench.escBack || Workbench.close)(); }],
    ['selToolbar', () => hideToolbar()],
    /* v4.1：弹出面板兜底（栈条目万一丢了也能被关掉） */
    ['outlinePop', () => toggleSidePop('outline', false)],
    ['thumbsPop', () => toggleSidePop('thumbs', false)],
    ['subPane', () => toggleSidePop('subs', false)],
    ['searchPane', () => clearSearch()]
  ];

  function closeVisibleOverlay() {
    for (let i = 0; i < ESC_VISIBLE_CLOSERS.length; i++) {
      const id = ESC_VISIBLE_CLOSERS[i][0];
      const f = ESC_VISIBLE_CLOSERS[i][1];
      const el = $('#' + id);
      if (!el || el.hidden) continue;
      try { f(); } catch (e) { console.warn('[Esc] 关闭 ' + id + ' 失败', e); }
      return true;
    }
    return false;
  }

  /* 最近一次真正处理 ESC 的时间，用于 keyup 兜底去重 */
  let escLastAt = 0;
  /* 全屏时只把「第一下 ESC」让给浏览器，避免残留全屏状态把 ESC 永久吞掉 */
  let escFsPassed = false;

  /* v4.4.0：ESC 最后一级改回「关闭插件」（用户要求），escExitHint 连同它的
     8 秒去重一起退役 —— 「按了没反应」本身就不存在了。决策点在 escguard.js。 */
  function onKeyDown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (state.isVideo) { U.toast('视频模式没有全文搜索', '', 1400); return; }
      focusSearchInput();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); persist(true); U.toast('已保存', 'ok', 1400); return;
    }
    /* Ctrl+W：和浏览器/编辑器一致的关窗手势。ESC 的按键通路在某些原生控件里
       会被吞掉，多一条路总没坏处。 */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
      e.preventDefault(); exitPlugin(); return;
    }
    /* ---------- Ctrl / ⌘ + N：新建笔记（v4.3.3）----------
       与「✎ 新建笔记」按钮同一个入口。大笔记框已经开着时绝不重开 ——
       openComposer 会重置草稿上下文，误按一下就把正写的字清了；
       此时只把光标送回编辑器。 */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      const ov = $('#noteModal');
      if (ov && !ov.hidden) { if (modalEditor) modalEditor.focus(); return; }
      openComposer('free', null, 'modal');
      return;
    }

    /* ---------- Ctrl / ⌘ + Enter：保存手头这一份 ----------
       笔记编辑器自己绑了一份，但那只在光标停在正文里时才响 —— 点了预览、点了附件、
       焦点被浮层抢走，或者用拼音输入法正选词，那一下都会落空。
       这里做应用级兜底：谁在最上面就存谁，不看焦点在哪。 */
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      /* 输入法选词时的 Enter 是「确认候选」，绝不能当成保存 */
      if (e.isComposing || e.keyCode === 229) return;
      const fn = hotSaveTarget(e);
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();     // 拦住编辑器自己那份，别存两次
      fn();
      return;
    }

    if (e.key === 'Escape') {
      escLastAt = Date.now();
      /* v3.31：这一行必须在所有 early return 之前。
         以前它在流程末尾，于是「输入法选词」「真全屏」这两条提前返回的分支
         不会被认领，index.html 那段内联兜底 900ms 后就把窗口关了 ——
         用户看到的就是「按 ESC 把 Eagle 也退了」。现在内联兜底已删，
         这行仍然保留：它同时是「ESC 被我们接管」的唯一标记。 */
      window.__escHandledAt = Date.now();
      /* 中文输入法选词时按下的 ESC 是「取消候选」，不是「往回收一层」—— 让给输入法 */
      if (e.isComposing || e.keyCode === 229) return;

      /* v4.2.16：鼠标点过的卡片/页签/按钮会把焦点留在原地，这一下 ESC（键盘事件）
         会让 Chromium 把「最后输入方式」翻成键盘模式，:focus-visible 蓝圈当场
         闪一下（等重渲染才消失）。趁绘制还没发生，把非输入类焦点交还 ——
         蓝圈根本没机会画出来。输入框/正文不动，光标与输入法状态都保留。 */
      try {
        const ae = document.activeElement;
        if (ae && ae !== document.body &&
            !(ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
          ae.blur();
        }
      } catch (err) { /* ignore */ }

      /* 真全屏时这一下先让给浏览器退全屏（抢过来 preventDefault 会把人卡在全屏里）。
         只让一次：万一全屏状态是残留、浏览器并没有真正退出，第二下就按正常流程走。 */
      let fsNow = false;
      try { fsNow = !!(document.fullscreenElement || document.webkitFullscreenElement); } catch (err) { fsNow = false; }
      if (fsNow && !escFsPassed) { escFsPassed = true; return; }
      escFsPassed = false;

      /* v4.2.7：笔记栏搜索框的 Esc = 清空。这里必须抢在 Esc 栈之前判——
         全局监听挂在 window 捕获阶段，#noteSearch 自己的 keydown 根本
         收不到（v4.2.6 的 Esc 清空因此一直没生效）。 */
      if (e.target && e.target.id === 'noteSearch' && e.target.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        noteSearchClear();
        renderNotes();
        return;
      }

      /* v4.2.7：[[ 引用弹窗开着时，Esc 先归编辑器分层处理（清查询 → 关弹窗），
         不能让全局栈把整个笔记框关掉、弹窗却残留。 */
      const nmEsc = $('#noteModal');
      if (nmEsc && !nmEsc.hidden && modalEditor && modalEditor.escPop && modalEditor.escPop()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      /* v3.22：动作判定抽到 js/escguard.js（纯函数，可测）。
         v4.4.0：最后一档恢复「退出插件」—— 用户要求 ESC 关闭插件；
         恢复前提：决策点只剩 escguard 一处，且事件无条件被吞（见下）。 */
      pruneEscLayers();

      const box = $('#searchInput');
      const env = {
        launcher: !!(Bridge.state.query || {}).launcher,
        depth: Esc.depth(),
        topName: (Esc.top() && Esc.top().name) || null,
        searchActive: !!(searchState.q || (box && box.value)),
        typing: typing
      };

      const EG = window.EscGuard;
      const act = (EG && EG.escapeAction) ? EG.escapeAction(env)
        : (env.depth > 0 ? 'pop-layer' : 'exit-plugin');
      /* v3.31：**一律吞掉，绝不再漏给宿主**。
         以前退出时故意不 preventDefault，本意是「我们关不掉就让 Eagle 兜」，
         结果 Eagle 一收到 ESC 就把整个界面收走 —— 用户想关掉一个另存为框，
         连 Eagle 一起没了。现在 ESC 从头到尾由我们处理，宿主收不到。 */
      e.preventDefault();
      e.stopPropagation();

      if (act === 'pop-layer') { Esc.handle(); return; }
      if (act === 'clear-search') { clearSearch(); return; }
      if (act === 'blur') {
        try { e.target.blur(); } catch (err) { /* ignore */ }
        return;
      }
      /* 栈比界面少一层时的兜底：眼前还有看得见的浮层，就先把它关掉 */
      if (closeVisibleOverlay()) return;
      /* v4.4.0：什么都不用关 → 关闭插件（与 ✕ / Ctrl+W 同一条出口，会顺带存草稿）。
         v3.31 时代这里只提示「退出请按 Ctrl+W」；用户要求恢复 ESC 关闭。
         v4.4.1：exitPlugin() 内先过窗口身份守卫；守卫不过就一个窗口 API 都不碰。 */
      /* 延迟再补一次宿主恢复：预览 webview 形态下这一下 ESC 若仍被 Eagle 收到、
         把主窗口收进托盘，260ms 后 restore+show 把它捞回来（不抢焦点）。 */
      setTimeout(() => {
        try { if (Bridge.focusParent) Bridge.focusParent({ focus: false }); } catch (e) { /* ignore */ }
      }, 260);
      exitPlugin();
      return;
    }

    if (typing) return;

    /* ---------- 撤销 / 重做 ----------
       输入框里的 Ctrl+Z 交给浏览器原生（上面 typing 已经放过），
       这里只处理「对数据做的操作」。 */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      const r = e.shiftKey ? Undo.redo() : Undo.undo();
      if (r.ok) U.toast((e.shiftKey ? '已重做：' : '已撤销：') + r.label, 'ok', 1600);
      else U.toast(e.shiftKey ? '没有可重做的操作' : '没有可撤销的操作', '', 1400);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      const r = Undo.redo();
      U.toast(r.ok ? '已重做：' + r.label : '没有可重做的操作', r.ok ? 'ok' : '', 1400);
      return;
    }

    /* ---------- Delete：删掉选中的摘录 / 笔记 / 时间轴标记 ----------
       必须无条件拦住：Eagle 默认把 Delete 当成「从资料库删掉这张素材」，
       让它漏下去就是把用户的 PDF 亲手删了。 */
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      if (!deleteSelection()) {
        U.toast('先点选要删除的摘录、笔记或时间轴标记，再按 Delete', '', 2400);
      }
      return;
    }

    /* 视频模式：空格播放 / 左右快进 / n 截图并笔记 */
    if (state.isVideo) {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          e.stopPropagation();
          /* 在 Eagle 资料库里按空格是「打开插件」，那一下的按键有可能跟着送进来；
             刚打开 600ms 内忽略，免得一进来就自动播。再按就是正常的播放/暂停。 */
          if (Date.now() - (state.openedAt || 0) < 600) return;
          if (VideoView.areaActive()) return;      // 正在框选，别乱放
          VideoView.toggle();
          break;
        case 'ArrowRight': e.preventDefault(); VideoView.nudge(5); break;
        case 'ArrowLeft': e.preventDefault(); VideoView.nudge(-5); break;
        case 'ArrowUp': e.preventDefault(); VideoView.nudge(30); break;
        case 'ArrowDown': e.preventDefault(); VideoView.nudge(-30); break;
        case 'n': case 'N': vsShot(true); break;
        case 'Escape': break;
        default: break;
      }
      return;
    }

    if (!state.doc) return;

    switch (e.key) {
      case 'ArrowRight': case 'PageDown':
        e.preventDefault(); viewer.goToPage(viewer.current + 1); break;
      case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); viewer.goToPage(viewer.current - 1); break;
      case 'Home':
        e.preventDefault(); viewer.goToPage(1); break;
      case 'End':
        e.preventDefault(); viewer.goToPage(state.doc.numPages); break;
      case '+': case '=':
        viewer.zoomIn(); updateZoomUI(); break;
      case '-':
        viewer.zoomOut(); updateZoomUI(); break;
      case '0':
        viewer.fitWidth(); updateZoomUI(); break;
      case 'v': case 'V': setTool('select'); break;
      case 'a': case 'A': setTool('area'); break;
      case 'n': case 'N': setTool('note'); break;
      case '/': e.preventDefault(); focusSearchInput(); break;
      default: break;
    }
  }

  /* ==================== 对外钩子 ==================== */
  window.AppState = state;

  /* v3.34：自绘标题栏的 ✕ 从这里出去。
     ────────────────────────────────────────────────────────────
     用户报「工作台按 ESC 收起来之后，插件还开着，右上角的 ✕ 点不动，只有 Ctrl+W 能关」。
     原因很直接：framewin.js 里那个 ✕ 调的是 window.close()，而 Eagle 的插件窗口
     对 close 有拦截（这正是 v3.28 查出来的那件事），window.close() 是一记空操作。
     Ctrl+W 之所以有效，是因为它走 exitPlugin() —— 先 Bridge.closeSelf()，
     400ms 后窗口还在就 destroySelf() 无条件销毁。
     所以 ✕ 不该有自己的一套关窗逻辑，直接复用退出流程（还会顺带存草稿）。 */
  window.App = {
    exit: exitPlugin,
    closeSelf: () => { try { return !!(Bridge.closeSelf && Bridge.closeSelf()); } catch (e) { return false; } },
    destroySelf: () => { try { return !!(Bridge.destroySelf && Bridge.destroySelf()); } catch (e) { return false; } },
    isExiting: () => exiting
  };
  window.AppViewer = () => viewer;
  window.AppOpenItem = (it) => openItem(it);
  window.AppConfirm = confirmDialog;      // workbench 的批量删除确认框也用它
  window.AppFocusAnn = (id) => {
    if (!state.data) return;
    const ann = state.data.annotations.find((a) => a.id === id);
    if (!ann) return;
    selectAnnotation(ann);
    focusAnn(ann);
  };
  window.AppRefreshAfterKb = () => {
    Store.invalidateIndex();
    if (state.item && state.data) {
      state.data = Store.load({
        itemId: state.item.id,
        name: state.item.name,
        filePath: state.item.filePath
      });
      renderExcerpts();
      renderNotes();
      if (annMgr) { annMgr.renderVisible(); annMgr.sweep(); }
      if (state.tab === 'kb') renderKbPanel();
    }
  };

  /* ==================== 启动 ==================== */
  if (/[?&]debug=1/.test(location.search)) {
    window.__PDFWORK__ = {
      state,
      bridge: Bridge.state,
      hasEagle: () => Bridge.hasEagle,
      viewer: () => viewer,
      addAnnotation,
      renderExcerpts,
      renderNotes,
      renderThumbs,
      switchTab,
      toggleSidePop,
      closeSidePops,
      openComposer,
      collectNotes,
      syncNotesToEagle,
      runExcerptAction,
      openItem,
      confirmDialog,
      exitPlugin,
      store: Store,
      translator: Translator,
      trash: Trash,
      // v3.1 新增：图片 / 链接 / 翻译 / 笔记框
      pickImage,
      runImageExcerpt,
      pickLink,
      runTranslate,
      saveTranslation,
      tryCloseNoteModal,
      resendSelection: (info) => { state.pendingSelection = info; },
      /* v3.3 */
      search: Search,
      searchState,
      esc: Esc,
      pdfwrite: PdfWrite,
      syncPdfFile,
      schedulePdfSync,
      video: VideoView,
      openVideoItem,
      videoMark,
      videoClip,
      focusSearchInput,
      runSearch,
      stepSearch,
      clearSearch,
      editorDirty,
      maybeHealPdf,
      markPdfwVersion,
      openKb: (f) => KnowledgeBase.open(f),
      destroy: () => { if (viewer) viewer.destroy(); },
      /* v3.4：视频模式 / 暂停联动 / 图片 OCR */
      applyModeUI,
      vsShot,
      vsArea,
      vsClip,
      vsZoomTo,
      ocrAnn,
      videoPausedByUs: () => videoPause,
      resumeVideo,
      enterVideoMode: (item) => {
        state.isVideo = true;
        state.openedAt = 0;
        applyModeUI();
        return !!item;
      },
      grabKeys,
      syncFilterChips,
      /* 本地增强向导：环境检测与状态，供设置页与测试复用 */
      checkEnv, envState: () => envState, renderEnvBar, redetectEnv, bootLocalAi, saveEnvExe, findEnvExe,
      /* v3.9.3：运行时（显存）状态与翻译渠道状态条 */
      refreshRuntime, renderTrChannels,
      /* v3.6：撤销 / Delete / 笔记定位 / 译文 */
      undo: (typeof Undo !== 'undefined' ? Undo : null),
      removeAnnotation,
      updateAnnotation,
      deleteSelection,
      jumpToNote,
      translateAnn,
      pickVideoMark,
      scrollExcerptTo,
      scrollNoteTo,
      clearHistoryOnly,
      leaveVideoMode: () => {
        state.isVideo = false;
        applyModeUI();
        return true;
      },
      confirmDialogReady: () => !!$('#confirmOverlay')
    };
  }

  boot();
})();
