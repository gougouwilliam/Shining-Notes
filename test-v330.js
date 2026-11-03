/* v3.30 回归：专业词表、片段「先记时间轴」、白边、笔记预览、ESC 回主窗
 *
 * 这一版修的是用户连着报的 13 条，测试按「能被机器验证的」拆开：
 *   1. 专业词表（DomainTerms）：医学/生命科学词条、领域归一化、就近挑词、提示词
 *   2. 字幕接上领域：热词偏置 + 语境校对提示词 + 界面下拉
 *   3. 片段：不再拦路录文件（先建记录），预览在视频窗口里按 A→B 播
 *   4. 底部白边：只裁底部连续纯白且 ≤6%，白底画面不碰
 *   5. 视频笔记有预览图（collectNotes 带 imagePath / renderNotes 用 ImgCache）
 *   6. 另存为：2.6 秒还不出现就判定「没弹出来」，不干等 120 秒
 *   7. 退出：先叫回 Eagle 主窗口，再关自己；顶栏不再有假的 ✕
 *   8. 笔记语音整块下线
 *
 * 运行：node test-v330.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
/* 仓库里的文件是 CRLF（Windows），断言里有换行的地方统一按 LF 比 */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const has = (src, s) => src.indexOf(s) >= 0;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

const APP = read('EaglePDFReader/js/app.js');
const VW = read('EaglePDFReader/js/videoview.js');
const BR = read('EaglePDFReader/js/bridge.js');
const SUB = read('EaglePDFReader/js/subtitle.js');
const HTML = read('EaglePDFReader/index.html');
const CSS = read('EaglePDFReader/css/app.css');
const DT = require('./EaglePDFReader/js/domainterms.js');

/* ───────────────────── 1. 专业词表 ───────────────────── */
console.log('\n[1] 专业词表：医学 / 生命科学');

ok(DT.MEDICAL.length >= 120, '医学词条 ' + DT.MEDICAL.length + ' 条（≥120）');
ok(DT.LIFE.length >= 80, '生命科学词条 ' + DT.LIFE.length + ' 条（≥80）');
ok(DT.MEDICAL.indexOf('胆囊三角') >= 0, '医学词表里有「胆囊三角」（用户的真实例子）');
ok(DT.MEDICAL.indexOf('脾动脉') >= 0, '有「脾动脉」');
ok(DT.MEDICAL.indexOf('胰十二指肠切除术') >= 0, '有术式「胰十二指肠切除术」');
ok(DT.LIFE.indexOf('线粒体') >= 0 && DT.LIFE.indexOf('聚合酶链反应') >= 0, '生命科学词表覆盖细胞器与实验方法');
ok(DT.MISHEAR.length >= 20, '常见听错示例 ' + DT.MISHEAR.length + ' 条（给校对模型做 few-shot）');
ok(DT.MISHEAR.some((p) => p[0] === '单囊三角' && p[1] === '胆囊三角'), '「单囊三角 → 胆囊三角」在里面');

ok(DT.normalize('medical') === 'medical', 'normalize 保留 medical');
ok(DT.normalize('medical+life') === 'medical+life', 'normalize 保留组合值');
ok(DT.normalize('general') === 'general', 'normalize(general) 还是 general');
ok(DT.normalize('') === 'general' && DT.normalize(null) === 'general', '空值落到 general');
ok(DT.normalize('医学') === 'general', '不认识的值不硬猜，落回 general');

ok(DT.terms('general').length === 0, '通用领域不带任何专业词');
const both = DT.terms('medical+life');
ok(DT.MEDICAL.every((t) => both.indexOf(t) >= 0) && DT.LIFE.every((t) => both.indexOf(t) >= 0),
  '组合领域包含两张表的全部词（' + both.length + ' 条，去重后）');
ok(DT.label('medical') === '医学' && DT.label('medical+life') === '医学 + 生命科学', '界面标签');

/* nearby：只挑跟这句话沾边的，不能把整表塞给模型 */
const near = DT.nearby('我们把脾动脉从胰体尾上游离出来', 'medical', 10);
ok(near.length > 0, 'nearby 能挑出词：' + near.slice(0, 5).join('、'));
ok(near.indexOf('脾动脉') >= 0, '句子里出现的词优先');
ok(near.indexOf('胰腺') >= 0 || near.indexOf('胰体尾') >= 0, '同段的近义词也带上了');
ok(near.length <= 10, '结果不超过 limit');
ok(DT.nearby('今天天气不错', 'general', 10).length === 0, '通用领域没有词可挑');

