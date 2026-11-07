/* wikilink.js —— v4.0 双链笔记 · 语法层（纯函数，不碰 DOM）
 *
 * 语法（Obsidian 兼容，不发明新格式）：
 *   [[书名]]          文档级链接 —— 目标 = 另一本投影 md 的「书名」
 *                     （= Eagle 条目名去扩展名 = projection manifest.title）
 *   [[书名|别名]]     显示别名，链接目标不变
 *   [[书名#笔记]]     笔记级链接（v4.2）—— 打开书后定位到那条笔记；
 *                     笔记标题 = 笔记正文的第一行（同 UI 口径，见 noteTitle）
 *   [[书名#笔记|别名]]
 *   [[书名#^eaglenote-nt-xxx|显示名]]   块级链接（v4.5.0）—— OB 原生块引用，
 *                     直接跳到那一条笔记/摘录所在位置，而不是只打开文件。
 *                     块 ID 由投影层按条目 id 生成，改标题、重名都不会断链。
 *                     插件里点它会先把块 ID 翻成笔记标题再定位。
 *
 * 职责边界：
 *   - 只管「文本 → 链接列表 / 上下文摘录」；目标解析（书名 → 条目）在
 *     projection.js（它拥有 manifest），跳转在 app.js（它拥有 openItem）。
 *   - 反向链接不写进 md 正文（会引发 A→B→A 写循环），运行时聚合。
 */
const WikiLink = (function () {
  'use strict';

  /* 目标里不允许再出现 [ ] 或换行；别名段从第一个 | 切开 */
  const RE = /\[\[([^\[\]\n]+?)\]\]/g;

  /* 先剥掉代码块和行内代码 —— 里面的 [[..]] 是示例不是链接，
     索引层和渲染层（markdown 行内代码走 stash 通道）保持同一口径 */
  function stripCode(text) {
    return String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`\n]*)`/g, ' ');
  }

  /* 解析一段文本里的全部双链（含重复出现） */
  function parseLinks(text) {
    const src = stripCode(text);
    const out = [];
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) != null) {
      const bar = m[1].indexOf('|');
      const target = (bar >= 0 ? m[1].slice(0, bar) : m[1]).trim();
      const alias = bar >= 0 ? m[1].slice(bar + 1).trim() : '';
      if (!target) continue;
      out.push({ raw: m[0], target: target, alias: alias });
    }
    return out;
  }

  /* 去重保序的目标清单（索引入 manifest 用） */
  function distinctTargets(text, exclude) {
    const seen = {};
    const out = [];
    const ex = normalize(exclude);
    for (const l of parseLinks(text)) {
      const n = normalize(l.target);
      if (!n || n === ex || seen[n]) continue;
      seen[n] = 1;
      out.push(l.target);
    }
    return out;
  }

  /* 目标题名归一化：比较时忽略首尾空格与大小写 */
  function normalize(t) {
    return String(t == null ? '' : t).trim().toLowerCase();
  }

  /* v4.2：目标拆成书名与笔记级部分。'书#笔记' → { book:'书', note:'笔记' }；
     没有 # 时 note 为空。第一个 # 之后的全部算笔记标题（标题里再出现 # 也归标题）。
     v4.5.0：新增第三种形态 '书#^块ID' —— Obsidian 块引用，目标直接落到
     那条摘录/笔记本体，不受标题改名、重名、标题里含 # 或 [[ ]] 的影响。
     这时 note 为空、anchor 为块 ID（不带 ^）。旧链接全部照常解析。 */
  function splitTarget(t) {
    const s = String(t == null ? '' : t).trim();
    const h = s.indexOf('#');
    if (h < 0) return { book: s, note: '', anchor: '' };
    const rest = s.slice(h + 1).trim();
    const book = s.slice(0, h).trim();
    if (rest.charAt(0) === '^') return { book: book, note: '', anchor: rest.slice(1).trim() };
    return { book: book, note: rest, anchor: '' };
  }

  function bookOf(t) { return splitTarget(t).book; }
  /* 生成块级目标：[[书#^块ID|显示名]] 里的目标段。 */
  function anchorTarget(book, anchor) {
    return String(book == null ? '' : book).trim() + '#^' +
      String(anchor == null ? '' : anchor).trim().replace(/^\^/, '');
  }
  /* 别把 OB 不认的字符塞进块 ID：只留 [A-Za-z0-9-] */
  function safeAnchor(a) {
    return String(a == null ? '' : a).trim().replace(/^\^/, '').replace(/[^A-Za-z0-9-]/g, '-');
  }

  /* v4.2：笔记的「标题」口径 = 正文第一行，剥掉 Markdown 记号后截 60 字。
     补全候选、跳转对账、反链上下文三处共用，必须同一个函数。 */
  function noteTitle(md) {
    const first = String(md == null ? '' : md).split(/\r?\n/).find((l) => String(l).trim()) || '';
    const t = first
      .replace(/^#{1,6}\s+/, '')            // 标题记号
      .replace(/^>\s?/, '')                 // 引用
      .replace(/[*_`~]/g, '')               // 强调 / 代码记号
      .replace(/\[\[|\]\]/g, '')            // 双链语法壳（保留文字本身）
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!\[\]\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 60 ? t.slice(0, 59).trim() + '…' : t;
  }

  /* v4.4.0：笔记的「锚标题」= 正文第一行原样（不剥记号、不截断）。
     投影 md 里每条笔记的 #### 标题头用的就是它（v4.3.6 起）——
     Obsidian 的 [[书#标题]] 只认标题原文，候选/插入/manifest 必须与标题头
     完全同源，否则 OB 里只能跳到文件、定位不到那条笔记。
     noteTitle（剥壳截断版）仍用于 UI 显示与反链摘录，别混用。 */
  function noteAnchorTitle(md) {
    const first = String(md == null ? '' : md).split(/\r?\n/).find((l) => String(l).trim()) || '';
    return first.trim();
  }

  /* 上下文摘录：文本里所有指向 target 的链接，各取前后 snippet 个字符。
     返回 [{ before, after }]（已剥掉 [[ ]] 语法本身）。反向链接面板用。
     v4.2：笔记级链接 [[书#笔记]] 也算指向「书」—— 按书名段匹配。 */
  function linkContexts(text, target, snippet) {
    const w = snippet || 40;
    const nT = normalize(target);
    const src = stripCode(text);
    const out = [];
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) != null) {
      const bar = m[1].indexOf('|');
      const t = (bar >= 0 ? m[1].slice(0, bar) : m[1]).trim();
      if (normalize(bookOf(t)) !== nT) continue;
      const alias = bar >= 0 ? m[1].slice(bar + 1).trim() : t;
      const before = src.slice(Math.max(0, m.index - w), m.index).replace(/\s+/g, ' ').trim();
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + w).replace(/\s+/g, ' ').trim();
      out.push({ alias: alias, before: before, after: after });
      if (out.length >= 3) break;   // 同一篇里最多给 3 段，反链面板不刷屏
    }
    return out;
  }

  return {
    RE, parseLinks, distinctTargets, linkContexts, normalize, stripCode,
    splitTarget, bookOf, anchorTarget, safeAnchor,
    noteTitle, noteAnchorTitle
  };
})();

try { window.WikiLink = WikiLink; } catch (e) { /* vm 沙箱里没有 window */ }
if (typeof module !== 'undefined' && module.exports) module.exports = WikiLink;
