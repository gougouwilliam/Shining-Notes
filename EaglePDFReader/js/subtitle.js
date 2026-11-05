/* 视频实时字幕面板（v3.10）

   上半截左栏：边播边出字。中文只显示原文，英文补一条中文译文（双语）。

   音频从哪儿来：直接从 <video> 节点抓。用 WebAudio 的 MediaElementSource 接进去，
   播放器解码出来的 PCM 就是现成的 —— 不用 ffmpeg、不用先把整个文件抽成 wav，
   任意浏览器能播的格式都能转写（mp4/mkv/mov/webm…），也不占额外内存。

   代价是「播到哪儿才转到哪儿」：跳过去还没播的地方没有字幕，这是实时字幕的正常行为，
   不假装能提前知道后面说什么。字幕**每次打开视频都从头生成**（v3.13），
   不读上次的结果；要留下来就点「导出」，md + 音频一起落到资料库的 _notes。
*/
const Subtitle = (function () {
  let fs = null, pathMod = null;
  try {
    if (typeof require === 'function') { fs = require('fs'); pathMod = require('path'); }
  } catch (e) { fs = null; pathMod = null; }

  let video = null;
  let actx = null;
  let srcNode = null;
  let proc = null;
  let resampler = null;
  let silentRuns = 0;
  let warnedSilent = false;
  let triedBlob = false;

  let on = false;            // 用户是否开启了字幕
  let running = false;       // 正在采集
  let busy = false;          // 正在准备引擎/模型
  let subs = [];             // [{ t, t1, text, zh, lang }]
  let partial = '';          // 正在说的这半句
  let curIdx = -1;           // 当前播放位置对应的条目
  let docKey = '';
  let docTitle = '';
  let follow = true;         // 列表是否跟着最新一句走（用户往回翻时自动让位）
  let gen = 0;               // 文档代次：切换 / 清空时 +1，异步任务据此判断自己是否过期
  let queue = [];            // 待翻译的条目下标
  let translating = false;

  /* ==================== 多选（v3.15） ====================
     字幕要能「挑几句存成笔记」，所以每条都要能被单独选上：
       · Ctrl / ⌘ + 点   加选 / 取消
       · Shift + 点      连选一段
       · Ctrl + A        全选
     存的时候按「连续段」分组：一段连续的字幕配一张图（它开头的那一帧），
     中间断开了就各自再配一张 —— 断处意味着话题换了，硬塞进同一张图是骗人。 */
  let sel = new Set();
  let selAnchor = -1;
  let saveHook = null;

  /* 精修（v3.12）：流式先出粗字幕，再把那几秒音频交给非流式模型重听一遍。
     队列串行执行 —— 并行只会让 CPU 打架，字幕反而更卡。 */
  let fixQ = [];
  let fixing = false;
  let fixCount = 0;          // 本轮精修改了多少条（给界面看效果）
  const LS_FIX = 'eaglenote.sub.fix';

  function fixEnabled() {
    try { const v = localStorage.getItem(LS_FIX); if (v === '0') return false; } catch (e) { /* ignore */ }
    return true;
  }

  function setFixEnabled(v) {
    try { localStorage.setItem(LS_FIX, v ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!v) { fixQ = []; }
  }

  /* ==================== 自动开启（v3.14） ====================
     以前每次打开视频都要手点一次「开启」，理由是「首次要下 212 MB、转写吃 CPU」。
     但引擎下好之后，这个理由就不成立了 —— 用户开视频是为了看字幕，不是来看引导页的。
     所以改成：引擎和模型都齐了就自动进采集待命（注意此时还没播，不吃 CPU），
     引擎没齐照旧显示引导页，绝不偷偷下载。

     「可以手动关闭」怎么落地：用户自己按「暂停」= 明确不想转这一路 → 记下来，
     下一个视频也不再自动开；用户再按一次「开启」→ 自动开恢复。
     播放结束 / 暂停视频不会改这个开关，否则看两集就得手动开一次。 */
  const LS_AUTO = 'eaglenote.sub.auto';

  function autoEnabled() {
    try { const v = localStorage.getItem(LS_AUTO); if (v === '0') return false; } catch (e) { /* ignore */ }
    return true;
  }

  function setAutoEnabled(v) {
    try { localStorage.setItem(LS_AUTO, v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* ==================== 语境矫正（v3.14） ====================
     精修那一遍（SenseVoice）能双向看整句，比流式准得多，但它仍然只看这一句。
     而「胆囊三角 / 单囊三角」这种错字，往往要靠前后文才能判出来 ——
     前一句在讲胆囊，这一句说什么都该往那边靠。

     所以再加一层：把最近几句 + 术语表一起交给本地大模型，让它只改「听错的音近字」。
     这一层是可选的（要装 Ollama），且**只在本地跑** —— 音频和字幕都不出网。
     它排在最慢的位置（精修之后），改不动也不影响字幕本身。 */
  const LS_CTX = 'eaglenote.sub.ctx';
  let ctxQ = [];
  let ctxing = false;
  let ctxCount = 0;

  /* ==================== 专业领域（v3.30） ====================
     医学 / 生命科学的视频，错得最多的不是常见字，而是专业词：
     「胆囊三角」听成「单囊三角」、「脾动脉」听成「皮动脉」——
     声学上都对，只是通用语料里另一个词更常见。

     所以除了用户自己的术语表，再内置一份领域词表（js/domainterms.js），
     用在两处：热词偏置（识别时就偏向这些词）+ 语境校对的提示词。
     领域是「按视频记」还是「全局记」？全局更省事 —— 一个人看的手术视频
     基本在同一个领域，每次打开都要重选反而烦。 */
  const LS_DOMAIN = 'eaglenote.sub.domain';

  function domain() {
    let raw = '';
    try { raw = localStorage.getItem(LS_DOMAIN) || ''; } catch (e) { raw = ''; }
    if (typeof DomainTerms === 'undefined') return 'general';
    return DomainTerms.normalize(raw);
  }

  function setDomain(spec) {
    const id = (typeof DomainTerms !== 'undefined') ? DomainTerms.normalize(spec) : 'general';
    try { localStorage.setItem(LS_DOMAIN, id); } catch (e) { /* ignore */ }
    /* 换了领域 → 热词要跟着换（识别器内部会把热词编进解码图） */
    try { refreshHotwords(); } catch (e) { /* ignore */ }
    return id;
  }

  function ctxEnabled() {
    try { const v = localStorage.getItem(LS_CTX); if (v === '0') return false; } catch (e) { /* ignore */ }
    return true;
  }

  function setCtxEnabled(v) {
    try { localStorage.setItem(LS_CTX, v ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!v) {
      ctxQ = [];
      /* 关掉语境时，队列里还没校的条目要立刻收口 —— 否则它们卡在
         「精修过了、语境没跑」的状态里，永远不会断句、永远没有译文。
         倒序遍历：finalize 可能把一条拆成几条，正序会漏掉刚拆出来的。 */
      for (let i = subs.length - 1; i >= 0; i--) {
        const r = subs[i];
        if (r && r.text && !r.ctx) { r.ctx = 1; finalize(i); }
      }
    }
  }

  const $ = (id) => document.getElementById(id);

  /* ==================== 字幕不落盘：每次打开都重头转写 ====================

     3.12.1 之前，字幕按条目缓存到 <dataDir>/asr/subs/<key>.json，重开视频时直接
     把上次的结果摆出来、按钮变「继续」。实机反馈是反的：用户要「每次打开视频都
     从头生成」。三条理由都成立 ——
       ① 老版本存下来的是粗字幕（没精修、没标点），摆在面前比空着更误导；
       ② 「续播」其实并不成立：重开的播放位置是 0，新转的句子接在旧句子后面，
          时间轴直接错位，看着像把同一段说了两遍；
       ③ 想让某一段重转，除了去删文件没有别的入口。

     所以改成「打开即清空」：内存清空，盘上那份也删掉（旧版本留下的残渣）。
     音频归档 <asr/audio/<id>.pcm> 不动 —— 那是精修和导出的原料，重转也要靠它，
     而且按时间戳覆盖写，重播一遍天然不会错位。
     代价说清楚：不留 JSON 缓存 = 关插件前记得点「导出」，换来的是一条不会和
     视频错位的字幕。 */

  function resetSubs() {
    gen++;                     // 让还在飞的翻译 / 精修任务知道自己过期了
    subs = [];
    partial = '';
    curIdx = -1;
    fixCount = 0;
    ctxCount = 0;
    stat = { zh: 0, en: 0 };
    queue = [];
    fixQ = [];
    ctxQ = [];
    sel = new Set();
    selAnchor = -1;
    follow = true;
    updateSelUI();
  }

  /* 旧版本留下的字幕缓存文件：现在没人读了，留着只是垃圾 */
  function dropLegacyCache() {
    if (!fs || !pathMod || !docKey) return false;
    let dir = '';
    try { dir = Asr.rootDir; } catch (e) { dir = ''; }
    if (!dir) return false;
    const p = pathMod.join(dir, 'subs', docKey + '.json');
    try {
      if (!fs.existsSync(p)) return false;
      fs.unlinkSync(p);
      return true;
    } catch (e) { return false; }
  }

  /* 条目 id 哈希：音频归档和（旧版的）缓存文件都靠它起名，太长或带非法字符的
     书名不能直接当文件名 */
  function keyOf(item) {
    const raw = String((item && (item.id || item.name)) || '');
    let h = 0;
    for (let i = 0; i < raw.length; i++) { h = (h * 31 + raw.charCodeAt(i)) | 0; }
    return 'sub-' + Math.abs(h).toString(36) + '-' + raw.length;
  }

  /* ==================== 热词（v3.14） ====================
     把「这段视频里大概率会出现哪些词」提前告诉识别器。
     来源只有两处、都不用用户额外操作：
       ① 术语表（就是划词翻译那张表，翻译和转写本来就该共用一份领域词）
       ② 视频文件名（医学课件名往往直接就是主题：「腹腔镜胆囊切除」）
     热词只在流式那一遍生效，精修那一遍仍然照音频自己听 —— 两遍互补，不互相绑架。 */
  let hwFetching = false;

  function hotwordList() {
    const out = [];
    try {
      if (typeof Translator !== 'undefined' && Translator.getGlossary) {
        Translator.getGlossary().forEach((g) => {
          if (g && g.from) out.push(String(g.from));
          if (g && g.to) out.push(String(g.to));
        });
      }
    } catch (e) { /* 没有术语表就算了 */ }
    /* v3.30：内置的领域词表。用户术语表排在前面（更贴近这一篇），
       领域词表补充进来；去重后整体交给识别器。 */
    try {
      if (typeof DomainTerms !== 'undefined') {
        DomainTerms.terms(domain()).forEach((t) => out.push(t));
      }
    } catch (e) { /* ignore */ }
    /* 文件名：去掉扩展名，再按常见分隔符切开，太短的词（「的」「2」）不值得偏置 */
    String(docTitle || '').replace(/\.[^.]+$/, '')
      .split(/[\s_\-—–·、,，.。()（）\[\]【】+]+/)
      .forEach((w) => { if (w.length >= 2 && w.length <= 12) out.push(w); });
    /* 去重但保持顺序：热词表越大，解码图越大，重复没有意义 */
    const seen = Object.create(null);
    return out.filter((w) => {
      const k = String(w || '').trim();
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  function refreshHotwords() {
    if (!Asr || !Asr.setHotwords) return;
    const list = hotwordList();
    let changed = false;
    try { changed = Asr.setHotwords(list); } catch (e) { return; }
    if (changed && running) {
      /* 识别器换了（热词编进解码图），正在跑的流要跟着换一个 */
      try { Asr.closeStream(); Asr.openStream(); } catch (e) { /* ignore */ }
    }
    /* 中英模型还差一份 bpe.vocab（约 1 MB）：后台补下，下完再挂一次。
       缺它只是没有热词，字幕照常能开，所以失败也无所谓。 */
    try {
      const st = Asr.hotwordState ? Asr.hotwordState() : null;
      if (st && st.need && !hwFetching) {
        hwFetching = true;
        try {
          Asr.ensureHotwordAsset().then(() => {
            hwFetching = false;
            try {
              if (Asr.setHotwords(list) && running) { Asr.closeStream(); Asr.openStream(); }
            } catch (e) { /* ignore */ }
          }).catch(() => { hwFetching = false; });
        } catch (e) { hwFetching = false; }
      }
    } catch (e) { /* ignore */ }
  }

  /* ==================== 语境矫正队列 ==================== */

  function enqueueCtx(i) {
    if (!ctxEnabled()) return;
    const row = subs[i];
    if (!row || row.ctx || !row.text) return;
    if (ctxQ.indexOf(i) >= 0) return;
    ctxQ.push(i);
    pumpCtx();
  }

  /* 交给本地大模型的一小段前后文。取最近 6 句而不是全部 ——
     上下文越长，7b 级模型越容易自作主张改写内容。 */
  function ctxWindow(i) {
    const from = Math.max(0, i - 4);
    const to = Math.min(subs.length, i + 3);
    const out = [];
    for (let k = from; k < to; k++) {
      if (k === i || !subs[k] || !subs[k].text) continue;
      out.push(subs[k].text);
    }
    return out.join('\n').slice(0, 700);
  }

  function ctxGlossary(text) {
    try {
      if (typeof Translator !== 'undefined' && Translator.pickGlossary) {
        return Translator.pickGlossary(text);
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function ctxPrompt(text, context, gloss) {
    let sys = '你是语音识别结果的校对助手。下面是一段视频字幕的转写文本，'
      + '其中可能有同音/近音字被听错（例如“胆囊三角”被听成“单囊三角”）。\n'
      + '只改正听错的字词，不要改写句子结构，不要增删内容，不要添加解释，'
      + '不要添加标点以外的任何文字。输出一整行，就是改正后的那一句原文。\n'
      + '如果判断没有错误，原样输出这一句。'
      + (gloss.length ? '\n\n领域术语（以这些写法为准）：\n' + gloss.map((g) => g.from + ' = ' + g.to).join('\n') : '');
    /* v3.30：内置领域词（医学 / 生命科学）。只挑跟这一句沾边的，
       整表塞进去小模型会开始往句子里硬塞术语。 */
    try {
      if (typeof DomainTerms !== 'undefined') {
        const block = DomainTerms.promptBlock(domain(), text + '\n' + (context || ''));
        if (block) sys += '\n\n' + block;
      }
    } catch (e) { /* ignore */ }
    let user = (context ? '【前后文，仅供判断，不要输出】\n' + context + '\n\n' : '')
      + '【待校对的这一句】\n' + text;
    return { sys, user };
  }

  async function pumpCtx() {
    if (ctxing) return;
    if (typeof Translator === 'undefined' || !Translator.complete) return;
    const my = gen;
    ctxing = true;
    while (ctxQ.length) {
      if (my !== gen) break;
      const i = ctxQ.shift();
      const row = subs[i];
      if (!row || row.ctx || !row.text) continue;
      const p = ctxPrompt(row.text, ctxWindow(i), ctxGlossary(row.text));
      let out = null;
      try { out = await Translator.complete(p.sys, p.user); } catch (e) { out = null; }
      if (my !== gen || subs[i] !== row) continue;
      applyCtx(i, out);
      /* 让出一帧：这一层是「锦上添花」，不能抢播放和精修的 CPU */
      await new Promise((r) => setTimeout(r, 60));
    }
    ctxing = false;
    updateStat();
    if (ctxQ.length) pumpCtx();
  }

  /* 模型改得对不对，靠这几条硬闸门禁。
     本地小模型最爱干的两件事：把前后文一起输出、顺手扩写。
     两者都会把字幕毁掉，宁可放弃这次校对。 */
  function applyCtx(i, out) {
    const row = subs[i];
    if (!row) return;
    let next = String(out || '').trim();
    /* 放弃这次校对也要往下收口（断句 + 翻译），否则这一条会永远没有译文。
       下面每一处提前 return 都走 done()。 */
    const done = () => {
      row.ctx = 1;
      finalize(i);          // 放在最后：断句会改变下标
    };
    if (!next) { done(); return; }
    /* 输出了不止一行 = 模型没按「只输出一句」做（最常见的就是把前后文一起回显）。
       这时候取第一行是错的 —— 第一行往往正是那段上下文。整条丢弃更稳。 */
    if (/[\r\n]/.test(next)) { done(); return; }
    next = next.replace(/^["'“”‘’【】\[\]]+|["'“”‘’]+$/g, '').trim();
    /* 还有些模型爱加前缀，例如「改正后：xxx」—— 只认冒号后那半句 */
    const cut = next.match(/^(?:改正后|校对后|输出|结果)[:：]\s*(.+)$/);
    if (cut) next = cut[1].trim();
    if (!next) { done(); return; }
    const a = next.length, b = row.text.length;
    if (b >= 6 && (a < b * 0.45 || a > b * 1.9)) { done(); return; }  // 长度离谱 = 模型自己发挥了
    row.ctx = 1;
    if (next === row.text) { finalize(i); return; }
    row.text = Asr.tidyCase(next);
    row.spl = 0;                 // 文本变了，可以重新断句
    ctxCount++;
    renderRow(i);
    /* 语种可能跟着变（原来按英文翻过的，现在判定是中文）；
       文本变了，之前那条译文就作废 —— 交给 finalize 重新按句翻。 */
    if (row.zh) row.zh = '';
    patchRow(i);
    finalize(i);
  }

  /* ==================== 音频采集 ==================== */

  function audioOk() {
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    return !!AC;
  }

  function attach(el) {
    if (!el || !audioOk()) return false;
    if (video === el && srcNode) return true;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      /* createMediaElementSource 对一个元素只能调一次，重复调会抛 InvalidStateError。
         视频元素在整个插件里是同一个，所以这里只认第一次。 */
      if (!srcNode) srcNode = actx.createMediaElementSource(el);
      if (!boundPlay) {
        boundPlay = true;
        /* 自动播放策略下 AudioContext 常是 suspended：接管音频后如果图不动，
           视频就彻底没声音。播放是最自然的用户手势，在这里唤醒。 */
        try {
          el.addEventListener('play', wakeAudio);
          el.addEventListener('playing', wakeAudio);
          document.addEventListener('click', wakeAudio, { passive: true });
        } catch (e) { /* ignore */ }
      }
      video = el;
      return true;
    } catch (e) {
      return false;
    }
  }

  let boundPlay = false;

  /* 音频接线（v3.12 修「开字幕后视频没声音」）
     ────────────────────────────────────────────
     createMediaElementSource 一旦调用，<video> 的音频就被 WebAudio 图接管，
     元素不再直连扬声器 —— 之后能不能听见，完全取决于这张图有没有通往 destination 的通路。

     3.10 的写法是 srcNode → proc → destination。看着是「接上了」，实际是静音：
     ScriptProcessor 的 outputBuffer 默认全 0，而 onaudioprocess 从来不往里写数据，
     于是 destination 收到的是一段数字静音 —— 声音被接管后又送进了一个不发声的旁路。

     正确接法是两条并行的支路：
       ① srcNode → destination        原声直达，零延迟，这就是用户听到的声音；
       ② srcNode → proc → 0 音量增益 → destination
          ScriptProcessor 只有在「有输出连接」时才会被音频线程拉取（否则 onaudioprocess
          根本不触发），所以必须接到 destination；中间那个 gain=0 保证它不重复出声。 */
  let silentSink = null;

  function wire() {
    if (!actx || !srcNode) return false;
    try {
      if (!proc) {
        proc = actx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = onAudio;
      }
      if (!silentSink) {
        silentSink = actx.createGain();
        silentSink.gain.value = 0;
        silentSink.connect(actx.destination);
      }
      /* 先全部拆掉再按上面的拓扑重接：重复 connect 同一对节点是幂等的（信号不会叠加），
         但留着旧连接会让「谁在出声」变得难以推理 */
      try { srcNode.disconnect(); } catch (e) { /* ignore */ }
      try { proc.disconnect(); } catch (e) { /* ignore */ }
      srcNode.connect(actx.destination);          // ① 原声
      srcNode.connect(proc);                      // ② 旁路采集
      proc.connect(silentSink);
      if (!resampler) resampler = Asr.makeResampler(actx.sampleRate);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* AudioContext 在人机交互之外创建时会是 suspended —— 这时整张图都不出声。
     播放是用户手势，正好拿来唤醒它；只在真的挂起时才 resume，避免无谓的状态抖动。 */
  function wakeAudio() {
    if (!actx) return;
    if (actx.state === 'suspended') {
      try { actx.resume(); } catch (e) { /* ignore */ }
    }
  }

  function onAudio(e) {
    if (!running || !video) return;
    if (video.paused || video.ended) return;
    const buf = e.inputBuffer.getChannelData(0);
    if (!buf || !buf.length) return;

    /* 有画面没声音：跨源（页面 eagleplugin:// 抓 file:// 的视频）时 MediaElementSource
       会一直吐 0。先试一次「切到内存源」——blob 与页面同源，切过去就能抓了；
       切了还不行，才提示用户。 */
    let energy = 0;
    for (let i = 0; i < buf.length; i += 16) energy += Math.abs(buf[i]);
    if (energy < 1e-6) {
      silentRuns++;
      if (silentRuns === 12 && !triedBlob) {
        triedBlob = true;
        setStat('听不到声音，正在切换音频来源…');
        try {
          if (typeof VideoView !== 'undefined' && VideoView.ensureBlobSource && VideoView.ensureBlobSource()) {
            silentRuns = 0;
            return;
          }
        } catch (e) { /* ignore */ }
      }
      if (silentRuns > 24 && !warnedSilent) {
        warnedSilent = true;
        setStat('抓不到这个视频的音频 · 字幕无法生成');
      }
      return;
    }
    silentRuns = 0;

    let pcm = buf;
    try {
      if (resampler) pcm = resampler.resample(new Float32Array(buf));
    } catch (err) { pcm = buf; }
    if (!pcm || !pcm.length) return;

    /* 先归档再识别：音频落盘是精修的前提，也是「知识库拿到原始音轨」的唯一来源。
       写的是 16 kHz 单声道（就是识别器吃的那份），一分钟 1.9 MB。 */
    try { Asr.pcmWrite(video.currentTime, pcm); } catch (err) { /* 盘满就只做流式 */ }

    let out = null;
    try { out = Asr.feed(pcm, video.currentTime); } catch (err) { return; }
    if (!out) return;

    if (out.partial !== partial) {
      partial = out.partial;
      renderTail();
    }
    if (out.segment) commit(out.segment);
  }

  /* 整段视频的语言倾向。
     逐句判断不够用：中英混说的一句话按字面比例容易判错，翻出来的中文反而重复。
     所以按「句」计票：中文句不少于英文句，就当这是一段中文视频，夹的英文也不翻。
     纯英文视频里偶有一句中文引用时（中文 1 句、英文 20 句），票数不会翻盘。 */
  let stat = { zh: 0, en: 0 };

  function docIsZh() {
    if (!stat.zh && !stat.en) return null;
    return stat.zh > 0 && stat.zh >= stat.en;
  }

  /* ==================== 断句（v3.15） ====================
     端点检测只认「安静了多久」，不认「这句话说完了没有」。
     结果是字幕经常卡在句子中间：说话人换气的那一下停顿就够触发端点，
     一句完整的话被切成两三条，每条都读不通。
     两条补救：
       ① 引擎侧把静音阈值放宽（1.2s → 1.9s），换气不再算一句结束；
       ② 这里再兜一层 —— 已经落定的那句要是「明显没说完」，就把新的一句接回去。
     判断「没说完」用两个信号，都用得上：
       · 间隔很短（≤ 1 秒）：端点八成是被噪声或 20 秒硬切触发的，不是真的停了；
       · 精修后的文本没有句末标点：SenseVoice 会补标点，它都没给句号，
         说明这句在音频里确实是连着说下去的。 */
  const RE_TERM = /[。！？…；;.!?]$/;

  function isCJK(ch) {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f);
  }

  /* 能不能把新的一句并进上一条 —— 保守：宁可分成两条，也不要并出一条超长的 */
  function canMerge(last, text, gap) {
    if (gap <= 1.0) return true;
    if (!last.fix) return false;                       // 没精修过就没有标点可参考
    if (RE_TERM.test(String(last.text || '').trim())) return false;
    if (gap > 2.2) return false;
    return (String(last.text || '').length + String(text || '').length) <= 110;
  }

  function mergeInto(last, text, seg) {
    const idx = subs.length - 1;
    const glue = (isCJK(last.text.slice(-1)) || isCJK(text[0])) ? '' : ' ';
    last.text = Asr.tidyCase(last.text + glue + text);
    last.t1 = Math.max(last.t1 || 0, seg.t1 || seg.t);
    /* 整段变了 → 精修和语境那两层都要重跑，否则留着的是半句的结论。
       ver：行版本号。正在路上的翻译/精修结果是对「旧文本」的，
       回来时对不上版本就作废重排 —— 否则合并后的句子顶着前半句的译文。 */
    last.ver = (last.ver || 0) + 1;
    last.fix = 0;
    last.ctx = 0;
    last.spl = 0;          // 文本变了，可以重新断句
    last.zh = '';
    const own = Asr.langOf(last.text);
    const zhDoc = docIsZh();
    const lang = zhDoc === false ? 'en' : (zhDoc === true ? 'zh' : own);
    if (lang !== last.lang) {
      if (last.lang === 'zh') stat.zh--; else if (last.lang === 'en') stat.en--;
      last.lang = lang;
      if (lang === 'zh') stat.zh++; else if (lang === 'en') stat.en++;
    }
    partial = '';
    renderRow(idx);
    queueRow(idx);       // 文本变了：等精修 / 语境落定后再断句翻译
    return true;
  }

  function commit(seg) {
    const text = Asr.tidyCase(seg.text);
    if (!text) return;
    /* 端点检测偶尔会把同一句重复吐一次，丢掉和上一条完全相同的 */
    const last = subs[subs.length - 1];
    if (last && last.text === text && Math.abs(seg.t - last.t) < 3) return;
    if (last && canMerge(last, text, seg.t - (last.t1 || last.t))) {
      if (mergeInto(last, text, seg)) return;
    }

    const own = Asr.langOf(text);
    if (own === 'zh') stat.zh++;
    else if (own === 'en') stat.en++;

    const zhDoc = docIsZh();
    const lang = zhDoc === false ? 'en' : (zhDoc === true ? 'zh' : own);
    const row = { t: Math.max(0, seg.t), t1: Math.max(seg.t + 0.2, seg.t1 || seg.t + 1), text, zh: '', lang };
    subs.push(row);
    if (subs.length > 4000) {
      const drop = subs.length - 4000;
      subs.splice(0, drop);
      /* 队列里存的是下标，前面的行被丢掉后所有下标都要跟着前移，
         否则会翻到隔壁那一句上（这个坑 3.10 就埋着了） */
      const shift = (a) => a.map((i) => i - drop).filter((i) => i >= 0);
      queue = shift(queue);
      fixQ = shift(fixQ);
      ctxQ = shift(ctxQ);
      sel = new Set(Array.from(sel).map((i) => i - drop).filter((i) => i >= 0));
    }
    partial = '';
    renderList();
    scrollToLatest();
    queueRow(subs.length - 1);
  }

  /* 一条字幕进流程的唯一入口。
     v3.26：翻译不再在 commit 里直接排队 —— 精修会把「听错的字」改掉，
     先翻等于翻的是一句错话，语境层之后还会再改一遍。
     所以统一等到文本落定（finalize）之后才翻，这是译文能再准一截的主要原因。
     精修在跑就等它回调，它失败也会走 finalize，不会漏。 */
  function queueRow(i) {
    const row = subs[i];
    if (!row) return;
    enqueueFix(i);
    let ready = false;
    try { ready = !!(Asr.refineProbe && Asr.refineProbe().ready); } catch (e) { ready = false; }
    if (!(fixEnabled() && ready)) afterFix(i);
  }

  /* ==================== 语义断句 + 收口（v3.26） ====================
     一条字幕的长度本来是端点检测决定的（换气停 1.9 秒才算一句，还允许并到 110 字），
     于是经常「三句话挤成一段」—— 屏幕上糊一大片，翻译也只能整段硬翻。

     现在文本落定后按标点拆句，一句一条。**不需要额外的模型**：
     句读来自已经在跑的精修模型（SenseVoice 自带标点）；
     精修没装时退回逗号 / 空格的弱边界，也能拆，只是不如标点准。

     为什么必须等「落定」才拆：流式阶段还没有标点，那时候只能按长度硬切，
     等于从句子中间劈一刀 —— 比不拆更难看。 */
  const BREAK_MAX = 74;          // 约 37 个汉字 / 74 个西文字符：两行字幕的舒适上限

  function breakOn() {
    try { const v = localStorage.getItem('eaglenote.sub.break'); if (v === '0') return false; } catch (e) { /* ignore */ }
    return true;
  }

  function setBreakOn(v) {
    try { localStorage.setItem('eaglenote.sub.break', v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /* 把第 i 条按语义拆成若干条，返回拆出的条数（1 = 没拆）。
     耗时按各段宽度比例分摊 —— 拆开之后点某一条仍能跳到大概的位置。 */
  function resplit(i) {
    const row = subs[i];
    if (!row || !row.text || row.spl) return 1;
    if (!breakOn()) return 1;
    if (typeof SentBreak === 'undefined' || !SentBreak.plan) return 1;
    let parts = null;
    try { parts = SentBreak.plan(row.text, { max: BREAK_MAX }); } catch (e) { parts = null; }
    if (!parts || parts.length <= 1) { row.spl = 1; return 1; }

    const ws = parts.map((p) => Math.max(1, SentBreak.weight(p)));
    let totalW = 0;
    ws.forEach((w) => { totalW += w; });
    if (!totalW) totalW = parts.length;
    const t0 = Math.max(0, Number(row.t) || 0);
    const t1 = Math.max(t0 + 0.4, Number(row.t1) || t0 + 1);
    const span = t1 - t0;
    const r2 = (v) => Math.round(v * 100) / 100;

    let acc = 0;
    const rows = parts.map((text, k) => {
      const a = t0 + span * (acc / totalW);
      acc += ws[k];
      const b = t0 + span * (acc / totalW);
      return {
        t: r2(a),
        t1: r2(Math.max(a + 0.3, b)),
        text,
        zh: '',
        lang: row.lang,
        /* 继承原条的状态：精修过就是精修过（时间戳照旧高亮），
           没精修过也保持 0 —— 别把粗字幕标成「精修过」。 */
        fix: row.fix ? 1 : 0,
        ctx: row.ctx ? 1 : 0,
        spl: 1
      };
    });
    /* 已有译文（精修晚到时可能出现）：按宽度比例对到每一段上，
       别把整段中文堆到第一行、后面几条空着。 */
    if (row.zh) {
      let zs = [];
      try { zs = SentBreak.splitZh(row.zh, ws); } catch (e) { zs = []; }
      rows.forEach((r, k) => { r.zh = zs[k] || ''; });
    }

    const delta = rows.length - 1;
    const bump = (a) => a.map((x) => (x > i ? x + delta : x));
    /* i 自己那几条队列项作废：拆完要按新的一条条重排 */
    queue = bump(queue.filter((x) => x !== i));
    fixQ = bump(fixQ.filter((x) => x !== i));
    ctxQ = bump(ctxQ.filter((x) => x !== i));
    if (curIdx > i) curIdx += delta;
    if (selAnchor > i) selAnchor += delta;
    if (sel.size) {
      const next = new Set();
      sel.forEach((x) => next.add(x > i ? x + delta : x));
      sel = next;
    }
    subs.splice(i, 1, ...rows);

    renderList();
    scrollToLatest();
    return rows.length;
  }

  /* 文本落定的统一出口：先断句，再逐条翻。
     精修 / 语境 / 直接出字幕三条路最后都汇到这里，避免出现
     「精修过的走一条、没精修的走另一条」两套逻辑。 */
  function finalize(i) {
    const row = subs[i];
    if (!row || !row.text) return;
    const n = resplit(i);
    for (let k = i; k < i + Math.max(1, n); k++) {
      const r = subs[k];
      if (r && r.lang === 'en' && !r.zh) enqueue(k);
    }
  }

  /* 语境层到底能不能跑：没有 Translator.complete 就没得跑，
     这时候直接收口，否则排进 ctxQ 也永远没人处理，那一条就永远没有译文。 */
  function ctxAvailable() {
    try { return !!(typeof Translator !== 'undefined' && Translator.complete); } catch (e) { return false; }
  }

  /* 精修之后往哪儿走：语境开着就交给语境层，关着就直接收口 */
  function afterFix(i) {
    if (ctxEnabled() && ctxAvailable()) enqueueCtx(i);
    else finalize(i);
  }

  /* ==================== 精修：拿音频重听一遍 ====================
     为什么值得多花这一遍：流式模型只能看「已经说过的字」，遇到专业术语、
     人名、数字，错法是系统性的（听成音近的常用词）。非流式模型能拿到整句音频
     双向看一遍，比流式准得多，还自带标点 —— 对要进知识库的文本，这一步是决定性的。

     为什么用户感觉不到卡：decodeAsync 在线程池里跑，主线程照常播放；
     队列串行 + 40 ms 间隔，避免和流式抢 CPU。 */

  function enqueueFix(i) {
    if (!fixEnabled()) return;
    let ready = false;
    try { ready = !!(Asr.refineProbe && Asr.refineProbe().ready); } catch (e) { ready = false; }
    if (!ready) return;               // 没装精修模型：不排队、不堆积，界面会提示「精修·未装」
    const row = subs[i];
    if (!row || row.fix) return;
    if (fixQ.indexOf(i) >= 0) return;
    fixQ.push(i);
    pumpFix();
  }

  async function pumpFix() {
    if (fixing) return;
    let st = null;
    try { st = Asr.refineProbe(); } catch (e) { return; }
    if (!st || !st.ready) return;               // 没下精修模型就只出粗字幕，不报错
    const my = gen;                             // 本轮属于哪一次「打开视频」
    fixing = true;
    updateStat();
    while (fixQ.length) {
      /* 这期间换过视频（或在同一视频里清空过）→ 下标已经指向别的句子，必须停手，
         否则会把 A 视频的精修结果写到 B 视频的第 i 行上 */
      if (my !== gen) break;
      const i = fixQ.shift();
      const row = subs[i];
      if (!row || row.fix) continue;
      /* 前后各留 0.35 秒余量：抓音频的位置是按 currentTime 倒推的，
         边缘可能切掉半个音，留点余量让模型自己裁。 */
      const t0 = Math.max(0, row.t - 0.35);
      const t1 = row.t1 + 0.35;
      let pcm = null;
      try { pcm = Asr.pcmRead(t0, t1); } catch (e) { pcm = null; }
      if (!pcm || pcm.length < 6400) { row.fix = 1; afterFix(i); continue; }   // 不到 0.4 秒，不值得跑
      const ver = row.ver || 0;
      let res = null;
      try { res = await Asr.refineAsync(pcm); } catch (e) { res = null; }
      if (my !== gen || subs[i] !== row) continue;  // 结果回来时这行已经不属于当前列表
      if ((row.ver || 0) !== ver) {                 // 行在等待期间被合并过 → 这是对旧音频段的结果
        if (!row.fix && fixQ.indexOf(i) < 0) fixQ.push(i);   // 按合并后的时间段重听一次
        continue;
      }
      if (res && res.text) applyFix(i, res);
      else { row.fix = 1; afterFix(i); }        // 重听也听不出东西，别无限重试
      /* 让出一帧：精修是「顺带做」的，不能把播放的线程抢光 */
      await new Promise((r) => setTimeout(r, 40));
    }
    fixing = false;
    updateStat();
    if (fixQ.length) pumpFix();                // 清空后又排进来的，交给下一轮
  }

  /* 精修结果要不要采纳 —— 这一段是防「模型抽风」的闸门：
     非流式模型偶尔会把整段听成一句极短的话（尤其是夹着噪音的片段），
     直接盖上去等于把用户刚看到的内容删了，宁可保留原来的粗字幕。 */
  function applyFix(i, res) {
    const row = subs[i];
    if (!row) return;
    const next = Asr.tidyCase(String(res.text || '').trim());
    if (!next) { row.fix = 1; afterFix(i); return; }
    if (row.text.length >= 8 && next.length < row.text.length * 0.5) { row.fix = 1; afterFix(i); return; }

    const lang = (res.lang === 'zh' || res.lang === 'en') ? res.lang : (Asr.langOf(next) || row.lang);
    const changed = next !== row.text;
    row.text = next;
    row.fix = 1;
    if (!changed && lang === row.lang) {
      renderRow(i);
      afterFix(i);          // 文本没变也要往下走：还得断句 + 翻译
      return;
    }
    fixCount++;

    if (lang !== row.lang) {
      if (row.lang === 'zh') stat.zh--;
      else if (row.lang === 'en') stat.en--;
      row.lang = lang;
      if (lang === 'zh') stat.zh++;
      else if (lang === 'en') stat.en++;
      /* 原来按英文翻过的，现在判定是中文了 → 那条译文反而多余 */
      if (lang === 'zh') row.zh = '';
    }
    renderRow(i);
    /* 收口放在最后：它会断句，一旦拆开，i 之后的下标都会前移，
       所以上面那些按下标做事的步骤必须先做完。 */
    afterFix(i);
  }

  /* 只换第 i 行，不动整个列表：整表重建会让用户正在看的位置跳掉 */
  function renderRow(i) {
    const list = $('subList');
    if (!list || !subs[i]) return;
    const old = list.querySelector('.sub-item[data-i="' + i + '"]');
    if (!old) return;
    old.replaceWith(rowNode(subs[i], i));
    markCurrent();
    updateStat();
  }

  /* ==================== 英文补中文 ==================== */

  /* 前后各取几句原文当语境。
     取 3 前 2 后：再往前就跑到别的话题上了，7b 级模型反而容易串味。 */
  function transContext(i) {
    const from = Math.max(0, i - 3);
    const to = Math.min(subs.length, i + 3);
    const out = [];
    for (let k = from; k < to; k++) {
      if (k === i) continue;
      const r = subs[k];
      if (!r || !r.text) continue;
      out.push(r.text);
    }
    return out.join('\n').slice(0, 600);
  }

  /* 译文合不合格：两道检查，都便宜。
     ① 残留源语言 —— Translator 里已有同款判定（「一是/二是」这类连接词会原样留着）；
     ② 长度比例 —— 中文通常比英文短（0.4~0.6），翻出来比原文长一倍以上，
        多半是把上下文一起翻了，或者模型自己在解释。 */
  function zhOk(src, zh) {
    const t = String(zh || '').trim();
    if (!t) return false;
    /* 原文有实词，译文却一个汉字都没有 → 基本就是原样回显。
       Translator.looksUntranslated 对短句不判（少于 24 字直接放过），
       而字幕恰恰全是短句，所以这里得自己补一条。 */
    if (/[A-Za-z]{2,}/.test(String(src || '')) && !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(t)) return false;
    try {
      if (typeof Translator !== 'undefined' && Translator.looksUntranslated
        && Translator.looksUntranslated(t, 'zh')) return false;
    } catch (e) { /* ignore */ }
    const r = t.length / Math.max(1, String(src || '').length);
    return r >= 0.12 && r <= 2.4;
  }

  function enqueue(i) {
    if (i < 0 || i >= subs.length) return;
    if (queue.indexOf(i) >= 0) return;
    queue.push(i);
    pump();
  }

  async function pump() {
    if (translating) return;
    if (typeof Translator === 'undefined') return;
    const my = gen;
    translating = true;
    while (queue.length) {
      if (my !== gen) break;              // 换过视频：这批下标作废
      const i = queue.shift();
      const row = subs[i];
      if (!row || row.zh || row.lang !== 'en') continue;
      const ver = row.ver || 0;
      /* v3.26：把前后几句原文当上下文一起交过去。
         本地模型会用它判断术语和指代（在线接口会忽略，不亏），
         同一段视频里的译名因此不会前后打架。 */
      const ctx = transContext(i);
      try {
        const res = await Translator.translate(row.text, {
          target: 'zh', context: ctx, source: 'en'
        });
        if (my !== gen || subs[i] !== row) continue;   // 译回来时这行已经换了
        if ((row.ver || 0) !== ver) {                  // 行在等待期间被合并过 → 译文是对旧文本的
          if (!row.zh && queue.indexOf(i) < 0) queue.push(i);   // 按新文本重排一次
          continue;
        }
        if (res && res.ok && res.text) {
          const zh = String(res.text).trim();
          /* 译文的最后一道闸门：明显没翻 / 长度离谱的，宁可空着也不摆出来。
             空着用户知道「这句没译出来」，摆一段错的会让人以为听错了。 */
          if (zhOk(row.text, zh)) {
            row.zh = zh;
            row.via = res.provider || '';
            patchRow(i);
          }
        }
      } catch (e) { /* 翻译失败就只留原文，不影响字幕 */ }
      /* 一条一条来：字幕是边播边加的，抢带宽没意义，还把主线程挤住 */
      await new Promise((r) => setTimeout(r, 60));
    }
    translating = false;
    if (queue.length) pump();             // 清空后又排进来的，交给下一轮
  }

  /* ==================== 渲染 ==================== */

  function fmt(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(r) : p(m) + ':' + p(r);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function rowNode(row, i) {
    const item = el('div', 'sub-item');
    item.dataset.i = String(i);
    if (row.lang === 'en') item.classList.add('en');
    if (row.fix) item.classList.add('fix');   // 精修过：时间戳用强调色，一眼能看出哪些更可靠
    if (sel.has(i)) item.classList.add('sel');
    item.appendChild(el('span', 'sub-t', fmt(row.t)));
    const body = el('div', 'sub-body');
    body.appendChild(el('div', 'sub-text', row.text));
    if (row.zh) body.appendChild(el('div', 'sub-zh', row.zh));
    item.appendChild(body);
    item.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSel(i); return; }
      if (e.shiftKey) { e.preventDefault(); rangeSel(i); return; }
      if (sel.size) { clearSel(); return; }   // 有选中态时，普通点击先退出多选
      if (video) { try { video.currentTime = row.t; } catch (err) { /* ignore */ } }
    });
    return item;
  }

  /* ---------- 多选 ---------- */
  function toggleSel(i) {
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    selAnchor = i;
    paintSel();
  }

  function rangeSel(i) {
    if (selAnchor < 0) { toggleSel(i); return; }
    const a = Math.min(selAnchor, i), b = Math.max(selAnchor, i);
    for (let k = a; k <= b; k++) if (subs[k]) sel.add(k);
    paintSel();
  }

  function selectAll() {
    subs.forEach((r, i) => sel.add(i));
    paintSel();
  }

  function clearSel() {
    if (!sel.size) return;
    sel = new Set();
    selAnchor = -1;
    paintSel();
  }

  /* 只改选中态的 class，不重建列表 —— 重建会丢掉滚动位置和正在看的那一句 */
  function paintSel() {
    const list = $('subList');
    if (list) {
      list.querySelectorAll('.sub-item[data-i]').forEach((n) => {
        n.classList.toggle('sel', sel.has(+n.dataset.i));
      });
    }
    updateSelUI();
  }

  function updateSelUI() {
    const b = $('btnSubSave');
    if (!b) return;
    const n = sel.size;
    b.hidden = n === 0;
    /* v3.25：多选时头部改用「紧凑版」——收起精修 / 语境，计数用半角括号。
       否则「存为笔记（4）」一挤，整行折行，标题被压成两行，排版像坏了。 */
    b.textContent = n ? ('存为笔记' + (n > 1 ? '(' + n + ')' : '')) : '存为笔记';
    /* v4.1：头部按钮行从 .sub-head 换成弹出面板里的 .sub-tools（保留旧类名兜底） */
    const head = b.closest ? (b.closest('.sub-tools') || b.closest('.sub-head')) : null;
    if (head && head.classList) head.classList.toggle('picking', n > 0);
    b.title = n
      ? '把选中的字幕存成笔记，并附上这段开头那一帧的画面'
      : '按住 Ctrl 点字幕可多选，Shift 连选，Ctrl+A 全选';
  }

  /* 选中的条目按「是否连续」分组：
     连续的一段只截一张图（它开头那一帧），断开了就各自再截一张。 */
  function selectedGroups() {
    const idx = Array.from(sel).filter((i) => subs[i]).sort((a, b) => a - b);
    if (!idx.length) return [];
    const runs = [];
    let cur = { from: idx[0], to: idx[0] };
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] === cur.to + 1) cur.to = idx[k];
      else { runs.push(cur); cur = { from: idx[k], to: idx[k] }; }
    }
    runs.push(cur);
    return runs.map((r) => {
      const rows = subs.slice(r.from, r.to + 1);
      return {
        from: r.from,
        to: r.to,
        t0: rows[0].t,
        t1: rows[rows.length - 1].t1,
        rows: rows.map((s) => ({ t: s.t, t1: s.t1, text: s.text, zh: s.zh || '', lang: s.lang }))
      };
    });
  }

  function saveSelection() {
    const groups = selectedGroups();
    const say = (m, t) => { try { if (typeof U !== 'undefined' && U.toast) U.toast(m, t || '', 2200); } catch (e) { /* ignore */ } };
    if (!groups.length) { say('先按住 Ctrl 点几条字幕'); return; }
    if (!saveHook) { say('这个界面还没接上保存动作', 'err'); return; }
    try { saveHook(groups); } catch (e) { say('保存失败：' + ((e && e.message) || e), 'err'); }
  }

  function renderList() {
    const list = $('subList');
    if (!list) return;
    const keepScroll = list.scrollTop;
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    subs.forEach((row, i) => frag.appendChild(rowNode(row, i)));
    list.appendChild(frag);
    if (partial) renderTail();
    list.scrollTop = keepScroll;
    markCurrent();
    updateStat();
    updateJump();
  }

  /* 半句结果只动最后一行，避免每 100 毫秒重建整个列表（滚动会跳） */
  function renderTail() {
    const list = $('subList');
    if (!list) return;
    let tail = list.querySelector('.sub-item.live');
    if (!partial) {
      if (tail) tail.remove();
      return;
    }
    if (!tail) {
      tail = el('div', 'sub-item live');
      tail.appendChild(el('span', 'sub-t', fmt(video ? video.currentTime : 0)));
      const body = el('div', 'sub-body');
      body.appendChild(el('div', 'sub-text', ''));
      tail.appendChild(body);
      list.appendChild(tail);
    }
    const t = tail.querySelector('.sub-text');
    if (t) t.textContent = partial;
    /* 半句在长：不跟着滚的话，用户看到的是「下面还有一行」而不是那行在写什么 */
    if (follow) {
      const list2 = $('subList');
      if (list2) list2.scrollTop = list2.scrollHeight;
    }
    updateJump();
  }

  function patchRow(i) {
    const list = $('subList');
    if (!list) return;
    const node = list.querySelector('.sub-item[data-i="' + i + '"]');
    if (!node) return;
    const body = node.querySelector('.sub-body');
    if (!body) return;
    let zh = body.querySelector('.sub-zh');
    if (!subs[i].zh) { if (zh) zh.remove(); return; }
    if (!zh) { zh = el('div', 'sub-zh'); body.appendChild(zh); }
    zh.textContent = subs[i].zh;
  }

  function markCurrent() {
    const list = $('subList');
    if (!list) return;
    const items = list.querySelectorAll('.sub-item[data-i]');
    items.forEach((n) => n.classList.toggle('active', +n.dataset.i === curIdx));
  }

  /* ==================== 跟随最新一句（v3.15） ====================
     字幕是从下往上长的：新句子永远在列表末尾。播放时不跟下去，
     用户就只能看着最开始那几句不动，以为字幕卡住了。
     但「跟」不能是硬抢 —— 用户往回翻看前面说了什么时，每来一句就把视图拽回底部，
     那等于没法回看。所以规则是：
       · 贴着底部（差 56px 以内）→ 自动跟；
       · 用户手动往上滚 → 停止跟随，并给一个「回到最新」的按钮；
       · 点那个按钮 → 回到底部并恢复跟随。 */
  function atBottom() {
    const list = $('subList');
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 56;
  }

  function onListScroll() {
    follow = atBottom();
    updateJump();
  }

  function scrollToLatest() {
    const list = $('subList');
    if (!list) return;
    if (!follow) { updateJump(); return; }
    list.scrollTop = list.scrollHeight;
    updateJump();
  }

  function jumpToLatest() {
    const list = $('subList');
    follow = true;
    if (list) list.scrollTop = list.scrollHeight;
    updateJump();
  }

  function updateJump() {
    const b = $('subJump');
    if (!b) return;
    b.hidden = follow || !subs.length;
  }

  function scrollToCurrent() {
    const list = $('subList');
    if (!list) return;
    const node = list.querySelector('.sub-item[data-i="' + curIdx + '"]');
    if (!node) return;
    const top = node.offsetTop;
    const h = list.clientHeight;
    if (top < list.scrollTop + 24 || top > list.scrollTop + h - 48) {
      list.scrollTop = Math.max(0, top - h / 2);
    }
  }

  function setStat(text) {
    const n = $('subStat');
    if (n) n.textContent = text;
  }

  function updateStat() {
    const st = Asr.status();
    const dot = $('subDot');
    const nm = $('subName');
    const lg = $('subLang');
    /* v4.2.1：面板平时不弹出，转写状态要能从顶栏「字幕」键上看出来 ——
       转写中亮小绿点，一眼知道后台在干活。 */
    const pop = $('btnPopSubs');
    if (pop) pop.classList.toggle('live', !!(running && !busy));
    if (nm) nm.textContent = on ? (running ? '实时字幕' : '字幕（暂停）') : '实时字幕';
    if (dot) {
      dot.className = 'sub-dot' +
        (running ? ' on' : '') +
        (busy ? ' wait' : '') +
        ((!busy && st.engine === 'missing') ? ' err' : '');
    }
    if (lg) {
      const hasEn = subs.some((s) => s.lang === 'en');
      const hasZh = subs.some((s) => s.lang === 'zh');
      lg.hidden = !subs.length;
      lg.textContent = hasEn && hasZh ? '中英' : (hasEn ? 'EN' : '中文');
    }
    if (!busy) {
      const rf = (typeof Asr !== 'undefined' && Asr.refineProbe) ? Asr.refineProbe() : { ready: false };
      if (ctxing) {
        setStat('语境校对中… 已校 ' + ctxCount + ' 条');
      } else if (fixing) {
        setStat('精修中… 已改好 ' + fixCount + ' 条');
      } else if (!subs.length) {
        setStat(on ? '等待声音…' : '未开启');
      } else {
        let t = subs.length + ' 条 · 已转写到 ' + fmt(subs[subs.length - 1].t1);
        if (fixCount) t += ' · 精修 ' + fixCount;
        else if (!rf.ready && fixEnabled()) t += ' · 精修未装';
        if (ctxCount) t += ' · 语境 ' + ctxCount;
        setStat(t);
      }
    }
    fixUI();
    ctxUI();
  }

  /* 头部那个「精修」小按钮：三种状态一眼可辨 —— 没装 / 装了但关了 / 正在用 */
  function fixUI() {
    const b = $('btnSubFix');
    if (!b) return;
    let ready = false;
    try { ready = !!(Asr.refineProbe && Asr.refineProbe().ready); } catch (e) { ready = false; }
    const onNow = fixEnabled();
    b.textContent = ready ? (onNow ? '精修' : '精修·关') : '精修·未装';
    b.classList.toggle('on', ready && onNow);
    b.classList.toggle('off', !ready || !onNow);
    b.disabled = busy;
  }

  /* 语境校对按钮：三态 —— 没有本地模型 / 有但关了 / 正在用。
     和「精修」并排，两个都是「再多花一点算力换准确性」的开关，放一起才说得清。 */
  function ctxUI() {
    const b = $('btnSubCtx');
    if (!b) return;
    const has = !!(typeof Translator !== 'undefined' && Translator.complete);
    const onNow = ctxEnabled();
    b.textContent = has ? (onNow ? '语境' : '语境·关') : '语境·未装';
    b.classList.toggle('on', has && onNow);
    b.classList.toggle('off', !has || !onNow);
  }

  function onCtxClick() {
    const next = !ctxEnabled();
    setCtxEnabled(next);
    if (next) subs.forEach((s, i) => { if (!s.ctx && s.text) enqueueCtx(i); });
    updateStat();
    try {
      if (typeof U !== 'undefined' && U.toast) {
        U.toast(next
          ? '语境校对已开启：会结合前后几句改听错的字（需要本地模型）'
          : '语境校对已关闭', '', 2600);
      }
    } catch (e) { /* ignore */ }
  }

  /* ==================== 引导 / 进度 ==================== */

  function showGuide(msg) {
    const g = $('subGuide');
    const list = $('subList');
    if (list) list.hidden = true;
    if (!g) return;
    g.hidden = false;
    const st = Asr.probe();        // 真的去盘上看一眼，别拿冷启动时的 'unknown' 当结论
    const title = $('sgTitle');
    const desc = $('sgDesc');
    const go = $('btnSubGo');
    const bar = $('sgBar');
    if (bar) bar.hidden = true;

    if (msg) {
      if (title) title.textContent = '没能开启字幕';
      if (desc) desc.textContent = msg;
      if (go) { go.hidden = false; go.textContent = '重试'; }
      syncFixRow();
      return;
    }
    if (st.engine !== 'ready') {
      if (title) title.textContent = '需要先下载识别引擎';
      if (desc) desc.textContent = '在本机识别，音频不出网。引擎约 23 MB、语音模型约 189 MB，只需下载一次，之后离线可用。';
      if (go) { go.hidden = false; go.textContent = '下载并开启'; }
    } else if (st.model !== 'ready') {
      if (title) title.textContent = '还差语音模型';
      if (desc) desc.textContent = '识别引擎已就绪，下载语音模型（约 189 MB）后即可开始。';
      if (go) { go.hidden = false; go.textContent = '下载模型'; }
    } else {
      if (title) title.textContent = '开启实时字幕';
      if (desc) desc.textContent = '边播边转写，每次打开视频都从头开始；中文只显示原文，英文会补一条中文译文。全部在本机完成。';
      if (go) { go.hidden = false; go.textContent = '开启'; }
    }
    syncFixRow();
    updateStat();
  }

  /* 引导页的「顺便下精修模型」勾选项：已装就藏起来，别占地方 */
  function syncFixRow() {
    const row = $('sgFixRow');
    if (!row) return;
    let ready = false;
    try { ready = !!(Asr.refineProbe && Asr.refineProbe().ready); } catch (e) { ready = false; }
    row.hidden = ready;
  }

  function wantRefine() {
    const c = $('sgFix');
    return !c || c.checked;
  }

  function hideGuide() {
    const g = $('subGuide');
    if (g) g.hidden = true;
    const list = $('subList');
    if (list) list.hidden = false;
  }

  function showProgress(p) {
    const g = $('subGuide');
    if (g) g.hidden = false;
    const list = $('subList');
    if (list) list.hidden = true;
    const bar = $('sgBar');
    const fill = $('sgBarFill');
    const stat = $('sgStat');
    const go = $('btnSubGo');
    if (go) go.hidden = true;
    if (bar) bar.hidden = false;
    if (fill) fill.style.width = (p.pct || 0) + '%';
    if (stat) {
      const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';
      stat.textContent = (p.label || '准备中…') +
        (p.total ? ' · ' + mb(p.got) + ' / ' + mb(p.total) + '（' + p.pct + '%）' : (p.got ? ' · ' + mb(p.got) : ''));
    }
    if (p.stage === 'engine' || p.stage === 'model' || p.stage === 'refine') {
      const title = $('sgTitle');
      if (title) title.textContent = '首次使用，正在准备';
      const desc = $('sgDesc');
      if (desc) desc.textContent = '下载后缓存在本机，以后打开任何视频都不用再等。';
    }
  }

  /* ==================== 开关 ==================== */

  function setOn(v) {
    on = !!v;
    const list = $('subList');
    if (list) list.hidden = false;
    if (on) {
      start(false);
    } else {
      stop();
      hideGuide();
      updateStat();
    }
    const btn = $('btnSubToggle');
    if (btn) btn.textContent = on ? '暂停' : '开启';
  }

  /* auto=true 表示这是「打开视频时自动开启」，不是用户按的那一下。
     区别只有一条：**自动开启绝不下载任何东西**（引擎 23 MB / 模型 189 MB /
     精修 239 MB）。用户没点头就往盘里拽几百 MB，这不是贴心，是冒犯。 */
  async function start(force, auto) {
    if (busy) return;
    const st = Asr.probe();
    if (st.engine !== 'ready' || st.model !== 'ready') {
      if (!force || auto) { showGuide(); return; }
      busy = true;
      updateStat();
      const ok = await Asr.prepare({ onProgress: showProgress });
      busy = false;
      if (!ok) { showGuide(Asr.status().error || '下载失败，检查网络后重试'); return; }
    }

    /* 精修模型是可选的第二级：用户勾了才下。
       下不下来都不该挡住字幕 —— 失败就降级成「只出粗字幕」，并在状态栏说清楚。 */
    if (!auto && fixEnabled() && wantRefine()) {
      let ready = false;
      try { ready = !!Asr.refineProbe().ready; } catch (e) { ready = false; }
      if (!ready) {
        busy = true;
        updateStat();
        let ok2 = true;
        try { await Asr.ensureRefine(showProgress); }
        catch (e) { ok2 = false; }
        busy = false;
        if (!ok2) {
          setFixEnabled(false);
          try {
            if (typeof U !== 'undefined' && U.toast) {
              U.toast('精修模型没下成，先用实时字幕（可在字幕头部点「精修·未装」重试）', '', 4200);
            }
          } catch (e) { /* ignore */ }
        } else {
          /* 已经转过的句子补一遍：用户不用重播 */
          subs.forEach((s, i) => { if (!s.fix && s.text) enqueueFix(i); });
        }
      }
    }
    hideGuide();
    if (!attach(video)) {
      showGuide('这个环境拿不到播放器的音频输出，无法转写');
      return;
    }
    if (!wire()) {
      showGuide('音频通道建立失败，无法转写');
      return;
    }
    try { if (actx.state === 'suspended') await actx.resume(); } catch (e) { /* ignore */ }
    Asr.openStream();
    running = true;
    silentRuns = 0;
    warnedSilent = false;
    triedBlob = false;
    const btn = $('btnSubToggle');
    if (btn) btn.textContent = '暂停';
    on = true;
    updateStat();
    renderList();
  }

  function stop() {
    if (running) {
      let seg = null;
      try { seg = Asr.flush(video ? video.currentTime : 0); } catch (e) { seg = null; }
      if (seg) commit(seg);
    }
    running = false;
    partial = '';
    renderTail();
    /* 暂停时把还在内存里的音频写掉：精修读的是盘上的数据 */
    try { Asr.pcmFlush(); } catch (e) { /* ignore */ }
    updateStat();
  }

  function toggle() {
    if (on && running) {
      /* 用户主动按「暂停」= 这一路不想转了，记下来，下一个视频也不再自动开 */
      stop();
      on = false;
      setAutoEnabled(false);
      const b = $('btnSubToggle');
      if (b) b.textContent = '开启';
      updateStat();
      return;
    }
    setAutoEnabled(true);       // 手动开过一次 = 恢复「以后自动开」
    setOn(true);
  }

  /* ==================== 对外 ==================== */

  function setDoc(item) {
    stop();
    if (!video) video = $('videoEl');   // 界面先于 openVideoItem 调用时也能拿到
    docKey = keyOf(item || {});
    docTitle = (item && item.name) || '';
    /* 归档音频按条目分开：换视频就换文件。旧音轨留着 —— 重播时会按时间戳覆盖写，
       未覆盖的部分正好给「跳到中间再精修」兜底 */
    try { Asr.pcmOpen(docKey); } catch (e) { /* ignore */ }
    /* 异步预热精修模型（加载约 1 秒）。放在这里而不是第一句字幕到来时，
       是为了让那 1 秒发生在用户还在看画面、没在等结果的空档里。 */
    if (fixEnabled()) { try { if (Asr.warmRefine) Asr.warmRefine(); } catch (e) { /* ignore */ } }

    /* 每次打开视频都从头转写（v3.13）：
       清掉上一次的字幕 + 旧版本留下的缓存文件，然后回到「点开启」的初始态。 */
    resetSubs();
    dropLegacyCache();
    refreshHotwords();          // 术语表 / 文件名 → 热词，先于识别器建立
    on = false;
    running = false;
    const btn = $('btnSubToggle');
    if (btn) btn.textContent = '开启';
    renderList();

    /* 自动开启（v3.14）：引擎和模型都齐了就直接进待命，不再让用户每次都点一下。
       没齐（第一次用）照旧显示引导页 —— 绝不偷偷下载 212 MB。
       这里用 probe() 而不是 status()：status() 读的是缓存，冷启动时它还是
       'unknown'，会把「早就下好了」误判成「需要先下载」（3.14 修）。 */
    const st = Asr.probe();
    if (autoEnabled() && st.engine === 'ready' && st.model === 'ready') {
      hideGuide();
      start(false, true).then(() => {
        /* v4.2.1：自动开启偶尔会在视频元素还没完全就绪时接不上音频
           （attach 失败只会在隐藏面板里写引导页，用户根本看不见）。
           在视频真正出声的第一拍补一次 —— 保证「点开字幕面板就能看到已出的字」。 */
        if (!running && video && video.addEventListener) {
          const retry = () => {
            video.removeEventListener('playing', retry);
            if (autoEnabled() && !running && !busy) start(false, true);
          };
          video.addEventListener('playing', retry);
        }
      });
    } else {
      showGuide();
    }
  }

  function setVideo(elItem) {
    video = elItem || video;
  }

  function onTime(t) {
    if (!subs.length) return;
    let idx = -1;
    for (let i = subs.length - 1; i >= 0; i--) {
      if (t >= subs[i].t - 0.15) { idx = i; break; }
    }
    if (idx === curIdx) return;
    curIdx = idx;
    markCurrent();
    if (running && follow) scrollToCurrent();
  }

  let bound = false;
  let subHot = false;        // 鼠标最近一次点击是不是落在字幕面板里（决定 Ctrl+A 归谁）

  function typing(node) {
    if (!node) return false;
    const t = (node.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || node.isContentEditable;
  }

  function bind() {
    if (bound) return;                 // 每次打开视频都会调，重复绑就会存两条
    bound = true;
    const list = $('subList');
    if (list) {
      list.addEventListener('scroll', onListScroll, { passive: true });
      list.addEventListener('wheel', () => { setTimeout(onListScroll, 60); }, { passive: true });
    }
    const jump = $('subJump');
    if (jump) jump.addEventListener('click', () => { jumpToLatest(); });
    const sv = $('btnSubSave');
    if (sv) sv.addEventListener('click', () => { saveSelection(); });

    /* 「最近点在哪个面板里」：Ctrl+A 是全局键，得知道该选谁 */
    document.addEventListener('pointerdown', (e) => {
      const pane = $('subPane');
      subHot = !!(pane && e.target && pane.contains(e.target));
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.key || '').toLowerCase() !== 'a') return;
      if (!subHot || typing(e.target)) return;
      const pane = $('subPane');
      if (!pane || pane.hidden) return;
      e.preventDefault();
      selectAll();
    });

    const go = $('btnSubGo');
    if (go) go.addEventListener('click', () => { start(true); });
    const tg = $('btnSubToggle');
    if (tg) tg.addEventListener('click', () => { toggle(); });
    const fx = $('btnSubFix');
    if (fx) fx.addEventListener('click', () => { onFixClick(); });
    const cx = $('btnSubCtx');
    if (cx) cx.addEventListener('click', () => { onCtxClick(); });
    /* v3.30：专业领域。改完立刻重挂热词，下一次开播就按新领域偏置。 */
    const dm = $('subDomain');
    if (dm) {
      dm.value = domain();
      dm.addEventListener('change', () => {
        const id = setDomain(dm.value);
        dm.value = id;
        try {
          if (typeof U !== 'undefined' && U.toast) {
            const n = (typeof DomainTerms !== 'undefined') ? DomainTerms.terms(id).length : 0;
            U.toast(n
              ? '已切换到「' + DomainTerms.label(id) + '」：' + n + ' 个专业词参与识别偏置与语境校对'
              : '已切回通用领域', '', 3000);
          }
        } catch (e) { /* ignore */ }
      });
    }
  }

  /* 头部「精修」按钮：没装就去下，装了就是开关。
     这是个很容易被忽略的功能，所以三态文案直接写在按钮上，不用另开一个设置页。 */
  async function onFixClick() {
    if (busy) return;
    let ready = false;
    try { ready = !!Asr.refineProbe().ready; } catch (e) { ready = false; }
    if (!ready) {
      busy = true;
      hideGuide();
      const g = $('subGuide');
      if (g) { g.hidden = false; }
      const list = $('subList');
      if (list) list.hidden = true;
      const title = $('sgTitle');
      if (title) title.textContent = '下载精修模型';
      const desc = $('sgDesc');
      if (desc) desc.textContent = '239 MB，只需一次。之后每句落定都会重听一遍，中文更准、带标点。';
      const go = $('btnSubGo');
      if (go) go.hidden = true;
      let ok = true;
      try { await Asr.ensureRefine(showProgress); } catch (e) { ok = false; }
      busy = false;
      if (!ok) { showGuide('精修模型下载失败，检查网络后重试'); return; }
      hideGuide();
      setFixEnabled(true);
      subs.forEach((s, i) => { if (!s.fix && s.text) enqueueFix(i); });
      updateStat();
      return;
    }
    const next = !fixEnabled();
    setFixEnabled(next);
    if (next) subs.forEach((s, i) => { if (!s.fix && s.text) enqueueFix(i); });
    updateStat();
    try {
      if (typeof U !== 'undefined' && U.toast) {
        U.toast(next ? '精修已开启：新句子会用非流式模型重听' : '精修已关闭：只出实时字幕', '', 2400);
      }
    } catch (e) { /* ignore */ }
  }

  function isOn() { return on; }
  function isRunning() { return running; }
  function rows() { return subs; }

  /* ==================== 导出：字幕 → 知识库 ====================
     这是「音频 → 知识库」这条链的最后一公里。
     格式上带时间戳，是为了以后能回跳到视频的那一秒；纯文本反而少了定位能力，
     而 LLM 读 `**01:23** text` 这种行完全不费力。 */
  function baseName(item) {
    const id = String((item && item.id) || 'video');
    const raw = String((item && item.name) || docTitle || '未命名').replace(/\.[^.]+$/, '');
    const clean = raw.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 72);
    return id + '-' + (clean || '未命名');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '+' + pad(-d.getTimezoneOffset() / 60).replace(/^(\d)$/, '0$1') + ':00';
  }

  function markdown(item) {
    const name = String((item && item.name) || docTitle || '未命名').replace(/\.[^.]+$/, '');
    const fixed = subs.filter((s) => s.fix).length;
    const out = [];
    out.push('---');
    out.push('eagle: ' + ((item && item.id) || ''));
    out.push('file: ' + name);
    out.push('kind: subtitles');
    out.push('cues: ' + subs.length);
    out.push('refined: ' + fixed);
    out.push('updated: ' + stamp());
    out.push('---');
    out.push('');
    out.push('# ' + name + ' · 字幕');
    out.push('');
    subs.forEach((s) => {
      out.push('**' + fmt(s.t) + '**　' + s.text);
      if (s.zh) out.push('> ' + s.zh);
      out.push('');
    });
    return out.join('\n');
  }

  /* 字幕 md + 归档音频（wav）一起落到 _notes。
     音频是「资料本身」，不是附属品 —— 后面要做检索、重听、换模型重跑，
     有原始音轨才有主动权，而不是只能回视频里翻。 */
  function exportAll(item, dir) {
    if (!fs || !pathMod || !dir) return { ok: false, error: '没有可写的目录' };
    if (!subs.length) return { ok: false, error: '还没有字幕内容' };
    const base = baseName(item);
    const res = { ok: true, md: null, wav: null, mdSize: 0, wavSize: 0 };
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, error: '目录不可写：' + ((e && e.message) || e) };
    }
    try {
      const p = pathMod.join(dir, base + '.subs.md');
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, markdown(item), 'utf8');
      fs.renameSync(tmp, p);
      res.md = p;
      try { res.mdSize = fs.statSync(p).size; } catch (e) { /* ignore */ }
    } catch (e) {
      return { ok: false, error: '写字幕失败：' + ((e && e.message) || e) };
    }
    try {
      if (docKey && Asr.pcmExportWav) {
        const w = Asr.pcmExportWav(docKey, pathMod.join(dir, base + '.audio.wav'));
        if (w) {
          res.wav = w;
          try { res.wavSize = fs.statSync(w).size; } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* 音频导不出来不影响字幕已经落盘 */ }
    return res;
  }

  /* 关闭视频时把采集支路拆掉：留着 ScriptProcessor 会一直占着音频线程。
     注意**只拆旁路**——MediaElementSource 已经把元素的音频接管了，
     要是连原声那条也断掉，用户关掉字幕后视频就永久没声音（3.10 的隐患）。 */
  function detach() {
    stop();
    try { if (proc) { proc.disconnect(); proc.onaudioprocess = null; } } catch (e) { /* ignore */ }
    proc = null;
    resampler = null;
    try {
      if (srcNode && actx) {
        srcNode.disconnect();
        srcNode.connect(actx.destination);   // 回到「原声直达」
      }
    } catch (e) { /* ignore */ }
    try { Asr.pcmClose(); } catch (e) { /* ignore */ }
  }

  return {
    bind, setDoc, setVideo, detach, start, stop, toggle, onTime,
    setOn, isOn, isRunning, rows, updateStat, renderList,
    attach, wire,
    /* 精修 */
    fixEnabled, setFixEnabled, onFixClick, fixCount: () => fixCount,
    /* 语境校对（v3.14） */
    ctxEnabled, setCtxEnabled, onCtxClick, ctxCount: () => ctxCount,
    /* 语义断句（v3.26） */
    breakOn, setBreakOn,
    _resplit: resplit, _finalize: finalize, _zhOk: zhOk,
    /* 自动开启 */
    autoEnabled, setAutoEnabled,
    /* 跟随 / 多选（v3.15） */
    jumpToLatest,
    onSaveSelection: (fn) => { saveHook = fn; },
    selectedGroups, saveSelection, clearSelection: clearSel,
    /* 热词 */
    refreshHotwords, hotwordList,
    /* v3.30：专业领域 */
    domain, setDomain,
    /* 导出 */
    markdown, exportAll, baseName,
    /* 测试用 */
    _fmt: fmt,
    _loadRows: (a) => { subs = a; },       // 只塞数据、不渲染（无 DOM 环境测试用）
    _resetSubs: resetSubs
  };
})();

try { window.Subtitle = Subtitle; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = Subtitle;
