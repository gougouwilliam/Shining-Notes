#!/usr/bin/env node
/* test-v4350.js —— 精修模型下载修复回归
 * Bug：subtitle.js 两处 ensureRefine({ onProgress: showProgress }) 传了对象，
 *      ensureRefine(onProgress) 要裸函数 → 对象真值被调用 → TypeError → 下载刚起步就崩。
 * 修复：① 两处调用改传裸函数；② ensureRefine 归一化防御（函数/对象都收）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

console.log('—— ① 调用方：subtitle.js 传裸函数 ——');
const SUB = read('EaglePDFReader/js/subtitle.js');
ok(!/ensureRefine\(\{\s*onProgress/.test(SUB), 'subtitle.js 不再出现 ensureRefine({ onProgress: … }) 对象传参');
const callSites = (SUB.match(/Asr\.ensureRefine\(showProgress\)/g) || []).length;
ok(callSites === 2, '两处调用都改为 Asr.ensureRefine(showProgress)，实际 ' + callSites + ' 处');

console.log('—— ② 被调方：asr.js 归一化防御 ——');
const ASR = read('EaglePDFReader/js/asr.js');
ok(/typeof onProgress !== 'function' && typeof onProgress\.onProgress === 'function'/.test(ASR),
  'ensureRefine 对 { onProgress } 对象参数归一化为裸函数');
ok(/if \(onProgress && typeof onProgress !== 'function'/.test(ASR), '归一化仅在「真值且非函数」时改写');

console.log('—— ③ 行为沙箱：归一化三分支 ——');
{
  const m = /async function ensureRefine\(onProgress\) \{([\s\S]*?)const k = refineKey\(\);/.exec(ASR);
  ok(!!m, '从源码原样提取归一化块（测的是真实现）');
  if (m) {
    const fn = new Function('onProgress', "'use strict';\n" + m[1] + '\nreturn onProgress;');
    const real = () => {};
    ok(fn(real) === real, '分支1：裸函数原样透传');
    const wrapped = fn({ onProgress: real });
    ok(typeof wrapped === 'function' && wrapped === real, '分支2：{ onProgress } 对象解包出裸函数');
    ok(fn(undefined) === undefined, '分支3：undefined 不动（后续 if (onProgress) 守卫兜住）');
    const weird = fn({ noCb: 1 });
    ok(weird && typeof weird === 'object', '分支4：真值但无 onProgress 字段 → 保持原样（内部守卫拦）');
  }
}

console.log('—— ④ 其他调用方回归 ——');
const APP = read('EaglePDFReader/js/app.js');
ok(/A\.ensureRefine\(\(p\) => \{/.test(APP), 'app.js 下载中心的 ensureRefine 本来就传函数，保持不动');

console.log('—— ⑤ 版本号与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本号一致且三段式');
const RD = read('EaglePDFReader/README.md');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(/更新记录 · 4\.3\.5（精修模型下载修复）/.test(RD), 'README 有 4.3.5 更新记录小节');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
