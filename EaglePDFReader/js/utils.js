/* 通用工具函数 —— 全局命名空间 U */
const U = (function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, html) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
        else if (k.startsWith('data-') || k.startsWith('aria-')) node.setAttribute(k, attrs[k]);
        else node[k] = attrs[k];
      }
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function uid(prefix) {
    return (prefix || 'a') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function debounce(fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    wrapped.flush = function (...args) { clearTimeout(t); fn.apply(this, args); };
    return wrapped;
  }

  function rafThrottle(fn) {
    let queued = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn.apply(this, lastArgs);
      });
    };
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function truncate(str, n) {
    str = String(str || '').replace(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = el('textarea', { style: { position: 'fixed', left: '-9999px' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
  }

  function toast(msg, type, ms) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const node = el('div', { class: 'toast ' + (type || ''), text: msg });
    wrap.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(4px)';
      setTimeout(() => node.remove(), 220);
    }, ms || 2200);
  }

  /**
   * 把逐字符 / 逐文本节点的矩形按行合并。
   * gapTol：同一行内两块矩形间距小于该值即视为连续，避免把整行空白也涂上。
   */
  function mergeLineRects(rects, gapTol) {
    gapTol = gapTol == null ? 6 : gapTol;
    const list = rects
      .filter((r) => r && r.width > 0.4 && r.height > 0.4)
      .slice()
      .sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const lines = [];
    for (const r of list) {
      const line = lines.find((l) => Math.abs(l.top - r.top) < Math.max(2, Math.min(l.height, r.height) * 0.55));
      if (line) {
        // 只有横向足够接近才合并，避免跨栏连成一条
        line.parts.push(r);
      } else {
        lines.push({ top: r.top, height: r.height, parts: [r] });
      }
    }
    const out = [];
    for (const line of lines) {
      line.parts.sort((a, b) => a.left - b.left);
      let cur = null;
      for (const r of line.parts) {
        if (!cur) {
          cur = { left: r.left, right: r.left + r.width, top: r.top, height: r.height };
          continue;
        }
        const gap = r.left - cur.right;
        if (gap <= gapTol) {
          cur.right = Math.max(cur.right, r.left + r.width);
          cur.top = Math.min(cur.top, r.top);
          cur.height = Math.max(cur.height, r.top + r.height - cur.top);
        } else {
          out.push({ left: cur.left, top: cur.top, width: cur.right - cur.left, height: cur.height });
          cur = { left: r.left, right: r.left + r.width, top: r.top, height: r.height };
        }
      }
      if (cur) out.push({ left: cur.left, top: cur.top, width: cur.right - cur.left, height: cur.height });
    }
    return out;
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[a-z0-9]+$/i, '');
  }

  function toFileUrl(p) {
    if (!p) return '';
    if (/^(https?|data|file):/i.test(p)) return p;
    let s = String(p).replace(/\\/g, '/');
    if (!/^([A-Za-z]:\/|\/)/.test(s)) return s;
    if (/^[A-Za-z]:\//.test(s)) s = '/' + s;
    return encodeURI('file://' + s);
  }

  function dataUrlToBase64(dataUrl) {
    const i = dataUrl.indexOf(',');
    return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  }

  function padNum(n) {
    return String(n).padStart(2, '0');
  }

  function todayStamp() {
    const d = new Date();
    return `${d.getFullYear()}${padNum(d.getMonth() + 1)}${padNum(d.getDate())}`;
  }

  /* 中日韩文字/标点区间：中文 PDF 排版的字间空格要挤掉，否则摘录不可读也不可复制 */
  const CJK_RANGE = '\\u2e80-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
  const CJK_GAP = new RegExp('([' + CJK_RANGE + '])[ \\t\\u00a0\\u2000-\\u200b]+(?=[' + CJK_RANGE + '])', 'g');
  const CJK_HEAD = new RegExp('([ \\t\\u00a0])+(?=[' + CJK_RANGE + '])', 'g');
  const CJK_TAIL = new RegExp('([' + CJK_RANGE + '])[ \\t\\u00a0]+$', 'g');

  /* 去掉中文之间的空白（不跨行，避免把两行并成一行） */
  function squeezeCJK(s) {
    return s.replace(CJK_GAP, '$1');
  }

  function normalizeText(s) {
    let t = String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n');
    // 逐行处理，避免跨行粘连
    t = t.split('\n').map((line) => {
      let l = squeezeCJK(line);
      l = l.replace(CJK_HEAD, '');
      l = l.replace(CJK_TAIL, '$1');
      return l.trim();
    }).join('\n');
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ==================== PDF 复制文本的「重排」 ====================
     PDF 里复制一段整段文字，拿到的是**排版后的文本**：
       · 每一行末尾都有一个换行（行宽决定，跟句子没关系）
       · 长单词被连字符切开（"laparo-\nscopic"）
     直接送去翻译，模型看到的是一段被切碎的东西：句子边界错、单词被拆，
     译文会跟着乱（最典型的是断词被当成两个词分别翻）。
     所以翻译前先把它「重排」回正常的段落文本。

     规则是刻意的保守：只动「几乎肯定是排版造成的」换行，宁可少合并不误合并。 */

  const CJK_CHAR = '\\u2e80-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
  const RE_CJK = new RegExp('[' + CJK_CHAR + ']');
  /* 行末这些标点 = 一句真的结束了，下一行是新的一句 / 新的一段，不能并 */
  const RE_END = /[.!?。！？…；;:：)\]}>"'’”]$/;
  /* 下一行这些开头 = 列表项 / 编号 / 小标题，不属于上一段 */
  const RE_HEAD = /^(?:[-–—•·▪◦※*>]+|\(?\d+[.)、]|[(（]\d+[)）]|[①-⑳]|[一二三四五六七八九十]+[、.]|[A-Z]\.|[（(][a-z]{1,2}[)）])/;

  function isCJK(ch) { return RE_CJK.test(ch || ''); }

  function reflow(s) {
    let t = String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ');

    /* ① 行尾断字：连字符 + 换行 + 小写起头 → 这是一个被切开的单词，拼回去。
       要求两侧各至少 2 个字母，且右边是小写（大写通常意味着专有名词的换行，
       而不是 hyphenation）。剩下的 "state-of-the-art" 这种真实连字符不受影响
       —— 它不在行尾。 */
    t = t.replace(/([A-Za-z\u00c0-\u024f]{2,})[\-\u2010-\u2015]\n[ \t]*([a-z\u00e0-\u024f]{2,})/g, '$1$2');
    /* 行尾连字符后面没有下一行（选区在半句处截断）→ 也把那个连字符去掉 */
    t = t.replace(/([A-Za-z\u00c0-\u024f]{2,})[\-\u2010-\u2015]$/gm, '$1');

    const lines = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { out.push(''); continue; }
      const prev = out.length ? out[out.length - 1] : '';
      if (!prev || !canJoin(prev, line)) { out.push(line); continue; }
      /* 中文之间不补空格（本来就没有），西文之间补一个（换行吃掉的那个空格） */
      const glue = (isCJK(prev[prev.length - 1]) || isCJK(line[0])) ? '' : ' ';
      out[out.length - 1] = prev + glue + line;
    }
    return out.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function canJoin(prev, line) {
    if (!prev || !line) return false;
    if (RE_END.test(prev)) return false;         // 上一行以句末标点收尾 = 一句结束
    if (RE_HEAD.test(line)) return false;        // 下一行是列表 / 编号 / 标题
    /* 上一行很短（不到 8 个字）且下一行首字母大写：多半是小标题 + 正文，别并 */
    if (prev.length < 8 && /^[A-Z]/.test(line) && !isCJK(prev[prev.length - 1])) return false;
    return true;
  }

  /* 日期键：本地时区的 YYYY-MM-DD，热力图 / 每日笔记共用 */
  function dateKey(d) {
    const x = d instanceof Date ? d : new Date(d || Date.now());
    return x.getFullYear() + '-' + padNum(x.getMonth() + 1) + '-' + padNum(x.getDate());
  }

  /* 中日韩字符占比：判断该把选区翻成中文还是英文 */
  function cjkRatio(s) {
    const str = String(s || '');
    if (!str) return 0;
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) n++;
    }
    return n / str.length;
  }

  function fmtClock(d) {
    const x = d || new Date();
    return padNum(x.getHours()) + ':' + padNum(x.getMinutes()) + ':' + padNum(x.getSeconds());
  }

  function fmtDateCN(d) {
    const x = d || new Date();
    const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][x.getDay()];
    return (x.getMonth() + 1) + ' 月 ' + x.getDate() + ' 日 · ' + wk;
  }

  /* 短哈希：本地文件没有 Eagle itemId 时用它做稳定键 */
  function hashKey(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = (h1 ^ c) * 16777619 >>> 0;
      h2 = (h2 + c * (i + 1)) >>> 0;
    }
    return ('0000000' + h1.toString(36)).slice(-7) + ('0000' + h2.toString(36)).slice(-4);
  }

  return {
    $, $$, el, uid, debounce, rafThrottle, clamp, clamp01, escapeHtml, fmtTime, relTime,
    truncate, copyText, toast, mergeLineRects, extOf, stripExt, toFileUrl,
    dataUrlToBase64, todayStamp, padNum, normalizeText, squeezeCJK, hashKey,
    reflow,
    dateKey, cjkRatio, fmtClock, fmtDateCN
  };
})();
