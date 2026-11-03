/* v3.36 回归：装上就报「异步异常：refreshPath is not defined」
 *
 * 根因不是 refreshPath 写错了，是它被写进了**另一个闭包**：
 * projText/refreshPath 落到了 Trash 的 IIFE 里，而调用点在 Workbench.render()。
 * 两个 IIFE 各是一个作用域，函数声明提升也跨不过去 —— 于是每次渲染工作台
 * 都抛 ReferenceError，被 app.js 的 unhandledrejection 兜住，弹成红色横幅。
 *
 * 这一版因此不只测「字符串在不在」，而是：
 *   A. 用 vm + 假 DOM **真跑一遍 Workbench.render()**，跑通才算过；
 *   B. 对每个 `const X = (function () { … })();` 做作用域体检：
 *      里面调用的名字必须是本块声明的、文件级的，或语言内置的。
 *      这一条能提前抓住「补丁插错地方」这一类事故，不依赖人肉 diff。
 *
 * 运行：node test-v336.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

const WB = read('EaglePDFReader/js/workbench.js');
const APP = read('EaglePDFReader/js/app.js');
const HTML = read('EaglePDFReader/index.html');

/* ───────────── 假 DOM：getElementById 默认 null，需要时注册 ───────────── */
function makeDoc() {
  const nodes = Object.create(null);
  function mkEl(tag) {
    const n = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '', className: '', innerHTML: '', textContent: '', title: '',
      hidden: false, checked: false, disabled: false, value: '',
      style: {}, dataset: {}, childNodes: [], children: [],
      appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      addEventListener() {}, removeEventListener() {}, remove() {}, blur() {}, focus() {},
      setAttribute() {}, getAttribute() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; },
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; }
      }
    };
    return n;
  }
  const doc = {
    _nodes: nodes,
    getElementById(id) { return nodes[id] || null; },
    createElement: (tag) => mkEl(tag),
    createTextNode: (t) => ({ nodeValue: t }),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    documentElement: { dataset: {}, style: {}, classList: { add() {}, remove() {}, contains() { return false; } } },
    body: mkEl('body'),
    activeElement: null,
    register(id) { const n = mkEl('div'); n.id = id; nodes[id] = n; return n; }
  };
  return doc;
}

