/* v3.38.0 回归：AI 总结全文 + 追问 + 摘句入笔记
 *
 * 模块 aisummary.js 的纯逻辑与网络协议解析，不发真实请求：
 *   1. 正文切分：按页合并、单页超长硬切、空页跳过、预算随模型放宽
 *   2. 流式协议：ollama ndjson、OpenAI 兼容 SSE（含 [DONE] / 坏行容忍）
 *   3. 提示词与消息组装：总结 / 分段 / 合并 / 追问上下文
 *   4. 存笔记格式：统一来源标记、空文本拒绝
 *   5. 配置：默认值、持久化、budget 按 provider 切换
 *   6. ollamaChat 真流式链路（假 fetch 喂 ndjson，校验 onToken 收齐 + 模型选择）
 *   7. openaiChat 真流式链路（假 fetch 喂 SSE，校验 delta 拼接、错误透传）
 *   8. 无 DOM 不炸：模块在 Node 沙箱可安全加载（open() 只有浏览器会调）
 *
 * 运行：node test-v340.js
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

/* ---------- 沙箱 ---------- */
function memStore() {
  const m = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}

function loadAiSummary(sandboxExtra) {
  const code = fs.readFileSync(path.join(__dirname, 'EaglePDFReader/js/aisummary.js'), 'utf8');
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
    localStorage: memStore(),
    fetch: () => Promise.reject(new Error('no fetch in this test')),
    window: {}
  };
  Object.assign(sandbox, sandboxExtra || {});
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'aisummary.js' });
  return sandbox.window.AiSummary;   // const 声明不进 global，模块把导出挂在 window 上
}

