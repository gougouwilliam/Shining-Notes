/* 把插件里的高亮真正写进 PDF 文件（v3.3）

   为什么不用「自己拼增量更新」：PDF 的对象流 / xref 流 / 加密字典太容易踩坑，
   拼错一个字节就是用户文件损坏。这里用 pdf-lib 整篇重写，代价是文件重排一次，
   换来的是「任何阅读器都能打开」。

   写入策略（关键，决定了「删除能否同步」）：
   - 每条高亮写成标准 /Highlight 注释，/NM = "eaglenote:<annId>" 作为我们的指纹。
   - 每次同步 = 先删掉所有带指纹的注释，再按当前数据重写一遍。
   - 所以插件里删掉一条高亮，下次同步时它自然就不会被写回去 —— 删除自动同步。
   - 只写 type === 'highlight'（框选 / 锚点不是文字高亮，落进 PDF 意义不大，
     而且会把页面涂花），行为写进 README。

   安全网：
   1) 第一次改某个文件前，把原文件复制到 <dataDir>/pdfbak/<docKey>.pdf；
   2) 写入用「临时文件 + rename」原子替换；
   3) 写完立刻重新解析一遍，核对指纹注释数量；对不上就用备份还原。
   加密 PDF 直接跳过并提示，不做任何写入。 */
