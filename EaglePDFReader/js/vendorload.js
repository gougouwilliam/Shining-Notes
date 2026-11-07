/* vendorload.js —— 大体积第三方库的按需加载（v4.5.1）

   为什么要有这个文件：
     pdf-lib（525KB）只在「把高亮写回 PDF 文件」时用得到，pinyin-pro（326KB）
     只在搜索 / [[ 补全需要拼音匹配时用得到。以前两者都写在 index.html 头部
     同步加载 —— 插件每打开一次，就要先解析这 851KB 才轮到首屏，白等。

   怎么做：
     · 本脚本只有几百字节，替代两个大块头进入首屏；
     · boot 之后在浏览器空闲时（requestIdleCallback）悄悄把两者拉下来；
     · 没加载完时各调用点保持旧行为：拼音退回纯子串匹配、PDF 回写暂时跳过；
       加载完自动生效，**不需要重载页面**（调用点每次现查 window.pinyinPro / PDFLib）；
     · 对「马上就要用」的场景（保存时回写 PDF）提供 ensure() 可 await 的入口。

   纪律：只动态插入 <script>，不声明任何窗口 / 进程能力，退出时无需收拾。
   失败一律静默降级，绝不抛给用户 —— 少一个拼音搜索，不能影响读书。 */
const Vendor = (function () {
  const SRC = {
    pinyin: 'vendor/pinyin-pro.js',
    pdflib: 'vendor/pdflib/pdf-lib.min.js'
  };
  const READY = {
    pinyin: () => typeof window !== 'undefined' && !!(window.pinyinPro && window.pinyinPro.match),
    pdflib: () => typeof window !== 'undefined' && !!window.PDFLib
  };
  const running = {};                 // name -> Promise（并发复用同一次加载）
  const state = {};                   // name -> 'idle' | 'loading' | 'ok' | 'fail'

  function isReady(name) {
    try { return !!(READY[name] && READY[name]()); } catch (e) { return false; }
  }

  function log(name, ok, ms) {
    try {
      if (typeof Dbg !== 'undefined' && Dbg.log) Dbg.log('vendor.load', { name: name, ok: ok, ms: ms });
    } catch (e) { /* ignore */ }
  }

  function load(name) {
    const src = SRC[name];
    if (!src) return Promise.resolve(false);
    if (isReady(name)) { state[name] = 'ok'; return Promise.resolve(true); }
    if (running[name]) return running[name];
    state[name] = 'loading';
    const t0 = Date.now();
    running[name] = new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        state[name] = ok ? 'ok' : 'fail';
        log(name, ok, Date.now() - t0);
        resolve(ok);
      };
      try {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        /* 加载成功也要复核全局是否真的挂上：装错了 / 被拦了都能看出来 */
        s.onload = () => finish(isReady(name));
        s.onerror = () => finish(false);
        (document.head || document.documentElement).appendChild(s);
      } catch (e) { finish(false); }
    });
    return running[name];
  }

  function ensure(name) { return load(name); }

  /* 空闲预取：不与首屏、也不与 PDF 第一帧抢主线程和磁盘。
     timeout 是兜底 —— 极端情况下 idle 一直不来，也要在 2.5 秒内开始加载。 */
  function prefetch(list) {
    const names = Array.isArray(list) ? list : Object.keys(SRC);
    const run = () => names.forEach((n) => { if (!isReady(n)) load(n); });
    try {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 });
      else setTimeout(run, 1200);
    } catch (e) { setTimeout(run, 1200); }
  }

  return {
    ensure: ensure,
    prefetch: prefetch,
    isReady: isReady,
    status: () => Object.assign({}, state)
  };
})();

try { window.Vendor = Vendor; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = Vendor;
