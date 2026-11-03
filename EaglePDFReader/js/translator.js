/* 划词翻译（3.3.3 重做调度）

   四层，按「快 + 准 + 不依赖网络环境」排序：

     1. 本地模型（Ollama，http://127.0.0.1:11434）——装了就是最快的，200–800ms，不外传；
     2. 有道「免密钥」接口（aidemo）—— 国内直连、不用密钥、实测 50–300ms，默认主力；
     3. Google gtx / MyMemory —— 只在前面都没回的时候，1.2 秒后一起放出去对冲。

   3.3.3 改了三件事，都是冲着「慢」和「500 字限制」去的：

     - **对冲而不是排队**：一线引擎（本地模型 / 有道免密钥）先跑，1.2 秒没结果就把
       Google / MyMemory 一起放出去，谁先回用谁。之前是「一个一个等」，
       在没有密钥、Google 被墙的机器上，一次翻译要等两个 4 秒超时。
     - **按接口上限分块**：有道免密钥 ≤1000 字、MyMemory ≤500 字。
       按 900 切块给主线路，MyMemory 自己在内部再切到 300–450。
       之前按 1200 切，于是稍长的选区必然失败，用户看到的就是「500 字限制」。
     - **缓存照旧**：同一段话第二次是 0 延迟（localStorage，按 文本+目标语言 建键）。

   将来做视频实时转译 / PDF OCR / 截帧 OCR，都可以挂到同一个「本地模型」通道上：
   只要能说 HTTP，插件这一侧不用再改。
*/
const Translator = (function () {
  const CACHE_MAX = 300;
  const LS_KEY = 'eaglenote:trcache';
  const LS_LOCAL = 'eaglenote:trlocal';
  /* 「本机哪里找到过 ollama.exe」与「上次扫盘时间」—— 见 findOllamaExe */
  const LS_EXE_HINT = 'eaglenote.ollama.exe';
  const LS_SCAN_AT = 'eaglenote.ollama.scanAt';
  const TIMEOUT = 5000;
  const LOCAL_TIMEOUT = 20000;     // 本地模型冷启动会比较慢，给足时间
  /* 显存保活。一次翻译就把计时器重置，所以连续阅读时模型一直热着；
     停手 5 分钟自动卸载，把约 5.6 GB 显存还给别的程序。 */
  const KEEP_ALIVE = '5m';
  /* 视觉模型的名字特征（qwen2.5vl / llava / minicpm-v …）。放在顶部是因为
     probeLocal 选模型时也要用：有视觉模型就优先用它，一个顶两个、永远不换载。 */
  const VISION_RE = /(vl|vision|llava|minicpm-v|moondream|internvl|pixtral|gemma3)/i;
  /* 没有视觉模型时建议用户 pull 哪个。7b 在 12 GB 显存上刚好，2b 给核显/小显存兜底。
     这个名字会出现在报错文案和右栏向导里，改一处就全改。 */
  const VISION_SUGGEST = 'qwen2.5vl:7b';
  const VISION_SMALL = 'qwen2.5vl:3b';
  const OLLAMA_SITE = 'https://ollama.com/download';
  /* 3.3.3：分块大小是实测出来的，不是拍的 ——
       有道免密钥接口：≤1000 字随便过，1200 字起报 errorCode 103（文本过长）
       MyMemory：整段超过 500 字直接回 QUERY LENGTH LIMIT EXCEEDED
     上一版按 1200 切块，于是「稍长一点的选区必然失败」，用户看到的就是硬邦邦的 500 字限制。
     现在主线路用 900（少发请求 = 更少撞频率限制），MyMemory 那条兜底路自己在内部再切到 450。 */
  const CHUNK = 900;
  const MYMEMORY_MAX = 450;
  const MAX_TOTAL = 20000;
  const CONCURRENCY = 3;
  const HEDGE_MS = 1200;           // 一线引擎这么久没回，就把公共接口也放出去跑
  let cache = null;

  /* ---------- 缓存 ---------- */
  function loadCache() {
    if (cache) return cache;
    cache = new Map();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        Object.keys(obj || {}).forEach((k) => cache.set(k, obj[k]));
      }
    } catch (e) { /* ignore */ }
    return cache;
  }

  function persistCache() {
    try {
      const obj = {};
      let n = 0;
      for (const [k, v] of cache) {
        if (n++ >= CACHE_MAX) break;
        obj[k] = v;
      }
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  const keyOf = (text, target) => 'h' + U.hashKey(String(text).trim() + '|' + target);

  function guessTarget(text) {
    return U.cjkRatio(text) > 0.22 ? 'en' : 'zh-CN';
  }

  function targetName(target) {
    return target === 'en' ? 'English' : 'Simplified Chinese';
  }

  /* ---------- 本地模型（Ollama） ---------- */
  function getLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_LOCAL) || 'null');
      return {
        url: String((o && o.url) || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
        model: String((o && o.model) || ''),
        /* 免安装版（解压即用）不在任何「标准安装位置」，自动拉起就得靠用户自己指个路。
           这是用户填的配置，不是开发机路径，上架也站得住。 */
        exe: String((o && o.exe) || '')
      };
    } catch (e) {
      return { url: 'http://127.0.0.1:11434', model: '', exe: '' };
    }
  }

  function setLocal(cfg) {
    try {
      const url = String((cfg && cfg.url) || '').trim();
      const model = String((cfg && cfg.model) || '').trim();
      const exe = String((cfg && cfg.exe) || '').trim();
      if (!url && !model && !exe) localStorage.removeItem(LS_LOCAL);
      else localStorage.setItem(LS_LOCAL, JSON.stringify({
        url: url || 'http://127.0.0.1:11434',
        model,
        exe
      }));
      probe.at = 0;                 // 配置变了，重新探测
      resetServeHint();             // 节流也一起清，填完路径能立刻再拉一次
    } catch (e) { /* ignore */ }
  }

  /* 探测结果缓存 30s，避免每次翻译都敲一次 /api/tags */
  const probe = { at: 0, ok: false, models: [] };

  /* forConfig=true 时用于「设置面板检测」：即使还没填模型名，探到就把第一个模型名交回去。
     注意这里**不再**要求先填模型名才探测 —— 本机装着 Ollama 就应该自动用上，
     用户不填任何东西也能生效。连不上是 ECONNREFUSED，毫秒级返回，且结果缓存 30s。

     v3.9.2：`probe.ok` 改成「服务可达」而不是「至少有一个模型」。
     以前 `/api/tags` 返回 200 但 models 为空（Ollama 刚装好、还没 pull 任何模型）
     会被判成 null，右栏于是写「未检测到 Ollama」—— 明明服务在跑，界面却说没装，
     用户只能一遍遍点检测。现在这种状态返回一个 model 为空的配置，
     界面就能正确说「已在运行 · 还缺视觉模型」。 */
  async function probeLocal(force, forConfig) {
    const cfg = getLocal();
    const now = Date.now();
    if (!force && probe.at && now - probe.at < 30000) {
      return probe.ok
        ? Object.assign({}, cfg, { model: probe.model || cfg.model, models: probe.models, serve: true })
        : null;
    }
    try {
      const j = await fetchJson(cfg.url + '/api/tags', null, 1500);
      const names = ((j && j.models) || []).map((m) => String(m.name || '')).filter(Boolean);
      probe.at = now;
      probe.models = names;
      probe.ok = true;                       // HTTP 通了就是通了，空列表也是通
      if (!names.length) {
        probe.model = '';
        return Object.assign({}, cfg, { model: '', models: [], serve: true });
      }
      /* 选哪个模型？关键是**别让它换载**。
         实测（12 GB 卡）：翻译模型 5.6 GB + 视觉模型 6.2 GB 装不下两个，
         每换一次模型就要约 3.9 秒重新加载。而视觉模型做纯文本翻译只要 0.3–0.5 秒，
         质量与纯文本模型相当（"bounding box" 反而更准）。
         所以：用户没指定模型时，**优先挑视觉模型**，让它一个顶两个用 ——
         翻译和 OCR 共用同一份显存，永不换载。用户显式填了模型才尊重他的选择。 */
      const hit = names.find((n) => n === cfg.model) ||
        names.find((n) => n.split(':')[0] === cfg.model.split(':')[0]) ||
        names.find((n) => VISION_RE.test(n)) ||
        names[0];
      probe.model = hit;
      return Object.assign({}, cfg, { model: hit, models: names, serve: true });
    } catch (e) {
      probe.at = now;
      probe.ok = false;
      probe.models = [];
      return null;
    }
  }

  function fetchJson(url, body, timeout) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctrl) timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeout || TIMEOUT);
    const init = {
      method: body ? 'POST' : 'GET',
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    };
    if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((t) => JSON.parse(t))
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /* 译文语言纯度自检。LLM 偶尔把「一是/二是」这种连接词原样留在译文里，
     看着像翻了，其实半截——实测 qwen2.5:7b 中译英必犯。检出就重试，再不行交下一个引擎。 */
  function cjkChars(s) {
    return (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
  }

  function looksUntranslated(out, target) {
    const s = String(out || '');
    const solid = s.replace(/\s/g, '').length;
    if (solid < 24) return false;              // 太短不判，免得专有名词被误伤
    const cjk = cjkChars(s);
    /* 译成外文时看绝对数：残留两三个汉字在长译文里比例极低，却最刺眼
       （实测「一是…二是…」4 个汉字 / 330 字符 = 1.2%，用比例永远抓不住） */
    if (target === 'en') return cjk >= 2;
    return cjk / solid < 0.25;                 // 译成中文却几乎没汉字 → 等于没翻
  }

  /* ---------- 术语表（v3.12）----------
     通用引擎永远给「最常见」的译法，而看文献时最常见往往就是错的：
     intervention 在介入科是「介入手术」，在公卫里是「干预」；
     dissection 在解剖学是「解剖」，在血管外科是「夹层」。
     这类词机器猜不出来，但用户自己知道 —— 所以给一张可编辑的对照表，
     翻译时只注入「这条文本里真的出现过」的条目，不污染无关的句子。 */
  const LS_GLOSSARY = 'eaglenote:glossary';
  let glossCache = null;

  function parseGlossary(raw) {
    const out = [];
    String(raw || '').split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      /* 支持三种写法：`a = b`、`a => b`、`a<TAB>b` */
      const m = s.match(/^(.+?)\s*(?:=>|=|\t)\s*(.+)$/);
      if (!m) return;
      const from = m[1].trim();
      const to = m[2].trim();
      if (from && to) out.push({ from, to });
    });
    return out;
  }

  function getGlossary() {
    if (glossCache) return glossCache;
    try { glossCache = parseGlossary(localStorage.getItem(LS_GLOSSARY)); }
    catch (e) { glossCache = []; }
    return glossCache;
  }

  function setGlossary(raw) {
    try { localStorage.setItem(LS_GLOSSARY, String(raw || '')); } catch (e) { /* ignore */ }
    glossCache = null;
    return getGlossary();
  }

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 只挑这条文本里出现过的术语。最多 24 条 —— prompt 越长，小模型越容易走神。 */
  function pickGlossary(text) {
    const list = getGlossary();
    if (!list.length) return [];
    const hay = String(text || '').toLowerCase();
    const out = [];
    for (let i = 0; i < list.length && out.length < 24; i++) {
      const k = String(list[i].from || '').toLowerCase();
      if (!k) continue;
      const hit = /^[\x00-\x7f]+$/.test(k)
        ? new RegExp('(^|[^a-z0-9])' + escRe(k) + '([^a-z0-9]|$)', 'i').test(hay)
        : hay.indexOf(k) >= 0;
      if (hit) out.push(list[i]);
    }
    return out;
  }

  /* 术语表一改，旧译文就不对了 —— 缓存键必须带术语表的指纹 */
  function gsig(list) {
    if (!list || !list.length) return '';
    return '|g' + U.hashKey(list.map((g) => g.from + '=' + g.to).join(';'));
  }

  /* 上下文也要进缓存键（v3.26）。
     同一句话在不同语境下可能该译成不同的词；不带这个指纹的话，
     「带上文翻出来的结果」会命中「没带上文时写下的旧译文」，改进等于白做。 */
  function ctxsig(ctx) {
    const s = String(ctx || '').trim();
    return s ? '|x' + U.hashKey(s.slice(0, 600)) : '';
  }

  /* 译文比原文长出一大截，多半是把「上下文」也一起翻了。
     小模型（7b 级）对「只翻指定部分」这种指令并不可靠，所以要有这道检测。 */
  function looksOverflowed(out, src) {
    const a = String(out || '').length;
    const b = String(src || '').length;
    return b > 12 && a > b * 3.2;
  }

  /* 组装 system prompt。抽成独立函数是为了能单独测 ——
     这段文本的质量直接决定译文质量，改词的时候必须看得见结果。 */
  function ollamaSys(target, strict, opts) {
    const o = opts || {};
    let sys = 'You are a precise translation engine. Translate the user text into '
      + targetName(target)
      + '. Output ONLY the translation, with no quotes, notes or explanations. '
      + 'Do not leave source-language fragments untranslated: every word must be '
      + 'converted, including short discourse markers such as 一是/二是/第一 '
      + '(render them as "first/second/third"). Proper nouns, product names and '
      + 'acronyms keep their original spelling. '
      + 'Preserve line breaks, numbers and inline punctuation.'
      + (strict
        ? ' IMPORTANT: your previous attempt left untranslated source-language characters '
          + 'in the output. Translate every single word this time; no Chinese character may '
          + 'appear unless the target language is Chinese.'
        : '');
    if (o.glossary && o.glossary.length) {
      sys += '\n\nTERMINOLOGY (binding — when a term below appears in the text, '
        + 'use exactly the given rendering):\n'
        + o.glossary.map((g) => g.from + ' = ' + g.to).join('\n');
    }
    if (o.context) {
      sys += '\n\nThe user will give one line of CONTEXT followed by the TEXT to translate. '
        + 'Context is only there so you can disambiguate terminology; '
        + 'do NOT translate the context and do NOT include it in your output. '
        + 'Output the translation of TEXT only.';
    }
    return sys;
  }

  function ollamaUser(text, opts) {
    const o = opts || {};
    return o.context
      ? 'CONTEXT (do not translate):\n' + String(o.context).slice(0, 600) + '\n\nTEXT:\n' + text
      : text;
  }

  async function ollama(text, target, cfg, strict, opts) {
    const o = opts || {};
    const sys = ollamaSys(target, strict, o);
    const user = ollamaUser(text, o);
    const j = await fetchJson(cfg.url + '/api/chat', {
      model: cfg.model,
      stream: false,
      keep_alive: KEEP_ALIVE,        // 每次翻译都续一次，不让模型在阅读中途掉出显存
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ]
    }, LOCAL_TIMEOUT);
    const out = j && j.message && j.message.content;
    if (!out) throw new Error('本地模型返回为空');
    return String(out).trim();
  }

  /* 通用补全（v3.14）：给字幕「语境校对」这类非翻译任务用的同一个本地通道。
     走 /api/chat，temperature 0，keep_alive 续一次 —— 和翻译共用同一份显存，
     不会为了校字幕再去换载一个模型。
     服务没起来 / 没模型就返回 null，调用方自己降级，不在这里抛。 */
  async function complete(system, user, opts) {
    const o = opts || {};
    let cfg = getLocal();
    if (!cfg.model) {
      try {
        const ps = await probeLocal(false, true);
        if (ps && ps.model) cfg = ps;
      } catch (e) { /* ignore */ }
    }
    if (!cfg.model) return null;
    try {
      const j = await fetchJson(cfg.url + '/api/chat', {
        model: cfg.model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') }
        ]
      }, o.timeout || LOCAL_TIMEOUT);
      const out = j && j.message && j.message.content;
      return out ? String(out).trim() : null;
    } catch (e) {
      return null;
    }
  }

  /* 本地模型带自检：残留源语言就先严格重试一次，还不行抛错交给兜底引擎 */
  async function ollamaChecked(text, target, cfg, opts) {
    const o = opts || {};
    const first = await ollama(text, target, cfg, false, o);
    /* 上下文被当成正文一起翻了：去掉上下文重来一次，别把两段话一起塞给用户 */
    if (o.context && looksOverflowed(first, text)) {
      const plain = await ollama(text, target, cfg, false, Object.assign({}, o, { context: '' }));
      if (!looksOverflowed(plain, text) && !looksUntranslated(plain, target)) return plain;
      return first;
    }
    if (!looksUntranslated(first, target)) return first;
    const second = await ollama(text, target, cfg, true, o);
    if (looksUntranslated(second, target)) throw new Error('本地模型译文残留源语言');
    return second;
  }

  /* ---------- 自动拉起 ollama serve ----------
     翻译和 OCR 都不该要求用户先回终端敲一遍命令。点下去的时候先看一眼服务在不在，
     不在就按各平台的标准安装位置找可执行文件拉起来，最多等 15 秒。
     找不到就静默返回 false —— 后面报「没检测到本地 Ollama」，不会卡住界面。

     ⚠ 这里只认厂商标准安装位置和 OLLAMA_EXE 环境变量。
     绝不能加入「开发者本机才有的目录」——插件要能装在任何人的机器上跑，
     Eagle 审核明确禁止依赖只在开发者电脑上存在的路径。

     ⚠ 窗口：**Windows 上不能带 detached**。Node 的 `windowsHide` 在
     `detached: true` 时会失效（uv_spawn 那条路径不传 CREATE_NO_WINDOW），
     结果是每拉一次服务就闪一个黑色控制台窗口 —— 打开插件时连闪几下就是这么来的。
     detached 只是为了 Unix 上脱离父进程的进程组，Windows 不需要它。 */
  const serveHint = { okAt: 0, triedAt: 0, giveUpAt: 0 };
  let starting = null;

  /* 用户刚改了 exe 路径、或手动点了「检测」：把「刚试过 / 刚放弃」的节流清掉。
     不清的话，配置改对了也得干等 30 秒才肯再拉一次，看着就像没生效。 */
  function resetServeHint() {
    serveHint.okAt = 0;
    serveHint.triedAt = 0;
    serveHint.giveUpAt = 0;
    /* 手动点「检测 / 自动查找」= 明确要我再找一遍：
       把「扫过盘、没找到」的 12 小时记忆清掉，否则刚装好也得等半天。 */
    lsWrite(LS_SCAN_AT, '');
  }

  function servePlatform() {
    try {
      if (typeof process !== 'undefined' && process.platform) return process.platform;
    } catch (e) { /* ignore */ }
    return 'unknown';
  }

  function ollamaExeCandidates() {
    const out = [];
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    if (env.OLLAMA_EXE) out.push(env.OLLAMA_EXE);      // 环境变量：优先级最高
    try { const c = getLocal(); if (c.exe) out.push(c.exe); } catch (e) { /* ignore */ }   // 设置里手填的路径

    let pathMod = null;
    try { if (typeof require === 'function') pathMod = require('path'); } catch (e) { /* 浏览器环境 */ }
    const join = pathMod ? pathMod.join : (a, b, c, d) => [a, b, c, d].filter(Boolean).join('/');

    const plat = servePlatform();
    if (plat === 'win32') {
      const la = env.LOCALAPPDATA || '';
      const pf = env.ProgramFiles || 'C:\\Program Files';
      if (la) {
        out.push(join(la, 'Programs', 'Ollama', 'ollama.exe'));
        /* 注意：**不要**把 `ollama app.exe` 放进候选。
           那是带托盘界面的启动器，把 'serve' 当参数传过去它不认，会直接弹出一个
           GUI 窗口 —— 用户看到的就是「一堆窗框闪出来又消失」。命令行服务只用 ollama.exe。 */
      }
      out.push(join(pf, 'Ollama', 'ollama.exe'));
    } else if (plat === 'darwin') {
      /* 官方 macOS 版是个 App，命令行在 Resources 里；Homebrew 两种前缀都要试。 */
      out.push('/Applications/Ollama.app/Contents/Resources/ollama');
      out.push('/Applications/Ollama.app/Contents/MacOS/ollama');
      out.push('/opt/homebrew/bin/ollama');
      out.push('/usr/local/bin/ollama');
    } else {
      out.push('/usr/local/bin/ollama');
      out.push('/usr/bin/ollama');
      out.push('/snap/bin/ollama');
    }
    return out.filter((p, i) => p && out.indexOf(p) === i);
  }

  /* ==================== 在本机上找 Ollama ====================
     用户的意见很直接：「插件不能自己检测我装没装 Ollama 么，非要我输入位置？」
     能，而且绝大多数情况本来就该检测得出来 —— 原来只看了两三个标准目录，
     凡是不在那几个目录里的（解压即用版、装到 D 盘、绿色版）一律被判成「没装」。

     现在按「证据强度」依次问系统，命中即停：
       1. 上次找到的路径（存 localStorage，此后开机直接用，不再找）
       2. 设置里手填的路径 / OLLAMA_EXE 环境变量
       3. 各平台标准安装目录
       4. PATH —— `where ollama`（官方安装包会把自己加进 PATH）
       5. 正在运行的 ollama 进程 —— 托盘版开机就常驻，从进程拿 exe 路径最准
       6. Windows 卸载表登记的 InstallLocation（官方安装包的登记处）
       7. 兜底：在常见根目录里有限度地走一遍目录树，找名为 ollama.exe 的文件

     第 1~3 步是几次 statSync，毫秒级，放在开机路径上；
     第 4~6 步要起进程问一句，约几百毫秒，只在 1~3 全空时才做；
     第 7 步有时间和目录数预算，最多 7 秒，且一次只读一个目录（await 之间让出事件循环，界面不卡）。
     七步全空才认定「这台机器上没有 Ollama」—— 那时候才该提示去下载。

     ⚠ 每一步都只是读系统自己的登记信息、或找用户自己装的那个文件，
     认的是「这台机器上有什么」，不含任何开发者本机路径。 */
  let finding = null;

  function modOf(name) {
    try { if (typeof require === 'function') return require(name); } catch (e) { /* 非 Node 环境 */ }
    return null;
  }

  function lsRead(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }

  function lsWrite(k, v) {
    try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  function pathExists(p) {
    const fs = modOf('fs');
    if (!fs || !p) return false;
    try { return !!fs.statSync(p); } catch (e) { return false; }
  }

  function exeExists(p) {
    const fs = modOf('fs');
    if (!fs || !p) return false;
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }
  }

  /* 跑一条短命令拿 stdout。没有 Node / 命令不存在 / 超时 → 空串。
     「找 Ollama」这件事本身绝不能抛错，也不能因为某条命令慢就卡住启动。 */
  function runCmd(file, args, timeout) {
    const cp = modOf('child_process');
    if (!cp || !file) return Promise.resolve('');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (s) => { if (!settled) { settled = true; resolve(String(s || '')); } };
      try {
        cp.execFile(file, args, {
          windowsHide: true,
          timeout: timeout || 3000,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf8'
        }, (err, stdout) => finish(stdout));
      } catch (e) { finish(''); }
    });
  }

  function winSysExe(name) {
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return root + '\\System32\\' + name;
  }

  /* 从命令输出里挑 exe：既认直接给出的 ollama.exe，也认目录（其后拼 ollama.exe）。
     注册表里 DisplayIcon 常写成 `...\ollama app.exe,0`，尾部那个 ,0 要削掉。 */
  function pickExeFromText(text) {
    const pathMod = modOf('path');
    const out = [];
    const re = /([A-Za-z]:\\[^\r\n\t"']+)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      let p = m[1].trim().replace(/,\s*\d+$/, '').replace(/[,\s]+$/, '').replace(/^"|"$/g, '');
      if (!p) continue;
      if (/\.exe$/i.test(p)) {
        const base = p.split(/[\\/]/).pop().toLowerCase();
        if (base === 'ollama.exe' && exeExists(p)) out.push(p);
        else if (pathMod && base.indexOf('ollama') === 0) {
          /* 注册表里也常给 `ollama app.exe`（托盘启动器），命令行不认它，
             取同目录的 ollama.exe —— 这才是能带 serve 参数的那个。 */
          const sibling = pathMod.join(pathMod.dirname(p), 'ollama.exe');
          if (exeExists(sibling)) out.push(sibling);
        }
      } else if (pathMod && pathExists(p)) {
        const cand = pathMod.join(p, 'ollama.exe');
        if (exeExists(cand)) out.push(cand);
      }
    }
    return out;
  }

  /* 问系统：PATH / 运行中的进程 / 卸载表。三步都便宜，且都是「系统已经登记过的信息」。 */
  async function probeSystemExe() {
    const plat = servePlatform();
    const pathMod = modOf('path');
    if (!pathMod) return null;

    if (plat === 'win32') {
      const where = await runCmd(winSysExe('where.exe'), ['ollama.exe'], 2500);
      const hit = where.split(/\r?\n/).map((s) => s.trim())
        .filter((p) => /ollama\.exe$/i.test(p) && exeExists(p));
      if (hit.length) return { path: hit[0], source: 'PATH' };

      /* 托盘版（ollama app.exe）一开机就常驻，它的目录里一定有 ollama.exe。
         从跑着的进程反查路径，比猜安装位置准得多。 */
      const ps = await runCmd(winSysExe('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"
      ], 4000);
      const fromPs = pickExeFromText(ps);
      if (fromPs.length) return { path: fromPs[0], source: '运行中的进程' };

      const reg = winSysExe('reg.exe');
      const keys = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      ];
      for (let i = 0; i < keys.length; i++) {
        const out = await runCmd(reg, ['query', keys[i], '/s', '/f', 'ollama', '/t', 'REG_SZ'], 3500);
        const reg1 = pickExeFromText(out);
        if (reg1.length) return { path: reg1[0], source: '安装记录' };
      }
      return null;
    }

    const which = await runCmd('which', ['ollama'], 2000);
    const first = which.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && exeExists(first)) return { path: first, source: 'PATH' };

    const psOut = await runCmd('ps', ['-axo', 'comm='], 2500);
    const line = psOut.split(/\r?\n/).map((s) => s.trim()).filter((s) => /(^|\/)ollama$/.test(s))[0];
    if (line && exeExists(line)) return { path: line, source: '运行中的进程' };
    return null;
  }

  /* 这些目录里不可能有 ollama.exe，进一次就白花时间（AppData 里的标准位置已单独查过） */
  const SKIP_DIRS = {
    'node_modules': 1, '.git': 1, '.svn': 1, '.hg': 1, '.cache': 1, '.gradle': 1,
    '.nuget': 1, '.cargo': 1, '.npm': 1, 'appdata': 1, 'application data': 1,
    'windows': 1, 'programdata': 1, '$recycle.bin': 1, 'system volume information': 1,
    'temp': 1, 'tmp': 1, '.trash': 1
  };

  /* 兜底扫盘：广度优先、有预算、可随时中断。
     用户点「自动查找」时给 9 秒，开机流程自己找时给 6.5 秒 —— 正常情况下
     家目录那一层就走到了（实测几十毫秒），预算是给「盘特别大 / 文件特别碎」留的余量。
     rootsOverride 只给测试用：不传就走上面那套真实根目录。 */
  async function scanDisk(budgetMs, rootsOverride) {
    const fs = modOf('fs');
    const pathMod = modOf('path');
    const os = modOf('os');
    if (!fs || !pathMod || !fs.promises || !fs.promises.readdir) return '';
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const home = (os && os.homedir) ? os.homedir() : '';
    const plat = servePlatform();

    const roots = [];
    const add = (dir, depth) => {
      if (!dir) return;
      if (roots.some((r) => r.dir.toLowerCase() === String(dir).toLowerCase())) return;
      roots.push({ dir, depth });
    };
    /* 顺序有讲究：家目录最可能藏绿色版；系统盘根目录放最后，避免先在
       C:\Program Files 里绕一大圈把预算耗光。 */
    if (rootsOverride && rootsOverride.length) {
      rootsOverride.forEach((r) => add(r.dir, r.depth || 4));
    } else {
      add(home, 5);
      if (plat === 'win32') {
        add(env.ProgramFiles, 3);
        add(env['ProgramFiles(x86)'], 3);
        add(env.LOCALAPPDATA ? env.LOCALAPPDATA + '\\Programs' : '', 3);
        ['D:\\', 'E:\\', 'F:\\', 'G:\\', 'C:\\'].forEach((d) => { if (pathExists(d)) add(d, 3); });
      } else {
        add('/Applications', 3);
        add('/opt', 4);
        add('/usr/local', 3);
        add('/snap', 3);
        add('/home', 5);
      }
    }

    const seen = Object.create(null);
    const t0 = Date.now();
    const budget = budgetMs || 7000;
    let visited = 0;

    /* 逐个根目录单独走 BFS，而不是把根目录塞进同一个队列。
       塞在一起时，C:\ 这种大盘会先被弹出、把预算吃光，家目录里那层子目录
       永远轮不到 —— 实测就是这样：绿色版明明在 C:\Users\me\... 里，却报没找到。 */
    for (let r = 0; r < roots.length; r++) {
      const queue = [{ dir: roots[r].dir, d: 0, max: roots[r].depth }];
      while (queue.length) {
        if (Date.now() - t0 > budget) return '';
        if (visited > 40000) return '';
        const cur = queue.shift();
        const key = String(cur.dir).toLowerCase().replace(/[\\/]+$/, '');
        if (seen[key]) continue;
        seen[key] = 1;

        let ents = null;
        try { ents = await fs.promises.readdir(cur.dir, { withFileTypes: true }); }
        catch (e) { continue; }               // 没权限 / 目录已删：跳过，不中断
        visited++;

        for (let i = 0; i < ents.length; i++) {
          const ent = ents[i];
          const name = String(ent.name || '');
          const low = name.toLowerCase();
          let isDir = false;
          try { isDir = ent.isDirectory(); } catch (e) { isDir = false; }
          if (isDir) {
            if (SKIP_DIRS[low]) continue;
            if (name.charAt(0) === '.') continue;       // 隐藏目录基本是缓存
            if (cur.d + 1 <= cur.max) {
              queue.push({ dir: pathMod.join(cur.dir, name), d: cur.d + 1, max: cur.max });
            }
          } else if (low === 'ollama.exe' || (plat !== 'win32' && low === 'ollama')) {
            return pathMod.join(cur.dir, name);
          }
        }
      }
    }
    return '';
  }

  function rememberExe(p) {
    if (!p) return;
    lsWrite(LS_EXE_HINT, p);
  }

  /* 给界面用：现在认为 ollama.exe 在哪、是怎么找到的 */
  function exeHint() {
    const p = lsRead(LS_EXE_HINT);
    return p && exeExists(p) ? p : '';
  }

  /* 主入口：返回 { path, source } 或 null。
     cheap=true 只做第 1~3 步（几次 statSync，开机路径专用）；
     否则继续问系统与扫盘。并发调用共享同一次查找，不会扫两遍。
     opts.auto=true 表示「开机流程自己找的」：24 小时内扫过且没扫到就不再扫，
     免得没装 Ollama 的人每次开插件都白扫一遍盘。 */
  async function findOllamaExe(opts) {
    const o = opts || {};
    if (!modOf('fs')) return null;

    const quick = [];
    const remembered = lsRead(LS_EXE_HINT);
    if (remembered) quick.push({ path: remembered, source: '上次找到' });
    try { const c = getLocal(); if (c.exe) quick.push({ path: c.exe, source: '设置' }); } catch (e) { /* ignore */ }
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    if (env.OLLAMA_EXE) quick.push({ path: env.OLLAMA_EXE, source: '环境变量' });
    ollamaExeCandidates().forEach((p) => quick.push({ path: p, source: '标准位置' }));
    for (let i = 0; i < quick.length; i++) {
      if (exeExists(quick[i].path)) {
        /* 找到了就记下来：下次开机第一次 statSync 就命中，连标准位置都不用试 */
        if (quick[i].source !== '上次找到') rememberExe(quick[i].path);
        return quick[i];
      }
    }

    if (o.cheap) return null;
    if (finding) return finding;

    finding = (async () => {
      const sys = await probeSystemExe();
      if (sys) { rememberExe(sys.path); return sys; }
      if (o.scan === false) return null;

      const lastScan = parseInt(lsRead(LS_SCAN_AT), 10) || 0;
      if (o.auto && lastScan && Date.now() - lastScan < 12 * 3600 * 1000) return null;

      const hit = await scanDisk(o.budget || 6500);
      lsWrite(LS_SCAN_AT, String(Date.now()));
      if (hit) { rememberExe(hit); return { path: hit, source: '本机扫描' }; }
      return null;
    })().finally(() => { finding = null; });
    return finding;
  }

  async function ensureServe(opts) {
    const o = opts || {};
    const cfg = getLocal();
    const now = Date.now();
    if (serveHint.okAt && now - serveHint.okAt < 5000) return true;
    try {
      await fetchJson(cfg.url + '/api/tags', null, 1200);
      serveHint.okAt = now;
      return true;
    } catch (e) { /* 服务没起来，往下试着拉 */ }
    if (starting) return starting;
    if (serveHint.triedAt && now - serveHint.triedAt < 10000) return false;  // 刚试过，别连点连拉
    /* 上一次整轮都没拉起来（没装 / 装错位置）。短时间内别再试，
       否则每开一次文档就再闪一遍窗，看着像插件在后台乱跑东西。 */
    if (serveHint.giveUpAt && now - serveHint.giveUpAt < 30000) return false;

    starting = (async () => {
      serveHint.triedAt = Date.now();
      let cp = null;
      let fs = null;
      try {
        if (typeof require === 'function') { cp = require('child_process'); fs = require('fs'); }
      } catch (e) { /* 没有 Node 就拉不起来，交给调用方报错 */ }
      if (!cp) return false;
      /* 找 exe：先看设置 / 环境变量 / 标准安装位置（几次 statSync）；
         都没有就去问系统 —— PATH、正在跑的 ollama 进程、卸载表登记位置；
         最后才按预算扫一遍常见目录。以前只看标准位置，
         解压即用版 / 装在别的盘的一律被判成「没装」，用户因此被要求手填路径。 */
      let found = await findOllamaExe({ cheap: true });
      if (!found) found = await findOllamaExe({ auto: !!o.auto, budget: o.budget || 6500 });
      if (!found) {
        serveHint.giveUpAt = Date.now();   // 七步都没找到：确实没装，歇 30 秒再试
        return false;
      }
      const exes = [found.path];
      for (let i = 0; i < exes.length; i++) {
        const exe = exes[i];
        try {
          if (fs && !fs.existsSync(exe)) continue;
          /* Ollama 默认上下文只有 2048，一个长段落加译文就会被静默截断；
             单并发会让分块翻译排队，两块就是两倍时间。 */
          const env = Object.assign({}, (typeof process !== 'undefined' && process.env) ? process.env : {}, {
            OLLAMA_HOST: '127.0.0.1:11434',
            OLLAMA_KEEP_ALIVE: KEEP_ALIVE,
            OLLAMA_CONTEXT_LENGTH: '8192',
            OLLAMA_NUM_PARALLEL: '2'
          });
          const spawnOpts = { stdio: 'ignore', windowsHide: true, env };
          /* Windows 上绝不能带 detached：Node 在 detached 分支里不传 CREATE_NO_WINDOW，
             windowsHide 形同虚设，`ollama serve` 的黑色控制台会闪一下。 */
          if (servePlatform() !== 'win32') spawnOpts.detached = true;
          if (typeof require === 'function') {
            try { spawnOpts.cwd = require('path').dirname(exe); } catch (e) { /* ignore */ }
          }
          const child = cp.spawn(exe, ['serve'], spawnOpts);
          if (child && child.unref) child.unref();
        } catch (e) { continue; }
        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          await new Promise((r) => setTimeout(r, 400));
          try {
            await fetchJson(cfg.url + '/api/tags', null, 1500);
            serveHint.okAt = Date.now();
            return true;
          } catch (e) { /* 还在起 */ }
        }
      }
      serveHint.giveUpAt = Date.now();     // 整轮没成功，歇 30 秒再试
      return false;
    })().finally(() => { starting = null; });
    return starting;
  }

  /* 代跑 ollama pull（v3.16）：缺视觉模型时不再让用户开终端复制命令。
     spawn 输出按行吐给 onLine（pull 的进度都在 stderr 里，\r 刷的那種也按行拆）；
     退出码 0 才算成功。找不到 exe / 没 Node / 进程报错 → false，绝不抛。 */
  function pullModel(model, onLine) {
    return new Promise((resolve) => {
      let cp = null;
      try { if (typeof require === 'function') cp = require('child_process'); } catch (e) { /* ignore */ }
      const name = String(model || '').trim();
      if (!cp || !name) { resolve(false); return; }
      findOllamaExe({ cheap: true }).then((found) => {
        const exe = found && found.path;
        if (!exe) { resolve(false); return; }
        let child = null;
        try {
          child = cp.spawn(exe, ['pull', name], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          });
        } catch (e) { resolve(false); return; }
        let buf = '';
        const emit = (raw) => {
          const line = String(raw || '').replace(/\r/g, '').trim();
          if (!line) return;
          try { if (onLine) onLine(line); } catch (e) { /* ignore */ }
        };
        const onChunk = (d) => {
          buf += String(d);
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          lines.forEach(emit);
        };
        child.stdout && child.stdout.on && child.stdout.on('data', onChunk);
        child.stderr && child.stderr.on && child.stderr.on('data', onChunk);
        child.on('error', () => resolve(false));
        child.on('close', (code) => { emit(buf); resolve(code === 0); });
      }).catch(() => resolve(false));
    });
  }

  /* 预热：模型闲置到 KEEP_ALIVE 就会被 Ollama 从显存卸掉，下一次划词要等 4 秒加载。
     打开文档时先问一句 /api/ps——还在显存就不打扰，真被卸了才发一个 1 token 的
     请求把它顶回去。用 /api/ps 而不是记时间戳，保活时长怎么调都不会失准。
     没装 Ollama 的用户这里静默返回 false。 */
  let warming = null;

  async function onGpu(cfg) {
    try {
      const j = await fetchJson(cfg.url + '/api/ps', null, 4000);
      const list = (j && j.models) || [];
      const want = String(cfg.model).toLowerCase();
      return list.some((m) => {
        const n = String(m.name || m.model || '').toLowerCase();
        return n === want || n === want + ':latest' || n.indexOf(want + ':') === 0;
      });
    } catch (e) {
      return false;
    }
  }

  function warmup() {
    if (warming) return warming;
    warming = (async () => {
      try {
        /* 打开文档时**只预热、不拉服务**。
           拉服务 = spawn 一个进程，在 Windows 上很容易闪一下窗框。预热本身就是锦上添花，
           绝不能有副作用 —— 服务没跑就安静放弃，等用户真的点翻译 / OCR 时再拉（ensureServe）。 */
        const cfg = await probeLocal(true, true);
        if (!cfg || !cfg.url || !cfg.model) return false;
        if (await onGpu(cfg)) return false;         // 已经热着，不必再发请求
        await fetchJson(cfg.url + '/api/chat', {
          model: cfg.model,
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { num_predict: 1, temperature: 0 },
          messages: [{ role: 'user', content: 'hi' }]
        }, 60000);                                 // 冷加载 4–10 秒，给足余量
        return true;
      } catch (e) {
        return false;
      } finally {
        warming = null;
      }
    })();
    return warming;
  }

  /* ---------- 图片文字识别（OCR）----------
     走本机 Ollama 的视觉模型（qwen2.5vl / llava / minicpm-v 之类）。
     整张图不出本机；没装视觉模型就明确报错说该 pull 哪个，绝不偷偷走联网 OCR —— 
     视频截图里可能有不该外传的内容。 */
  async function pickVisionModel(cfg) {
    if (cfg && cfg.model && VISION_RE.test(cfg.model)) return cfg.model;
    const j = await fetchJson(cfg.url + '/api/tags', null, 4000);
    const list = ((j && j.models) || []).map((m) => m.name).filter(Boolean);
    return list.find((n) => VISION_RE.test(n)) || '';
  }

  async function ocrImage(dataUrl, opts) {
    if (!dataUrl) throw new Error('没有图片');
    /* 点 OCR 就代表要用模型：服务没在跑先拉起来，别让用户去翻 bat */
    await ensureServe();
    const cfg = await probeLocal(true, true);
    if (!cfg || !cfg.url) {
      /* 这里是新用户最容易撞上的一堵墙，文案必须自己说清楚下一步怎么走：
         别写本机路径、别写 bat 文件名，别人机器上不存在那种东西。 */
      throw new Error('OCR 需要本地视觉模型，本机还没装 Ollama。'
        + '上 ollama.com/download 装好后执行 ollama pull ' + VISION_SUGGEST + '，'
        + '再回插件打开右栏「本地增强」点重新检测。翻译不受影响，会自动走在线通道。');
    }
    const model = await pickVisionModel(cfg);
    if (!model) {
      throw new Error('Ollama 已在运行，但还没有视觉模型。终端执行 ollama pull ' + VISION_SUGGEST + ' 即可。');
    }
    const b64 = String(dataUrl).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    if (!b64) throw new Error('图片数据为空');
    const tip = (opts && opts.prompt)
      || '把这张图片里的所有文字逐行提取出来，保持原有的分行和顺序。'
        + '只输出文字本身，不要任何解释、标题或 Markdown 代码块。'
        + '数字、英文、公式符号按原样保留，不要翻译。'
        + '看不清的字用 □ 代替，不要猜测。如果图里确实没有文字，输出空。';
    const j = await fetchJson(cfg.url + '/api/chat', {
      model,
      stream: false,
      /* 视觉模型比翻译模型更占显存（qwen2.5vl:7b 约 6.2 GB），12 GB 卡上装不下两个。
         所以让它早点让位：OCR 是低频操作，翻译是高频，别让 VL 长期占着显存。
         5 分钟和翻译侧的 KEEP_ALIVE 对齐 —— 看文献是集中式的，5 分钟不动基本就是走了。 */
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'user', content: tip, images: [b64] }]
    }, 120000);                      // 视觉模型首帧加载较慢，给足两分钟
    const out = j && j.message && j.message.content;
    if (out == null) throw new Error('模型没有返回内容');
    const text = String(out)
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    return tidyOcr(text);
  }

  /* 视觉模型爱在每两行之间插一个空行（实测 qwen2.5vl 稳定如此），
     原文并没有这种排版。如果空行数≥正文行数-1，就认定是模型口癖，折叠掉。 */
  function tidyOcr(s) {
    const lines = String(s).split('\n');
    const solid = lines.filter((l) => l.trim());
    if (solid.length >= 3 && (lines.length - solid.length) >= solid.length - 1) {
      return solid.join('\n');
    }
    return String(s).replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------- 公共 GET 接口 ---------- */
  async function requestJson(url, timeout) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctrl) timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeout || TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return JSON.parse(await res.text());
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---------- 有道「免密钥」接口（3.3.3 新增，主力） ----------
     aidemo.youdao.com 是网页端在用的公开接口：国内直连、不用密钥、通常 200–300ms，
     质量比 MyMemory 好一档。代价是有频率限制（errorCode 411）和 500 字上限，
     所以：① 分段在 450 字；② 只允许 2 个并发，超出的排一下队。 */
  const freeQueue = { active: 0, limit: 2, wait: [] };

  function freeSlot() {
    if (freeQueue.active < freeQueue.limit) { freeQueue.active++; return Promise.resolve(); }
    return new Promise((resolve) => freeQueue.wait.push(resolve));
  }

  function freeRelease() {
    const next = freeQueue.wait.shift();
    if (next) next();                 // 名额直接转交，active 不变
    else freeQueue.active = Math.max(0, freeQueue.active - 1);
  }

  async function youdaofree(text, target) {
    const to = target === 'en' ? 'en' : 'zh-CHS';
    const url = 'https://aidemo.youdao.com/trans?from=auto&to=' + to
      + '&q=' + encodeURIComponent(text);
    await freeSlot();
    let j = null;
    try {
      j = await requestJson(url, 4000);
    } finally {
      freeRelease();
    }

    /* 411 = 撞到频率限制。**不重试**：重试只会多等半秒再失败，
       直接抛出去让兜底线路立刻接手（MyMemory 通常 700–900ms 就有结果），
       用户体感是「慢一点但能用」，而不是「转圈三秒然后报错」。 */
    const code = j && j.errorCode;
    if (code != null && String(code) !== '0') throw new Error('有道免密钥接口 errorCode ' + code);

    /* 返回体有两种格式，都要认：
         translation:     ["译文"]                       ← aidemo 现在的格式
         translateResult: [[{src, tgt}, ...], ...]        ← 老版 / 网页端格式 */
    let out = '';
    const tr = j && j.translation;
    if (typeof tr === 'string') out = tr;
    else if (Array.isArray(tr)) out = tr.map((x) => (typeof x === 'string' ? x : ((x && x.tgt) || ''))).join('');
    if (!out && j && Array.isArray(j.translateResult)) {
      out = j.translateResult
        .map((seg) => (Array.isArray(seg) ? seg.map((x) => (x && x.tgt) || '').join('') : String(seg || '')))
        .join('');
    }
    out = String(out || '').trim();
    if (!out) throw new Error('有道免密钥接口返回为空');
    if (out === String(text).trim()) throw new Error('有道免密钥接口未翻译');
    return { text: out };
  }

  const PROVIDERS = [
    {
      id: 'google',
      label: 'Google',
      timeout: 4000,
      url: (text, target) => 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
        + encodeURIComponent(target) + '&dt=t&dj=1&q=' + encodeURIComponent(text),
      pick: (r) => {
        if (!r || !Array.isArray(r.sentences)) return null;
        const s = r.sentences.map((x) => (x && x.trans) || '').join('');
        return s ? { text: String(s).trim(), src: r.src || '' } : null;
      }
    },
    {
      id: 'google-arr',
      label: 'Google',
      timeout: 4000,
      url: (text, target) => 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
        + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text),
      pick: (r) => {
        if (!Array.isArray(r) || !Array.isArray(r[0])) return null;
        const s = r[0].map((x) => (x && x[0]) || '').join('');
        return s ? { text: String(s).trim(), src: r[2] || '' } : null;
      }
    },
    {
      id: 'mymemory',
      label: 'MyMemory',
      timeout: 6000,
      url: (text, target, src) => 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
        + '&langpair=' + encodeURIComponent((src || (target === 'en' ? 'zh-CN' : 'en')) + '|' + target),
      pick: (r) => {
        const t = r && r.responseData && r.responseData.translatedText;
        if (!t) return null;
        return { text: String(t).trim(), src: '' };
      }
    }
  ];

  /* ---------- 竞速 + 对冲（3.3.3） ----------

     之前的写法是「先等一线引擎（本地 / 有道），全失败再一个个试公共接口」：
     在没有密钥、Google 又被墙的机器上，一线引擎是空的，于是老老实实等 Google 超时 4s、
     再等第二个 Google 变体再超时 4s，最后才轮到 MyMemory —— 一次翻译 8 秒起步。

     现在改成对冲：一线引擎（有道免密钥 / 本地模型）先跑；
     1.2 秒还没结果，就把 Google / MyMemory 一起放出去，谁先回用谁，其余结果直接丢弃。
     一线引擎秒回时，公共接口根本不会被唤醒。 */
  /* 每个通道最近一次的成败：界面上「哪条能用」不能只靠静态配置猜，
     有道免密钥被限频、Google 被墙，都是真实会遇到的情况。
     这里只记内存，不持久化 —— 网络状况换一次 Wi-Fi 就全变了。 */
  const stats = {};

  function noteStat(id, ok, ms, err) {
    if (!id) return;
    const cur = stats[id] || {};
    if (ok) { cur.okAt = Date.now(); cur.ms = ms; cur.err = ''; }
    else { cur.failAt = Date.now(); cur.err = String(err || '').slice(0, 80); }
    stats[id] = cur;
  }

  function raceWithHedge(primary, fallback, hedgeMs) {
    return new Promise((resolve) => {
      let settled = false;
      let running = 0;
      let startedFb = false;
      const errors = [];
      let timer = null;

      const settleFail = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ failed: true, errors });
      };

      const startFallback = () => {
        if (settled || startedFb) return;
        startedFb = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (!fallback.length) {
          if (running === 0) settleFail();
          return;
        }
        fallback.forEach(start);
      };

      const idle = () => {
        if (settled || running > 0) return;
        if (!startedFb) { startFallback(); return; }
        settleFail();                 // 两轮全挂
      };

      function start(job) {
        running++;
        const t0 = Date.now();
        Promise.resolve()
          .then(job.run)
          .then((out) => {
            const t = String(out == null ? '' : out).trim();
            if (settled) return;
            if (!t) throw new Error('空结果');
            settled = true;
            noteStat(job.id, true, Date.now() - t0);
            if (timer) clearTimeout(timer);
            resolve({ id: job.id, text: t });
          })
          .catch((e) => {
            noteStat(job.id, false, Date.now() - t0, (e && e.message) || e);
            errors.push((job.label || job.id) + '：' + ((e && e.message) || e));
          })
          .then(() => { running--; idle(); });
      }

      if (!primary.length) { startFallback(); }
      else {
        primary.forEach(start);
        timer = setTimeout(() => { timer = null; startFallback(); }, hedgeMs || HEDGE_MS);
      }
    });
  }

  /* 单个公共接口跑一次。
     每个接口自己的长度上限不一样：MyMemory 500 字就翻脸，Google 能吃几千字。
     所以这里按 provider 再切一次，别让兜底线路因为「太长」而白白失败。 */
  async function runProvider(p, text, target, opts) {
    const cap = p.id === 'mymemory'
      ? (U.cjkRatio(String(text)) > 0.3 ? 300 : MYMEMORY_MAX)
      : 4000;
    if (String(text).length > cap) {
      const segs = splitText(String(text), cap);
      const outs = [];
      for (const seg of segs) outs.push(await runProvider(p, seg, target, opts));
      return outs.join('\n');
    }
    const json = await requestJson(p.url(text, target, opts && opts.source), (opts && opts.timeout) || p.timeout);
    const got = p.pick(json);
    const out = got && got.text ? String(got.text).trim() : '';
    if (!out) throw new Error('返回为空');
    /* MyMemory 偶尔原样回显，等于没翻 */
    if (out === String(text).trim()) throw new Error('未翻译');
    return out;
  }

  /* 单块翻译：一线引擎竞速 → 对冲公共接口 */
  async function translateOnce(text, target, opts) {
    const primary = [];

    const local = await probeLocal();
    /* 本地模型是唯一能吃到「上下文 + 术语表」的通道（在线接口没有这个能力），
       所以准确度提升的收益也全在这条路上。 */
    if (local && local.model) {
      primary.push({ id: 'local', label: '本地模型', run: () => ollamaChecked(text, target, local, opts) });
    }
    primary.push({ id: 'youdao-free', label: '有道（免密钥）', run: () => youdaofree(text, target).then((r) => r.text) });

    const fallback = PROVIDERS.map((p) => ({
      id: p.id, label: p.label, run: () => runProvider(p, text, target, opts)
    }));

    const won = await raceWithHedge(primary, fallback, HEDGE_MS);
    if (won.failed) return { ok: false, errors: won.errors };
    return { ok: true, text: won.text, provider: won.id };
  }

  /* ---------- 长文分段 ----------
     按「段落 → 句子 → 逗号 → 硬切」四级退让，尽量不把一句话劈开。 */
  function splitText(text, max) {
    const src = String(text);
    if (src.length <= max) return [src];

    const parts = [];
    let buf = '';
    const push = (s) => {
      if (s) parts.push(s);
    };
    /* 先按段落切，段落还长就按句末标点切 */
    const paras = src.split(/(\n{1,})/);
    const pieces = [];
    paras.forEach((p) => {
      if (!p) return;
      if (/^\n+$/.test(p)) { pieces.push(p); return; }
      if (p.length <= max) { pieces.push(p); return; }
      let s = p;
      let guard = 0;
      while (s.length > max && guard++ < 500) {
        const seg = s.slice(0, max);
        /* 找出 seg 里最后一个句末标点，尽量整句切 */
        let at = -1;
        const re = /[。！？!?；;…]+["'”’）)]*/g;
        let m;
        while ((m = re.exec(seg))) at = m.index + m[0].length;
        if (at < max * 0.4) {
          const comma = Math.max(seg.lastIndexOf('，'), seg.lastIndexOf(', '), seg.lastIndexOf('、'));
          at = comma > max * 0.5 ? comma + 1 : max;
        }
        pieces.push(s.slice(0, at));
        s = s.slice(at);
      }
      if (s) pieces.push(s);
    });

    pieces.forEach((p) => {
      if (buf.length + p.length > max && buf) { push(buf); buf = ''; }
      if (p.length > max) { push(p); return; }
      buf += p;
    });
    if (buf) push(buf);
    return parts;
  }

  /* 分段并行：最多 3 块同时翻，结果按原顺序拼回去 */
  async function translateMulti(raw, target, opts) {
    const parts = splitText(raw, CHUNK);
    if (parts.length <= 1) {
      const r = await translateOnce(raw, target, opts);
      if (!r.ok) return { ok: false, errors: r.errors || [] };
      return { ok: true, text: r.text, provider: r.provider, chunks: 1 };
    }
    const out = new Array(parts.length);
    let provider = '';
    let cursor = 0;
    let failure = null;

    async function worker() {
      while (!failure) {
        const i = cursor++;
        if (i >= parts.length) return;
        const r = await translateOnce(parts[i], target, opts);
        if (!r.ok) { failure = r.errors || ['翻译失败']; return; }
        out[i] = r.text;
        provider = provider || r.provider;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker));
    if (failure) return { ok: false, errors: failure };
    return { ok: true, text: out.join('\n'), provider, chunks: parts.length };
  }

  /* 选中即预翻译：只填充缓存，不产生任何 UI 副作用 */
  const prefetching = new Map();
  function prefetch(text, target) {
    const raw = String(text || '').trim();
    if (!raw || raw.length < 2) return null;
    const tg = target || guessTarget(raw);
    const key = keyOf(raw, tg) + gsig(pickGlossary(raw));
    if (loadCache().has(key) || prefetching.has(key)) return prefetching.get(key) || null;
    const p = translate(raw, { target: tg, silent: true })
      .catch(() => null)
      .finally(() => { prefetching.delete(key); });
    prefetching.set(key, p);
    return p;
  }

  /* 返回 { ok, text, src, target, provider, cached, ms, chunks } 或 { ok:false, error, detail } */
  async function translate(text, opts) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, error: '没有可翻译的文字' };
    if (raw.length > MAX_TOTAL) return { ok: false, error: `选中的文字太长（超过 ${MAX_TOTAL} 字）` };

    const options = opts || {};
    const target = options.target || guessTarget(raw);
    const map = loadCache();
    /* 术语表命中的条目一起参与缓存键：改了对照表，旧译文必须失效 */
    const gloss = pickGlossary(raw);
    const key = keyOf(raw, target) + gsig(gloss) + ctxsig(options.context);
    if (map.has(key)) return Object.assign({ ok: true, cached: true, ms: 0 }, map.get(key));

    /* 选中文字时已经预翻译过（prefetch），这里直接等那一份，不要再发一遍。
       以前是各跑一次，用户点上「翻译」就等于把等待时间翻倍。 */
    const pend = prefetching.get(key);
    if (pend) {
      try { await pend; } catch (e) { /* 预翻译失败就走正常流程 */ }
      const m2 = loadCache();
      if (m2.has(key)) return Object.assign({ ok: true, cached: true, ms: 0 }, m2.get(key));
    }

    const t0 = Date.now();
    /* 走到这里说明缓存没有：翻译即「要用本地模型」，先确保服务活着 */
    try { await ensureServe(); } catch (e) { /* ignore */ }
    const got = await translateMulti(raw, target, Object.assign({}, options, { glossary: gloss }));
    if (!got.ok) {
      const local = getLocal();
      return {
        ok: false,
        error: '翻译失败：当前网络访问不到翻译接口',
        detail: (got.errors || []).join('；'),
        hint: local.model
          ? '可点 ⚙ 检查本地模型是否在运行（ollama serve）'
          : '可点 ⚙ 配置本地模型（Ollama）后重试'
      };
    }

    const result = { text: got.text, src: '', target, provider: got.provider, chunks: got.chunks || 1 };
    map.set(key, result);
    persistCache();
    return Object.assign({ ok: true, ms: Date.now() - t0 }, result);
  }

  /* ---------- 运行时状态：服务在不在、模型在不在显存里 ----------

     「模型是开着还是关掉了」只有一个可信来源：/api/ps。它列的就是此刻真正占着
     显存的模型；用「上次调用时间 + keep_alive」自己算会失准（模型可能被别的
     程序挤掉，keep_alive 也可能被用户改过）。这里只问一次、只读不写。

     ⚠ 不能顺手把模型顶回显存（那就是 warmup 的活）：右栏每隔十几秒刷一次状态，
     每次都发推理请求的话，模型永远闲不下来，显存 5 分钟也放不掉。 */
  function sameModel(a, b) {
    const x = String(a || '').toLowerCase();
    const y = String(b || '').toLowerCase();
    if (!x || !y) return false;
    return x === y || x === y + ':latest' || y === x + ':latest'
      || x.indexOf(y + ':') === 0 || y.indexOf(x + ':') === 0;
  }

  async function psInfo() {
    const cfg = getLocal();
    /* queried 是「这次问到了没有」，和 serve（服务在不在）不是一个意思：
       问不到可能是服务没了，也可能只是一次超时，让调用方自己决定怎么降级。 */
    const out = { serve: false, models: [], vision: '', chat: '', queried: false };
    try {
      const j = await fetchJson(cfg.url + '/api/ps', null, 1200);
      out.serve = true;
      out.queried = true;
      out.models = ((j && j.models) || []).map((m) => ({
        name: String(m.name || m.model || ''),
        vram: Number(m.size_vram || 0),
        until: String(m.expires_at || '')
      })).filter((m) => m.name);
      const v = out.models.filter((m) => VISION_RE.test(m.name));
      out.vision = v.length ? v[0].name : '';
      const c = out.models.filter((m) => !VISION_RE.test(m.name));
      out.chat = c.length ? c[0].name : '';
    } catch (e) { /* 服务没跑：serve 保持 false */ }
    return out;
  }

     /* 各渠道此刻能不能用。给界面看的一份快照：
        - 本地模型问 /api/tags + /api/ps（真实可用性，还带「是否已在显存」）；
        - 有道免密钥 / Google / MyMemory 是国内能直连的公开通道，标为可用，
       真出问题会在翻译时报错并自动换下一条 —— 每开一次翻译框就 ping 一遍公网
       既慢又吵，不值得。 */
  async function channels() {
    const cfg = await probeLocal(false, true);
    const ps = await psInfo();
    const localModel = (cfg && cfg.model) || '';
    const withStat = (row) => {
      const st = stats[row.id] || null;
      /* 只留最近一次：成功过就显示耗时，失败过就说明原因。
         成功之后又失败，仍然以「最近一次失败」提示，但 ok 不翻成 false ——
         偶发失败不等于这条通道不能用。 */
      if (st) {
        const last = st.okAt && (!st.failAt || st.okAt >= st.failAt) ? 'ok' : 'fail';
        row.last = last;
        row.lastMs = last === 'ok' ? st.ms : 0;
        row.lastErr = last === 'fail' ? st.err : '';
        row.failed = last === 'fail';
      }
      return row;
    };
    const list = [
      {
        id: 'local',
        label: '本地模型',
        /* 有模型名 + 服务在跑才算可用；服务没跑时点它会把服务拉起来 */
        ok: !!(localModel && ps.serve),
        hot: !!(localModel && ps.models.some((m) => sameModel(m.name, localModel))),
        detail: !ps.serve
          ? 'Ollama 未运行'
          : (!localModel ? '没有可用的对话模型' : localModel)
      },
      { id: 'youdao-free', label: '有道', ok: true, detail: '免密钥 · 国内直连' },
      { id: 'google', label: 'Google', ok: true, detail: '在线兜底' },
      { id: 'mymemory', label: 'MyMemory', ok: true, detail: '在线兜底' }
    ].map(withStat);
    return { list, serve: ps.serve, localModel, ps };
  }

  /* 手动把模型请出显存：给「看完文献想立刻收回显存」的人一个按钮，
     不用等 keep_alive 到点。keep_alive:0 是 Ollama 官方的卸载写法。 */
  async function unload(model) {
    const cfg = getLocal();
    if (!model) return false;
    try {
      await fetch(cfg.url + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0, stream: false })
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function providerLabel(id) {
    if (id === 'local') return '本地模型';
    if (id === 'youdao-free') return '有道';
    if (id === 'mymemory') return 'MyMemory';
    if (id && id.indexOf('google') === 0) return 'Google';
    return id || '';
  }

  function clearCache() {
    cache = new Map();
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  return {
    translate, prefetch, guessTarget, providerLabel, clearCache,
    getLocal, setLocal, probeLocal, splitText, looksUntranslated, warmup,
    ocrImage, pickVisionModel, tidyOcr, ensureServe, resetServeHint, KEEP_ALIVE,
    pullModel,
    psInfo, channels, unload, sameModel,
    VISION_SUGGEST, VISION_SMALL, OLLAMA_SITE, ollamaExeCandidates, servePlatform,
    findOllamaExe, exeHint, probeSystemExe, scanDisk,
    /* 术语表 / 上下文 */
    getGlossary, setGlossary, pickGlossary, parseGlossary, complete,
    /* 测试用 */
    _looksOverflowed: looksOverflowed
  };
})();

/* classic script 的 const 不挂 window，测试与调试需要显式挂一次 */
try { window.Translator = Translator; } catch (e) { /* ignore */ }
