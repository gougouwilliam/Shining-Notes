#!/usr/bin/env node
/* test-v444.js —— 点击页面后 ESC 仍能退出（v4.4.4）
 * 现场：打开文档不操作 / 只滚轮 → ESC 能退出；鼠标点过一下 → ESC 失效。
 *       debug.log 里 00:25 之后成片的 exit.selfclose，全是
 *       {allow:false, allowWindowClose:true, code:'no-self-id'}。
 * 根因：app.js 在 window 上挂了匿名 beforeunload（退出时 persist）。
 *       Chromium 规定：页面有 beforeunload 监听器且用户已产生 sticky
 *       activation（点击/按键）时，脚本发起的 window.close() 会被拦下；
 *       滚轮不产生 activation，所以「不操作时能退、点一下就不能退」。
 *       v4.4.3 恰好把 window.close() 留成了唯一出口。
 * 修复：① 退出前摘掉自己的 beforeunload 监听；
 *       ② 新增第三级许可 allowSenderClose，主进程按
 *          BrowserWindow.fromWebContents(event.sender) 定向 close/destroy；
 *       ③ window.close() 降级为兜底，320ms 仍活则 destroy 硬销毁；
 *       ④ 连按 ESC 防抖 + 诊断日志补全。
 * 安全：Eagle 主窗口 / browser / 身份不明形态一律拿不到 allowSenderClose，
 *       绝不重演「ESC 把 Eagle 一起收进托盘」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const WG = require('./EaglePDFReader/js/winguard.js');
const EG = require('./EaglePDFReader/js/escguard.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); }

const WG_SRC = read('EaglePDFReader/js/winguard.js');
const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const ASR = read('EaglePDFReader/js/asr.js');
const RD = read('EaglePDFReader/README.md');

console.log('—— ① 现场形态：parentID=2 / windowID=8 / selfId=null ——');
{
  /* debug.log 00:25、00:26、00:26:13 三轮，windowID 分别是 8 / 11 / 14 */
  [8, 11, 14].forEach((wid) => {
    const v = WG.closeVerdict({
      mode: 'preview', parentID: 2, windowID: wid,
      selfId: null, allIds: null, selfIsHost: false
    });
    ok(v.code === 'no-self-id', 'windowID=' + wid + ' 裁决码仍是 no-self-id（旧契约不变）');
    ok(v.allow === false, 'windowID=' + wid + ' remote / IPC 取窗口仍封死');
    ok(v.allowWindowClose === true, 'windowID=' + wid + ' window.close 仍放行');
    ok(v.allowSenderClose === true, 'windowID=' + wid + ' ★ 新增：sender 定向关窗放行');
  });
}

console.log('—— ② 危险 / 身份不明形态：sender 关窗一律零放行 ——');
[
  [{}, 'unknown-mode', '形态未知'],
  [{ mode: 'browser' }, 'browser-mode', '浏览器调试'],
  [{ mode: 'window', selfIsHost: true, selfId: 2, allIds: [1, 2] }, 'flagged-host', '明确标记 selfIsHost'],
  [{ mode: 'preview', parentID: 2, windowID: 2 }, 'windowID-is-parent', '真跑在主窗口 webContents'],
  [{ mode: 'preview', parentID: 2 }, 'no-self-id', '有 parentID 却拿不到 windowID'],
  [{ mode: 'window', parentID: 2 }, 'no-self-id', 'window 形态同样身份不明'],
  [{ mode: 'preview' }, 'preview-no-self', 'preview 但窗口身份全无']
].forEach(([env, code, msg]) => {
  const v = WG.closeVerdict(env);
  ok(v.allowSenderClose === false && v.allow === false && v.code === code,
    msg + ' → 三级全拒（' + v.code + '）');
});
{
  const v = WG.closeVerdict({ mode: 'window', selfId: 2, allIds: [1, 2] });
  ok(v.allow === true && v.allowWindowClose === true && v.allowSenderClose === true,
    '独立 window 形态三级全开（grant 路径不受影响）');
}

