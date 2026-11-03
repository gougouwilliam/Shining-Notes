#!/usr/bin/env node
/* v4.2.7 回归：Esc 三处（笔记搜索框 / [[ 弹窗逐层 / 全局捕获）+ 预览光标 +
   搜索框卡片化 + 媒体管线（enmedia 转存 / 视频黑屏修复 / 附件副本 / =WxH 尺寸）+
   工具栏 SVG 图形化 + 附件按钮 + 引用摘录下线 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = __dirname;
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = read('EaglePDFReader/index.html');
const E = read('EaglePDFReader/js/editor.js');
const A = read('EaglePDFReader/js/app.js');
const C = read('EaglePDFReader/css/app.css');
const MD = read('EaglePDFReader/js/markdown.js');
const MF = read('EaglePDFReader/js/mediafix.js');
const ST = read('EaglePDFReader/js/store.js');
const MFEST = read('EaglePDFReader/manifest.json');
const WFEST = read('EagleNoteWorkbench/manifest.json');
const README = read('EaglePDFReader/README.md');

console.log('== 1. 版本联动（硬约定）==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(MFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(WFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/### 更新记录 · \d+\.\d+\.\d+/.test(README), 'README 更新记录为三段式标题');

console.log('== 2. Esc 修复一：笔记栏搜索框清空 ==');
ok(A.indexOf("e.target.id === 'noteSearch'") > 0, '全局 Esc 分支识别 noteSearch');
ok(/e\.target\.id === 'noteSearch'[\s\S]{0,200}noteSearchClear\(\);[\s\S]{0,80}renderNotes\(\)/.test(A), '搜索框有词 Esc → 清空 + 恢复列表');
ok(/e\.target\.id === 'noteSearch'[\s\S]{0,120}e\.preventDefault\(\);/.test(A), '该分支吞掉事件（不放行给宿主）');

console.log('== 3. Esc 修复二：[[ 弹窗逐层退 ==');
ok(E.indexOf('function escPop()') > 0, 'editor.escPop 分层处理存在');
ok(/if \(d && d\.q\.length\) \{[\s\S]{0,400}wsearch\.focus\(\)/.test(E), '层① 搜索框有词 → 清词、弹窗留着');
ok(/wikiClose\(\);[\s\S]{0,300}d\.start - 2/.test(E), '层② 空查询 → 关弹窗 + 删悬空 [[');
ok(/nmEsc && !nmEsc\.hidden && modalEditor && modalEditor\.escPop && modalEditor\.escPop\(\)/.test(A),
  '全局 Esc 先问编辑器弹窗（不再直接关编辑框留残窗）');
ok(E.indexOf('escPop: escPop') > 0, 'escPop 从组件 API 导出');

console.log('== 4. 预览态光标 + 焦点框 ==');
ok(E.indexOf('CARET_SENTINEL') > 0 && E.indexOf("\\u2063") > 0 && E.indexOf("ne-caret") > 0,
  'editor 渲染时 \u2063 哨兵定位光标');
ok(/body\.classList\.contains\('previewing'\)[\s\S]{0,120}document\.activeElement === ta/.test(E),
  '只在预览态 + 焦点在输入框时画光标');
ok(/\.ne-caret \{/.test(C) && /neCaretBlink/.test(C), '闪烁 caret 样式 + 动画');
ok(/\.ne-body\.previewing \.ne-preview \{[\s\S]*?border-color: var\(--accent\)/.test(C),
  '预览态保留蓝色焦点框（不再变灰）');

console.log('== 5. 笔记搜索框卡片化 ==');
ok(/\.note-search-row \{[\s\S]*?border: 1px solid/.test(C) && /box-shadow/.test(C) && /margin: 10px 0 14px/.test(C),
  '搜索框独立卡片（与 OCR / 环境条拉开距离）');

console.log('== 6. markdown 媒体出口（沙箱行为）==');
try {
  let src = MD.replace(/try \{ window\.Markdown[\s\S]*?\} catch \(e\) \{[^}]*\}/, '');
  const Ux = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  const M = new Function('U', src + '\nreturn Markdown;')(Ux);
  const r1 = M.render('![贴图](enmedia:m1abc.png)');
  ok(r1.includes('data-fsrc="enmedia:m1abc.png"') && !r1.includes(' src="'), 'enmedia 短引用 → data-fsrc，无明文 src');
  const r2 = M.render('![a](D:\\图 库\\x.png =300x200)');
  ok(r2.includes('width:300px') && r2.includes('height:200px') && r2.includes('object-fit:contain'), '=300x200 → 定宽高 + contain');
  ok(!r2.includes('=300x200'), '尺寸尾参不混进地址');
  const r3 = M.render('![a](D:\\x.png =300)');
  ok(r3.includes('width:300px') && !r3.includes('height:'), '=300 只定宽');
  const r4 = M.render('![a](D:\\x.png =x200)');
  ok(r4.includes('height:200px') && !r4.includes('width:'), '=x200 只定高');
  const r5 = M.render('@[视频](D:\\影\\a.mp4 =640x360)');
  ok(r5.includes('<video') && r5.includes('width:640px') && r5.includes('data-fsrc="D:\\影\\a.mp4"'), '视频语法 + 尺寸 + 本地 data-fsrc');
  const r6 = M.render('![a](D:\\x.png)');
  ok(r6.includes('src="file:///D:/x.png"') && r6.includes('data-fsrc'), '本地路径 → file:/// + data-fsrc（mediafix 接手）');
  const r7 = M.render('![a](https://x.com/i.png)');
  ok(!r7.includes('data-fsrc'), 'http 图片不挂 data-fsrc（浏览器自己加载）');
  ok(!M.render('![x](javascript:alert(1))').includes('<img'), 'javascript: 仍拒收');
} catch (err) { ok(false, 'markdown 沙箱：' + err.message); }

console.log('== 7. mediafix.js（黑屏修复管线）==');
ok(H.indexOf('js/mediafix.js') > 0, 'index.html 引入 mediafix.js');
ok(MF.indexOf('MutationObserver') > 0 && MF.indexOf('scan(document)') > 0, '全局观察扫描（预览/阅读页/卡片一处修复）');
ok(MF.indexOf("slice(8)") > 0 && MF.indexOf('enmedia') > 0, 'enmedia: 前缀解析');
ok(/readyState < 1[\s\S]{0,60}3000/.test(MF), '视频 3 秒看门狗（file:// 静默被拦时换内存源）');
ok(MF.indexOf('require(\'fs\')') > 0 && MF.indexOf('readFile') > 0, 'Node fs 异步读 → blob');
ok(MF.indexOf('md-broken') > 0 && C.indexOf('.md-broken') > 0, '读不出的媒体给可见占位');
ok(C.indexOf('.md-video[style]') > 0, '定尺寸媒体的默认铺满样式让路');

console.log('== 8. Store 媒体库（真实落盘沙箱）==');
try {
  let src = ST;
  /* store.js 顶层探测 require —— new Function 里要显式注入（不是全局变量） */
  const Store2 = new Function('require', 'module', 'exports', src + '\nreturn Store;')(require, module, {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enmedia-test-'));
  Store2.setDataDir(tmp);
  const token = Store2.saveMediaDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', 'png');
  ok(/^enmedia:[A-Za-z0-9._\-]+$/.test(token), 'saveMediaDataUrl → enmedia: 短引用（' + token.slice(0, 18) + '…）');
  const p = Store2.mediaPath(token.slice(8));
  ok(p && fs.existsSync(p), '文件真实落盘 media/ 目录');
  const evil = Store2.mediaPath('..\\evil.json');
  const mediaRoot = path.resolve(tmp, 'media');
  ok(evil === '' || path.resolve(evil).indexOf(mediaRoot + path.sep) === 0,
    'mediaPath 拒绝路径穿越（解析后仍在 media/ 内）');
  const srcFile = path.join(tmp, 'orig.txt');
  fs.writeFileSync(srcFile, 'hello');
  const copy = Store2.copyMedia(srcFile);
  ok(copy && fs.existsSync(copy) && copy.indexOf(path.join('media')) > 0, 'copyMedia 本地文件 → media/ 副本');
  ok(Store2.copyMedia('Z:\\不存在的路径\\x.txt') === '', '复制失败返回空串（调用方退回原路径）');
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (err) { ok(false, 'store 沙箱：' + err.message); }

console.log('== 9. 粘贴图转存 + 附件副本（接线）==');
ok(/onPasteImage: async \(dataUrl\) =>[\s\S]{0,120}Store\.saveMediaDataUrl/.test(A), '编辑器 onPasteImage → Store 落盘');
ok(/token = await opts\.onPasteImage[\s\S]{0,200}!\[贴图\]\(' \+ \(token \|\| rd\.result\)/.test(E),
  '粘贴图优先 enmedia 短引用，失败才退回 dataURL');
ok(/Store\.copyMedia\(p\)/.test(A) && /copied: !!copy/.test(A), '本地附件先复制副本入库');

console.log('== 10. 工具栏图形化 ==');
ok(E.indexOf('function svgIcon') > 0 && E.indexOf('ICONS.attach') > 0 && E.indexOf("dataset.md = 'attach'") > 0,
  'SVG 图标 + 附件按钮');
ok(E.indexOf("k === 'attach'") > 0 && /'attach'[\s\S]{0,200}btnLocal\.click\(\)/.test(E), '附件按钮与「＋本地文件」同入口');
ok(E.indexOf("'md-btn quote-btn'") < 0 && E.indexOf('btnQuote') < 0 && E.indexOf('onInsertQuote') < 0,
  '「引用摘录」按钮下线');
ok(E.indexOf('ICONS.video') > 0 && E.indexOf('ICONS.alignleft') > 0 && E.indexOf('ICONS.list') > 0, '列表/对齐/视频换 SVG');
ok(C.indexOf('.md-btn.md-strike') > 0 && C.indexOf('line-through') > 0, '删除线按钮 CSS 划线');
ok(C.indexOf('.md-btn svg') > 0, 'SVG 图标样式');
ok(E.indexOf('=640x360 可调播放窗大小') > 0, '视频插入提示尺寸尾参写法');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
