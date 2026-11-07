#!/usr/bin/env node
/* test-v440.js —— v4.4.0：OB 格式优化 + 双链精确定位 + ESC 关闭插件
 * ① 摘录/笔记原文用 Obsidian callout（> [!quote]- 标签）呈现，阅读视图可折叠、
 *    一眼可分；回读层把 > 行剥掉，回读口径零变化。
 * ② 笔记级双链口径统一为「原始第一行」（noteAnchorTitle）：manifest rec.nt、
 *    [[ 补全候选、跳转对账三处与投影 #### 标题头完全一致 —— OB 里 [[书#标题]]
 *    精确跳到那条笔记，不再只到文件。
 * ③ ESC 最后一级 = 关闭插件（用户要求恢复；决策点唯一、事件无条件吞掉）。
 * ④ 快捷键盘点：Ctrl+N 新建笔记、Ctrl+W 退出、Ctrl+F 搜索 —— 与 Eagle 官方
 *    快捷键对照后确认插件窗口内不冲突（插件按键全部 preventDefault+stopPropagation）。
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

const PJ = read('EaglePDFReader/js/projection.js');
const APP = read('EaglePDFReader/js/app.js');
const WJ = read('EaglePDFReader/js/wikilink.js');
const EG = require('./EaglePDFReader/js/escguard.js');

console.log('—— ① callout：写出侧 ——');
ok(/function quoteCallout\(text, title\) \{/.test(PJ), 'quoteCallout 辅助函数存在');
ok(/'> \[!quote\]- ' \+ String\(title \|\| '原文'\)/.test(PJ),
  'callout 头格式 > [!quote]- 标题（带折叠 - 标记）');
ok(/\.map\(\(l\) => '> ' \+ l\)/.test(PJ), '原文每行都以 > 起头（合法 callout 体）');
/* v4.5.0：标题统一成「原文 · 类型 · 颜色」，无标签时仍是「原文」 */
ok(/quoteCallout\(a\.text, '原文' \+ \(label \? ' · ' \+ label : ''\)\)/.test(PJ),
  '摘录原文走 callout，标题带类型·颜色标签（高亮·蓝 等）');
