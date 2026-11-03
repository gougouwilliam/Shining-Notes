/* test-selection.js —— v3.21.0：PDF 划词「整片泛蓝 / 跟不上鼠标」的回归测试
 *
 * 三处改动的验证：
 *   ① 拖选守卫：mousedown→mouseup 之间 isSelecting() 为真，且能自我复位（含 blur / pointercancel）
 *   ② 悬停蓝框：拖选期间 _bindHover 的 move 直接短路，不再画 .link-hover、不再解析图片几何
 *   ③ CSS 命中区：层 user-select:none / 只有 span 可选 / 框选·锚点工具连 span 一起关
 * 另加 app.js 接线断言与版本一致性。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---- 在沙箱里加载 PdfViewer 类（只取定义，不跑构造函数） ---- */
const src = read('EaglePDFReader/js/viewer.js');
const listeners = { document: {}, window: {} };
const fakeDoc = {
  addEventListener(type, fn) { (listeners.document[type] ||= []).push(fn); },
  removeEventListener() {}
};
const fakeWin = {
  addEventListener(type, fn) { (listeners.window[type] ||= []).push(fn); },
  removeEventListener() {}
};
const U = {
  rafThrottle: (fn) => fn,
  debounce: (fn) => fn,
  el: () => ({ style: {}, remove() {} }),
  clamp: (v) => v,
  clamp01: (v) => v
};
const PdfViewer = new Function('document', 'window', 'U', 'NodeFilter',
  src + '\nreturn PdfViewer;')(fakeDoc, fakeWin, U, {});

function fire(scope, type, evt) {
  (listeners[scope][type] || []).forEach((fn) => fn(evt));
}
function makeStub() {
  const inst = Object.create(PdfViewer.prototype);
  inst._selecting = false;
  inst._hoverCalls = 0;
  inst._overlayCalls = 0;
  inst._setHover = function () { this._hoverCalls++; };
  inst.ensureOverlays = function () { this._overlayCalls++; };
  inst.pagesEl = {
    style: {},
    addEventListener(type, fn) { (this._h ||= {})[type] = fn; }
  };
  return inst;
}
const inPage = { closest: (sel) => (sel === '.page' ? {} : null) };
const offPage = { closest: () => null };

console.log('\n[1] 拖选守卫：按下才进入，抬起/失焦/取消都要复位');
(() => {
  const v = makeStub();
  v._bindSelectGuard();

  ok(v.isSelecting() === false, '初始不在拖选');

  fire('document', 'mousedown', { button: 0, target: inPage });
  ok(v.isSelecting() === true, '页内左键按下 → isSelecting() 为真');
  ok(v._hoverCalls === 1, '按下时清掉已有的悬停蓝框');

  fire('document', 'mouseup', {});
  ok(v.isSelecting() === false, '抬起 → 复位');

  fire('document', 'mousedown', { button: 0, target: inPage });
  fire('window', 'blur', {});
  ok(v.isSelecting() === false, '拖出窗口失焦 → 复位（不会卡死）');

  fire('document', 'mousedown', { button: 0, target: inPage });
  fire('document', 'pointercancel', {});
  ok(v.isSelecting() === false, 'pointercancel → 复位');

  v._selecting = false;
  fire('document', 'mousedown', { button: 2, target: inPage });
  ok(v.isSelecting() === false, '右键按下不算划词');

  v._selecting = false;
  fire('document', 'mousedown', { button: 0, target: offPage });
  ok(v.isSelecting() === false, '页外按下不算划词（面板/工具条照常）');
})();

console.log('\n[2] 悬停蓝框：拖选期间必须短路');
(() => {
  const v = makeStub();
  v.tool = 'select';
  v._links = new Map();
  v._imgs = new Map();
  v.findLinkAt = () => null;
  v.findImageAt = () => null;
  v._bindHover();
  const move = v.pagesEl._h.mousemove;
  ok(typeof move === 'function', 'mousemove 监听已注册');

  const fakePage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }), dataset: { page: '1' } };
  const evt = { target: { closest: () => fakePage }, clientX: 100, clientY: 100 };

  v._selecting = true;
  v._overlayCalls = 0; v._hoverCalls = 0;
  move(evt);
  ok(v._overlayCalls === 0, '拖选中不解析图片几何（不触发 ensureOverlays）');
  ok(v._hoverCalls === 1, '拖选中只清悬停框，不画新框');

  v._selecting = false;
  v._overlayCalls = 0;
  move(evt);
  ok(v._overlayCalls === 1, '非拖选时恢复正常的悬停探测');
})();

