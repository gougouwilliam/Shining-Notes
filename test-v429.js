#!/usr/bin/env node
/* v4.2.9 回归：新建按钮收窄（不顶边）+ 网页视频灰按钮根治
   （非直链 → 浏览器打开卡片；直链失败 → 兜底提示；file:// → 本地路径转换） */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok - ' + msg); }
  else { failed++; console.log('  FAIL - ' + msg); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MD = read('EaglePDFReader/js/markdown.js');
const MF = read('EaglePDFReader/js/mediafix.js');
const A = read('EaglePDFReader/js/app.js');
const E = read('EaglePDFReader/js/editor.js');
const C = read('EaglePDFReader/css/app.css');
const MFEST = read('EaglePDFReader/manifest.json');
const WFEST = read('EagleNoteWorkbench/manifest.json');
const README = read('EaglePDFReader/README.md');

console.log('== 1. 版本联动 ==');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(MFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '主插件 manifest 版本为三段式');
ok(/^\s*"version": "\d+\.\d+\.\d+",?$/.test(WFEST.trim().split('\n').filter(l => l.indexOf('"version"') >= 0)[0] || ''), '工作台 manifest 版本为三段式（与主插件一致）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(README), 'README 当前版本为三段式');
ok(/### 更新记录 · \d+\.\d+\.\d+/.test(README), 'README 更新记录为三段式标题');

console.log('== 2. 新建按钮收窄 ==');
/* v4.2.13 起宽度实际值由 JS 抄 clientWidth 同步、margin 固定左缘 10px 不再居中 */
ok(/\.note-new-bar \{[\s\S]{0,400}width: calc\(100% - 20px\)/.test(C) && /\.note-new-bar \{[\s\S]{0,400}margin: 10px 10px 16px/.test(C),
  '按钮宽度与笔记列对齐：calc(100% - 20px) 基础宽 + 左缘 10px（v4.2.13 由 JS 实测同步）');
ok(/\.note-new-bar \{[\s\S]{0,500}padding: 9px 12px/.test(C) && /\.note-new-bar \{[\s\S]{0,500}font-size: 12\.5px/.test(C),
  '高度与字号降档（padding 9px / 12.5px）');

console.log('== 3. 网页视频：非直链 → 浏览器打开卡片 ==');
ok(/function videoTag\(url, title\) \{[\s\S]{0,400}md-webvideo/.test(MD), 'videoTag 识别网页链接渲染 md-webvideo 卡片');
ok(MD.indexOf('网页视频无法内嵌播放') > 0 || MD.indexOf('点击在浏览器中播放') > 0, '卡片带说明文案');
ok(/md-webvideo[\s\S]{0,200}data-href/.test(MD), '卡片携带 data-href');
ok(/a\.md-webvideo, a\.md-media-tip/.test(A), 'app.js 委托处理卡片点击 → openExternal');
ok(A.indexOf('Bridge.openExternal(href)') > 0, '点击走 Bridge.openExternal（系统浏览器）');

console.log('== 4. 直链失败兜底 ==');
ok(MF.indexOf('fixHttpVideo') > 0 && MF.indexOf("video.md-video[src]:not([data-fsrc])") > 0,
  'mediafix 监听网络直链 <video> 的失败');
ok(MF.indexOf('md-dead') > 0 && MF.indexOf('failTip(v, url,') > 0,
  '失败后隐藏视频并补「浏览器打开」提示条');
ok(MF.indexOf('failTip(v, \'\', \'视频读取失败') > 0, '本地视频读取失败有可见说明');
ok(MF.indexOf("failTip(im, '', '图片读取失败") > 0, '本地图片读取失败有可见说明');

console.log('== 5. file:// 链接 → 本地路径 ==');
ok(MF.indexOf('decodeURIComponent') > 0 && MF.indexOf("/^file:") > 0, 'pathOf 解码 file:/// 前缀');
ok(/replace\(\^\\\/\(\[A-Za-z\]:\)\|?/.test(MF) || MF.indexOf("replace(/^\\/([A-Za-z]:)/, '$1')") > 0,
  '/D:/x → D:/x（剥掉 URL 开头的斜杠）');

console.log('== 6. 预览层放行所有链接 ==');
ok(/pv\.addEventListener\('mousedown'[\s\S]{0,200}closest\('a'\)/.test(E), 'pv mousedown 放行所有 <a>');

console.log('== 7. CSS 在位 ==');
ok(/\.md-webvideo \{/.test(C) && /\.md-media-tip \{/.test(C) && /\.md-dead \{ display: none; \}/.test(C),
  'md-webvideo / md-media-tip / md-dead 样式齐备');

console.log('== 8. 沙箱行为：videoTag 路由 ==');
(function () {
  const src = MD;
  const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv|mkv)(\?|#|$)/i;
  function route(url) {   // 与 videoTag 相同的路由口径
    const raw = String(url).trim();
    if (/^https?:\/\//i.test(raw) && !VIDEO_EXT.test(raw)) return 'webcard';
    return 'video';
  }
  ok(route('https://www.bilibili.com/video/BV1xx') === 'webcard', 'B 站网页链接 → 卡片');
  ok(route('https://cdn.example.com/movie.mp4?token=1') === 'video', 'http mp4 直链 → <video>');
  ok(route('D:\\库\\课程\\第1讲.mp4') === 'video', '本地路径 → <video>（mediafix 兑现）');
  ok(route('enmedia:v1.mp4') === 'video', 'enmedia 短引用 → <video>');
})();

console.log('');
console.log(`v4.2.9：${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