console.log('—— ③ 穷举：allowSenderClose 的必要条件 ——');
{
  const bools = [true, false];
  const ids = [null, 1, 5];
  let bad = null, tried = 0, senderCnt = 0;
  for (const mode of ['window', 'preview', 'browser', '']) {
    for (const parentID of ids) {
      for (const windowID of ids) {
        for (const selfId of ids) {
          for (const host of bools) {
            for (const all of [null, [1], [1, 2], [1, 5]]) {
              tried++;
              const v = WG.closeVerdict({ mode, parentID, windowID, selfId, allIds: all, selfIsHost: host });
              const separate = parentID !== null && windowID !== null && parentID !== windowID;
              const standalone = parentID === null && windowID === null && mode === 'window';
              const expect = v.allow === true ? true : (v.allowWindowClose && (separate || standalone));
              if (v.allowSenderClose) senderCnt++;
              if (v.allowSenderClose !== expect) {
                bad = { mode, parentID, windowID, selfId, host, code: v.code, got: v.allowSenderClose, expect };
              }
              /* 绝不允许「封了 window.close 却放行 sender destroy」这种倒挂 */
              if (!v.allowWindowClose && v.allowSenderClose) {
                bad = { mode, parentID, windowID, inverted: true, code: v.code };
              }
            }
          }
        }
      }
    }
  }
  ok(!bad, '穷举 ' + tried + ' 组：许可边界完全符合定义（' + JSON.stringify(bad) + '）');
  ok(senderCnt > 0 && senderCnt < tried, '确实存在放行与拒绝两组（守卫不是摆设）');
}

