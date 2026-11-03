/* test-v322.js —— v3.22.0：ESC 语义分流 + 优雅选区条带
 *
 * 覆盖三条用户反馈：
 *   1) PDF 预览界面按 ESC 退不出去        → EscGuard + exitPlugin 的 window.close
 *   2) 置顶工作台按 ESC 只收起工作台      → launcher 落地页直达退出
 *   3) 划词轻微一动就选一大片、蓝色刺眼   → SelBand 裁带 / 吸附修正 / 原生高亮透明
 *
 * 纯函数做行为级断言；DOM 接线用静态源码断言固定，避免回归。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const E = require('./EaglePDFReader/js/escguard.js');
const S = require('./EaglePDFReader/js/selband.js');
const R = require('./EaglePDFReader/js/rungate.js');

console.log('\n[1] ESC 动作判定：v3.31 起 ESC 永不关窗口');
(() => {
  ok(E.escapeAction({ launcher: true, depth: 1, topName: 'workbench' }) === 'pop-layer',
    'launcher + 栈顶工作台 → pop-layer（ESC 只往回收，不再退出整窗）');
  ok(E.escapeAction({ launcher: true, depth: 0 }) === 'noop',
    'launcher + 无浮层 → noop（什么都不做，窗口留着）');
  ok(E.escapeAction({ launcher: true, depth: 2, topName: 'confirm' }) === 'pop-layer',
    'launcher + 确认框在上 → pop-layer（不越过未保存确认）');
  ok(E.escapeAction({ launcher: false, depth: 1, topName: 'workbench' }) === 'pop-layer',
    '普通窗口 + 工作台浮层 → pop-layer（从笔记界面进工作台，ESC 只收工作台）');
  ok(E.escapeAction({ depth: 0, searchActive: true }) === 'clear-search',
    '搜索框有字 → clear-search');
  ok(E.escapeAction({ depth: 0, typing: true }) === 'blur',
    '正在输入 → blur（留给输入法）');
  ok(E.escapeAction({ depth: 0 }) === 'noop', '无浮层无输入 → noop（绝不关窗口）');
  ok(E.escapeAction() === 'noop', '空参数 → noop');
  /* 用户的原话：「想关闭另存为，按 ESC，也退出 eagle 界面了」。
     forceExit 就是给这种场景准备的「连按两次强退」—— 现在整条拿掉。 */
  ok(E.escapeAction({ forceExit: true, launcher: true, depth: 2, topName: 'workbench' }) === 'pop-layer',
    'forceExit 已废弃：传了也只收一层');
  ok(E.escapeAction({ forceExit: true, depth: 0 }) === 'noop',
    'forceExit 再也不能把窗口关掉');
  const acts = ['exit-plugin'];
  ['', 'a', null].forEach((k) => {
    ok(E.escapeAction({ depth: 0, topName: k, launcher: !!k }) !== 'exit-plugin',
      '任何参数组合都不会返回 exit-plugin（' + JSON.stringify(k) + '）');
  });
  ok(acts.indexOf(E.escapeAction({ depth: 0 })) < 0, '「退出插件」这一档整条删除');
})();

console.log('\n[1b] 连续 ESC 模拟：按多少下都不许关窗口');
(() => {
  /* 用户实测场景：另存为框弹不出来，想按 ESC 把它关掉 ——
     旧实现第二下就判定「空转」并强退，于是 Eagle 界面跟着没了。
     现在没有「强退」这条路径，连按多少下都只是逐层回收。 */
  const t0 = 1000000;
  let closedAt = -1;
  for (let i = 0; i < 5; i++) {
    const act = E.escapeAction({ depth: 1, topName: 'toolbar' });
    if (act === 'exit-plugin') { closedAt = i; break; }
  }
  ok(closedAt === -1, '连按五下都不会退出（旧实现第二下就关窗）');

  /* 无层可关时连按：也只是重复 noop，不会升级成退出 */
  let act2 = null;
  for (let i = 0; i < 5; i++) act2 = E.escapeAction({ depth: 0 });
  ok(act2 === 'noop', '空栈连按五下仍是 noop');

  /* 真的逐级退出：三层界面依次回收，每一下都是 pop-layer */
  let steps = 0;
  const layers = ['toolbar,trPanel|BODY', 'toolbar|BODY', 'BODY'];
  for (let i = 0; i < layers.length; i++) {
    const act = E.escapeAction({ depth: layers.length - i, topName: 'layer' + i });
    ok(act === 'pop-layer', '第 ' + (i + 1) + ' 下只收一层');
    steps++;
  }
  ok(steps === 3, '三层界面依次退完');
})();