console.log('\n[3] app.js：selectionchange 必须让位给拖选守卫');
(() => {
  const app = read('EaglePDFReader/js/app.js');
  const i = app.indexOf('function onSelectionChange()');
  const blk = app.slice(i, app.indexOf('function onDocumentMouseUp', i));
  ok(i > 0, '存在 onSelectionChange');
  ok(blk.indexOf('viewer.isSelecting') > 0, '回调里有 isSelecting 闸门');
  ok(blk.indexOf('viewer.isSelecting') < blk.indexOf('viewer.snapshotSelection'),
    '闸门在快照之前（否则仍会强制布局）');
  ok(/onDocumentMouseUp[\s\S]{0,700}?viewer\.snapshotSelection\(\)/.test(app),
    'mouseup 仍会取一次完整快照（几何结果不丢）');
  ok(app.indexOf("_bindSelectGuard()") < 0, '守卫只由 viewer 自己注册');
})();

console.log('\n[4] viewer.js：守卫接线');
(() => {
  const s = read('EaglePDFReader/js/viewer.js');
  ok(s.indexOf('this._bindSelectGuard();') > 0, '构造函数注册守卫');
  ok(s.indexOf('this._bindSelectGuard();') < s.indexOf('this._bindHover();'),
    '守卫先于 hover 注册');
  ok(/isSelecting\(\)\s*\{\s*return !!this\._selecting;\s*\}/.test(s), 'isSelecting 读取真实标志');
  const hv = s.slice(s.indexOf('_bindHover() {'));
  ok(hv.indexOf('if (this._selecting)') > 0, 'hover 回调首行判拖选');
  ok(hv.indexOf('tool !==') > 0, '非 select 工具仍照旧清框');
})();

console.log('\n[5] CSS：命中区收敛到 span，工具模式下彻底禁选');
(() => {
  const css = read('EaglePDFReader/css/viewer.css');
  const layer = css.slice(css.indexOf('.textLayer {'), css.indexOf('.textLayer span,'));
  ok(/user-select:\s*none/.test(layer), '文字层本身不可选（空白处不再起选）');
  ok(/contain:\s*paint/.test(layer), 'contain:paint 把重绘关在层内');
  ok(/overflow:\s*hidden/.test(layer), '仍保留 overflow:hidden');

  ok(/\.textLayer span\s*\{\s*user-select:\s*text;\s*\}/.test(css), '只有 span 可选字');
  ok(/\.textLayer br,\s*\.textLayer span\.markedContent,\s*\.textLayer \.endOfContent\s*\{\s*user-select:\s*none/.test(css),
    'br / markedContent / endOfContent 明确不可选');
  ok(/\.tool-area \.textLayer span,\s*\.tool-note \.textLayer span\s*\{\s*user-select:\s*none/.test(css),
    '框选/锚点工具连 span 一起禁选（补上覆盖关系的漏洞）');
  /* v3.22：原生 ::selection 彻底透明，改画 .sel-band 柔和条带 */
  ok(/\.textLayer ::selection,\s*\.textLayer br::selection\s*\{\s*background:\s*transparent/.test(css),
    '原生选区已透明（不再整片泛蓝）');
  ok(/\.selBandLayer\s*\{/.test(css) && /\.sel-band\s*\{/.test(css), '条带层与条带样式已定义');
  ok(/\.tool-highlight \.sel-band/.test(css), '高亮工具下条带预览为琥珀色');
})();

console.log('\n[6] 版本与文档');
(() => {
  const mf = JSON.parse(read('EaglePDFReader/manifest.json'));
  const wb = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(mf.version === wb.version && /^\d+\.\d+\.\d+$/.test(mf.version), '两个插件版本同步（三段式），实际 ' + mf.version);
  const rd = read('EaglePDFReader/README.md');
  ok(rd.indexOf('当前版本 **' + mf.version + '**') > 0, 'README 当前版本与 manifest 一致');
  ok(rd.indexOf('3.22.0（ESC') > 0, 'README 有 3.22.0 说明');
  ok(rd.indexOf('3.21.0（划词') > 0, 'README 保留 3.21.0 划词说明');
  ok(/selectionchange/.test(rd) && /user-select/.test(rd), 'README 写清三条根因');
})();

console.log('\n========================================');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
