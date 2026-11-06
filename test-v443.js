#!/usr/bin/env node
/* test-v443.js —— 预览窗口 ESC 一致退出（v4.4.3）
 * 现场：打开文档不操作按 ESC 能退出；一操作再按只弹「预览视图，不执行关闭」。
 *       debug.log 43 次裁决全是 no-self-id。
 * 根因：Eagle 的 openPreview 用 new BrowserWindow 独立承载预览，
 *       windowID !== parentID 恰恰证明「我不是主窗口」；v4.4.1 却把有 parentID
 *       一律当成内嵌 webview，remote 拿不到 selfId 就永久拒绝关窗。
 * 修复：winguard 两级许可（allow=remote/IPC，allowWindowClose=window.close），
 *       exitPlugin 在拒绝 remote 但允许 window.close 时只关自己的预览窗口。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WG = require('./EaglePDFReader/js/winguard.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const WG_SRC = read('EaglePDFReader/js/winguard.js');
const APP = read('EaglePDFReader/js/app.js');
const HTML = read('EaglePDFReader/index.html');
const RD = read('EaglePDFReader/README.md');
const EG = require('./EaglePDFReader/js/escguard.js');

console.log('—— ① 现场裁决：43 次 no-self-id 现在能关自己的窗口 ——');
{
  /* 现场 debug.log 里能取到的全部线索：mode=preview、有 parentID、
     预览窗口 windowID ≠ parentID、remote 拿不到 selfId。 */
  const live = { mode: 'preview', parentID: 1, windowID: 5, selfId: null, allIds: null, selfIsHost: false };
  const v = WG.closeVerdict(live);
  ok(v.code === 'no-self-id', '裁决码保持 no-self-id（旧契约不变）');
  ok(v.allow === false, 'remote / IPC 关窗仍被封死（绝不误关 Eagle 主窗口）');
  ok(v.allowWindowClose === true, 'window.close() 放行 → ESC 能关掉自己的预览窗口');
  ok(v.allow === false && v.allowWindowClose === true, '两级许可组合正确');
}

console.log('—— ② 危险形态一律零窗口操作 ——');
[
  [{}, 'unknown-mode', '形态未知'],
  [{ mode: 'browser' }, 'browser-mode', '浏览器调试形态'],
  [{ mode: 'window', selfIsHost: true, selfId: 2, allIds: [1, 2] }, 'flagged-host', '明确标记 selfIsHost'],
  [{ mode: 'preview', parentID: 1, windowID: 1, selfId: 2, allIds: [1, 2] }, 'windowID-is-parent', 'windowID === parentID（真跑在主窗口里）'],
  [{ mode: 'window', parentID: 1, windowID: 1 }, 'windowID-is-parent', 'window 模式同样不许与主窗口共用 webContents']
].forEach(([env, code, msg]) => {
  const v = WG.closeVerdict(env);
  ok(v.allow === false && v.allowWindowClose === false && v.code === code,
    msg + ' → 两级全拒（' + v.code + '）');
});

console.log('—— ③ 证据不足只封 remote，不封自己的窗口 ——');
[
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 1, allIds: [1, 2] }, 'self-is-parent'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2 }, 'window-list-unknown'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1] }, 'single-window'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1, 3] }, 'self-not-in-list'],
  [{ mode: 'preview' }, 'preview-no-self'],
  [{ mode: 'preview', selfId: 2 }, 'preview-unproven'],
  [{ mode: 'window', selfId: 2, allIds: [1] }, 'single-window']
].forEach(([env, code]) => {
  const v = WG.closeVerdict(env);
  ok(v.allow === false && v.allowWindowClose === true && v.code === code,
    code + ' → 只封 remote，window.close 仍可用（' + v.code + '）');
});

console.log('—— ④ 放行的两种形态：两级都开 ——');
[
  [{ mode: 'window' }, 'standalone-window'],
  [{ mode: 'window', selfId: 2, allIds: [1, 2] }, 'standalone-window'],
  [{ mode: 'preview', parentID: 1, windowID: 5, selfId: 2, allIds: [1, 2] }, 'own-window'],
  [{ mode: 'preview', selfId: 2, allIds: [1, 2] }, 'preview-own-window']
].forEach(([env, code]) => {
  const v = WG.closeVerdict(env);
  ok(v.allow === true && v.allowWindowClose === true && v.code === code,
    code + ' → 两级全放行');
});
ok(WG.closeVerdict({ mode: 'preview', parentID: 1, windowID: 5 }).allowWindowClose === true,
  'windowID 与 parentID 分离即可证明独立窗口，不需要 remote');
ok(WG.idOf('7') === 7 && WG.idOf(0) === null && WG.idOf('') === null,
  'idOf 归一化沿用 v4.4.1 契约');

