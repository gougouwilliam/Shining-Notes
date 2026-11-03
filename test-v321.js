/* test-v321.js —— v3.20.1：plugin-run 分诊（RunGate）
 * 背景：Eagle 建窗时连发两次 plugin-run，导致启动器窗口落地后被选中项顶掉。
 * 这里对三档判定做行为级验证，并把 app.js / index.html 的接线固定住。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'EaglePDFReader');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const G = require('./EaglePDFReader/js/rungate.js');

console.log('\n[1] 三档判定：启动器窗口永远是工作台');
(() => {
  ok(G.verdict({ launcher: true, hasDoc: false, touched: false }) === 'workbench',
    '启动器 + 无文档 + 未交互 → workbench');
  ok(G.verdict({ launcher: true, hasDoc: true, touched: true }) === 'workbench',
    '启动器 + 已开文档 + 已交互 → 仍是 workbench（图标语义就是工作台）');
  ok(G.verdict({ launcher: true }) === 'workbench',
    '启动器（缺省字段）→ workbench');
})();

console.log('\n[2] 普通窗口：建窗期的伪触发要丢掉');
(() => {
  ok(G.verdict({ launcher: false, hasDoc: false, touched: false }) === 'ignore',
    '无文档 + 未交互 → ignore（Eagle 建窗连发的 plugin-run）');
  ok(G.verdict({}) === 'ignore', '空参数 → ignore（默认不抢文档）');
  ok(G.verdict({ hasDoc: true }) === 'open-selected',
    '已打开文档 → open-selected（老的「点选条目就打开」不变）');
  ok(G.verdict({ touched: true }) === 'open-selected',
    '用户已动过界面 → open-selected（真·再次触发）');
  ok(G.verdict({ hasDoc: false, touched: true }) === 'open-selected',
    '在工作台里操作过之后再触发 → open-selected');
})();

console.log('\n[3] 返回值收敛在三种之内');
(() => {
  const set = new Set();
  for (const launcher of [true, false, undefined]) {
    for (const hasDoc of [true, false, undefined]) {
      for (const touched of [true, false, undefined]) {
        set.add(G.verdict({ launcher, hasDoc, touched }));
      }
    }
  }
  ok(set.size === 3 && set.has('workbench') && set.has('ignore') && set.has('open-selected'),
    '27 种组合只产出 3 种结果：' + [...set].join(' / '));
})();

console.log('\n[4] 接线：app.js 必须真的走这个判定');
(() => {
  const app = read('EaglePDFReader/js/app.js');

  ok(/Bridge\.onRun\(async \(\) => \{[\s\S]{0,600}?RunGate\.verdict\(/.test(app),
    'onRun 回调里调用 RunGate.verdict');

  ok(app.indexOf("if (q.launcher) return;") > 0,
    'openInitial 顶部对 launcher 窗口直接返回（不读选中项）');

  const runBlk = app.slice(app.indexOf('Bridge.onRun(async () => {'));
  const blk = runBlk.slice(0, runBlk.indexOf('\n      });'));
  ok(blk.indexOf("v === 'ignore'") > 0, 'workbench/ignore 分支存在');
  ok(blk.indexOf("Workbench.open(true)") > 0, 'workbench 分支回工作台');
  ok(blk.indexOf('getSelectedDocs') > 0, 'open-selected 分支仍读选中项');

  ok(/touched: userTouched/.test(app), '判定入参用真实的 userTouched');
  ok(/hasDoc: loaded\(\)/.test(app), '判定入参用 loaded()');
  ok(/launcher: !!q\.launcher/.test(app), '判定入参用 query.launcher');

  ok(app.indexOf('function markUserTouch()') > 0, '存在 markUserTouch');
  ok(app.indexOf("sync('交互标记'") > 0, 'boot 里注册了交互标记');

  /* 交互标记必须覆盖指针/键盘/滚轮，否则「只滚了一下」会被误判成没交互 */
  const mk = app.slice(app.indexOf('function markUserTouch()'));
  const mkBody = mk.slice(0, mk.indexOf('\n  }'));
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => {
    ok(mkBody.indexOf("'" + ev + "'") > 0, '交互标记监听 ' + ev);
  });
})();

console.log('\n[5] 接线：脚本顺序（rungate 必须在 app.js 之前）');
(() => {
  const html = read('EaglePDFReader/index.html');
  const iGate = html.indexOf('js/rungate.js');
  const iApp = html.indexOf('js/app.js');
  ok(iGate > 0, 'index.html 引入 js/rungate.js');
  ok(iApp > 0 && iGate < iApp, 'rungate.js 在 app.js 之前加载');
})();

console.log('\n[6] 模块形态：浏览器与 Node 都能用（测试靠的就是这个）');
(() => {
  const src = read('EaglePDFReader/js/rungate.js');
  ok(src.indexOf('module.exports') > 0, '有 CommonJS 导出');
  ok(src.indexOf('root.RunGate') > 0, '挂了浏览器全局 RunGate');
  ok(typeof G.verdict === 'function', 'verdict 是函数');
  ok(Object.keys(G).length === 1, '只暴露 verdict 一个 API');
})();

console.log('\n[7] 文档与版本');
(() => {
  const mf = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8'));
  const wb = JSON.parse(fs.readFileSync(path.join(ROOT, 'EagleNoteWorkbench', 'manifest.json'), 'utf8'));
  ok(mf.version === wb.version, '主插件与启动器版本同步：' + mf.version);
  const readme = read('EaglePDFReader/README.md');
  ok(readme.indexOf('3.20.1') > 0, 'README 有 3.20.1 记录');
  ok(readme.indexOf('plugin-run') > 0, 'README 写明了 plugin-run 的根因');
  ok(readme.indexOf('当前版本 **' + mf.version + '**') > 0, 'README 当前版本与 manifest 一致');
})();

console.log('\n========================================');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
