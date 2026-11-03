/* v3.31 回归：ESC 不再关窗口、另存为真能弹出来、视频点击播放、白边真被裁掉、图片点选有框
 *
 * 用户报的五条，根因分别是：
 *   1. ESC 关窗口这条规则被三处兜底叠着 → 一次「想关个框」的 ESC 把 Eagle 一起关了
 *   2. 另存为只走 window.eagle.dialog，那条通道在预览窗口里从来没成功过
 *   3. 去掉原生 controls 之后，点画面没绑任何行为
 *   4. detectCrop 把整帧缩到 160×72 取样，10 行白边被缩放抹平成 0 行
 *   5. 点中 PDF 图片只弹工具条，看不出点的是哪一张
 *
 * 运行：node test-v331.js
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
const IMGC = read('EaglePDFReader/js/imgcache.js');
const SA = read('EaglePDFReader/js/saveas.js');
const VWR = read('EaglePDFReader/js/viewer.js');
const HTML = read('EaglePDFReader/index.html');
const CSS = read('EaglePDFReader/css/app.css');
const VCSS = read('EaglePDFReader/css/viewer.css');
const EG = require('./EaglePDFReader/js/escguard.js');
const VideoView = require('./EaglePDFReader/js/videoview.js');

/* ───────────────────── 1. ESC 只往回收一层 ───────────────────── */
console.log('\n[1] ESC：永不关窗口');

ok(EG.escapeAction({ depth: 0 }) === 'noop', '空栈 → noop');
ok(EG.escapeAction() === 'noop', '空参数 → noop');
ok(EG.escapeAction({ forceExit: true, depth: 0 }) === 'noop', 'forceExit 传了也是 noop');
ok(EG.escapeAction({ launcher: true, depth: 0 }) === 'noop', '启动器窗口无浮层 → noop');
ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '有浮层 → 收一层');
ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索有字 → 清搜索');
ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '正在输入 → 失焦');

/* 穷举一批参数组合，确认没有任何一条能返回 exit-plugin */
(() => {
  let bad = null;
  let tried = 0;
  const bools = [true, false];
  const names = [null, 'workbench', 'confirm', 'toolbar'];
  for (const l of bools) {
    for (const s of bools) {
      for (const t of bools) {
        for (const f of bools) {
          for (const d of [0, 1, 2]) {
            for (const n of names) {
              tried++;
              const act = EG.escapeAction({ launcher: l, searchActive: s, typing: t, depth: d, topName: n, forceExit: f });
              if (act === 'exit-plugin') bad = { l, s, t, f, d, n };
            }
          }
        }
      }
    }
  }
  ok(!bad, '穷举 ' + tried + ' 组参数：没有一组返回 exit-plugin');
})();

console.log('\n[1b] ESC：三处兜底拆干净');

ok(!/function escUiSig\(\)/.test(APP), 'app.js 里 e<s>cUiSig（空转签名）已删');
ok(!/escStall/.test(APP), 'app.js 里「连续无进展计数」已删');
ok(!/forceExit:\s*dbl/.test(APP), 'env 里不再传 forceExit');
ok(has(APP, 'escExitHint()'), '无层可关时只提示怎么退出');
ok(/ESC 只关闭浮层；要退出插件请按 Ctrl\+W/.test(APP), '提示文案说清了新规矩');
ok(/if \(closeVisibleOverlay\(\)\) return;/.test(APP), '兜底关完浮层就返回，不再往下走退出');

/* ESC 分支里不许出现 exitPlugin() */
(() => {
  const f = APP.indexOf('function onKeyDown');
  const i = APP.indexOf("if (e.key === 'Escape') {", f);
  const k = APP.indexOf('escExitHint();', i);
  const end = APP.indexOf('\n    }', k);
  const ESC = APP.slice(i, end > 0 ? end : i + 3000);
  ok(i > 0 && k > i && end > k, '能定位到 ESC 分支（' + ESC.length + ' 字符）');
  ok(ESC.indexOf('exitPlugin') < 0, 'ESC 分支里没有任何 exitPlugin() 调用');
  const claim = ESC.indexOf('window.__escHandledAt = Date.now()');
  const firstReturn = ESC.indexOf('return;');
  ok(claim > 0 && claim < firstReturn, '认领时间戳在任何 return 之前（' + claim + ' < ' + firstReturn + '）');
  ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(ESC),
    'ESC 一律吞掉，不漏给宿主（Eagle 收不到就不会收界面）');
})();