console.log('\n[1c] Esc 栈体检：只清理「肉眼确认已关闭」的层');
(() => {
  const src = read('EaglePDFReader/js/esc.js');
  const EscMod = new Function('window', src + '\nreturn Esc;')({});
  EscMod.push('toolbar', () => {});
  EscMod.push('confirm', () => {});
  EscMod.push('tr', () => {});
  ok(EscMod.names().join(',') === 'toolbar,confirm,tr', '三层按打开顺序入栈');
  const n = EscMod.prune((name) => name !== 'tr');
  ok(n === 1 && EscMod.names().join(',') === 'toolbar,confirm', 'prune 移除失效层 tr');
  ok(EscMod.prune(() => { throw new Error('x'); }) === 0, 'keep 抛错 → 一律保留（不误删）');
  ok(EscMod.prune(() => undefined) === 0, 'keep 返回 undefined → 保留（未知层保守处理）');
  EscMod.push('search', () => {});
  ok(EscMod.prune((n2) => n2 !== 'search') === 1 && EscMod.depth() === 2, '按名精确清理');
})();

console.log('\n[2] 优先级：浮层 > 搜索 > 输入 > 什么都不做');
(() => {
  ok(E.escapeAction({ launcher: true, depth: 1, topName: 'workbench', searchActive: true, typing: true }) === 'pop-layer',
    '有浮层时先收浮层（即使在工作台里 / 即使焦点在输入框里）');
  ok(E.escapeAction({ depth: 0, searchActive: true, typing: true }) === 'clear-search',
    '无浮层时先清搜索（在输入框里也不关窗）');
  ok(E.escapeAction({ launcher: false, depth: 1, topName: 'search' }) === 'pop-layer',
    '普通窗口搜索入栈 → pop-layer 优先于 clear-search');
  ok(E.escapeAction({ searchActive: true, typing: true }) === 'clear-search',
    '搜索 + 输入 → clear-search 优先于 blur');
})();

