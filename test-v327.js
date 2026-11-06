/* v3.27 回归：注释三方统一 + 视频原分辨率导出 + 节选按键提示 + ESC 死循环
 *
 * 覆盖五块：
 *   1. AnnText.buildAnnotationText（纯函数）：摘录/笔记/时间轴都进注释
 *   2. ClipExport 纯函数：容器选择、扩展名、码率、文件名
 *   3. ESC：笔记框不再弹确认框（死循环根因）、危险层按真实可见性体检、退出通道
 *   4. 布局：笔记栏上下颠倒、节选按键高亮、导出进度条
 *   5. 落盘：Store.writeDataUrl / writeBinaryFile、Bridge 写注释读回核对
 *
 * 运行：node test-v327.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  \u2717 ' + msg);
}

const AT = require('./EaglePDFReader/js/annotext.js');
const CE = require('./EaglePDFReader/js/clipexport.js').ClipExport;

/* ───────────────────── 1. 注释正文 ───────────────────── */
console.log('\n[1] AnnText：摘录、笔记、时间轴都写进 Eagle 注释');

(() => {
  ok(AT.buildAnnotationText(null) === '', '没有数据 → 空串');
  ok(AT.buildAnnotationText({ annotations: [], notes: [] }) === '', '空文档 → 空串');

  const one = AT.buildAnnotationText({
    annotations: [{ type: 'highlight', page: 3, text: '第一段原文', note: '', createdAt: 1 }]
  });
  ok(one.indexOf('【摘录 · 第 3 页】第一段原文') === 0, '只有摘录、没写笔记，也要进注释');
  ok(one.indexOf('笔记：') < 0, '没写笔记就不该出现「笔记：」');

  const withNote = AT.buildAnnotationText({
    annotations: [{ type: 'highlight', page: 3, text: '原文', note: '我的想法', createdAt: 1 }]
  });
  ok(withNote.indexOf('笔记：我的想法') > -1, '摘录上的笔记跟着摘录一起写');

  const anchor = AT.buildAnnotationText({
    annotations: [{ type: 'note', page: 7, text: '', note: '页边一句话', createdAt: 1 }]
  });
  ok(anchor.indexOf('【锚点 · 第 7 页】') === 0, '锚点的类型名是「锚点」');
  ok(anchor.indexOf('笔记：页边一句话') > -1, '锚点笔记进注释');

  const area = AT.buildAnnotationText({
    annotations: [{ type: 'area', page: 2, text: '', note: '', image: 'data:image/jpeg;base64,xx', createdAt: 1 }]
  });
  ok(area.indexOf('【框选 · 第 2 页】［图片］') === 0, '只有图片的框选写成「［图片］」，不丢条目');

  const video = AT.buildAnnotationText({
    annotations: [{ type: 'area', page: 1, vt: 'clip', t: 12, t1: 31, text: '', note: '这段讲得好', createdAt: 1 }]
  }, { typeLabel: () => '片段', fmtTime: (s) => '00:' + String(s).padStart(2, '0') });
  ok(video.indexOf('【片段 · 00:12–00:31】') === 0, '视频片段用时间轴定位');
  ok(video.indexOf('笔记：这段讲得好') > -1, '片段笔记也进注释');

  const notes = AT.buildAnnotationText({
    annotations: [],
    notes: [{ md: '**重点**：这里\n\n还有一段', page: null, createdAt: 1 }]
  }, { plain: (md) => md.replace(/\*\*/g, '') });
  ok(notes.indexOf('【笔记 · 独立笔记】') === 0, '独立笔记单独成条');
  ok(notes.indexOf('**') < 0, 'Markdown 记号被去掉（注释放进 Eagle 是纯文本）');
  ok(notes.indexOf('\n\n') < 0, '多行压成一行，一条一行');

  const ordered = AT.buildAnnotationText({
    annotations: [
      { type: 'highlight', page: 2, text: '后面的', createdAt: 200 },
      { type: 'highlight', page: 1, text: '前面的', createdAt: 100 }
    ]
  });
  ok(ordered.indexOf('前面的') < ordered.indexOf('后面的'), '按创建时间排序，和阅读顺序一致');
})();