/* ───────────── 沙箱 ───────────── */
function boot(opts) {
  opts = opts || {};
  const doc = makeDoc();
  const dir = 'E:\\Notes Collection from Eagle\\DY - Clinical Surgery';
  const hub = 'E:\\Notes Collection from Eagle';
  const calls = { toast: [], saveDaily: 0 };

  const sandbox = {
    console,
    document: doc,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Math, Number, String, Boolean, Array, Object, Set, Map, Promise, RegExp, Error,
    U: {
      stripExt: (n) => String(n || '').replace(/\.[a-z0-9]+$/i, ''),
      relTime: () => '刚刚',
      dateKey: () => '2026-10-31',
      truncate: (s, n) => String(s || '').slice(0, n),
      fmtClock: () => '00:34',
      fmtDateCN: () => '10月31日',
      toast: (m, k) => { calls.toast.push([m, k]); }
    },
    Store: {
      getIndex: () => ({ entries: [], docs: {} }),
      getHistory: () => [],
      getDataDir: () => 'C:\\Users\\gougo\\AppData\\Roaming\\Eagle\\Plugins\\EagleNoteManager\\data',
      getDaily: () => '',
      saveDaily: () => { calls.saveDaily++; },
      rebuildIndex: () => {},
      getPrefs: () => ({}),
      setPrefs: () => {}
    },
    Bridge: {
      hasEagle: !!opts.hasEagle,
      state: { libraryName: 'DY - Clinical Surgery' },
      getAllItems: async () => [],
      countItems: async () => 0,
      showInFolder: () => true
    },
    Projection: {
      available: () => opts.projAvailable !== false,
      hubOf: () => hub,
      dirOf: () => dir,
      isOn: () => true,
      setEnabled: () => true,
      rebuildAll: () => ({ written: 0 })
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WB, sandbox, { filename: 'workbench.js' });
  return { sandbox, doc, calls, dir, hub };
}

console.log('\n[1] 真跑一遍 Workbench.render()——这正是用户看到红条的那条路径');
(async () => {
  {
    const { sandbox, doc, dir, hub } = boot({});
    const p = doc.register('wbProjPath');
    let err = null;
    try { await sandbox.Workbench.render(); } catch (e) { err = e; }
    ok(!err, 'render() 不抛异常' + (err ? '（实际：' + err.message + '）' : ''));
    ok(!(err && /is not defined/.test(err.message)), '不再出现 xxx is not defined');
    ok(typeof sandbox.Workbench.refreshPath === 'function', 'Workbench 导出了 refreshPath（app.js 换目录后要调它）');
    ok(typeof sandbox.Workbench.projText === 'function', 'Workbench 导出了 projText（供调试与测试）');

    const txt = String(p.textContent || '');
    /* v4.2.12：md 投影下线 —— 路径行显示数据根，chkMdProj 元素已从 HTML 删除 */
    ok(txt.indexOf(dir) === 0, '路径那行显示数据根：' + txt.slice(0, 40));
    ok(txt.indexOf('笔记数据随库走') > 0, '路径行口径 = 笔记数据随库走');
  }

  /* 再跑一次：第二次 render 不能因为 dataset.loaded 之类卡住或重复绑事件 */
  {
    const { sandbox } = boot({});
    let err = null;
    try { await sandbox.Workbench.render(); await sandbox.Workbench.render(); } catch (e) { err = e; }
    ok(!err, '连续 render 两次也正常');
  }

  /* 纯浏览器调试（没有 Projection）：要写「不可用」，而不是抛错 */
  {
    const { sandbox, doc } = boot({ projAvailable: false, hasEagle: true });
    const p = doc.register('wbProjPath');
    let err = null;
    try { await sandbox.Workbench.render(); } catch (e) { err = e; }
    ok(!err, '没有 Projection 时不抛错');
    ok(String(p.textContent).indexOf('不可用') >= 0, '没有 Projection 时明确写「不可用」');
  }

  /* ───────────── 2. 作用域体检：IIFE 里不许调用别人家的函数 ───────────── */
  console.log('\n[2] 每个闭包调用的名字，必须在自己的作用域里找得到');

  const BUILTIN = new Set([
    'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Date', 'Set', 'Map',
    'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol',
    'Intl', 'Proxy', 'Reflect', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
    'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone',
    'console', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage',
    'alert', 'confirm', 'prompt', 'fetch', 'atob', 'btoa', 'Blob', 'URL', 'FileReader',
    'FormData', 'Image', 'Audio', 'Event', 'CustomEvent', 'Node', 'Element', 'HTMLElement',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await',
    'async', 'else', 'do', 'try', 'delete', 'void', 'in', 'of', 'case', 'throw', 'yield',
    'super', 'this'
  ]);

  /* 文件级（顶层）声明与 window.xxx 挂载 */
  function topGlobals(src) {
    const g = new Set();
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) g.add(m[1]);
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) g.add(m[1]);
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) g.add(m[1]);
    return g;
  }

  /* 切出每个 `const X = (function () {` … `\n})();` */
  function iifeBlocks(src) {
    const out = [];
    const head = /^const ([A-Za-z_$][\w$]*) = \(function \(\) \{$/gm;
    let m;
    while ((m = head.exec(src))) {
      const start = m.index + m[0].length;
      const end = src.indexOf('\n})();', start);
      if (end < 0) break;
      out.push({ name: m[1], body: src.slice(start, end) });
      head.lastIndex = end;
    }
    return out;
  }

  /* 注释里也会出现 func( 这种写法（比如「以前会直接 closeWindow()」），
     先剥掉注释再扫，否则全是假警报。 */
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');

  /* 返回 [{ block, call }]：block 里调用了自己作用域里没有的名字 */
  function audit(src) {
    const g = topGlobals(src);
    const leaks = [];
    iifeBlocks(src).forEach((raw) => {
      const body = stripComments(raw.body);
      const own = new Set();
      for (const d of body.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) own.add(d[1]);
      for (const d of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) own.add(d[1]);
      /* 形参与箭头函数参数 */
      for (const d of body.matchAll(/\(([^()]*)\)\s*=>/g)) {
        d[1].split(',').forEach((x) => {
          const n = x.trim().split('=')[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n)) own.add(n);
        });
      }
      for (const c of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const n = c[2];
        if (own.has(n) || g.has(n) || BUILTIN.has(n)) continue;
        leaks.push({ block: raw.name, call: n });
      }
    });
    return leaks;
  }

  const blocks = iifeBlocks(WB);
  ok(blocks.length >= 3, '切出 ' + blocks.length + ' 个闭包（Workbench / KnowledgeBase / Trash）');

  const leaks = audit(WB);
  const leakTxt = leaks.map((l) => l.block + ' → ' + l.call + '()');
  ok(leaks.length === 0, '闭包内没有跨作用域的调用' + (leakTxt.length ? '（' + leakTxt.join('，') + '）' : ''));

  /* 检测器自检：拿一段「上次那种插错位置」的最小复刻，必须能报出来。
     不然这条检查可能永远是绿的，等于没测。 */
  const SAMPLE = [
    'const A = (function () {',
    '  function render() { refreshPath(); }',
    '  return { render };',
    '})();',
    'const B = (function () {',
    '  function refreshPath() { }',
    '  return { refreshPath };',
    '})();'
  ].join('\n');
  const sampleLeaks = audit(SAMPLE);
  ok(sampleLeaks.length === 1 && sampleLeaks[0].block === 'A' && sampleLeaks[0].call === 'refreshPath',
    '检测器对「函数放错闭包」这种事故是灵敏的（样本复刻 → 报 A → refreshPath）');

  /* 具体点：refreshPath / projText 必须跟 render 同一个闭包 */
  const wbBlock = blocks.filter((b) => b.name === 'Workbench')[0];
  const trashBlock = blocks.filter((b) => b.name === 'Trash')[0];
  ok(!!wbBlock && /function refreshPath\(/.test(wbBlock.body), 'refreshPath 定义在 Workbench 里（和 render 同一层）');
  ok(!!wbBlock && /function projText\(/.test(wbBlock.body), 'projText 也在一起（refreshPath 要用）');
  ok(!!trashBlock && !/function refreshPath\(/.test(trashBlock.body), 'Trash 里没有这个函数了（上次就是插到这儿才炸的）');
  ok(!/refreshPath,/.test(trashBlock.body.split('return {').pop() || ''), 'Trash 的导出表里不再有 refreshPath');

  /* ───────────── 3. 调用点：app.js 那边要防着用 ───────────── */
  console.log('\n[3] 外部调用点的防御');

  ok(!/Workbench\.refreshPath/.test(APP), 'app.js 不再有 refreshPath 调用点（changeProjRoot 已随 md 下线删除）');
  ok(/async function render\(\)/.test(WB), 'render 是 async（异常才会变成 unhandledrejection）');
  ok(/unhandledrejection/.test(APP), 'app.js 有全局兜底，红条本来就是这个兜底弹出的');
  ok(/refreshPath\(\);/.test(WB), 'render 里仍然刷新路径那行');

  /* HTML 里那两个元素的 id 不能改名，否则 refreshPath 静默失效
     v4.2.12：chkMdProj 已随 md 投影下线删除，wbProjPath 保留 */
  ok(/id="wbProjPath"/.test(HTML), '工作台有 #wbProjPath');
  ok(!/id="chkMdProj"/.test(HTML), '工作台不再有 #chkMdProj（md 投影下线）');

  console.log('\n' + (fail === 0 ? 'PASS ' : 'FAIL ') + pass + ' 项通过，' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})();
