/* 本地语音识别（v3.10）

   「视频实时字幕」的引擎层。为什么不用 Ollama：它只做文本/图片，没有声学模型；
   为什么不用 whisper.cpp：它的 Windows 二进制只在 GitHub Release 上，国内经常连不上，
   而且它是「整段跑完再出字」，十几分钟的片子要等好几分钟才有第一句。

   这里选 sherpa-onnx：流式（边说边出字，延迟不到一秒）、有 npm 预编译包（走国内镜像很快）、
   中英双语模型天然支持一句话里混着中英文 —— 正好对上「中文不翻译、英文要双语」的需求。

   两样东西不打进插件包（否则从 2.3 MB 涨到 210 MB，商店也过不了）：
     引擎  sherpa-onnx-node + 平台原生包（约 23 MB）   ← npmmirror
     模型  中英双语 streaming zipformer int8（约 189 MB） ← hf-mirror
   第一次点「开启字幕」时下载一次，之后离线可用。

   注意：这里只负责「拿到 PCM → 出文字」。音频怎么来由 subtitle.js 管（从 <video> 里抓），
   所以不依赖 ffmpeg —— 浏览器能播的视频，这里就能转写。 */
const Asr = (function () {
  let fs = null, pathMod = null, https = null, zlib = null, os = null, node = false;
  try {
    if (typeof require === 'function') {
      fs = require('fs');
      pathMod = require('path');
      https = require('https');
      zlib = require('zlib');
      os = require('os');
      node = !!(fs && pathMod && https);
    }
  } catch (e) { node = false; }

  /* ---------- 可选模型 ----------
     小模型 24 MB 就能跑，但中文错字明显（"礼拜三"会被认成"妈呗三"），
     所以默认给标准模型。快/准由用户自己选，界面上写清楚代价。 */
  const MODELS = {
    small: {
      id: 'zh-14m',
      title: '轻量（只中文）',
      desc: '约 24 MB · 启动快，适合纯中文、网络慢的场合',
      repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
      files: ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt'],
      /* 建模单元：热词要靠它把词切成 token，必须与训练时一致 */
      unit: 'cjkchar',
      bpe: ''
    },
    main: {
      id: 'bilingual-zh-en',
      title: '标准（中英双语）',
      desc: '约 189 MB · 中英混说都能认，英文准确度明显更好',
      repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
      files: ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt'],
      unit: 'cjkchar+bpe',
      bpe: 'bpe.vocab'
    }
  };
  const DEFAULT_MODEL = 'main';

  /* ---------- 精修模型（v3.12）----------
     流式模型的宿命：为了「边说边出字」，它只能用很短的上下文和单向注意力，
     遇到专业术语、人名、数字，错得很有规律（"胆囊三角"→"单囊三角"）。
     既然字幕最终是要进知识库的，就不能只有流式这一层。

     做法：每句话落定后，把这段时间的原始音频交给非流式模型重听一遍。
     SenseVoice 是非自回归结构（并行输出，不是逐字生成），
     10 秒音频在 2 个线程上约 0.15–0.3 秒 —— 比流式慢，但用户说慢一点没关系。
     它自带中文标点（ITN），这是流式模型给不了的，对知识库尤其重要。 */
  const REFINE = {
    sense: {
      id: 'sense-voice-zh-en-ja-ko-yue',
      title: 'SenseVoice（中文最准）',
      desc: '约 239 MB · 中/英/日/韩/粤，自带标点',
      repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      files: ['model.int8.onnx', 'tokens.txt'],
      bytes: 239233841
    }
  };
  const DEFAULT_REFINE = 'sense';
  const LS_REFINE = 'eaglenote.asr.refine';

  const PKG_JS = 'sherpa-onnx-node';
  const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];
  const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];
  const LS_MODEL = 'eaglenote.asr.model';

  let rootDir = '';            // <dataDir>/asr
  let sherpa = null;           // 已加载的 sherpa-onnx-node
  let rec = null;              // OnlineRecognizer 单例（模型加载一次就复用）
  let recModel = '';           // rec 对应的模型 id
  let stream = null;           // 当前识别流
  let segStart = null;         // 当前这句话的起点（秒）
  let pendingDur = 0;          // 上一次落段以来喂进去的音频长度（秒）

  /* 精修（非流式）这边是另一套东西：模型不同、线程预算也不同，所以单开一份状态 */
  let offRec = null;
  let offReady = false;

  /* 音频归档：<asr>/audio/<docKey>.pcm（16 kHz 单声道 int16）
     为什么要落盘而不是只放内存：一段 1 小时的视频就是 115 MB，
     全放内存迟早把插件撑爆；而且落盘之后「精修」和「重播」都不用重新解码，
     顺带成了知识库的原始素材（音频本身也是资料的一部分）。 */
  let pcmFd = null;
  let pcmPath = '';
  let pcmDoc = '';
  let pcmPend = [];            // 还没写盘的 Float32Array 片段
  let pcmPendN = 0;            // 上面这些片段一共多少样本
  let pcmPendAt = 0;           // 第一个待写片段在文件里的起始样本序号

  const state = {
    engine: 'unknown',         // unknown | missing | ready
    model: 'unknown',          // unknown | missing | ready
    modelId: DEFAULT_MODEL,
    loading: false,
    error: '',
    /* 下载进度：{stage, label, got, total, pct} */
    progress: null
  };

  function setDataDir(p) {
    if (!p || !pathMod) return;      // 非 Eagle 环境（纯浏览器 / 测试）没有 path
    rootDir = pathMod.join(p, 'asr');
    /* 目录换了（Bridge 晚于首次 probe 才注入）→ 之前那份「缺引擎 / 缺模型」的结论作废，
       不然明明下好了，界面还一直提示要下载（v3.14 修的就是这个）。 */
    state.engine = 'unknown';
    state.model = 'unknown';
    try { fs.mkdirSync(rootDir, { recursive: true }); } catch (e) { /* ignore */ }
  }

  function ensureRoot() {
    if (!rootDir) {
      /* 实在没拿到数据目录，退到临时目录：功能还能用，只是下次要重下 */
      const tmp = (os && os.tmpdir ? os.tmpdir() : '.');
      rootDir = pathMod.join(tmp, 'eaglenote-asr');
    }
    try { fs.mkdirSync(rootDir, { recursive: true }); } catch (e) { /* ignore */ }
    return rootDir;
  }

  function nodeModulesDir() { return pathMod.join(ensureRoot(), 'node_modules'); }
  function platformPkg() {
    const plat = (typeof process !== 'undefined' && process.platform) ? process.platform : 'win32';
    const arch = (typeof process !== 'undefined' && process.arch) ? process.arch : 'x64';
    return 'sherpa-onnx-' + (plat === 'win32' ? 'win' : plat) + '-' + arch;
  }
  function modelDir(key) { return pathMod.join(ensureRoot(), 'models', (MODELS[key] || MODELS[DEFAULT_MODEL]).id); }

  function fileOk(p) {
    try { const st = fs.statSync(p); return !!(st && st.isFile() && st.size > 0); } catch (e) { return false; }
  }

  /* ==================== 下载 ==================== */

  function httpGet(url, depth) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'EagleNoteManager/3.10', 'Accept': '*/*' }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (depth || 0) < 6) {
          res.resume();
          let next = res.headers.location;
          try { next = new URL(res.headers.location, url).toString(); } catch (e) { /* 相对地址兜底 */ }
          return resolve(httpGet(next, (depth || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        resolve(res);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { try { req.destroy(new Error('连接超时')); } catch (e) { /* ignore */ } });
    });
  }

  /* 下载到文件。先写 .part 再改名，断在中途不会留下半个文件被当成「已下载」。 */
  async function downloadTo(url, dest, onTick) {
    const res = await httpGet(url, 0);
    const total = Number(res.headers['content-length'] || 0);
    const part = dest + '.part';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      let got = 0;
      let last = 0;
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        try { out.destroy(); } catch (err) { /* ignore */ }
        try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
        reject(e);
      };
      res.on('data', (c) => {
        got += c.length;
        if (onTick && Date.now() - last > 250) {
          last = Date.now();
          onTick(got, total);
        }
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (done) return;
        done = true;
        try { fs.renameSync(part, dest); } catch (e) { return reject(e); }
        if (onTick) onTick(got, total || got);
        resolve();
      });
      res.pipe(out);
    });
  }

  /* 多源依次尝试：国内镜像优先，挂了再走官方源 */
  async function downloadAny(paths, dest, onTick) {
    let lastErr = null;
    for (const url of paths) {
      try {
        await downloadTo(url, dest, onTick);
        return url;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('下载失败');
  }

  /* ==================== tar.gz 解包 ====================
     npm 的 tgz 里就是「512 字节头 + 内容」重复，写一个够用的解析器，
     比依赖 PowerShell / tar 命令稳 —— 那些在部分机器上被策略禁用。 */
  function cstr(buf, off, len) {
    let end = off;
    const max = off + len;
    while (end < max && buf[end] !== 0) end++;
    return buf.toString('utf8', off, end);
  }

  function extractTgz(tgzPath, destDir) {
    const raw = zlib.gunzipSync(fs.readFileSync(tgzPath));
    let off = 0;
    let files = 0;
    while (off + 512 <= raw.length) {
      /* 连续两个全零块 = 结束 */
      if (raw[off] === 0) break;
      const name = cstr(raw, off, 100);
      if (!name) break;
      const sizeStr = cstr(raw, off + 124, 12).trim();
      const size = sizeStr ? (parseInt(sizeStr, 8) || 0) : 0;
      const type = String.fromCharCode(raw[off + 156] || 48);
      const prefix = cstr(raw, off + 345, 155);
      const full = (prefix ? prefix + '/' : '') + name;
      const start = off + 512;

      if (type === '0' || type === '\u0000') {
        /* 去掉首层目录（npm 打包统一是 package/） */
        const rel = full.replace(/^[^/]+\//, '');
        if (rel && !/\/$/.test(rel)) {
          const out = pathMod.join(destDir, rel);
          try {
            fs.mkdirSync(pathMod.dirname(out), { recursive: true });
            fs.writeFileSync(out, raw.subarray(start, start + size));
            files++;
          } catch (e) { /* 单个文件失败不中断 */ }
        }
      }
      off = start + Math.ceil(size / 512) * 512;
    }
    return files;
  }

  function rmrf(p) {
    try {
      if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
      else if (fs.rmdirSync) fs.rmdirSync(p, { recursive: true });
    } catch (e) { /* ignore */ }
  }

  async function pkgTarball(name) {
    let lastErr = null;
    for (const reg of REGISTRIES) {
      try {
        const res = await httpGet(reg + '/' + name + '/latest', 0);
        const text = await new Promise((resolve, reject) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { s += c; });
          res.on('end', () => resolve(s));
          res.on('error', reject);
        });
        const j = JSON.parse(text);
        let url = j && j.dist && j.dist.tarball;
        if (!url) throw new Error('没有 tarball 地址');
        /* 官方源给的地址可能还是 npmjs.org，换成本次可用的镜像 */
        url = String(url).replace(/^https?:\/\/registry\.npmjs\.org/, reg);
        return { version: j.version || '', url };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('取包信息失败');
  }

  /* ==================== 引擎 ==================== */

  function enginePresent() {
    if (!node) return false;
    const js = pathMod.join(nodeModulesDir(), PKG_JS, 'sherpa-onnx.js');
    const bin = pathMod.join(nodeModulesDir(), platformPkg(), 'sherpa-onnx.node');
    return fileOk(js) && fileOk(bin);
  }

  function loadSherpa() {
    if (sherpa) return sherpa;
    const entry = pathMod.join(nodeModulesDir(), PKG_JS);
    sherpa = require(entry);
    return sherpa;
  }

  async function ensureEngine(onProgress) {
    if (enginePresent()) {
      state.engine = 'ready';
      return true;
    }
    if (!node) throw new Error('当前环境不支持本地识别');
    state.engine = 'missing';
    const nm = nodeModulesDir();
    fs.mkdirSync(nm, { recursive: true });

    const names = [PKG_JS, platformPkg()];
    for (const name of names) {
      const info = await pkgTarball(name);
      if (onProgress) onProgress({ stage: 'engine', label: '正在下载识别引擎 · ' + name, got: 0, total: 0, pct: 0 });
      const tgz = pathMod.join(ensureRoot(), name + '.tgz');
      await downloadAny([info.url], tgz, (got, total) => {
        if (onProgress) onProgress({
          stage: 'engine', label: '正在下载识别引擎 · ' + name,
          got, total, pct: total ? Math.round(got / total * 100) : 0
        });
      });
      if (onProgress) onProgress({ stage: 'engine', label: '正在解压识别引擎…', got: 1, total: 1, pct: 100 });
      const dest = pathMod.join(nm, name);
      rmrf(dest);
      fs.mkdirSync(dest, { recursive: true });
      extractTgz(tgz, dest);
      try { fs.unlinkSync(tgz); } catch (e) { /* ignore */ }
    }
    if (!enginePresent()) throw new Error('识别引擎解压不完整');
    state.engine = 'ready';
    return true;
  }

  /* ==================== 模型 ==================== */

  /* 选中的模型记在 localStorage；文件协议下 localStorage 可能不可写，
     所以再留一份内存副本 —— 不然「切了小模型又自己跳回大模型」这种怪事会出现。 */
  let modelOverride = '';

  function modelKey() {
    if (modelOverride && MODELS[modelOverride]) return modelOverride;
    try {
      const v = localStorage.getItem(LS_MODEL);
      if (v && MODELS[v]) { modelOverride = v; return v; }
    } catch (e) { /* ignore */ }
    return DEFAULT_MODEL;
  }

  function setModel(key) {
    if (!MODELS[key]) return;
    modelOverride = key;
    try { localStorage.setItem(LS_MODEL, key); } catch (e) { /* ignore */ }
    if (recModel !== key) { rec = null; recModel = ''; }
    state.modelId = key;
  }

  function modelPresent(key) {
    if (!node) return false;
    const dir = modelDir(key);
    return (MODELS[key] || MODELS[DEFAULT_MODEL]).files.every((f) => fileOk(pathMod.join(dir, f)));
  }

  async function ensureModel(key, onProgress) {
    const k = MODELS[key] ? key : modelKey();
    if (modelPresent(k)) {
      state.model = 'ready';
      state.modelId = k;
      return true;
    }
    const m = MODELS[k];
    const dir = modelDir(k);
    fs.mkdirSync(dir, { recursive: true });

    /* 每个文件的大小边下边攒，进度条才有分母（拿不到就退化成「已下载 x MB」） */
    const sizes = m.files.map(() => 0);

    for (let i = 0; i < m.files.length; i++) {
      const f = m.files[i];
      const dest = pathMod.join(dir, f);
      if (fileOk(dest)) continue;
      const urls = MIRRORS.map((base) => base + '/' + m.repo + '/resolve/main/' + f);
      await downloadAny(urls, dest, (got, total) => {
        if (!total) return;
        if (!sizes[i]) sizes[i] = total;
        const sum = sizes.slice(0, i).reduce((a, b) => a + b, 0);
        const tot = sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : 0;
        if (onProgress) onProgress({
          stage: 'model',
          label: '正在下载语音模型 · ' + (i + 1) + '/' + m.files.length,
          got: sum + got,
          total: tot,
          pct: tot ? Math.round((sum + got) / tot * 100) : 0
        });
      });
    }
    if (!modelPresent(k)) throw new Error('语音模型不完整，请重试');
    state.model = 'ready';
    state.modelId = k;
    return true;
  }

  /* ==================== 热词偏置（v3.14） ====================
     医学术语被听错，本质是「声学上都对，只是通用语料里那个词更常见」：
     胆囊三角 → 单囊三角、冠状动脉 → 冠状动漫。这类错误靠换模型收效很慢，
     而热词（contextual biasing）是 sherpa-onnx 在解码时给指定词加分 ——
     不用重训模型、不用重新下载权重，改一个文本文件就行。

     限制要说清楚：sherpa-onnx 的热词只对 **transducer + modified_beam_search** 生效，
     我们流式那支正好是 zipformer transducer 且已经在用 modified_beam_search，
     所以直接能吃；精修用的 SenseVoice 是非 transducer，吃不到 ——
     热词只提升「第一遍出字」，精修那一遍仍然按音频自己听。

     热词文件是按建模单元切分的：纯中文模型是 cjkchar（按字），
     中英双语是 cjkchar+bpe，这时必须再给一份 bpe.vocab（约 1 MB，单独下一次）。 */

  let hotwords = [];
  let hotSig = '';

  function hotwordsPath() { return pathMod ? pathMod.join(ensureRoot(), 'hotwords.txt') : ''; }
  function bpeVocabPath(key) {
    if (!pathMod) return '';
    const m = MODELS[key || modelKey()] || MODELS[DEFAULT_MODEL];
    return m.bpe ? pathMod.join(modelDir(key || modelKey()), m.bpe) : '';
  }

  /* 热词要不要等一份额外文件：中英模型要 bpe.vocab，没有它热词开不起来 */
  function hotwordNeed() {
    if (!node || !pathMod) return '';
    const k = modelKey();
    const m = MODELS[k] || MODELS[DEFAULT_MODEL];
    if (!m.bpe) return '';
    return fileOk(bpeVocabPath(k)) ? '' : m.bpe;
  }

  /* 单独下一次 bpe.vocab。放在这里而不是塞进 models.files，
     是因为「已下过 189 MB 模型」的用户不该因为多了个小文件被判定成模型不完整。 */
  async function ensureHotwordAsset(onProgress) {
    if (!node || !pathMod) return false;
    const k = modelKey();
    const m = MODELS[k] || MODELS[DEFAULT_MODEL];
    if (!m.bpe) return true;
    const dest = bpeVocabPath(k);
    if (fileOk(dest)) return true;
    if (!node) return false;
    try {
      fs.mkdirSync(modelDir(k), { recursive: true });
      await downloadAny(MIRRORS.map((b) => b + '/' + m.repo + '/resolve/main/' + m.bpe), dest,
        (got, total) => {
          if (onProgress) onProgress({
            stage: 'hotword', label: '正在下载热词分词表…', got, total,
            pct: total ? Math.round(got / total * 100) : 0
          });
        });
    } catch (e) { return false; }
    return fileOk(dest);
  }

  /* 换热词 = 换识别器：词条是建在解码图里的，改完必须重建。
     重建要重新加载 189 MB 权重（约 1 秒），所以调用方只在「内容真的变了」时才拿到 true。 */
  function setHotwords(list) {
    const clean = [];
    const seen = Object.create(null);
    (list || []).forEach((w) => {
      const s = String(w || '').trim().replace(/[\r\n]+/g, ' ');
      if (!s || s.length > 24) return;
      /* 每行至少一个字母/汉字 —— 纯数字或纯符号会被 sherpa 判为无效行 */
      if (!/[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]/.test(s)) return;
      /* bpe 词表是大写的（sentencepiece 那套），英文热词要按大写写进去才匹配得上；
         中文是 cjkchar，按原样。 */
      const hw = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s) ? s : s.toUpperCase();
      const key = hw.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      clean.push(hw);
    });
    const sig = clean.join('\n');
    if (sig === hotSig) return false;
    hotSig = sig;
    hotwords = clean;
    if (node) {
      try {
        if (clean.length) fs.writeFileSync(hotwordsPath(), clean.join('\n') + '\n', 'utf8');
        else { try { fs.unlinkSync(hotwordsPath()); } catch (e) { /* ignore */ } }
      } catch (e) { /* 写不了就只走内存，热词降级为关闭 */ }
    }
    /* 让下一次 recognizer() 用新配置重建 */
    rec = null;
    recModel = '';
    return true;
  }

  function hotwordState() {
    return {
      count: hotwords.length,
      ready: !!hotwords.length && !hotwordNeed(),
      need: hotwordNeed(),
      unit: (MODELS[modelKey()] || MODELS[DEFAULT_MODEL]).unit
    };
  }

  /* ==================== 识别器 ==================== */

  function threads() {
    const n = (os && os.cpus) ? os.cpus().length : 4;
    return Math.max(1, Math.min(4, n));
  }

  function recognizer(key) {
    const k = key || modelKey();
    if (rec && recModel === k) return rec;
    const S = loadSherpa();
    const dir = modelDir(k);
    const m = MODELS[k] || MODELS[DEFAULT_MODEL];
    const pick = (kw) => m.files.filter((f) => f.indexOf(kw) >= 0)[0];

    const cfg = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: pathMod.join(dir, pick('encoder')),
          decoder: pathMod.join(dir, pick('decoder')),
          joiner: pathMod.join(dir, pick('joiner'))
        },
        tokens: pathMod.join(dir, 'tokens.txt'),
        numThreads: threads(),
        provider: 'cpu',
        debug: 0
      },
      /* modified_beam_search 比 greedy 多留几条候选路径再回看，
         中英混说的句子不会一条路走到黑（"attention is all you need" 这类
         被贪心解码切成乱七八糟的片段，beam 能救回来）。代价是 CPU 翻两三倍，
         4 线程下仍能实时，而准确度提升是立刻能听见的。
         另外它也是热词的前提 —— sherpa 只在 modified_beam_search 下应用热词。 */
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      /* 端点检测 = 自动断句。阈值是「宁可晚一点断」：
         1.2 秒那档会把说话人换气的停顿当成一句结束，字幕就卡在句子中间（v3.15 修）。
         放到 1.9 秒后，正常换气不再触发；连续讲满 26 秒才强制断一次，
         免得一整条几万字。真被硬切开的情况由 subtitle 的合并逻辑再兜一层。 */
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.8,
      rule2MinTrailingSilence: 1.9,
      rule3MinUtteranceLength: 26
    };

    /* 热词：分词表齐了才挂上去。缺 bpe.vocab 就静默降级 ——
       少一份热词不该让字幕直接开不起来。 */
    const bpePath = bpeVocabPath(k);
    if (hotwords.length && fileOk(hotwordsPath()) && (!m.bpe || fileOk(bpePath))) {
      cfg.hotwordsFile = hotwordsPath();
      cfg.hotwordsScore = 2.2;        // 每个命中 token 加的分；太高会把正常句子拽歪
      cfg.modelingUnit = m.unit;
      if (m.bpe) cfg.bpeVocab = bpePath;
    }

    try {
      rec = new S.OnlineRecognizer(cfg);
    } catch (e) {
      /* 万一这个版本的 sherpa 不认热词字段，退回无热词配置再来一次 */
      delete cfg.hotwordsFile; delete cfg.hotwordsScore;
      delete cfg.modelingUnit; delete cfg.bpeVocab;
      rec = new S.OnlineRecognizer(cfg);
    }
    recModel = k;
    return rec;
  }

  /* 声卡出来的通常是 44.1k / 48k，识别器只吃 16k。
     用 sherpa 自带的线性重采样（C 实现，比在 JS 里手写降采样快得多）。 */
  function makeResampler(inRate) {
    const S = loadSherpa();
    return new S.LinearResampler(Number(inRate) || 48000, 16000);
  }

  function openStream() {
    const R = recognizer();
    stream = R.createStream();
    segStart = null;
    pendingDur = 0;
    return true;
  }

  function closeStream() {
    stream = null;
    segStart = null;
    pendingDur = 0;
  }

  /* 视频跳转后必须重置：识别流里还带着上一处的声学上下文，
     不重置会把跳转前那半句话接着读下去，字幕就完全对不上了。 */
  function resetStream() {
    if (!stream) return;
    try { recognizer().reset(stream); } catch (e) { /* ignore */ }
    segStart = null;
    pendingDur = 0;
  }

  /* 喂一段 16 kHz 单声道 PCM。
     tNow 是这段音频对应的视频时间（秒），用来给字幕打时间戳。
     返回 {partial, segment}：partial 是「正在说的这半句」，segment 是刚落定的一句。 */
  function feed(samples, tNow) {
    if (!stream || !samples || !samples.length) return null;
    const R = recognizer();
    const dur = samples.length / 16000;
    try {
      stream.acceptWaveform({ sampleRate: 16000, samples });
      while (R.isReady(stream)) R.decode(stream);
    } catch (e) {
      return null;
    }
    const res = R.getResult(stream);
    const text = String((res && res.text) || '').trim();
    let segment = null;

    if (text && segStart == null) segStart = Math.max(0, (Number(tNow) || 0) - pendingDur - dur);

    if (R.isEndpoint(stream)) {
      if (text) {
        segment = { t: Math.max(0, segStart == null ? (Number(tNow) || 0) - dur : segStart), t1: Number(tNow) || 0, text };
      }
      try { R.reset(stream); } catch (e) { /* ignore */ }
      segStart = null;
      pendingDur = 0;
    } else {
      pendingDur += dur;
    }
    return { partial: text, segment };
  }

  /* 收尾：播放结束 / 关闭字幕时，把没断句的最后半句也交出来。
     注意这里**不能**无条件再 decode 一次 —— 流里的帧已经在前面的 feed 里解完了，
     再灌一次会顶爆 sherpa 内部的帧缓冲（实测直接 abort：992 + 39 > 1004）。
     只在确实还有待解码的帧时才解。 */
  function flush(tNow) {
    if (!stream) return null;
    const R = recognizer();
    try {
      while (R.isReady(stream)) R.decode(stream);
    } catch (e) { /* 没有更多可解的帧，正常 */ }
    let text = '';
    try { text = String((R.getResult(stream).text) || '').trim(); } catch (e) { text = ''; }
    let seg = null;
    if (text) seg = { t: Math.max(0, segStart == null ? (Number(tNow) || 0) : segStart), t1: Number(tNow) || 0, text };
    closeStream();
    return seg;
  }

  /* ==================== 精修：非流式重识别 ====================
     流程：流式先出一句「粗字幕」→ 这句的音频原始 PCM 已经归档在盘上
     → 把这段音频交给非流式模型重听 → 用更准的文本替换掉。

     为什么能做到「不打扰播放」：OfflineRecognizer.decodeAsync 把计算丢进
     libuv 线程池，主线程照常跑动画和音频回调；线程数限到 2，避免和流式抢 CPU。 */

  function refineKey() {
    try {
      const v = localStorage.getItem(LS_REFINE);
      if (v && REFINE[v]) return v;
    } catch (e) { /* ignore */ }
    return DEFAULT_REFINE;
  }

  function refineDir(key) {
    return pathMod.join(ensureRoot(), 'refine', (REFINE[key] || REFINE[DEFAULT_REFINE]).id);
  }

  function refinePresent(key) {
    if (!node) return false;
    const dir = refineDir(key);
    return (REFINE[key] || REFINE[DEFAULT_REFINE]).files.every((f) => fileOk(pathMod.join(dir, f)));
  }

  async function ensureRefine(onProgress) {
    /* 兼容两种传参：裸函数（本文档约定）与 { onProgress } 对象（prepare 的样式）——
       对象是真值，直接当函数调会炸「onProgress is not a function」，下载刚起步就崩（v4.3.5 修） */
    if (onProgress && typeof onProgress !== 'function' && typeof onProgress.onProgress === 'function') {
      onProgress = onProgress.onProgress;
    }
    const k = refineKey();
    if (refinePresent(k)) return true;
    if (!node) throw new Error('当前环境不支持本地识别');
    const m = REFINE[k];
    const dir = refineDir(k);
    fs.mkdirSync(dir, { recursive: true });
    const sizes = m.files.map(() => 0);
    for (let i = 0; i < m.files.length; i++) {
      const f = m.files[i];
      const dest = pathMod.join(dir, f);
      if (fileOk(dest)) continue;
      const urls = MIRRORS.map((base) => base + '/' + m.repo + '/resolve/main/' + f);
      await downloadAny(urls, dest, (got, total) => {
        if (!total) return;
        if (!sizes[i]) sizes[i] = total;
        const sum = sizes.slice(0, i).reduce((a, b) => a + b, 0);
        const tot = sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : 0;
        if (onProgress) onProgress({
          stage: 'refine',
          label: '正在下载精修模型 · ' + (i + 1) + '/' + m.files.length,
          got: sum + got,
          total: tot,
          pct: tot ? Math.round((sum + got) / tot * 100) : 0
        });
      });
    }
    if (!refinePresent(k)) throw new Error('精修模型不完整，请重试');
    return true;
  }

  /* SenseVoice 的 language 给 `<|zh|>`，情绪给 `<|NEUTRAL|>`，事件给 `<|Speech|>`。
     语言标签比「数汉字有几个」准得多 —— 中英混说时中文模型会直接告诉你这是 zh。 */
  function tagOf(v) {
    const m = /<\|([A-Za-z]+)\|>/.exec(String(v || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function refineConfig(k) {
    const dir = refineDir(k);
    const m = REFINE[k] || REFINE[DEFAULT_REFINE];
    const cfg = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        tokens: pathMod.join(dir, 'tokens.txt'),
        /* 线程只给 2：流式那边还在实时吃 CPU，精修是「慢一点没关系」的那一半，
           让它把资源让出来，界面才不会卡。 */
        numThreads: Math.max(1, Math.min(2, threads())),
        provider: 'cpu',
        debug: 0
      }
    };
    if (m.id.indexOf('sense') === 0) {
      cfg.modelConfig.senseVoice = {
        model: pathMod.join(dir, 'model.int8.onnx'),
        /* auto：让模型自己判断中/英/日/韩/粤。
           ITN 打开才有标点和数字规范化 —— 知识库要的是能读的句子，
           "礼拜2" 这种小瑕疵比通篇没有标点划算得多。 */
        language: 'auto',
        useInverseTextNormalization: 1
      };
    }
    return cfg;
  }

  function refineRecognizer() {
    const k = refineKey();
    if (offRec && offKey === k) return offRec;
    const S = loadSherpa();
    offRec = new S.OfflineRecognizer(refineConfig(k));
    offKey = k;
    return offRec;
  }

  /* 预热。模型第一次加载要 1 秒左右（实测），同步构造会把界面硬卡一下 ——
     用户刚点完「开启」，画面定住一秒，很容易被当成卡死。
     createAsync 把加载丢进线程池，主线程该干嘛干嘛。 */
  function warmRefine() {
    const k = refineKey();
    if (offRec && offKey === k) return Promise.resolve(true);
    if (!refinePresent(k)) return Promise.resolve(false);
    let S = null;
    try { S = loadSherpa(); } catch (e) {
      refineErr = (e && e.message) || String(e);
      return Promise.resolve(false);
    }
    if (!S.OfflineRecognizer.createAsync) {
      return new Promise((r) => setTimeout(() => {
        try { refineRecognizer(); r(true); } catch (e) { refineErr = (e && e.message) || String(e); r(false); }
      }, 0));
    }
    return S.OfflineRecognizer.createAsync(refineConfig(k))
      .then((rec) => {
        if (!offRec) { offRec = rec; offKey = k; }
        return true;
      })
      .catch((e) => {
        refineErr = (e && e.message) || String(e);
        return false;
      });
  }

  /* 这段音频到底有没有人在说话。
     SenseVoice 对「静音 / 纯噪声」不是返回空，而是会编出点东西 —— 实测全 0 输入
     得到的是 "그."（韩语一个字符）。跳转后 pcm 里的空洞正好会走到这条路，
     不挡住的话，用户会看到某句字幕突然变成一串莫名其妙的字符。
     阈值取 0.003（约 -50 dBFS）：正常说话在 0.02~0.2，环境底噪在 0.001 以下。 */
  function rms(samples) {
    if (!samples || !samples.length) return 0;
    const n = Math.min(samples.length, 16000 * 20);
    let sum = 0;
    let k = 0;
    for (let i = 0; i < n; i += 4) { sum += samples[i] * samples[i]; k++; }
    return k ? Math.sqrt(sum / k) : 0;
  }

  function refineResult(res) {
    const text = String((res && res.text) || '').trim();
    if (!text) return null;
    /* 只剩标点的结果同样不可用（"." / "。" 撑不起一行字幕） */
    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    const lang = tagOf(res.lang);
    return {
      text,
      lang: lang === 'zh' || lang === 'yue' ? 'zh' : (lang === 'en' ? 'en' : '')
    };
  }

  /* 精修失败的原因要留得住：静默返回 null 的话，用户只会看到「精修没反应」，
     而真正的原因可能是引擎没装好、线程爆了、模型版本对不上。 */
  let refineErr = '';

  /* 同步版：给「导入 / 批量处理」用 */
  function refine(samples) {
    if (!samples || !samples.length) return null;
    if (rms(samples) < 0.003) return null;          // 静音不必麻烦模型
    try {
      const R = refineRecognizer();
      const st = R.createStream();
      st.acceptWaveform({ sampleRate: 16000, samples });
      R.decode(st);
      return refineResult(R.getResult(st));
    } catch (e) {
      refineErr = (e && e.message) || String(e);
      return null;
    }
  }

  /* 异步版：播放中用这个，不阻塞主线程 */
  async function refineAsync(samples) {
    if (!samples || !samples.length) return null;
    if (rms(samples) < 0.003) return null;          // 静音不必麻烦模型
    try {
      const R = refineRecognizer();
      const st = R.createStream();
      st.acceptWaveform({ sampleRate: 16000, samples });
      const res = await R.decodeAsync(st);
      return refineResult(res);
    } catch (e) {
      refineErr = (e && e.message) || String(e);
      return null;
    }
  }

  function refineProbe() {
    const k = refineKey();
    return {
      ready: refinePresent(k),
      key: k,
      title: (REFINE[k] || REFINE[DEFAULT_REFINE]).title,
      engine: node,
      error: refineErr
    };
  }

  function setRefine(key) {
    if (!REFINE[key]) return;
    try { localStorage.setItem(LS_REFINE, key); } catch (e) { /* ignore */ }
    if (offKey !== key) { offRec = null; offKey = ''; }
  }

  function refineList() {
    return Object.keys(REFINE).map((k) => ({ key: k, title: REFINE[k].title, desc: REFINE[k].desc }));
  }

  /* ==================== 音频归档 ====================
     <asr>/audio/<docKey>.pcm：16 kHz 单声道 int16，按时间戳随机写。

     三个用处，缺一不可：
       ① 精修要「重听这一段」，没有原始音频就只能干瞪眼；
       ② 精修失败 / 用户重开插件，不用让用户从头再播一遍；
       ③ 音频本身就是资料 —— 后面做知识库，原始音轨是最后一道凭据。

     按「位置」而不是「追加」写：用户往回拖进度条时，新数据盖掉旧的同一段，
     天然幂等，不会出现两段音频拼在一起、时间轴错位的问题。 */

  function pcmDir() { return pathMod.join(ensureRoot(), 'audio'); }
  function pcmPathOf(key) { return pathMod.join(pcmDir(), String(key || '') + '.pcm'); }

  function pcmOpen(key) {
    pcmClose();
    if (!node || !key) return false;
    try {
      fs.mkdirSync(pcmDir(), { recursive: true });
      pcmPath = pcmPathOf(key);
      pcmDoc = String(key);
      /* 必须是 r+ / w+，不能是 a+：O_APPEND 模式下所有写入都会被挪到文件末尾，
         position 参数直接失效（实测表现是「跳转后写的数据全堆在结尾」，
         读某一段就完全对不上）。w+ 只在文件还不存在时用，避免把旧音轨截断。 */
      const exist = fs.existsSync(pcmPath);
      pcmFd = fs.openSync(pcmPath, exist ? 'r+' : 'w+');
      return true;
    } catch (e) {
      pcmFd = null;
      return false;
    }
  }

  function pcmFlush() {
    if (pcmFd == null || !pcmPendN) return;
    const total = pcmPendN;
    const at = pcmPendAt;
    const i16 = new Int16Array(total);
    let k = 0;
    for (let c = 0; c < pcmPend.length; c++) {
      const s = pcmPend[c];
      for (let i = 0; i < s.length && k < total; i++) {
        let v = s[i];
        if (v > 1) v = 1; else if (v < -1) v = -1;
        i16[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    pcmPend = [];
    pcmPendN = 0;
    try {
      fs.writeSync(pcmFd, Buffer.from(i16.buffer, 0, k * 2), 0, k * 2, at * 2);
    } catch (e) { /* 盘满 / 文件被占用：字幕照常走，只是没法精修 */ }
  }

  /* tEnd 是这段音频「播到哪儿」的视频时间；samples 是 16 kHz float32 */
  function pcmWrite(tEnd, samples) {
    if (pcmFd == null || !samples || !samples.length) return;
    const n = samples.length;
    const startS = Math.max(0, Math.round((Number(tEnd) || 0) * 16000) - n);
    if (!pcmPendN) {
      pcmPendAt = startS;
    } else if (Math.abs(startS - (pcmPendAt + pcmPendN)) > 4800) {
      /* 跳转 / 卡了一下：差出 0.3 秒以上就断段，免得把两处音频糊在一起 */
      pcmFlush();
      pcmPendAt = startS;
    }
    pcmPend.push(samples);
    pcmPendN += n;
    /* 攒够 1 秒再落盘：onAudio 是音频回调，每次几毫秒的同步 IO 会直接听成爆音 */
    if (pcmPendN >= 16000) pcmFlush();
  }

  function pcmRead(t0, t1) {
    if (pcmFd == null || !pcmPath || !fs) return null;
    pcmFlush();                      // 刚播的那几秒可能还压在缓冲里
    const a = Math.max(0, Math.floor((Number(t0) || 0) * 16000));
    const b = Math.max(a + 1600, Math.ceil((Number(t1) || 0) * 16000));
    const len = (b - a) * 2;
    if (len <= 0) return null;
    let fd = null;
    try {
      const st = fs.statSync(pcmPath);
      if (!st || st.size < a * 2 + 320) return null;
      fd = fs.openSync(pcmPath, 'r');
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, a * 2);
      if (got < 3200) return null;
      const n = Math.floor(got / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      return out;
    } catch (e) {
      return null;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
  }

  function pcmClose() {
    pcmFlush();
    if (pcmFd != null) { try { fs.closeSync(pcmFd); } catch (e) { /* ignore */ } }
    pcmFd = null;
    pcmPath = '';
    pcmDoc = '';
  }

  function pcmInfo(key) {
    if (!node) return { bytes: 0, sec: 0, path: '' };
    const p = pcmPathOf(key || pcmDoc);
    let bytes = 0;
    try { const st = fs.statSync(p); bytes = st.size; } catch (e) { bytes = 0; }
    /* 按「最后写入位置」算时长没意义，直接按文件长度：洞是 0，也能读 */
    return { bytes, sec: Math.floor(bytes / 2 / 16000), path: p };
  }

  /* 归档音频导出成 wav：知识库 / 外部工具直接能用，不用再解码视频 */
  function pcmExportWav(key, dest) {
    const p = pcmPathOf(key);
    let bytes = 0;
    try { bytes = fs.statSync(p).size; } catch (e) { return null; }
    if (!bytes) return null;
    const out = dest || p.replace(/\.pcm$/, '.wav');
    let fd = null, rd = null;
    try {
      fd = fs.openSync(out, 'w');
      const h = Buffer.alloc(44);
      h.write('RIFF', 0, 'ascii');
      h.writeUInt32LE(36 + bytes, 4);
      h.write('WAVE', 8, 'ascii');
      h.write('fmt ', 12, 'ascii');
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);          // PCM
      h.writeUInt16LE(1, 22);          // 单声道
      h.writeUInt32LE(16000, 24);
      h.writeUInt32LE(32000, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write('data', 36, 'ascii');
      h.writeUInt32LE(bytes, 40);
      fs.writeSync(fd, h, 0, 44, 0);
      rd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(1 << 20);      // 一次性 1 MB，别每轮开一次文件
      let off = 0;
      while (off < bytes) {
        const want = Math.min(buf.length, bytes - off);
        const n = fs.readSync(rd, buf, 0, want, off);
        if (!n) break;
        fs.writeSync(fd, buf, 0, n, 44 + off);
        off += n;
      }
      return out;
    } catch (e) {
      return null;
    } finally {
      if (rd != null) { try { fs.closeSync(rd); } catch (e) { /* ignore */ } }
      if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
  }

  /* ==================== 一句话的语言 ==================== */

  /* 判断「这条字幕该不该翻成中文」。
     不按字符比例算：中英混说时汉字少而字母多（"今天讲 Transformer 和 attention"
     汉字只占 17%），按比例会把明显的中文句子判成英文。
     汉字本身就是「这段在讲中文」的证据 —— 出现两个以上就当中文。
     纯英文视频里偶尔蹦一个汉字（引用中文名），由上层「整段基调」兜住。 */
  function langOf(text) {
    const s = String(text || '');
    const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (cjk >= 2) return 'zh';
    if (cjk === 1 && latin < 6) return 'zh';
    return latin ? 'en' : '';
  }

  /* 模型的英文输出常常整句大写（TODAY IS MONDAY），摆一列看着很累。
     只在「整句没有一个字母是小写、且不带中文」时收成句首大写，专有名词不会被改坏。 */
  function tidyCase(text) {
    const s = String(text || '');
    if (!s) return s;
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(s)) return s;
    if (!/[A-Z]/.test(s)) return s;
    if (/[a-z]/.test(s)) return s;              // 已经有大写变小写混排，不动
    const lower = s.toLowerCase();
    return lower.replace(/(^\s*[a-z])|([.!?]\s+[a-z])|(\bi\b)/g, (m) => m.toUpperCase());
  }

  /* ==================== 状态 ==================== */

  function probe() {
    const key = modelKey();
    state.modelId = key;
    state.engine = enginePresent() ? 'ready' : 'missing';
    state.model = modelPresent(key) ? 'ready' : 'missing';
    /* 引擎已在内存里跑过，就不再看磁盘（用户可能中途删了目录，但本次会话还能用） */
    if (rec && recModel === key) state.model = 'ready';
    return Object.assign({}, state);
  }

  /* status() 以前只是把 state 原样吐出去，而 state 初值是 'unknown' ——
     谁都没 probe 过就问「引擎好了吗」，答案永远是「没好」，于是每次打开视频
     都弹「需要先下载识别引擎」（明明早就下好了）。这里补一次自愈：
     还没探过就先探，之后再照常返回缓存。 */
  function status() {
    if (state.engine === 'unknown' || state.model === 'unknown') probe();
    return Object.assign({}, state);
  }
  function modelList() { return Object.keys(MODELS).map((k) => ({ key: k, title: MODELS[k].title, desc: MODELS[k].desc })); }
  function currentModel() { return modelKey(); }

  async function prepare(opts) {
    const o = opts || {};
    const onProgress = o.onProgress;
    state.loading = true;
    state.error = '';
    try {
      await ensureEngine(onProgress);
      await ensureModel(o.model || modelKey(), onProgress);
      probe();
      return true;
    } catch (e) {
      state.error = (e && e.message) || String(e);
      probe();
      return false;
    } finally {
      state.loading = false;
      state.progress = null;
    }
  }

  return {
    setDataDir, probe, status, prepare,
    modelList, currentModel, setModel, langOf, tidyCase,
    /* 热词偏置（v3.14） */
    setHotwords, hotwordState, ensureHotwordAsset,
    makeResampler, openStream, closeStream, resetStream, feed, flush,
    /* 精修（非流式） */
    ensureRefine, refineProbe, refine, refineAsync, warmRefine, refineList, setRefine, refineKey, tagOf,
    /* 音频归档 */
    pcmOpen, pcmWrite, pcmRead, pcmClose, pcmFlush, pcmInfo, pcmExportWav, pcmPathOf,
    /* 测试用 */
    _extractTgz: extractTgz,
    get rootDir() { return ensureRoot(); }
  };
})();

try { window.Asr = Asr; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = Asr;
