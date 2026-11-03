/* v3.41.0 回归：AI 总结双通道（本地 Ollama + 自定义 OpenAI 兼容接口）+ Markdown 呈现
 *
 * v3.41 变更：Kimi 网页壳（kimiweb.js）与 Kimi API 通道整体下线；
 * AI 回复改为 Markdown 渲染呈现（流式节流），入库保存原始 Markdown 文本。
 *
 * 覆盖：
 *   1. 配置：默认双通道、旧配置迁移（provider kimi/kimiweb → local、残留字段清理）
 *   2. 预算：local / openai；provLabel
 *   3. openaiChat：假 fetch 喂 SSE（delta 拼接、[DONE]、缺 key 报错）
 *   4. 本地兜底：openai 失败 → 本地接管；local 失败直接抛；根因优先
 *   5. Markdown 渲染：markdown.js 标题/列表/表格/代码块；流式节流策略（纯函数侧验证 noteMd 保存原文）
 *   6. 静态挂接：kimiweb.js 已删除且不再挂载、版本号
 *
 * 运行：node test-v341.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n— ' + t + ' —'); }

const ROOT = path.join(__dirname, 'EaglePDFReader');

/* ---------- 沙箱 ---------- */
function memStore() {
  const m = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}

function baseSandbox(extra) {
  const sb = {
    console, Date, JSON, Math, setTimeout, clearTimeout,
    Event,
    TextDecoder,
    KeyboardEvent: function KbEv(type, init) { this.type = type; Object.assign(this, init || {}); },
    localStorage: memStore(),
    fetch: () => Promise.reject(new Error('no fetch in this test')),
    window: {}
  };
  Object.assign(sb, extra || {});
  sb.global = sb;
  vm.createContext(sb);
  return sb;
}

function loadAiSummary(extra) {
  const code = fs.readFileSync(path.join(ROOT, 'js/aisummary.js'), 'utf8');
  const sb = baseSandbox(extra);
  vm.runInContext(code, sb, { filename: 'aisummary.js' });
  return { sb, A: sb.window.AiSummary };
}

function loadMarkdown(extra) {
  const sb = baseSandbox(extra);
  /* markdown.js 用到全局 U（utils.js）—— 只需 escapeHtml，用等价实现替代 */
  vm.runInContext('const U = { escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };', sb);
  const code = fs.readFileSync(path.join(ROOT, 'js/markdown.js'), 'utf8');
  vm.runInContext(code, sb, { filename: 'markdown.js' });
  /* const 声明不进 sandbox 对象（词法全局）—— 显式取一次引用供断言用 */
  const MD = vm.runInContext('Markdown', sb);
  return { sb, MD };
}

