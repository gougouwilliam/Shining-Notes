/* v4.3.1 回归：Eagle 注释巡检
   ─────────────────────────────────
   背景：Eagle 注释三层存储（内存 / library-caches 缓存 / 磁盘 metadata.json）。
   插件正常读写走官方 API，三层自动同步；但索引清空后的注释残留插件够不着
   （clearAllData 依赖索引定位）。本版本在工作台加「Eagle 注释巡检…」：
   全库扫描 → 标记格式判定 → 官方 API 清空，不依赖索引。
   ① index.html：btnWbAnnScan 按钮
   ② app.js：annMarkedOurs（行首标记判定）+ annInspectAll（扫描/复核/确认/清空/报告）
   ③ 行为沙箱：判定函数对真实样本（含手写注释）的分类
   ④ 行为沙箱：annInspectAll 全流程（桩 Bridge/U/confirmDialog）
   ⑤ 版本联动：两包 manifest 4.3.1 一致，README / FEATURES 更新 */
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const A = R('EaglePDFReader/js/app.js');
const H = R('EaglePDFReader/index.html');
const M1 = JSON.parse(R('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(R('EagleNoteWorkbench/manifest.json'));
const RD = R('EaglePDFReader/README.md');
const FT = R('FEATURES.md');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL - ' + msg); }
}
const has = (s, k) => s.indexOf(k) >= 0;

console.log('—— ① index.html：巡检按钮 ——');
ok(has(H, 'id="btnWbAnnScan"'), '工作台有「Eagle 注释巡检…」按钮');
ok(/btnWbAnnScan"[^>]*title="[^"]*官方 ?API/.test(H.replace(/\r/g, '')), '按钮 title 讲清走官方 API（三层同步）');

console.log('—— ② app.js：结构与守卫 ——');
ok(has(A, 'function annMarkedOurs('), 'annMarkedOurs 判定函数已定义');
ok(/\/\^【\(摘录\|截图\|框选\|片段\|打点\|字幕\|笔记\|锚点\) · \//.test(A), '标记正则：行首 8 种标记 + 「 · 」格式（手写字几乎不可能撞上）');
ok(has(A, 'async function annInspectAll()'), 'annInspectAll 已定义');
ok(has(A, "on('#btnWbAnnScan', 'click', annInspectAll)"), '按钮已绑定');
ok(/hasEagle[\s\S]{0,80}注释巡检不可用/.test(A.replace(/\r/g, '')), '非 Eagle 环境守卫（提示后返回）');
ok(/Bridge\.getAllItems\(\['id', 'name', 'annotation'\]\)/.test(A), '全库扫描走 Bridge.getAllItems（不依赖插件索引）');
ok(/逐条 \+? ?getAnnotation 复核|复核：item\.get 拿到的 annotation 可能是批量快照/.test(A.replace(/\r/g, '')), '批量命中后逐条 getAnnotation 复核（防快照不新鲜）');
ok(/if \(annMarkedOurs\(cur\)\) confirmed\.push/.test(A), '复核仍用标记判定，双保险');
ok(has(A, 'confirmDialog(\'Eagle 注释巡检\''), '执行前确认框列出命中条目');
ok(/官方 ?API 清空[\s\S]{0,60}三层自动同步/.test(A.replace(/\r/g, '')), '确认框说明官方 API / 三层同步');
ok(/Bridge\.setAnnotation\(c\.id, ''\)/.test(A), '清空走 Bridge.setAnnotation 官方 API（自带读回核对+重试）');
ok(/清空 ' \+ ok \+ ' 条'/.test(A) && /失败 ' \+ fail \+ ' 条/.test(A), '完成报告含扫描数/清空数/失败数');
ok(/手打的注释不受影响|手打的注释一行都不碰/.test(A.replace(/\r/g, '')), '明确「手写注释不动」口径');
ok(has(A, 'annInspectAll') && !has(A, 'fs.readFileSync'), '巡检不直接读库文件（文件层手术禁令）');

console.log('—— ③ 行为沙箱：annMarkedOurs 对真实样本 ——');
(async () => {
{
  const body = /function annMarkedOurs\(a\) \{([\s\S]*?)\n  \}/.exec(A);
  ok(!!body, '能提取 annMarkedOurs 函数体');
  if (body) {
    const f = new Function('a', body[1] + '; return annMarkedOurs(a);');
    // 插件写入的真实样本（今天清理过的 ANGEL-TNK 条目摘头）
    ok(f('【摘录 · 第 2 页】在 253名入组患者\n笔记：daffodilad dfljie %%++\n\n【笔记 · 独立笔记】方法是大大') === true, '插件标记注释（摘录+笔记混合）→ 判 ours');
    ok(f('【笔记 · 独立笔记】da\n\n【笔记 · 独立笔记】cac') === true, '纯独立笔记标记 → 判 ours');
    ok(f('【截图 · 第 3 页】.\n【片段 · 00:12:03】.') === true, '截图/片段/打点标记 → 判 ours');
    ok(f('【锚点 · p2】.') === true, '锚点标记 → 判 ours');
    // 用户手写注释（今天特意保留的）
    ok(f('甲状旁腺显影') === false, '手写短备注 → 不判 ours');
    ok(f('硬性内窥镜') === false, '手写短备注 2 → 不判 ours');
    ok(f('上海市第一人民医院泌尿外科毕海主任在ERBT术式试用了方犁环') === false, '手写长业务记录 → 不判 ours');
    ok(f('这是【摘录】格式的普通文字') === false, '行中含【摘录】但非行首「 · 」格式 → 不判 ours');
    ok(f('【笔记】随手写的方括号') === false, '行首【笔记】但无「 · 」→ 不判 ours');
    ok(f('') === false && f(null) === false, '空/null → 不判 ours');
  }
}

console.log('—— ④ 行为沙箱：annInspectAll 全流程 ——');
{
  const body = /async function annInspectAll\(\) \{([\s\S]*?)\n  \}/.exec(A);
  ok(!!body, '能提取 annInspectAll 函数体');
  if (body) {
    let src = body[1]
      .replace(/async function annInspectAll\(\) \{/, '');
    // 桩：Bridge / U / confirmDialog（annMarkedOurs 从源码原样注入，测的是真实现）
    const markBody = /function annMarkedOurs\(a\) \{([\s\S]*?)\n  \}/.exec(A);
    const markSrc = markBody ? ('function annMarkedOurs(a) {' + markBody[1] + '}') : 'function annMarkedOurs(a){return false;}';
    const S = { scanned: 0, cleared: [], toasts: [], confirmCalls: 0 };
    const sandbox = markSrc + '\n' + `
      const Bridge = {
        get hasEagle() { return __eagle; },
        getAllItems: async (fields) => { S.scanned++; return __items; },
        getAnnotation: async (id) => {
          const it = __items.find((x) => x.id === id);
          return it ? it.annotation : '';
        },
        setAnnotation: async (id, t) => { S.cleared.push(id); return t; }
      };
      const U = { toast: (m, t, ms) => { S.toasts.push(m); } };
      const confirmDialog = async (title, text, actions) => { S.confirmCalls++; return __answer; };
    `;
    const run = async (env) => {
      S.scanned = 0; S.cleared = []; S.toasts = []; S.confirmCalls = 0;
      const fn = new Function('__eagle', '__items', 'S', '__answer',
        sandbox + '\nreturn (async () => { ' + src + ' })();');
      return await fn(env.eagle, env.items, S, env.answer || 'ok');
    };

    // 场景1：非 Eagle 环境
    await run({ eagle: false, items: [] });
    ok(S.toasts.some((t) => /巡检不可用/.test(t)) && S.confirmCalls === 0, '非 Eagle 环境：提示并返回，不弹确认框');

    // 场景2：全库干净
    await run({ eagle: true, items: [
      { id: 'A1', name: '手写条目', annotation: '硬性内窥镜' },
      { id: 'A2', name: '空注释', annotation: '' }
    ] });
    ok(S.toasts.some((t) => /没有插件标记的注释残留/.test(t)), '全库干净：报告无残留');
    ok(S.confirmCalls === 0 && S.cleared.length === 0, '无残留时不弹确认框、不写任何条目');

    // 场景3：有残留 + 用户确认 → 逐条清空
    await run({ eagle: true, items: [
      { id: 'B1', name: 'ANGEL-TNK', annotation: '【摘录 · 第 2 页】在 253名\n【笔记 · 独立笔记】da' },
      { id: 'B2', name: '手写保留', annotation: '甲状旁腺显影' },
      { id: 'B3', name: '插件笔记', annotation: '【笔记 · 独立笔记】cac' }
    ], answer: 'ok' });
    ok(S.cleared.length === 2 && S.cleared.includes('B1') && S.cleared.includes('B3'), '确认后只清标记条目（B1/B3），手写 B2 不动');
    ok(S.confirmCalls === 1, '执行前弹了一次确认框');
    ok(S.toasts.some((t) => /扫描 3 条/.test(t) && /清空 2 条/.test(t)), '完成报告：扫描 3 条、清空 2 条');

    // 场景4：有残留 + 用户取消 → 不清
    await run({ eagle: true, items: [
      { id: 'C1', name: '插件笔记', annotation: '【笔记 · 独立笔记】cac' }
    ], answer: 'cancel' });
    ok(S.cleared.length === 0 && S.confirmCalls === 1, '用户取消：不写任何条目');
  }
}

console.log('—— ⑤ 版本联动与文档 ——');
ok(/^\d+\.\d+\.\d+$/.test(M1.version) && M1.version === M2.version,
  '两包 manifest 版本一致且三段式：' + M1.version + ' / ' + M2.version);
ok(/^\d+\.\d+\.\d+$/.test(M1.version), '版本号三段式（随版本推进不追改）：' + M1.version);
ok(/^\d+\.\d+\.\d+$/.test(M2.version) && M1.version === M2.version, '两包 manifest 版本一致');
ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(RD), 'README 当前版本为三段式');
ok(has(RD, '## 更新记录 · 4.3.1（Eagle 注释巡检）'), 'README 更新记录有 4.3.1 小节');
ok(has(RD, 'library-caches'), '更新记录讲清了三层存储背景（缓存层）');
ok(has(FT, 'Eagle 注释巡检'), 'FEATURES.md 已收录巡检功能');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('沙箱异常:', e); process.exit(1); });
