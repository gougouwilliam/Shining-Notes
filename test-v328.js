/* v3.28 回归：另存为、图片只存路径、ESC 真关窗、白线、语音、清数据
 *
 * 覆盖七块：
 *   1. SaveAs 纯函数：文件名清洗、扩展名补回、默认路径、dataURL → 字节
 *   2. ImgCache._whiteRows：底部白边裁切的边界（6% 上限、非白、读不到像素）
 *   3. ESC 三条通道：IPC close → destroy → 常驻横幅；index.html 内联兜底早于 app.js
 *   4. 截图 / 框选 / 片段只存路径，图片不可拖动
 *   5. 缩略图裁白边只作用于显示，原图不动
 *   6. 清除插件数据（wipe 模式）与 Store.wipeAll 的保留清单
 *   7. 编辑器语音按钮 + 划词选区重建（_snapRange）
 *
 * 运行：node test-v328.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (src, s) => src.indexOf(s) >= 0;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  \u2717 ' + msg);
}

const SaveAs = require('./EaglePDFReader/js/saveas.js');
const ImgCache = require('./EaglePDFReader/js/imgcache.js');

/* ───────────────────── 1. SaveAs ───────────────────── */
console.log('\n[1] SaveAs：文件名清洗、扩展名、默认路径、字节转换');

ok(SaveAs.safeName('a/b:c*d?.png') === 'a-b-c-d-.png', 'Windows 非法字符全部换成 -');
ok(SaveAs.safeName('  片段  ') === '片段', '首尾空格去掉');
ok(SaveAs.safeName('末尾有点...') === '末尾有点', '结尾的点和空格去掉（资源管理器不接受）');
ok(SaveAs.safeName('') === '未命名', '空名给默认值');
ok(SaveAs.safeName('   ', '素材') === '素材', '空白名用调用方给的兜底');
ok(SaveAs.safeName('a\nb\tc').indexOf('\n') < 0, '换行与制表符被替换，不会写出畸形文件名');

const longName = 'x'.repeat(200) + '.png';
const cut = SaveAs.safeName(longName);
ok(cut.length <= 120 && cut.endsWith('.png'), '超长文件名被截断但保留扩展名');

ok(SaveAs.ensureExt('D:/x/y', ['png']) === 'D:/x/y.png', '缺扩展名时补第一个');
ok(SaveAs.ensureExt('D:/x/y.PNG', ['png']) === 'D:/x/y.PNG', '已有扩展名（大写）不重复补');
ok(SaveAs.ensureExt('D:/x/y.webm', ['webm', 'mp4']) === 'D:/x/y.webm', '多扩展名命中任意一个即通过');
ok(SaveAs.ensureExt('', ['png']) === '', '空路径原样返回');
ok(SaveAs.ensureExt('D:/x/y', []) === 'D:/x/y', '没有 filters 时不动路径');

ok(SaveAs.stripExt('E:/a/b.mp4') === 'E:/a/b', 'stripExt 去扩展名');
ok(SaveAs.stripExt('E:/a/b.c/d') === 'E:/a/b.c/d', '目录里的点不算扩展名');
ok(SaveAs.baseName('E:/a/b.mp4') === 'b.mp4', 'baseName 取文件名');
ok(SaveAs.baseName('E:\\a\\b.mp4') === 'b.mp4', 'Windows 反斜杠也认');

const dp = SaveAs.defaultPath({ name: '影像.mp4' }, '00-18', '.png');
ok(dp === '影像-00-18.png', '拿不到源目录时只给文件名，交给系统默认目录：' + dp);
const dp2 = SaveAs.defaultPath({ name: 'a:b.mp4' }, 'p3', '.png');
ok(dp2 === 'a-b-p3.png', '文档名里的非法字符也会清洗：' + dp2);
const dp3 = SaveAs.defaultPath({ name: '', }, '片段', '.webm');
ok(dp3 === '素材-片段.webm', '没有文档名时用「素材」兜底：' + dp3);

const b64 = SaveAs.dataUrlBytes('data:image/png;base64,' + Buffer.from('hello').toString('base64'));
ok(b64 && b64.length === 5 && b64[0] === 104, 'base64 dataURL 解成字节，长度与首字节正确');
const plain = SaveAs.dataUrlBytes('data:text/plain,hello%20world');
ok(plain && plain.length === 11, '非 base64 dataURL 走 decodeURIComponent');
ok(SaveAs.dataUrlBytes('no-comma-here') === null, '没有逗号的串返回 null');
ok(SaveAs.dataUrlBytes('data:image/png;base64,@@@@') === null, 'base64 非法时返回 null 而不是抛错');

