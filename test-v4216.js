/* v4.2.16 回归：按 Esc 前交还非输入类焦点（蓝框偶闪根治）
   覆盖：
   1) Esc 分支存在「activeElement blur」前置步骤（preventDefault 之前、输入法判断之后）；
   2) 只 blur 非输入类：INPUT/TEXTAREA/contentEditable 不动；
   3) 4.2.14 的页签 click→blur 仍然在（双保险都在）；
   4) 双 manifest 版本一致（三段式）；
   5) README 版本行 + 更新记录。
*/
const fs = require('fs');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const A = fs.readFileSync('EaglePDFReader/js/app.js', 'utf8');
const TAB = fs.readFileSync('EaglePDFReader/index.html', 'utf8');
const README = fs.readFileSync('EaglePDFReader/README.md', 'utf8');
const MFEST = fs.readFileSync('EaglePDFReader/manifest.json', 'utf8');
const WFEST = fs.readFileSync('EagleNoteWorkbench/manifest.json', 'utf8');

console.log('\n[v4.2.16] Esc 焦点交还');

/* 1) Esc 分支里有 blur activeElement 的前置块 */
const escIdx = A.indexOf("if (e.key === 'Escape')");
const composingIdx = A.indexOf('if (e.isComposing || e.keyCode === 229) return;', escIdx);
const blurBlock = A.indexOf('v4.2.16', composingIdx);
ok(escIdx > 0 && composingIdx > escIdx && blurBlock > composingIdx,
  'Esc 分支内、输入法放行之后存在 v4.2.16 焦点交还块');
ok(/const ae = document\.activeElement;[\s\S]{0,300}ae\.blur\(\);/.test(A.slice(blurBlock, blurBlock + 900)),
  '块内：取 activeElement 并 blur');
ok(/ae\.tagName === 'INPUT' \|\| ae\.tagName === 'TEXTAREA' \|\| ae\.isContentEditable/.test(A.slice(blurBlock, blurBlock + 900)),
  '输入类（INPUT/TEXTAREA/contentEditable）排除在 blur 之外');
ok(A.indexOf('ae !== document.body', blurBlock) > 0 && A.indexOf('ae !== document.body', blurBlock) < blurBlock + 900,
  'body 兜底排除');

/* 2) blur 发生在 preventDefault 之前（绘制前执行才有「闪一下」根治意义）。
      以 v4.2.16 注释为锚，向后找 blur 与 Esc 分支真正的 preventDefault */
const anchor = A.indexOf('/* v4.2.16');
const blurAt = A.indexOf('ae.blur()', anchor);
const pdAt = A.indexOf('e.preventDefault();', blurAt);
ok(anchor > 0 && blurAt > anchor && pdAt > blurAt, '焦点交还在 preventDefault 之前（抢在下一次绘制前）');

/* 3) 4.2.14 页签 click→blur 双保险仍在 */
ok(/onAll\('#panelTabs \.panel-tab', 'click'[\s\S]{0,600}blur\(\)/.test(A),
  '页签 click→blur（4.2.14）仍保留');

/* 4) 行为沙箱：输入焦点不动、按钮焦点被交还 */
{
  const calls = [];
  const mk = (tagName, ce) => ({ tagName, isContentEditable: ce,
    blur() { calls.push('blur:' + tagName); } });
  const btn = mk('BUTTON', false);
  const ta = mk('TEXTAREA', false);
  const input = mk('INPUT', false);
  const ce = mk('DIV', true);
  const bodyEl = mk('BODY', false);
  const fn = new Function('document',
    'try { const ae = document.activeElement;\n' +
    "  if (ae && ae !== document.body && !(ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) { ae.blur(); }\n" +
    '} catch (err) {}');
  fn({ activeElement: btn, body: bodyEl });
  fn({ activeElement: ta, body: bodyEl });
  fn({ activeElement: input, body: bodyEl });
  fn({ activeElement: ce, body: bodyEl });
  fn({ activeElement: null, body: bodyEl });
  ok(calls.join(',') === 'blur:BUTTON', '行为沙箱：只有 BUTTON 被 blur，TEXTAREA/INPUT/contentEditable/BODY 都不动');
}

/* 5) 版本与文档 */
ok(/^\s*"version": "\d+\.\d+\.\d+"/m.test(MFEST) && /^\s*"version": "\d+\.\d+\.\d+"/m.test(WFEST), '双 manifest 版本三段式');
ok((MFEST.match(/"version":\s*"([^"]+)"/) || [])[1] === (WFEST.match(/"version":\s*"([^"]+)"/) || [])[1], '双 manifest 版本一致');
ok(/当前版本 \*\*4\.2\.16\*\*/.test(README) && /## 更新记录 · 4\.2\.16/.test(README), 'README 版本行 + 4.2.16 记录');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
