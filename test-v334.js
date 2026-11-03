/* v3.34 回归：自绘标题栏的三个按钮（✕ / 最小化 / 最大化）必须真的能用
 *
 * 用户实测两轮：
 *   3.34.0 前：✕ 点了没反应，只有 Ctrl+W 能关；
 *   3.34.0 后：✕ 还是不行 —— 而且**最小化、最大化也一起点不动**。
 *
 * 全部点不动 = 不是三个独立 bug，而是 handler 一个都没绑上。
 * 根因：init() 要求 `isLauncher() && eagle.window` 都在，而 isLauncher() 读的是
 *       `Bridge.state.query.launcher` —— 它要等 Bridge.ready()（异步、最多等 1 秒）才被赋值，
 *       init() 却在同步启动段就跑完了 → 判断恒为假 → return false，三个按钮全死。
 *       界面上的标题栏还在，是因为 index.html 里那段内联脚本按 location.search
 *       把 .frameless / hidden 打开了：看得见、点不动。
 *
 * 本次契约：
 *   1. 判据读 location.search（与内联脚本同一个正则），不再依赖 Bridge 的时序
 *   2. 绑按钮不要求在启动瞬间就有 eagle.window；动作走 @electron/remote 直连
 *   3. 三个按钮各管各的：minimize / maximize↔unmaximize / close(=App.exit)
 *   4. Bridge 连上之后 app.js 再补一次 init()，且必须幂等（不重复绑定）
 *   5. ESC 仍然永不关窗口（v3.31 规则没被带回去）
 *
 * 运行：node test-v334.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const has = (src, s) => src.indexOf(s) >= 0;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
const tick = () => new Promise((r) => setImmediate(r));

const FW = read('EaglePDFReader/js/framewin.js');
const APP = read('EaglePDFReader/js/app.js');
const HTML = read('EaglePDFReader/index.html');
const LAUNCH = read('EagleNoteWorkbench/workbench.html');

/* ───────────────────── 假 DOM（只为跑 framewin.init） ───────────────────── */
function makeEl(id) {
  return {
    id,
    hidden: true,
    title: '',
    handlers: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    click() { (this.handlers.click || []).forEach((f) => f({ target: { closest: () => null } })); },
    querySelector() { return null; },
    closest() { return null; }
  };
}

/* 在隔离沙箱里跑 framewin.js（它是吃 window 的 IIFE，不能直接 require）。
   opts: remote(false 表示没有 remote) / eagle(false 表示 Eagle API 还没注入)
         search / query / appExit / maximized / bridgeClose / bridgeDestroy */
