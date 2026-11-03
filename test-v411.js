/* v4.1.0 回归：界面重构（左栏移除 + 顶栏弹出面板）+ 环境检查弹窗重设计
 *
 * v4.1 变更：
 *   · 左侧栏整体移除：目录 / 缩略图 / 搜索结果 / 实时字幕改为顶栏弹出面板；
 *     阅读历史 UI 移除（数据仍记录，工作台「最近阅读」是入口）；
 *   · 网格从三列改两列，右栏加宽到 420px；
 *   · 环境检查弹窗加徽标头部 + 摘要行 + 卡片化条目；
 *   · 笔记区：底部新建 / 编辑区做成抬起的卡片。
 *
 * 覆盖：
 *   1. HTML：左栏元素已删、弹出面板与入口键齐全、onboard 新结构齐全
 *   2. CSS：两列网格、--panel-w 420、.side-pop / .sp-title / .sp-body、
 *           pop-subs/sub-tools、onboard 新样式、笔记区新样式、旧样式已清
 *   3. app.js：toggleSidePop / closeSidePops / syncSidePopBtns、applyModeUI 视频分支、
 *             搜索面板锚定、历史渲染函数已删但 Store.pushHistory 保留、
 *             ESC 栈（sidepop:* 体检 + 兜底关闭列表）、renderOnboard 摘要
 *   4. esc.js：has / push / remove / prune 接口与弹出面板用法匹配
 *   5. subtitle.js：picking 类挂到 .sub-tools（含 .sub-head 兜底）
 *   6. manifest / README 版本号
 *
 * 运行：node test-v411.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t + ' —'); }

const ROOT = path.join(__dirname, 'EaglePDFReader');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html');
const css = read('css/app.css');
const appjs = read('js/app.js');
const subjs = read('js/subtitle.js');
const escjs = read('js/esc.js');
const manifest = JSON.parse(read('manifest.json'));

/* ==================== 1. HTML ==================== */
section('1. index.html：左栏移除，弹出面板与入口键齐全');
['id="leftTabs"', 'id="leftBottom"', 'id="historyList"', 'id="splitter"',
  'id="lbTitle"', 'id="btnClearHistory"', 'class="left"', 'mini-tab', 'left-search-pane']
  .forEach((s) => ok(!html.includes(s), '左栏元素已删：' + s));
['id="outlinePop"', 'id="thumbsPop"', 'id="searchPane"', 'id="subPane"',
  'id="outlineList"', 'id="thumbList"', 'id="searchList"', 'id="subList"']
  .forEach((s) => ok(html.includes(s), '弹出面板 / 内容容器保留：' + s));
['id="btnPopOutline"', 'id="btnPopThumbs"', 'id="btnPopSubs"', 'data-spclose']
  .forEach((s) => ok(html.includes(s), '入口键 / 关闭键存在：' + s));
ok(html.includes('class="tool-btn" id="btnPopOutline"'), '目录 / 缩略图入口在顶栏（tool-btn）');
ok(html.includes('id="btnPopSubs"') && /id="btnPopSubs"[^>]*hidden/.test(html), '字幕入口默认 hidden（视频模式才显示）');
/* 字幕面板的控件一个都不能丢 */
['subDot', 'subName', 'subLang', 'subDomain', 'btnSubFix', 'btnSubCtx', 'btnSubSave',
  'btnSubToggle', 'subJump', 'subGuide', 'sgTitle', 'sgBar', 'sgFix', 'btnSubGo', 'subStat', 'btnSubExport']
  .forEach((id) => ok(html.includes('id="' + id + '"'), '字幕控件保留：' + id));
/* 搜索面板的控件 */
['searchPaneTitle', 'btnSearchPaneClose'].forEach((id) => ok(html.includes('id="' + id + '"'), '搜索面板控件保留：' + id));
/* onboard 新结构 */
['obBadge', 'onboardSum', 'onboardList', 'btnOnboardRecheck', 'btnOnboardSkip', 'btnOnboardDone']
  .forEach((id) => ok(html.includes('id="' + id + '"'), '环境检查弹窗元素：' + id));
ok(html.includes('ob-head') && html.includes('onboard-sum'), '环境检查弹窗有新头部与摘要行结构');