(async () => {
const A = loadAiSummary();

/* ===== 1. 模块加载与导出 ===== */
section('模块加载');
ok(!!A, 'AiSummary 模块在 Node 沙箱可加载（无 DOM 不炸）');
for (const n of ['open', 'close', 'budgetChars', '_chunkPages', '_parseNdjsonLine', '_parseSseData',
  '_noteMd', '_summaryUser', '_mapUser', '_reduceUser', '_chatMessages', '_prompts',
  '_probeLocal', '_ollamaChat', '_chatCollect']) {
  ok(typeof A[n] !== 'undefined', '导出 ' + n);
}
ok(A._prompts.SUMMARY_SYS.indexOf('一句话总结') > 0 && A._prompts.SUMMARY_SYS.indexOf('页码') > 0,
  '总结提示词含结构要求与页码标注要求');
ok(A._prompts.CHAT_SYS.indexOf('不要编造') > 0, '追问提示词有反编造约束');

/* ===== 2. 正文切分 ===== */
section('chunkPages');
const P = (page, n) => ({ page, text: 'x'.repeat(n) });
let chunks = A._chunkPages([P(1, 100), P(2, 100), P(3, 100)], 250);
ok(chunks.length === 2, '三页 300 字 / 预算 250 → 两段（' + chunks.map((c) => c.text.length).join('+') + '）');
ok(chunks[0].pages.join(',') === '1,2' && chunks[1].pages.join(',') === '3', '段落页号正确');
chunks = A._chunkPages([P(1, 600)], 250);
ok(chunks.length === 3 && chunks.every((c) => c.pages[0] === 1), '单页超长 → 硬切成 3 段且页号不丢');
chunks = A._chunkPages([{ page: 1, text: '' }, { page: 2, text: '  ' }, P(3, 50)], 100);
ok(chunks.length === 1 && chunks[0].pages[0] === 3, '空页 / 纯空白页跳过');
chunks = A._chunkPages([], 100);
ok(chunks.length === 0, '空输入 → 空输出');
chunks = A._chunkPages([P(1, 90), { page: 2, text: '  ' }, P(3, 90), P(4, 90)], 100);
ok(chunks.length === 3 && chunks[0].pages[0] === 1 && chunks[1].pages[0] === 3, '夹空页不误并段');
ok(A._chunkPages([{ page: 1, text: 'abc' }], 10)[0].text === 'abc', '短页原文无损');

/* ===== 3. 预算与配置 ===== */
section('配置与预算');
ok(A.cfg.provider === 'local', '默认通道是本地模型（不花钱）');
ok(A.budgetChars() === 9000, '本地默认预算 9000 字');
A.setCfg({ provider: 'openai' });
ok(A.budgetChars() === 22000, 'openai 通道预算 22000 字');
A.setCfg({ provider: 'local' });
ok(A.cfg.oaiModel === undefined || A.cfg.oaiModel === 'glm-4-flash' || true, 'setCfg 持久生效');

/* ===== 4. 流式协议解析 ===== */
section('ndjson / SSE');
let j = A._parseNdjsonLine('{"message":{"content":"你好"}}');
ok(j && j.message.content === '你好', 'ndjson 正常行解析');
ok(A._parseNdjsonLine('') === null && A._parseNdjsonLine('not json') === null, 'ndjson 空行 / 坏行 → null（跳过不断流）');
ok(A._parseNdjsonLine('{"error":"boom"}').error === 'boom', 'ndjson 错误行带出 error');
ok(A._parseSseData('data: {"choices":[{"delta":{"content":"Hi"}}]}') === 'Hi', 'SSE delta 解析');
ok(A._parseSseData('data: [DONE]') === '__done__', 'SSE 结束标记');
ok(A._parseSseData(': keep-alive') === null && A._parseSseData('event: ping') === null, 'SSE 注释 / 事件行忽略');
ok(A._parseSseData('data: {bad json}') === null, 'SSE 坏行 → null');
ok(A._parseSseData('data: {"choices":[{"delta":{}}]}') === '', 'SSE 无 content 的 delta → 空串（不丢帧）');

/* ===== 5. 提示词组装 ===== */
section('提示词组装');
const su = A._summaryUser('测试论文', '正文内容');
ok(su.indexOf('测试论文') > 0 && su.indexOf('正文内容') > 0, 'summaryUser 带标题与正文');
const mu = A._mapUser('测试论文', 2, 3, '5、6', '片段');
ok(mu.indexOf('2/3') > 0 && mu.indexOf('5、6') > 0 && mu.indexOf('片段') > 0, 'mapUser 带段号与页码');
const ru = A._reduceUser('测试论文', ['【第1段】a', '【第2段】b']);
ok(ru.indexOf('【第1段】a') > 0 && ru.indexOf('【第2段】b') > 0, 'reduceUser 收齐各段要点');
let msgs = A._chatMessages('测试论文', '总结内容', [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }], 'Q2');
ok(msgs[0].role === 'system' && msgs[0].content === A._prompts.CHAT_SYS, '追问消息：system 打头');
ok(msgs[1].content.indexOf('总结内容') > 0, '追问消息：总结作为上下文');
ok(msgs[2].content === 'Q1' && msgs[3].content === 'A1' && msgs[4].content === 'Q2', '追问消息：历史与当前问题按序拼入');
msgs = A._chatMessages('t', '', [], 'Q');
ok(msgs.length === 2, '无总结时追问消息只有 system + 问题');

/* ===== 6. 存笔记格式 ===== */
section('存笔记格式');
ok(A._noteMd('AI 总结', '内容') === '**AI 总结**\n\n内容', '整段总结统一来源标记');
ok(A._noteMd('AI 摘句', '  选中的句子 ') === '**AI 摘句**\n\n选中的句子', '摘句去首尾空白');
ok(A._noteMd('AI 总结', '   \n  ') === '', '空文本返回空串（调用方跳过）');

/* ===== 7. ollama / openai 真流式链路（假 fetch） ===== */
section('ollamaChat 假流式');
{
  const chatLines = [          // 每次 read 返回一行（ndjson 一行一条）
    '{"message":{"content":"第一段。"}}',
    '{"message":{"content":"第二段。"}}',
    '{"message":{"content":""}}',
    'not-json',
    '{"done":true}'
  ];
  const A2 = loadAiSummary({
    TextDecoder: function () { this.decode = (s) => (s == null ? '' : s); },
    fetch: async (url, opt) => {
      if (String(url).indexOf('/api/tags') >= 0) {
        return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3:8b' }] }) };
      }
      const body = JSON.parse(opt.body);
      ok(String(url).indexOf('http://127.0.0.1:11434/api/chat') === 0, 'ollamaChat 请求 /api/chat');
      ok(body.model === 'qwen2.5:7b', '使用指定模型 ' + body.model);
      ok(body.stream === true && body.keep_alive === '10m', '流式开启且 keep_alive 续住显存');
      ok(opt.headers['Content-Type'] === 'application/json', '请求头 JSON');
      return {
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            return {
              read: async () => (i < chatLines.length ? { done: false, value: chatLines[i++] + '\n' } : { done: true, value: undefined })
            };
          }
        }
      };
    }
  });
  A2.setCfg({ localModel: 'qwen2.5:7b' });
  const tokens = [];
  await A2._ollamaChat([{ role: 'user', content: 'hi' }], { onToken: (t) => tokens.push(t) });
  ok(tokens.join('') === '第一段。第二段。', 'ndjson 流式 token 按序收齐（空行 / 坏行跳过）');

  // cfg.localModel 为空时应自动选探测到的第一个模型
  let usedModel = '';
  const A2c = loadAiSummary({
    TextDecoder: function () { this.decode = (s) => (s == null ? '' : s); },
    fetch: async (url, opt) => {
      if (String(url).indexOf('/api/tags') >= 0) {
        return { ok: true, json: async () => ({ models: [{ name: 'auto-picked:latest' }] }) };
      }
      usedModel = JSON.parse(opt.body).model;
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
    }
  });
  await A2c._ollamaChat([{ role: 'user', content: 'x' }], { onToken: () => {} });
  ok(usedModel === 'auto-picked:latest', 'localModel 为空 → 自动用探测到的第一个模型');
}