ok(SaveAs.has() === false, 'Node 里没有 eagle.dialog，has() 为 false');
ok(typeof SaveAs.ask === 'function', 'ask 是异步接口');

/* ───────────────────── 2. 白边裁切 ───────────────────── */
console.log('\n[2] ImgCache._whiteRows：底部白边的判定与上限');

/* 造一块假像素：中间是内容列（深灰），左右各 pad 列纯黑（录屏的黑边），
   底部 whiteTail 行纯白。v3.32 起判据是「先找内容列，再在内容列里判白」，
   所以 fixture 必须带上黑边，否则测的就不是真实形态。 */
function fakeCtx(w, h, whiteTail, opts) {
  const o = opts || {};
  const pad = o.pad == null ? Math.round(w * 0.15) : o.pad;
  const bar = o.bar || 0;                        // 白带上方烧着的进度条行数
  return {
    getImageData(x, y, gw, gh) {
      if (o.boom) throw new Error('tainted');
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let yy = 0; yy < gh; yy++) {
        const abs = y + yy;                       // 这一行在整图里的行号
        const inBand = abs >= h - whiteTail;
        const at = o.barAt || 0;                  // 条距带底的行数（模拟条夹在白带中间）
      const inBar = bar > 0 && abs >= h - whiteTail + at && abs < h - whiteTail + at + bar;
        for (let xx = 0; xx < gw; xx++) {
          const ax = x + xx;
          const i = (yy * gw + xx) * 4;
          let v;
          if (ax < pad || ax >= w - pad) v = 0;              // 左右黑边
          else if (inBar) v = (xx % 4 === 0) ? 60 : 255;      // 进度条：约 25% 深色
          else v = inBand ? 255 : 30;                         // 白带 / 普通画面
          data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
      }
      return { data };
    }
  };
}

/* v3.33 起每条都多裁 2 行过渡行（白带上方那一行是「画面 + 白」的混色，不裁就是细白线） */
ok(ImgCache._whiteRows(fakeCtx(1000, 1000, 8), 1000, 1000) === 10, '1000 高、底部 8 行纯白 → 裁 10 行（8 + 2 过渡）');
ok(ImgCache._whiteRows(fakeCtx(1000, 1000, 0), 1000, 1000) === 0, '底部不是白的 → 一行都不裁');
ok(ImgCache._whiteRows(fakeCtx(1000, 200, 20), 1000, 200) === 13, '200 高、20 行白 → 被 6.5% 上限压到 13 行');
ok(ImgCache._whiteRows(fakeCtx(1000, 200, 12), 1000, 200) === 13, '200 高、12 行白 → 12 + 2 过渡后仍撞 6.5% 上限，取 13');
ok(ImgCache._whiteRows(fakeCtx(1000, 1000, 200), 1000, 1000) === 65, '底部白到超出上限时只裁 6.5%（65 行）');
/* 黑边 + 进度条：v3.32 之前这一形态直接判 0（整行只有 70% 白），白带永远裁不掉 */
ok(ImgCache._whiteRows(fakeCtx(1000, 400, 20, { bar: 6 }), 1000, 400) === 16,
  '带黑边 + 进度条在带顶部：裁底部 14 行白 + 2 过渡（不乱啃条）');
/* 真正的「白 → 条 → 白」：条夹在中间时必须连条一起裁
   （600 高 → 上限 39 行，三段合计 26+2 = 28 不会被截断） */
ok(ImgCache._whiteRows(fakeCtx(1000, 600, 20, { bar: 6, barAt: 6 }), 1000, 600) === 22,
  '白 8 + 条 6 + 白 6 三段式：连条一起裁 20 行（+2 过渡 = 22）');
/* 三段合计超上限时按上限截住，不会无限往下啃 */
ok(ImgCache._whiteRows(fakeCtx(1000, 400, 40, { bar: 10, barAt: 12 }), 1000, 400) === 26,
  '三段合计 40 行超 6.5% 上限 → 按上限裁 26 行');
ok(ImgCache._whiteRows(fakeCtx(1000, 1000, 8, { boom: true }), 1000, 1000) === 0, '读不到像素时返回 0，不抛错');
ok(ImgCache._whiteRows(fakeCtx(100, 30, 5), 100, 30) === 3, '极矮的图：至少裁 3 行，不超过 5% 太多');

ok(ImgCache.url('', {}) instanceof Promise, 'url() 始终返回 Promise');
ok(ImgCache.url(null, {}) instanceof Promise, 'null 路径也不炸');

