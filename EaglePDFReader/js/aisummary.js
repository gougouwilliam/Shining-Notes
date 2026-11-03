/* aisummary.js —— v3.41 一键 AI 总结全文 + 追问 + 摘句入笔记
 *
 * 需求（2026-10-31）：阅读页一键总结全文，弹窗展示；总结完可以继续追问；
 * 总结 / 回答里选中一句或几句，直接存成笔记。AI 回复按 Markdown 渲染呈现，
 * 入库保存原始 Markdown 文本。
 *
 * 模型通道两条，不引第三方 SDK：
 *   - 本地 Ollama（默认）：免费、不外传、和翻译共用本机模型；
 *   - 自定义接口（OpenAI 兼容）：填 baseURL + key + 模型名即可接任何兼容服务。
 *     推荐免费的智谱 GLM-4-Flash（open.bigmodel.cn，注册就能用，不限量）。
 *   WorkBuddy 的积分是本助手会话的算力，插件没有通道去调它，这里不接。
 *
 * 长文策略：正文超过模型预算时按页切成多段，先逐段提炼（map），
 * 再把各段要点合并成最终总结（reduce），避免静默截断让总结只剩前几页。
 *
 * 职责边界：只管「取全文 → 调模型 → 展示 → 存笔记」。
 * 存笔记通过 ctx.addNote 回调（app.js 注入），本模块不直接碰 state/Store；
 * 全文提取通过 ctx.getPageTexts 回调（app.js 注入，优先复用搜索索引）。
 */