const block = DT.promptBlock('medical', '胆囊三角的解剖，注意胆囊动脉');
ok(has(block, '医学'), '提示词里写明领域');
ok(has(block, '胆囊三角'), '提示词带上相关术语');
ok(has(block, '单囊三角 → 胆囊三角'), '提示词带上「听错 → 正确」示例');
ok(DT.lcs('胆囊三角', '单囊三角') === 3, '最长公共子串 = 3（胆囊三角/单囊三角）');

/* ───────────────────── 2. 字幕接上领域 ───────────────────── */
console.log('\n[2] 字幕：热词偏置 + 语境校对 + 下拉');

ok(has(SUB, 'DomainTerms.terms(domain())'), '热词表里加入领域词（识别时偏置）');
ok(has(SUB, "const LS_DOMAIN = 'eaglenote.sub.domain'"), '领域选择记在本地');
ok(has(SUB, 'DomainTerms.promptBlock(domain()'), '语境校对提示词里加入领域词');
ok(has(SUB, 'function setDomain(') && has(SUB, 'refreshHotwords();'), '换领域会立刻重挂热词');
ok(has(SUB, 'domain, setDomain,'), '导出 domain / setDomain');

ok(has(HTML, 'id="subDomain"'), '字幕面板有领域下拉');
ok(has(HTML, '<option value="medical">医学</option>'), '有「医学」选项');
ok(has(HTML, '<option value="life">生命科学</option>'), '有「生命科学」选项');
ok(has(HTML, '<option value="medical+life">医学 + 生命科学</option>'), '可以两个都要');
ok(has(HTML, 'js/domainterms.js'), 'index.html 加载了词表模块');
ok(has(CSS, '.sub-domain'), '下拉有样式');
ok(HTML.indexOf('js/domainterms.js') < HTML.indexOf('js/subtitle.js'), '词表在 subtitle.js 之前加载');

/* ───────────────────── 3. 片段：先记时间轴 ───────────────────── */
console.log('\n[3] 片段：先记时间轴，要文件时才录');

const clipStart = APP.indexOf('function videoClip(');
const clipBody = APP.slice(clipStart, APP.indexOf('async function attachClipPoster', clipStart));
ok(clipStart > 0, '有 videoClip');
ok(!/await\s+saveClipAs/.test(clipBody), 'videoClip 里不再 await 录制（这就是「点了没反应」的根源）');
ok(has(clipBody, 'addAnnotation({'), '先把记录建出来');
ok(has(clipBody, "vt: 'clip'"), '记录类型是 clip');
ok(!/pauseForVideo\(\)/.test(clipBody), '建片段不再暂停视频');
ok(has(clipBody, 'attachClipPoster(ann, a)'), '预览图后台补，不挡笔记框');
ok(has(clipBody, 'openComposer('), '「并笔记」能立刻弹输入框');

ok(!/pauseForVideo\(\);\s*\/\/ 取终点才停/.test(APP), '第二次点片段不再先暂停');
const vsClipBody = APP.slice(APP.indexOf('function vsClip('), APP.indexOf('function updateVideoToolLabels('));
ok(!/^\s*pauseForVideo\(\);/m.test(vsClipBody), 'vsClip 收尾不暂停（只剩注释里提到它）');

ok(has(APP, 'function previewClip('), '有「预览片段」');
ok(has(APP, 'VideoView.playRange(ann.t, ann.t1)'), '预览=在视频窗口里按 A→B 播');
ok(has(APP, "acts.push(['previewclip', '预览片段'])"), '片段卡片有「预览片段」');
ok(has(APP, "acts.push(['saveclip', ann.filePath ? '重新导出' : '另存为'])"), '文件要的时候才「另存为」');
ok(!has(APP, "acts.push([ann.filePath ? 'openclip' : 'saveclip'"), '卡片不再用「打开片段」（不走系统播放器）');

const expBody = APP.slice(APP.indexOf('async function exportClipVideo('), APP.indexOf('async function videoFrameExcerpt('));
ok(!has(expBody, 'Bridge.openPath'), 'exportClipVideo 不再用系统播放器打开');

ok(has(VW, 'function playRange('), 'VideoView 有 playRange');
ok(has(VW, 'rangeStop'), '有终点定时器');
ok(has(VW, 'if (rangeStop != null && video.currentTime >= rangeStop'), '到 B 点自动暂停');