/* ───────────────────── 3. ESC 真关窗 ───────────────────── */
console.log('\n[3] ESC：IPC close → destroy → 常驻横幅');

const BR = read('EaglePDFReader/js/bridge.js');
ok(has(BR, "plugin.window."), 'bridge 保留 plugin.window. 通道作兜底（主进程会转发 BrowserWindow 方法）');
/* v3.30：关窗改走 @electron/remote —— 同步、有返回值，不必赌 IPC 有没有接住 */
ok(has(BR, "require('@electron/remote')"), '关窗优先走 @electron/remote');
ok(has(BR, 'function closeSelf()') && has(BR, 'w.close()'), 'closeSelf 调真正的 BrowserWindow.close()');
ok(has(BR, 'function destroySelf()') && has(BR, 'w.destroy()'), 'destroySelf 调 BrowserWindow.destroy()');
ok(has(BR, 'IPC_WINDOW_DENY'), 'v4.4.6：关闭类 IPC 已被硬拦截');
ok(has(BR, 'closeSelf,') && has(BR, 'destroySelf,'), '两者都从 Bridge 导出');
ok(has(BR, 'function focusParent('), '退出前能把 Eagle 主窗口叫回来（不再落到「最小化的 Eagle」）');
ok(has(BR, 'focusParent,'), 'focusParent 已导出');
ok(has(BR, 'function openPath('), '片段「打开」需要 shell.openPath');

const APP = read('EaglePDFReader/js/app.js');
ok(has(APP, 'function exitFailBanner('), '关不掉时给常驻横幅，而不是静默什么都不发生');
ok(has(APP, 'Bridge.closeSelf'), '退出先试 close');
ok(!has(APP, 'Bridge.destroySelf()'), 'v4.4.6：退出流程不再 destroy 主窗口');
ok(has(APP, 'window.__escHandledAt = Date.now()'), 'app.js 认领 ESC 时打时间戳');
ok(has(APP, "'Ctrl+W'") || has(APP, 'Ctrl+W'), 'Ctrl+W 也能退出');
ok(!has(APP, 'visibilityState === \'hidden\''), '不再把「藏起来」误判成「已关闭」');

const HTML = read('EaglePDFReader/index.html');
/* v3.31：内联那段「900ms 没认领就自己调 IPC 关窗」的兜底整段删除。
   它是第三个「ESC 会关窗口」的出口：全屏 / 输入法选词时会提前 return 不被认领，
   于是 900ms 后照样把窗口关了 —— 用户看到的就是「按 ESC 连 Eagle 一起没了」。 */
const iApp = HTML.indexOf('js/app.js');
ok(HTML.indexOf('__escHandledAt && window.__escHandledAt >= at') < 0, '内联 ESC 兜底脚本已删除');
ok(HTML.indexOf('function hardClose') < 0, '不再有「没认领就直接关窗」的代码');
ok(HTML.indexOf('那就自己关窗') < 0 && HTML.indexOf('ESC 的内联兜底') > -1, '原位置留了删除说明');
ok(has(HTML, 'js/saveas.js') && has(HTML, 'js/imgcache.js'), '两个新模块都引入了');
ok(HTML.indexOf('js/saveas.js') < iApp && HTML.indexOf('js/imgcache.js') < iApp, '新模块在 app.js 之前加载');

/* ───────────────────── 4. 只存路径 + 禁拖 ───────────────────── */
console.log('\n[4] 摘录：先收进右栏（素材目录）、索引只留路径、另存只在卡片上、图片不可拖');

ok(has(APP, 'function keepImageLocally('), '摘录图走 keepImageLocally（不弹框，直接进素材目录）');
ok(has(APP, "Store.joinPath(dd, 'media')") || has(APP, "'media'"), '素材目录是 <dataDir>/media');
ok(has(APP, 'imagePath: kept.path'), '索引里只记 imagePath，不存 base64');
ok(has(APP, 'filePath: res.path'), '片段只记 filePath');
ok(!/image:\s*dataUrl/.test(APP), '没有「把 dataURL 塞进 image 字段」的老写法了');
ok(has(APP, 'async function copyImageFileAs('), '卡片「另存原图」按字节复制，不重新编码');
ok(has(APP, 'async function handleAreaRect('), 'PDF 框选是异步的（要先取图才算完）');