const AiSummary = (function () {
  'use strict';

  const U = (typeof window !== 'undefined' && window.U) || {};
  /* markdown.js 用 const Markdown 声明（词法全局，不在 window 上）—— 两条路都试，
     v3.40.3 之前 window.Markdown 一直是 null，AI 消息从未真正渲染过 Markdown。 */
  const MD = (function () {
    try { if (typeof window !== 'undefined' && window.Markdown && window.Markdown.render) return window.Markdown; } catch (e) { /* ignore */ }
    try { if (typeof Markdown !== 'undefined' && Markdown && Markdown.render) return Markdown; } catch (e) { /* ignore */ }
    return null;
  })();
  const ESC = (typeof window !== 'undefined' && window.Esc) || null;

  /* ==================== 配置 ==================== */

  const LS_CFG = 'eaglenote.aisum.cfg';
  const PROVIDERS = ['local', 'openai'];   // v3.41 移除了 kimi / kimiweb

  function defaultCfg() {
    return {
      provider: 'local',                       // 'local' | 'openai'
      localUrl: 'http://127.0.0.1:11434',
      localModel: '',                          // 空 = 自动用探测到的第一个
      oaiBase: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      oaiKey: '',
      oaiModel: 'glm-4-flash',
      budgetLocal: 9000,                       // 单次塞给本地模型的正文上限（字符）
      budgetOai: 22000                         // 自定义接口：保守值，glm-4-flash 128k 其实可以更大
    };
  }

  let cfg = (function () {
    let c = null;
    try { c = Object.assign(defaultCfg(), JSON.parse(localStorage.getItem(LS_CFG) || '{}')); }
    catch (e) { c = defaultCfg(); }
    /* 旧配置里存过已下线的 provider（kimi / kimiweb）→ 回退默认，不让弹窗失效 */
    if (PROVIDERS.indexOf(c.provider) < 0) c.provider = 'local';
    /* 清掉已下线通道的残留字段 */
    ['kimiKey', 'kimiModel', 'budgetKimi', 'budgetKimiWeb'].forEach((k) => { delete c[k]; });
    return c;
  })();

  function saveCfg() {
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  function budgetChars() {
    if (cfg.provider === 'openai') return Number(cfg.budgetOai) || 22000;
    return Number(cfg.budgetLocal) || 9000;
  }

  /* ==================== 提示词 ==================== */

  const SUMMARY_SYS = [
    '你是专业的阅读助手。请把用户给的文档内容整理成一份结构化总结，用简体中文，Markdown 格式，依次包含：',
    '# 一句话总结',
    '## 核心要点（3~8 条，每条一行，重要的用 **加粗**）',
    '## 关键数据与名词（如原文有；没有就省略这一节）',
    '## 结论 / 怎么用（一段话）',
    '规则：只依据原文，不编造；引用事实时在行尾标注页码（如 P12）；原文没有的就写「原文未提及」。'
  ].join('\n');

  const MAP_SYS = '你是阅读助手。把这段文档节选提炼成要点清单：简体中文、每条一行、保留页码 / 数据 / 术语，不展开、不评论。';

  const REDUCE_SYS = SUMMARY_SYS;

  const CHAT_SYS = '你是这份文档的阅读助手。文档总结在上下文里，请据此用简体中文回答；总结里没有的，明确说「总结里没有提到」，不要编造。回答尽量短，直接可用。';

  function provLabel() {
    if (cfg.provider === 'openai') return '自定义接口';
    return '本地模型';
  }

  function summaryUser(title, text) {
    return '请总结下面这篇文档《' + title + '》的全文。\n\n<document>\n' + text + '\n</document>';
  }

  function mapUser(title, idx, total, pages, text) {
    return '这是《' + title + '》的第 ' + idx + '/' + total + ' 段（原文页码：' + pages + '）。提炼要点：\n\n<part>\n' + text + '\n</part>';
  }

  function reduceUser(title, parts) {
    return '下面是《' + title + '》各段的要点。请去重合并，输出最终总结。\n\n' + parts.join('\n\n');
  }

  /* ==================== 正文切分（纯函数） ==================== */

  /* 按页合并到 maxChars 为止；单页超长的硬切，保证每段都不超预算。
     空页跳过 —— 扫描页不该占模型的上下文。 */
  function chunkPages(pages, maxChars) {
    const out = [];
    let buf = [];
    let bufLen = 0;
    const flush = () => {
      if (!buf.length) return;
      out.push({ pages: buf.map((p) => p.page), text: buf.map((p) => p.text).join('\n\n') });
      buf = []; bufLen = 0;
    };
    (pages || []).forEach((p) => {
      const t = String(p.text || '').trim();
      if (!t) return;
      if (t.length > maxChars) {                 // 单页超长：硬切，页号标首段所在页
        flush();
        for (let i = 0; i < t.length; i += maxChars) {
          out.push({ pages: [p.page], text: t.slice(i, i + maxChars) });
        }
        return;
      }
      if (bufLen + t.length > maxChars) flush();
      buf.push({ page: p.page, text: t });
      bufLen += t.length;
    });
    flush();
    return out;
  }

  /* ==================== 流式解析（纯函数） ==================== */

  /* ollama /api/chat 流式：一行一个 JSON */
  function parseNdjsonLine(line) {
    line = String(line || '').trim();
    if (!line) return null;
    try { return JSON.parse(line); } catch (e) { return null; }
  }

  /* OpenAI 兼容 SSE：'data: {...}' -> delta 文本；'[DONE]' -> '__done__'；其余 -> null */
  function parseSseData(line) {
    line = String(line || '').trim();
    if (!line) return null;
    if (line === 'data: [DONE]' || line === '[DONE]') return '__done__';
    if (line.indexOf('data:') !== 0) return null;
    let j = null;
    try { j = JSON.parse(line.slice(5).trim()); } catch (e) { return null; }
    const d = j && j.choices && j.choices[0] && j.choices[0].delta;
    const piece = d && d.content;
    return piece ? String(piece) : '';
  }

  /* ==================== 本地模型探测 ==================== */

  const probeCache = { at: 0, models: [], url: '' };

  async function fetchTags(url) {
    try {
      const r = await fetch(url + '/api/tags', { method: 'GET' });
      if (r.ok) {
        const j = await r.json();
        return ((j && j.models) || []).map((m) => String(m.name || '')).filter(Boolean);
      }
    } catch (e) { /* 服务没起 */ }
    return [];
  }

  async function probeLocal(force) {
    if (!force && probeCache.models.length && Date.now() - probeCache.at < 30000) return probeCache;
    const url = String(cfg.localUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    let models = await fetchTags(url);
    if (!models.length) {
      /* 服务没起：借翻译模块的标准拉起通道（找 ollama.exe、最多等 15 秒）。
         拉起来之后总结和翻译共用同一个服务；失败就照实报缺，不卡界面。 */
      const T = (typeof window !== 'undefined' && window.Translator) || null;
      if (T && T.ensureServe) {
        try { await T.ensureServe(); } catch (e) { /* ignore */ }
        models = await fetchTags(url);   // 只有真的拉起过才值得再探一次
      }
    }
    probeCache.at = Date.now();
    probeCache.models = models;
    probeCache.url = url;
    return probeCache;
  }

  /* ==================== 对话通道（都走流式） ==================== */

  async function ollamaChat(messages, opt) {
    const pr = await probeLocal(false);
    if (!pr.models.length) {
      throw new Error('本机没有可用的 Ollama 模型 —— 启动 Ollama 并拉一个模型（如 qwen2.5:3b），或切到自定义接口');
    }
    const model = (cfg.localModel && pr.models.indexOf(cfg.localModel) >= 0)
      ? cfg.localModel
      : (cfg.localModel || pr.models[0]);
    const res = await fetch(pr.url + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '10m',        // 总结 + 追问是一场连续对话，别让模型中途掉出显存
        options: { temperature: opt.temperature == null ? 0.3 : opt.temperature }
      }),
      signal: opt.signal
    });
    if (!res.ok) throw new Error('本地模型 HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const j = parseNdjsonLine(line);
        if (!j) continue;
        if (j.error) throw new Error(String(j.error));
        const piece = j.message && j.message.content;
        if (piece) opt.onToken(piece);
      }
    }
  }

  /* OpenAI 兼容协议（智谱 / 硅基流动 / Moonshot…任何兼容服务都走这一条） */
  async function openaiChat(base, key, model, label, messages, opt) {
    if (!key) {
      throw new Error('还没填 ' + label + ' 的 API Key —— 点右上角 ⚙ 填入');
    }
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: model,
        messages,
        stream: true,
        temperature: opt.temperature == null ? 0.3 : opt.temperature
      }),
      signal: opt.signal
    });
    if (!res.ok) {
      let msg = label + ' HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (e) { /* 保留状态码提示 */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const t = parseSseData(line);
        if (t === '__done__') return;
        if (t) opt.onToken(t);
      }
    }
  }

  async function openaiProviderChat(messages, opt) {
    const base = String(cfg.oaiBase || '').trim();
    if (!base) throw new Error('还没填接口地址（baseURL）—— 点右上角 ⚙ 填入');
    return openaiChat(base, cfg.oaiKey, cfg.oaiModel || 'glm-4-flash', '自定义接口', messages, opt);
  }

  function chat(messages, opt) {
    if (cfg.provider === 'openai') return openaiProviderChat(messages, opt);
    return ollamaChat(messages, opt);
  }

  /* 收整段回复（流式回调照发），返回全文 */
  async function chatCollect(messages, opt) {
    let out = '';
    await chat(messages, {
      signal: opt.signal,
      temperature: opt.temperature,
      onToken: (t) => { out += t; if (opt.onToken) opt.onToken(t); }
    });
    return out.trim();
  }

  function isAbort(e) { return !!(e && e.name === 'AbortError'); }

  /* v3.39.1 本地兜底：非本地通道失败（非用户中止）→ 自动改用本地 Ollama 重试一次。
     兜底是会话级临时切换（不动用户保存的 provider 设置）；本地也失败就抛
     **原始**错误 —— 那个才是根因，报「本地也没模型」只会把人带偏。
     onFallback(e) 在开始兜底前回调，让界面把原因说清楚，绝不静默换模型。 */
  async function chatCollectFB(messages, opt) {
    if (cfg.provider === 'local') return chatCollect(messages, opt);
    try {
      return await chatCollect(messages, opt);
    } catch (e) {
      if (isAbort(e)) throw e;
      if (opt.onFallback) { try { opt.onFallback(e); } catch (x) { /* 通知失败不影响兜底 */ } }
      const saved = cfg.provider;
      cfg.provider = 'local';               // 会话级临时切换，不动 localStorage
      try {
        return await chatCollect(messages, opt);
      } catch (e2) {
        throw e;                            // 原始错误更有诊断价值
      } finally {
        cfg.provider = saved;
      }
    }
  }

  /* ==================== 总结编排 ==================== */

  /* ui 协议：
   *   phase(text)                  状态栏文字
   *   signal                       AbortSignal
   *   openStream(kind, label)      开一条流式消息，返回 {onToken(t), close(md), fail(err)}
   */
  async function runSummary(ctx, ui) {
    /* v3.39.1：兜底记账 —— 只要走过一次本地兜底，完成态就如实标注 */
    let usedFallback = false;
    function noticeFB(reason) {
      usedFallback = true;
      if (ui.notice) {
        ui.notice('⚠ ' + provLabel() + ' 失败（' + reason + '）—— 自动改用**本地模型**兜底');
      }
      ui.phase('本地模型兜底中…');
    }
    const onFB = (e) => noticeFB(e && e.message ? e.message : String(e));

    ui.phase('正在提取全文…');
    const pages = await ctx.getPageTexts((i, n) => ui.phase('正在提取全文… ' + i + '/' + n + ' 页'));
    const withText = (pages || []).filter((p) => String(p.text || '').trim());
    if (!withText.length) throw new Error('没有提取到文本 —— 扫描版 PDF 需要先 OCR 才能总结');
    const total = withText.reduce((s, p) => s + String(p.text).length, 0);
    const chunks = chunkPages(withText, budgetChars());

    if (chunks.length === 1) {
      ui.phase('总结中…（全文 ' + total + ' 字）');
      const s = ui.openStream('final', '最终总结（全文）');
      try {
        const text = await chatCollectFB(
          [
            { role: 'system', content: SUMMARY_SYS },
            { role: 'user', content: summaryUser(ctx.title || '', chunks[0].text) }
          ],
          { signal: ui.signal, onToken: s.onToken, onFallback: onFB }
        );
        s.close(text);
        ui.phase('完成 · ' + (usedFallback ? '本地模型（兜底）' : provLabel()));
        return text;
      } catch (e) { s.fail(e); throw e; }
    }

    /* 超预算：map-reduce。每段的中间结果单独一条灰底消息，
       既让用户看到进展，出问题时也知道是哪一段。 */
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      ui.phase('分段提炼 ' + (i + 1) + '/' + chunks.length + '…（全文 ' + total + ' 字，分 ' + chunks.length + ' 段）');
      const s = ui.openStream('part', '第 ' + (i + 1) + '/' + chunks.length + ' 段要点（P' + chunks[i].pages.join('、') + '）');
      try {
        const part = await chatCollectFB(
          [
            { role: 'system', content: MAP_SYS },
            { role: 'user', content: mapUser(ctx.title || '', i + 1, chunks.length, chunks[i].pages.join('、'), chunks[i].text) }
          ],
          { signal: ui.signal, onToken: s.onToken, temperature: 0.2, onFallback: onFB }
        );
        s.close(part);
        parts.push('【第 ' + (i + 1) + '/' + chunks.length + ' 段 · P' + chunks[i].pages.join('、') + '】\n' + part);
      } catch (e) { s.fail(e); throw e; }
    }
    ui.phase('合并成最终总结…');
    const sf = ui.openStream('final', '最终总结（全文）');
    try {
      const text = await chatCollectFB(
        [
          { role: 'system', content: REDUCE_SYS },
          { role: 'user', content: reduceUser(ctx.title || '', parts) }
        ],
        { signal: ui.signal, onToken: sf.onToken, onFallback: onFB }
      );
      sf.close(text);
      ui.phase('完成 · ' + (usedFallback ? '本地模型（兜底）' : provLabel()));
      return text;
    } catch (e) { sf.fail(e); throw e; }
  }

  /* 追问：带上总结做上下文（不再重发全文，控成本） */
  function chatMessages(title, summary, history, question) {
    const msgs = [{ role: 'system', content: CHAT_SYS }];
    if (summary) {
      msgs.push({ role: 'user', content: '这是文档《' + (title || '') + '》的总结：\n\n' + summary + '\n\n请基于它回答我接下来的问题。' });
    }
    (history || []).forEach((h) => msgs.push({ role: h.role, content: h.content }));
    msgs.push({ role: 'user', content: question });
    return msgs;
  }

  /* ==================== 存笔记的格式 ==================== */

  /* 统一加来源标记，和「译文」入库同一个惯例；空文本返回 ''，调用方跳过 */
  function noteMd(kind, text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return '**' + kind + '**\n\n' + t;
  }

  /* ==================== 界面 ==================== */

  let M = null;        // 打开状态 { ov, log, ta, title, ... }
  let busy = null;     // 进行中的任务 { abort }

  function renderMd(text) {
    if (MD && MD.render) return MD.render(String(text || ''));
    const d = document.createElement('div');
    d.textContent = String(text || '');
    return d.innerHTML;
  }

  function open(ctx) {
    if (M) { M.ov.style.display = 'flex'; return; }
    ctx = ctx || {};

    const ov = document.createElement('div');
    ov.className = 'ai-ov';
    const modal = document.createElement('div');
    modal.className = 'ai-modal';
    ov.appendChild(modal);

    /* --- 头部 --- */
    const head = document.createElement('div');
    head.className = 'ai-head';
    head.appendChild(Object.assign(document.createElement('b'), { textContent: 'AI 总结' }));
    head.appendChild(Object.assign(document.createElement('span'), { className: 'ai-doc', textContent: ctx.title || '', title: ctx.title || '' }));
    const provSel = document.createElement('select');
    provSel.className = 'ai-prov';
    provSel.appendChild(new Option('本地模型（免费）', 'local'));
    provSel.appendChild(new Option('自定义接口（OpenAI 兼容）', 'openai'));
    provSel.value = cfg.provider;
    const gear = document.createElement('button');
    gear.className = 'icon-btn'; gear.type = 'button'; gear.textContent = '⚙'; gear.title = '模型设置';
    const xbtn = document.createElement('button');
    xbtn.className = 'icon-btn'; xbtn.type = 'button'; xbtn.textContent = '✕'; xbtn.title = '关闭 (Esc)';
    head.appendChild(provSel);
    head.appendChild(gear);
    head.appendChild(xbtn);
    modal.appendChild(head);

    /* --- 设置行（按 provider 换内容） --- */
    const setRow = document.createElement('div');
    setRow.className = 'ai-settings';
    setRow.hidden = true;
    modal.appendChild(setRow);

    function buildSettings() {
      setRow.textContent = '';
      if (cfg.provider === 'local') {
        const url = document.createElement('input');
        url.type = 'text'; url.className = 'ai-in'; url.value = cfg.localUrl;
        url.placeholder = 'Ollama 地址'; url.title = 'Ollama 服务地址';
        const model = document.createElement('select');
        model.className = 'ai-in';
        const scan = document.createElement('button');
        scan.type = 'button'; scan.className = 'ai-mini'; scan.textContent = '检测';
        const fill = (models) => {
          model.textContent = '';
          if (!models.length) model.appendChild(new Option('（没检测到模型）', ''));
          models.forEach((m) => model.appendChild(new Option(m, m)));
          model.value = models.indexOf(cfg.localModel) >= 0 ? cfg.localModel : (models[0] || '');
        };
        fill(probeCache.models);
        scan.addEventListener('click', async () => {
          scan.textContent = '检测中…';
          cfg.localUrl = url.value.trim() || 'http://127.0.0.1:11434';
          const pr = await probeLocal(true);
          fill(pr.models);
          scan.textContent = '检测';
        });
        model.addEventListener('change', () => { cfg.localModel = model.value; saveCfg(); });
        url.addEventListener('change', () => { cfg.localUrl = url.value.trim() || 'http://127.0.0.1:11434'; saveCfg(); });
        setRow.appendChild(Object.assign(document.createElement('span'), { textContent: 'Ollama：' }));
        setRow.appendChild(url); setRow.appendChild(model); setRow.appendChild(scan);
      } else if (cfg.provider === 'openai') {
        const base = document.createElement('input');
        base.type = 'text'; base.className = 'ai-in'; base.value = cfg.oaiBase;
        base.placeholder = '接口地址 …/chat/completions'; base.title = 'OpenAI 兼容接口地址';
        const key = document.createElement('input');
        key.type = 'password'; key.className = 'ai-in'; key.value = cfg.oaiKey;
        key.placeholder = 'API Key'; key.autocomplete = 'off';
        const model = document.createElement('input');
        model.type = 'text'; model.className = 'ai-in'; model.value = cfg.oaiModel;
        model.placeholder = '模型名，如 glm-4-flash';
        base.addEventListener('change', () => { cfg.oaiBase = base.value.trim(); saveCfg(); });
        key.addEventListener('change', () => { cfg.oaiKey = key.value.trim(); saveCfg(); });
        model.addEventListener('change', () => { cfg.oaiModel = model.value.trim() || 'glm-4-flash'; saveCfg(); });
        setRow.appendChild(Object.assign(document.createElement('span'), { textContent: '接口：' }));
        setRow.appendChild(base); setRow.appendChild(key); setRow.appendChild(model);
        const hint = document.createElement('span');
        hint.className = 'ai-note-hint';
        hint.textContent = '推荐免费的智谱 GLM-4-Flash：open.bigmodel.cn 注册即用，不限量';
        setRow.appendChild(hint);
      }
    }
    buildSettings();

    /* --- 消息区 --- */
    const log = document.createElement('div');
    log.className = 'ai-log';
    modal.appendChild(log);

    const status = document.createElement('div');
    status.className = 'ai-status';
    modal.appendChild(status);

    /* --- 输入区 --- */
    const foot = document.createElement('div');
    foot.className = 'ai-input';
    const ta = document.createElement('textarea');
    ta.className = 'ai-ta'; ta.rows = 2;
    ta.placeholder = '总结完可以在这里追问…（Enter 发送，Shift+Enter 换行）';
    const send = document.createElement('button');
    send.type = 'button'; send.className = 'tb solo act'; send.textContent = '发送';
    const stop = document.createElement('button');
    stop.type = 'button'; stop.className = 'tb solo'; stop.textContent = '停止'; stop.hidden = true;
    foot.appendChild(ta); foot.appendChild(send); foot.appendChild(stop);
    modal.appendChild(foot);

    const selBtn = document.createElement('button');
    selBtn.type = 'button'; selBtn.className = 'ai-selbtn'; selBtn.textContent = '加入笔记'; selBtn.hidden = true;
    document.body.appendChild(selBtn);

    /* --- 消息构造 --- */
    let history = [];        // 追问历史（不含总结与当前问题）
    let lastSummary = '';
    let curHandle = null;

    function scrollDown() { log.scrollTop = log.scrollHeight; }
    function setPhase(t) { status.textContent = t || ''; }

    function addMsg(role, mdText, label) {
      const w = document.createElement('div');
      w.className = 'ai-msg ' + role;
      let labelEl = null;
      if (label) {
        labelEl = Object.assign(document.createElement('div'), { className: 'ai-msg-label', textContent: label });
        w.appendChild(labelEl);
      }
      const body = document.createElement('div');
      body.className = 'ai-md';
      if (mdText != null) body.innerHTML = renderMd(mdText);
      w.appendChild(body);
      log.appendChild(w);
      scrollDown();
      const handle = { wrap: w, body, raw: mdText == null ? '' : String(mdText), labelEl };
      if (role === 'ai') attachFoot(handle);
      return handle;
    }

    /* 每条 AI 消息一个「加入笔记」；选区另有浮标 */
    function attachFoot(handle) {
      const f = document.createElement('div');
      f.className = 'ai-msg-foot';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ai-notebtn'; b.textContent = '加入笔记';
      b.addEventListener('click', () => {
        const md = noteMd(handle.kind || 'AI 总结', handle.raw);
        if (!md) return;
        if (ctx.addNote) ctx.addNote(md, '');
      });
      f.appendChild(b);
      handle.wrap.appendChild(f);
    }

    /* 流式消息：openStream(kind, label) -> {onToken, close(md), fail(err)}
       v3.41：AI 回复是 Markdown —— 流式过程中节流渲染（120ms 一拍，滚动不卡），
       close 时做最终渲染；保存进笔记的始终是原始 Markdown 文本。 */
    function openStream(kind, label) {
      const h = addMsg('ai' + (kind === 'part' ? ' part' : ''), null, label);
      if (kind !== 'part') h.kind = 'AI 总结';
      /* 中间分段默认折叠：长文档仍能看到进展（状态栏「分段提炼 X/Y」），
         但最终合并结果才是重点，开头就折叠，避免几段要点盖过总结本身。 */
      if (kind === 'part') {
        h.wrap.classList.add('ai-collapsed');
        if (h.labelEl) {
          const t = document.createElement('span');
          t.className = 'ai-toggle';
          t.textContent = ' ▸ 展开';
          t.addEventListener('click', (e) => {
            e.stopPropagation();
            h.wrap.classList.toggle('ai-collapsed');
            t.textContent = h.wrap.classList.contains('ai-collapsed') ? ' ▸ 展开' : ' ▾ 收起';
          });
          h.labelEl.appendChild(t);
        }
      }
      let raw = '';
      let paintTimer = 0;
      const paint = () => { paintTimer = 0; h.body.innerHTML = renderMd(raw); };
      curHandle = h;
      return {
        onToken: (t) => {
          raw += t;
          h.raw = raw;
          if (!paintTimer) paintTimer = setTimeout(paint, 120);
          scrollDown();
        },
        close: (md) => {
          if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
          h.raw = md || raw;
          h.body.innerHTML = renderMd(h.raw);
          scrollDown();
        },
        fail: (err) => {
          if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
          h.wrap.classList.add('ai-err');
          h.body.innerHTML = renderMd('⚠ ' + (err && err.message ? err.message : String(err)));
        }
      };
    }

    /* --- 总结入口（窗口里内嵌按钮，比顶部再放一个干净） --- */
    const hint = document.createElement('div');
    hint.className = 'ai-hint';
    hint.appendChild(Object.assign(document.createElement('div'), {
      textContent: '还没有总结。点下面的按钮把全文交给模型；总结完可以直接追问，选中任意文字可存为笔记。'
    }));
    const goBtn = document.createElement('button');
    goBtn.type = 'button'; goBtn.className = 'tb solo act'; goBtn.textContent = '总结全文';
    goBtn.addEventListener('click', () => startSummary());
    hint.appendChild(goBtn);
    log.appendChild(hint);

    function setBusy(on) {
      busy = on ? { abort } : null;
      stop.hidden = !on;
      send.disabled = !!on;
      provSel.disabled = !!on;
    }

    let abort = null;
    async function startSummary() {
      if (busy) return;
      hint.hidden = true;
      const ctl = new AbortController();
      abort = () => ctl.abort();
      setBusy(true);
      const ui = {
        signal: ctl.signal,
        phase: setPhase,
        openStream,
        notice: (t) => { addMsg('ai part', t, '兜底'); }
      };
      try {
        const text = await runSummary(ctx, ui);
        lastSummary = text;
        history = [];
      } catch (e) {
        if (e && e.name === 'AbortError') { setPhase('已停止'); }
        else setPhase('失败：' + (e && e.message ? e.message : e));
      } finally {
        setBusy(false);
        abort = null;
      }
    }

    async function doSend() {
      const q = ta.value.trim();
      if (!q || busy) return;
      if (!lastSummary) { setPhase('先点「总结全文」，再追问'); return; }
      ta.value = '';
      addMsg('user', q);
      history.push({ role: 'user', content: q });
      const ctl = new AbortController();
      abort = () => ctl.abort();
      setBusy(true);
      const s = openStream('final', '');
      try {
        const ans = await chatCollectFB(
          chatMessages(ctx.title || '', lastSummary, history.slice(0, -1), q),
          {
            signal: ctl.signal, onToken: s.onToken, temperature: 0.5,
            onFallback: (e) => {
              addMsg('ai part', '⚠ ' + provLabel() + ' 失败（' + (e && e.message ? e.message : e) + '）—— 自动改用**本地模型**兜底', '兜底');
              setPhase('本地模型兜底中…');
            }
          }
        );
        s.close(ans);
        history.push({ role: 'assistant', content: ans });
        setPhase('');
      } catch (e) {
        s.fail(e);
        setPhase(e && e.name === 'AbortError' ? '已停止' : '失败：' + (e && e.message ? e.message : e));
      } finally {
        setBusy(false);
        abort = null;
      }
    }

    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
    });
    stop.addEventListener('click', () => { if (abort) abort(); });

    /* --- 选区 → 加入笔记 --- */
    let selText = '';
    function onMouseUp(ev) {
      selText = '';
      selBtn.hidden = true;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !M || !M.log) return;
      if (!M.log.contains(sel.anchorNode)) return;
      const text = String(sel.toString() || '').trim();
      if (!text) return;
      selText = text;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      selBtn.hidden = false;
      selBtn.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 130)) + 'px';
      selBtn.style.top = Math.min(window.innerHeight - 44, r.bottom + 6) + 'px';
    }
    selBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();                 // 先于 mouseup 清选区，保住 selection
      const md = noteMd('AI 摘句', selText);
      if (md && ctx.addNote) ctx.addNote(md, '');
      selBtn.hidden = true;
    });
    document.addEventListener('mouseup', onMouseUp, true);

    /* --- 头部交互 --- */
    gear.addEventListener('click', () => { setRow.hidden = !setRow.hidden; });
    provSel.addEventListener('change', () => {
      cfg.provider = provSel.value;
      saveCfg();
      buildSettings();
      setPhase('');
    });

    /* --- 开 / 关 --- */
    function close() {
      if (!M) return;
      if (abort) abort();
      document.removeEventListener('mouseup', onMouseUp, true);
      selBtn.remove();
      ov.remove();
      if (ESC && ESC.remove) ESC.remove('aiModal');
      M = null;
    }
    xbtn.addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    if (ESC && ESC.push) ESC.push('aiModal', close);

    document.body.appendChild(ov);
    M = { ov, log, ta, close };
    ta.focus();
    return M;
  }

  function close() { if (M) M.close(); }

  return {
    open,
    close,
    get cfg() { return cfg; },
    setCfg(patch) { Object.assign(cfg, patch || {}); saveCfg(); },
    budgetChars,
    /* 测试用 */
    _chunkPages: chunkPages,
    _parseNdjsonLine: parseNdjsonLine,
    _parseSseData: parseSseData,
    _noteMd: noteMd,
    _summaryUser: summaryUser,
    _mapUser: mapUser,
    _reduceUser: reduceUser,
    _chatMessages: chatMessages,
    _prompts: { SUMMARY_SYS, MAP_SYS, REDUCE_SYS, CHAT_SYS },
    _probeLocal: probeLocal,
    _ollamaChat: ollamaChat,
    _openaiChat: openaiChat,
    _openaiProviderChat: openaiProviderChat,
    _provLabel: provLabel,
    _renderMd: renderMd,
    _chatCollect: chatCollect,
    _chatCollectFB: chatCollectFB,
    _isAbort: isAbort
  };
})();

try { window.AiSummary = AiSummary; } catch (e) { /* ignore */ }