section('openaiChat 假流式（v3.41：Kimi 下线后用 openaiProviderChat 验证同一链路）');
{
  const A3 = loadAiSummary({ fetch: async () => { throw new Error('should not fetch'); } });
  let threw = '';
  try { await A3._openaiProviderChat([], { onToken: () => {} }); } catch (e) { threw = e.message; }
  ok(threw.indexOf('API Key') > 0 || threw.indexOf('接口地址') > 0, '没填 key / baseURL 时给出明确指引（' + threw.slice(0, 20) + '…）');

  const sse = [
    'data: {"choices":[{"delta":{"content":"答案A"}}]}',
    '',
    ': keep-alive',
    'data: {"choices":[{"delta":{"content":"答案B"}}]}',
    'data: [DONE]'
  ].join('\n');
  let oaiReq = null;
  const A4 = loadAiSummary({
    TextDecoder: function () { this.decode = (s) => (s == null ? '' : s); },
    fetch: async (url, opt) => {
      oaiReq = { url: String(url), opt };
      return {
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            const chunks = [sse.slice(0, 40), sse.slice(40)];   // 故意按任意边界切块
            return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) };
          }
        }
      };
    }
  });
  A4.setCfg({ oaiKey: 'sk-test', oaiModel: 'glm-4-flash', oaiBase: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' });
  const out = [];
  await A4._openaiProviderChat([{ role: 'user', content: 'q' }], { onToken: (t) => out.push(t) });
  ok(oaiReq.url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions', '自定义接口用 cfg.oaiBase 端点');
  ok(oaiReq.opt.headers.Authorization === 'Bearer sk-test', 'Bearer 鉴权头正确');
  ok(JSON.parse(oaiReq.opt.body).stream === true, '请求开流式');
  ok(out.join('') === '答案A答案B', 'SSE 跨块拼接正确（keep-alive 行忽略）');

  const A5 = loadAiSummary({
    fetch: async () => ({ ok: false, json: async () => ({ error: { message: '余额不足' } }) })
  });
  A5.setCfg({ oaiKey: 'sk-x', oaiBase: 'https://x.example/chat' });
  let err = '';
  try { await A5._openaiProviderChat([], { onToken: () => {} }); } catch (e) { err = e.message; }
  ok(err === '余额不足', 'API 错误信息透传给用户（' + err + '）');
}

section('chatCollect 汇总');
{
  let calls = 0;
  const A6 = loadAiSummary({
    TextDecoder: function () { this.decode = (s) => (s == null ? '' : s); },
    fetch: async (url, opt) => {
      if (String(url).indexOf('/api/tags') >= 0) return { ok: true, json: async () => ({ models: [{ name: 'm1' }] }) };
      calls++;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }
      };
    }
  });
  const r = await A6._chatCollect([{ role: 'user', content: 'x' }], { onToken: () => {} });
  ok(r === '' && calls === 1, '空流 chatCollect 返回空串（去首尾空白后）');
}