/* 四个摘录入口都不该再弹另存为 —— 只允许「卡片按钮」这条路上弹 */
(function () {
  const pick = (name, endName) => {
    const i = APP.indexOf('function ' + name + '(');
    let j = APP.indexOf('function ' + endName + '(', i + 10);
    if (j < 0) j = APP.indexOf('async function ' + endName + '(', i + 10);
    return (i >= 0 && j > i) ? APP.slice(i, j) : '';
  };
  const areas = {
    '图片摘录': pick('runImageExcerpt', 'copySelectedImage'),
    'PDF 框选': pick('handleAreaRect', 'handleNotePoint'),
    '视频截图': pick('videoFrameExcerpt', 'pauseForVideo'),
  };
  Object.keys(areas).forEach((k) => {
    const body = areas[k];
    ok(!!body, k + '：找到函数体');
    ok(body.indexOf('keepImageLocally') >= 0, k + '：存进素材目录');
    ok(body.indexOf('saveImageAsFile') < 0, k + '：不再先弹另存为');
  });
  /* 视频框选在 vsArea 的回调里，单独看一段 */
  const iv = APP.indexOf('function vsArea(');
  const vsBody = iv >= 0 ? APP.slice(iv, iv + 3000) : '';
  ok(vsBody.indexOf('keepImageLocally') >= 0, '视频框选：存进素材目录');
  ok(vsBody.indexOf('saveImageAsFile') < 0, '视频框选：不再先弹另存为');
  /* 片段仍然弹框（用户明确要「片段另存为」） */
  const ic = APP.indexOf('async function saveClipAs(');
  const clipBody = ic >= 0 ? APP.slice(ic, ic + 1600) : '';
  ok(clipBody.indexOf('SaveAs.askEx') >= 0, '片段仍然先问保存位置（这是用户要的）');
})();

ok(has(APP, 'function annHasImage('), 'annHasImage 同时认 image 和 imagePath');
ok(has(APP, 'function appendCardImage('), '卡片按路径加载缩略图');
ok(has(APP, 'img.draggable = false'), '卡片图片显式禁止拖动');
ok(has(APP, 'dragstart'), '全局 dragstart 捕获，挡住所有 <img> 拖拽');
ok(has(read('EaglePDFReader/css/app.css'), '-webkit-user-drag'), 'CSS 层也禁拖（防止拖影先出现）');
ok(has(APP, 'function appendClipFile('), '片段卡片显示「▶ 文件名 · 时长」而不是空白缩略图');
ok(has(APP, '要独立文件点卡片上的「另存原图」'), '收进右栏后有提示，说明原图怎么拿出去');

/* ───────────────────── 5. 裁白边只影响显示 ───────────────────── */
console.log('\n[5] 白线：只在缩略图上裁，原图一像素不动');

ok(has(APP, 'ImgCache.url(ann.imagePath, { trim: trim })'), '卡片缩略图按类型决定是否 trim');
ok(has(APP, "const trim = ann.vt === 'shot' || ann.vt === 'clip'"), '只有视频整帧 / 片段封面才裁白边，PDF 框选不动');
ok(has(APP, 'captureNative('), '截图 / 框选走原分辨率采集');
ok(has(APP, "'image/png'") || has(APP, '"image/png"'), '原图存 PNG，不用 JPEG 二次压缩');
ok(has(read('EaglePDFReader/js/imgcache.js'), 'TRIM_MAX_RATIO = 0.06'), '裁切上限写在常量里，便于以后调');

/* ───────────────────── 6. 清除插件数据 ───────────────────── */
console.log('\n[6] 清除插件数据：wipe 模式与保留清单');

const ST = read('EaglePDFReader/js/store.js');
ok(has(ST, 'function wipeAll('), 'Store.wipeAll 存在');
ok(has(ST, "pathMod.join(dataDir, 'docs')") && has(ST, "pathMod.join(dataDir, 'pdfbak')"),
  'wipeAll 删 docs/ 与 pdfbak/');
ok(has(ST, "'index.json', 'trash.json', 'daily.json'"), 'wipeAll 删 index.json / trash.json / daily.json');
const iWipe = ST.indexOf('function wipeAll(');
const iWipeEnd = ST.indexOf('function readFileBuffer(');
const wipeBody = ST.slice(iWipe, iWipeEnd > iWipe ? iWipeEnd : iWipe + 2000);
ok(!/asr/.test(wipeBody), 'wipeAll 不碰 asr/（识别模型要保留，删了得重下几百 MB）');
ok(has(wipeBody, "mkdirSync(pathMod.join(dataDir, 'docs')"), '删完把 docs/ 重建，后续写入不报错');
ok(has(wipeBody, 'localStorage.removeItem'), 'localStorage 里的内容也一起清（回收站 / 历史 / 每日笔记 / 术语表）');
ok(has(wipeBody, "keep = { [THEME_KEY]: 1, [EPOCH_KEY]: 1 }"),
  '只留主题与数据版本两个纯设置项（有道开关 3.39 已随有道智云下线）');
