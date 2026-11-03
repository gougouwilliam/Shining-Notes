/* Markdown 笔记编辑器（可复用组件）

   同一套代码挂载在两处：
     · 右栏「笔记」上半部       —— 快速记笔记
     · 「摘录并笔记」的大浮层   —— 带原文引用 + 附件
   特点：
     · 左编辑右预览，输入即时渲染（不是等保存后才生效）
     · 工具栏插入的语法同样立刻可见
     · 附件只记录「来源地址」：本地文件记绝对路径，Eagle 条目记 itemId，
       不复制文件本体，条目在 Eagle 里换文件夹也不会失效 */
const NoteEditor = (function () {
  const HEADS = [
    { v: '1', t: '标题 1' },
    { v: '2', t: '标题 2' },
    { v: '3', t: '标题 3' },
    { v: '0', t: '正文' }
  ];
  const SIZES = [
    { v: '24', t: '特大' },
    { v: '19', t: '大' },
    { v: '16', t: '中' },
    { v: '14', t: '小' }
  ];

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* v4.2.5：打分 / 拼音匹配提到组件级 —— 笔记栏顶部的全局搜索框
     （app.js）要复用同一套相关度逻辑，保证「两边搜出来的排序口径一致」。
     v4.2.3：拼音模糊搜索。vendor/pinyin-pro.js 提供 window.pinyinPro.match，
       全拼 / 首字母 / 混合都认（「sa」→「撒」，「ls」→「历史」），返回命中的字符下标。
       库没加载成功就自动退回纯子串匹配，不报错。 */
  const PinyinMatch = (function () {
    try { return (typeof window !== 'undefined' && window.pinyinPro && window.pinyinPro.match) || null; }
    catch (e) { return null; }
  })();
  const HAS_LATIN = /[a-z]/i;

  /* v4.2.4：相关度打分。之前打一个「c」—— 中段子串和任意位置的拼音首字母
     全都算命中，候选一屏全是沾边的。现在每个词给出分数：
     开头 > 词界 > 中段；多字符词比单字符词可信；单字符拉丁词只有
     打在开头 / 词界 / 拼音首字才算强命中，中段沾边的算弱命中直接过滤。 */
  const SEP_CHARS = ' ··—－–-_/\\()（）[【《「『,，、。;；:：|｜';
  function scoreOne(hay, token) {
    const s = String(hay || '');
    const t = String(token).toLowerCase();
    if (!t) return 0;
    const low = s.toLowerCase();
    const idx = low.indexOf(t);
    if (idx >= 0) {
      const boundary = idx === 0 || SEP_CHARS.indexOf(s[idx - 1]) >= 0;
      if (t.length >= 2) return boundary ? 80 : 60;
      return boundary ? 70 : 20;
    }
    if (PinyinMatch && HAS_LATIN.test(t)) {
      try {
        const m = PinyinMatch(s, String(token));
        if (Array.isArray(m) && m.length) {
          const first = m[0];
          const boundary = first === 0 || SEP_CHARS.indexOf(s[first - 1]) >= 0;
          if (t.length >= 2) return boundary ? 75 : 45;
          return first === 0 ? 65 : 0;   // 单字符拼音：只有首字命中算强
        }
      } catch (e) { /* 拼音匹配失败就走子串结果 */ }
    }
    return -1;
  }
  /* 多词 AND：每个词都得命中（-1 整体不命中）；weak = 查询里有单字符拉丁词
     只在中段沾边 —— 这类结果只贡献噪音，调用方把它们过滤掉。 */
  function matchScore(hay, tokens) {
    let score = 0;
    let weak = false;
    for (let i = 0; i < tokens.length; i++) {
      const sc = scoreOne(hay, tokens[i]);
      if (sc < 0) return null;
      if (tokens[i].length === 1 && HAS_LATIN.test(tokens[i]) && sc < 40) weak = true;
      score += sc;
    }
    return { score: score, weak: weak };
  }
  /* 命中高亮（v4.2.3 重写）：按字符下标合并各词命中区间后打 <mark>。
     拼音命中的下标同样参与，所以「sa」搜「撒」也能高亮到那个字。
     逐字符转义后再包 mark，用户输入不会变成 HTML。 */
  const CHAR_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function hi(label, tokens) {
    const s = String(label || '');
    if (!s) return '';
    const marks = new Array(s.length).fill(false);
    (tokens || []).forEach((t) => {
      if (!t) return;
      const low = s.toLowerCase();
      const tl = String(t).toLowerCase();
      let hit = false;
      let i = 0;
      while ((i = low.indexOf(tl, i)) >= 0) {
        for (let k = 0; k < tl.length && i + k < s.length; k++) marks[i + k] = true;
        hit = true;
        i += Math.max(1, tl.length);
      }
      if (!hit && PinyinMatch && HAS_LATIN.test(t)) {
        try {
          const idx = PinyinMatch(s, t);
          if (Array.isArray(idx)) idx.forEach((x) => { if (x >= 0 && x < s.length) marks[x] = true; });
        } catch (e) { /* 拼音匹配失败就只亮子串 */ }
      }
    });
    let out = '';
    let run = false;
    for (let i = 0; i < s.length; i++) {
      const c = CHAR_ESC[s[i]] || s[i];
      if (marks[i] && !run) { out += '<mark>'; run = true; }
      else if (!marks[i] && run) { out += '</mark>'; run = false; }
      out += c;
    }
    if (run) out += '</mark>';
    return out;
  }

  function create(root, opts) {
    opts = opts || {};
    root.innerHTML = '';

    /* ---------- 工具栏 ---------- */
    /* v4.2.7：工具栏图形重做 —— 列表 / 分割线 / 对齐 / 视频 / 附件换成
       统一的 14px 线性 SVG 图标（之前是 ⇤ ↔ ▶ 这类字符，形状各家长得不一样，
       意思全靠猜）。加粗 / 斜体 / 高亮 / 删除线保留字符但用 CSS 规整形状。 */
    function svgIcon(paths) {
      return '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" '
        + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    }
    const ICONS = {
      list: '<path d="M5 3.5h7M5 7h7M5 10.5h7"/>'
        + '<circle cx="2.1" cy="3.5" r=".9" fill="currentColor" stroke="none"/>'
        + '<circle cx="2.1" cy="7" r=".9" fill="currentColor" stroke="none"/>'
        + '<circle cx="2.1" cy="10.5" r=".9" fill="currentColor" stroke="none"/>',
      hr: '<path d="M1.5 7h11"/>',
      alignleft: '<path d="M1.5 3.5h11M1.5 7h7.5M1.5 10.5h11"/>',
      aligncenter: '<path d="M1.5 3.5h11M3.2 7h7.6M1.5 10.5h11"/>',
      alignright: '<path d="M1.5 3.5h11M5 7h7.5M1.5 10.5h11"/>',
      video: '<rect x="1.2" y="3" width="11.6" height="8" rx="1.6"/><path d="M6 5.5l3.2 2-3.2 2z" fill="currentColor" stroke="none"/>',
      attach: '<path d="M4.4 7.4l4-4a2 2 0 0 1 2.9 2.9l-5.2 5.2a3.3 3.3 0 0 1-4.7-4.7l4.9-4.9"/>'
    };
    const bar = el('div', 'ne-toolbar');
    [['bold', '<b>B</b>', '加粗 (Ctrl+B)'], ['italic', '<i>I</i>', '斜体 (Ctrl+I)'],
      ['mark', '==', '高亮'], ['strike', 'S', '删除线']].forEach(([k, label, title]) => {
      const b = el('button', 'md-btn' + (k === 'mark' ? ' md-mark' : '') + (k === 'strike' ? ' md-strike' : ''), label);
      b.title = title;
      b.dataset.md = k;
      bar.appendChild(b);
    });
    bar.appendChild(el('span', 'md-sep'));

    const selHead = el('select', 'md-select');
    selHead.title = '标题级别';
    selHead.innerHTML = '<option value="">标题</option>' + HEADS.map((h) => `<option value="${h.v}">${h.t}</option>`).join('');
    bar.appendChild(selHead);

    const selSize = el('select', 'md-select');
    selSize.title = '字号（写入行内样式）';
    selSize.innerHTML = '<option value="">字号</option>' + SIZES.map((s) => `<option value="${s.v}">${s.t}</option>`).join('');
    bar.appendChild(selSize);

    bar.appendChild(el('span', 'md-sep'));
    [['quote', '❝', '引用'], ['ul', svgIcon(ICONS.list), '列表'], ['hr', svgIcon(ICONS.hr), '分割线']].forEach(([k, label, title]) => {
      const b = el('button', 'md-btn', label);
      b.title = title;
      b.dataset.md = k;
      bar.appendChild(b);
    });
    /* v4.2.6：左 / 中 / 右对齐 + 视频链接（md 渲染成内嵌播放窗口），图形化上工具栏
       v4.2.7：图标换 SVG；新增附件按钮（和底部「＋本地文件」同一入口）；
       「引用摘录」按钮下线（大窗编辑时没法回 PDF 摘录，用户确认去掉）。 */
    bar.appendChild(el('span', 'md-sep'));
    [['alignleft', svgIcon(ICONS.alignleft), '左对齐'], ['aligncenter', svgIcon(ICONS.aligncenter), '居中'],
      ['alignright', svgIcon(ICONS.alignright), '右对齐']].forEach(([k, label, title]) => {
      const b = el('button', 'md-btn md-align', label);
      b.title = title;
      b.dataset.md = k;
      bar.appendChild(b);
    });
    const btnVideo = el('button', 'md-btn', svgIcon(ICONS.video));
    btnVideo.title = '插入视频（预览时变成可直接播放的窗口）';
    btnVideo.dataset.md = 'video';
    bar.appendChild(btnVideo);
    const btnAtt = el('button', 'md-btn', svgIcon(ICONS.attach));
    btnAtt.title = '添加附件（本地文件，自动复制副本入库）';
    btnAtt.dataset.md = 'attach';
    bar.appendChild(btnAtt);

    root.appendChild(bar);

    /* ---------- 编辑 + 实时预览 ---------- */
    const body = el('div', 'ne-body');
    const ta = el('textarea', 'ne-input');
    ta.placeholder = '写笔记… 支持 Markdown：**加粗**、*斜体*、==高亮==、# 标题、- 列表、> 引用';
    const pv = el('div', 'ne-preview md-body');
    body.appendChild(ta);
    body.appendChild(pv);
    root.appendChild(body);

    /* v3.30：笔记的语音输入整块下线。
       3.28 给编辑器加的麦克风在这里移除 —— 用户明确不要「写笔记时口述」。
       语音能力没有消失：视频转字幕那条链（asr.js / subtitle.js）仍在用，
       只是不再有「对着笔记输入框说话」这个入口。 */

    /* ---------- 附件 ---------- */
    const attWrap = el('div', 'ne-atts');
    const attList = el('div', 'ne-att-list');
    const attBtns = el('div', 'ne-att-btns');
    const btnLocal = el('button', 'ghost-btn xs', '＋ 本地文件');
    const btnEagle = el('button', 'ghost-btn xs', '＋ Eagle 库');
    attBtns.appendChild(btnLocal);
    attBtns.appendChild(btnEagle);
    attWrap.appendChild(attList);
    attWrap.appendChild(attBtns);
    root.appendChild(attWrap);

    /* ---------- 底部 ---------- */
    const foot = el('div', 'ne-foot');
    const hint = el('span', 'ne-hint', '');
    foot.appendChild(hint);
    foot.appendChild(el('span', 'spacer'));
    const btnCancel = el('button', 'ghost-btn sm', '取消');
    /* 快捷键直接印在按钮上 —— 这个功能写进 README 没人看，摆在手边才会用 */
    const btnSave = el('button', 'primary-btn sm', '保存笔记<span class="kbd" title="Ctrl+Enter">Ctrl ↵</span>');
    foot.appendChild(btnCancel);
    foot.appendChild(btnSave);
    root.appendChild(foot);

    let attachments = [];
    let rafId = 0;

    /* 空内容时「保存笔记」置灰：避免点下去才提示「内容为空」 */
    function hasContent() {
      return !!ta.value.trim() || attachments.length > 0;
    }
    function updateSaveState() {
      btnSave.disabled = !hasContent();
      btnSave.title = btnSave.disabled ? '先写点内容再保存' : '保存到 Eagle（Markdown）';
    }

    /* ---------- 预览 ---------- */
    /* v4.2.7：预览态光标 —— 之前切到预览后光标整个消失（textarea 变透明了），
       用户「能继续打字但看不见光标，很别扭」。现在渲染时在光标位置
       埋一个不可见分隔符 \u2063，渲染完找到它换成闪烁的 caret span；
       找不到（光标在链接 URL 里等会把语法拆坏的场景）就不画，保底不报错。 */
    const CARET_SENTINEL = '\u2063';
    function renderCaret() {
      try {
        const walker = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walker.nextNode())) {
          const i = n.nodeValue.indexOf(CARET_SENTINEL);
          if (i < 0) continue;
          n.nodeValue = n.nodeValue.replace(CARET_SENTINEL, '');
          const caret = document.createElement('span');
          caret.className = 'ne-caret';
          const range = document.createRange();
          range.setStart(n, Math.min(i, n.nodeValue.length));
          range.collapse(true);
          range.insertNode(caret);
          return;
        }
      } catch (e) { /* 画不出光标就算了，别影响渲染 */ }
    }
    function renderPreview() {
      const md = ta.value.trim();
      /* 预览态 + 焦点在输入框里才画光标；编辑态渲染不带哨兵（画了也看不见） */
      if (body.classList.contains('previewing') && document.activeElement === ta && ta.value.length) {
        const pos = Math.max(0, Math.min(ta.selectionStart || 0, ta.value.length));
        pv.innerHTML = Markdown.render(ta.value.slice(0, pos) + CARET_SENTINEL + ta.value.slice(pos));
        renderCaret();
      } else {
        pv.innerHTML = md
          ? Markdown.render(md)
          : '<div class="ne-preview-empty">渲染效果显示在这里 —— 停手片刻自动切换，点一下返回编辑</div>';
      }
      updateSaveState();
    }
    function schedulePreview() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { rafId = 0; renderPreview(); });
    }

    /* v4.2.8：方向键移动光标 —— 之前光标哨兵只在 input 事件里重画，
       方向键只改 selection 不触发 input，于是预览里光标钉在原地，
       用户以为「四向键失效」。selectionchange 对 textarea 同样生效，
       在这里跟着重画（rAF 去抖，和打字共用一条渲染通路）。 */
    document.addEventListener('selectionchange', () => {
      if (!body.classList.contains('previewing')) return;
      if (document.activeElement !== ta) return;
      schedulePreview();
    });

    /* v4.2.8：Ctrl+→ 跳到本行末尾（用户点名）；Ctrl+← 对称跳行首。
       不加 Shift/Alt 修饰判断会干扰选词，这里收紧成纯 Ctrl/⌘。 */
    ta.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const p = ta.selectionStart;
      if (e.key === 'ArrowRight') {
        const nl = ta.value.indexOf('\n', p);
        const end = nl < 0 ? ta.value.length : nl;
        ta.selectionStart = ta.selectionEnd = end;
      } else if (e.key === 'ArrowLeft') {
        const ls = ta.value.lastIndexOf('\n', p - 1) + 1;
        ta.selectionStart = ta.selectionEnd = ls;
      }
      schedulePreview();
    });

    /* ---------- 选区包装 ---------- */
    function wrap(before, after, placeholder) {
      showEdit();   // 预览态点工具栏：先回编辑态再插语法
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const value = ta.value;
      const selected = value.slice(start, end) || placeholder || '文字';
      ta.value = value.slice(0, start) + before + selected + after + value.slice(end);
      ta.focus();
      ta.selectionStart = start + before.length;
      ta.selectionEnd = start + before.length + selected.length;
      schedulePreview();
    }

    function prefixLine(prefix) {
      showEdit();
      const value = ta.value;
      const start = ta.selectionStart;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      ta.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + prefix.length;
      schedulePreview();
    }

    function insertBlock(block) {
      showEdit();
      const pos = ta.selectionStart;
      ta.value = ta.value.slice(0, pos) + block + ta.value.slice(ta.selectionEnd);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + block.length;
      schedulePreview();
    }

    /* ---------- 工具栏事件 ---------- */
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('select')) return;
      e.preventDefault();   // 保住 textarea 的选区
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.md-btn[data-md]');
      if (!btn) return;
      const k = btn.dataset.md;
      if (k === 'bold') wrap('**', '**', '加粗文字');
      else if (k === 'italic') wrap('*', '*', '斜体文字');
      else if (k === 'mark') wrap('==', '==', '高亮文字');
      else if (k === 'strike') wrap('~~', '~~', '删除线');
      else if (k === 'quote') prefixLine('> ');
      else if (k === 'ul') prefixLine('- ');
      else if (k === 'hr') insertBlock('\n---\n');
      /* v4.2.6：对齐（markdown.js 渲染成 text-align div）+ 视频链接 */
      else if (k === 'alignleft') wrap('<div style="text-align:left">', '</div>', '左对齐内容');
      else if (k === 'aligncenter') wrap('<div style="text-align:center">', '</div>', '居中内容');
      else if (k === 'alignright') wrap('<div style="text-align:right">', '</div>', '右对齐内容');
      else if (k === 'video') {
        insertBlock('\n@[视频](在这里粘贴视频链接或本地路径)\n');
        U.toast('把括号里换成视频链接 / 本地路径；末尾加 =640x360 可调播放窗大小', '', 3200);
      } else if (k === 'attach') {
        /* v4.2.7：附件入口统一 —— 和底部「＋ 本地文件」走同一条路（复制副本入库） */
        btnLocal.click();
      }
    });
    selHead.addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.value = '';
      if (v === '') return;
      if (v === '0') {
        // 正文：去掉行首的 # 标记
        const value = ta.value;
        const start = ta.selectionStart;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        ta.value = value.slice(0, lineStart) + value.slice(lineStart).replace(/^#{1,6}\s+/, '');
        ta.focus();
        ta.selectionStart = ta.selectionEnd = Math.max(lineStart, start - 2);
      } else {
        const value = ta.value;
        const start = ta.selectionStart;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const line = value.slice(lineStart).replace(/^#{1,6}\s+/, '');
        ta.value = value.slice(0, lineStart) + '#'.repeat(parseInt(v, 10)) + ' ' + line;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + parseInt(v, 10) + 1;
      }
      schedulePreview();
    });
    selSize.addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.value = '';
      if (v) wrap(`<span style="font-size:${v}px">`, '</span>');
    });

    /* ---------- 输入 ---------- */
    /* v4.2.6：预览切换重做 —— 之前 previewing 用 display:none 藏输入框，
       焦点跟着没了，打字快一点就被打断（用户实测：每次自动转换都失焦）。
       现在 previewing 只把输入框 opacity:0 压到渲染层底下 —— 焦点始终留在
       textarea 上，切到预览后继续打字，渲染层实时跟着变（这才是真的
       「边识别 md 语法边变化」）；点渲染层回到编辑态，光标原地不动。 */
    body.classList.add('editing');
    let pvTimer = 0;          // 停手计时器
    let editScroll = 0;       // 进预览前的滚动位置，回来时还原
    function showEdit() {
      if (pvTimer) { clearTimeout(pvTimer); pvTimer = 0; }
      body.classList.remove('previewing');
      body.classList.add('editing');
    }
    function showPreview() {
      /* [[ 补全还开着时不切 —— 切走会影响输入 */
      if (wpop && !wpop.hidden) return;
      editScroll = ta.scrollTop;
      body.classList.remove('editing');
      body.classList.add('previewing');
      /* 焦点不动：ta 只是变透明，没有被 display:none，继续接收键入 */
    }
    ta.addEventListener('input', () => {
      /* 预览态里打字不再切回编辑 —— 就让渲染层实时跟着变 */
      schedulePreview();
      if (pvTimer) clearTimeout(pvTimer);
      pvTimer = setTimeout(() => { pvTimer = 0; showPreview(); }, 800);
    });
    /* 点渲染区 = 回到编辑。光标位置本来就没动过，原样回来。
       v4.2.8：双链 a.wikilink 放行 —— 之前 mousedown 一律吞掉并切回编辑态，
       <a> 在 click 到来前就被 innerHTML 换掉了，预览里的笔记链接永远点不开。
       v4.2.9：放行所有 <a>（wikilink / 网页视频卡片 / 普通链接），
       各自走 app.js 的 document 级委托。 */
    pv.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('a')) return;
      e.preventDefault();
      showEdit();
      ta.scrollTop = editScroll;
      try { ta.focus(); } catch (err) { /* ignore */ }
    });
    /* v4.2.6：粘贴贴图 —— 截图直接 Ctrl+V 进笔记。
       v4.2.7：不再把 base64 长串塞进 md（编辑态一坨编码，笔记文件还容易被
       撑爆）—— 先经 opts.onPasteImage 落盘媒体库，md 里只记 enmedia: 短引用，
       渲染时 mediafix.js 从副本读出来显示。落盘失败才退回 dataURL 内嵌。 */
    ta.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          const f = it.getAsFile();
          if (!f) continue;
          e.preventDefault();
          if (f.size > 4 * 1024 * 1024) { U.toast('图片超过 4MB，先压缩一下再贴', 'err', 2600); return; }
          const rd = new FileReader();
          rd.onload = async () => {
            if (typeof rd.result !== 'string') return;
            let token = '';
            if (opts.onPasteImage) {
              try { token = await opts.onPasteImage(rd.result) || ''; } catch (err) { token = ''; }
            }
            insertBlock('\n![贴图](' + (token || rd.result) + ')\n');
            if (token) U.toast('贴图已存进附件库，原稿删了也不丢', 'ok', 1800);
          };
          rd.readAsDataURL(f);
          return;
        }
      }
    });

    /* ---------- 双链补全（v4.0 / v4.2 层级选择器）----------
       敲 [[ 弹候选。数据源 opts.wikiTree()（注入，编辑器组件不依赖投影模块）：
         [{ book, self, notes:[标题] }]
       查询支持「书」与「书#笔记」两级：
         无 #  → 列书名（匹配的书给出 + 该书前几条笔记预览）
         有 #  → 只列匹配书里的笔记（含当前书自己的笔记，笔记互链合法）
       行数封顶 + 「还有 N 条」提示，条目多时不会糊满半屏。
       ↑↓ 选择（跳过分组行）、Enter/Tab 确认、ESC 关闭（不往全局 Esc 栈漏）。 */
    const wpop = el('div', 'ne-wikipop');
    /* v4.2.2：弹层自带真搜索框。之前只有一行「敲关键词」的提示文字，
       用户把提示当搜索框点，焦点一离开 textarea，blur 就把整个弹层收了，
       于是「一点搜索框，引用框就关」。现在点框、打字都在弹层里完成，
       打字回写进 textarea 的 [[ 后面 —— 一份查询，两个入口。 */
    const wsearch = el('input', 'ne-wiki-search');
    wsearch.type = 'text';
    wsearch.spellcheck = false;
    wsearch.autocomplete = 'off';
    wsearch.placeholder = '⌕ 搜索书名 / 笔记 · 支持拼音 · 空格分隔多词';
    const wlist = el('div', 'ne-wiki-list');
    wpop.appendChild(wsearch);
    wpop.appendChild(wlist);
    wpop.hidden = true;   // v4.2.3：重构时把这行弄丢了 → 弹层随编辑器挂载直接显示（笔记栏一打开就冒弹窗）
    /* v4.2.4：大笔记框（居中浮动窗）里 [[ 候选弹在编辑器右侧的独立搜索窗。
       .ov-card 是 overflow:hidden，弹层留在卡片内会被裁掉，所以挂到 body 用 fixed。
       小编辑区（笔记栏底部）仍是原来的跟光标内嵌模式。 */
    if (opts.wikiSide) {
      document.body.appendChild(wpop);
      wpop.classList.add('side');
    } else {
      body.style.position = 'relative';
      body.appendChild(wpop);
    }
    let wikiAll = [];      // 渲染用（含分组行 { group }）
    let wikiRows = [];     // 导航用（纯条目行 { value, label, sub }）
    let wikiMore = 0;      // 被封顶截掉的条数
    let wikiTotal = 0;     // 命中总数（展开按钮文案用）
    let wikiExpand = false; // v4.2.5：展开全部态
    let wikiLastQ = null;   // 上次查询原文，变了就收回展开态
    let wikiIdx = 0;

    function wikiClose() { wpop.hidden = true; wsearch.value = ''; wikiAll = []; wikiRows = []; wikiMore = 0; }

    /* v4.2.7：[[ 弹窗的 Esc 逐层退（用户实测：全局 Esc 在捕获阶段把按键抢走，
       编辑框关了、弹窗还钉在屏幕上）。分层规则：
         ① 搜索框有词 → 先清空查询（弹窗留着，重新列出全部候选）；
         ② 弹窗开着但没词 → 关弹窗，顺带删掉悬空的 [[，光标回到原位；
         ③ 弹窗没开 → 返回 false，交给全局 Esc 栈（关编辑框）。 */
    function escPop() {
      if (wpop.hidden) return false;
      const d = wikiDetect();
      if (d && d.q.length) {
        ta.value = ta.value.slice(0, d.start) + ta.value.slice(d.start + d.q.length);
        ta.selectionStart = ta.selectionEnd = d.start;
        wsearch.value = '';
        wikiExpand = false;
        wikiLastQ = '';
        wikiRefresh();          // 空查询重新列出全部候选，弹窗不收
        try { wsearch.focus(); } catch (e) { /* ignore */ }
        return true;
      }
      wikiClose();
      /* 悬空的 [[ 一并删掉，别让它留在正文里变成死字 */
      if (d && d.start >= 2) {
        ta.value = ta.value.slice(0, d.start - 2) + ta.value.slice(d.start);
        ta.selectionStart = ta.selectionEnd = d.start - 2;
      }
      try { ta.focus(); } catch (e) { /* ignore */ }
      schedulePreview();
      return true;
    }

    function wikiDetect() {
      const pos = ta.selectionStart;
      if (pos == null || ta.selectionEnd !== pos) return null;
      const m = /\[\[([^\[\]\n]*)$/.exec(ta.value.slice(0, pos));
      return m ? { q: m[1], start: pos - m[1].length } : null;
    }

    const WIKI_CAP = 24;

    function wikiQuery() {
      const d = wikiDetect();
      if (!d) return null;
      const src = opts.wikiTree
        || (opts.wikiTitles ? () => (opts.wikiTitles() || []).map((t) => ({ book: t, notes: [] })) : null);
      if (!src) return null;
      const q = d.q;
      const hash = q.indexOf('#');
      const qBook = (hash >= 0 ? q.slice(0, hash) : q).trim().toLowerCase();
      const qNote = hash >= 0 ? q.slice(hash + 1).trim().toLowerCase() : null;
      /* v4.2.1：空格分词，AND 语义 —— 「神经 癌」= 书/笔记名同时含这两个词 */
      const tBook = qBook ? qBook.split(/\s+/).filter(Boolean) : [];
      const tNote = qNote ? qNote.split(/\s+/).filter(Boolean) : null;
      const rows = [];
      let total = 0;
      /* v4.2.4：先把每本书算出命中分，按分排序后再生成行 —— 相关度高的书排前面。
         空查询不排序不打分，保持 wikiTree 的原序。 */
      const scored = [];
      (src() || []).forEach((node) => {
        if (node.self && !(node.notes || []).length) return;   // 当前书：只在自己有笔记时出现
        const nB = String(node.book || '');
        const notes = (node.notes || []);
        let bSc = { score: 50, weak: false };
        let nHits = [];
        if (tNote == null) {
          if (tBook.length) {
            bSc = matchScore(nB, tBook) || null;
            nHits = notes
              .map((t) => { const sc = matchScore(t, tBook); return sc && !sc.weak ? { t: t, sc: sc.score } : null; })
              .filter(Boolean);
          }
          if ((!bSc || bSc.weak) && !nHits.length) return;
        } else {
          if (tBook.length) {
            bSc = matchScore(nB, tBook) || null;
            if (!bSc || bSc.weak) return;
          }
          nHits = tNote.length
            ? notes.map((t) => { const sc = matchScore(t, tNote); return sc && !sc.weak ? { t: t, sc: sc.score } : null; }).filter(Boolean)
            : notes.map((t) => ({ t: t, sc: 50 }));
          if (!nHits.length) return;
        }
        nHits.sort((a, b) => b.sc - a.sc);
        const best = Math.max.apply(null, [bSc ? bSc.score : -1].concat(nHits.map((x) => x.sc)));
        scored.push({ node: node, bSc: bSc, nHits: nHits, best: best });
      });
      if ((tBook.length || (tNote && tNote.length))) {
        scored.sort((a, b) => b.best - a.best);
      }
      scored.forEach((x) => {
        const node = x.node;
        const bSc = x.bSc;
        const nHits = x.nHits;
        const bookHit = tNote == null && bSc && !bSc.weak;
        if (rows.length) rows.push({ group: node.book });
        if (bookHit && !node.self) rows.push({ value: node.book, label: node.book, hl: tBook });
        if (tNote == null) {
          /* 书名中但笔记标题没（强）命中：预览沿用旧习惯给前几条，别让书行孤着 */
          let preview = nHits.map(function (x2) { return x2.t; });
          if (bookHit && !preview.length) {
            preview = (node.notes || []).slice(0, tBook.length ? 6 : 3);
          }
          if (bookHit) {
            preview.forEach((t) => {
              rows.push({ value: node.book + '#' + t, label: t, sub: true, hl: tBook });
            });
          } else {
            /* 书名没中（或弱命中被滤）但笔记标题强命中：列出命中的笔记 */
            preview.slice(0, 10).forEach((t) => {
              rows.push({ value: node.book + '#' + t, label: t, sub: true, hl: tBook });
            });
          }
          total += 1 + (node.notes || []).length;
        } else {
          nHits.forEach((x2) => rows.push({ value: node.book + '#' + x2.t, label: x2.t, sub: true, hl: tNote }));
          total += nHits.length;
        }
      });
      /* v4.2.5：默认封顶展示，底部给「展开全部」按钮；点开后本查询内不再封顶，
         列表内部滚动。查询一变就收回折叠态，避免上一次的展开黏到新查询。 */
      const cap = wikiExpand ? rows.length : WIKI_CAP;
      const shown = rows.filter((r) => r.group || r.value).slice(0, cap);
      return {
        rows: shown,
        more: wikiExpand ? 0 : Math.max(0, total - shown.filter((r) => r.value).length),
        total: total,
        q: q.trim()
      };
    }

    function wikiRender() {
      wlist.innerHTML = '';
      const d = wikiDetect();
      if (!d) { wikiClose(); return; }   // 不在 [[ 模式才真关；有查询但没结果要给出提示
      /* 搜索框镜像当前查询；焦点在框里时不回写（它自己就是查询来源） */
      if (document.activeElement !== wsearch) wsearch.value = d.q;
      /* v4.2.3：没搜到不收弹层 —— 收了就像「搜索框坏了」，提示换词，弹层留着接着改 */
      if (!wikiRows.length) {
        wlist.appendChild(el('div', 'ne-wiki-empty',
          d.q.trim()
            ? '没有匹配「' + U.escapeHtml(d.q.trim()) + '」的书 / 笔记 · 换个关键词试试'
            : '还没有可引用的书 / 笔记'));
        wpop.hidden = false;
        wikiFollowCursor();
        return;
      }
      /* 空查询时列表顶部给一行键盘操作提示（搜索已由上方输入框承担） */
      if (!d.q.trim()) {
        wlist.appendChild(el('div', 'ne-wiki-hint', '↑↓ 选择 · Enter 确认 · Esc 关闭'));
      }
      wikiAll.forEach((r) => {
        if (r.group) {
          wlist.appendChild(el('div', 'ne-wiki-group', U.escapeHtml(r.group)));
          return;
        }
        const i = wikiRows.indexOf(r);
        const it = el('div', 'ne-wiki-item' + (r.sub ? ' sub' : '') + (i === wikiIdx ? ' on' : ''), hi(r.label, r.hl || []));
        it.addEventListener('mousedown', (e) => { e.preventDefault(); wikiPick(r.value); });
        wlist.appendChild(it);
      });
      if (wikiMore > 0) {
        /* v4.2.5：「还有 N 条」从死提示变成按钮 —— 结果多时先告诉你一共多少，
           想全看点一下就全量展开（列表内部滚动），不想全看继续输关键词缩小。 */
        const moreBtn = el('button', 'ne-wiki-more-btn',
          '共 ' + wikiTotal + ' 条结果 · 点击展开全部');
        moreBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          wikiExpand = true;
          wikiRefresh();
        });
        wlist.appendChild(moreBtn);
      }
      wpop.hidden = false;
      wikiFollowCursor();
    }

    /* v4.2.4：小编辑区 = 跟光标行走（行号 × 行高，滚动随 scrollTop 修正）；
       大笔记框（wikiSide）= 独立搜索窗钉在编辑器右侧，右边放不下挪左边。 */
    function wikiFollowCursor() {
      try {
        if (opts.wikiSide) {
          const r = root.getBoundingClientRect();
          const W = wpop.offsetWidth || 300;
          let x = r.right + 10;
          if (x + W > window.innerWidth - 8) x = r.left - W - 10;
          if (x + W > window.innerWidth - 8) x = window.innerWidth - W - 8;
          if (x < 8) x = 8;
          /* v4.2.6：搜索窗直接和整张笔记弹窗等高（用户嫌只跟输入框等高还是小），
             顶对齐弹窗、右边放不下挪左边，列表吃掉搜索框以下全部空间。 */
          const card = (root.closest && root.closest('.ov-card')) || root;
          const box = card.getBoundingClientRect();
          wpop.style.top = Math.max(8, box.top) + 'px';
          wpop.style.left = x + 'px';
          wpop.style.height = Math.min(box.height, window.innerHeight - 16) + 'px';
          wlist.style.maxHeight = '';
          return;
        }
        /* 非侧窗模式不留下一次的定高 */
        wpop.style.height = '';
        wlist.style.maxHeight = '';
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight) || 18;
        const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
        wpop.style.top = Math.min((line - 1) * lh - ta.scrollTop + lh + 4, ta.clientHeight - 8) + 'px';
        wpop.style.left = '12px';
      } catch (e) { /* 定不了位就留在原地 */ }
    }

    function wikiRefresh() {
      const d = wikiDetect();
      if (!d) { wikiClose(); return; }
      showEdit();   // v4.2.6：预览态里敲出 [[ → 弹层要出来，先回编辑态
      if (d.q !== wikiLastQ) { wikiExpand = false; wikiLastQ = d.q; }   // 换词收回展开态
      const q = wikiQuery();
      if (!q) { wikiClose(); return; }
      wikiAll = q.rows;
      wikiRows = q.rows.filter((r) => r.value);
      wikiMore = q.more;
      wikiTotal = q.total;
      wikiIdx = 0;
      wikiRender();
    }

    function wikiPick(value) {
      const d = wikiDetect();
      wikiClose();
      if (!d) return;
      const ins = '[[' + value + ']]';
      /* v4.2.8：从「[[」之前开始整体替换 —— 之前从 [[ 之后拼，原来那对 [[
         留在正文里，选完就变成 [[[[书#笔记]]（用户截图实锤）。 */
      const s0 = Math.max(0, d.start - 2);
      ta.value = ta.value.slice(0, s0) + ins + ta.value.slice(ta.selectionStart);
      const pos = s0 + ins.length;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos;
      schedulePreview();
    }

    ta.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].indexOf(e.key) >= 0) return;
      wikiRefresh();
    });
    ta.addEventListener('click', wikiRefresh);
    ta.addEventListener('blur', () => {
      /* 焦点挪进弹层（点搜索框）不算离开，只有真点外面才收 */
      setTimeout(() => { if (!wpop.contains(document.activeElement)) wikiClose(); }, 120);
    });
    /* ↑↓ 选择（跳过分组行）、Enter/Tab 确认、ESC 关闭 —— textarea 和搜索框共用 */
    function wikiKey(e) {
      if (wpop.hidden) return;
      if (e.isComposing || e.keyCode === 229) return;   // 输入法组词不当成导航/确认
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();   // ESC 只关补全，不往全局 Esc 栈漏
        wikiClose();
        try { ta.focus(); } catch (e2) { /* ignore */ }
        return;
      }
      /* 空结果（只有「没搜到」提示行）：没有可选项，方向键/回车不动作，避免选进提示行或插出 [[]]
         v4.2.13：Enter/Tab 还要 stopPropagation —— 只 preventDefault 挡不住宿主，
         Eagle 会把没人认领的 Enter 当成「用默认软件打开当前文档」。 */
      if (!wikiRows.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); wikiIdx = (wikiIdx + 1) % wikiRows.length; wikiRender(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); wikiIdx = (wikiIdx - 1 + wikiRows.length) % wikiRows.length; wikiRender(); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        wikiPick(wikiRows[wikiIdx] ? wikiRows[wikiIdx].value : '');
      }
    }
    ta.addEventListener('keydown', wikiKey);

    /* v4.2.13：普通 Enter 在这里整个吞掉 —— 全局 keydown 对「正在打字」的按键
       一律放行，宿主 Eagle 收到没人认领的 Enter 就会用默认软件打开当前文档。
       preventDefault 会杀掉 textarea 的换行默认行为，所以换行手工补；
       [[ 补全弹窗开着时让上面的 wikiKey 先认领，这里不插手。 */
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;   // 输入法选词的那一下让给输入法
      if (wpop && !wpop.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      const s = ta.selectionStart || 0;
      const epos = ta.selectionEnd == null ? s : ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(epos);
      ta.selectionStart = ta.selectionEnd = s + 1;
      /* 手工插的换行不会自动触发 input，预览调度和落盘防抖都挂在这上面 */
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    /* 搜索框打字 → 回写 textarea 的 [[ 后面 → 走同一套过滤 */
    wsearch.addEventListener('input', () => {
      const d = wikiDetect();
      if (!d) { wikiClose(); return; }
      const qv = wsearch.value;
      ta.value = ta.value.slice(0, d.start) + qv + ta.value.slice(d.start + d.q.length);
      ta.selectionStart = ta.selectionEnd = d.start + qv.length;
      wikiRefresh();
    });
    wsearch.addEventListener('keydown', wikiKey);

    ta.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); wrap('**', '**', '加粗文字'); }
      else if (k === 'i') { e.preventDefault(); wrap('*', '*', '斜体文字'); }
      else if (k === 'enter') {
        /* 输入法选词时那一下 Enter 是「确认候选」，不是「保存」。
           不拦住的话，用拼音打「保存笔记」四个字，选词那一按就把半句话存进去了。 */
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (opts.onSave) opts.onSave(api);
      }
    });

    /* ---------- 附件 ---------- */
    function renderAtts() {
      attList.innerHTML = '';
      if (!attachments.length) { attWrap.classList.remove('has'); updateSaveState(); return; }
      attWrap.classList.add('has');
      attachments.forEach((a, i) => {
        const chip = el('div', 'att-chip');
        chip.title = a.kind === 'eagle' ? ('Eagle 条目 ' + (a.itemId || '')) : (a.path || '');
        chip.appendChild(el('span', 'att-ico', a.kind === 'eagle' ? '◈' : '▤'));
        chip.appendChild(el('span', 'att-name', U.escapeHtml(a.name || '未命名附件')));
        if (a.ext) chip.appendChild(el('span', 'att-ext', String(a.ext).toUpperCase()));
        const x = el('button', 'att-x', '✕');
        x.title = '移除';
        x.addEventListener('click', () => {
          attachments.splice(i, 1);
          renderAtts();
        });
        chip.appendChild(x);
        attList.appendChild(chip);
      });
      updateSaveState();
    }

    btnLocal.addEventListener('click', async () => {
      if (!opts.onAddLocal) return;
      const got = await opts.onAddLocal();
      if (got) pushAtt(got);
    });
    btnEagle.addEventListener('click', async () => {
      if (!opts.onAddEagle) return;
      const list = await opts.onAddEagle();
      if (list && list.length) { list.forEach(pushAtt); }
    });

    function pushAtt(a) {
      if (!a) return;
      const key = a.kind === 'eagle' ? 'e:' + a.itemId : 'f:' + a.path;
      if (attachments.some((x) => (x.kind === 'eagle' ? 'e:' + x.itemId : 'f:' + x.path) === key)) {
        U.toast('该附件已在列表中', '', 1400);
        return;
      }
      attachments.push(a);
      renderAtts();
    }

    /* ---------- 保存 / 取消 ---------- */
    btnSave.addEventListener('click', () => { if (opts.onSave) opts.onSave(api); });
    btnCancel.addEventListener('click', () => { if (opts.onCancel) opts.onCancel(api); });

    const api = {
      root,
      getValue: () => ta.value,
      setValue: (v) => { showEdit(); ta.value = v || ''; renderPreview(); },
      getAttachments: () => attachments.slice(),
      setAttachments: (list) => { attachments = (list || []).slice(); renderAtts(); },
      hasContent,
      clear: () => {
        showEdit();
        ta.value = '';
        attachments = [];
        renderAtts();
        renderPreview();
      },
      focus: () => { showEdit(); ta.focus(); },
      setHint: (text, editing) => {
        hint.textContent = text || '';
        hint.classList.toggle('editing', !!editing);
      },
      insertText: (block) => insertBlock(block),
      escPop: escPop,           // v4.2.7：[[ 弹窗的 Esc 分层退，全局 Esc 先问这里
      destroy: () => {
        root.innerHTML = '';
        if (wpop.parentNode && wpop.parentNode !== root) wpop.remove();   // 侧窗模式挂在 body 上
      }
    };

    renderPreview();
    renderAtts();
    updateSaveState();
    return api;
  }

  /* v4.2.5：matchScore 一并导出 —— 笔记栏顶部搜索框（app.js）复用同一套
     相关度打分，[[ 补全、本文献 / 全局 / Eagle 库三层搜索排序口径一致。 */
  return { create: create, matchScore: matchScore, scoreOne: scoreOne };
})();

try { window.NoteEditor = NoteEditor; } catch (e) { /* ignore */ }