function loadFrameWin(opts) {
  opts = opts || {};
  const calls = { appExit: 0, min: 0, max: 0, unmax: 0, remoteClose: 0, winClose: 0, ipc: [], bridgeClose: 0, bridgeDestroy: 0 };
  const timers = [];
  let maximized = !!opts.maximized;

  const els = { winBar: makeEl('winBar'), winMin: makeEl('winMin'), winMax: makeEl('winMax'), winClose: makeEl('winClose') };
  els.winBar.querySelector = (sel) => (sel === '#winMax' ? els.winMax : null);

  const remote = opts.remote === false ? null : {
    getCurrentWindow() {
      return {
        minimize() { calls.min++; },
        maximize() { calls.max++; maximized = true; },
        unmaximize() { calls.unmax++; maximized = false; },
        isMaximized() { return maximized; },
        close() { calls.remoteClose++; }
      };
    }
  };

  const win = {
    location: { search: opts.search === undefined ? '?launcher=1#workbench' : opts.search },
    Bridge: { state: { query: opts.query || {} } },
    document: {
      body: { classList: { add() {} } },
      getElementById: (id) => els[id] || null
    },
    addEventListener() {},
    close() { calls.winClose++; },
    setTimeout(fn) { timers.push(fn); return timers.length; }
  };
  if (opts.eagle !== false) {
    win.eagle = { window: { minimize() {}, maximize() {}, unmaximize() {}, isMaximized: () => false } };
  }
  win.document.body.classList.addEventListener = () => {};
  if (opts.appExit) win.App = { exit() { calls.appExit++; } };
  if (opts.bridgeClose !== undefined) {
    win.Bridge.closeSelf = () => { calls.bridgeClose++; return opts.bridgeClose; };
    if (opts.bridgeDestroy) win.Bridge.destroySelf = () => { calls.bridgeDestroy++; return true; };
  }

  const sandbox = {
    window: win,
    console,
    document: win.document,
    setTimeout: win.setTimeout,
    require(name) {
      if (name === '@electron/remote') { if (!remote) throw new Error('no remote'); return remote; }
      if (name === 'electron') {
        if (opts.ipc === false) throw new Error('no ipc');
        return { ipcRenderer: { invoke: (...a) => { calls.ipc.push(a); return Promise.resolve(true); } } };
      }
      throw new Error('module not found: ' + name);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(FW, sandbox);

  return {
    FrameWin: win.FrameWin,
    win,
    els,
    calls,
    init: () => win.FrameWin.init(),
    fireTimers() { const t = timers.splice(0); t.forEach((f) => f()); }
  };
}

(async function main() {
  /* ───────────── 1. 曾经的致命时序：init 在 Bridge 之前跑 ───────────── */
  console.log('\n[1] 没有 eagle、Bridge 还没解析 query —— 也必须绑上');

  {
    /* 完全复刻用户那台机器的启动瞬间：只有 location.search 里那个 launcher=1，
       eagle.window 还没注入，Bridge.state.query 还是空的 */
    const fx = loadFrameWin({ eagle: false, query: {} });
    const inited = fx.init();
    ok(inited === true, 'init() 返回 true（以前这里是 false，三个按钮全死）');
    ok(fx.els.winBar.hidden === false, '标题栏显示出来');
    ok(fx.els.winMin.handlers.click && fx.els.winMin.handlers.click.length === 1, '最小化绑上了');
    ok(fx.els.winMax.handlers.click && fx.els.winMax.handlers.click.length === 1, '最大化绑上了');
    ok(fx.els.winClose.handlers.click && fx.els.winClose.handlers.click.length === 1, '关闭绑上了');
  }

  /* ───────────── 2. 最小化 ───────────── */
  console.log('\n[2] 最小化');

  {
    const fx = loadFrameWin({});
    fx.init();
    fx.els.winMin.click();
    await tick();
    ok(fx.calls.min === 1, '点最小化 → 窗口 minimize()');
    ok(fx.calls.winClose === 0, '没有误触关窗');
  }

  /* ───────────── 3. 最大化 / 还原 ───────────── */
  console.log('\n[3] 最大化 ↔ 还原');

  {
    const fx = loadFrameWin({ maximized: false });
    fx.init();
    fx.els.winMax.click();
    await tick();
    ok(fx.calls.max === 1, '非最大化态点一次 → maximize()');
    ok(fx.els.winBar.classList.contains('is-max'), '按钮图标切到「还原」');
  }

  {
    const fx = loadFrameWin({ maximized: true });
    fx.init();
    fx.els.winMax.click();
    await tick();
    ok(fx.calls.unmax === 1, '最大化态点一次 → unmaximize()');
    ok(!fx.els.winBar.classList.contains('is-max'), '按钮图标切回「最大化」');
  }

  {
    /* 双击标题栏空白处 = 最大化（Windows 习惯），点按钮不该触发它 */
    const fx = loadFrameWin({ maximized: false });
    fx.init();
    const dbl = (fx.els.winBar.handlers.dblclick || [])[0];
    ok(typeof dbl === 'function', '标题栏绑了 dblclick');
    if (dbl) { dbl({ target: { closest: () => null } }); await tick(); }
    ok(fx.calls.max === 1, '双击空白 → maximize()');
    if (dbl) { dbl({ target: { closest: (s) => (s === 'button' ? {} : null) } }); await tick(); }
    ok(fx.calls.max === 1 && fx.calls.unmax === 0, '双击按钮上不触发最大化');
  }

  /* ───────────── 4. ✕ 关窗 ───────────── */
  console.log('\n[4] ✕ 关窗：和 Ctrl+W 同一条路');

  {
    const fx = loadFrameWin({ appExit: true });
    fx.init();
    fx.els.winClose.click();
    await tick();
    ok(fx.calls.appExit === 1, '点 ✕ → App.exit()（退出流程，顺带存草稿）');
    ok(fx.calls.winClose === 0 && fx.calls.remoteClose === 0, '不去碰裸 window.close()');

    /* 幂等：Bridge 连上后 app.js 会再 init 一次，不能重复绑定 */
    const before = fx.els.winClose.handlers.click.length;
    fx.init();
    ok(fx.els.winClose.handlers.click.length === before, '第二次 init() 不会重复绑 handler');
    fx.els.winClose.click();
    await tick();
    ok(fx.calls.appExit === 2, '重复 init 之后点一次仍然只触发一次');
  }

  {
    /* 没有 App（app.js 还没跑到那段）→ 退到 Bridge.closeSelf + 400ms destroy */
    const fx = loadFrameWin({ bridgeClose: true, bridgeDestroy: true });
    fx.init();
    fx.els.winClose.click();
    await tick();
    ok(fx.calls.bridgeClose === 1, '没 App → Bridge.closeSelf()');
    fx.fireTimers();
    ok(fx.calls.bridgeDestroy === 1, '没关掉 → 400ms 后 destroySelf()');
  }

  {
    /* 连 Bridge 都没有 → 最后退到 remote close，再不行才 window.close() */
    const fx = loadFrameWin({});
    fx.init();
    fx.els.winClose.click();
    await tick();
    ok(fx.calls.remoteClose === 1, '没有 App/Bridge → remote 的 close()');
  }

  {
    const fx = loadFrameWin({ remote: false, ipc: false });
    fx.init();
    fx.els.winClose.click();
    await tick();
    ok(fx.calls.winClose === 1, '连 remote / IPC 都没有 → 才退回 window.close()');
  }

  /* ───────────── 5. 非启动器窗口什么都不做 ───────────── */
  console.log('\n[5] 非启动器窗口');

  {
    const fx = loadFrameWin({ search: '?id=abc&path=/x.pdf' });
    ok(fx.init() === false, '没有 launcher=1 → init() 不动');
    ok(fx.els.winBar.hidden === true, '标题栏保持隐藏（用原生边框）');
    ok(!fx.els.winMin.handlers.click, '不绑任何 handler');
  }

  /* ───────────── 6. 源码契约 ───────────── */
  console.log('\n[6] 源码契约');

  ok(/const LAUNCH_RE = \/\(\?:\\\?\|&\)launcher=1/.test(FW), '判据用的是 launcher=1 的正则');
  ok(/LAUNCH_RE\.test\(global\.location\.search/.test(FW), 'isLauncher 先读 location.search');
  ok(!/if \(!isLauncher\(\) \|\| !api\) return false;/.test(FW),
    'init() 不再要求 eagle.window 必须在（那是三个按钮全死的直接原因）');
  ok(/function remoteWin\(\)/.test(FW), '有 remoteWin()：@electron/remote 直连');
  ok(/ipc\.invoke\('plugin\.window\.'/.test(FW), '两条都没有时走 IPC 转发');
  ok(/if \(bound\) \{ refresh\(bar\); return true; \}/.test(FW), 'init() 幂等');
  ok(/min\.addEventListener\('click', \(\) => \{ act\('minimize'\); \}\)/.test(FW), '最小化绑 act(minimize)');
  ok(/max\.addEventListener\('click', \(\) => \{ toggleMax\(bar\); \}\)/.test(FW), '最大化绑 toggleMax()');
  ok(/close\.addEventListener\('click', \(\) => \{ closeSelf\(\); \}\)/.test(FW), '关闭绑 closeSelf()');
  ok(/global\.FrameWin = \{ init, refresh, isLauncher, closeSelf, act, toggleMax \}/.test(FW),
    '对外导出 init / refresh / closeSelf / act / toggleMax');
  ok(/typeof global\.Dbg !== 'undefined'[\s\S]{0,40}?global\.Dbg\.log\('framewin'/.test(FW), '关键动作写进 debug.log（下次好定位）');

  ok(/await step\('自绘窗口条（补）'[\s\S]{0,80}?FrameWin\.init\(\)/.test(APP),
    'app.js 在 Bridge 连上之后再 init 一次');
  ok(/(?<!FrameWin\.)\bwindow\.App = \{[\s\S]{0,200}?exit: exitPlugin/.test(APP), 'app.js 暴露 window.App.exit = exitPlugin');

  ok(/<button type="button" id="winClose" class="win-close" title="关闭"/.test(HTML), '顶栏 ✕ 还在（只是修好了行为）');
  ok(has(HTML, 'js/framewin.js'), 'framewin.js 仍然被引入');
  ok(/\/\(\?:\\\?\|&\)launcher=1\(\?:&\|#\|\$\)\//.test(HTML), '内联脚本的判据与 framewin 一致');

  const CSS = read('EaglePDFReader/css/app.css');
  ok(/\.winbar-ctl button \{[\s\S]{0,260}?-webkit-app-region: no-drag/.test(CSS),
    '按钮自己标了 no-drag（拖拽区按元素算，少这一行点击可能被当成拖标题栏吞掉）');
  ok(/\.winbar \{[\s\S]{0,300}?-webkit-app-region: drag/.test(CSS), '整条标题栏仍是可拖动的');

  /* ───────────── 7. 启动器那个 ✕ 也一起修 ───────────── */
  console.log('\n[7] 启动器 workbench.html 的 ✕');

  ok(/function closeWin\(\) \{/.test(LAUNCH), '启动器有自己的 closeWin()');
  ok(/getCurrentWindow[\s\S]{0,160}?w\.close\(\)/.test(LAUNCH), '首选 @electron/remote 的 getCurrentWindow().close()');
  ok(/plugin\.window\.[\s\S]{0,80}?'close'/.test(LAUNCH), '退路是 IPC 的 plugin.window. close');
  ok(!/w\.destroy\(\)/.test(LAUNCH), '启动器不做 destroy 兜底（马上要跳去主插件）');

  /* ───────────── 8. 退出流程与 ESC 没被改坏 ───────────── */
  console.log('\n[8] 退出流程 / ESC 不回退');

  ok(/function exitPlugin\(\) \{/.test(APP), 'exitPlugin 还在');
  ok(/tried = !!\(Bridge\.closeSelf && Bridge\.closeSelf\(\)\)/.test(APP), 'exitPlugin 先走 remote close');
  ok(/if \(Bridge\.destroySelf\) Bridge\.destroySelf\(\);[\s\S]{0,80}?\}, 400\)/.test(APP), 'exitPlugin 400ms 后 destroy 兜底');
  ok(/flushDrafts\(\)/.test(APP), '关窗前存草稿（✕ 复用这条路，笔记不会丢）');

  const EG = require('./EaglePDFReader/js/escguard.js');
  ok(EG.escapeAction({ depth: 0 }) === 'noop', 'ESC 空栈仍是 noop');
  ok(EG.escapeAction({ launcher: true, depth: 0 }) === 'noop', '启动器窗口 ESC 仍是 noop');

  const WB = read('EaglePDFReader/js/workbench.js');
  ok(/function close\(\) \{[\s\S]{0,400}?Esc\.remove\('workbench'\)/.test(WB), 'Workbench.close() 会摘掉自己的 ESC 层');

  /* ───────────── 9. 版本 ───────────── */
  console.log('\n[9] 版本号');

  const m1 = JSON.parse(read('EaglePDFReader/manifest.json'));
  const m2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m1.version), '三段式版本号，实际 ' + m1.version);
  ok(/^\d+\.\d+\.\d+$/.test(m2.version), '三段式版本号，实际 ' + m2.version);

  console.log('\n' + '─'.repeat(40));
  console.log('  PASS ' + pass + '   FAIL ' + fail);
  console.log('─'.repeat(40) + '\n');
  process.exit(fail ? 1 : 0);
})();
