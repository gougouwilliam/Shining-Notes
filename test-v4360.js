#!/usr/bin/env node
/* test-v4360.js —— 双链在 Obsidian 里可用（v4.3.6）
 * 问题：插件写的 [[书名]] / [[书名#笔记]] 在 OB 全是未解析链接。
 *   ① OB 按文件名（或 frontmatter aliases）解析书级链接，投影文件名经 safeName
 *      消毒/截断/加后缀，书名对不上；
 *   ② OB 的 [[书#标题]] 只认标题，而笔记标题（正文第一行）藏在正文里，没有标题头。
 * 修复：
 *   ① build() frontmatter 写 aliases（原始书名 + 改名历史，剔除与文件名相同的）；
 *   ② 笔记块写出 `#### 标题` 标题头（文本 = 原始第一行，[[双链]] 不能被剥壳；
 *      正文从第二行写起），回读时消费标题头、把标题还原成 md 第一行 ——
 *      没动过不产生假外部改动，改了标题/正文都原样同步。
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

console.log('—— ① 书级：frontmatter aliases ——');
ok(/aliases: \[' \+ fmList\.map\(yamlStr\)\.join\(', '\) \+ '\]'/.test(PJ),
  'frontmatter 写出 aliases: [ … ] 行');
ok(/pushAlias\(name\)/.test(PJ), '原始书名（未消毒）进别名表');
ok(/prev\.aliases\.forEach\(pushAlias\)/.test(PJ), '改名历史（manifest aliases）进别名表');
ok(/fmList = fmAliases\.filter\(\(a\) => WL\.normalize\(a\) !== WL\.normalize\(safeName\(name\)\)\)/.test(PJ),
  '与文件名相同的别名剔除，不写冗余行');
ok(/if \(fmList\.length\) L\.push\('aliases:/.test(PJ), '别名表为空时不写 aliases 行');

console.log('—— ② 笔记级：写出 #### 标题头 ——');
ok(/const firstLine = mdText \? mdText\.split\(\/\\r\?\\n\/\)\[0\]\.trim\(\) : '';/.test(PJ),
  '标题头文本 = 原始第一行（不用 noteTitle 剥壳版，[[双链]] 不丢）');
ok(/L\.push\('#### ' \+ firstLine\);/.test(PJ), '标题升级成 #### 标题头');
ok(/const rest = firstLine \? mdText\.split\(\/\\r\?\\n\/\)\.slice\(1\)\.join\('\\n'\)\.trim\(\) : mdText;/.test(PJ),
  '正文从第二行写起（OB 里标题不重复显示）');
ok(/L\.push\('### ' \+ head\);\s*\n\s*if \(firstLine\) \{/.test(PJ), '标题头紧跟 ### 页码/独立笔记 行');
ok(!/WL\.noteTitle\(mdText\)/.test(PJ), '标题头不再走 WL.noteTitle（剥壳会丢 [[ ]]）');

console.log('—— ③ 笔记级：回读消费标题头（真实 bodyOfNt 沙箱，返回存储口径字符串）——');
let bodyOfNt = null;
{
  const m = /function dropNoise[\s\S]*?function bodyOfNt\(seg, expectTitle\) \{[\s\S]*?\n  \}/.exec(PJ);
  ok(!!m, '从源码原样提取 dropNoise + bodyOfNt（测的是真实现）');
  if (m) {
    const WL = { normalize: (t) => String(t == null ? '' : t).trim().toLowerCase() };
    bodyOfNt = new Function('WL', 'dropNoise',
      "'use strict';\n" + m[0] + '\nreturn bodyOfNt;')(WL,
      (s) => String(s || '').split(/\r?\n/)
        .filter((l) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l))
        .filter((l) => !/^\s*<!--[\s\S]*?-->\s*$/.test(l))
        .join('\n').replace(/\n{3,}/g, '\n\n').trim());
  }
}
if (bodyOfNt) {
  /* 场景 A：新结构、没动过 → 标题头消费后还原成存储口径，零假改动 */
  const md = '卒中防治的核心要点\n第二条正文。';
  const seg = [
    '### 第 3 页',
    '#### 卒中防治的核心要点',
    '',
    '> 引用原文一行',
    '',
    '第二条正文。',
    ''
  ].join('\n');
  ok(bodyOfNt(seg, '卒中防治的核心要点') === md, 'A：标题头消费 + 还原成第一行，与存储完全一致');

  /* 场景 B：单行笔记（正文只有标题） */
  ok(bodyOfNt('### 独立笔记\n#### 单行标题\n', '单行标题') === '单行标题', 'B：单行笔记还原成标题行');

  /* 场景 C：用户在 OB 改了正文 → 改动被检出，标题行不丢 */
  const segC = seg.replace('第二条正文。', '用户在 OB 里改过的正文。');
  ok(bodyOfNt(segC, '卒中防治的核心要点') === '卒中防治的核心要点\n用户在 OB 里改过的正文。',
    'C：OB 改正文 → want 带标题行 + 新正文');

  /* 场景 D：用户在 OB 改了标题 → 对不上第一行，标题头当正文收回（下一轮自愈） */
  const segD = seg.replace('#### 卒中防治的核心要点', '#### 新标题');
  const wantD = bodyOfNt(segD, '卒中防治的核心要点');
  ok(wantD.indexOf('#### 新标题') >= 0 && wantD.indexOf('第二条正文。') >= 0,
    'D：标题对不上 → 不消费，原样进正文');

  /* 场景 E：旧结构 md（标题在正文里、没有标题头）→ 口径不变 */
  ok(bodyOfNt('### 第 1 页\n\n> 引用\n\n旧标题行\n旧正文。', '旧标题行') === '旧标题行\n旧正文。',
    'E：旧结构不消费标题头，want 与旧口径一致');

  /* 场景 F：只有引用没有正文的笔记 → expectTitle 空，不消费任何东西 */
  ok(bodyOfNt('### 第 2 页\n\n> 纯引用笔记\n', '') === '', 'F：无标题笔记 → 无假改动');

  /* 场景 G：用户自己写的 #### 小节（不紧跟 ### 行）不受影响 */
  const wantG = bodyOfNt('### 第 3 页\n#### 卒中防治的核心要点\n\n> 引用\n\n正文前段\n\n#### 我的小节\n\n小节内容',
    '卒中防治的核心要点');
  ok(wantG.indexOf('卒中防治的核心要点') === 0 && wantG.indexOf('#### 我的小节') >= 0
    && wantG.indexOf('小节内容') >= 0, 'G：插件标题头消费、用户 #### 小节保留在正文');

  /* 场景 H（本次回归核心）：第一行含 [[双链]] → 标题头原样保留，不剥壳 */
  const mdH = '参见 [[旧书]] 的第三章';
  const segH = '### 独立笔记\n#### 参见 [[旧书]] 的第三章\n';
  ok(bodyOfNt(segH, mdH) === mdH, 'H1：含 [[ ]] 的标题行消费还原无损');
  ok(/L\.push\('#### ' \+ firstLine\);/.test(PJ) && !/WL\.noteTitle/.test(
    (PJ.match(/const firstLine = mdText[\s\S]*?L\.push\('#### ' \+ firstLine\);/) || [''])[0]
  ), 'H2：写出侧标题头不经 noteTitle 剥壳（[[旧书]] 不消失）');
}

console.log('—— ④ vault README 说明 ——');
ok(/\| frontmatter 的 `aliases:` \|/.test(PJ), 'vault README 表格补了 aliases 行');
ok(/每条笔记的标题（正文第一行）写成 `#### 标题`/.test(PJ), 'vault README 规矩里说明了标题头');

console.log('—— ⑤ 版本号与文档 ——');
const M1 = JSON.parse(read('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
ok(M1.version === M2.version && /^\d+\.\d+\.\d+$/.test(M1.version), '双插件版本号一致且三段式');
ok(M1.version === '4.3.6', '版本号推进到 4.3.6');
const RD = read('EaglePDFReader/README.md');
ok(/当前版本 \*\*4\.3\.6\*\*/.test(RD), 'README 当前版本 4.3.6');
ok(/更新记录 · 4\.3\.6（双链在 Obsidian 里可用）/.test(RD), 'README 有 4.3.6 更新记录小节');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