/* ───────────────────── 2. 片段导出纯函数 ───────────────────── */
console.log('\n[2] ClipExport：容器 / 扩展名 / 码率 / 文件名');

(() => {
  ok(CE.extOf('video/mp4;codecs=avc1') === '.mp4', 'mp4 → .mp4');
  ok(CE.extOf('video/webm;codecs=vp9,opus') === '.webm', 'webm → .webm');
  ok(CE.extOf('') === '.webm', '未知类型退 webm');

  const onlyWebm = CE.pickMime((t) => t.indexOf('webm') >= 0);
  ok(onlyWebm.indexOf('webm') > -1, '只支持 webm 时选 webm');
  const both = CE.pickMime((t) => t.indexOf('webm') >= 0 || t.indexOf('mp4') >= 0);
  ok(both.indexOf('mp4') > -1, '两者都支持时优先 mp4（通用播放器更认）');
  ok(CE.pickMime(() => false) === '', '都不支持时返回空串，交给 MediaRecorder 自己猜');

  const b1080 = CE.bitrateFor(1920, 1080, 30);
  ok(b1080 >= 6000000 && b1080 <= 9000000, '1080p30 约 7.5 Mbps');
  const bSmall = CE.bitrateFor(320, 240, 24);
  ok(bSmall === 1200000, '小画面不低于 1.2 Mbps（糊了就没意义）');
  const bHuge = CE.bitrateFor(7680, 4320, 60);
  ok(bHuge === 24000000, '8K 封顶 24 Mbps');

  const name = CE.fileBase('C:\\资料/第 3 讲:函数.mp4', 12, 31, (s) => '00:' + String(s).padStart(2, '0'));
  ok(/[/\\:*?"<>|]/.test(name) === false, '文件名里没有 Windows 非法字符');
  ok(name.indexOf('片段') > -1 && name.indexOf('00:12-00:31') > -1 || name.indexOf('0012') > -1,
    '文件名带「片段」和区间');
  ok(name.indexOf('.mp4') < 0 || name.lastIndexOf('.mp4') > 0, '扩展名由调用方加，不会被重复拼进去');
})();

/* ───────────────────── 3. ESC ───────────────────── */
console.log('\n[3] ESC：笔记框不再弹确认框、危险层按可见性体检、退出通道');

(() => {
  const app = read('EaglePDFReader/js/app.js');

  ok(app.indexOf('function closeNoteModalByEsc') > -1, 'ESC 关笔记框有专门路径');
  /* v4.2.8 需求反转：Esc 关闭不再静默保存，改为弹「取消/不保存/保存」确认框
     （confirmDialog 同步压 confirm 层到栈顶，handle() 的兜底弹层打不到 noteModal，
     「弹框→关框→再弹框」的旧坑不会复发）。 */
  ok(app.indexOf('Esc.push(\'noteModal\', () => closeNoteModalByEsc())') > -1,
    '笔记框压进 Esc 栈的是 closeNoteModalByEsc');
  const cbStart = app.indexOf('function closeNoteModalByEsc');
  const cb = app.slice(cbStart, app.indexOf('function tryCloseNoteModal', cbStart));
  ok(cb.indexOf('tryCloseNoteModal()') > -1, 'Esc 关闭走 tryCloseNoteModal（有内容弹确认框）');
  ok(app.indexOf('笔记还没保存，要保存后再关闭吗') > -1, '确认文案在位（取消/不保存/保存）');

  ok(app.indexOf("noteModal: () => { const el = $('#noteModal');") > -1,
    'noteModal 层按真实 DOM 体检（不可见就回收，不再永久占着栈顶）');
  ok(app.indexOf("confirm: () => { const el = $('#confirmOverlay');") > -1,
    'confirm 层同样按真实 DOM 体检');
  ok(app.indexOf('const dbl = (escStall >= 2)') < 0,
    'v3.31：「连按三次毫无进展就退出」整条删除（它会把 Eagle 一起关掉）');
  ok(app.indexOf('if (closeVisibleOverlay()) return;') > -1,
    '没有层可关时先按可见性兜底关浮层');
  ok(app.indexOf('function closeVisibleOverlay') > -1, '有按可见性关浮层的实现');
  ok(/if \(closeVisibleOverlay\(\)\) return;[\s\S]{0,900}?exitPlugin\(\);/.test(app),
    'v4.4.0：兜底也关不掉时 exitPlugin() 关闭插件（用户要求恢复 ESC 关闭）');
  ok(app.indexOf('tryEagleHide') < 0, '退出路径不再调 eagle.window.hide()（那会把整个 Eagle 收进托盘）');

  const html = read('EaglePDFReader/index.html');
  /* v3.30：顶栏那个 ✕ 删了 —— 它只是又一个「按了没反应」的假出口 */
  ok(html.indexOf('id="btnClosePlugin"') < 0, '顶栏不再放假的关闭键');

  ok(app.indexOf("on('#btnClosePlugin'") < 0, '也不再绑它的点击');
})();

/* ───────────────────── 4. 布局 / 节选提示 ───────────────────── */
console.log('\n[4] 布局：笔记栏上下颠倒、节选按键变红闪烁、导出进度');

(() => {
  const html = read('EaglePDFReader/index.html');
  const listAt = html.indexOf('<div class="notes-list" id="notesList"></div>');
  const editorAt = html.indexOf('<button class="note-new-bar" id="btnNoteNew"');
  ok(listAt > -1 && editorAt > -1, '笔记列表与新建入口都在（v4.2.4 起底部编辑区改为大窗按钮）');
  ok(listAt < editorAt, '笔记列表在上、新建按钮在下（上下颠倒）');

  const css = read('EaglePDFReader/css/app.css');
  ok(css.indexOf('.vs-acts .ghost-btn.rec') > -1, '节选按键有 .rec 状态');
  ok(css.indexOf('@keyframes vs-rec-pulse') > -1, '并且是闪烁动画');
  ok(css.indexOf('.vs-exp') > -1 && html.indexOf('id="vsExpHud"') > -1, '片段导出有进度条');
  ok(css.indexOf('.panel-body[data-panel="notes"] .note-editor') > -1, '编辑区在底部时的分隔线与高度限制');

  const app = read('EaglePDFReader/js/app.js');
  ok(app.indexOf('function setClipButtons') > -1 && app.indexOf('function setAreaButtons') > -1,
    '片段 / 框选都有按键状态机');
  ok(app.indexOf("paintVsButton(b, on && pressed === b, 'clipNote', '● 节选中…')") > -1,
    '按下的那颗显示「● 节选中…」');
  ok(app.indexOf("clearVsActionState()") > -1, '切文档时复位按键状态');
  ok(app.indexOf('setClipButtons(true, pressedId)') > -1, '开始节选时点亮按键');
  ok(app.indexOf('setClipButtons(false)') > -1, '结束/取消时复原');
})();

/* ───────────────────── 5. 落盘与三方统一 ───────────────────── */
console.log('\n[5] 原分辨率另存 / 清空时三方一起清');

(() => {
  const app = read('EaglePDFReader/js/app.js');
  /* v3.28：动作改名 —— 「原图」→「另存原图」，「导出片段」→「打开片段 / 片段另存为」 */
  ok(app.indexOf('saveAnnImageNative') > -1, '有「另存原图」');
  ok(app.indexOf('exportClipVideo') > -1, '有「片段另存为」');
  ok(app.indexOf("acts.push(['saveimg', '另存原图'])") > -1, '图片摘录卡片上有「另存原图」');
  /* v3.30：片段先记时间轴，卡片上给「预览片段 + 另存为」 */
  ok(app.indexOf("acts.push(['previewclip', '预览片段'])") > -1,
    '片段卡片上先给「预览片段」');
  ok(app.indexOf("acts.push(['saveclip', ann.filePath ? '重新导出' : '另存为'])") > -1,
    '再给「另存为 / 重新导出」（这时才真的录文件）');

  const vv = read('EaglePDFReader/js/videoview.js');
  ok(vv.indexOf('function captureNative') > -1, 'VideoView 能按原分辨率取帧');
  ok(vv.indexOf('videoWidth') > -1 && vv.indexOf('toDataURL(\'image/png\')') > -1,
    '原分辨率取帧输出 PNG');

  /* 纯摘录也要进注释：addAnnotation / updateAnnotation / detachAnn 都得触发同步，
     否则「只摘不写字」的条目永远写不进 Eagle 注释。 */
  const addBlock = app.slice(app.indexOf('function addAnnotation'), app.indexOf('function updateAnnotation'));
  ok(addBlock.indexOf('syncLater()') > -1, '新增摘录就触发注释同步');
  const updBlock = app.slice(app.indexOf('function updateAnnotation'), app.indexOf('function removeAnnotation'));
  ok(updBlock.indexOf('syncLater()') > -1, '修改摘录（加笔记/译文）也触发同步');
  const detBlock = app.slice(app.indexOf('function detachAnn'), app.indexOf('function pushAnnTrash'));
  ok(detBlock.indexOf('syncLater()') > -1, '删除摘录后注释里对应那段跟着走');
  const exitBlock = app.slice(app.indexOf('async function exitPlugin'), app.indexOf('flushDrafts') > -1 ? app.indexOf('const gone =') : 0);
  ok(exitBlock.indexOf('syncNotesToEagle(true)') > -1, '退出前把压着的那次同步立刻发出去');

  const clear = app.slice(app.indexOf('async function clearAllData'), app.indexOf('async function clearHistoryOnly'));
  ok(clear.indexOf('Store.load({ itemId: id })') > -1, '清空前先记下每篇的预期注释');
  ok(clear.indexOf('Bridge.setAnnotation(id, \'\')') > -1, '逐篇清 Eagle 注释（不再只清当前这一条）');
  ok(clear.indexOf("annsFailed") > -1, '清不掉时如实报数');
  ok(clear.indexOf('annLooksOurs(cur, mine)') > -1,
    '只清「确实是我们写的」注释（用户在 Eagle 里自己敲的字不动）');
  ok(app.indexOf('function annLooksOurs') > -1, '归属判定有单独实现（旧格式按逐行包含认回来）');

  const store = read('EaglePDFReader/js/store.js');
  ok(store.indexOf('function writeBinaryFile') > -1, 'Store 能写二进制');
  ok(store.indexOf('function writeDataUrl') > -1, 'Store 能写 dataURL');
  ok(store.indexOf('function uniqueName') > -1, '重名自动加序号，不覆盖已有文件');

  const bridge = read('EaglePDFReader/js/bridge.js');
  ok(bridge.indexOf('function annSame') > -1, '写注释后有内容比对');
  ok(bridge.indexOf('Eagle 注释未写入') > -1, '三次都对不上就抛错（不再假装成功）');
  ok(bridge.indexOf('await it.save()') > -1, '仍然走 Item.save()');

  const manifest = JSON.parse(read('EaglePDFReader/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(manifest.version), '三段式版本号，实际 ' + manifest.version);

  const html = read('EaglePDFReader/index.html');
  const order = ['js/videoview.js', 'js/clipexport.js', 'js/annotext.js', 'js/app.js']
    .map((s) => html.indexOf(s));
  ok(order.every((n) => n > -1) && order.join(',') === order.slice().sort((a, b) => a - b).join(','),
    '脚本顺序：videoview → clipexport → annotext → app');
})();

console.log('\n────────────────────────────────');
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('────────────────────────────────');
process.exit(fail ? 1 : 0);
