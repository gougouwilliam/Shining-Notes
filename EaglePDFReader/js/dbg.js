/* dbg.js —— 插件自己的小日志（v3.28.3）

   为什么需要它：
   「截图 / 框选没反应」这类问题的现场在用户机器上，我这头看不见。
   上一版的做法是「猜」，猜错了要再来一轮。现在把关键步骤写到
   <数据目录>/debug.log，出问题时读一眼就知道断在哪一步：
     画框 → 渲染 → 弹对话框 → 写文件，到底哪一跳失败了、错误原文是什么。

   三条纪律：
     · 只记事件和错误，不记笔记内容、不记图片数据（隐私）；
     · 超过 200KB 自动轮转成 debug.log.1，不会无限长；
     · 任何异常都吞掉 —— 日志坏了不能影响主流程。 */
const Dbg = (function () {
  const MAX = 200 * 1024;
  let fs = null;
  let pathMod = null;
  try {
    if (typeof require === 'function') {
      fs = require('fs');
      pathMod = require('path');
    }
  } catch (e) { fs = null; }

  function file() {
    try {
      const dir = (typeof Store !== 'undefined' && Store.getDataDir) ? Store.getDataDir() : null;
      if (!dir) return null;
      return pathMod ? pathMod.join(dir, 'debug.log') : dir + '/debug.log';
    } catch (e) { return null; }
  }

  function brief(v) {
    try {
      if (v === undefined) return '';
      if (v === null) return 'null';
      if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v;
      if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '');
      if (typeof v === 'object') {
        const s = JSON.stringify(v, (k, val) => {
          if (typeof val === 'string' && val.length > 200) return val.slice(0, 200) + '…';
          return val;
        });
        return s && s.length > 600 ? s.slice(0, 600) + '…' : s;
      }
      return String(v);
    } catch (e) { return '[unserializable]'; }
  }

  function log(tag, data) {
    if (!fs) return false;
    const f = file();
    if (!f) return false;
    try {
      try {
        const st = fs.statSync(f);
        if (st.size > MAX) {
          try { fs.renameSync(f, f + '.1'); } catch (e) { /* 轮转失败就继续追加 */ }
        }
      } catch (e) { /* 文件还不存在 */ }
      const t = new Date();
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      const stamp = pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '.' + ('00' + t.getMilliseconds()).slice(-3);
      const line = stamp + ' [' + tag + '] ' + (data === undefined ? '' : brief(data)) + '\n';
      fs.appendFileSync(f, line);
      return true;
    } catch (e) { return false; }
  }

  /* 读回来（关于页的「查看日志」用） */
  function tail(maxLines) {
    if (!fs) return '';
    const f = file();
    if (!f) return '';
    try {
      const s = fs.readFileSync(f, 'utf8');
      const lines = s.split('\n');
      const n = maxLines || 200;
      return lines.slice(Math.max(0, lines.length - n)).join('\n');
    } catch (e) { return ''; }
  }

  function clear() {
    if (!fs) return false;
    const f = file();
    if (!f) return false;
    try { fs.writeFileSync(f, ''); return true; } catch (e) { return false; }
  }

  /* 全局兜底：以前这类错误只会安静地躺在 devtools 里，用户什么也看不到 */
  let hooked = false;
  function hook() {
    if (hooked || typeof window === 'undefined') return;
    hooked = true;
    try {
      window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason;
        log('reject', (r && (r.stack || r.message)) || r);
        console.error('[unhandledrejection]', r);
      });
    } catch (e) { /* ignore */ }
    try {
      window.addEventListener('error', (e) => {
        log('error', (e && (e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0))));
      });
    } catch (e) { /* ignore */ }
  }

  return { log, tail, clear, hook };
})();

try { window.Dbg = Dbg; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = Dbg;