ok(has(wipeBody, 'localStorage.setItem(EPOCH_KEY, EPOCH)'), '清完把数据版本号写回（否则下次启动会当成旧数据再迁一遍）');

ok(has(APP, 'clearAllData({wipe:true})') || has(APP, 'wipe:true'), '有 wipe 模式的入口');
ok(has(APP, "parts.push('删除 ' + wiped + ' 项插件数据文件')"), '提示里报出删了多少项');
ok(has(APP, 'ImgCache.clear()'), '换掉缓存，避免已删图片还挂在内存里');
ok(has(HTML, 'id="btnWbWipe"'), '界面上有「清除插件数据…」按钮');
ok(has(APP, 'btnWbWipe'), '按钮有绑定');
ok(has(APP, '不会动：PDF 正文本身'), '确认框写清楚不动什么');

/* ───────────────────── 7. 语音已下线 + 选区重建 ───────────────────── */
console.log('\n[7] 笔记语音已下线 + 划词不再整段闪');

const ED = read('EaglePDFReader/js/editor.js');
const HTML7 = read('EaglePDFReader/index.html');
const APP7 = read('EaglePDFReader/js/app.js');
const CSS7 = read('EaglePDFReader/css/app.css');
ok(!has(ED, 'VoiceInput.button'), '编辑器不再插麦克风（v3.30 按用户要求下线）');
ok(!has(ED, 'ne-mic'), '编辑器里也没有 mic 相关 class 了');
ok(!/^<script src="js\/voiceinput\.js"><\/script>$/m.test(HTML7), 'index.html 不再加载 voiceinput.js');
ok(!has(HTML7, 'id="npMicSlot"') && !has(HTML7, 'id="wbDailyMic"'), '两个麦克风插槽从 DOM 里删掉');
ok(!has(APP7, 'function initVoiceInputs'), '挂麦克风的初始化函数已删除');
ok(!has(APP7, 'initVoiceInputs()'), 'boot 里也不再调它');
ok(!has(CSS7, '.ne-mic') && !has(CSS7, '.mic-diag'), '麦克风相关样式一并清掉');

const VW = read('EaglePDFReader/js/viewer.js');
ok(has(VW, '_snapRange('), '有 _snapRange 负责把选区钉回真实字符');
ok(has(VW, 'sel.collapse(anchor.node, anchor.offset)') && has(VW, 'sel.extend(focus.node, focus.offset)'),
  '用 collapse + extend 重建选区（自动处理拖选方向）');
ok(!has(VW, 'sel.setBaseAndExtent('), '不再用 setBaseAndExtent（行间空白会被算成整段）');
ok(has(VW, 'band.moved'), '只有真的拖动过才修选区，点一下不会跳');

/* ───────────────────── 7b. 编辑器冒烟：真的把它跑起来 ─────────────────────
   3.28 首版就是这里翻车：语音按钮在 `const ta` 之前调用 VoiceInput.button(ta)，撞上 TDZ，
   boot 时抛 "Cannot access 'ta' before initialization"，页头挂一条「部分功能初始化失败」。
   静态断言查不出这种顺序错，所以这里用假 DOM 真跑一遍 create()：
   只要抛错、或者麦克风没挂上、或者麦克风拿到的不是输入框，就算失败。 */
console.log('\n[7b] 编辑器冒烟测试（假 DOM 真跑 create）');

function mkEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    title: '',
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    disabled: false,
    selectionStart: 0,
    selectionEnd: 0,
    _html: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) {
        if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (on) this._s.add(c); else this._s.delete(c);
      }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertAdjacentHTML() {},
    addEventListener(t, fn) { (this._ev = this._ev || {})[t] = fn; },
    removeEventListener() {},
    focus() { this._focused = true; },
    closest() { return null; },
    setAttribute() {},
    getAttribute() { return null; },
    remove() {},
    querySelector() { return null; }
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children.length = 0; }
  });
  Object.defineProperty(e, 'firstChild', { get() { return this.children[0] || null; } });
  return e;
}

