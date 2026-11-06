/* wikilink.js —— v4.0 双链笔记 · 语法层（纯函数，不碰 DOM）
 *
 * 语法（Obsidian 兼容，不发明新格式）：
 *   [[书名]]          文档级链接 —— 目标 = 另一本投影 md 的「书名」
 *                     （= Eagle 条目名去扩展名 = projection manifest.title）
 *   [[书名|别名]]     显示别名，链接目标不变
 *   [[书名#笔记]]     笔记级链接（v4.2）—— 打开书后定位到那条笔记；
 *                     笔记标题 = 笔记正文的第一行（同 UI 口径，见 noteTitle）
 *   [[书名#笔记|别名]]
 *   块级 [[书名#ec:xx]] 语法层不解析（ec 锚点留给以后）
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
     没有 # 时 note 为空。第一个 # 之后的全部算笔记标题（标题里再出现 # 也归标题）。 */
  function splitTarget(t) {
    const s = String(t == null ? '' : t).trim();
    const h = s.indexOf('#');
    if (h < 0) return { book: s, note: '' };
    return { book: s.slice(0, h).trim(), note: s.slice(h + 1).trim() };
  }

  function bookOf(t) { return splitTarget(t).book; }

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

  return { RE, parseLinks, distinctTargets, linkContexts, normalize, stripCode, splitTarget, bookOf, noteTitle, noteAnchorTitle };
})();

try { window.WikiLink = WikiLink; } catch (e) { /* vm 沙箱里没有 window */ }
if (typeof module !== 'undefined' && module.exports) module.exports = WikiLink;
