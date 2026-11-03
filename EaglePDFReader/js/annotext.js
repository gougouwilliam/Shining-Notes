/* Eagle 注释正文生成（v3.27，纯函数）

   「三方统一」的落地：Eagle 条目的注释 = 插件里这一篇的全部内容。
   旧版本只写「笔记正文」，于是只摘录没写字的条目在 Eagle 里看不到任何痕迹，
   用户就会说「PDF 的笔记没进注释」。

   这里只做「数据 → 文本」的排版，不碰任何 DOM / Eagle API，
   方便在 Node 里直接断言（见 test-v327.js）。 */
(function (global) {
  'use strict';

  function oneLine(s) {
    return String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' ').trim();
  }

  /* 默认类型名与面板保持一致：底层 type 是 highlight，但用户看到的一律叫「摘录」 */
  const DEFAULT_LABEL = { highlight: '摘录', area: '框选', note: '锚点' };

  /* data: { annotations: [], notes: [] }
     opts: { typeLabel(ann) -> '摘录'|'框选'|'截图'…, fmtTime(sec) -> '00:12' } */
  function buildAnnotationText(data, opts) {
    if (!data) return '';
    const o = opts || {};
    const typeLabel = typeof o.typeLabel === 'function'
      ? o.typeLabel
      : (a) => DEFAULT_LABEL[(a && a.type) || ''] || '摘录';
    const fmtTime = typeof o.fmtTime === 'function'
      ? o.fmtTime
      : (s) => String(Math.floor(Number(s) || 0));

    const anns = (Array.isArray(data.annotations) ? data.annotations : []).slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const notes = (Array.isArray(data.notes) ? data.notes : []).slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lines = [];

    const whereOf = (a) => {
      if (typeof a.t === 'number' && isFinite(a.t)) {
        return fmtTime(a.t) + (typeof a.t1 === 'number' && isFinite(a.t1) ? '–' + fmtTime(a.t1) : '');
      }
      return '第 ' + (a.page || 1) + ' 页';
    };

    anns.forEach((a) => {
      if (!a) return;
      const quote = oneLine(a.text);
      const note = oneLine(a.note);
      /* v3.28：图片只存路径了（不再塞 base64），判断也要认 imagePath；
         片段则是文件（ann.filePath），注释里带上路径方便回找。 */
      const img = !!(a.image || a.imagePath);
      if (!quote && !note && !img && !a.filePath) return;
      const head = '【' + typeLabel(a) + ' · ' + whereOf(a) + '】';
      if (quote) lines.push(head + quote);
      else if (a.filePath) lines.push(head + '［片段文件］');
      else if (img) lines.push(head + '［图片］');
      else lines.push(head);
      if (a.filePath) lines.push('文件：' + a.filePath);
      if (note) lines.push('笔记：' + note);
      lines.push('');
    });

    /* 独立笔记：Markdown 记号去掉再写，注释框里读着才干净 */
    notes.forEach((n) => {
      if (!n) return;
      const raw = String(n.md || '');
      const md = typeof o.plain === 'function' ? o.plain(raw) : raw;
      if (!oneLine(md)) return;
      lines.push('【笔记 · ' + (n.page ? '第 ' + n.page + ' 页' : '独立笔记') + '】' + oneLine(md));
      lines.push('');
    });

    return lines.join('\n').trim();
  }

  const mod = { buildAnnotationText };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.AnnText = mod; } catch (e) { /* ignore */ }
})(typeof window !== 'undefined' ? window : globalThis);