ok(/quoteCallout\(n\.quote, '原文'\)/.test(PJ), '笔记引用原文走 callout');
ok(!/function quoteBlock\(/.test(PJ), '旧 quoteBlock 已移除（无死代码）');

console.log('—— ② callout：回读侧口径不变（> 行全部剥离）——');
/* noteOfEx：摘录注释回读 —— 摘掉 ### 页头、引用行、图片行之后剩正文 */
ok(/function noteOfEx\(seg\) \{[\s\S]*?if \(\/\^\\s\*>\//.test(PJ),
  'noteOfEx 剥 > 行 —— callout 的 > [!quote]- 头和原文行都被消费');
/* bodyOfNt：笔记回读 —— > 行同样剥离 */
ok(/function bodyOfNt\(seg, expectTitle\) \{[\s\S]*?if \(\/\^\\s\*>\//.test(PJ),
  'bodyOfNt 剥 > 行 —— 笔记 callout 同样被消费，不产生假外部改动');
/* callout 头行也是一种 > 行，天然被上面两条吃掉 —— 无需专门适配 */

console.log('—— ③ 双链精确定位：noteAnchorTitle（原始第一行口径）——');
{
  const WL = require('./EaglePDFReader/js/wikilink.js');
  ok(typeof WL.noteAnchorTitle === 'function', 'WikiLink.noteAnchorTitle 已导出');
  ok(WL.noteAnchorTitle('参见 [[旧书]] 的第三章\n第二条') === '参见 [[旧书]] 的第三章',
    '第一行原样返回，[[ ]] 语法壳不剥（与 #### 标题头完全一致）');
  ok(WL.noteAnchorTitle('**重点**：前 3 小时黄金抢救窗') === '**重点**：前 3 小时黄金抢救窗',
    '强调记号不剥、不截 60 字 —— 候选/插入/标题头三方字节级一致');
  ok(WL.noteAnchorTitle('\n\n第二行才是正文') === '第二行才是正文',
    '跳过空行取第一个非空行');
  ok(WL.noteAnchorTitle('') === '' && WL.noteAnchorTitle(null) === '', '空输入 → 空串');
  ok(WL.noteTitle('参见 [[旧书]] 的第三章') === '参见 旧书 的第三章',
    'noteTitle（旧口径）保留作显示用途 —— 两个口径并存、各有分工');
}
ok(/rec\.nt = noteTitles/.test(PJ) || /nt: noteTitles/.test(PJ),
  'manifest rec.nt 继续写入（口径已切换为锚标题）');
ok(/WL\.noteAnchorTitle \? WL\.noteAnchorTitle\(a\.note\) : WL\.noteTitle\(a\.note\)/.test(PJ) ||
   /WL\.noteAnchorTitle \? WL\.noteAnchorTitle\(a\.note\)/.test(PJ),
  'manifest 侧摘录注释标题走 noteAnchorTitle（旧实现兜底）');
ok(/const t = \(WL\.noteAnchorTitle \|\| WL\.noteTitle\)\(n\.md\);/.test(PJ),
  '惰性回填同样走 noteAnchorTitle');
ok(/const t = \(WL\.noteAnchorTitle \|\| WL\.noteTitle\)\(n\.md\);/.test(WJ) === false,
  'wikilink.js 内无残留循环依赖');
/* 编辑器插入 [[书#标题]] 时用的是候选列表标题 = 锚标题 = 标题头 → OB 精确命中 */

console.log('—— ④ locateNoteByTitle：跳转对账用锚标题 ——');
ok(/function locateNoteByTitle\(title\) \{/.test(APP), 'locateNoteByTitle 存在');
ok(/WikiLink\.noteAnchorTitle/.test(APP), '跳转定位优先用 noteAnchorTitle（与标题头一致）');
ok(/WikiLink\.noteTitle/.test(APP), '旧口径保留为兼容回退（旧结构 md 未重建时仍可跳）');

console.log('—— ⑤ ESC：escapeAction 四档（真实模块）——');
ok(EG.escapeAction({ depth: 1 }) === 'pop-layer', '有浮层 → pop-layer（最优先）');
ok(EG.escapeAction({ depth: 0, searchActive: true }) === 'clear-search', '搜索有字 → 清搜索');
ok(EG.escapeAction({ depth: 0, typing: true }) === 'blur', '正在输入 → 失焦');
ok(EG.escapeAction({ depth: 0 }) === 'exit-plugin', '空栈 → exit-plugin（v4.4.0 恢复关闭插件）');
ok(EG.escapeAction() === 'exit-plugin', '空参数 → exit-plugin');
/* 穷举：有浮层时无论其他参数怎么变都必须 pop-layer */
{
  let bad = null, tried = 0;
  for (const l of [true, false]) for (const s of [true, false]) for (const t of [true, false]) {
    for (const f of [true, false]) for (const d of [0, 1, 2]) {
      tried++;
      const act = EG.escapeAction({ launcher: l, searchActive: s, typing: t, forceExit: f, depth: d });
      if (d > 0 && act !== 'pop-layer') bad = { l, s, t, f, d };
      if (d === 0 && act === 'pop-layer') bad = { l, s, t, f, d };
    }
  }
  ok(!bad, '穷举 ' + tried + ' 组参数：浮层永远快于关窗（' + JSON.stringify(bad) + '）');
}

console.log('—— ⑥ ESC：app.js 接线 ——');
ok(!/escExitHint\s*\(/.test(APP), 'escExitHint（按了没反应的提示）已退役');
ok(/closeVisibleOverlay\(\)\) return;[\s\S]{0,900}?exitPlugin\(\);/.test(APP),
  '兜底关完可见浮层 → exitPlugin() 关闭插件（与 ✕ / Ctrl+W 同一出口）');
ok(!/\? 'pop-layer' : 'noop'/.test(APP), 'EG 缺失时的 fallback 不再返回 noop');
ok(/if \(e\.key === 'Escape'[\s\S]{0,600}?window\.__escHandledAt = Date\.now\(\);/.test(APP),
  '认领时间戳在分支开头（任何 early return 之前）');
{
  const i = APP.indexOf('if (e.key === \'Escape\') {', 6000);
  const j = APP.indexOf('window.__escHandledAt', i);
  const k = APP.indexOf('e.preventDefault();\n      e.stopPropagation();', j);
  ok(i > 0 && j > i && k > j, 'preventDefault+stopPropagation 在认领之后、动作分发之前（绝不漏给 Eagle）');
}
ok(/if \(e\.isComposing \|\| e\.keyCode === 229\) return;/.test(APP), '输入法选词的 ESC 让给输入法');
ok(/if \(fsNow && !escFsPassed\) \{ escFsPassed = true; return; \}/.test(APP),
  '真全屏的第一次 ESC 让给浏览器（只让一次）');
ok(!/exit-plugin'[\s\S]{0,200}exitPlugin\(\);[\s\S]{0,100}exitPlugin\(\);/.test(APP),
  'exitPlugin 在 ESC 分支里只出现一次（无叠加兜底）');

console.log('—— ⑦ 快捷键盘点（与 Eagle 官方对照后不冲突的三个组合键）——');
ok(/\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'n'/.test(APP),
  'Ctrl+N / ⌘N → 新建笔记（Eagle 无此绑定）');
ok(/\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'w'/.test(APP),
  'Ctrl+W / ⌘W → 退出插件（Eagle 无此绑定）');
ok(/e\.key\.toLowerCase\(\) === 'f'/.test(APP), 'Ctrl+F → 搜索（Eagle 同键但插件窗口内已接管）');
ok(/kbd-hint/.test(read('EaglePDFReader/index.html')), '新建按钮标注 Ctrl+N 快捷键提示');

console.log('—— ⑧ 版本号与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version, '双插件版本号一致（' + M1.version + '）');
ok(/^\d+\.\d+\.\d+$/.test(M1.version), '版本号三段式');
const RD = read('EaglePDFReader/README.md');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(/更新记录 · 4\.4\.0（OB 格式优化 \+ 双链精确定位 \+ ESC 关闭插件）/.test(RD),
  'README 有 4.4.0 更新记录小节');
ok(/\[!quote\]/.test(PJ) && /callout/.test(PJ), '实现注释说明了 callout 设计与兼容性退化');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
