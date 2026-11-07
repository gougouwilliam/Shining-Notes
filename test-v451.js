#!/usr/bin/env node
/* test-v451.js —— v4.5.1 稳定性 / 启动速度 / 冗余清理（行为级回归）
 *
 * 这一版不动任何功能与界面，只做四件事：
 *   ① 启动提速：pdf-lib（525KB）+ pinyin-pro（326KB）从首屏阻塞改为空闲加载，
 *      没就绪时降级（拼音退回子串、PDF 回写延后补做），就绪后自动生效；
 *      诊断用的 windowProbe 挪出关键路径；每步耗时写进 debug.log。
 *   ② 稳定性：退出即停后台定时器；PDF 回写不再因为「库还没到」而永久错过。
 *   ③ 红线：任何地方都不许再调窗口生命周期 / 可见性 API（minimize 也一样）。
 *   ④ 冗余：安装包不再塞 README/FEATURES；部署脚本会清掉陈旧文件
 *      但保留 Eagle 自己写的 window-state.json。
 *
 * 运行：node test-v451.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const APP = read('EaglePDFReader/js/app.js');
const EDITOR = read('EaglePDFReader/js/editor.js');
const PDFW = read('EaglePDFReader/js/pdfwrite.js');
const HTML = read('EaglePDFReader/index.html');
const VL = read('EaglePDFReader/js/vendorload.js');
const PACK = read('pack-plugin.py');

/* ---------- 用假 DOM 真跑 vendorload.js ---------- */
function loadVendor(opts) {
  const o = opts || {};
  const injected = [];
  const logs = [];
  const win = {};
  const doc = {
    head: {
      appendChild(node) {
        injected.push(node);
        /* 模拟浏览器：脚本插入后异步 load */
        setTimeout(() => {
          if (o.fail) { if (node.onerror) node.onerror(new Error('404')); return; }
          if (node.src.indexOf('pinyin') >= 0) win.pinyinPro = { match: () => [0] };
          if (node.src.indexOf('pdf-lib') >= 0) win.PDFLib = { PDFDocument: {} };
          if (node.onload) node.onload();
        }, 0);
      }
    },
    createElement() {
      const el = { src: '', async: false, onload: null, onerror: null };
      Object.defineProperty(el, 'src', {
        get() { return el._src || ''; },
        set(v) { el._src = String(v); }
      });
      return el;
    }
  };
  const timers = [];
  const sandbox = {
    window: win,
    document: doc,
    Dbg: { log: (tag, data) => logs.push([tag, data]) },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    requestIdleCallback: o.noIdle ? undefined : (fn) => { timers.push(fn); return 1; },
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VL, sandbox, { filename: 'vendorload.js' });
  /* vm 里顶层 const 不会挂成 sandbox 属性，模块自己会写 window.Vendor */
  return { V: win.Vendor || sandbox.Vendor, win, injected, logs, timers, sandbox };
}

/* ==================== 1. 首屏不再同步加载两个大块头 ==================== */
section('1. 首屏体积（index.html 不再阻塞加载 851KB）');
{
  ok(HTML.indexOf('<script src="vendor/pinyin-pro.js"></script>') < 0,
    'pinyin-pro 不再是同步 <script>（326KB 移出首屏）');
  ok(HTML.indexOf('<script src="vendor/pdflib/pdf-lib.min.js"></script>') < 0,
    'pdf-lib 不再是同步 <script>（525KB 移出首屏）');
  ok(HTML.indexOf('js/vendorload.js') > 0, '改为引入几十字节的 js/vendorload.js');
  ok(HTML.indexOf('js/vendorload.js') < HTML.indexOf('js/editor.js'),
    'vendorload 在 editor 之前就位（懒加载入口先于消费方）');
  ok(HTML.indexOf('<script src="vendor/pdfjs/pdf.min.js"></script>') > 0,
    '核心 pdf.js 仍同步加载（阅读器没有它就没有第一帧）');
  ok(fs.existsSync(path.join(__dirname, 'EaglePDFReader/vendor/pinyin-pro.js'))
    && fs.existsSync(path.join(__dirname, 'EaglePDFReader/vendor/pdflib/pdf-lib.min.js')),
    '两个 vendor 文件都还在包里（只是不再阻塞首屏）');
}