ok(has(APP, "if (ann.vt === 'clip') appendClipFile(card, ann)"), '片段卡片一定显示时间区间（不再只在没图时显示）');
ok(has(APP, "class: 'ec-clip'"), '时间区间用 .ec-clip');
ok(has(CSS, '.ec-clip'), '有对应样式');

ok(has(APP, "if (n.vt === 'clip' && n.t != null && n.t1 != null)"), '笔记里也显示片段区间');

/* ───────────────────── 4. 底部白边 ───────────────────── */
console.log('\n[4] 视频底部白带：显示裁掉、截图也裁掉');

ok(has(VW, 'function analyzeBand('), '有白边探测');
ok(has(VW, 'Math.min(h, Math.round(maxRows || h * 0.05))'), '探测上限 5% 高度（v3.32 起）');
ok(has(VW, 'dark <= samples * 0.6'), '先量内容列：左右黑边不算在内（v3.32 起）');
ok(has(VW, 'if (r >= 0.42 && r < 0.98) B++;'), '烧进画面的进度条（0.42~0.98 白）算白带里的条');
ok(has(VW, '(B >= 3 && C >= 3)'), '条之上必须再出现整行白（C），才连条一起裁');
ok(has(VW, 'if (A < 2) {'), '底部不是整行白 → 判为画面内容，不裁');
ok(has(VW, 'function trimCanvas('), '有裁剪画布');
ok(has(VW, 'function detectCrop(') && has(VW, 'function applyCrop('), '播放器里也裁（clip-path）');
ok(has(VW, 'inset(0 0 '), '用的是 clip-path inset');
ok(has(VW, "video.addEventListener('loadeddata', () => { detectCrop()"), '画面出来就量一次');
ok(has(VW, "video.addEventListener('seeked', () => { detectCrop()"), '换帧后再量（片头可能是另一种画面）');
ok(has(VW, 'const visibleH = vh * (1 - cropPct / 100)'), '框选不会把裁掉的那条算进去');

const drawNativeBody = VW.slice(VW.indexOf('function drawNative('), VW.indexOf('function captureNative('));
ok(has(drawNativeBody, 'trimCanvas(c)'), '原分辨率截图裁掉白边');
ok(has(drawNativeBody, 'const full = !(rect && rect.w > 0 && rect.h > 0)'), '只裁整帧，框选区域不动');
ok(has(CSS, '.vs-frame {\n  background: #000;'), '画面下方用黑底接住，不露出白');

ok(!has(HTML, 'id="videoEl" controls'), '去掉原生 controls（它盖住白边，鼠标一移开就露）');
ok(has(HTML, 'id="btnVsPlay"') && has(HTML, 'id="btnVsMute"') && has(HTML, 'id="btnVsFull"'), '补回播放/静音/全屏三个键');
ok(has(VW, 'function syncCtrl('), '三个键的状态会跟着播放状态更新');
ok(has(VW, 'function toggleFull('), '全屏可用');
ok(has(CSS, '.vs-cbtn'), '控制键有样式');
ok(has(CSS, '.video-stage:fullscreen'), '全屏时铺满');

/* ───────────────────── 5. 笔记预览图 ───────────────────── */
console.log('\n[5] 视频笔记的预览图');

ok(has(APP, 'imagePath: a.imagePath || \'\''), 'collectNotes 带上 imagePath');
ok(has(APP, 'if (n.image || n.imagePath) {'), '笔记卡片认路径图');
ok(has(APP, "const trim = n.vt === 'shot' || n.vt === 'clip';"), '视频图缩略图同样裁白边');
ok(has(APP, "img.draggable = false;") , '笔记里的图也不能拖');

/* ───────────────────── 6. 另存为不再干等 ───────────────────── */
console.log('\n[6] 另存为：框没出现就不再干等 120 秒');