console.log('—— ④ Bridge：按 sender 定向关窗通道 ——');
{
  ok(/function closeCurrent\(method\) \{/.test(BR), '新增 closeCurrent(method)');
  ok(/if \(!v\.allow && !v\.allowSenderClose\) \{/.test(BR), '双闸门：allow 或 allowSenderClose 至少其一');
  ok(/return ipcWindow\(method === 'destroy' \? 'destroy' : 'close'\);/.test(BR),
    '只转发 close / destroy 两个方法，交给主进程 sender 定位');
  ok(/fromWebContents\(event\.sender\)/.test(BR), '注释写明主进程按 sender 定位，不跨窗口');
  ok(/pending\.catch\(\(\) => \{\}\)/.test(BR), 'invoke 的 Promise reject 被吞掉，不制造 UnhandledRejection');
  ok(/^\s+closeCurrent,$/m.test(BR), 'closeCurrent 已导出给 app.js');
  ok(/exit\.senderclose\.deny/.test(BR), '被拒时写 debug.log，下轮好定位');
}

console.log('—— ⑤ app.js：退出前摘 beforeunload ——');
{
  ok(/let detachUnloadPersist = null;/.test(APP), '模块级摘钩句柄');
  ok(/const onUnloadPersist = \(\) => \{ persist\(true\); \};/.test(APP), 'beforeunload 改具名监听');
  ok(/window\.addEventListener\('beforeunload', onUnloadPersist\)/.test(APP), '具名监听已注册');
  ok(/window\.removeEventListener\('beforeunload', onUnloadPersist\)/.test(APP), '摘钩时真正 remove 掉');
  ok(!/window\.addEventListener\('beforeunload', \(\) => \{ persist\(true\); \}\)/.test(APP),
    '旧的匿名 beforeunload 已彻底移除（不然没法摘）');
  ok(/if \(detachUnloadPersist\) detachUnloadPersist\(\)/.test(APP), 'exitPlugin 保存数据后立刻摘钩');
  const e = APP.indexOf('async function exitPlugin()');
  const d = APP.indexOf('detachUnloadPersist()', e);
  const p = APP.indexOf('persist(true)', e);
  ok(e > 0 && p > e && d > p, '顺序正确：先 persist 落盘，再摘钩（不丢数据）');
}

console.log('—— ⑥ app.js：预览分支的关窗序列 ——');
{
  const i = APP.indexOf('async function exitPlugin()');
  const k = APP.indexOf('if (!verdict.allow && verdict.allowWindowClose) {', i);
  const end = APP.indexOf('exiting = false;\n      return;', k);
  ok(i > 0 && k > i && end > k, '能定位到预览分支');
  const seg = APP.slice(k, end);
  ok(/now - exitSentAt < 1200/.test(seg), '连按 ESC 1.2s 防抖，不重复发 IPC');
  ok(/Bridge\.closeCurrent\('close'\)/.test(seg), '主路径：主进程 sender 定向 close');
  ok(/window\.close\(\)/.test(seg), 'renderer 的 window.close 降级为兜底');
  ok(/Bridge\.closeCurrent\('destroy'\)/.test(seg), '320ms 仍活 → destroy 硬销毁');
  ok(/}, 320\);/.test(seg) && /}, 900\);/.test(seg), '硬兜底 320ms、提示 900ms');
  ok(/\[120, 420\]\.forEach/.test(seg), '保留两次宿主 restore/show（不抢焦点）');
  ok(!/Bridge\.(closeSelf|destroySelf)\(/.test(seg) && !/\.destroy\(\)/.test(seg),
    '不直接调 remote 关窗 API（那条路可能指回主窗口）');
  ok(/dbg\('exit\.senderclose'/.test(seg) && /dbg\('exit\.senderdestroy'/.test(seg) &&
     /dbg\('exit\.stillalive'/.test(seg), '三级诊断日志齐全');
  ok(/窗口未关闭，请按空格或点 Eagle 的返回退出预览/.test(seg), '极端情况仍给可执行提示');
}

console.log('—— ⑦ 根因写进注释，防止下次再判错 ——');
ok(/sticky activation/.test(WG_SRC) && /beforeunload/.test(WG_SRC),
  'winguard 注释说明 beforeunload + 点击的 Chromium 规则');
ok(/allowSenderClose/.test(WG_SRC) && /separateWindow/.test(WG_SRC),
  'winguard 注释说明第三级许可与证据要求');
ok(/sticky activation/.test(read('EaglePDFReader/js/escguard.js')),
  'escguard 注释同步更正：ESC 分级没错，错在关窗通道');

console.log('—— ⑧ ESC 策略不变 ——');
ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '有浮层仍只收浮层');
ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索有字仍先清字');
ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '输入中仍先失焦');
ok(EG.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈仍返回 exit-plugin');
ok(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(
  APP.slice(APP.indexOf("if (e.key === 'Escape') {", 6000), APP.indexOf("if (e.key === 'Escape') {", 6000) + 3000)
), 'ESC 仍无条件吞掉，不漏给 Eagle 宿主');

console.log('—— ⑨ ASR 进度回调崩溃防御（日志里的 TypeError） ——');
ok(!/if \(onProgress\) onProgress\(/.test(ASR), '不再有任何「真值就当函数调用」的进度回调');
ok((ASR.match(/typeof onProgress === 'function'\) onProgress\(/g) || []).length >= 5,
  '所有进度回调统一用 typeof === function 判定');
ok(/let onProgress = o\.onProgress;/.test(ASR), 'prepare 入口也做对象传参归一');
ok(/typeof onProgress !== 'function' && typeof onProgress\.onProgress === 'function'/.test(ASR),
  '保留 v4.3.5 的归一化契约（旧套件零回归）');

console.log('—— ⑩ 版本与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本一致且三段式');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(/更新记录 · 4\.4\.4（/.test(RD), 'README 有 4.4.4 更新记录小节');
ok(/更新记录 · 4\.4\.3（修复/.test(RD), 'README 保留 4.4.3 历史小节');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) process.exit(1);