/* ==================== 2. vendorload 行为 ==================== */
section('2. vendorload 按需加载（vm 真跑）');
{
  const env = loadVendor();
  ok(typeof env.V.ensure === 'function' && typeof env.V.prefetch === 'function'
    && typeof env.V.isReady === 'function', '导出 ensure / prefetch / isReady');

  ok(env.V.isReady('pinyin') === false, '未加载时 isReady=false');
  const p = env.V.ensure('pinyin');
  ok(env.injected.length === 1 && env.injected[0].src.indexOf('vendor/pinyin-pro.js') >= 0,
    'ensure(pinyin) 动态插入 vendor/pinyin-pro.js');
  const p2 = env.V.ensure('pinyin');
  ok(env.injected.length === 1, '并发重复调用只插一次（复用同一个 Promise）');

  setTimeout(() => {
    ok(env.V.isReady('pinyin') === true, '脚本 load 后 isReady 变 true');
    ok(env.logs.some((l) => l[0] === 'vendor.load' && l[1] && l[1].ok === true),
      '加载结果写 debug.log（vendor.load ok）');
    ok(typeof env.V.state === 'undefined' || typeof env.V.status === 'function',
      '不暴露内部可变状态（只给 status() 快照）');

    /* 幂等：已就绪不再插脚本 */
    env.V.ensure('pinyin');
    ok(env.injected.length === 1, '已就绪后再 ensure 不重复插脚本');

    /* 失败降级：onerror 不抛、不卡死调用方 */
    const bad = loadVendor({ fail: true });
    bad.V.ensure('pdflib').then((okFlag) => {
      ok(okFlag === false, '加载失败 ensure 返回 false（不抛异常）');
      ok(bad.logs.some((l) => l[0] === 'vendor.load' && l[1] && l[1].ok === false),
        '失败也写 debug.log'); 

      /* prefetch：没有 requestIdleCallback 时退回 setTimeout，不阻塞 */
      const slow = loadVendor({ noIdle: true });
      slow.V.prefetch();
      ok(slow.injected.length === 0 && slow.timers.length === 1,
        '没有 requestIdleCallback 时先排定时器，绝不同步加载');
      slow.timers.forEach((fn) => fn());
      ok(slow.injected.length === 2, '空闲回调里把两个 vendor 都排上');
      finish();
    });
  }, 5);
}

