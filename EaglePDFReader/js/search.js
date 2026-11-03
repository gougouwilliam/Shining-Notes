/* 全文搜索（v3.3 重做）

   旧版的问题：
   1) 结果区一直是空的 —— 状态行能显示「N 处匹配」，列表却渲染不出来；
   2) 只能显示条数，点了也不会定位到具体那一行；
   3) 阅读区没有视觉标记，翻到了也不知道命中的是哪一段。

   现在：
   - 建立「页码 → { text, items[] }」索引，items 带每段文字的位置矩阵；
   - 命中记录 = 页 + 字符区间，据此反算出若干矩形（归一化），交给阅读区画临时高亮；
   - 索引一旦建好就常驻，换关键词只是重新过滤，所以输入时是实时的。 */
const Search = (function () {
  const MAX_HITS = 300;

  let index = null;         // { token, pages: [{ text, items, vp }] }
  let building = null;

  function reset() { index = null; building = null; }
  function ready() { return !!index; }
  function pages() { return index ? index.pages : []; }

  /* ---------- 建索引 ---------- */
  async function build(doc, token, onProgress) {
    if (index && index.token === token) return index;
    if (building && building.token === token) return building.promise;
    const pdfjsLib = window.pdfjsLib;

    const job = { token, promise: null };
    job.promise = (async () => {
      const n = Math.max(0, Number(doc && doc.numPages) || 0);
      const out = new Array(n);
      for (let i = 1; i <= n; i++) {
        let page = null;
        try { page = await doc.getPage(i); } catch (e) { out[i - 1] = { text: '', items: [], vp: null }; continue; }
        let tc = null;
        try { tc = await page.getTextContent(); } catch (e) { tc = null; }
        const vp = page.getViewport({ scale: 1 });
        const items = [];
        let text = '';
        (tc && tc.items ? tc.items : []).forEach((it) => {
          if (typeof it.str !== 'string') return;
          const str = it.str;
          if (!str) return;
          items.push({
            start: text.length,
            str,
            width: it.width || 0,
            height: it.height || 0,
            transform: it.transform
          });
          text += str + ' ';            // 用空格分隔：拉丁单词之间本来就需要，中文多一个空格无碍
        });
        out[i - 1] = { text, items, vp: { transform: vp.transform, width: vp.width, height: vp.height } };
        if (onProgress && (i % 4 === 0 || i === n)) onProgress(i, n);
      }
      index = { token, pages: out };
      building = null;
      return index;
    })();
    building = job;
    return job.promise;
  }

  /* ---------- 查找 ---------- */
  function find(q, limit) {
    const list = [];
    if (!index || !q) return list;
    const needle = String(q).toLowerCase();
    const cap = limit || MAX_HITS;
    for (let p = 0; p < index.pages.length; p++) {
      const entry = index.pages[p];
      const hay = (entry.text || '').toLowerCase();
      if (!hay) continue;
      let from = 0;
      for (;;) {
        const pos = hay.indexOf(needle, from);
        if (pos < 0) break;
        const before = entry.text.slice(Math.max(0, pos - 40), pos);
        const match = entry.text.slice(pos, pos + needle.length);
        const after = entry.text.slice(pos + needle.length, pos + needle.length + 70);
        list.push({
          page: p + 1,
          start: pos,
          end: pos + needle.length,
          before: (pos > 40 ? '…' : '') + before,
          match,
          after: after + (pos + needle.length + 70 < entry.text.length ? '…' : '')
        });
        if (list.length >= cap) return list;
        from = pos + Math.max(1, needle.length);
      }
    }
    return list;
  }

  /* ---------- 命中 → 归一化矩形 ---------- */
  function rectsFor(hit) {
    const entry = index && index.pages[hit.page - 1];
    if (!entry || !entry.vp || !entry.items.length) return [];
    const lib = window.pdfjsLib;
    const vp = entry.vp;
    const out = [];
    entry.items.forEach((it) => {
      const s = it.start;
      const e = it.start + it.str.length;
      if (e <= hit.start || s >= hit.end) return;
      const from = Math.max(0, hit.start - s) / Math.max(1, it.str.length);
      const to = Math.min(it.str.length, hit.end - s) / Math.max(1, it.str.length);
      let tx;
      try { tx = lib.Util.transform(vp.transform, it.transform); } catch (err) { return; }
      const fontH = Math.hypot(tx[2], tx[3]) || it.height || 10;
      const totalW = (it.width || 0) * (vp.scale || 1);
      if (!vp.width || !vp.height) return;
      const left = tx[4] + totalW * from;
      const right = tx[4] + totalW * Math.max(to, from + 0.02);
      const top = tx[5] - fontH * 0.86;
      const height = fontH * 1.02;
      out.push({
        x: +U.clamp01(left / vp.width).toFixed(5),
        y: +U.clamp01(top / vp.height).toFixed(5),
        w: +Math.max(0.002, (right - left) / vp.width).toFixed(5),
        h: +Math.max(0.002, height / vp.height).toFixed(5)
      });
    });
    return out;
  }

  return { build, find, rectsFor, reset, ready, pages };
})();

try { window.Search = Search; } catch (e) { /* ignore */ }