(async () => {
  const os = require('os');
  const fresh = () => {
    const p = require.resolve('./EaglePDFReader/js/saveas.js');
    delete require.cache[p];
    return require(p);
  };

  /* 正常：1 秒后返回路径 → 照常拿到 path（不能因为「早退」误判） */
  global.window = { eagle: { dialog: { showSaveDialog: () => new Promise((r) => setTimeout(() => r({ filePath: 'D:/a/b' }), 600)) } } };
  let t0 = Date.now();
  let r = await fresh().askEx({ filters: [{ extensions: ['png'] }] });
  ok(r.kind === 'path' && r.path === 'D:/a/b.png', '慢 0.6 秒的对话框仍然算正常：' + JSON.stringify(r));
  ok(Date.now() - t0 < 2000, '没有多余等待，用时 ' + (Date.now() - t0) + 'ms');

  /* 关键：对话框永远不回（宿主没接住）→ 2.6 秒左右判定 unavailable，并留下 pending */
  global.window = { eagle: { dialog: { showSaveDialog: () => new Promise(() => {}) } } };
  t0 = Date.now();
  r = await fresh().askEx({});
  const cost = Date.now() - t0;
  ok(r.kind === 'unavailable', '永不返回 → unavailable（不再等 120 秒）');
  ok(cost >= 2400 && cost < 5000, '判定耗时约 2.6 秒，实际 ' + cost + 'ms');
  ok(!!r.pending, '把那个悬着的 promise 交出去（迟到的选择还能被采纳）');
  ok(/没有出现/.test(r.reason || ''), '原因说得具体：' + (r.reason || ''));

  /* 取消 / undefined 仍然分得开 */
  global.window = { eagle: { dialog: { showSaveDialog: async () => ({ canceled: true }) } } };
  ok((await fresh().askEx({})).kind === 'cancel', '取消 → cancel');
  global.window = { eagle: { dialog: { showSaveDialog: async () => undefined } } };
  ok((await fresh().askEx({})).kind === 'unavailable', '主进程回 undefined → unavailable');

  ok(has(APP, 'function honorLateDialog('), '迟到的另存为选择会被采纳（不白选）');
  ok(has(APP, '另存为框后来出现了'), '并且明说「也存了一份」');
  ok(has(APP, 'function dataUrlBytesOf('), '有 dataURL → 字节的封装');

  /* 「另存原图」的顺序：先复制已有原件，别再回视频取帧 */
  const saveBody = APP.slice(APP.indexOf('async function saveAnnImageNative('), APP.indexOf('function dataUrlBytesOf('));
  const iCopy = saveBody.indexOf('copyImageFileAs(');
  const iCap = saveBody.indexOf('captureNative(');
  ok(iCopy > 0 && iCap > 0 && iCopy < iCap, '先按字节复制，取帧只作兜底');
  ok(has(saveBody, '视频可能已经切走'), '取不到帧时给可执行的建议');

  /* ───────────────────── 7. 退出 ───────────────────── */
  console.log('\n[7] 退出：叫回 Eagle 主窗口，关自己');

  ok(has(BR, 'function focusParent('), 'bridge 有 focusParent');
  ok(has(BR, 'win.isMinimized && win.isMinimized()') && has(BR, 'win.restore()'), '最小化就 restore');
  ok(has(BR, '!win.isVisible()) win.show()'), '在托盘里就 show');
  const exitBody = APP.slice(APP.indexOf('async function exitPlugin('), APP.indexOf('function hotSaveTarget('));
  ok(exitBody.indexOf('Bridge.focusParent()') < exitBody.indexOf('Bridge.closeSelf()'), '先叫回主窗口，再关自己');
  ok(has(APP, 'Ctrl+W'), 'Ctrl+W 也能退');

  ok(!has(HTML, 'id="btnClosePlugin"'), '顶栏那个假 ✕ 删了');
  ok(!has(APP, "on('#btnClosePlugin'"), '对应绑定也删了');

  /* ───────────────────── 8. 语音下线 ───────────────────── */
  console.log('\n[8] 笔记语音整块下线');

  ok(!fs.existsSync(path.join(ROOT, 'EaglePDFReader/js/voiceinput.js')), 'voiceinput.js 已删除');
  ok(!has(HTML, 'voiceinput.js'), 'index.html 不再引用它');
  ok(!has(APP, 'VoiceInput.button') && !has(APP, 'typeof VoiceInput'), 'app.js 不再引用 VoiceInput 模块');
  ok(!has(read('EaglePDFReader/js/editor.js'), 'VoiceInput'), 'editor.js 里也没有');
  ok(has(HTML, 'js/asr.js') && has(HTML, 'js/subtitle.js'), '字幕那条语音链还在（删的是「写笔记时口述」）');

  /* ───────────────────── 9. 版本 ───────────────────── */
  console.log('\n[9] 版本号');
  const m1 = JSON.parse(read('EaglePDFReader/manifest.json'));
  const m2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '三段式版本号，实际 ' + m1.version);
  ok(/^\d+\.\d+\.\d+$/.test(m2.version), '三段式版本号，实际 ' + m2.version);

  console.log('\nPASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})();
