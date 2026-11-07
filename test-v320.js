/* test-v320.js —— v3.20.0 无边框窗口 + 自绘深色标题栏
   背景：Eagle 把 manifest 的 frame 直接传给 Electron，且全篇不设 nativeTheme.themeSource，
   于是 Windows 用系统主题给插件窗口画原生边框（浅色系统 → 白条），CSS/JS 无法改它的颜色。
   解法：启动器窗口 frame:false + 页面自绘深色标题栏。
   本测试：
   1) 静态：启动器 manifest frame:false；index.html 有 #winBar / 三个按钮；脚本与初始化已接好。
   2) 行为（桩 window/document 跑 framewin.js）：
      - 非启动器窗口 → 不启用、不加 body.frameless
      - 启动器窗口 → 启用、显示标题栏、加 body.frameless
      - 最小化 / 最大化 / 还原 / 关闭 / 双击标题栏 / 图标状态同步
   运行：node test-v320.js
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'EaglePDFReader');
const WB = path.join(ROOT, 'EagleNoteWorkbench');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('\n[1] 静态接线');
(() => {
  const wbMf = JSON.parse(fs.readFileSync(path.join(WB, 'manifest.json'), 'utf8'));
  ok(wbMf.main.frame === false, '启动器窗口 frame:false（去掉原生边框）');
  ok(wbMf.main.backgroundColor === '#18191c', '窗口底色仍是深色（无白闪）');
  ok(!('preview' in wbMf), '启动器仍无 preview（保住图钉资格）');

  const html = fs.readFileSync(path.join(MAIN, 'index.html'), 'utf8');
  ok(html.indexOf('id="winBar"') > 0, 'index.html 有自绘标题栏容器');
  ok(html.indexOf('id="winMin"') > 0 && html.indexOf('id="winMax"') > 0 && html.indexOf('id="winClose"') > 0,
    '三个窗口按钮齐全');
  ok(html.indexOf('js/framewin.js') > 0, 'framewin.js 已引入');
  ok(html.indexOf('framewin.js') > html.indexOf('multiselect.js'), 'framewin.js 在 app.js 之前加载');

  const app = fs.readFileSync(path.join(MAIN, 'js', 'app.js'), 'utf8');
  ok(app.indexOf('FrameWin.init()') > 0, 'app.js boot 里调用 FrameWin.init()');

  const css = fs.readFileSync(path.join(MAIN, 'css', 'app.css'), 'utf8');
  ok(css.indexOf('-webkit-app-region: drag') > 0, 'CSS 声明了拖动区域');
  ok(css.indexOf('-webkit-app-region: no-drag') > 0, '按钮区域排除拖动');
  ok(css.indexOf('body.frameless .app') > 0, 'frameless 时给标题栏让出高度');
  ok(css.indexOf('body.frameless .wb') > 0, '工作台视图也下移，不被标题栏盖住');
})();

console.log('\n[2] framewin 行为（桩 DOM）');
(() => {
  const src = fs.readFileSync(path.join(MAIN, 'js', 'framewin.js'), 'utf8');

  /* --- 极简 DOM 桩 --- */
  function makeEl(id) {
    const handlers = {};
    const classes = new Set();
    return {
      id, hidden: true, title: '',
      classList: {
        add: (c) => classes.add(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c)
      },
      _handlers: handlers,
      addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
      fire: (t, ev) => (handlers[t] || []).forEach((fn) => fn(ev || { target: { closest: () => null } })),
      querySelector: (sel) => (sel === '#winMax' ? els.winMax : null),
      closest: () => null
    };
  }
  const els = {};
  ['winBar', 'winMin', 'winMax', 'winClose'].forEach((id) => { els[id] = makeEl(id); });

  const listeners = {};
  function makeWindow(opts) {
    const calls = [];
    const win = {
      Bridge: { state: { query: opts.query || {} } },
      eagle: opts.noEagle ? undefined : {
        window: {
          minimize: () => { calls.push('minimize'); return Promise.resolve(); },
          maximize: () => { calls.push('maximize'); opts.maximized = true; return Promise.resolve(); },
          unmaximize: () => { calls.push('unmaximize'); opts.maximized = false; return Promise.resolve(); },
          isMaximized: () => Promise.resolve(!!opts.maximized)
        }
      },
      close: () => { calls.push('close'); },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      _calls: calls
    };
    return win;
  }
  const doc = {
    body: { classList: { add: (c) => { doc._bodyClass.add(c); }, contains: (c) => doc._bodyClass.has(c) } },
    _bodyClass: new Set(),
    getElementById: (id) => els[id] || null
  };

  function run(win) {
    doc._bodyClass = new Set();
    Object.keys(els).forEach((k) => { els[k].hidden = true; });
    /* framewin 是 IIFE(window)；document 走全局，临时挂上 */
    const fn = new Function('window', 'document', src + '\nreturn window.FrameWin;');
    return fn(win, doc);
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    /* 1) 非启动器窗口：不启用 */
    let w = makeWindow({ query: {} });
    let FW = run(w);
    ok(FW.init() === false, '非启动器窗口不启用自绘标题栏');
    ok(doc._bodyClass.has('frameless') === false, '非启动器窗口不加 body.frameless');
    ok(els.winBar.hidden === true, '非启动器窗口标题栏保持隐藏');

    /* 2) 启动器窗口：启用 */
    w = makeWindow({ query: { launcher: '1' } });
    FW = run(w);
    ok(FW.init() === true, '启动器窗口启用自绘标题栏');
    ok(doc._bodyClass.has('frameless') === true, '加了 body.frameless');
    ok(els.winBar.hidden === false, '标题栏显示出来');
    await tick();

    /* 3) 三个按钮 */
    els.winMin.fire('click');
    ok(w._calls.includes('minimize'), '最小化调用 eagle.window.minimize');

    await els.winMax.fire('click');
    await tick();
    ok(w._calls.includes('maximize'), '未最大化时点按钮 → maximize');
    ok(els.winBar.classList.contains('is-max') === true, '图标切换成「还原」');
    ok(els.winMax.title === '还原', '按钮提示改为「还原」');

    await els.winMax.fire('click');
    await tick();
    ok(w._calls.includes('unmaximize'), '已最大化时点按钮 → unmaximize');
    ok(els.winBar.classList.contains('is-max') === false, '图标切回「最大化」');

    await els.winBar.fire('dblclick');
    await tick();
    ok(w._calls.filter((c) => c === 'maximize').length >= 2, '双击标题栏也能最大化');

    els.winClose.fire('click');
    ok(!w._calls.includes('close'), 'v4.4.6：✕ 不再调用窗口 close/destroy，统一走 App.exit / hostExit');

    /* 4) v3.34.1：没有 eagle.window 也要启用。
       以前这里断言「无 eagle.window 就 return false」，正是那条规则让用户那台机器上
       ✕ / 最小化 / 最大化 全点不动：init() 在同步启动段跑，那时 eagle 还没注入。
       现在动作走 @electron/remote（这个桩里没有 require，于是退回 eagle.window / IPC），
       纯浏览器里点按钮也不会抛错。 */
    w = makeWindow({ query: { launcher: '1' }, noEagle: true });
    FW = run(w);
    let threw = null;
    try { ok(FW.init() === true, '无 eagle.window 仍然启用（不再被时序卡死）'); } catch (e) { threw = e; }
    ok(threw === null, '无 eagle.window 时不抛错');
    ok(doc._bodyClass.has('frameless') === true, '无 eagle.window 也加 frameless（标题栏本来就画好了）');
    try { els.winMin.fire('click'); els.winClose.fire('click'); } catch (e) { threw = e; }
    ok(threw === null, '无 eagle.window 时点按钮不抛错');

    console.log('\n----------------------------------------');
    console.log(`通过 ${pass} 项，失败 ${fail} 项`);
    process.exit(fail ? 1 : 0);
  })();
})();