ok(!has(HTML, 'function hardClose'), 'index.html 里「没认领就自己关窗」的兜底已删');
ok(!has(HTML, '__escHandledAt && window.__escHandledAt >= at'), '那段 900ms 定时器已删');
ok(has(HTML, 'ESC 的内联兜底'), '原位置留了删除说明');

console.log('\n[1c] ESC：Ctrl+W 仍是明确出口');

ok(has(APP, "'w'") && has(APP, 'exitPlugin()'), 'Ctrl+W 仍会退出');
ok(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'w'\)/.test(APP),
  'Ctrl+W 的判定在 ESC 分支之外');

/* ───────────────────── 2. 另存为真能弹出来 ───────────────────── */
console.log('\n[2] 另存为：先走 @electron/remote 的原生对话框');

ok(has(SA, "require('@electron/remote')"), 'saveas.js 会去拿 remote');
ok(has(SA, 'rem.dialog.showSaveDialog'), '直接用 remote 的 showSaveDialog');
ok(/const rem = remoteApi\(\);[\s\S]{0,600}?parseResult\(r, exts\)/.test(SA),
  'remote 有结果就用它，不再走「猜框有没有弹出来」那套');
ok(SA.indexOf('remoteApi()') < SA.indexOf('const raw = dlg();'),
  'remote 分支排在宿主 dialog 通道之前');
ok(has(SA, 'remoteWindow(rem)'), '有窗口对象时把它当父窗口（模态归属正确）');
ok(has(SA, 'function has()') && /if \(remoteApi\(\)\) return true;/.test(SA),
  'has() 也认 remote（调用方据此决定要不要提示）');
ok(has(SA, '宿主没接住这个请求'), 'remote 失败时仍保留原来的兜底说明');

console.log('\n[2b] 另存为：两条链都不通才算失败');

ok(/reason: '这个窗口没有系统另存为（remote 与宿主通道都不可用）'/.test(SA),
  '失败原因写清是「两条路都不通」');
ok(has(APP, 'function saveImageAsFile('), '截图 / 框选的另存仍走同一个入口');
ok(/async function exportClipVideo\(ann\)/.test(APP) && has(APP, '片段另存为'),
  '片段另存走同一套对话框');

/* ───────────────────── 3. 点画面播放 / 暂停 ───────────────────── */
console.log('\n[3] 视频：点画面 = 播放 / 暂停');

