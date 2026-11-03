/* mediafix.js —— 笔记内嵌媒体的播放修复（v4.2.7）

   为什么需要：插件页面跑在 eagleplugin:// 协议下，<video>/<img> 里的 file://
   地址会被 webSecurity 静默拦截 —— 视频黑屏、图片裂图，而且往往连 error
   事件都不冒（videoview.js 早就踩过同一个坑，那边靠看门狗 + 内存读取兜底）。
   出路只有一条：Node fs 把文件读进来包成 Blob 换 objectURL（与页面同源）。

   data-fsrc 两种取值（markdown.js 输出时挂上）：
     · enmedia:<名>  —— 笔记媒体库副本（Store.mediaPath 解析成绝对路径）
     · 本地原始路径  —— 用户手写的盘符路径
   没有 data-fsrc 的（http / dataURL）浏览器自己加载，不归这里管。

   全局 MutationObserver：编辑器预览、阅读页、笔记卡片、知识库、工作台……
   所有 Markdown.render 出来的媒体在一处修复，各调用方零改动。 */
const MediaFix = (function () {
  let fs = null;
  try { if (typeof require === 'function') fs = require('fs'); } catch (e) { fs = null; }

  let nameResolver = (n) => (typeof Store !== 'undefined' && Store.mediaPath) ? Store.mediaPath(n) : '';
  const busy = new WeakSet();
  let mo = null;
  let scanQueued = false;

  function pathOf(fsrc) {
    const s = String(fsrc || '');
    if (/^enmedia:/i.test(s)) {
      try { return nameResolver(s.slice(8)) || ''; } catch (e) { return ''; }
    }
    /* v4.2.9：用户手写的 file:/// 链接也是「原始路径」—— 但 fs.readFile 不认 URL，
       转回本地盘符路径（含 %20 / 中文解码）。 */
    if (/^file:\/\//i.test(s)) {
      try {
        let p = decodeURIComponent(s.replace(/^file:\/\//i, ''));
        p = p.replace(/^\/([A-Za-z]:)/, '$1');   // /D:/x → D:/x
        return p;
      } catch (e) { return ''; }
    }
    return s;   // 原始盘符路径，fs 直接认
  }

  function mimeOf(p) {
    const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
    const e = m ? m[1].toLowerCase() : '';
    if (e === 'png') return 'image/png';
    if (e === 'gif') return 'image/gif';
    if (e === 'webp') return 'image/webp';
    if (e === 'svg') return 'image/svg+xml';
    if (e === 'mp4' || e === 'm4v') return 'video/mp4';
    if (e === 'webm') return 'video/webm';
    if (e === 'mov') return 'video/quicktime';
    if (e === 'mkv') return 'video/x-matroska';
    if (e === 'ogv') return 'video/ogg';
    return '';
  }

  function toBlobUrl(p, cb) {
    if (!fs || !p) { cb(''); return; }
    fs.readFile(p, (err, buf) => {
      if (err || !buf || !buf.length) { cb(''); return; }
      try { cb(URL.createObjectURL(new Blob([buf], { type: mimeOf(p) }))); }
      catch (e) { cb(''); }
    });
  }

  /* v4.2.9：失败要看得见 —— 之前只加个 md-broken 灰框，播放按钮还是灰的，
     用户不知道是文件没了还是格式不支持。现在在媒体下方补一行说明，
     网络链接附带「浏览器打开」入口。 */
  function failTip(el, href, text) {
    try {
      const nx = el.nextElementSibling;
      if (nx && nx.classList && nx.classList.contains('md-media-tip')) return;
      const tip = document.createElement(href ? 'a' : 'div');
      tip.className = 'md-media-tip';
      if (href) { tip.href = 'javascript:void(0)'; tip.dataset.href = href; }
      tip.textContent = text;
      el.insertAdjacentElement('afterend', tip);
    } catch (e) { /* 提示补不上不影响主体 */ }
  }

  function fixVideo(v) {
    const p = pathOf(v.dataset.fsrc);
    if (!p) return;
    let blobbed = false;
    const goBlob = () => {
      if (blobbed) return;
      blobbed = true;
      toBlobUrl(p, (u) => {
        if (!u) { v.classList.add('md-broken'); failTip(v, '', '视频读取失败：文件可能被移动、删除或暂不可用'); return; }
        v.src = u;
        try { v.load(); } catch (e) { /* ignore */ }
      });
    };
    v.addEventListener('error', goBlob);
    /* 看门狗：file:// 被拦时既不报错也不加载 —— 3 秒还没元数据就换内存源。
       mkv 这类内核本来不认的格式，error 会先到，同样落到这里给出裂图标记。 */
    const wd = setTimeout(() => { if (v.readyState < 1) goBlob(); }, 3000);
    v.addEventListener('loadedmetadata', () => clearTimeout(wd), { once: true });
  }

  /* v4.2.9：网络直链（http 的 .mp4 等）浏览器自己加载，失败（403 防盗链 / 已下架）
     也得给说法 —— 藏一个「浏览器打开」的兜底入口。 */
  function fixHttpVideo(v) {
    const url = v.currentSrc || v.src || '';
    if (!/^https?:/i.test(url)) return;
    if (v.dataset.httpWatch === '1') return;
    v.dataset.httpWatch = '1';
    v.addEventListener('error', () => {
      v.classList.add('md-dead');
      failTip(v, url, '此视频链接无法内嵌播放（可能已失效或有防盗链）· 点击在浏览器中打开');
    });
  }

  function fixImg(im) {
    const p = pathOf(im.dataset.fsrc);
    if (!p) return;
    let blobbed = false;
    const goBlob = () => {
      if (blobbed) return;
      blobbed = true;
      toBlobUrl(p, (u) => {
        if (u) im.src = u;
        else { im.classList.add('md-broken'); failTip(im, '', '图片读取失败：文件可能被移动、删除或暂不可用'); }
      });
    };
    /* enmedia 的图没带 src，直接读；file:// 的先试原生加载，出错 / 超时再读 */
    if (!im.getAttribute('src')) { goBlob(); return; }
    im.addEventListener('error', goBlob);
    const wd = setTimeout(() => { if (!im.complete || !im.naturalWidth) goBlob(); }, 2500);
    im.addEventListener('load', () => clearTimeout(wd), { once: true });
  }

  function scan(root) {
    if (!fs) return;
    (root || document).querySelectorAll('video.md-video[data-fsrc]').forEach((v) => {
      if (busy.has(v)) return;
      busy.add(v);
      fixVideo(v);
    });
    (root || document).querySelectorAll('video.md-video[src]:not([data-fsrc])').forEach((v) => {
      fixHttpVideo(v);
    });
    (root || document).querySelectorAll('img.md-img[data-fsrc]').forEach((im) => {
      if (busy.has(im)) return;
      busy.add(im);
      fixImg(im);
    });
  }

  function init() {
    if (mo || !fs) return;
    mo = new MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      requestAnimationFrame(() => { scanQueued = false; scan(document); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan(document);
  }

  return { init, scan, setNameResolver: (f) => { if (typeof f === 'function') nameResolver = f; } };
})();

try { window.MediaFix = MediaFix; } catch (e) { /* ignore */ }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => MediaFix.init());
else MediaFix.init();
