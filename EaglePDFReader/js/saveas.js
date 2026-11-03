/* saveas.js —— 「另存为」（v3.28）

   先说清楚为什么要改：
   以前截图 / 框选 / 片段是「直接塞进索引、顺手写在源文件旁边」。
   两个后果，用户都踩到了：
     · 索引 JSON 里躺着 base64 大图（一张 1200px 的 JPEG 十几万字符），
       备份、同步、打开都变慢；
     · 用户没法决定文件放哪儿、叫什么 —— 想放进 PPT 的素材库里做不到。

   现在统一成：**先弹系统保存对话框，用户选好位置再落盘**，
   索引里只留路径（见 js/imgcache.js 怎么把路径变回缩略图）。

   纯逻辑（文件名清洗、扩展名补齐、行数判断）单独可测，见 test-v328.js。 */
const SaveAs = (function () {

  function dlg() {
    try { return (window.eagle && window.eagle.dialog) || null; } catch (e) { return null; }
  }

  /* v3.31：真正能弹出对话框的那条路
     ────────────────────────────────────────────────────────────
     用户实测：截图 / 框选 / 片段点「另存为」，界面提示「另存为框没弹出来
     （宿主没接住这个请求），已直接存」。也就是说 `window.eagle.dialog` 这条
     通道在预览窗口里**从来没成功过**，前面所有的超时判定、焦点判定都是在
     给一个不存在的对话框打补丁。

     Eagle 自己（app.asar）到处用 `require('@electron/remote')`，插件窗口也开着
     nodeIntegration，所以这里可以直接拿 remote 的 dialog —— 它由主进程弹出、
     父窗口就是我们自己，完全不经过 `plugin.window.` 那条转发。这条路上
     弹不出来才会是「真的弹不出来」。 */
  function remoteApi() {
    try {
      if (typeof require !== 'function') return null;
      const r = require('@electron/remote');
      return (r && r.dialog && typeof r.dialog.showSaveDialog === 'function') ? r : null;
    } catch (e) { return null; }
  }

  function remoteWindow(r) {
    try { return (r && typeof r.getCurrentWindow === 'function') ? r.getCurrentWindow() : null; } catch (e) { return null; }
  }

  function has() {
    if (remoteApi()) return true;
    const d = dlg();
    return !!(d && typeof d.showSaveDialog === 'function');
  }

  /* Windows 不允许的字符统一换成 -；去掉结尾的点和空格（资源管理器不接受） */
  function safeName(name, fallback) {
    let s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    if (!s) s = fallback || '未命名';
    if (s.length > 120) {
      const dot = s.lastIndexOf('.');
      s = dot > 0 ? s.slice(0, 110) + s.slice(dot) : s.slice(0, 110);
    }
    return s;
  }

  /* 用户可能把扩展名删掉，也可能自己换成别的。以 filters 里的第一个为准补回来。 */
  function ensureExt(path, exts) {
    const p = String(path || '');
    if (!p || !exts || !exts.length) return p;
    const lower = p.toLowerCase();
    for (let i = 0; i < exts.length; i++) {
      if (lower.endsWith('.' + String(exts[i]).toLowerCase())) return p;
    }
    return p + '.' + String(exts[0]).replace(/^\./, '');
  }

  function stripExt(p) {
    const s = String(p || '');
    const i = s.lastIndexOf('.');
    const j = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > j ? s.slice(0, i) : s;
  }

  function baseName(p) {
    const s = String(p || '');
    const j = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return j >= 0 ? s.slice(j + 1) : s;
  }

  /* 弹保存对话框 —— v3.28.3 起返回「三态」，不再是含糊的 路径 / '' / null
     ────────────────────────────────────────────────────────────
     以前把「没有对话框」（null）和「用户取消」（''）混在一起判断，
     结果最要命的一种情况被当成了「取消」：**对话框压根没弹出来**。
     Eagle 的 dialog IPC 是 `dialog[method](BrowserWindow.fromWebContents(sender), …)`，
     插件窗口在某些宿主形态下 `fromWebContents` 拿不到窗口 → 主进程回 undefined
     → 这里 `!r` 成立 → 当成「用户取消」→ 静默什么都不做，
     用户看到的就是「框画出来了，但截不了图」。所以必须把这两种情况分开：

       { kind: 'path',        path }  用户选了位置
       { kind: 'cancel' }             用户按了取消
       { kind: 'unavailable', reason } 这个窗口弹不出对话框 / 超时没响应

     'unavailable' 由调用方决定怎么办（现在的策略是：直接存到源文件旁边，不丢图）。 */
  const WATCHDOG_MS = 120000;              // 对话框一直不返回就当它没弹出来
  const EARLY_MS = 2600;                   // 这段时间内窗口没失焦 → 框根本没出现
  const WATCHDOG = { __watchdog: true };
  const EARLY = { __early: true };

  function wait(ms, value) {
    return new Promise((res) => { setTimeout(() => res(value), ms); });
  }

  /* 把主进程/Electron 返回的东西归一成三态 */
  function parseResult(r, exts) {
    if (r === WATCHDOG) {
      return { kind: 'unavailable', reason: '另存为框 ' + Math.round(WATCHDOG_MS / 1000) + ' 秒没有响应' };
    }
    /* undefined / null：主进程没接住这条消息（拿不到父窗口），不是用户取消 */
    if (r === undefined || r === null) {
      return { kind: 'unavailable', reason: '另存为框没有返回结果（宿主没接住）' };
    }
    if (r.canceled) return { kind: 'cancel' };
    const p = r.filePath || (Array.isArray(r.filePaths) && r.filePaths[0]) || '';
    if (!p) return { kind: 'cancel' };
    return { kind: 'path', path: exts.length ? ensureExt(p, exts) : p };
  }

  function windowFocused() {
    try {
      if (typeof document === 'undefined' || !document.hasFocus) return true;
      return !!document.hasFocus();
    } catch (e) { return true; }
  }

  async function askEx(opts) {
    const o = opts || {};
    const exts = [];
    (o.filters || []).forEach((f) => { (f.extensions || []).forEach((x) => exts.push(x)); });
    let def = o.defaultPath || '';
    if (def && exts.length) def = ensureExt(def, exts);

    const opt = {
      title: o.title || '另存为',
      defaultPath: def || o.name || 'untitled',
      filters: o.filters || [],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    };

    /* ① 首选：@electron/remote 的原生对话框。
       同步等结果，没有「2.6 秒没出现」这种猜测，也没有 120 秒看门狗 ——
       用户不点，它就一直在那儿，这才是系统另存为该有的样子。 */
    const rem = remoteApi();
    if (rem) {
      const win = remoteWindow(rem);
      /* 先带父窗口（模态归属正确、会跟着插件窗走），抛错就退回不带窗口的调用 */
      const tries = win ? [[win, opt], [opt]] : [[opt]];
      for (let i = 0; i < tries.length; i++) {
        try {
          const r = await rem.dialog.showSaveDialog.apply(rem.dialog, tries[i]);
          const out = parseResult(r, exts);
          if (out.kind !== 'unavailable') return out;
        } catch (e) {
          console.warn('[SaveAs] remote 对话框失败（第 ' + (i + 1) + ' 次）', e);
        }
      }
    }

    /* ② 兜底：宿主（Eagle）的 dialog 通道 + 早退判定。
       有些环境禁用了 remote（`enableRemoteModule: false`），这时只能走这条。 */
    const raw = dlg();
    if (!raw || typeof raw.showSaveDialog !== 'function') {
      return { kind: 'unavailable', reason: '这个窗口没有系统另存为（remote 与宿主通道都不可用）' };
    }

    let pending = null;
    try {
      pending = Promise.resolve(raw.showSaveDialog(opt));
      /* 谁都不听的 rejection 会变成 unhandledrejection，把界面上那条红条勾出来；
         这里先挂一个空的 catch，迟到的结果由调用方（honorLateDialog）自己接。 */
      pending.catch(() => { /* 由 race 或调用方处理 */ });

      const first = await Promise.race([pending, wait(EARLY_MS, EARLY), wait(WATCHDOG_MS, WATCHDOG)]);
      if (first !== EARLY) {
        const out = parseResult(first, exts);
        return Object.assign(out, out.kind === 'unavailable' ? { pending } : {});
      }

      /* 2.6 秒过去了还没返回：用「焦点」判断框到底有没有出现。
         系统模态对话框一弹出，父窗口必然失焦；还带着焦点，基本可以断定没弹。 */
      if (windowFocused()) {
        return { kind: 'unavailable', reason: '另存为框没有出现（宿主没接住这个请求）', pending };
      }
      /* 窗口已经失焦 → 框在，安静等用户选（最长仍是 120 秒） */
      const second = await Promise.race([pending, wait(Math.max(1000, WATCHDOG_MS - EARLY_MS), WATCHDOG)]);
      const out = parseResult(second, exts);
      return Object.assign(out, out.kind === 'unavailable' ? { pending } : {});
    } catch (e) {
      console.warn('[SaveAs] 保存对话框失败', e);
      return { kind: 'unavailable', reason: (e && e.message) || '对话框报错', pending };
    }
  }

  /* 旧接口（路径 / '' / null），保留给不关心细节的地方 */
  async function ask(opts) {
    const r = await askEx(opts);
    if (r.kind === 'path') return r.path;
    if (r.kind === 'cancel') return '';
    return null;
  }

  /* 同名文件已存在就加 (2)(3)…，不覆盖用户已有的文件 */
  function uniquePath(target) {
    const p = String(target || '');
    if (!p) return p;
    let fs = null;
    try { if (typeof require === 'function') fs = require('fs'); } catch (e) { fs = null; }
    if (!fs) return p;
    const exists = (f) => { try { return fs.existsSync(f); } catch (e) { return false; } };
    if (!exists(p)) return p;
    const ext = /\.[A-Za-z0-9]{1,6}$/.test(p) ? p.slice(p.lastIndexOf('.')) : '';
    const stem = ext ? p.slice(0, p.length - ext.length) : p;
    for (let i = 2; i < 1000; i++) {
      const next = stem + ' (' + i + ')' + ext;
      if (!exists(next)) return next;
    }
    return stem + '-' + Date.now() + ext;
  }

  /* dataURL → Uint8Array（不走 atob 的字符串中间态，大图也不会卡） */
  function dataUrlBytes(dataUrl) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (comma < 0) return null;
    const head = s.slice(0, comma);
    const body = s.slice(comma + 1);
    try {
      if (head.indexOf('base64') < 0) {
        const text = decodeURIComponent(body);
        const out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
        return out;
      }
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }

  /* 写文件（目标路径由用户选）。失败返回 null。 */
  function write(path, bytes) {
    if (!path || !bytes) return null;
    try { return Store.writeFileAt ? Store.writeFileAt(path, bytes) : null; } catch (e) { return null; }
  }

  function writeDataUrl(path, dataUrl) {
    const bytes = dataUrlBytes(dataUrl);
    if (!bytes) return null;
    return write(path, bytes);
  }

  /* 默认放在源文件同目录、文件名叫「文档名-标记.扩展名」。
     源文件路径拿不到（本地打开的 PDF）就只给文件名，让对话框用系统默认目录。 */
  function defaultPath(item, tag, ext) {
    const base = safeName(stripExt((item && item.name) || ''), '素材');
    const fileName = safeName((base ? base + '-' : '') + (tag || ''), '素材') + (ext || '');
    const dir = (item && item.filePath && typeof Store !== 'undefined' && Store.dirOf)
      ? Store.dirOf(item.filePath) : '';
    const join = (typeof Store !== 'undefined' && Store.joinPath)
      ? Store.joinPath
      : (d, n) => (d ? String(d).replace(/[\\/]+$/, '') + '/' + n : n);
    return dir ? join(dir, fileName) : fileName;
  }

  return {
    has, ask, askEx, uniquePath, safeName, ensureExt, stripExt, baseName,
    dataUrlBytes, write, writeDataUrl, defaultPath
  };
})();

try { window.SaveAs = SaveAs; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = SaveAs;
