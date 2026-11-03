/* PDF 文档封装：Worker 初始化、文档加载、页面尺寸、目录、文本提取 */
const PdfDocument = (function () {
  const REL_WORKER = 'vendor/pdfjs/pdf.worker.min.js';
  const REL_CMAPS = 'vendor/pdfjs/cmaps/';
  const REL_FONTS = 'vendor/pdfjs/standard_fonts/';
  let workerReady = false;

  function nodeModules() {
    try {
      if (typeof require === 'function') {
        return { fs: require('fs'), path: require('path') };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function pluginDir() {
    if (Bridge.state.pluginPath) return Bridge.state.pluginPath;
    const mods = nodeModules();
    if (!mods) return null;
    // Electron 中页面脚本的 __dirname 即插件根目录，可作为自定义协议下的兜底
    try {
      if (typeof __dirname === 'string' && __dirname) return __dirname;
    } catch (e) { /* ignore */ }
    try {
      const url = new URL('.', location.href);
      let p = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);   // Windows: /C:/... -> C:/...
      return p;
    } catch (e) {
      return null;
    }
  }

  /* 通过 Node 读取本地资源，避免 file:// 下 Worker 与 XHR 的跨域限制 */
  function setupWorker() {
    if (workerReady) return;
    workerReady = true;
    if (!window.pdfjsLib) {
      console.error('[PDF] pdf.js 未加载');
      return;
    }
    const mods = nodeModules();
    const dir = pluginDir();
    if (mods && dir) {
      try {
        const workerPath = mods.path.join(dir, REL_WORKER);
        if (mods.fs.existsSync(workerPath)) {
          const code = mods.fs.readFileSync(workerPath, 'utf8');
          const blob = new Blob([code], { type: 'text/javascript' });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
          return;
        }
      } catch (e) {
        console.warn('[PDF] 本地 Worker 载入失败，改用相对路径', e);
      }
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = REL_WORKER;
  }

  /* 自定义 CMap / 标准字体工厂：在 Node 环境下直接读盘，file:// 协议下也能正常解析中文 PDF */
  function buildFactories() {
    const mods = nodeModules();
    const dir = pluginDir();
    if (!mods || !dir) return {};

    class FsCMapFactory {
      async fetch(opts) {
        const name = opts.name || opts.filename;
        const file = mods.path.join(dir, REL_CMAPS, name + '.bcmap');
        const buf = mods.fs.readFileSync(file);
        return {
          cMapData: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          compressionType: 1
        };
      }
    }
    class FsFontFactory {
      async fetch(opts) {
        const name = opts.filename || opts.name;
        const file = mods.path.join(dir, REL_FONTS, name);
        const buf = mods.fs.readFileSync(file);
        return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
      }
    }
    return { CMapReaderFactory: FsCMapFactory, StandardFontDataFactory: FsFontFactory };
  }

  async function open(source, onProgress) {
    setupWorker();
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error('pdf.js 未正确加载');

    const factories = buildFactories();
    const hasUrlBase = !factories.CMapReaderFactory;

    const params = Object.assign({
      isEvalSupported: false,
      cMapPacked: true,
      cMapUrl: hasUrlBase ? REL_CMAPS : undefined,
      standardFontDataUrl: hasUrlBase ? REL_FONTS : undefined,
      enableXfa: false,
      disableFontFace: false
    }, factories);

    if (source.data) params.data = source.data;
    else if (source.url) params.url = source.url;
    else throw new Error('缺少 PDF 数据来源');

    const task = pdfjsLib.getDocument(params);
    if (onProgress && task.onProgress) {
      task.onProgress = (p) => {
        if (p && p.total) onProgress(p.loaded / p.total);
      };
    }

    let pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      // 字符映射资源不可用时，退化为纯文档打开，保证阅读与标注可用
      if (params.CMapReaderFactory || params.cMapUrl) {
        console.warn('[PDF] 首次加载失败，正在以精简参数重试', err);
        const retry = Object.assign({}, params, { cMapUrl: undefined, standardFontDataUrl: undefined });
        delete retry.CMapReaderFactory;
        delete retry.StandardFontDataFactory;
        pdf = await pdfjsLib.getDocument(retry).promise;
      } else {
        throw err;
      }
    }

    const sizes = await loadSizes(pdf, onProgress);
    const outline = await buildOutline(pdf);
    return {
      proxy: pdf,
      numPages: pdf.numPages,
      sizes,
      outline
    };
  }

  async function loadSizes(pdf, onProgress) {
    const n = pdf.numPages;
    const sizes = new Array(n);
    let cursor = 0;
    let done = 0;
    const concurrency = Math.min(8, Math.max(1, n));
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= n) return;
        try {
          const page = await pdf.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 });
          sizes[i] = { w: vp.width, h: vp.height };
        } catch (e) {
          sizes[i] = { w: 595, h: 842 };
        }
        done++;
        if (onProgress) onProgress(done / n, done, n);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return sizes;
  }

  async function buildOutline(pdf) {
    let raw = null;
    try { raw = await pdf.getOutline(); } catch (e) { return []; }
    if (!raw || !raw.length) return [];
    const out = [];
    const resolvePage = async (item) => {
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0];
          if (typeof ref === 'object' && ref !== null) {
            const idx = await pdf.getPageIndex(ref);
            return idx + 1;
          }
          if (typeof ref === 'number') return ref + 1;
        }
      } catch (e) { /* ignore */ }
      return null;
    };
    const walk = async (items, depth) => {
      for (const it of items) {
        out.push({ title: (it.title || '(无标题)').trim(), page: await resolvePage(it), depth });
        if (it.items && it.items.length) await walk(it.items, Math.min(depth + 1, 3));
      }
    };
    await walk(raw, 0);
    return out;
  }

  return { open, setupWorker, pluginDir };
})();