/* 在假 DOM 里执行 editor.js，拿回 NoteEditor */
function loadEditor() {
  const src = read('EaglePDFReader/js/editor.js');
  const doc = { createElement: (t) => mkEl(t), addEventListener: () => {} };   // v4.2.8 selectionchange 监听
  const win = {};
  const fn = new Function('window', 'document', 'Markdown', 'VoiceInput',
    'requestAnimationFrame', 'cancelAnimationFrame', 'U', src + '\n;return NoteEditor;');
  const NoteEditor = fn(win, doc, { render: (md) => '<p>' + md + '</p>' },
    undefined, (cb) => 1, () => {}, { escapeHtml: (s) => String(s) });
  return { NoteEditor, win };
}

function walk(node, out) {
  (node.children || []).forEach((c) => { out.push(c); walk(c, out); });
  return out;
}

(() => {
  let err = null;
  let api = null;
  try {
    const { NoteEditor, win } = loadEditor();
    const root = mkEl('div');
    api = NoteEditor.create(root, {});
    ok(!!win.NoteEditor, 'editor.js 把自己挂到了 window.NoteEditor');
    const all = walk(root, []);
    const ta = all.filter((n) => n.className === 'ne-input')[0];
    ok(!!ta, '输入框建出来了');
    const mic = all.filter((n) => String(n.className).indexOf('mic') >= 0);
    ok(mic.length === 0, '工具栏里没有麦克风了，实际 ' + mic.length + ' 个');
    const bar = all.filter((n) => n.className === 'ne-toolbar')[0];
    const kids = bar ? bar.children.map((c) => c.className || c.tagName) : [];
    /* v4.2.7：「引用摘录」按钮按用户要求下线 —— 断言放宽为「工具栏末尾还有按钮」 */
    ok(kids.length > 0 && String(kids[kids.length - 1]).indexOf('md-btn') >= 0,
      '工具栏末尾保留按钮项（引用摘录已下线）：' + kids.join(','));
    ok(typeof api.getValue === 'function' && api.getValue() === '', 'API 可用，初值为空串');
    api.setValue('# 标题');
    ok(api.getValue() === '# 标题', 'setValue 写回正常');
  } catch (e) { err = e; }
  ok(!err, 'create() 不抛错' + (err ? '：' + err.message : ''));
})();

/* ───────────────────── 9. （已删除）麦克风分级兜底 ─────────────────────
   v3.30 把「笔记语音」整块下线，这段针对 voiceinput.js 的行为测试随之取消。
   语音没有消失：视频转字幕走的还是 asr.js / subtitle.js，那部分测试在
   test-v326.js 与 test-subtitle 里。 */