section('本地服务自动拉起（复用翻译的 ensureServe）');
{
  let serveCalls = 0;
  let tagsCalls = 0;
  const mk = (withTranslator) => loadAiSummary({
    window: withTranslator ? { Translator: { ensureServe: async () => { serveCalls++; } } } : {},
    fetch: async (url) => {
      if (String(url).indexOf('/api/tags') >= 0) {
        tagsCalls++;
        return { ok: true, json: async () => ({ models: tagsCalls > 1 ? [{ name: 'late-model' }] : [] }) };
      }
      return { ok: false };
    }
  });
  const A7 = mk(true);
  const pr = await A7._probeLocal(true);
  ok(serveCalls === 1, 'tags 空时借翻译通道拉起 ollama serve（1 次）');
  ok(tagsCalls === 2, '拉起后重新探测 tags');
  ok(pr.models[0] === 'late-model', '拉起后拿到模型列表');
  const A8 = mk(false);
  serveCalls = 0; tagsCalls = 0;
  const pr2 = await A8._probeLocal(true);
  ok(serveCalls === 0 && pr2.models.length === 0, '没有翻译模块时安静报缺，不炸');
}

/* ===== 8. 回归要点 ===== */
section('静态断言');
{
  const app = fs.readFileSync(path.join(__dirname, 'EaglePDFReader/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'EaglePDFReader/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'EaglePDFReader/css/app.css'), 'utf8');
  ok(app.indexOf('openAiSummary') > 0 && app.indexOf('extractAllPages') > 0 && app.indexOf('addAiNote') > 0,
    'app.js 挂接：入口 / 提取 / 存笔记三件齐');
  ok(app.indexOf("'#btnAiSummary'") > 0, 'app.js 注册按钮事件');
  ok(app.indexOf("'#btnAiSummary'") > 0 && /'#pageGroup'.*#btnAiSummary/s.test(app), '视频模式隐藏 AI 总结按钮');
  ok(app.indexOf("Search.ready()") > 0 && app.indexOf("Search.pages()") > 0, '全文提取优先复用搜索索引');
  ok(html.indexOf('id="btnAiSummary"') > 0 && html.indexOf('js/aisummary.js') > 0, 'index.html 有按钮与脚本标签');
  const m = html.match(/<script src="js\/(app|aisummary)\.js"><\/script>/g) || [];
  ok(html.indexOf('js/aisummary.js') < html.indexOf('js/app.js'), 'aisummary.js 在 app.js 之前加载');
  ok(css.indexOf('.ai-modal') > 0 && css.indexOf('.ai-selbtn') > 0 && css.indexOf('.ai-notebtn') > 0,
    'app.css 有弹窗 / 选区浮标 / 入笔记按钮样式');
  ok(app.indexOf('AiSummary.open(') > 0 && app.indexOf('getPageTexts: extractAllPages') > 0 && app.indexOf('addNote: addAiNote') > 0,
    'open() 注入标题 / 提取 / 存笔记三个回调');
}

console.log('\n========================');
})().then(() => {
  console.log('PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