const PdfWrite = (function () {
  const PREFIX = 'eaglenote:';
  const AUTHOR = '闪灵笔记';
  /* 3.3.3：改用「马克笔」配方 —— 正片叠底（Multiply）+ 0.45 不透明度 + 接近原色的 /C。
     之前 0.38 普通混合压在白纸上只剩一层很淡的糖水色，和 WPS 自己的「高亮文本」差得远；
     正片叠底的好处是底色越深越暗、白纸处显色：纸变黄，字仍是黑的，浓淡刚好等于 WPS 的荧光笔。 */
  const ALPHA = 0.45;

  /* 与 annotations.js 的 AnnColors 对齐（0–1 的 RGB） */
  const RGB = {
    yellow: [0.96, 0.77, 0.26],
    green: [0.30, 0.76, 0.54],
    blue: [0.29, 0.56, 0.89],
    pink: [0.89, 0.42, 0.65],
    purple: [0.61, 0.48, 0.83]
  };

  function mods() {
    try {
      if (typeof require === 'function') {
        return { fs: require('fs'), path: require('path') };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function lib() {
    return (typeof window !== 'undefined' && window.PDFLib) || null;
  }

  function available() {
    return !!lib() && !!mods();
  }

  /* v4.5.1：pdf-lib 从首屏挪到空闲加载（js/vendorload.js）。
     ensure() 给「马上就要写文件」的路径用：库还没到就等它到（或明确失败），
     避免「刚打开就保存」时静默漏掉一次回写。 */
  function ensure() {
    if (lib()) return Promise.resolve(true);
    try {
      if (typeof Vendor !== 'undefined' && Vendor.ensure) {
        return Promise.resolve(Vendor.ensure('pdflib')).then(() => !!lib());
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(false);
  }

  /* 库到位后回调一次，参数是「到底有没有到」。
     调用方据此决定补做还是彻底放弃 —— 不能只在成功时回调，
     否则调用方的「只补一次」标记会永远卡住。 */
  function whenReady(fn) {
    const run = (ok) => { try { fn(!!ok); } catch (e) { /* ignore */ } };
    if (lib()) return run(true);
    try {
      if (typeof Vendor !== 'undefined' && Vendor.ensure) {
        Promise.resolve(Vendor.ensure('pdflib')).then((ok) => run(!!lib() && !!ok));
        return;
      }
    } catch (e) { /* ignore */ }
    run(false);
  }

  /* ---------- 几何：显示坐标（左上原点）→ PDF 用户坐标（左下原点） ---------- */
  /* viewport.transform 是 pdf.js 给的「用户空间 → 显示空间」矩阵，
     求逆就能把归一化矩形换回用户空间，顺带天然处理 /Rotate 与 CropBox 偏移。 */
  function invert(m) {
    const [a, b, c, d, e, f] = m;      // 注意 pdf.js 的矩阵按 [a,b,c,d,e,f] 列主序使用
    const det = a * d - b * c;
    if (!det) return null;
    return [
      d / det, -b / det,
      -c / det, a / det,
      (c * f - d * e) / det, (b * e - a * f) / det
    ];
  }

  function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /* 把颜色往白色方向提 k（0–1）。用于 /C：给不认 /AP 的阅读器留一条淡色后路。 */
  function lighten(rgb, k) {
    const t = Number(k) || 0;
    return rgb.map((v) => Number((1 - (1 - v) * (1 - t)).toFixed(3)));
  }

  function quadOfRect(rect, geom) {
    const vw = geom.width;
    const vh = geom.height;
    const inv = invert(geom.transform);
    if (!inv) return null;
    const x1 = rect.x * vw;
    const x2 = (rect.x + rect.w) * vw;
    const y1 = rect.y * vh;
    const y2 = (rect.y + rect.h) * vh;
    const ul = apply(inv, x1, y1);
    const ur = apply(inv, x2, y1);
    const ll = apply(inv, x1, y2);
    const lr = apply(inv, x2, y2);
    const xs = [ul[0], ur[0], ll[0], lr[0]];
    const ys = [ul[1], ur[1], ll[1], lr[1]];
    return {
      quad: [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]],
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    };
  }

  /* ---------- 外观流：没有 /AP 的注释在不少阅读器里根本不显示 ----------
     两个坑，都是实机反馈回来的（3.3.1）：

     1) **BBox 必须与这条注释自己的 /Rect 同尺寸**。
        PDF 规范里，注释的外观流绘制时会「把 BBox 映射到 Rect」——
        BBox 比 Rect 大多少，内容就被压缩多少。之前整页共用一个流、BBox 是整页大小，
        而 Rect 只有一行文字高，于是整页的色块被压进那条 Rect 里：**又粗又实心，把字盖死**。

     2) **每条注释必须有独立的外观流**（或至少同色同尺寸的），
        否则整页的高亮全用/第一个条目的颜色 —— 紫色的条目在 PDF 里会变成黄色，看着像「没显示」。
        多条 0.42 透明叠加也会变成不透明，进一步把字盖住。

     所以这里：一条注释 → 一个流 → BBox 就取这条自己的 bbox，矩形坐标相对它自己的左下角。 */
  function makeAppearance(ctx, quads, bbox, color) {
    const L = lib();
    const ox = bbox[0];
    const oy = bbox[1];
    const w = Math.max(1, bbox[2] - ox);
    const h = Math.max(1, bbox[3] - oy);
    const f = (v) => Number(v).toFixed(3);

    /* 关键：透明度靠 `gs` 操作符，而 `gs` 的操作数是**资源名**，必须写成 `/GS0 gs`。
       3.3.0/3.3.1 写成了 `0.38 gs`（把数值当资源名），PDFium（Edge）、WPS 都判定这一句非法：
       Edge 直接不画这个外观流 → 看不到高亮；WPS 丢掉 AP、退回用 /C 实心填充 → 不透明色条盖住文字。
       少一个斜杠，两家的表现全对上了。 */
    const lines = ['q', '/GS0 gs', `${f(color[0])} ${f(color[1])} ${f(color[2])} rg`];
    quads.forEach((q) => {
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      /* 统一夹到 BBox 内：越界部分会被阅读器裁掉，宁可变窄也不要留脏边 */
      const x0 = Math.max(0, Math.min(Math.min(...xs) - ox, w));
      const y0 = Math.max(0, Math.min(Math.min(...ys) - oy, h));
      const x1 = Math.max(0, Math.min(Math.max(...xs) - ox, w));
      const y1 = Math.max(0, Math.min(Math.max(...ys) - oy, h));
      const lw = x1 - x0;
      const lh = y1 - y0;
      if (lw <= 0.2 || lh <= 0.2) return;
      lines.push(`${f(x0)} ${f(y0)} ${f(lw)} ${f(lh)} re`);
    });
    lines.push('f', 'Q');

    /* 只在这里做一次透明。注释字典上不再写 /CA —— 那会和这里的 ca 相乘，
       0.45×0.45 变得几乎看不见；而给了 /AP 之后阅读器本来就以 AP 为准。

       `BM /Multiply` 是「和 WPS 长得一样」的关键：正片叠底让白纸变成色带、
       黑字仍是黑字，所以可以放心把不透明度提到 0.45（普通混合在这个浓度会把字染黄）。
       不支持 BM 的老阅读器会退回 Normal，此时 0.45 也仍然能看清字。 */
    const gs = ctx.obj({ Type: 'ExtGState', ca: ALPHA, CA: ALPHA, BM: 'Multiply' });
    const gsRef = ctx.register(gs);
    const res = ctx.obj({ ExtGState: { GS0: gsRef } });
    const dict = ctx.obj({
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, w, h],
      Resources: res,
      Matrix: [1, 0, 0, 1, 0, 0]
    });
    const { PDFRawStream } = L;
    const bytes = new Uint8Array(lines.join('\n').split('').map((ch) => ch.charCodeAt(0) & 0xff));
    const stream = PDFRawStream.of(dict, bytes);
    return ctx.register(stream);
  }

  function pdfDate() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const oh = p(Math.floor(Math.abs(off) / 60));
    const om = p(Math.abs(off) % 60);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
      + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${oh}'${om}'`;
  }

  function nameOf(dict) {
    const L = lib();
    try {
      const nm = dict.get(L.PDFName.of('NM'));
      if (!nm) return '';
      if (typeof nm.decodeText === 'function') return nm.decodeText();
      if (typeof nm.stringValue === 'string') return nm.stringValue;
      if (typeof nm.asString === 'function') return nm.asString();
    } catch (e) { /* ignore */ }
    return '';
  }

  /* 统计一份 PDF 里带我们指纹的注释（校验与诊断用） */
  async function countMarks(bytes) {
    const L = lib();
    if (!L) return -1;
    try {
      const doc = await L.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
      let n = 0;
      doc.getPages().forEach((page) => {
        const refOrArr = page.node.get(L.PDFName.of('Annots'));
        if (!refOrArr) return;
        const arr = doc.context.lookup(refOrArr, L.PDFArray);
        if (!arr) return;
        arr.asArray().forEach((ref) => {
          const d = doc.context.lookup(ref);
          if (d && typeof d.get === 'function' && nameOf(d).indexOf(PREFIX) === 0) n++;
        });
      });
      return n;
    } catch (e) {
      return -1;
    }
  }

  /* ---------- 主流程 ---------- */
  /**
   * @param {object} opts
   *   filePath  目标 PDF 路径
   *   items     [{ id, page, rects:[{x,y,w,h}], color, note, text }]
   *   geomFor   async (pageNum) => { transform:[6], width, height }   （viewport scale=1）
   *   backupPath 备份文件路径（首次写入前保存原文件）
   * @returns {{ok:true, count:number, removed:number, bytes:number} | {ok:false, reason:string, detail?:string}}
   */
  async function sync(opts) {
    const L = lib();
    const m = mods();
    if (!L) return { ok: false, reason: 'no-lib' };
    if (!m) return { ok: false, reason: 'no-fs' };
    const filePath = opts && opts.filePath;
    if (!filePath) return { ok: false, reason: 'no-path' };

    let original;
    try { original = m.fs.readFileSync(filePath); } catch (e) {
      return { ok: false, reason: 'read', detail: e.message };
    }

    let doc;
    try {
      doc = await L.PDFDocument.load(new Uint8Array(original), {
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (e) {
      const enc = e && (e.name === 'EncryptedPDFError' || /encrypt/i.test(String(e.message || '')));
      return { ok: false, reason: enc ? 'encrypted' : 'load', detail: String((e && e.message) || e) };
    }

    const ctx = doc.context;
    const pages = doc.getPages();
    const byPage = new Map();
    (opts.items || []).forEach((it) => {
      if (!it || !it.rects || !it.rects.length) return;
      const p = Math.max(1, Math.min(pages.length, it.page || 1));
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(it);
    });

    let removed = 0;
    let added = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageNo = i + 1;
      const key = L.PDFName.of('Annots');
      const oldRef = page.node.get(key);
      let oldArr = oldRef ? ctx.lookup(oldRef, L.PDFArray) : null;
      const keep = [];
      if (oldArr) {
        oldArr.asArray().forEach((ref) => {
          const d = ctx.lookup(ref);
          if (d && typeof d.get === 'function' && nameOf(d).indexOf(PREFIX) === 0) { removed++; return; }
          keep.push(ref);
        });
      }

      const wanted = byPage.get(pageNo) || [];
      if (!wanted.length && !oldArr) continue;

      let geom = null;
      if (wanted.length && typeof opts.geomFor === 'function') {
        try { geom = await opts.geomFor(pageNo); } catch (e) { geom = null; }
      }

      const next = keep.slice();
      if (wanted.length && geom) {
        wanted.forEach((it) => {
          const quads = [];
          let bbox = null;
          (it.rects || []).forEach((r) => {
            const q = quadOfRect(r, geom);
            if (!q) return;
            quads.push(q.quad);
            bbox = bbox
              ? [Math.min(bbox[0], q.bbox[0]), Math.min(bbox[1], q.bbox[1]),
                Math.max(bbox[2], q.bbox[2]), Math.max(bbox[3], q.bbox[3])]
              : q.bbox.slice();
          });
          if (!quads.length || !bbox) return;

          const color = RGB[it.color] || RGB.yellow;
          /* /C 只对「完全不理会 /AP、直接拿 /C 铺一块」的阅读器起作用。
             3.3.3 起只提亮 20%：色相与饱和度都和插件色板一致（也就是 WPS 高亮色板那一套），
             换到别的阅读器里看也是同一个颜色家族，而不是被洗成一层白蒙蒙的糖水色。
             真遇到不认 /AP 又不认透明度的阅读器，这条淡色带也盖不住字。 */
          const cLight = lighten(color, 0.2);
          /* 一条注释一个外观流：BBox 就是这条的 bbox，颜色就是这条的颜色 */
          const apRef = makeAppearance(ctx, quads, bbox, color);

          const annot = ctx.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: bbox,
            QuadPoints: quads.reduce((acc, q) => acc.concat(q), []),
            C: cLight,
            F: 4,
            T: L.PDFHexString.fromText(AUTHOR),
            NM: L.PDFString.of(PREFIX + it.id),
            M: L.PDFString.of(pdfDate()),
            Contents: L.PDFHexString.fromText(String(it.note || it.text || '').slice(0, 2000)),
            AP: { N: apRef }
          });
          next.push(ctx.register(annot));
          added++;
        });
      }

      if (next.length) page.node.set(key, ctx.obj(next));
      else if (oldRef) page.node.delete(key);
    }

    let out;
    try {
      out = await doc.save({ useObjectStreams: false });
    } catch (e) {
      return { ok: false, reason: 'save', detail: String((e && e.message) || e) };
    }

    /* 写完先自检：指纹注释数量必须等于本次写入数 */
    const check = await countMarks(out);
    if (check !== added) {
      return { ok: false, reason: 'verify', detail: `期望 ${added} 条，实际 ${check} 条` };
    }

    /* 首次修改前备份原文件（只备份一次，保留最原始的那份） */
    let backup = null;
    const bk = opts.backupPath;
    if (bk) {
      try {
        if (!m.fs.existsSync(bk)) {
          m.fs.mkdirSync(m.path.dirname(bk), { recursive: true });
          m.fs.writeFileSync(bk, original);
        }
        backup = bk;
      } catch (e) { backup = null; }
    }

    try {
      const tmp = filePath + '.en-tmp';
      /* 直接写 Uint8Array：不要依赖 Buffer —— 渲染进程里不一定有 */
      m.fs.writeFileSync(tmp, out);
      m.fs.renameSync(tmp, filePath);
    } catch (e) {
      return { ok: false, reason: 'write', detail: e.message };
    }

    return { ok: true, count: added, removed, bytes: out.length, backup };
  }

  /* 用备份还原（写入出错时的兜底） */
  function restore(filePath, backupPath) {
    const m = mods();
    if (!m || !filePath || !backupPath) return false;
    try {
      if (!m.fs.existsSync(backupPath)) return false;
      m.fs.copyFileSync(backupPath, filePath);
      return true;
    } catch (e) { return false; }
  }

  return {
    available, ensure, whenReady, sync, restore, countMarks,
    /* 外观格式版本：改了「怎么画」就 +1，插件会据此把老文件里的旧注释重写一遍
       1 → 首版；2 → BBox 与 Rect 对齐、一条一个流；3 → 修 `gs` 操作数（/GS0 gs）；
       4 → 正片叠底 + 0.45 + 近原色 /C（和 WPS 高亮同色系） */
    VERSION: 4,
    PREFIX, AUTHOR
  };
})();

/* classic script 的 const 不挂 window，测试与调试需要显式挂一次 */
try { window.PdfWrite = PdfWrite; } catch (e) { /* ignore */ }