console.log('\n[3] ESC 决策只暴露一个出口（不残留能关窗的旧 API）');
(() => {
  const EscSrc = read('EaglePDFReader/js/escguard.js');
  ok(!/function\s+(?:isRepeat|canSelfClosePreview)\s*\(/.test(EscSrc),
    '兜底期的 isRepeat / canSelfClosePreview 已删除（注释里留个说明可以）');
  ok(Object.keys(E).join(',') === 'escapeAction', '导出只有 escapeAction');
})();

console.log('\n[4] SelBand.mapRects：视口矩形 → 页内相对坐标并裁剪');
(() => {
  const pages = [{ page: 1, left: 0, top: 0, right: 200, bottom: 300 }];
  const r = S.mapRects([{ left: 10, top: 20, right: 50, bottom: 34 }], pages);
  ok(r.length === 1 && r[0].page === 1 && r[0].left === 10 && r[0].width === 40,
    '页内矩形原样映射');
  const cross = S.mapRects([{ left: 150, top: 20, right: 260, bottom: 34 }], pages);
  ok(cross.length === 1 && cross[0].width === 50, '越出页右边界 → 裁到页内');
  ok(S.mapRects([{ left: 400, top: 20, right: 460, bottom: 34 }], pages).length === 0,
    '完全在页外 → 丢弃');
  ok(S.mapRects([{ left: 10, top: 20, width: 0, height: 0 }], pages).length === 0,
    '零尺寸 → 丢弃');
  const two = S.mapRects(
    [{ left: -10, top: 290, right: 40, bottom: 320 }],
    [{ page: 1, left: 0, top: 0, right: 200, bottom: 300 },
     { page: 2, left: 0, top: 310, right: 200, bottom: 610 }]
  );
  ok(two.length === 2 && two[0].page === 1 && two[1].page === 2,
    '跨页矩形 → 拆成两条页内矩形');
  ok(S.mapRects(null, pages).length === 0 && S.mapRects([], null).length === 0,
    '缺参数 → 空数组');
})();

console.log('\n[5] SelBand.canPaint：不该画的时候一律不画');
(() => {
  ok(S.canPaint('select', 1, false) === true, 'select + 有效选区 → 画');
  ok(S.canPaint('area', 1, false) === false, '框选工具 → 不画');
  ok(S.canPaint('note', 1, false) === false, '锚点工具 → 不画');
  ok(S.canPaint('select', 0, false) === false, '无 range → 不画');
  ok(S.canPaint('select', 1, true) === false, '折叠选区 → 不画');
})();

console.log('\n[6] 条带不再横向裁剪（v3.23 回退了 v3.22 的 clipToBand）');
(() => {
  ok(S.clipToBand === undefined,
    'clipToBand 已删除（横向裁剪正是「像框选」的元凶）');
  const v = read('EaglePDFReader/js/viewer.js');
  ok(v.indexOf('clipToBand') < 0, 'viewer 不再调用横向裁剪');
  ok(v.indexOf('_liveRects') > 0, '改为逐文本节点取真实行矩形');
  ok(/U\.mergeLineRects\(/.test(v), '行矩形按行合并（同一行多 span 拼成一条）');
})();

console.log('\n[7] SelBand.isSuspicious：识别浏览器把选区吸附放大');
(() => {
  const band = { l: 100, t: 100, r: 140, b: 104 };
  ok(S.isSuspicious({ left: 100, top: 100, right: 900, bottom: 106 }, band, 14) === true,
    '轻微移动却横向吞掉整行 → 可疑');
  ok(S.isSuspicious({ left: 100, top: 100, right: 140, bottom: 260 }, band, 14) === true,
    '轻微移动却竖向吞掉整页 → 可疑');
  ok(S.isSuspicious({ left: 100, top: 60, right: 140, bottom: 104 }, band, 14) === true,
    '起点被吸到拖拽带上方 → 可疑');
  ok(S.isSuspicious({ left: 100, top: 100, right: 142, bottom: 106 }, band, 14) === false,
    '与拖拽带基本一致 → 正常，不修正');
  ok(S.isSuspicious({ left: 100, top: 100, right: 180, bottom: 132 }, band, 14) === false,
    '正常的双行拖选 → 不误判');
  ok(S.isSuspicious(null, band, 14) === false, '缺选区 → 不修正');
  ok(S.isSuspicious({ left: 0, top: 0, right: 10, bottom: 10 }, null, 14) === false,
    '缺拖拽带 → 不修正');
})();

console.log('\n[8] SelBand.pickCaret：按指针重钉结束点');
(() => {
  const mk = (text, left, top, right, bottom) => ({ node: { nodeValue: text }, left, top, right, bottom });
  const nodes = [
    mk('AAAA', 100, 100, 140, 114),
    mk('BBBB', 100, 130, 140, 144)
  ];
  const a = S.pickCaret(nodes, 120, 107);
  ok(a && a.node === nodes[0].node, '竖直距离优先，命中第一行');
  ok(a && a.offset === 2, '水平位置换算成字符偏移（40px 宽，中点 → 2）');
  const b = S.pickCaret(nodes, 138, 137);
  ok(b && b.node === nodes[1].node && b.offset === 4, '第二行靠右 → 偏移接近 4');
  const c = S.pickCaret(nodes, 105, 134);
  ok(c && c.node === nodes[1].node,
    '水平更靠近第一行时，仍按竖直距离命中第二行（不跨行挑错）');
  ok(S.pickCaret([], 1, 1) === null, '空候选 → null');
  ok(S.pickCaret(null, 1, 1) === null, 'null 候选 → null');
  const zero = S.pickCaret([mk('XY', 10, 10, 10, 20)], 10, 15);
  ok(zero && zero.offset === 2, '零宽节点 → 取末尾');
  const clamped = S.pickCaret([mk('XY', 0, 0, 10, 10)], 999, 5);
  ok(clamped && clamped.offset === 2, '超出右边界 → 偏移被夹到长度内');
})();

console.log('\n[9] RunGate 回归：v3.22 没碰坏工作台直达逻辑');
(() => {
  ok(R.verdict({ launcher: true, hasDoc: true, touched: true }) === 'workbench', '启动器 → workbench');
  ok(R.verdict({ launcher: false, hasDoc: false, touched: false }) === 'ignore', '建窗伪触发 → ignore');
  ok(R.verdict({ launcher: false, hasDoc: true, touched: false }) === 'open-selected', '有文档 → open-selected');
})();

console.log('\n[10] 接线静态断言');
(() => {
  const html = read('EaglePDFReader/index.html');
  const app = read('EaglePDFReader/js/app.js');
  const viewer = read('EaglePDFReader/js/viewer.js');
  const css = read('EaglePDFReader/css/viewer.css');

  ok(html.indexOf('js/escguard.js') > -1 && html.indexOf('js/escguard.js') < html.indexOf('js/app.js'),
    'escguard.js 在 app.js 之前加载');
  ok(html.indexOf('js/selband.js') > -1 && html.indexOf('js/selband.js') < html.indexOf('js/viewer.js'),
    'selband.js 在 viewer.js 之前加载');

  ok(/escapeAction\(env\)/.test(app), 'app.js 接入 ESC 动作判定');
  /* v3.28：关窗改走主进程 IPC —— eagle.window 没有 close，window.close() 会被静默拒绝 */
  ok(app.indexOf('Bridge.closeSelf') > -1 && app.indexOf('Bridge.destroySelf') > -1,
    'app.js 用主进程 IPC 关窗（close 不行就 destroy）');
  ok(/launcher:\s*!!\(Bridge\.state\.query/.test(app),
    '仍把 launcher 形态传给判定（但 v3.31 起不再据此退窗）');
  ok(app.indexOf('window.close()') > -1, 'app.js 用 window.close() 关独立预览/启动器窗口');
  ok(app.indexOf('viewer.paintSelection(info)') > -1, 'mouseup 后用精确行矩形定稿条带');
  ok(app.indexOf('clearSelBand()') > -1, '滚动 / 塌陷时收掉条带');

  ok(viewer.indexOf('selBandLayer') > -1, 'viewer.js 建了条带层');
  ok(viewer.indexOf('_clampSelection()') > -1, 'viewer.js 接入吸附修正');
  ok(viewer.indexOf('_paintLiveBand') > -1, '拖选中实时画条带');
  ok(viewer.indexOf('pickCaret') > -1, '按指针重钉结束点');

  /* v3.23：ESC 不再可能「按了没反应」 */
  ok(app.indexOf('pruneEscLayers()') > -1, 'app.js 每次 ESC 前做栈体检');
  ok(app.indexOf('Esc.prune') > -1 || app.indexOf('Esc.prune(') > -1, '调用 Esc.prune 清理失效层');
  /* v3.31：ESC 分支里不能出现任何 exitPlugin() 调用 —— 它就是把 Eagle 一起关掉的出口 */
  ok(!/if \(act === 'pop-layer'\)[\s\S]{0,1200}?exitPlugin\(\)/.test(app),
    'ESC 各个分支之后都不再有 exitPlugin()');
  ok(/setTimeout\(\(\) => \{\s*\n\s*if \(!alive\(\)\) return;\s*\n\s*try \{ if \(Bridge\.destroySelf\)/.test(app),
    '400ms 后还活着就 destroy（close 被拦住时的兜底）');
  ok(app.indexOf('window.close()') > -1 && app.indexOf('Bridge.closeSelf') > -1,
    'IPC 关窗与标准 window.close 同时尝试');
  ok(app.indexOf('document.visibilityState') === -1,
    '不再用 visibilityState 判断「已关掉」（隐藏 ≠ 关闭，会把失败的关闭当成成功）');
  ok(/if \(act === 'blur'\)/.test(app) && /preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(app),
    'ESC 各分支统一接管，不漏给 Eagle');

  /* v3.24：退出路径上不再有会自我循环的确认框 */
  ok(app.indexOf("'不保存，直接退出'") === -1,
    '退出时不再弹「未保存」确认框（它是 ESC 弹框→关框→再弹框的死循环源头）');
  ok(/function flushDrafts\(\)/.test(app), '退出前改为静默落盘 flushDrafts()');
  ok(/async function exitPlugin\(\)[\s\S]{0,300}?flushDrafts\(\);/.test(app),
    'exitPlugin 先保存草稿，不再 await 任何对话框');
  ok(app.indexOf('escExitHint') > -1, '无层可关时给一句「退出请按 Ctrl+W」，不关窗口');
  ok(app.indexOf('ESC_VISIBLE_CLOSERS') > -1, '按真实可见性兜底关浮层');
  ok(app.indexOf('escFsPassed') > -1, '全屏状态只让一次，不会永久吞掉 ESC');
  ok(/window\.addEventListener\('keydown'/.test(app) && app.indexOf('__escSeen') > -1,
    'keydown 同时挂在 window 捕获阶段并去重（焦点在原生控件里也不丢）');
  ok(app.indexOf('e.isComposing') > -1, '输入法选词中的 ESC 交给输入法');

  /* v3.25：栈体检补齐工作台 / 知识库 / 回收站；签名去掉 activeElement */
  ok(/workbench:\s*\(\)\s*=>/.test(app) && /kb:\s*\(\)\s*=>/.test(app) && /trash:\s*\(\)\s*=>/.test(app),
    'ESC_LAYER_ALIVE 补上工作台 / 知识库 / 回收站（它们的残留层是「按了没反应」的来源）');
  ok(!/function escUiSig\(\)/.test(app),
    'escUiSig 与「空转强退」一起删除（它只为强退服务）');
  ok(app.indexOf('eaglePicker') > -1 && app.indexOf("'pickPicker'") === -1,
    '浮层 id 用真实存在的 eaglePicker');
  ok(app.indexOf("'kbOverlay'") > -1 && app.indexOf("'trashOverlay'") > -1,
    '覆盖层 id 用真实存在的 kbOverlay / trashOverlay');
  ok(app.indexOf('escStall') === -1, '「连续无进展计数」整段删除（它只为强退服务）');
  ok(/keyup[\s\S]{0,300}Escape/.test(app), 'keyup 对 ESC 做兜底（keydown 被原生控件吞掉时仍能退出）');

  /* v3.25：三个「并笔记」入口统一 */
  ok(/NOTE_TITLE = \{ text: '摘录并笔记', area: '框选并笔记', note: '锚点并笔记' \}/.test(app),
    '三种来源的标题分别是 摘录 / 框选 / 锚点 并笔记');
  ok(/NOTE_TITLE_HINT = \{ text: '摘录笔记', area: '框选笔记', note: '锚点笔记' \}/.test(app),
    '副标题按类型区分');
  ok(/handleAreaRect[\s\S]{0,4200}openComposer\('ann', ann\.id, 'modal'/.test(app),
    '框选后弹的是同一个大笔记框，不再是独立小浮层');
  ok(!/handleAreaRect[\s\S]{0,400}openPopover/.test(app), '框选不再走 openPopover');

  /* v3.25：字幕头部不换行、多选时收起精修 / 语境 */
  const cssApp = read('EaglePDFReader/css/app.css');
  const sub = read('EaglePDFReader/js/subtitle.js');
  ok(/\.sub-tools\s*\{[\s\S]{0,400}flex-wrap:\s*wrap/.test(cssApp), '字幕工具行样式存在（v4.1 .sub-tools）');
  ok(/\.sub-name\s*\{[\s\S]{0,300}text-overflow:\s*ellipsis/.test(cssApp), '标题过窄时省略而不是折行');
  ok(/\.sub-tools\.picking \.sub-fix\s*\{\s*display:\s*none/.test(cssApp), '多选时收起精修 / 语境腾位置');
  ok(sub.indexOf("classList.toggle('picking'") > -1, '多选状态同步到头部（picking 类）');
  ok(sub.indexOf("'(' + n + ')'") > -1, '计数用半角括号，宽度更省');

  /* v3.25：年度活动按月分行 */
  const wb = read('EaglePDFReader/js/workbench.js');
  ok(wb.indexOf('wb-heat-row') > -1 && wb.indexOf('wb-heat-m') > -1, '热力图按月分行并带月份标签');
  ok(/new Date\(year, m \+ 1, 0\)\.getDate\(\)/.test(wb), '按月份取真实天数（2 月不会画出 30 日）');
  ok(/\.wb-heat-row\s*\{[\s\S]{0,200}repeat\(31, 1fr\)/.test(cssApp), '每行 31 列对应 1..31 日');

  ok(css.indexOf('.selBandLayer') > -1 && css.indexOf('.sel-band') > -1, 'CSS 定义了条带样式');
  ok(/\.textLayer\s+::selection[^}]*background:\s*transparent/.test(css),
    '原生 ::selection 已透明（蓝色闪烁的根因）');
  ok(/user-select:\s*none/.test(css) && /\.textLayer span \{\s*user-select: text/.test(css),
    '仍保留「层不可选、仅 span 可选」的 v3.21 防护');

  const m = JSON.parse(read('EaglePDFReader/manifest.json'));
  const w = JSON.parse(read('EagleNoteWorkbench/manifest.json'));
  ok(/^\d+\.\d+\.\d+$/.test(m.version), '主插件三段式版本号，实际 ' + m.version);
  ok(/^\d+\.\d+\.\d+$/.test(w.version), '启动器三段式版本号，实际 ' + w.version);
  ok(!!m.preview && !w.preview, '主插件保留 preview、启动器无 preview（可置顶的必要条件）');
  ok(w.main.frame === false, '启动器无边框，自绘深色标题栏');
})();

console.log('\n[11] viewer 接线沙箱：逐行条带 + 吸附修正');
(() => {
  const src = read('EaglePDFReader/js/viewer.js');
  const L = { document: {}, window: {} };
  const fakeDoc = {
    addEventListener(t, fn) { (L.document[t] ||= []).push(fn); },
    removeEventListener() {},
    createTreeWalker(root) {
      const list = root._nodes || []; let i = -1;
      return { nextNode() { i++; return i < list.length ? list[i] : null; } };
    },
    createRange() {
      return {
        _node: null,
        collapsed: false,
        selectNodeContents(n) { this._node = n; return this; },
        getBoundingClientRect() {
          return (this._node && this._node._rect) ||
            { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        },
        getClientRects() {
          const rc = this.getBoundingClientRect();
          return (rc.width || rc.height) ? [rc] : [];
        },
        setStart() { this.collapsed = false; },
        setEnd() { this.collapsed = false; }
      };
    }
  };
  const fakeWin = {
    addEventListener(t, fn) { (L.window[t] ||= []).push(fn); },
    removeEventListener() {}
  };
  const U = {
    rafThrottle: (f) => f, debounce: (f) => f,
    el: () => ({ style: {}, remove() {} }),
    clamp: (v) => v, clamp01: (v) => v,
    mergeLineRects: (rects, tol) => {
      /* 与 utils.mergeLineRects 同语义的最小实现：按 top 分行、行内按间隙合并 */
      const list = rects.filter((r) => r.width > 0.4 && r.height > 0.4)
        .slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
      const rows = [];
      for (const r of list) {
        const row = rows.find((q) => Math.abs(q.top - r.top) < 8);
        if (row) row.parts.push(r); else rows.push({ top: r.top, parts: [r] });
      }
      const out = [];
      for (const row of rows) {
        row.parts.sort((a, b) => a.left - b.left);
        let cur = null;
        for (const r of row.parts) {
          if (!cur) { cur = { left: r.left, right: r.left + r.width, top: r.top, height: r.height }; continue; }
          if (r.left - cur.right <= (tol || 6)) {
            cur.right = Math.max(cur.right, r.left + r.width);
          } else {
            out.push({ left: cur.left, top: cur.top, width: cur.right - cur.left, height: cur.height });
            cur = { left: r.left, right: r.left + r.width, top: r.top, height: r.height };
          }
        }
        if (cur) out.push({ left: cur.left, top: cur.top, width: cur.right - cur.left, height: cur.height });
      }
      return out;
    }
  };
  const V = new Function('document', 'window', 'U', 'NodeFilter',
    src + '\nreturn PdfViewer;')(fakeDoc, fakeWin, U, { SHOW_TEXT: 4 });

  /* 两行文字：每行一个文本节点，行宽 200，行高 14，行距 30 */
  const nodes = [
    { nodeValue: 'AAAA', _rect: { left: 100, top: 100, right: 300, bottom: 114, width: 200, height: 14 } },
    { nodeValue: 'BBBB', _rect: { left: 100, top: 130, right: 300, bottom: 144, width: 200, height: 14 } }
  ];
  const pageEl = {
    offsetWidth: 600, offsetHeight: 800,
    dataset: { page: '1' },
    getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }; },
    querySelector(sel) {
      if (sel === '.selBandLayer') return { appendChild() {} };
      return { firstChild: true, _nodes: nodes };
    }
  };
  const inst = Object.create(V.prototype);
  inst.pageEls = [pageEl];
  inst.intersecting = new Set([1]);
  inst.current = 1;
  inst.tool = 'select';
  inst._bandEls = [];
  inst._selecting = true;
  inst._dragBand = { l: 100, t: 100, r: 300, b: 134, x: 200, y: 134, lineH: 14 };

  function mkRange(rect) {
    return {
      _rect: rect, collapsed: false, endNode: null, endOffset: -1,
      startContainer: null, endContainer: null, startOffset: 0, endOffset2: 0,
      cloneRange() { return mkRange(this._rect); },
      getBoundingClientRect() { return this._rect; },
      getClientRects() { return [this._rect]; },
      intersectsNode() { return true; },
      setEnd(n, o) { this.endNode = n; this.endOffset = o; }
    };
  }
  const selObj = {
    rangeCount: 0, isCollapsed: true, ranges: [],
    _anchor: null, _focus: null,
    getRangeAt(i) { return this.ranges[i]; },
    removeAllRanges() { this.ranges = []; this.rangeCount = 0; this.isCollapsed = true; },
    addRange(r) { this.ranges = [r]; this.rangeCount = 1; this.isCollapsed = !!r.collapsed; },
    /* v3.28：吸附修正改成 collapse + extend（能自己处理拖拽方向） */
    collapse(n, o) { this._anchor = { node: n, offset: o }; this.ranges = []; this.rangeCount = 0; this.isCollapsed = true; },
    extend(n, o) {
      this._focus = { node: n, offset: o };
      const r = mkRange({ left: 100, top: 100, right: 142, bottom: 106, width: 42, height: 6 });
      r.startContainer = this._anchor ? this._anchor.node : null;
      r.startOffset = this._anchor ? this._anchor.offset : 0;
      r.endNode = n; r.endOffset = o;
      this.ranges = [r]; this.rangeCount = 1; this.isCollapsed = false;
    }
  };
  fakeWin.SelBand = S;
  fakeWin.getSelection = () => selObj;

  /* A. 底层选区被放大 → 结束点被钉回指针所在文本节点（指针停在第一行） */
  inst._dragBand = { l: 100, t: 100, r: 300, b: 110, x: 200, y: 104, lineH: 14 };
  selObj.removeAllRanges();
  selObj.addRange(mkRange({ left: 100, top: 100, right: 580, bottom: 112, width: 480, height: 12 }));
  inst._downCaret = { node: nodes[0], offset: 0 };   // 按下点最近的字（mousedown 时算好）
  ok(inst._clampSelection() === true, '包围盒远超拖拽带 → 触发吸附修正');
  ok(selObj._focus && selObj._focus.node === nodes[0] && selObj._focus.offset === 2,
    '结束点重新钉到第一行的第 2 个字符（摘录/翻译不再拿到整页）');
  ok(selObj._anchor && selObj._anchor.node === nodes[0] && selObj._anchor.offset === 0,
    '起点也钉回按下点（不再被浏览器吸附到整段开头）');

  /* B. 正常拖选不修正，不破坏用户真实意图 */
  const normal = mkRange({ left: 100, top: 100, right: 142, bottom: 106, width: 42, height: 6 });
  selObj.removeAllRanges(); selObj.addRange(normal);
  ok(inst._clampSelection() === false, '选区与拖拽带一致 → 不修正');
  ok(selObj.ranges[0] === normal, '正常选区原样保留');

  /* C. 从上往下拖：两行各自整行成条，不被横向截断 */
  inst._dragBand = { l: 100, t: 100, r: 300, b: 144, x: 200, y: 144, lineH: 14 };
  inst._invalidateDragNodes();
  selObj.removeAllRanges();
  selObj.addRange(mkRange({ left: 100, top: 100, right: 300, bottom: 144, width: 200, height: 44 }));
  inst._bandEls = [];
  inst._paintLiveBand();
  ok(inst._bandEls.length === 2, '两行 → 两条条带（不是一个大方框）');
  ok(inst._bandEls[0].style.width === '200px' && inst._bandEls[1].style.width === '200px',
    '每行保留完整行宽（v3.22 的横向裁剪已移除）');
  ok(inst._bandEls[0].style.height === '14px', '条带高度贴合行高');
  ok(inst._bandEls[0].style.top === '100px' && inst._bandEls[1].style.top === '130px',
    '两条条带各自落在自己的行上');

  /* D. 选区塌陷 → 条带清空 */
  inst.clearSelBand();
  ok(inst._bandEls.length === 0, 'clearSelBand 清空所有条带节点');
  selObj.removeAllRanges();
  inst._paintLiveBand();
  ok(inst._bandEls.length === 0, '无选区时不画条带');
})();

console.log('\n────────────────────────────────');
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('────────────────────────────────');
process.exit(fail ? 1 : 0);