function loadAiSummaryWithMd(extra) {
  /* 同一沙箱先载 markdown.js 再载 aisummary.js —— 复现浏览器加载顺序，
     验证 aisummary 能通过词法全局拿到 Markdown（window.Markdown 不存在）。 */
  const sb = baseSandbox(extra);
  vm.runInContext('const U = { escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };', sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/markdown.js'), 'utf8'), sb, { filename: 'markdown.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/aisummary.js'), 'utf8'), sb, { filename: 'aisummary.js' });
  return { sb, MD: vm.runInContext('Markdown', sb), A: sb.window.AiSummary };
}

(async () => {

/* ===== 1. 配置与迁移 ===== */
section('配置默认值与旧配置迁移');
{
  const r1 = loadAiSummary();
  const A = r1.A;
  ok(!!A, 'aisummary.js 仍可加载');
  ok(A.cfg.oaiBase.indexOf('open.bigmodel.cn') > 0, '自定义接口默认预填智谱（免费档）');
  ok(A.cfg.oaiModel === 'glm-4-flash', '默认模型 glm-4-flash（免费不限量）');
  ok(A.cfg.budgetOai === 22000 && A.cfg.budgetLocal === 9000, '两条预算默认值就位');
  ok(A.cfg.kimiKey === undefined && A.cfg.kimiModel === undefined, '默认配置不再含 kimi 字段');
}
{
  /* localStorage 里存过已下线 provider → 回退 local；残留字段清掉 */
  const r1 = loadAiSummary({
    localStorage: (() => {
      const st = memStore();
      st.setItem('eaglenote.aisum.cfg', JSON.stringify({
        provider: 'kimiweb', kimiKey: 'sk-old', kimiModel: 'moonshot-v1-8k',
        budgetKimiWeb: 60000, oaiKey: 'sk-keep', localModel: 'qwen2.5'
      }));
      return st;
    })()
  });
  const A = r1.A;
  ok(A.cfg.provider === 'local', '旧配置 provider=kimiweb → 自动回退 local（弹窗不失效）');
  ok(A.cfg.oaiKey === 'sk-keep' && A.cfg.localModel === 'qwen2.5', '其它配置字段原样保留');
  ok(A.cfg.kimiKey === undefined && A.cfg.budgetKimiWeb === undefined, '已下线通道的残留字段被清理');
}
{
  const r1 = loadAiSummary({
    localStorage: (() => {
      const st = memStore();
      st.setItem('eaglenote.aisum.cfg', JSON.stringify({ provider: 'kimi', kimiKey: 'x' }));
      return st;
    })()
  });
  ok(r1.A.cfg.provider === 'local', '旧配置 provider=kimi → 同样回退 local');
}

/* ===== 2. 预算与标签 ===== */
section('预算与通道标签');
const r2 = loadAiSummary();
const A = r2.A;
A.setCfg({ provider: 'openai' });
ok(A.budgetChars() === 22000, 'openai 通道预算 22000');
A.setCfg({ provider: 'local' });
ok(A.budgetChars() === 9000, 'local 预算 9000（回归）');
ok(A._provLabel() === '本地模型', 'provLabel: local');
A.setCfg({ provider: 'openai' });
ok(A._provLabel() === '自定义接口', 'provLabel: openai');
A.setCfg({ provider: 'local' });

/* ===== 3. openaiChat（假 fetch，SSE 全链路） ===== */
section('openaiChat（假 fetch，SSE 全链路）');
async function sseFetch(url, opt) {
  const enc = new TextEncoder();
  const lines = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',
    '\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n',
    'data: [DONE]\n',
    ''
  ];
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => (lines.length ? { done: false, value: enc.encode(lines.shift()) } : { done: true }) }) }
  };
}
{
  const r3 = loadAiSummary({ fetch: sseFetch });
  let got = '';
  await r3.A._openaiChat('https://x.example/chat', 'sk-test', 'm-1', '测试通道',
    [{ role: 'user', content: 'hi' }], { onToken: (t) => { got += t; } });
  ok(got === '你好', 'delta 按序拼接，[DONE] 收尾');
}
{
  const r3 = loadAiSummary({});
  let err = null;
  try { await r3.A._openaiChat('https://x.example', '', 'm', '测试通道', [], { onToken() {} }); }
  catch (e) { err = e; }
  ok(err && err.message.indexOf('还没填') === 0 && err.message.indexOf('测试通道') > 0, '缺 key 报错带通道名');
}
{
  const captured = {};
  const r3 = loadAiSummary({
    fetch: async (url, opt) => {
      captured.url = url; captured.body = JSON.parse(opt.body);
      captured.auth = opt.headers.Authorization;
      return sseFetch(url, opt);
    }
  });
  r3.A.setCfg({ oaiKey: 'sk-oai', oaiModel: 'glm-4-flash', oaiBase: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' });
  await r3.A._openaiProviderChat([{ role: 'user', content: 'hi' }], { onToken() {} });
  ok(captured.url.indexOf('open.bigmodel.cn') > 0, 'openaiProviderChat 用 cfg.oaiBase');
  ok(captured.body.model === 'glm-4-flash', '用 cfg.oaiModel');
  ok(captured.body.stream === true, '仍然流式');
  ok(captured.auth === 'Bearer ' + r3.A.cfg.oaiKey, 'Bearer 头来自 cfg.oaiKey');
}

/* ===== 4. 本地 Ollama 兜底 ===== */
section('chatCollectFB（本地兜底）');
ok(A._isAbort({ name: 'AbortError' }) === true && A._isAbort(new Error('x')) === false, 'isAbort 语义正确');

function ollamaFetch(chatLines) {
  const enc = new TextEncoder();
  return async (url, opt) => {
    const u = String(url);
    if (u.indexOf('/api/tags') >= 0) {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5' }] }) };
    }
    if (u.indexOf('/api/chat') >= 0) {
      const lines = chatLines.map((j) => JSON.stringify(j) + '\n');
      return { ok: true, body: { getReader: () => ({ read: async () => (lines.length ? { done: false, value: enc.encode(lines.shift()) } : { done: true }) }) } };
    }
    throw new Error('unexpected url ' + u);
  };
}

{
  /* openai 没填 key → 兜底走本地假 ollama */
  const r4 = loadAiSummary({ fetch: ollamaFetch([{ message: { content: '本' } }, { message: { content: '地' } }]) });
  r4.A.setCfg({ provider: 'openai', oaiKey: '' });
  const fbCalls = [];
  let out = '';
  const got = await r4.A._chatCollectFB(
    [{ role: 'user', content: 'hi' }],
    { onToken: (t) => { out += t; }, onFallback: (e) => fbCalls.push(e && e.message) }
  );
  ok(fbCalls.length === 1 && fbCalls[0].indexOf('API Key') > 0, '兜底前先通知原因（不静默换模型）');
  ok(got === '本地' && out === '本地', '失败后自动走本地 Ollama 并收齐流式结果');
  ok(r4.A.cfg.provider === 'openai', '兜底是会话级切换，结束后 provider 还原（不动用户设置）');
  ok(r4.A.cfg.oaiKey === '', 'localStorage 里 oaiKey 原样');
}
{
  /* local 通道不兜底：失败直接抛 */
  const r4 = loadAiSummary({ fetch: () => Promise.reject(new Error('conn refused')) });
  r4.A.setCfg({ provider: 'local' });
  const fbCalls = [];
  let err = null;
  try { await r4.A._chatCollectFB([{ role: 'user', content: 'hi' }], { onToken() {}, onFallback: (e) => fbCalls.push(1) }); }
  catch (e) { err = e; }
  ok(err && err.message.indexOf('Ollama 模型') > 0 && fbCalls.length === 0, '本地通道失败不兜底、直接抛本地诊断错误');
}
{
  /* 兜底通道也挂：抛原始错误（openai 缺 key），而不是本地错误 */
  const r4 = loadAiSummary({ fetch: () => Promise.reject(new Error('conn refused')) });
  r4.A.setCfg({ provider: 'openai', oaiKey: '' });
  let err = null;
  try { await r4.A._chatCollectFB([{ role: 'user', content: 'hi' }], { onToken() {}, onFallback() {} }); }
  catch (e) { err = e; }
  ok(err && err.message.indexOf('API Key') > 0, '本地也失败 → 抛原始错误（根因优先）');
}

/* ===== 5. Markdown 渲染 ===== */
section('Markdown 渲染（markdown.js）');
{
  const r5 = loadMarkdown();
  const MD = r5.MD;
  ok(!!MD && typeof MD.render === 'function', 'markdown.js 可加载');
  const html1 = MD.render('# 一句话总结\n\n## 核心要点\n\n- **要点一** P12\n- 要点二\n\n```js\nconst x = 1;\n```');
  ok(html1.indexOf('<h1>一句话总结</h1>') >= 0, '标题渲染为 h1');
  ok(html1.indexOf('<h2>核心要点</h2>') >= 0, '二级标题渲染');
  ok(html1.indexOf('<strong>要点一</strong>') >= 0, '加粗渲染');
  ok(html1.indexOf('<li>') >= 0 && html1.indexOf('<ul>') >= 0, '列表渲染');
  ok(html1.indexOf('<pre><code') >= 0 && html1.indexOf('const x = 1;') >= 0, '代码块渲染且内容保留');
  const html2 = MD.render('| 列A | 列B |\n|---|---|\n| 1 | 2 |');
  ok(html2.indexOf('<table>') >= 0 && html2.indexOf('<th>列A</th>') >= 0, '表格渲染');
  const html3 = MD.render('<script>alert(1)</script>');
  ok(html3.indexOf('<script>') < 0, '原始 HTML 被转义（安全）');
  ok(MD.plain('**加粗** 和 `code`').indexOf('**') < 0, 'plain() 剥掉 md 标记');
}
{
  /* noteMd：入库保存原始 Markdown（不做转换） */
  const md = A._noteMd('AI 总结', '# 一句话总结\n\n- **要点** P12');
  ok(md.indexOf('**AI 总结**') === 0, '入库带来源标记');
  ok(md.indexOf('# 一句话总结') > 0 && md.indexOf('**要点**') > 0, '正文保留原始 Markdown 文本（保存即 md）');
  ok(A._noteMd('AI 总结', '   ') === '', '空文本不入库');
}
{
  /* 关键回归：aisummary 在同沙箱（浏览器加载顺序）下必须拿到 Markdown 渲染器
     —— v3.40.3 之前 window.Markdown 恒为 null，AI 消息从未真正渲染过。 */
  const r5 = loadAiSummaryWithMd({ fetch: sseFetch });
  ok(r5.MD && typeof r5.MD.render === 'function', '同沙箱下 Markdown 词法全局可见');
  const out = r5.A._renderMd('## 小节\n\n- **加粗** 条目');
  ok(out.indexOf('<h2>小节</h2>') >= 0 && out.indexOf('<strong>加粗</strong>') >= 0,
    'A._renderMd 真的走 Markdown.render（不再退化为纯文本转义）');
  const esc = r5.A._renderMd('<img src=x onerror=alert(1)>');
  ok(esc.indexOf('<img') < 0, '渲染仍走转义，原始 HTML 不透传（安全）');
}

/* ===== 6. 静态挂接 ===== */
section('静态挂接与版本');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(html.indexOf('js/kimiweb.js') < 0, 'index.html 不再挂载 kimiweb.js');
ok(html.indexOf('js/aisummary.js') > 0, 'aisummary.js 仍挂载');
ok(!fs.existsSync(path.join(ROOT, 'js/kimiweb.js')), 'kimiweb.js 文件已删除');
const appjs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
ok(appjs.indexOf('getFilePath') < 0, 'app.js 不再注入 getFilePath（文件直传随网页壳下线）');
ok(appjs.indexOf('btnAiSummary') > 0, 'AI 总结按钮挂接保留');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'manifest 是合法三段式（版本无关）');
const cssText = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
ok(cssText.indexOf('.kimiweb-holder') < 0, 'CSS 里 kimiweb 面板样式已清理');
ok(cssText.indexOf('.ai-md table') > 0 && cssText.indexOf('.ai-md pre') > 0, 'AI 消息 Markdown 样式（表格/代码块）就位');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
ok(readme.indexOf('Kimi') < 0 || readme.indexOf('3.41') > 0, 'README 已更新到下线 Kimi 之后的版本');

/* ===== 12. 工作台 ESC 分流（v3.41.2：置顶栏场景 ESC = 返回资料库） ===== */
section('工作台 ESC 分流');
{
  const wbSrc = fs.readFileSync(path.join(ROOT, 'js/workbench.js'), 'utf8');
  ok(wbSrc.indexOf("Esc.push('workbench', escBack)") > 0, 'ESC 层注册的是 escBack（不再是纯收起的 close）');
  const mEsc = wbSrc.match(/function escBack\(\) \{([\s\S]*?)\n  \}/);
  ok(!!mEsc, 'escBack 函数存在');
  ok(mEsc && mEsc[1].indexOf('hasDocBehind()') > 0 && mEsc[1].indexOf('returnToLibrary()') > 0,
    'escBack：背后无文档 → returnToLibrary（关窗回资料库）');
  ok(mEsc && mEsc[1].indexOf('close()') > 0, 'escBack：背后有文档 → 只收起工作台（回到摘录笔记界面）');
  ok(wbSrc.indexOf('return { open, close, escBack') > 0, 'escBack 已导出（供 app.js 兜底列表用）');

  const appText = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  ok(appText.indexOf('Workbench.escBack || Workbench.close') > 0, 'ESC 兜底列表与 Esc 栈同语义');
  /* 打开文档的两处必须保持纯收起 —— 加载新文档不能顺手关窗 */
  const plain = (appText.match(/Workbench\.isOpen\(\)\) Workbench\.close\(\)/g) || []).length;
  ok(plain >= 2, '文档加载流程仍用纯收起 close()（' + plain + ' 处）');
}

console.log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