/* ==================== 2. CSS ==================== */
section('2. app.css：两列网格 + 弹出面板 + 新弹窗样式');
ok(/--panel-w:\s*420px/.test(css), '--panel-w 加宽到 420px');
ok(!/--left-w/.test(css), '--left-w 变量已删');
ok(/\.app\s*\{[^}]*grid-template-columns:\s*var\(--panel-w\)\s+minmax\(0,\s*1fr\)/.test(css), '.app 网格为两列（摘录/笔记栏 + 阅读区，v4.1.1 栏在左）');
ok(/\.panel\s*\{[^}]*border-right:\s*1px solid var\(--border\)/.test(css), '.panel 靠右边界用 border-right');
ok(!/left-collapsed/.test(css), 'left-collapsed 规则已删');
ok(css.includes('.side-pop') && css.includes('.sp-title') && css.includes('.sp-body'), '.side-pop / .sp-title / .sp-body 存在');
ok(/\.side-pop\s*\{[^}]*position:\s*absolute/.test(css), '.side-pop 绝对定位（弹在顶栏下方）');
ok(css.includes('.pop-outline') && css.includes('.pop-thumbs') && css.includes('.pop-search') && css.includes('.pop-subs'), '四个弹出面板的宽度规格齐全');
ok(css.includes('.sub-tools') && css.includes('.sub-tools.picking .sub-fix'), '.sub-tools 及多选紧凑模式样式存在');
ok(!/\.sub-head\s*\{/.test(css), '旧 .sub-head 样式已删');
ok(!/\.mini-tab|\.splitter|\.left-bottom|\.hist-item|\.history-list/.test(css), '左栏遗留样式已清');
ok(css.includes('.ob-badge') && css.includes('.onboard-sum') && css.includes('.onboard-row.st-missing'), '环境检查弹窗新样式（徽标 / 摘要 / 缺项竖条）');
ok(/\.onboard-foot\s*\{[^}]*border-top/.test(css), '环境检查底栏有分割线');
ok(css.includes('.panel-body > .note-editor'), '右栏笔记编辑区有抬起卡片样式');
ok(/\.app\.video-mode \.panel/.test(css) && !/\.app\.video-mode\.left-collapsed/.test(css), '视频模式网格规则已简化');

/* ==================== 3. app.js ==================== */
section('3. app.js：弹出面板逻辑 + 模式切换 + ESC + 历史');
['function toggleSidePop', 'function closeSidePops', 'function syncSidePopBtns',
  "SIDE_POPS = { outline: 'outlinePop', thumbs: 'thumbsPop', subs: 'subPane' }"]
  .forEach((s) => ok(appjs.includes(s), '弹出面板管理函数：' + s));
ok(!appjs.includes('switchLeftTab') && !appjs.includes('leftTabs') && !appjs.includes('#left)'),
  '旧左栏页签逻辑已删');
ok(!appjs.includes('renderHistory') && !appjs.includes('openHistoryItem') && !appjs.includes('bindSplitter'),
  '历史渲染 / 分割条逻辑已删');
ok(appjs.includes('Store.pushHistory'), '阅读历史仍照常记录（Store.pushHistory 保留）');
ok(appjs.includes("Esc.push('sidepop:' + which"), '弹出面板入 ESC 栈');
ok(appjs.includes("'sidepop:outline'") && appjs.includes("'sidepop:thumbs'") && appjs.includes("'sidepop:subs'"),
  'ESC 栈体检覆盖三个弹出面板');
ok(appjs.includes("['outlinePop', () => toggleSidePop('outline', false)]")
  && appjs.includes("['thumbsPop', () => toggleSidePop('thumbs', false)]")
  && appjs.includes("['subPane', () => toggleSidePop('subs', false)]"),
  'ESC 兜底关闭列表覆盖三个弹出面板');
ok(/bOut\.hidden = v/.test(appjs) && /bSub\.hidden = !v/.test(appjs), 'applyModeUI：目录 / 缩略图视频下隐藏，字幕仅视频显示');
ok(/closeSidePops\(v \? 'subs' : null\)/.test(appjs), 'applyModeUI：进视频先收其它面板（保留字幕）');
ok(appjs.indexOf("if (sp && sp.hidden && !searchOpen()) toggleSidePop('subs')") < 0, 'v4.2：进入视频不再自动弹出字幕面板（用户点「字幕」键才开）');
ok(appjs.includes('if (!state.thumbsBuilt || !list.childElementCount)') || /state\.thumbsBuilt && list\.childElementCount/.test(appjs),
  'renderThumbs：DOM 常驻，已建过只同步高亮');
ok(appjs.includes("pane.style.left") && appjs.includes("r.bottom + 6"), '搜索面板按搜索框位置动态锚定');
ok(appjs.includes('onboardSum'), 'renderOnboard 写摘要行');
ok(appjs.includes("actCount === 0") && appjs.includes("all-ok"), '摘要行区分「全就绪 / 还差几步」');
ok(appjs.includes('toggleSidePop,') && appjs.includes('closeSidePops,'), '调试导出更新为弹出面板函数');
ok(!/id="left"|'#left'/.test(appjs), 'app.js 不再引用 #left');

section('3b. app.js 语法');
try { new Function(appjs); ok(true, 'app.js 语法可解析'); } catch (e) { ok(false, 'app.js 语法错误：' + e.message); }

/* ==================== 4. esc.js 接口 ==================== */
section('4. esc.js：has / push / remove / prune 与用法匹配');
['function push(', 'function remove(', 'function has(', 'function prune(']
  .forEach((s) => ok(escjs.includes(s), 'Esc 接口存在：' + s.trim()));

/* ==================== 5. subtitle.js ==================== */
section('5. subtitle.js：picking 类挂到 .sub-tools');
ok(subjs.includes("b.closest('.sub-tools') || b.closest('.sub-head')"), 'picking 优先挂 .sub-tools，旧类名兜底');

/* ==================== 6. 版本 ==================== */
section('6. manifest / README 版本');
ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'manifest.json 三段式版本号（实际 ' + manifest.version + '）');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(read('README.md')), 'README 标注当前版本');
ok(/### 更新记录 · 4\.1/.test(read('README.md')), 'README 有 4.1.x 更新记录');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