ok(/video\.addEventListener\('click', \(\) => \{[\s\S]{0,160}?toggle\(\);/.test(VW),
  '视频元素上绑了 click → toggle()');
ok(/video\.addEventListener\('click'[\s\S]{0,120}?if \(areaActive\(\)\) return;/.test(VW),
  '框选模式下不抢这一下（否则画不出矩形）');
ok(has(CSS, 'cursor: pointer'), '画面光标改成 pointer，提示可点');

/* ───────────────────── 4. 白边：黑边 + 进度条都要算进去 ───────────────────── */
console.log('\n[4] 白边：左右黑边 + 烧进画面的进度条');

const T = VideoView.__test;
ok(!!T && typeof T.analyzeBand === 'function', '白边函数 analyzeBand 对外可测');

/* 造一块假像素：左右是黑边（pillar box），内容列里按 ratio(y) 决定多少像素是白。
   这和真实录屏的几何一致 —— 白带只横跨中间那一段，两侧永远是黑的。
   getImageData 按传入的矩形切片，和浏览器行为一致（imgcache 那边会取整幅、也会取条带）。 */
function buildFull(w, h, pillar, ratio) {
  const [px0, px1] = pillar;
  const span = px1 - px0 + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const wc = Math.round(span * Math.max(0, Math.min(1, ratio(y))));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 30;                                  // 普通画面内容
      if (x < px0 || x > px1) v = 0;               // 左右黑边
      else if (x - px0 < wc) v = 255;              // 白带
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return data;
}

function mkCtx(w, h, pillar, ratio) {
  const full = buildFull(w, h, pillar, ratio);
  return {
    getImageData(x, y, ww, hh) {
      const out = new Uint8ClampedArray(ww * hh * 4);
      for (let r = 0; r < hh; r++) {
        const from = ((y + r) * w + x) * 4;
        out.set(full.subarray(from, from + ww * 4), r * ww * 4);
      }
      return { data: out };
    }
  };
}

/* 实测剖面 A：手术画面（.tmp-frames/raw_6.png，1920×858）
   857-842 纯白 / 841-832 进度条 69% / 831-821 纯白 / 820 过渡 / 819 起是画面
   → 白带 = 858-820 = 38 行（4.43%） */
const VH = 858;
const VW2 = 200;
const ratioSurgery = (y) => {
  if (y >= 842) return 1;
  if (y >= 832) return 0.69;
  if (y >= 821) return 1;
  if (y === 820) return 0.97;
  return 0;
};
const nSurgery = T.analyzeBand(mkCtx(VW2, VH, [20, 180], ratioSurgery), VW2, VH, Math.ceil(VH * 0.05));
/* 37 行是剖面本身的真实结构（16 白 + 10 条 + 11 白），
   v3.33 又固定多裁 2 行过渡行 —— 那两行是 0.97 白，不裁掉就是一条细白线。 */
ok(nSurgery === 39, '手术画面：裁 39 行（37 行白带 + 2 行过渡），实际 ' + nSurgery);
ok(Math.abs((nSurgery / VH) * 100 - 4.55) < 0.05,
  '裁剪比例 ' + ((nSurgery / VH) * 100).toFixed(2) + '% ≈ 4.55%');

/* 旧算法在同一个剖面上的表现 —— 这就是「白带还在」的真正原因 */
(function () {
  /* ① 只看整行全白：1282/1920 = 66.7%，永远达不到 99% */
  const spanRatio = 1282 / 1920;
  ok(spanRatio < 0.99, '整行白占比只有 ' + (spanRatio * 100).toFixed(1) + '%，旧阈值 99% 永远不成立');
  /* ② 连续纯白：走到进度条那 10 行就断，只剩条下方的 16 行 */
  let only = 0;
  for (let y = VH - 1; y >= 0; y--) { if (ratioSurgery(y) >= 0.99) only++; else break; }
  ok(only === 16, '旧算法只数到进度条下方 16 行（条还留在画面里）');
})();

/* 实测剖面 B：白底幻灯片（.tmp-frames/raw_3.png）
   整幅偏白，白带边界肉眼看不出来 —— 靠进度条的 76% 那段定位，
   上限 5%（43 行）兜住，不会顺着白底一路啃上去。 */
const ratioSlide = (y) => {
  if (y >= 846) return 1;
  if (y >= 835) return 0.9;
  if (y >= 819) return 0.76;
  if (y >= 787) return 0.7;
  return 0.5;
};
const cap = Math.ceil(VH * 0.05);
const nSlide = T.analyzeBand(mkCtx(VW2, VH, [40, 160], ratioSlide), VW2, VH, cap);
/* v3.33 之前这里会被「见浅色就往里吞」的贪婪判据吃到上限 43 行，
   等于把幻灯片正文切掉一截。现在只认底部的整行纯白（12 行 + 2 行过渡）。 */
ok(nSlide === 14, '白底幻灯片：只裁底部 14 行，不顺着白底往上啃，实际 ' + nSlide);
ok(nSlide < cap, '正文没被当成白带：' + nSlide + ' 行 < 上限 ' + cap);

/* 实测剖面 C：进度条正好贴着底边（上一版裁掉条下方的白之后就是这形态）
   底 11 行是进度条 75%，往上是 10 行纯白 → 必须连条一起裁掉 21-22 行。
   v3.31 的写法要求「条上方先见过白」，这种形态会直接判 0 —— 白带就留在图里了。 */
const H2 = 842;
const ratioEdge = (y) => (y >= H2 - 11 ? 0.75 : y >= H2 - 21 ? 1 : 0.02);
const nEdge = T.analyzeBand(mkCtx(VW2, H2, [20, 180], ratioEdge), VW2, H2, Math.ceil(H2 * 0.05));
ok(nEdge === 23, '进度条贴底边：连条一起裁 23 行（11 条 + 10 白 + 2 过渡），实际 ' + nEdge);

console.log('\n[4c] 缩略图（卡片里的图）用同一套判据');

/* 右侧卡片里的图走 ImgCache：先缩到 900 宽，再自己裁一遍。
   那边原来也是「整行 99% 白」，同一个病根，所以卡片里同样留着白带。 */
const ImgCache = require('./EaglePDFReader/js/imgcache.js');
ok(typeof ImgCache._whiteRows === 'function', 'ImgCache 的白边函数对外可测');

/* 手术画面缩到 900 宽后是 900×402，白带从 38 行变成约 18 行 */
const TH = 402;
const ratioThumb = (y) => {
  if (y >= TH - 8) return 1;          // 条下方的白
  if (y >= TH - 13) return 0.69;      // 进度条
  if (y >= TH - 18) return 1;         // 条上方的白
  return 0;
};
const cutThumb = ImgCache._whiteRows(mkCtx(VW2, TH, [20, 180], ratioThumb), VW2, TH);
ok(cutThumb >= 17 && cutThumb <= 21, '缩略图裁掉 ' + cutThumb + ' 行（含进度条 + 2 行过渡，应约 20 行）');
ok(cutThumb > 8, '旧算法只裁条下方 8 行，新算法把条一起裁掉');

const noBand = ImgCache._whiteRows(mkCtx(VW2, TH, [20, 180], () => 0.03), VW2, TH);
ok(noBand === 0, '缩略图底部没有白 → 不裁');

console.log('\n[4d] 卡片里的一圈白线：图不能垫白底');

ok(has(CSS, '.ec-img, .nc-img { display: block; object-fit: contain; background: transparent; }'),
  '视频图（截图 / 框选 / 片段）改成透明底，不再漏 1px 白边');
ok(has(CSS, '.nm-quote-img,\n.kbn-img { background: #fff; }'),
  'PDF 摘录图（透明底黑线稿）仍然垫白底');
ok(!/\.ec-img[\s\S]{0,200}?background: #fff/.test(
  CSS.slice(CSS.indexOf('/* ---------- 3：框选图片按原始比例缩放'), CSS.indexOf('.ec-img { margin'))),
  '统一规则里 .ec-img / .nc-img 已不再是 #fff');

console.log('\n[4b] 白边：不该裁的一律不裁');

/* 画面内容一直画到最底 → 0 */
const contentAll = T.analyzeBand(mkCtx(VW2, VH, [20, 180], (y) => (y > VH - 4 ? 0.02 : 0.02)), VW2, VH, cap);
ok(contentAll === 0, '底部不是白 → 一行都不裁');

/* 只有 6 行白、上面立刻是内容 → 只裁 6 行，不多啃 */
const six = T.analyzeBand(mkCtx(VW2, VH, [20, 180], (y) => (y >= VH - 6 ? 1 : 0.02)), VW2, VH, cap);
ok(six === 8, '底部 6 行白 → 裁 6 行 + 2 行过渡 = 8，实际 ' + six);

/* 1:1 的行分辨率是前提：同一份剖面缩到 72 行就量不准了 */
const SH = 72;
const shrunk = [];
for (let y = 0; y < SH; y++) shrunk.push(ratioSurgery(Math.round((y / (SH - 1)) * (VH - 1))));
let shrunkRows = 0;
for (let y = SH - 1; y >= 0; y--) { if (shrunk[y] >= 0.98) shrunkRows++; else break; }
ok(shrunkRows < 3, '缩到 72 行后只剩 ' + shrunkRows + ' 行可数 —— 行分辨率不能丢');

ok(has(VW, 'getImageData(0, 0, w, h)'), 'analyzeBand 一次取全画布');
ok(/const bandH = Math.min\(vh, maxRows \+ 16\)/.test(VW), '取样条带高度 = 上限 + 余量');
ok(/c\.ctx\.drawImage\(video, 0, vh - bandH, vw, bandH, 0, 0, bw, bandH\)/.test(VW),
  '只取底部条带，且高度方向 1:1');
ok(/Math\.min\(8, Number\(pct\) \|\| 0\)/.test(VW), 'clip-path 上限放到 8%');

/* ─────────────── 4e. 裁完还留「一点点白」的三个补丁（v3.33） ───────────────
   现场：用户截了 1462×27 的条带，画面 → 过渡行 → 白行 → 灰行 → 纯黑。
   白带主体已经裁掉了，剩的是 clip 边界的取整 / 抗锯齿混色。
   三处一起收，缺一处就会重新冒出来。 */
console.log('\n[4e] 裁完不留「一点点白」');

/* ① 上限 5% → 6.5%：幻灯片实测白带 43 行 / 858 = 5.01%，旧上限 ceil(858*0.05)=43
      正好卡在边界，少裁一两行就是那条白线 */
ok(/Math\.ceil\(vh \* 0\.065\)/.test(VW), '探测上限提到 6.5%（幻灯片白带 5.01% 不再擦边）');
ok(/Math\.round\(h \* 0\.065\)/.test(IMGC), '缩略图上限同步 6.5%');

/* 用实测剖面确认：43 行白带在 5% 上限下会被削，6.5% 下才完整 */
const VH2 = 858;
const white43 = [];
for (let y = 0; y < VH2; y++) white43.push(y >= VH2 - 43 ? 1 : 0.01);
ok(T.analyzeBand(mkCtx(200, VH2, [20, 180], (y) => white43[y]), 200, VH2, Math.ceil(VH2 * 0.05)) === 43,
  '5% 上限（43 行）刚好够 43 行白带 —— 一行余量都没有');
const tall = [];
for (let y = 0; y < VH2; y++) tall.push(y >= VH2 - 50 ? 1 : 0.01);
ok(T.analyzeBand(mkCtx(200, VH2, [20, 180], (y) => tall[y]), 200, VH2, Math.ceil(VH2 * 0.05)) === 43,
  '5% 上限下，50 行白带只能裁 43 行 —— 剩下 7 行就是那条白线');
ok(T.analyzeBand(mkCtx(200, VH2, [20, 180], (y) => tall[y]), 200, VH2, Math.ceil(VH2 * 0.065)) === 52,
  '6.5% 上限下，同一份数据完整裁掉 52 行（50 + 2 行过渡）');

/* ② clip-path 多裁 1px：百分比落到设备像素要取整，边界会留半行混色 */
ok(/calc\(' \+ \(p \+ pad\)\.toFixed\(2\) \+ '% \+ 1px\)/.test(VW), 'clip-path 额外 +1px，边界推进黑带');
ok(/getBoundingClientRect\(\)\.height/.test(VW), '按元素实际高度换算这 1px 的百分比');

/* ③ 底部压一条黑边：clip 再怎么取整，最下面几像素都是黑的 */
ok(/classList\.toggle\('has-crop', !!p\)/.test(VW), '裁切时给 vs-frame 打 has-crop');
ok(/\.vs-frame\.has-crop::after \{/.test(CSS), '样式里有 has-crop 的黑边遮罩');
const afterBlock = (CSS.match(/\.vs-frame\.has-crop::after \{[\s\S]{0,320}?\}/) || [''])[0];
ok(/height: 4px/.test(afterBlock), '黑边高 4px，够吃掉 1-2 行混色');
ok(/background: #000/.test(afterBlock), '黑边是纯黑，和播放器下缘一致');
ok(/pointer-events: none/.test(afterBlock), '黑边不吃点击（点画面照样播放/暂停）');
ok(/z-index: 1/.test(afterBlock), '黑边在框选层(z=3)之下，不挡拖拽');

/* ───────────────────── 5. PDF 图片点选有框 ───────────────────── */
console.log('\n[5] PDF 图片：点中后描一圈框');

ok(/markImage\(pageEl, rect\) \{/.test(VWR), 'viewer 有 markImage');
ok(/clearImageMark\(\) \{/.test(VWR), 'viewer 有 clearImageMark');
ok(/querySelector\('\.pinLayer'\)/.test(VWR), '框画在 pinLayer 里（跟着页面缩放走）');
ok(/rect\.x \* 100\)\.toFixed\(3\) \+ '%'/.test(VWR), '用百分比定位，缩放 / 换页不跑位');
ok(has(VWR, "'img-pick'"), '元素类名 img-pick');
ok(/if \(viewer\.markImage\) viewer\.markImage\(pageEl, rect\);/.test(APP),
  'pickImage 里先画框再弹工具条');
ok(/function hideToolbar\(\)[\s\S]{0,320}?viewer\.clearImageMark\(\)/.test(APP),
  '工具条收掉时框一起收');
ok(/\.img-pick \{/.test(VCSS), '样式中定义了 .img-pick');
ok(/\.img-pick[\s\S]{0,260}?pointer-events: none/.test(VCSS), '框不挡点击与选字');
ok(/\.img-pick[\s\S]{0,200}?border: 2px solid/.test(VCSS), '2px 描边，够显眼');

/* ───────────────────── 6. 版本 ───────────────────── */
console.log('\n[6] 版本号');

const m1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const m2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(/^\d+\.\d+\.\d+$/.test(m1.version), '三段式版本号，实际 ' + m1.version);
ok(/^\d+\.\d+\.\d+$/.test(m2.version), '三段式版本号，实际 ' + m2.version);
ok(has(HTML, 'js/escguard.js') && has(HTML, 'js/saveas.js'), '关键模块都还引着');

console.log('\n' + '─'.repeat(40));
console.log('  PASS ' + pass + '   FAIL ' + fail);
console.log('─'.repeat(40) + '\n');
process.exit(fail ? 1 : 0);