(async () => {
  /* ───────────────────── 11. 另存为三态与兜底链（v3.28.3） ─────────────────────
     这一段的由来：用户报「PDF 框选只能看见框，截不了图」。
     复盘发现 saveas.js 把「对话框根本没弹出来」和「用户点了取消」当成同一件事
     （都返回 ''），于是最要命的那种失败被静默吞掉 —— 什么也不保存、什么也不提示。 */
  console.log('\n[11] 另存为三态、不覆盖、日志、窗口截屏兜底');

  const os = require('os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglenote-283-'));
  const freshSaveAs = () => {
    const p = require.resolve('./EaglePDFReader/js/saveas.js');
    delete require.cache[p];
    return require(p);
  };
  const setDialog = (dialog) => { global.window = { eagle: dialog ? { dialog: dialog } : {} }; };

  {
    setDialog({ showSaveDialog: async () => ({ canceled: false, filePath: 'D:/tmp/a' }) });
    const SA = freshSaveAs();
    const r = await SA.askEx({ defaultPath: 'D:/tmp/a', filters: [{ extensions: ['png'] }] });
    ok(r.kind === 'path' && r.path === 'D:/tmp/a.png', '选了位置 → kind:path，并补回扩展名：' + JSON.stringify(r));
  }
  {
    setDialog({ showSaveDialog: async () => ({ canceled: true }) });
    const r = await freshSaveAs().askEx({});
    ok(r.kind === 'cancel', '用户点取消 → kind:cancel（这时才什么都不留）');
  }
  {
    /* 关键用例：主进程拿不到父窗口时会回 undefined */
    setDialog({ showSaveDialog: async () => undefined });
    const r = await freshSaveAs().askEx({});
    ok(r.kind === 'unavailable', '对话框回 undefined → kind:unavailable，不能当成「用户取消」：' + r.kind);
    ok(/宿主/.test(r.reason || ''), '给出可读原因：' + (r.reason || ''));
  }
  {
    setDialog({ showSaveDialog: async () => { throw new Error('boom'); } });
    const r = await freshSaveAs().askEx({});
    ok(r.kind === 'unavailable' && /boom/.test(r.reason || ''), '对话框抛错 → unavailable 且带原文');
  }
  {
    setDialog(null);
    const r = await freshSaveAs().askEx({});
    ok(r.kind === 'unavailable', '没有 dialog API → unavailable');
  }
  {
    /* 旧接口仍然保持「路径 / '' / null」三种返回 */
    setDialog({ showSaveDialog: async () => undefined });
    const r = await freshSaveAs().ask({});
    ok(r === null, 'ask() 对 unavailable 仍返回 null，旧调用点行为不变');
  }
  {
    const SA = freshSaveAs();
    const target = path.join(tmpRoot, '同名.png');
    fs.writeFileSync(target, 'x');
    const uniq = SA.uniquePath(target);
    ok(uniq !== target && /同名 \(2\)\.png$/.test(uniq), '同名文件已存在时自动加 (2)，不覆盖：' + uniq);
    const uniq2 = SA.uniquePath(path.join(tmpRoot, '还没用.png'));
    ok(/还没用\.png$/.test(uniq2), '不存在的路径原样返回');
  }

  /* 版本轴：日志模块真的会落盘（不是「写了段代码但没跑到」） */
  {
    global.Store = { getDataDir: () => tmpRoot };
    const p = require.resolve('./EaglePDFReader/js/dbg.js');
    delete require.cache[p];
    const Dbg = require(p);
    ok(Dbg.log('test', 'hello-283') === true, 'Dbg.log 返回 true 表示写成功');
    const out = Dbg.tail(20);
    ok(has(out, '[test] hello-283'), '日志里能读回刚写的那行：' + out.slice(0, 60));
    ok(Dbg.log('test', { a: 1, long: 'y'.repeat(500) }) === true, '对象参数也能记');
    const out2 = Dbg.tail(5);
    ok(!has(out2, 'y'.repeat(300)), '超长字符串被截断，不把日志撑爆');
    delete global.Store;
  }

  /* 静态：通道与兜底都在 */
  {
    const BR = read('EaglePDFReader/js/bridge.js');
    ok(has(BR, 'plugin.window.webContents.'), '走主进程的 webContents 转发（capturePage 拿的就是自己这个页面）');
    ok(has(BR, 'async function captureWindow'), '有窗口截屏兜底');
    ok(has(BR, 'async function windowProbe'), '有环境自检（判断窗口句柄拿没拿到）');
    ok(has(BR, "method: 'isMaximized'"), '自检用 isMaximized 探测：能回 true/false 才说明通道是通的');

    const VW = read('EaglePDFReader/js/viewer.js');
    ok(has(VW, 'client: { x: x1, y: y1, w: w, h: h }'), '框选把屏幕坐标一起交给上层（兜底截屏要用）');
  }

  /* app.js 的行为型断言 */
  {
    const APP = read('EaglePDFReader/js/app.js');
    const areaBody = (() => {
      const i = APP.indexOf('async function handleAreaRect');
      const j = APP.indexOf('function handleNotePoint', i);
      return APP.slice(i, j > i ? j : i + 4000);
    })();
    ok(areaBody.indexOf('try {') >= 0 && areaBody.indexOf('catch (e)') > 0, 'handleAreaRect 整段有 try/catch，异常不会再变成静默 rejection');
    ok(has(areaBody, "'area.begin'") && has(areaBody, 'Dbg.log'), '起手记一条日志');
    ok(has(areaBody, 'Bridge.captureWindow'), 'pdf.js 没出图时改用窗口截屏');
    ok(!/^\s{4}const image = await captureRegion/m.test(areaBody), '不再是「裸 await captureRegion」（这正是静默失败的写法）');

    const saveBody = (() => {
      const i = APP.indexOf('async function saveImageAsFile');
      const j = APP.indexOf('function fitImageSize', i);
      return APP.slice(i, j);
    })();
    ok(has(saveBody, 'SaveAs.askEx'), '改用三态 askEx');
    ok(has(saveBody, "asked.kind === 'cancel'") && has(saveBody, 'fallback: asked.kind'), '取消与不可用分开处理');
    ok(has(saveBody, 'SaveAs.uniquePath'), '兜底落盘不覆盖同名文件');
    ok(has(saveBody, 'assets'), '源目录拿不到时退到插件数据目录的 assets/');
    ok(has(APP, 'function toastSaved'), '有统一的保存提示（兜底时要说明为什么没弹框）');
  }

  /* 加载顺序 */
  {
    const HTML = read('EaglePDFReader/index.html');
    const iDbg = HTML.indexOf('js/dbg.js');
    const iApp = HTML.indexOf('js/app.js');
    const iStore = HTML.indexOf('js/store.js');
    ok(iDbg > 0, 'index.html 引入了 dbg.js');
    ok(iDbg > iStore && iDbg < iApp, 'dbg.js 在 store.js 之后、app.js 之前（要能用到 Store，也要先于业务代码）');
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  delete global.window;

  /* ───────────────────── 9b. 素材目录：真写文件 ───────────────────── */
  /* 这一段是真的落盘：把 store.js / saveas.js 用 vm 装进一个假浏览器环境，
     给一个临时数据目录，走一遍 keepImageLocally 的那几行，再看磁盘。 */
  console.log('\n[9b] 摘录图落进素材目录（真实文件系统）');

  (function () {
    const vm = require('vm');
    const os = require('os');
    const pathMod = require('path');

    function loadScript(file, exportName) {
      const code = fs.readFileSync(pathMod.join(ROOT, file), 'utf8')
        + '\n;globalThis.__x = ' + exportName + ';';
      const ls = {
        _d: {},
        getItem(k) { return (k in this._d) ? this._d[k] : null; },
        setItem(k, v) { this._d[k] = String(v); },
        removeItem(k) { delete this._d[k]; },
        key(i) { return Object.keys(this._d)[i]; },
        get length() { return Object.keys(this._d).length; }
      };
      const ctx = {
        require, console: { log() {}, warn() {}, error() {} },
        localStorage: ls, navigator: {}, Uint8Array, Buffer,
        atob, btoa, setTimeout, clearTimeout, module: { exports: {} }
      };
      ctx.globalThis = ctx;
      ctx.window = ctx;
      vm.createContext(ctx);
      vm.runInContext(code, ctx);
      return { api: ctx.__x, ctx };
    }

    const { api: Store } = loadScript('EaglePDFReader/js/store.js', 'Store');
    /* saveas.js 在自己的沙箱里跑，write() 用的是它那个全局的 Store，所以
       必须把 Store 塞进 **saveas 的** 上下文（塞错到 store 的上下文会静默失败） */
    const { api: SaveAs, ctx: sctx } = loadScript('EaglePDFReader/js/saveas.js', 'SaveAs');
    sctx.Store = Store;
    sctx.SaveAs = SaveAs;

    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'keepimg-'));
    Store.setDataDir(tmp);

    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const mediaDir = Store.joinPath(tmp, 'media');
    const target = SaveAs.uniquePath(Store.joinPath(mediaDir, '文档名-p3-框选.png'));
    const saved = SaveAs.writeDataUrl(target, PNG);

    ok(!!saved, '图片写进素材目录（media/ 目录会被自动建出来）');
    ok(saved && fs.existsSync(saved), '文件真的在盘上：' + saved);
    ok(saved && fs.statSync(saved).size > 0, '文件不是 0 字节');
    ok(saved && saved.indexOf(pathMod.join('media', '')) > 0, '落在 <dataDir>/media 下面');
    ok(saved && /\.png$/.test(saved), '扩展名按 dataURL 的类型给（PNG）');
    ok(saved && /文档名-p3-框选/.test(pathMod.basename(saved)), '文件名带「文档名-页码-动作」，回头能认出是哪来的');

    /* 同一个位置再写一次：不覆盖，自动加 (2) */
    const again = SaveAs.uniquePath(Store.joinPath(mediaDir, '文档名-p3-框选.png'));
    ok(again !== saved, '同名再摘一次不覆盖原文件');
    ok(/\(2\)/.test(again), '重名自动加 (2)，实际 ' + pathMod.basename(again));

    /* wipeAll 要把素材副本一起清掉，但不能碰 asr/ */
    fs.mkdirSync(pathMod.join(tmp, 'asr'), { recursive: true });
    fs.writeFileSync(pathMod.join(tmp, 'asr', 'model.bin'), 'x');
    const wiped = Store.wipeAll();
    ok(wiped > 0, 'wipeAll 报告删了 ' + wiped + ' 项');
    ok(!fs.existsSync(pathMod.join(tmp, 'media')), '清数据时 media/ 一起清掉（摘录图的副本）');
    ok(fs.existsSync(pathMod.join(tmp, 'asr', 'model.bin')), '识别模型仍然保留');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  })();

  /* ───────────────────── 10. 版本 ───────────────────── */
  console.log('\n[10] 版本号');
  const m1 = JSON.parse(read('EaglePDFReader/manifest.json'));
  const m2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '三段式版本号，实际 ' + m1.version);
  ok(/^\d+\.\d+\.\d+$/.test(m2.version), '三段式版本号，实际 ' + m2.version);

  console.log('\nPASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
