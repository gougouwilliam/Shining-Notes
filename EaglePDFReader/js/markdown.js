/* 轻量 Markdown 渲染器：标题 / 列表 / 引用 / 代码 / 表格 / 加粗 / 斜体 / 高亮 / 链接
   仅输出受控 HTML，原始 HTML 一律转义（唯一例外是编辑器插入的字号 span）。 */
const Markdown = (function () {
  const TOKEN = '\u0000';
  const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv|mkv)(\?|#|$)/i;
  /* v4.2.7：媒体库短引用（粘贴图 / 附件副本，Store 落盘后笔记里只记这个名字） */
  const MEDIA_NAME = /^enmedia:([A-Za-z0-9._\-]+)$/i;
  /* v4.2.7：尺寸尾参 ` =300` / ` =300x200` / ` =x200`（Typora 同款写法） */
  const SIZE_TAIL = /\s+=([0-9]*)(?:x([0-9]*))?$/;

  function sizeStyle(w, h) {
    const s = [];
    if (w) s.push('width:' + parseInt(w, 10) + 'px');
    if (h) s.push('height:' + parseInt(h, 10) + 'px');
    if (w && h) s.push('object-fit:contain');
    return s.length ? ' style="' + s.join(';') + '"' : '';
  }
  /* 把「 =WxH」从地址尾巴上剥下来；返回 { url, style } */
  function stripSize(raw) {
    const m = SIZE_TAIL.exec(String(raw || '').trim());
    if (!m) return { url: String(raw || '').trim(), style: '' };
    return { url: String(raw).trim().replace(SIZE_TAIL, ''), style: sizeStyle(m[1], m[2]) };
  }

  /* v4.2.6：媒体地址白名单 —— 只放 http(s) / data: / file: 和本地盘符路径，
     javascript: 之类一律拒掉；引号转义防属性逃逸。 */
  function safeSrc(url) {
    const s = String(url || '').trim();
    if (/^(https?:\/\/|data:image\/|data:video\/|file:\/\/)/i.test(s)) return s.replace(/"/g, '%22');
    if (/^[a-z]:[\\/][^"\n\r]*$/i.test(s)) {   // Windows 本地路径（允许空格）→ file:/// URL
      return ('file:///' + s.replace(/\\/g, '/')).replace(/[ ]/g, '%20').replace(/"/g, '%22');
    }
    return '';
  }
  function isVideoUrl(url) {
    return VIDEO_EXT.test(String(url || '').trim()) || /^data:video\//i.test(String(url || '').trim());
  }

  /* v4.2.7：媒体标签统一出口。
     · http(s)/data: —— 直接给 src，浏览器自己加载；
     · file:/// 本地盘路径 —— 本页面跑在 eagleplugin:// 下，file:// 媒体会被
       webSecurity 静默拦成黑屏 / 裂图（js/videoview.js 有同款前车之鉴），
       所以同时挂 data-fsrc（原始路径），mediafix.js 用 fs 读出来换成 blob；
     · enmedia:<名> —— 笔记媒体库副本，src 留空，同样由 mediafix.js 兑现。 */
  function mediaOut(tag, cls, url, label, style, isVideo) {
    const r = stripSize(url);
    const raw = r.url;
    const styleAll = (r.style + ';' + style).replace(/^;|;;/g, ';').replace(/;$/, '');
    const open = (srcAttr, fsrc) => {
      let s = '<' + tag + ' class="' + cls + '"' + srcAttr + fsrc + (styleAll && styleAll !== ';' ? ' style="' + styleAll + '"' : '');
      s += isVideo ? ' controls preload="metadata"' : ' loading="lazy"';
      s += ' alt="' + U.escapeHtml(label || '') + '" title="' + U.escapeHtml(label || '') + '"></' + tag + '>';
      return s;
    };
    const nm = MEDIA_NAME.exec(raw);
    if (nm) return open('', ' data-fsrc="' + U.escapeHtml(raw) + '"');
    const u = safeSrc(raw);
    if (!u) return '<span class="md-badlink">[' + U.escapeHtml(label || '媒体') + '：链接无效]</span>';
    const fsrc = /^file:/i.test(u) ? ' data-fsrc="' + U.escapeHtml(raw) + '"' : '';
    return open(' src="' + u + '"', fsrc);
  }
  function videoTag(url, title) {
    const raw = stripSize(url).url;
    /* v4.2.9：网页链接（非视频直链）用 <video> 必然是灰播放按钮 —— 播不了还占地方。
       直接渲染「浏览器打开」卡片，点一下用系统浏览器播。直链（.mp4 等）仍走 <video>。 */
    if (/^https?:\/\//i.test(raw) && !VIDEO_EXT.test(raw)) {
      const u = safeSrc(raw);
      if (!u) return '<span class="md-badlink">[' + U.escapeHtml(title || '视频') + '：链接无效]</span>';
      return '<a class="md-webvideo" href="javascript:void(0)" data-href="' + U.escapeHtml(u)
        + '" title="网页视频无法内嵌播放，点此用系统浏览器打开">'
        + '<span class="mv-play">▶</span><span class="mv-t">' + U.escapeHtml(title || '网页视频') + '</span>'
        + '<span class="mv-hint">网页视频 · 点击在浏览器中播放</span></a>';
    }
    return mediaOut('video', 'md-video', url, title, 'background:#000', true);
  }
  function imgTag(url, alt) {
    return mediaOut('img', 'md-img', url, alt, '', false);
  }

  function renderInline(src, depth) {
    depth = depth || 0;
    const stash = [];
    const keep = (html) => {
      stash.push(html);
      return TOKEN + (stash.length - 1) + TOKEN;
    };
    let s = String(src == null ? '' : src);

    // 行内代码
    s = s.replace(/`([^`\n]+)`/g, (m, code) => keep('<code>' + U.escapeHtml(code) + '</code>'));

    // 双链 [[目标]] / [[目标|别名]] / [[书#笔记]]（v4.0/v4.2）—— 走 stash 通道，不被转义破坏；
    // 不写真实 href，点击走全局事件委托 data-wtarget（app.js openWikiTarget）
    s = s.replace(/\[\[([^\[\]\n]+?)\]\]/g, (m, inner) => {
      const bar = inner.indexOf('|');
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const alias = bar >= 0 ? inner.slice(bar + 1).trim() : '';
      if (!target) return m;
      const h = target.indexOf('#');
      const label = alias || (h >= 0
        ? target.slice(0, h).trim() + ' › ' + target.slice(h + 1).trim()
        : target);
      return keep('<a class="wikilink" href="javascript:void(0)" data-wtarget="'
        + U.escapeHtml(target) + '" title="跳转到《' + U.escapeHtml(h >= 0 ? target.slice(0, h).trim() : target) + '》'
        + (h >= 0 ? ' 的笔记「' + U.escapeHtml(target.slice(h + 1).trim()) + '」' : '') + '">'
        + U.escapeHtml(label) + '</a>');
    });

    // 允许的字号 span（编辑器「字号」按钮写入）
    s = s.replace(/<span\s+style="\s*font-size:\s*(\d{1,2})px\s*;?\s*"\s*>([\s\S]*?)<\/span>/gi,
      (m, px, inner) => {
        const size = Math.max(10, Math.min(48, parseInt(px, 10) || 14));
        return keep('<span style="font-size:' + size + 'px">' + U.escapeHtml(inner) + '</span>');
      });

    // v4.2.6：对齐块（编辑器「对齐」按钮写入 <div style="text-align:…">）。
    // 内部行内语法递归渲染；depth 防构造嵌套炸栈。
    if (depth < 3) {
      s = s.replace(/<(div|p)\s+style="\s*text-align:\s*(left|center|right)\s*;?\s*"\s*>([\s\S]*?)<\/\1>/gi,
        (m, tag, al, inner) =>
          keep('<' + tag + ' style="text-align:' + al.toLowerCase() + ';margin:0">' + renderInline(inner, depth + 1) + '</' + tag + '>'));
    }

    // v4.2.6：视频 —— @[标题](链接) 直接变内嵌播放窗口；
    // 图片语法 ![标题](xxx.mp4) 里的视频扩展名同样按视频渲染。
    s = s.replace(/@\[([^\]\n]*)\]\(([^)]+)\)/g, (m, t, url) => keep(videoTag(url.trim(), t)));

    // v4.2.6：图片（http / data / file / 本地盘符路径都收，其余不动防注入；
    // 目标允许空格 —— 用户会直接粘贴「D://笔记 资料\a.mp4」这种带空格的本地路径）
    // v4.2.7：走 imgTag 统一出口（enmedia 短引用 / =WxH 尺寸 / 本地文件 data-fsrc）
    s = s.replace(/!\[([^\]\n]*)\]\(([^)]+)\)/g, (m, alt, url) => {
      if (isVideoUrl(url)) return keep(videoTag(url, alt));
      return keep(imgTag(url, alt));
    });

    // 其余内容全部转义
    s = U.escapeHtml(s);

    // 链接
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (m, text, url) => '<a href="' + url + '" target="_blank" rel="noreferrer">' + text + '</a>');

    // 加粗 / 斜体 / 删除线 / 高亮
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

    // 还原占位
    let guard = 0;
    while (s.indexOf(TOKEN) >= 0 && guard++ < 30) {
      s = s.replace(new RegExp(TOKEN + '(\\d+)' + TOKEN, 'g'), (m, i) => stash[+i] != null ? stash[+i] : '');
    }
    return s;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line || '');
  }

  function splitRow(line) {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function render(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const isBlockStart = (line, next) => {
      if (!line.trim()) return true;
      if (/^\s*```/.test(line)) return true;
      if (/^#{1,6}\s+/.test(line)) return true;
      if (/^\s*>/.test(line)) return true;
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) return true;
      if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) return true;
      if (line.indexOf('|') >= 0 && next != null && isTableSep(next)) return true;
      return false;
    };

    while (i < lines.length) {
      const line = lines[i];

      // 空行
      if (!line.trim()) { i++; continue; }

      // 代码块
      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code' + (lang ? ' class="lang-' + U.escapeHtml(lang) + '"' : '') + '>' +
          U.escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 标题
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const lv = Math.min(6, h[1].length);
        out.push('<h' + lv + '>' + renderInline(h[2].trim()) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 分割线
      if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 表格
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let t = '<table><thead><tr>' + head.map((c) => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>';
        rows.forEach((r) => {
          t += '<tr>' + head.map((_, k) => '<td>' + renderInline(r[k] || '') + '</td>').join('') + '</tr>';
        });
        out.push(t + '</tbody></table>');
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表（同级渲染，忽略缩进层级，保证 HTML 结构永远合法）
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          const text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
          i++;
          const cont = [];
          while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) {
            cont.push(lines[i].trim());
            i++;
          }
          items.push(text + (cont.length ? ' ' + cont.join(' ') : ''));
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + '</' + tag + '>');
        continue;
      }

      // 段落
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        out.push('<p>' + renderInline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
      } else {
        i++;
      }
    }
    return out.join('\n');
  }

  /* 纯文本版（用于生成图片卡片） */
  function plain(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/<span[^>]*>|<\/span>/gi, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/@\[[^\]]*\]\(([^)]*)\)/g, (m, u) => '▷ 视频 ' + u)   // v4.2.6 视频语法留链接文字
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => (a || t).trim())   // 双链留显示文字
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '· ')
      .replace(/(\*\*|__|~~|==|\*|_)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { render, renderInline, plain };
})();