console.log('—— ⑤ 穷举：allowWindowClose 只有 4 类拒绝码会关掉 ——');
{
  const bools = [true, false];
  const ids = [null, 1, 5];
  let bad = null, tried = 0, closedCnt = 0;
  const closedCodes = ['unknown-mode', 'browser-mode', 'flagged-host', 'windowID-is-parent'];
  for (const mode of ['window', 'preview', 'browser', '']) {
    for (const parentID of ids) {
      for (const windowID of ids) {
        for (const selfId of ids) {
          for (const host of bools) {
            for (const all of [null, [1], [1, 2], [1, 5]]) {
              tried++;
              const v = WG.closeVerdict({ mode, parentID, windowID, selfId, allIds: all, selfIsHost: host });
              if (!v.allowWindowClose) {
                closedCnt++;
                if (closedCodes.indexOf(v.code) < 0) bad = { mode, parentID, windowID, selfId, host, code: v.code };
              }
              if (v.allow && !v.allowWindowClose) bad = { mode, allow: true, code: v.code };
            }
          }
        }
      }
    }
  }
  ok(!bad, '穷举 ' + tried + ' 组：window.close 只在 4 类危险码被封（' + JSON.stringify(bad) + '）');
  ok(closedCnt > 0 && closedCnt < tried, '确实存在被封的组合（守卫不是摆设）');
}

console.log('—— ⑥ 事实依据写进注释，防止下次再判错 ——');
ok(/pluginModule\.openPreview/.test(WG_SRC), '注释记录 openPreview 源码位置');
ok(/new BrowserWindow/.test(WG_SRC), '注释明确预览是独立 BrowserWindow');
ok(/allowWindowClose/.test(WG_SRC) && /两级许可/.test(WG_SRC), '注释说明两级许可的设计');
ok(HTML.indexOf('js/winguard.js') > 0 && HTML.indexOf('js/winguard.js') < HTML.indexOf('js/bridge.js'),
  'winguard.js 仍在 bridge.js 之前加载');

console.log('—— ⑦ exitPlugin：新分支只 window.close，绝不碰 remote ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const j = APP.indexOf('let verdict = { allow: true, allowWindowClose: true', i);
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', j);
  const denyAt = APP.indexOf('if (!verdict.allow) {', k);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  ok(i > 0 && j > i && k > j && end > k && denyAt > end, '能定位到新分支与旧拒绝分支（新分支在前）');
  const seg = APP.slice(k, end);
  ok(/window\.close\(\)/.test(seg), '新分支调用 window.close() 关自己的窗口');
  ok(seg.indexOf('closeSelf') < 0 && seg.indexOf('destroySelf') < 0 &&
     seg.indexOf('ipcWindow') < 0 && seg.indexOf('destroy()') < 0,
    '新分支没有任何 remote / IPC / destroy 调用');
  ok(/Bridge\.focusParent\(\{ focus: false \}\)/.test(seg), '只 restore/show 宿主，不抢焦点');
  ok(/\[120, 420\]\.forEach/.test(seg), '120/420ms 两次补恢复');
  ok(/窗口未关闭，请按空格或点 Eagle 的返回退出预览/.test(seg), '脚本关窗被拒时有可执行兜底提示');
  ok(/}, 900\);/.test(seg), '兜底提示延迟到 900ms（关窗成功就不会弹）');
  ok(/exiting = false/.test(seg + 'exiting = false;'), '复位 exiting，不会卡住后续退出');

  const denySeg = APP.slice(denyAt, APP.indexOf('exiting = false;\n      return;', denyAt));
  ok(denySeg.indexOf('window.close') < 0 && denySeg.indexOf('closeSelf') < 0 &&
     denySeg.indexOf('destroySelf') < 0,
    '完全拒绝分支仍零窗口操作（v4.4.1 契约保留）');
  ok(/U\.toast\('当前是 Eagle 预览视图/.test(denySeg), '完全拒绝时仍给明确提示');
  ok(/dbg\('exit\.guard', verdict\)/.test(APP), '裁决结果写入 debug.log');
  ok(/dbg\('exit\.env', Bridge\.windowIdentity\(\)\)/.test(APP), '补记 windowIdentity 全字段');
  ok(/dbg\('exit\.selfclose', verdict\)/.test(APP), '补记 selfclose 决策');
}

console.log('—— ⑧ ESC 策略不变 ——');
ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '有浮层仍只收浮层');
ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索有字仍先清字');
ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '输入中仍先失焦');
ok(EG.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈仍返回 exit-plugin');
ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(
  APP.slice(APP.indexOf("if (e.key === 'Escape') {", 6000), APP.indexOf("if (e.key === 'Escape') {", 6000) + 3000)
), 'ESC 仍无条件吞掉，不漏给 Eagle 宿主');

console.log('—— ⑨ 版本与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === '4.4.3' && M2.version === '4.4.3', '双插件版本同为 4.4.3');
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '版本一致且三段式');
ok(/当前版本 \*\*4\.4\.3\*\*/.test(RD), 'README 当前版本 4.4.3');
ok(/更新记录 · 4\.4\.3（修复/.test(RD), 'README 有 4.4.3 更新记录小节');
ok(/更新记录 · 4\.4\.2（Eagle 删除条目后/.test(RD), '4.4.2 历史小节保留');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