function finish() {
  /* ==================== 3. 消费方降级 ==================== */
  section('3. 消费方：库没到就降级，到了自动生效');
  {
    ok(/function pinyinMatch\(\)/.test(EDITOR), 'editor 用惰性 pinyinMatch()，不缓存加载期结果');
    ok(!/const PinyinMatch = /.test(EDITOR), '不再有加载期固化的 PinyinMatch 常量');
    ok((EDITOR.match(/pinyinMatch\(\)/g) || []).length >= 2, '打分与高亮两处都现查');
    ok(EDITOR.indexOf('window.pinyinPro') > 0, '就绪判据仍是 window.pinyinPro.match');

    ok(/function ensure\(\)/.test(PDFW) && /Vendor\.ensure\('pdflib'\)/.test(PDFW),
      'pdfwrite.ensure() 走 Vendor 懒加载');
    ok(/function whenReady\(fn\)/.test(PDFW) && PDFW.indexOf('whenReady, sync') > 0,
      'pdfwrite.whenReady 已导出（库到位后补做一次）');

    ok(/function retryWhenPdfLib\(fn\)/.test(APP), 'app 有「库未就绪就排队补做」的入口');
    ok(/PdfWrite\.whenReady\(\(ok\) => \{/.test(APP), 'whenReady 回调带「有没有到」标记');
    ok(/pdfLibRetryQueued = false;[\s\S]{0,120}if \(!ok\) return;/.test(APP),
      '库没到也要放开「只补一次」标记（下次还能再试）');
    ok(/function whenReady\(fn\) \{[\s\S]{0,300}run\(!!ok\)/.test(PDFW) || /const run = \(ok\) =>/.test(PDFW),
      'pdfwrite.whenReady 成败都回调一次');
    const syncFn = APP.slice(APP.indexOf('function schedulePdfSync'), APP.indexOf('function maybeHealPdf'));
    ok(/if \(!PdfWrite\.available\(\)\) \{ retryWhenPdfLib\(schedulePdfSync\); return; \}/.test(syncFn),
      'schedulePdfSync 未就绪 → 排队补做');
    const healFn = APP.slice(APP.indexOf('function maybeHealPdf'), APP.indexOf('async function syncPdfFile'));
    ok(/retryWhenPdfLib\(maybeHealPdf\)/.test(healFn), 'maybeHealPdf 未就绪 → 排队补做');
    const clearFn = APP.slice(APP.indexOf('async function clearPdfMarksInFile'), APP.indexOf('async function clearPdfMarksInFile') + 700);
    ok(/await PdfWrite\.ensure\(\)/.test(clearFn),
      '用户主动「清空标记」会等库到位（不让文件留满屏孤儿高亮）');
  }

  /* ==================== 4. 关键路径与耗时埋点 ==================== */
  section('4. 启动关键路径与耗时埋点');
  {
    const openAt = APP.indexOf("await step('载入初始文档'");
    const probeAt = APP.indexOf("Dbg.log('env', env)");
    ok(openAt > 0 && probeAt > openAt, 'windowProbe（诊断）挪到「载入初始文档」之后');
    ok(/setTimeout\(\(\) => \{\s*\(async \(\) => \{[\s\S]{0,400}windowProbe/.test(APP),
      '诊断探针延后到首屏之后，不占关键路径');
    ok(/const bootT0 = /.test(APP) && /function sinceBoot\(\)/.test(APP), '启动计时起点 + sinceBoot()');
    ok(/Dbg\.log\('boot\.slow'/.test(APP) && /Dbg\.log\('boot\.done'/.test(APP),
      '每步 ≥60ms 记 boot.slow，收尾记 boot.done');
    ok(/await step\('同步窗口底色', \(\) => \{ try \{ Bridge\.syncWindowBg/.test(APP),
      '窗口底色不再 await（装饰动作不挡载入）');
    ok(/sync\('预取依赖', \(\) => \{ try \{ Vendor\.prefetch\(\)/.test(APP),
      'boot 同步段就把 vendor 预取排进空闲队列');
  }

  /* ==================== 5. 红线：零窗口 API ==================== */
  section('5. 红线：不许碰窗口生命周期 / 可见性');
  {
    /* 注释里提到 minimize 是「为什么删掉它」的说明，不算违规；只看活代码 */
    const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(code.indexOf('eagle.window.minimize') < 0 && code.indexOf('.window.minimize(') < 0,
      'app.js 活代码里已无 minimize 调用（旧「最小化」按钮删除）');
    const banner = code.slice(code.indexOf('function exitFailBanner'), code.indexOf('function exitFailBanner') + 1200);
    ok(banner.indexOf('data-xf="min"') < 0, '退出兜底横幅不再提供「最小化」');
    ok(/data-xf="retry"/.test(banner) && /data-xf="hide"/.test(banner), '只留「再试一次 / 知道了」');
    ok(!/BrowserWindow|\.destroy\(|\.close\(\)/.test(VL), 'vendorload 零窗口 API');
    ok(!/require\(|ipcRenderer/.test(VL), 'vendorload 不碰 Node / IPC（纯 DOM 插脚本）');
    ok(!/minimize|maximize|setAlwaysOnTop/.test(banner), '横幅里没有任何窗口操作');
    const FW = read('EaglePDFReader/js/framewin.js');
    ok(/function isPreviewUrl\(\)/.test(FW) && /if \(isPreviewUrl\(\)\) return false;/.test(FW),
      'framewin 安全绳：带 id/path 的预览页永不当启动器');
    ok(/\(\?:\\\?\|&\)\(\?:id\|path\)=/.test(FW) || /\(\?:id\|path\)=/.test(FW),
      '判据读 location.search 的 id / path');
  }

  /* ==================== 6. 退出收尾 ==================== */
  section('6. 稳定性：退出即停表');
  {
    ok(/function stopBgTimers\(\)/.test(APP), '新增 stopBgTimers()');
    const fn = APP.slice(APP.indexOf('function stopBgTimers'), APP.indexOf('function projMeta'));
    ok(/clearInterval\(state\.rtTimer\)/.test(fn), '停掉显存轮询');
    ok(/_timer\) \{ clearInterval/.test(fn) && /_reconcileTimer/.test(fn), '停掉投影回读与删除对账');
    ok(/_rebuildKick/.test(fn) && /clearTimeout/.test(fn), '取消还没跑的一次性任务');
    const exitAt = APP.indexOf('async function exitPlugin');
    const exitBody = APP.slice(exitAt, exitAt + 2200);
    ok(/Projection\.flush\(\)/.test(exitBody), '退出先把投影写完');
    ok(!/stopBgTimers\(\)/.test(exitBody),
      '退出请求发出前不停表（宿主 Exit 可能没生效，停了同步就断了）');
    const unloadAt = APP.indexOf('const onUnloadPersist');
    const unloadBody = APP.slice(unloadAt, unloadAt + 1200);
    ok(/Projection\.flush\(\)[\s\S]{0,200}stopBgTimers\(\)/.test(unloadBody),
      'beforeunload：先落盘再停表（顺序不能反）');
    ok((APP.match(/stopBgTimers\(\)/g) || []).length >= 2,
      'beforeunload / pagehide 两处都收尾');
  }

  /* ==================== 7. 打包与部署的冗余清理 ==================== */
  section('7. 冗余文件');
  {
    ok(/README\.md/.test(PACK) && /FEATURES\.md/.test(PACK),
      '安装包排除 README/FEATURES（单 README 就 300KB）');
    const DEPLOY = read('deploy-plugin.py');
    ok(/window-state\.json/.test(DEPLOY) && /PRESERVE/.test(DEPLOY),
      '部署脚本保留 Eagle 自己写的 window-state.json');
    ok(/os\.remove/.test(DEPLOY) && /removed/.test(DEPLOY),
      '部署时清掉源码里已不存在的陈旧文件');
    ok(/plugin-snapshots/.test(DEPLOY) && /PLUG.*plugin-snapshots|SNAP/.test(DEPLOY),
      '快照仍然放在 Plugins 之外');
    ok(!fs.existsSync(path.join(__dirname, 'pj.json')), '根目录临时元数据 pj.json 已清掉');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
