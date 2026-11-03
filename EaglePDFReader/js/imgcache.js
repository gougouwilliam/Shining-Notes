/* imgcache.js —— 把「另存的图片路径」变回右栏缩略图（v3.28）

   为什么要绕这一圈：
   索引里不再存 base64 图片（见 js/saveas.js 的说明），只存 `ann.imagePath`。
   但右栏卡片还是要显示这张图，所以渲染时按路径读文件、缩成小图、缓存起来。

   三个必须做到的细节：
     · **只在内存里**：缩略图是 blob URL，会话结束就没了；关掉卡片不会丢文件。
     · **限宽**：原图可能是 4000px 的 PNG，直接塞进 <img> 会解成几十 MB 位图，
       十几张卡片就能把内存吃光。统一缩到 900px 以内再显示。
     · **裁掉底部白边**：有些录屏视频最底下几行是纯白（进度条 / 滚动条残留），
       整帧截图会把这条白线一起截进来，看着就像「卡片下面有一条白线」。
       显示用的缩略图里自动裁掉 —— 另存的原图一个像素都不动。

   读不到文件（用户把文件挪走 / 删了）时返回 ''，调用方显示占位即可。 */
const ImgCache = (function () {
  const cache = new Map();      // key -> blob URL
  const pending = new Map();    // key -> Promise
  const MAXW = 900;
  /* 一次最多裁掉画面高度的 6%：再高就不像「白边」而像正常内容了 */
  const TRIM_MAX_RATIO = 0.06;

  function key(path, maxW, trim) {
    return String(path) + '|' + (maxW || MAXW) + '|' + (trim ? 't' : 'n');
  }

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* 底部有几行是纯白？只看最后 40 行，够用且便宜 */
  /* 底部白带（含烧进画面的进度条）占多少行。
     v3.32：和 videoview.analyzeBand 用同一套判据，原因见那边的长注释：
       · 录屏画面左右是黑边，白带只占中间 2/3 宽 ——
         「整行 99% 是白」永远不成立（1920 里只有 1282 列白 = 66.7%），白带就留下了；
       · 白带里烧着一条进度条，那十来行只有七成白，「连续纯白」到条这里就断，
         只裁到条下方那十几行，条还留在缩略图里。
     所以：先量内容列，再把「白 → 进度条 → 白」看成同一块。 */
  function whiteRows(ctx, w, h) {
    let cut = 0;
    try {
      const probe = Math.min(h, Math.max(48, Math.round(h * 0.12)));
      const y0 = h - probe;
      const data = ctx.getImageData(0, y0, w, probe).data;
      const at = (x, y) => (y * w + x) * 4;

      /* ① 内容列：排除左右黑边 */
      const step = Math.max(1, Math.round(w / 400));
      let run = 0;
      let best = 0;
      let bestAt = 0;
      let idx = 0;
      for (let x = 0; x < w; x += step, idx++) {
        let dark = 0;
        let n = 0;
        for (let y = 0; y < probe; y += 2, n++) {
          const i = at(x, y);
          if (data[i] <= 24 && data[i + 1] <= 24 && data[i + 2] <= 24) dark++;
        }
        if (n && dark <= n * 0.6) {
          run++;
          if (run > best) { best = run; bestAt = idx - run + 1; }
        } else {
          run = 0;
        }
      }
      if (!best) return 0;
      const cx0 = bestAt * step;
      const cx1 = Math.min(w - 1, (bestAt + best - 1) * step);

      /* ② v3.33：与播放器那边同一套「白 → 进度条 → 白」三段式判据。
         缩略图尺度上白带会被缩到几行，贪婪版会把浅色正文一起吃掉，
         所以这里也要求「B 之上重新出现整行纯白 C」才承认进度条。 */
      const cap = Math.min(probe, Math.max(3, Math.round(h * 0.065)));
      const ratioAt = (y) => {
        let white = 0;
        let total = 0;
        for (let x = cx0; x <= cx1; x += 2) {
          const i = at(x, y);
          total++;
          if (data[i] > 232 && data[i + 1] > 232 && data[i + 2] > 232) white++;
        }
        return total ? white / total : 0;
      };

      let A = 0;
      while (A < cap && ratioAt(probe - 1 - A) >= 0.98) A++;

      if (A < 2) {
        /* 条贴底：底部直接是进度条，条上方才是整行白 —— 也要连条一起裁 */
        let b = 0;
        while (b < 16 && probe - 1 - b >= 0) {
          const r = ratioAt(probe - 1 - b);
          if (r >= 0.42 && r < 0.98) b++;
          else break;
        }
        if (b < 3) return 0;
        let c = 0;
        while (c < cap && probe - 1 - b - c >= 0 && ratioAt(probe - 1 - b - c) >= 0.98) c++;
        if (c < 3) return 0;
        cut = Math.min(b + c + 2, cap);
      } else {
        const yA = probe - 1 - A;
        let B = 0;
        while (B < 16 && yA - B >= 0) {
          const r = ratioAt(yA - B);
          if (r >= 0.42 && r < 0.98) B++;
          else break;
        }
        let C = 0;
        if (B >= 3) {
          const yB = yA - B;
          while (C < cap && yB - C >= 0 && ratioAt(yB - C) >= 0.98) C++;
        }
        /* +2：白带上方那 1-2 行过渡行不裁掉就是一条细白线 */
        cut = Math.min(((B >= 3 && C >= 3) ? A + B + C : A) + 2, cap);
      }
    } catch (e) { return 0; }
    /* 保险丝：5% 上限之外再兜一层（极矮的图按「至少 3 行」走时会略超 5%） */
    if (cut > h * 0.1) return 0;
    return cut;
  }

  function toUrl(canvas) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) { resolve(''); return; }
          try { resolve(URL.createObjectURL(blob)); } catch (e) { resolve(''); }
        }, 'image/jpeg', 0.84);
      } catch (e) { resolve(''); }
    });
  }

  async function build(path, maxW, trim) {
    let buf = null;
    try { buf = Store.readFileBuffer(path); } catch (e) { buf = null; }
    if (!buf) return '';
    const blob = new Blob([buf]);
    let bmp = null;
    try { bmp = await createImageBitmap(blob); } catch (e) { bmp = null; }
    if (!bmp) {
      /* 解不开就退回原图（至少能看见），别再往下做缩放 */
      try { return URL.createObjectURL(blob); } catch (e) { return ''; }
    }
    const s = Math.min(1, maxW / (bmp.width || 1));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    let out = canvasOf(w, h);
    let ctx = out.getContext('2d');
    /* 白底：PNG 透明区域在 jpeg 里会变黑，先铺一层白 */
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (trim) {
      const cut = whiteRows(ctx, w, h);
      if (cut > 0) {
        const cut2 = canvasOf(w, h - cut);
        const c2 = cut2.getContext('2d');
        c2.fillStyle = '#fff';
        c2.fillRect(0, 0, w, h - cut);
        c2.drawImage(out, 0, 0);
        out = cut2;
        ctx = c2;
      }
    }
    try { if (bmp.close) bmp.close(); } catch (e) { /* ignore */ }
    return await toUrl(out);
  }

  /* 路径 → 可直接放进 <img src> 的 URL（异步，带缓存） */
  function url(path, opts) {
    const o = opts || {};
    if (!path) return Promise.resolve('');
    const k = key(path, o.maxW, o.trim);
    if (cache.has(k)) return Promise.resolve(cache.get(k));
    if (pending.has(k)) return pending.get(k);
    const p = build(path, o.maxW || MAXW, !!o.trim)
      .then((u) => {
        pending.delete(k);
        if (u) cache.set(k, u);
        return u;
      })
      .catch(() => { pending.delete(k); return ''; });
    pending.set(k, p);
    return p;
  }

  /* 给 OCR 用：整张原图（不裁不缩），OCR 的准确度和清晰度直接相关 */
  async function dataUrl(path) {
    const buf = (() => { try { return Store.readFileBuffer(path); } catch (e) { return null; } })();
    if (!buf) return '';
    try {
      const blob = new Blob([buf]);
      const bmp = await createImageBitmap(blob);
      const s = Math.min(1, 1800 / (bmp.width || 1));
      const w = Math.max(1, Math.round(bmp.width * s));
      const h = Math.max(1, Math.round(bmp.height * s));
      const c = canvasOf(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      try { if (bmp.close) bmp.close(); } catch (e) { /* ignore */ }
      return c.toDataURL('image/png');
    } catch (e) { return ''; }
  }

  function clear() {
    cache.forEach((v) => { try { URL.revokeObjectURL(v); } catch (e) { /* ignore */ } });
    cache.clear();
  }

  return { url, dataUrl, clear, _whiteRows: whiteRows };
})();

try { window.ImgCache = ImgCache; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = ImgCache;
