/* Markdown 知识库同步层（v3.35）

   定位：**单向投影 + 受控回写**。
     docs/<docKey>.json        ← 权威（坐标 / 颜色 / 时间轴 / 附件）
     <hub>/<库名>/*.md          ← 每篇文档一份，四者一一对应
     <hub>/<库名>/assets/<id>/  ← 摘录区域图、笔记配图

   为什么不做成唯一源：高亮矩形、颜色、视频时间轴没法无损塞进 MD；
   反过来 MD 也不该承担结构化数据。

   v3.35 相比 v3.11 的变化：
     1) 目录从「资料库里藏一个 _notes」改成用户能看懂的知识库
        （v3.35 默认盘根 Notes Collection from Eagle\<库名>\；v4.2.11 起
        默认改到 <资料库>\.eaglenote\md 随库走，盘根仅作回退与兼容旧目录）；
     2) 文件名用书名，不再顶一串条目 id（撞名才追加短 id）；
     3) 每条摘录 / 笔记都有 HTML 注释锚点，四者可以逐条对上；
     4) **可以手改**：笔记正文与摘录批注会被读回插件（readExternal）。
        两边都改过时以 MD 里的手改优先，插件里那份旧值另存成 .conflict 文件。

   安全网：文件末尾若有 `## 手记（不会被插件覆盖）` 区块，重写时整段保留。 */
const Projection = (function () {
  let fs = null;
  let pathMod = null;
  let osMod = null;
  let node = false;
  try {
    if (typeof require === 'function') {
      fs = require('fs');
      pathMod = require('path');
      try { osMod = require('os'); } catch (e) { osMod = null; }
      node = !!fs && !!pathMod;
    }
  } catch (e) { node = false; }

  const SUB = '_notes';                       // 旧版目录名，仅供迁移提示
  const MANIFEST = '.eaglenote-manifest.json';
  /* v4.2.3：资料库级索引（.eaglenote-lib.json）。
     双链候选不再只限「插件打开过的书」—— 全库 pdf/视频都进候选；
     只存 id + 名字 + 别名（不存路径，移动文件夹不影响），
     Eagle 里改名时旧名记进 aliases，[[旧名]] 依旧解析得到。 */
  const LIBFILE = '.eaglenote-lib.json';
  const ENABLE_KEY = 'eaglenote:mdproj';
  const ROOT_KEY = 'eaglenote:mdroot';        // 用户自定义知识库根
  const HUB_NAME = 'Notes Collection from Eagle';
  const HAND = '## 手记（不会被插件覆盖）';
  const WRITE_DELAY = 2600;                   // 打字停 2.6s 才落盘，别把同步盘写爆
  const EC_LOCAL_TTL = 15000;                 // 写回 Eagle 注释后，容忍 metadata.json 迟迟不落盘的窗口

  let root = null;               // <hub>/<库名> 绝对路径
  let hub = null;                // <hub> 绝对路径（README 放这）
  let libPath = null;            // 资料库根（反查源文件用）
  let libName = '';              // 资料库名（rebuildAll 写进 frontmatter）
  let enabled = true;
  let manifest = {};             // id -> { file, hash, at, rev, items:{}, hand }
  let libMap = {};               // v4.2.3：itemId -> { name, ext, aliases:[] }（全库索引，未打开过的条目也认）
  let libDirty = false;
  let libTimer = null;
  let manifestDirty = false;
  let manifestTimer = null;
  let timer = null;
  let pending = null;
  let lastError = null;
  let lastAt = 0;
  let wroteCount = 0;
  let inExternal = 0;
  let hooks = {};                // { onExternal(meta,data,edits), onMerged(meta,data,edits) }
  /* Eagle 注释栏写回：
     ecLocal   刚通过官方 API 写回、但 metadata.json 可能还没落盘的文本（短时以此为准）；
     ecQueue   待写回队列（md 手改注释 → Eagle 注释栏），drainEcWrites 逐条消费。 */
  let ecLocal = {};
  let ecLocalAt = {};
  let ecQueue = [];
  let ecDrainTimer = null;

  try {
    const v = localStorage.getItem(ENABLE_KEY);
    /* v4.3.0：Obsidian 同步复活——默认开启；显式存过 'off' 才关。
       v4.2.12 曾整体下线（当时用户不需要导出），v4.3.0 应用户要求以
       「随库 vault + 双向同步」形态回归：vault 固定在 <库>\.eaglenote\vault\，
       JSON 仍是权威数据，md 只是投影 + 手改回流通道。 */
    if (v === 'off') enabled = false;
  } catch (e) { /* ignore */ }

  /* ---------- 配置 ---------- */
  function available() { return node && !!root; }

  function readPref() {
    try { return localStorage.getItem(ROOT_KEY) || ''; } catch (e) { return ''; }
  }

  function writePref(v) {
    try {
      if (v) localStorage.setItem(ROOT_KEY, v);
      else localStorage.removeItem(ROOT_KEY);
    } catch (e) { /* ignore */ }
  }

  function homeDir() {
    try {
      if (osMod && osMod.homedir) return osMod.homedir();
      if (global.process && global.process.env) return global.process.env.USERPROFILE || global.process.env.HOME || '';
    } catch (e) { /* ignore */ }
    return '';
  }

  /* 候选根目录：先看用户设过的，再看 E 盘（用户习惯放这），最后退回「文档」。
     每个候选都要真能写一个探针文件才算数 —— 只判断盘符存在不够，E 盘也可能只读。 */
  function candidates() {
    const out = [];
    const pref = readPref();
    if (pref) out.push(pref);
    if (fs) {
      ['E:', 'D:', 'F:'].forEach((d) => {
        try { if (fs.existsSync(d + '\\')) out.push(d + '\\' + HUB_NAME); } catch (e) { /* ignore */ }
      });
    }
    const h = homeDir();
    if (h) out.push(pathMod.join(h, 'Documents', HUB_NAME));
    if (h) out.push(pathMod.join(h, HUB_NAME));
    return out;
  }

  function pickHub() {
    const list = candidates();
    for (let i = 0; i < list.length; i++) {
      const dir = list[i];
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = pathMod.join(dir, '.eaglenote-write-test');
        fs.writeFileSync(probe, 'ok', 'utf8');
        fs.unlinkSync(probe);
        return dir;
      } catch (e) { /* 换下一个 */ }
    }
    return null;
  }

  /* Bridge 在拿到资料库名之后调用：确定知识库根 + 当前库的子目录 */
  function setHub(dir) {
    const next = dir || pickHub();
    hub = next || null;
    if (hub) writePref(hub);
    ensureReadme();
    return hub;
  }

  function ensureReadme() {
    if (!hub || !node) return false;
    const f = pathMod.join(hub, 'README.md');
    try { if (fs.existsSync(f)) return true; } catch (e) { /* ignore */ }
    const body = [
      '# ' + HUB_NAME,
      '',
      '这是「闪灵笔记」插件自动维护的 Markdown 知识库，**用 Windows 资源管理器就能直接看**。',
      '',
      '## 目录结构',
      '',
      '```',
      HUB_NAME + '\\',
      '├─ README.md                 ← 本文件',
      '└─ <资料库名>\\',
      '   ├─ <书名>.md              每篇文档一份：摘录 + 笔记 + 原文件路径',
      '   └─ assets\\<条目id>\\       摘录区域图、笔记配图的副本',
      '```',
      '',
      '## 四者怎么对上',
      '',
      '| 你看到的 | 对应的东西 |',
      '| --- | --- |',
      '| 一份 `.md` | Eagle 里的一个条目（PDF / 视频） |',
      '| frontmatter 的 `eagle:` | Eagle 条目 id，唯一且改名搬盘都不变 |',
      '| frontmatter 的 `source:` | 源文件在磁盘上的真实路径 |',
      '| 每个 `<!-- eagle:ex:… -->` 块 | 一条摘录（引用原文 + 你的批注） |',
      '| 每个 `<!-- eagle:nt:… -->` 块 | 一条笔记 |',
      '| `<!-- eagle:ec:… -->` 区块 | Eagle 注释栏（双向同步，两边改都行） |',
      '',
      '## 可以手改，但要守两条规矩',
      '',
      '1. **只改「笔记」正文和摘录下面的批注文字。** 引用原文、页码、时间点、图片是插件生成的，',
      '   改了下次同步会被还原（不然插件就没法定位高亮了）。',
      '2. **「Eagle 注释」区块与 Eagle 的注释栏双向同步**：在 md 里改会写回 Eagle，',
      '   在 Eagle 里改会同步到这里；两边都改过时以 md 为准，Eagle 那份进 .conflict。',
      '3. **想写不会被覆盖的自由内容**，在文件末尾加一行：',
      '',
      '   ```',
      '   ' + HAND,
      '   ```',
      '',
      '   这一区块原样保留，插件只往里追加、从不删改。',
      '',
      '改完保存即可。插件下次打开这篇文档、或你点工作台的「立即同步」时会读回插件里的笔记。',
      '',
      '## 冲突',
      '',
      '如果同一段文字在插件里和 MD 里都被改过，以 **MD 里手改的版本**为准，',
      '插件里那份旧值会另存成 `<书名>.conflict-<时间>.md`，不会悄悄丢。',
      '',
      '_本文件只在缺失时生成一次，删了也无所谓。_',
      ''
    ].join('\n');
    try { fs.writeFileSync(f, body, 'utf8'); return true; } catch (e) { return false; }
  }

  /* 库子目录名。Eagle 的 `eagle.library` 常常只给 path、不给 name，
     早先这里 `|| 'Eagle'` 兜底 —— 于是知识库根下凭空多出一个
     `E://Notes Collection from Eagle\Eagle`，本来那两篇 md 在 `DY - Clinical Surgery` 里，
     清除时清的是 `Eagle`，什么都没删掉（v3.35.1 的现场）。
     现在优先用 name，其次从 `<库>.library` 的目录名反推；两者都没有就返回空，
     宁可不写，也不造一个假目录。 */
  function libDirName() {
    if (libName && String(libName).trim()) return safeName(libName);
    const p2 = libPath ? String(libPath).replace(/[\\/]+$/, '') : '';
    if (p2) {
      const base = p2.split(/[\\/]/).pop() || '';
      const clean = base.replace(/\.library$/i, '');
      if (clean) return safeName(clean);
    }
    return '';
  }

  /* 切换知识库根（用户在工作台里手选目录）：
     hub 变了，库子目录跟着变，manifest 重新读 → 下次 rebuild 全量重写。 */
  function relocate(hubDir, name) {
    const h = setHub(hubDir);
    if (!h || !node) return null;
    if (name) libName = String(name);
    const sub = libDirName();
    if (!sub) return null;
    const dir = pathMod.join(h, sub);
    const ok = setRoot(dir);
    return ok ? dir : null;
  }

  /* v4.2.12：旧位置索引迁移。md 投影下线后，全库改名别名索引
     （.eaglenote-lib.json）与 manifest 改放 <库>\.eaglenote（= dataDir）。
     历史位置按序探测：盘根/文档目录 Notes Collection from Eagle\<库名>、
     v4.2.11 过渡位置 <库>\.eaglenote\md —— 命中就搬，目标已有不覆盖。 */
  function migrateLegacyIndex(targetDir) {
    if (!node || !targetDir) return false;
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) { return false; }
    const sources = [];
    const sub = libDirName();
    if (sub) {
      for (const base of candidates()) sources.push(pathMod.join(base, sub));
    }
    if (libPath) sources.push(pathMod.join(libPath, '.eaglenote', 'md'));
    let moved = 0;
    for (const old of sources) {
      let exists = false;
      try { exists = fs.existsSync(old); } catch (e) { /* ignore */ }
      if (!exists) continue;
      [LIBFILE, MANIFEST].forEach((f) => {
        const dst = pathMod.join(targetDir, f);
        try {
          const src = pathMod.join(old, f);
          if (!fs.existsSync(dst) && fs.existsSync(src)) { fs.copyFileSync(src, dst); moved++; }
        } catch (e) { /* 单个文件搬不动不影响主流程 */ }
      });
    }
    if (moved) console.info('[Projection] 旧位置别名索引已迁入', targetDir);
    return moved > 0;
  }

  /* v4.2.11：随库模式 —— md 根直接指向 <资料库>\.eaglenote\md，随库一起搬家。
     与 setHub 的三点不同：
       1) 不写 pref —— pref 是全局的，指向某个库的目录会带偏其它库；
       2) 不建 hub/库名 两层嵌套（库本身就是命名空间）；
       3) 首次切换时把旧 hub（E:\Notes Collection from Eagle\<库名>\ 等）
          里的别名索引和 manifest 搬过来 —— [[旧名]] 解析不断链。
          md / assets 不搬，打开对应文档时会按权威 JSON 重新生成。
     返回 true = 目录可用（bridge 据此决定要不要走盘根回退）。 */
  function setPortableRoot(dir) {
    if (!node || !dir) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = pathMod.join(dir, '.eaglenote-write-test');
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
    } catch (e) { return false; }
    try {
      const sub = libDirName();
      if (sub) {
        for (const base of candidates()) {
          const old = pathMod.join(base, sub);
          let exists = false;
          try { exists = fs.existsSync(old); } catch (e) { /* ignore */ }
          if (!exists) continue;
          [LIBFILE, MANIFEST].forEach((f) => {
            const dst = pathMod.join(dir, f);
            try {
              const src = pathMod.join(old, f);
              if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
            } catch (e) { /* 单个文件搬不动不影响主流程 */ }
          });
          console.info('[Projection] 旧知识库索引已随库迁移', old, '→', dir);
          break;
        }
      }
    } catch (e) { /* 迁移失败不影响启动 */ }
    return !!setRoot(dir);
  }

  /* 资料库根路径：rebuildAll 时手上只有 docs/*.json（没有 Eagle 的 item 对象），
     靠它反推「源文件在哪」，才能把 source: 写进 frontmatter。 */
  function setLibrary(p, name) {
    libPath = p || null;
    libName = name || libName;
    return libPath;
  }

  /* Eagle 的条目文件在 <库>/images/<id>.info/<name>.<ext>，同目录还有 metadata.json、
     _thumbnail.png 和用户裁出来的片段。所以不能「取目录里唯一那个文件」——
     metadata.json 里的 name + ext 才是准的，取不到才退「同名文件」。 */
  function itemInfoOf(id, fallbackName) {
    const out = { path: '', ext: '', name: '' };
    if (!node || !libPath || !id) return out;
    const dir = pathMod.join(libPath, 'images', String(id) + '.info');
    try {
      if (!fs.existsSync(dir)) return out;
      const mf = pathMod.join(dir, 'metadata.json');
      if (fs.existsSync(mf)) {
        try {
          const meta = JSON.parse(fs.readFileSync(mf, 'utf8')) || {};
          out.name = String(meta.name || meta.fileName || '');
          out.ext = String(meta.ext || '').replace(/^\./, '').toLowerCase();
        } catch (e) { /* ignore */ }
      }
      if (out.name && out.ext) {
        const full = pathMod.join(dir, out.name + '.' + out.ext);
        if (fs.existsSync(full)) { out.path = full; return out; }
      }
      const files = fs.readdirSync(dir)
        .filter((f) => !/\.json$/i.test(f) && !/_thumbnail\./i.test(f));
      const want = out.name || String(fallbackName || '');
      if (want) {
        const hit = files.filter((f) => f.replace(/\.[a-z0-9]+$/i, '') === want)[0];
        if (hit) {
          out.path = pathMod.join(dir, hit);
          out.name = out.name || want;
          out.ext = out.ext || ((hit.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
          return out;
        }
      }
      if (!out.name && files.length === 1) {
        out.path = pathMod.join(dir, files[0]);
        out.ext = ((files[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
      }
      return out;
    } catch (e) { return out; }
  }

  /* Eagle 注释栏（metadata.json 的 annotation 字段）。
     currentEcText 的三条规则处理「API 写回成功、但 Eagle 还没把 metadata.json 落盘」的时差：
     1) 落盘了（和写回值一致）→ 立即改用磁盘值，撤销覆盖；
     2) 超过 15s 还没落盘 → 也按磁盘值算（用户多半在 Eagle 里又改了）；
     3) 窗口期内 → 用写回值，否则下一次 build 会把用户刚写的内容又冲回旧版。 */
  function annotationOf(id) {
    if (!node || !libPath || !id) return '';
    try {
      const mf = pathMod.join(libPath, 'images', String(id) + '.info', 'metadata.json');
      if (!fs.existsSync(mf)) return '';
      const meta = JSON.parse(fs.readFileSync(mf, 'utf8')) || {};
      return String(meta.annotation == null ? '' : meta.annotation);
    } catch (e) { return ''; }
  }

  function currentEcText(id) {
    const key = String(id == null ? '' : id);
    /* 队列里的待写回文本是最新的真相：build 若不等它，手改会在写回 Eagle
       之前就被旧值冲掉（写回是异步的，build 是同步的）。 */
    const job = ecQueue.filter((j) => j.id === key)[0];
    if (job) return job.text;
    const fresh = annotationOf(key);
    if (!Object.prototype.hasOwnProperty.call(ecLocal, key)) return fresh;
    if (fresh === ecLocal[key] || Date.now() - (ecLocalAt[key] || 0) > EC_LOCAL_TTL) {
      delete ecLocal[key];
      delete ecLocalAt[key];
      return fresh;
    }
    return ecLocal[key];
  }

  /* root 由 Bridge 注入：<hub>/<库名> */
  function setRoot(dir) {
    const next = dir || null;
    if (next === root) return available();
    root = next;
    manifest = {};
    libMap = {};
    libDirty = false;
    if (!node || !root) return false;
    try {
      fs.mkdirSync(pathMod.join(root, 'assets'), { recursive: true });
      const mf = pathMod.join(root, MANIFEST);
      if (fs.existsSync(mf)) {
        const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (raw && typeof raw === 'object') manifest = raw;
      }
      const lf = pathMod.join(root, LIBFILE);
      if (fs.existsSync(lf)) {
        const rawLib = JSON.parse(fs.readFileSync(lf, 'utf8'));
        if (rawLib && typeof rawLib === 'object') libMap = rawLib;
      }
    } catch (e) {
      console.warn('[Projection] 初始化知识库目录失败', e);
      root = null;
      return false;
    }
    return true;
  }

  function isOn() { return enabled && !!root && node; }

  /* v4.2.12：别名索引可用性 —— 不依赖 md 开关。[[ 候选/双链/改名别名
     全靠 libMap，只要 root（= dataDir）在就工作。 */
  function libReady() { return !!root && node; }

  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem(ENABLE_KEY, enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    return enabled;
  }

  function dirOf() { return root || null; }
  function hubOf() { return hub || null; }

  function status() {
    return {
      on: isOn(),
      enabled,
      root: root || null,
      hub: hub || null,
      wrote: wroteCount,
      at: lastAt,
      error: lastError
    };
  }

  function setHooks(h) {
    hooks = Object.assign({}, hooks, h || {});
  }

  /* ---------- 文件名 ---------- */
  /* Windows 禁止 \ / : * ? " < > |，书名里「：」「？」很常见；末尾的点和空格也要去掉。
     英文长书名很容易上百字符，截到 72 —— 整条路径仍在 260 以内。 */
  function safeName(s) {
    let t = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    /* 90 是个折中：知识库根 + 库名大约占 45 字，Windows 整条路径 260，
       留足余量；再短的话英文论文标题会被截得认不出来。 */
    if (t.length > 90) t = t.slice(0, 89).replace(/[. ]+$/, '') + '…';
    return t || '未命名';
  }

  function shortId(id) {
    return String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'x';
  }

  /* 锚点：只留安全字符，且必须能反查回原 id */
  function anchorId(id, fallback) {
    const raw = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
    return raw || ('a' + String(fallback == null ? '0' : fallback));
  }

  function keyOf(meta, data) {
    if (meta && meta.itemId) return meta.itemId;
    if (data && data.itemId) return data.itemId;
    try { return Store.docKey(meta || {}); } catch (e) { return 'local_' + U.hashKey((meta && meta.name) || 'x'); }
  }

  function ownerOf(file) {
    const keys = Object.keys(manifest);
    for (let i = 0; i < keys.length; i++) {
      const rec = manifest[keys[i]];
      if (rec && rec.file === file) return keys[i];
    }
    return null;
  }

  /* 文件名 = 书名.md。撞名（不同条目同书名）才追加短 id，
     既保证一一对应，又不会让资源管理器里满屏乱码。 */
  function fileNameOf(meta, data, id) {
    const title = (meta && meta.name) || (data && data.fileName) || '未命名';
    const base = safeName(U.stripExt(title));
    let file = base + '.md';
    const owner = ownerOf(file);
    if (owner && owner !== id) {
      file = safeName(base.slice(0, 78)) + ' (' + shortId(id) + ').md';
    }
    return file;
  }

  /* 书名没变就沿用上次那个文件名 —— 你在资源管理器里手动改过名也不会被抢回去；
     书名变了（Eagle 里重命名条目）才重算，旧文件由 writeNow 顺手删掉。 */
  function fileOf(meta, data) {
    if (!root) return null;
    const id = keyOf(meta, data);
    const prev = manifest[id];
    const title = safeName(U.stripExt((meta && meta.name) || (data && data.fileName) || ''));
    if (prev && prev.file && prev.title === title) return pathMod.join(root, prev.file);
    return pathMod.join(root, fileNameOf(meta, data, id));
  }

  /* ---------- 文本工具 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isoLocal(ts) {
    const d = new Date(ts || Date.now());
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  function clockOf(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h ? pad2(h) + ':' : '') + pad2(m) + ':' + pad2(ss);
  }

  /* YAML 标量：JSON 字符串本身就是合法的双引号 YAML 标量，中文不用额外处理 */
  function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }

  function quoteBlock(text) {
    return String(text || '').split(/\r?\n/).map((l) => '> ' + l).join('\n');
  }

  function pluginVersion() {
    try {
      const m = global.Bridge && Bridge.state && Bridge.state.manifest;
      return (m && m.version) || '';
    } catch (e) { return ''; }
  }

  const TYPE_LABEL = {
    highlight: '高亮',
    area: '框选',
    note: '批注',
    image: '截图',
    video: '视频标记'
  };

  const VIDEO_EXT = {
    mp4: 1, mov: 1, mkv: 1, webm: 1, avi: 1, m4v: 1, flv: 1, wmv: 1, mpg: 1, mpeg: 1, ts: 1
  };

  const COLOR_LABEL = {
    yellow: '黄', green: '绿', blue: '蓝', pink: '粉', purple: '紫', orange: '橙', red: '红'
  };

  /* ---------- 图片落盘 ---------- */
  function dataUrlToBuf(u) {
    const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(u || ''));
    if (!m) return null;
    try {
      return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
    } catch (e) { return null; }
  }

  function extOfMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.indexOf('jpeg') >= 0) return 'jpg';
    if (m.indexOf('webp') >= 0) return 'webp';
    if (m.indexOf('gif') >= 0) return 'gif';
    return 'png';
  }

  function writeImage(id, name, dataUrl, keep) {
    const buf = dataUrlToBuf(dataUrl);
    if (!buf || !buf.length) return '';
    const m = /^data:([^;,]+)?/.exec(String(dataUrl));
    const ext = extOfMime(m && m[1]);
    const dir = pathMod.join(root, 'assets', id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = safeName(name) + '.' + ext;
      fs.writeFileSync(pathMod.join(dir, file), buf);
      keep.push(file);
      return 'assets/' + id + '/' + file;
    } catch (e) {
      console.warn('[Projection] 写图片失败', e);
      return '';
    }
  }

  /* 图片存在用户自己选的位置（ann.imagePath），投影时**复制**一份进 assets/ ——
     原文件归用户，投影目录是插件自己的副本，删掉重建也不影响原图。 */
  function writeImageFile(id, name, srcPath, keep) {
    if (!srcPath) return '';
    try {
      if (!fs.existsSync(srcPath)) return '';
      const ext = (String(srcPath).match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'png';
      const dir = pathMod.join(root, 'assets', id);
      fs.mkdirSync(dir, { recursive: true });
      const file = safeName(name) + '.' + ext.toLowerCase();
      fs.copyFileSync(srcPath, pathMod.join(dir, file));
      keep.push(file);
      return 'assets/' + id + '/' + file;
    } catch (e) {
      console.warn('[Projection] 复制图片失败', e);
      return '';
    }
  }

  function pruneImages(id, oldList, newList) {
    if (!root || !oldList || !oldList.length) return 0;
    const keepSet = {};
    (newList || []).forEach((f) => { keepSet[f] = 1; });
    const dir = pathMod.join(root, 'assets', id);
    let n = 0;
    oldList.forEach((f) => {
      if (keepSet[f]) return;
      try { fs.unlinkSync(pathMod.join(dir, f)); n++; } catch (e) { /* 可能已被手动删掉 */ }
    });
    return n;
  }

  /* ---------- 组装 Markdown ---------- */
  function build(meta, data) {
    const m = meta || {};
    const d = data || {};
    const name = U.stripExt(m.name || d.fileName || '未命名');
    const anns = (Array.isArray(d.annotations) ? d.annotations : []).slice()
      .sort((a, b) => ((a.page || 0) - (b.page || 0)) || ((a.t || 0) - (b.t || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)));
    const notes = (Array.isArray(d.notes) ? d.notes : []).slice()
      .sort((a, b) => ((a.page || 0) - (b.page || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)));

    /* 先过滤掉完全空白的条目，避免生成一堆空标题 */
    const liveAnns = anns.filter((a) => String(a.text || '').trim() || String(a.note || '').trim() || a.image || a.imagePath || a.filePath);
    const liveNotes = notes.filter((n) => String(n.md || '').trim() || String(n.quote || '').trim() || n.image);

    const images = [];
    const id = keyOf(m, d);
    const ecAnchor = anchorId(id, 'ec');
    const ecText = currentEcText(id);
    /* 按扩展名判是不是视频，别猜。PDF 的框选也可能带 t（截图那一秒），
       早先按「有没有 t」判断，结果 PDF 摘录在重建成 MD 时被写成 00:03。 */
    const ext = String(m.ext || '').replace(/^\./, '').toLowerCase();
    const useTime = !!VIDEO_EXT[ext] ||
      (!ext && liveAnns.length > 0 && liveAnns.every((a) => !a.page && typeof a.t === 'number'));
    const prev = manifest[id] || {};

    const L = [];
    L.push('---');
    L.push('eagle: ' + yamlStr(m.itemId || id));
    L.push('title: ' + yamlStr(name));
    L.push('file: ' + yamlStr(m.name || d.fileName || ''));
    if (m.ext) L.push('kind: ' + yamlStr(String(m.ext).toLowerCase()));
    if (m.libraryName) L.push('library: ' + yamlStr(m.libraryName));
    if (m.filePath) L.push('source: ' + yamlStr(m.filePath));
    if (Array.isArray(m.tags) && m.tags.length) L.push('tags: [' + m.tags.map(yamlStr).join(', ') + ']');
    L.push('updated: ' + isoLocal(Date.now()));
    L.push('rev: ' + ((prev.rev || 0) + 1));
    L.push('excerpts: ' + liveAnns.length);
    L.push('notes: ' + liveNotes.length);
    const ver = pluginVersion();
    if (ver) L.push('generator: ' + yamlStr('闪灵笔记 ' + ver));
    L.push('---');
    L.push('');
    L.push('# ' + name);
    L.push('');
    L.push('> 由「闪灵笔记」维护。笔记正文与摘录批注可以手改，保存后插件会读回；');
    L.push('> 引用原文、页码、时间点、图片以插件为准。文件末尾加一个「手记」二级标题即可写自由内容，那一块不会被覆盖。');
    L.push('');

    /* 每条都包一对 HTML 注释锚点：渲染时看不见，解析时能精确对回条目 id。
       用注释而不是 Obsidian 的 ^block，是因为 Typora / VSCode 也不会把它显示出来。 */
    if (liveAnns.length) {
      L.push('## 摘录');
      L.push('');
      let lastHead = null;
      liveAnns.forEach((a, i) => {
        const head = useTime
          ? (typeof a.t === 'number' ? clockOf(a.t) + (typeof a.t1 === 'number' ? '–' + clockOf(a.t1) : '') : '未定位')
          : ('p.' + (a.page || 1));
        const aid = anchorId(a.id, 'ex' + i);
        const label = [TYPE_LABEL[a.type] || '', COLOR_LABEL[a.color] || ''].filter(Boolean).join(' · ');
        L.push('<!-- eagle:ex:' + aid + ' -->');
        if (head !== lastHead) {
          L.push('### ' + head);
          L.push('');
          lastHead = head;
        }
        if (String(a.text || '').trim()) {
          L.push(quoteBlock(a.text));
          L.push('');
        }
        if (a.image || a.imagePath) {
          const rel = a.image
            ? writeImage(id, a.id || ('img' + i), a.image, images)
            : writeImageFile(id, a.id || ('img' + i), a.imagePath, images);
          if (rel) L.push('![' + (label || '摘录') + '](' + rel + ')');
          else L.push('_（图片未能导出）_');
          L.push('');
        }
        /* 片段：文件在用户那儿，投影里只放一条链接，不复制视频 */
        if (a.filePath) {
          L.push('[' + (label || '片段') + '：' + (pathMod.basename(a.filePath) || '打开') + '](' + a.filePath + ')');
          L.push('');
        }
        /* 批注区固定用 **笔记** 起头 —— 回读时靠这个标记切段 */
        if (String(a.note || '').trim()) {
          L.push('**笔记**');
          L.push('');
          L.push(String(a.note).trim());
          L.push('');
        }
        /* 图注里已经有「框选 · 黄」了，不再多写一行注释 —— 三条纯图摘录连着看太吵。 */
        L.push('<!-- /eagle:ex:' + aid + ' -->');
        L.push('');
      });
    }

    if (liveNotes.length) {
      L.push('## 笔记');
      L.push('');
      liveNotes.forEach((n, i) => {
        const head = n.page ? ('第 ' + n.page + ' 页') : '独立笔记';
        const nid = anchorId(n.id, 'nt' + i);
        L.push('<!-- eagle:nt:' + nid + ' -->');
        L.push('### ' + head);
        L.push('');
        if (String(n.quote || '').trim()) {
          L.push(quoteBlock(n.quote));
          L.push('');
        }
        if (String(n.md || '').trim()) {
          L.push(String(n.md).trim());
          L.push('');
        }
        if (n.image) {
          const rel = writeImage(id, n.id || ('note' + i), n.image, images);
          if (rel) L.push('![](' + rel + ')');
          L.push('');
        }
        L.push('<!-- /eagle:nt:' + nid + ' -->');
        L.push('');
      });
    }

    /* Eagle 注释栏小节：annotation 双向同步。锚点里的内容 = Eagle 注释栏；
       在 md 里改会写回 Eagle（官方 API），在 Eagle 里改会投影到这里。
       空的时候锚点内留空 —— 别放占位文字，否则回读会把占位符当成注释写进 Eagle。 */
    L.push('## Eagle 注释（双向同步）');
    L.push('');
    L.push('<!-- eagle:ec:' + ecAnchor + ' -->');
    if (String(ecText).trim()) {
      L.push(String(ecText).replace(/\r\n/g, '\n').trim());
      L.push('');
    }
    L.push('<!-- /eagle:ec:' + ecAnchor + ' -->');
    if (!String(ecText).trim()) {
      L.push('');
      L.push('_此区块与 Eagle 注释栏双向同步，在这里或 Eagle 里写都行。_');
      L.push('');
    }

    if (!liveAnns.length && !liveNotes.length && !String(ecText).trim()) {
      L.push('_这篇还没有摘录或笔记。_');
      L.push('');
    }

    /* 手记区：上次保留下来的用户内容，原样接在末尾 */
    if (prev.hand) {
      L.push(HAND);
      L.push('');
      L.push(prev.hand);
      L.push('');
    }

    return { text: L.join('\n'), images, id, rev: (prev.rev || 0) + 1, ec: ecText, ecAnchor };
  }

  /* ---------- 从 MD 读回 ---------- */
  const BLOCK_RE = /<!--\s*eagle:(ex|nt|ec):([A-Za-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/eagle:\1:\2\s*-->/g;

  function parseBlocks(text) {
    const out = { ex: {}, nt: {}, ec: {} };
    BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = BLOCK_RE.exec(String(text || '')))) {
      out[m[1]][m[2]] = m[3];
    }
    return out;
  }

  function dropNoise(s) {
    return String(s || '')
      .split(/\r?\n/)
      .filter((l) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l))   // 图片行
      .filter((l) => !/^\s*<!--[\s\S]*?-->\s*$/.test(l))         // 注释行
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* 摘录块的批注 = 「**笔记**」之后的文本；没有这个标记说明结构被改过，不回读 */
  function noteOfEx(seg) {
    const m = /^\s*\*\*笔记\*\*\s*$/m.exec(String(seg || ''));
    if (!m) return null;
    return dropNoise(String(seg).slice(m.index + m[0].length));
  }

  /* 笔记块 = 去掉标题行、引用行、图片行之后剩下的正文 */
  function bodyOfNt(seg) {
    const lines = String(seg || '').split(/\r?\n/);
    const kept = [];
    lines.forEach((l) => {
      if (/^\s*###\s/.test(l)) return;
      if (/^\s*>/.test(l)) return;
      if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l)) return;
      if (/^\s*<!--[\s\S]*?-->\s*$/.test(l)) return;
      kept.push(l);
    });
    return dropNoise(kept.join('\n'));
  }

  /* 只认「单独占一行」的二级标题。早先用 indexOf 判断，结果文件开头的说明文字里
     也带着这串字，整篇正文都被当成手记区原样保留，越写越长（3.35 的坑）。 */
  function handOf(text) {
    const m = /^## 手记（不会被插件覆盖）[ \t]*$/m.exec(String(text || ''));
    if (!m) return '';
    const rest = String(text).slice(m.index + m[0].length).replace(/^\s*\n/, '').trim();
    /* 卫生检查：手记区不该出现插件自己的锚点或大段结构，出现就说明抓错了 */
    if (rest.length > 20000) return '';
    if (rest.indexOf('<!-- eagle:') >= 0) return '';
    return rest;
  }

  /* 比较 MD 与上次写入的差异。返回 [] 表示「外部没改到我们管的部分」。
     conflict=true 表示本地这条也改过（两边都动过）。 */
  function readExternal(meta, data, text, prev) {
    const blocks = parseBlocks(text);
    const items = (prev && prev.items) || {};
    const edits = [];
    const anns = (data && Array.isArray(data.annotations)) ? data.annotations : [];
    const notes = (data && Array.isArray(data.notes)) ? data.notes : [];

    anns.forEach((a, i) => {
      const aid = anchorId(a.id, 'ex' + i);
      const seg = blocks.ex[aid];
      if (seg == null) return;
      const want = noteOfEx(seg);
      if (want == null) return;
      const rec = items['ex:' + aid];
      if (!rec) return;
      if (U.hashKey(want) === rec.w) return;              // 这段没被改过
      const local = String(a.note == null ? '' : a.note).trim();
      if (want === local) return;                          // 改来改去又改回来了
      edits.push({
        kind: 'ex',
        ref: a,
        id: a.id,
        text: want,
        old: local,
        conflict: U.hashKey(local) !== rec.l
      });
    });

    notes.forEach((n, i) => {
      const nid = anchorId(n.id, 'nt' + i);
      const seg = blocks.nt[nid];
      if (seg == null) return;
      const want = bodyOfNt(seg);
      const rec = items['nt:' + nid];
      if (!rec) return;
      if (U.hashKey(want) === rec.w) return;
      const local = String(n.md == null ? '' : n.md).trim();
      if (want === local) return;
      edits.push({
        kind: 'nt',
        ref: n,
        id: n.id,
        text: want,
        old: local,
        conflict: U.hashKey(local) !== rec.l
      });
    });

    /* Eagle 注释小节：md 里手改 → 写回 Eagle 注释栏。
       插件这边（Eagle metadata）也改过 → 双改冲突，仍以 MD 为准，Eagle 旧值进 .conflict。 */
    const ecAnchor = anchorId(keyOf(meta, data), 'ec');
    const ecSeg = (blocks.ec || {})[ecAnchor];
    if (ecSeg != null) {
      const rec = items['ec:' + ecAnchor];
      if (rec) {
        const want = dropNoise(ecSeg);
        if (U.hashKey(want) !== rec.w) {
          const local = String(currentEcText(keyOf(meta, data)) || '').trim();
          if (want !== local) {
            edits.push({
              kind: 'ec',
              ref: { itemId: keyOf(meta, data) },
              id: keyOf(meta, data),
              text: want,
              old: local,
              conflict: U.hashKey(local) !== rec.l
            });
          }
        }
      }
    }

    return edits;
  }

  /* 把读回的改动应用回内存对象；返回实际生效条数。
     ec 不落在 data 上（它归 Eagle 注释管），进写回队列，由 drainEcWrites 异步消费。 */
  function applyEdits(edits) {
    let n = 0;
    (edits || []).forEach((e) => {
      if (!e || !e.ref) return;
      if (e.kind === 'ex') { e.ref.note = e.text; n++; }
      else if (e.kind === 'nt') { e.ref.md = e.text; n++; }
      else if (e.kind === 'ec') { queueEcWrite(e.id, e.text); n++; }
    });
    return n;
  }

  /* ---------- md 手改注释 → Eagle 注释栏 ---------- */
  function queueEcWrite(id, text) {
    const t = String(text == null ? '' : text).trim();
    if (!id) return;
    ecQueue = ecQueue.filter((j) => j.id !== id);   // 同一条目只留最新
    ecQueue.push({ id: String(id), text: t });
    if (!ecDrainTimer) ecDrainTimer = setTimeout(drainEcWrites, 300);
  }

  /* 写回通道：官方 API（item.annotation = …; item.save()，Eagle 界面实时可见）优先，
     HTTP API 兜底。两个都失败（Eagle 没开等）就留在队列里，下次有写回时再试。 */
  function eagleApiWrite(id, text) {
    return new Promise((resolve) => {
      try {
        if (typeof eagle !== 'undefined' && eagle && eagle.item && eagle.item.getById) {
          Promise.resolve(eagle.item.getById(id)).then((item) => {
            if (!item) return resolve(false);
            try {
              item.annotation = text;
              Promise.resolve(item.save()).then(() => resolve(true)).catch(() => resolve(false));
            } catch (e) { resolve(false); }
          }).catch(() => resolve(false));
          return;
        }
      } catch (e) { /* fallthrough */ }
      try {
        const http = require('http');
        const body = JSON.stringify({ id: id, annotation: text });
        const req = http.request({
          host: '127.0.0.1', port: 41595, path: '/api/item/update', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(buf).status === 'success'); } catch (e) { resolve(false); }
          });
        });
        req.on('error', () => resolve(false));
        req.write(body);
        req.end();
      } catch (e) { resolve(false); }
    });
  }

  async function drainEcWrites() {
    ecDrainTimer = null;
    while (ecQueue.length) {
      const job = ecQueue[0];
      let okWrite = false;
      try { okWrite = await eagleApiWrite(job.id, job.text); } catch (e) { okWrite = false; }
      if (!okWrite) break;
      ecQueue.shift();
      ecLocal[job.id] = job.text;          // metadata.json 可能还没落盘，窗口期内以写回值为准
      ecLocalAt[job.id] = Date.now();
      if (typeof Dbg !== 'undefined' && Dbg && Dbg.log) {
        try { Dbg.log('projection', { ecWrite: job.id, len: job.text.length }); } catch (e) { /* ignore */ }
      }
    }
  }

  /* 全量扫描：哪些 md 在我们写完之后被外部动过（只看 manifest 里认领的文件） */
  function externallyChanged() {
    if (!node || !root) return [];
    const out = [];
    Object.keys(manifest).forEach((id) => {
      const rec = manifest[id];
      if (!rec || !rec.file) return;
      const f = pathMod.join(root, rec.file);
      try {
        if (!fs.existsSync(f)) return;
        const st = fs.statSync(f);
        /* 只有「比我们写入的那一刻更早」才算没动过。
           早先留了 20ms 容差，结果紧接着写文件再改，会被当成没变（测试里就撞上了）。 */
        if (rec.at && st.mtimeMs <= rec.at) return;
        const text = fs.readFileSync(f, 'utf8');
        if (U.hashKey(text) !== rec.hash) out.push(id);
      } catch (e) { /* 读不了就当没改 */ }
    });
    return out;
  }

  /* ---------- 写入 ---------- */
  function flushManifest() {
    if (manifestTimer) { clearTimeout(manifestTimer); manifestTimer = null; }
    if (!manifestDirty || !root) return;
    manifestDirty = false;
    try {
      const f = pathMod.join(root, MANIFEST);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(manifest), 'utf8');
      fs.renameSync(tmp, f);
    } catch (e) { /* 清单写不进去不影响正文 */ }
  }

  function markManifest() {
    manifestDirty = true;
    if (manifestTimer) return;
    manifestTimer = setTimeout(() => { manifestTimer = null; flushManifest(); }, 1500);
  }

  /* ---------- v4.2.3 资料库级索引 ---------- */
  function flushLib() {
    if (libTimer) { clearTimeout(libTimer); libTimer = null; }
    if (!libDirty || !root) return;
    libDirty = false;
    try {
      const f = pathMod.join(root, LIBFILE);
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(libMap), 'utf8');
      fs.renameSync(tmp, f);
    } catch (e) { /* 索引写不进去只影响候选范围，不影响正文 */ }
  }

  function markLib() {
    libDirty = true;
    if (libTimer) return;
    libTimer = setTimeout(() => { libTimer = null; flushLib(); }, 1500);
  }

  /* 全库条目（Bridge.listLibraryItems 拉回）并进索引：
     · 新条目 → 直接收录；
     · 同 id 改名 → 旧名记进 aliases（去重、封顶 12），[[旧名]] 继续可用；
     · 消失的条目不删（可能临时读不到），点击时 getItemById 兜底。
     返回发生变化的条数（0 = 无事发生）。 */
  function libSync(items) {
    if (!isOn() || !Array.isArray(items)) return 0;
    let changed = 0;
    items.forEach((it) => {
      const id = String((it && it.id) || '');
      const name = U.stripExt(String((it && it.name) || '')).trim();
      const ext = String((it && it.ext) || '').toLowerCase();
      if (!id || !name) return;
      const prev = libMap[id];
      if (!prev) { libMap[id] = { name: name, ext: ext, aliases: [] }; changed++; return; }
      if (WL.normalize(prev.name) !== WL.normalize(name)) {
        if (!prev.aliases.some((a) => WL.normalize(a) === WL.normalize(prev.name))) {
          prev.aliases.push(prev.name);
          if (prev.aliases.length > 12) prev.aliases = prev.aliases.slice(-12);   // 防反复改名撑爆
        }
        prev.name = name;
        changed++;
      }
      if (prev.ext !== ext) { prev.ext = ext; changed++; }
    });
    if (changed) {
      wikiCache = null;   // 候选树下次重建
      markLib();
    }
    return changed;
  }

  /* 双改冲突：插件里那一版先落成 .conflict 文件再被覆盖，绝不悄悄丢内容。
     文件名带秒级时间戳，同一天连改几次也不会互相盖掉。 */
  function writeConflictFile(file, items) {
    if (!file || !items || !items.length) return null;
    try {
      const d = new Date();
      const stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
        '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
      const out = file.replace(/\.md$/i, '') + '.conflict-' + stamp + '.md';
      const L = [];
      L.push('# 冲突备份 · ' + isoLocal(Date.now()));
      L.push('');
      L.push('> 下面这些是「闪灵笔记」里原来那一版，已被 Markdown 里的手改版本取代。');
      L.push('> 需要找回就从这里复制回插件；本文件不会再被插件读写。');
      L.push('');
      items.forEach((e) => {
        L.push('## ' + (e.kind === 'ex' ? '摘录批注' : (e.kind === 'ec' ? 'Eagle 注释' : '笔记')) + ' `' + (e.id || '') + '`');
        L.push('');
        L.push(String(e.old || '').trim() || '（原本是空的）');
        L.push('');
      });
      fs.writeFileSync(out, L.join('\n'), 'utf8');
      return out;
    } catch (e) {
      console.warn('[Projection] 写冲突备份失败', e);
      return null;
    }
  }

  /* 逐条的「写入时的值」与「当时插件里的值」都记哈希：
     w = 上次写进 MD 的文本，用来判断 MD 是否被手改；
     l = 当时插件里的值，用来判断插件这边是否也改过（双改 → 冲突）。 */
  function itemHashes(data) {
    const out = {};
    const anns = (data && Array.isArray(data.annotations)) ? data.annotations : [];
    const notes = (data && Array.isArray(data.notes)) ? data.notes : [];
    anns.forEach((a, i) => {
      if (!String(a.note || '').trim()) return;
      out['ex:' + anchorId(a.id, 'ex' + i)] = U.hashKey(String(a.note).trim());
    });
    notes.forEach((n, i) => {
      if (!String(n.md || '').trim()) return;
      out['nt:' + anchorId(n.id, 'nt' + i)] = U.hashKey(String(n.md).trim());
    });
    return out;
  }

  /* 这篇有没有「值得落成 md」的内容：摘录 / 笔记 / Eagle 注释栏，任一非空就算。
     判定口径与 build 的 liveAnns / liveNotes 过滤一致。 */
  function hasLiveContent(data, annText) {
    const anns = (data && Array.isArray(data.annotations)) ? data.annotations : [];
    const notes = (data && Array.isArray(data.notes)) ? data.notes : [];
    if (anns.some((a) => String(a.text || '').trim() || String(a.note || '').trim() || a.image || a.imagePath || a.filePath)) return true;
    if (notes.some((n) => String(n.md || '').trim() || String(n.quote || '').trim() || n.image)) return true;
    if (String(annText || '').trim()) return true;
    return false;
  }

  /* force=true 时忽略哈希，强制重写（「重建全部」用） */
  function writeNow(meta, data, force) {
    if (!isOn() || !meta || !data) return { ok: false, skipped: true };
    const id = keyOf(meta, data);
    const prev = manifest[id] || {};
    const file = fileOf(meta, data);

    /* ⓪ 内容全空就不落盘：md 文件跟着内容走 —— 产生第一条摘录/笔记/注释才建文件；
          内容清空（且没有手记）就整个回收，不在资源管理器里留空壳。
          早先「打开即投影」，三部只点开没记笔记的视频在 E 盘留下三篇空壳 md，
          清掉之后一打开又长回来，用户最后明确要求：没有内容就别生成。 */
    if (!hasLiveContent(data, currentEcText(id))) {
      const exists = file && fs.existsSync(file);
      if (!exists) return { ok: true, skipped: true, empty: true };
      /* 磁盘上这份里若有手记、或注释区被手写过（待写回 Eagle），都不能回收 */
      let hand = '';
      let ecInFile = '';
      try {
        const text = fs.readFileSync(file, 'utf8');
        hand = handOf(text);
        const bl = parseBlocks(text);
        ecInFile = dropNoise((bl.ec || {})[anchorId(id, 'ec')] || '');
      } catch (e) { /* 读不了按空处理 */ }
      if (!hand && !prev.hand && !ecInFile) {
        try { fs.unlinkSync(file); } catch (e) { /* 可能已被手动删掉 */ }
        pruneImages(id, prev.images || [], []);
        try {
          const ad = pathMod.join(root, 'assets', id);
          if (fs.existsSync(ad) && !fs.readdirSync(ad).length) fs.rmdirSync(ad);
        } catch (e) { /* ignore */ }
        if (manifest[id]) { delete manifest[id]; markManifest(); }
        return { ok: true, removed: true };
      }
      /* 有手记：手记不能丢，往下走写成空壳 */
    }

    /* ① 写之前先看 MD 有没有被手改过 —— 不看就写，等于把用户手打的东西冲掉。
          有改动就先交给上层合并（上层把值改回 data 上），本次顺着写新的。 */
    if (!force && inExternal < 1 && typeof hooks.onExternal === 'function' && file && prev.items) {
      let text = null;
      try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); } catch (e) { text = null; }
      if (text && U.hashKey(text) !== prev.hash) {
        const edits = readExternal(meta, data, text, prev);
        if (edits.length) {
          const bad = edits.filter((e) => e.conflict && String(e.old || '').trim());
          if (bad.length) writeConflictFile(file, bad);
          inExternal++;
          try { hooks.onExternal(meta, data, edits); } catch (e) { console.warn('[Projection] 合并回调失败', e); }
          finally { inExternal--; }
          try { if (typeof hooks.onMerged === 'function') hooks.onMerged(meta, data, edits); } catch (e) { /* ignore */ }
        }
      }
    }

    let out;
    try { out = build(meta, data); } catch (e) {
      lastError = '组装失败：' + (e.message || e);
      console.warn('[Projection] 组装失败', e);
      return { ok: false, error: lastError };
    }
    const hash = U.hashKey(out.text);

    /* v4.0 双链：出链索引进 manifest。md 正文一个字不动（反链运行时聚合，
       不写回文件——否则 A 引 B、B 引 A 会互相触发重写）。 */
    const myTitle = safeName(U.stripExt((meta && meta.name) || (data && data.fileName) || ''));
    const outLinks = WL.distinctTargets(out.text, myTitle);
    /* v4.2 笔记级双链：把笔记标题（正文第一行口径，见 WikiLink.noteTitle）
       一并记进 manifest，补全候选不用为每次按键翻全部 docs。 */
    const noteTitles = (function () {
      const out = [];
      const anns2 = (data && Array.isArray(data.annotations)) ? data.annotations : [];
      const notes2 = (data && Array.isArray(data.notes)) ? data.notes : [];
      anns2.forEach((a) => {
        const t = WL.noteTitle(a.note);
        if (t) out.push(t);
      });
      notes2.forEach((n) => {
        const t = WL.noteTitle(n.md);
        if (t) out.push(t);
      });
      return out;
    })();

    if (!force && prev.hash === hash && file && fs.existsSync(file)) {
      /* 文本没变也要把 links/nt 补上：老 manifest 升级后第一次同步就补齐 */
      if (prev && (JSON.stringify(prev.links) !== JSON.stringify(outLinks)
        || JSON.stringify(prev.nt) !== JSON.stringify(noteTitles))) {
        manifest[id] = Object.assign({}, prev, { links: outLinks, nt: noteTitles });
        markManifest();
        wikiCache = null;
      }
      return { ok: true, skipped: true, file };
    }

    /* 手记区：读一次原文，把用户写的那段留下来，再重算一遍文本 */
    let hand = prev.hand || '';
    if (file && fs.existsSync(file)) {
      try {
        const h = handOf(fs.readFileSync(file, 'utf8'));
        if (h) hand = h;
      } catch (e) { /* ignore */ }
    }
    if (hand && prev.hand !== hand) {
      manifest[id] = Object.assign({}, prev, { hand });
      try { out = build(meta, data); } catch (e) { /* 用原来那份 */ }
    }

    /* v4.2.1 四方同步审计 · 孤儿文件保护：磁盘上已有同名 md、但 manifest 里
       没有这个条目（清单被手删 / 损坏 / 换过库）。此时无法区分「我们上次写的」
       和「用户自己放的」，也做不了手改合并 —— 先把原文件备份成 .orphan 再覆盖，
       绝不静默丢内容。备份只发生一次：写完这条 manifest 记录就建立了认领。 */
    if (!prev.file && file && fs.existsSync(file)) {
      try {
        if (fs.statSync(file).size > 0) {
          const d = new Date();
          const stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
            '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
          fs.copyFileSync(file, file.replace(/\.md$/i, '') + '.orphan-' + stamp + '.md');
        }
      } catch (e) { /* 备份失败不挡写入 */ }
    }

    /* v4.2.1 四方同步审计 · 改名别名：书名变了就把旧名记进 aliases，
       别的书里已写出的 [[旧名]] 仍能解析到这本书（idByTitle / backlinksOf 走别名），
       不需要回头改别人文件里的正文。 */
    let aliases = Array.isArray(prev.aliases) ? prev.aliases.slice() : [];
    if (prev.title && prev.title !== myTitle
      && !aliases.some((a) => WL.normalize(a) === WL.normalize(prev.title))) {
      aliases.push(prev.title);
      if (aliases.length > 12) aliases = aliases.slice(-12);   // 防反复改名撑爆清单
    }

    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, out.text, 'utf8');
      fs.renameSync(tmp, file);

      /* 书名改了 / 撞名消解 → 删掉旧文件名那份 */
      if (prev.file && prev.file !== pathMod.basename(file)) {
        try { fs.unlinkSync(pathMod.join(root, prev.file)); } catch (e) { /* 已经不在了 */ }
      }
      pruneImages(id, prev.images, out.images);

      const keys = itemHashes(data);
      keys['ec:' + out.ecAnchor] = U.hashKey(String(out.ec || '').trim());
      const items = {};
      Object.keys(keys).forEach((k) => { items[k] = { w: keys[k], l: keys[k] }; });

      manifest[id] = {
        file: pathMod.basename(file),
        title: safeName(U.stripExt((meta && meta.name) || (data && data.fileName) || '')),
        hash: U.hashKey(out.text),
        items,
        hand: hand || '',
        rev: out.rev,
        images: out.images,
        links: outLinks,
        nt: noteTitles,
        aliases: aliases,
        at: Date.now()
      };
      markManifest();
      wikiCache = null;   // v4.2：笔记标题变了，补全候选树下次重建
      lastAt = Date.now();
      lastError = null;
      wroteCount++;
      return { ok: true, file };
    } catch (e) {
      lastError = e.message || String(e);
      console.warn('[Projection] 写入失败', file, e);
      return { ok: false, error: lastError };
    }
  }

  /* ---------- v4.0 双链查询（链接关系只在 manifest 层，md 文件保持纯净） ---------- */

  /* WikiLink 未加载时的安全替身（比如空格预览窗口） */
  const WL = (typeof WikiLink !== 'undefined') ? WikiLink : {
    normalize: (t) => String(t == null ? '' : t).trim().toLowerCase(),
    distinctTargets: () => [],
    linkContexts: () => [],
    splitTarget: (t) => ({ book: String(t || '').trim(), note: '' }),
    bookOf: (t) => String(t || '').trim(),
    noteTitle: () => ''
  };

  /* 老 manifest 条目没有 links 字段 → 惰性读盘补算一次（缓存进 rec，不落 manifest 文件） */
  function ensureLinks(rec) {
    if (rec.links) return rec.links;
    let text = '';
    try { text = fs.readFileSync(pathMod.join(root, rec.file), 'utf8'); } catch (e) { text = ''; }
    rec.links = text ? WL.distinctTargets(text, rec.title) : [];
    return rec.links;
  }

  /* 谁链接了这本书：[{ id, title, file, contexts:[{alias,before,after}] }]
     v4.2：[[书#笔记]] 也算指向这本书 —— 按书名段（# 之前）对账。
     v4.2.1：书 A 改过名时，别的书里写的 [[旧名]] 也算 —— 先把当前书的全部
     名字（新名 + aliases）归一化成一张对账表，链接目标命中任一即算。 */
  function backlinksOf(title) {
    if (!root || !title) return [];
    const nT = WL.normalize(title);
    if (!nT) return [];
    const names = [nT];
    const selfId = idByTitle(title);
    if (selfId) {
      const rec0 = manifest[selfId];
      (rec0 && Array.isArray(rec0.aliases) ? rec0.aliases : []).forEach((a) => {
        const n = WL.normalize(a);
        if (n && names.indexOf(n) < 0) names.push(n);
      });
    }
    const out = [];
    for (const id of Object.keys(manifest)) {
      const rec = manifest[id];
      if (!rec || !rec.file) continue;
      const links = ensureLinks(rec);
      if (!links.some((t) => names.indexOf(WL.normalize(WL.bookOf(t))) >= 0)) continue;
      let text = '';
      try { text = fs.readFileSync(pathMod.join(root, rec.file), 'utf8'); } catch (e) { text = ''; }
      /* 上下文摘录按每个名字各查一遍再合并（一条链接只按它实际用的那个名字命中） */
      const contexts = [];
      if (text) {
        names.forEach((n) => {
          WL.linkContexts(text, n).forEach((c) => { contexts.push(c); });
        });
      }
      out.push({
        id: id,
        title: rec.title || '',
        file: rec.file,
        contexts: contexts
      });
    }
    return out;
  }

  /* 补全候选：manifest 里全部书名（排除 exclude = 当前书），按中文排序 */
  function wikiTitles(exclude) {
    if (!root) return [];
    const nEx = WL.normalize(exclude);
    const seen = {};
    const out = [];
    for (const id of Object.keys(manifest)) {
      const rec = manifest[id];
      if (!rec || !rec.title) continue;
      const n = WL.normalize(rec.title);
      if (!n || n === nEx || seen[n]) continue;
      seen[n] = 1;
      out.push(rec.title);
    }
    return out.sort((a, b) => a.localeCompare(b, 'zh'));
  }

  /* ---------- v4.2 笔记级补全候选 ----------
     返回 [{ book, self, notes:[标题] }]。数据全来自 manifest（writeNow 时写入
     rec.nt）；老条目没有 nt 就从 Store 的 docs 惰性回填一次。
     exclude = 当前书：书级候选排除它，但 currentBook 的 notes 照常给出 ——
     同一篇里笔记互链（[[本书#另一条笔记]]）是合法用法。 */
  let wikiCache = null;   // { at, tree }；writeNow 落盘时置空

  function noteTitlesFromStore() {
    /* 一次遍历 Store 的全部 docs，建 itemId → 笔记标题表（只在缓存失效时跑） */
    const map = {};
    try {
      const idx = Store.getIndex();
      const keys = Object.keys((idx && idx.docs) || {}).filter((k) => k !== '__daily__');
      keys.forEach((k) => {
        let raw = null;
        try { raw = Store.readDocByKey(k); } catch (e) { raw = null; }
        if (!raw) return;
        const out = [];
        (Array.isArray(raw.annotations) ? raw.annotations : []).forEach((a) => {
          const t = WL.noteTitle(a.note);
          if (t) out.push(t);
        });
        (Array.isArray(raw.notes) ? raw.notes : []).forEach((n) => {
          const t = WL.noteTitle(n.md);
          if (t) out.push(t);
        });
        const iid = String(raw.itemId || k);
        if (out.length) map[iid] = out;
      });
    } catch (e) { /* Store 不可用就给空表 */ }
    return map;
  }

  function wikiTree(exclude) {
    if (!root) return [];
    if (wikiCache && Date.now() - wikiCache.at < 15000) {
      return applyWikiExclude(wikiCache.tree, exclude);
    }
    const storeMap = null;   // 需要时再算（见下）
    const tree = [];
    let needStore = false;
    const recs = Object.keys(manifest).map((id) => ({ id: id, rec: manifest[id] }))
      .filter((x) => x.rec && x.rec.title);
    recs.forEach((x) => {
      if (!Array.isArray(x.rec.nt)) needStore = true;
    });
    const sm = needStore ? noteTitlesFromStore() : storeMap;
    recs.forEach((x) => {
      let notes = Array.isArray(x.rec.nt) ? x.rec.nt.slice() : (sm[x.id] || []).slice();
      if (!Array.isArray(x.rec.nt) && sm[x.id]) {
        x.rec.nt = sm[x.id];   // 回填进内存 rec（不立即落 manifest，下次 writeNow 会带上）
      }
      notes.sort((a, b) => a.localeCompare(b, 'zh'));
      tree.push({ book: x.rec.title, self: false, notes: notes });
    });
    /* v4.2.3：全库条目并进候选 —— 没打开过的书/视频也能被 [[ 引用。
       已经在 manifest 里的（打开过、有笔记）不重复；同名去重（带笔记的优先）。 */
    const seenTitle = {};
    tree.forEach((t) => { seenTitle[WL.normalize(t.book)] = 1; });
    Object.keys(libMap).forEach((id) => {
      if (manifest[id]) return;                 // 已投影的书由上半段给出（带笔记）
      const rec = libMap[id];
      const n = WL.normalize(rec.name);
      if (!n || seenTitle[n]) return;
      seenTitle[n] = 1;
      tree.push({ book: rec.name, self: false, notes: [] });
    });
    tree.sort((a, b) => a.book.localeCompare(b.book, 'zh'));
    wikiCache = { at: Date.now(), tree: tree };
    return applyWikiExclude(tree, exclude);
  }

  function applyWikiExclude(tree, exclude) {
    const nEx = WL.normalize(exclude);
    if (!nEx) return tree.map((t) => t);
    /* 当前书：书级候选里排除，笔记级保留（标记 self 供编辑器区分展示） */
    return tree
      .filter((t) => WL.normalize(t.book) !== nEx || (t.notes && t.notes.length))
      .map((t) => (WL.normalize(t.book) === nEx ? Object.assign({}, t, { self: true }) : t));
  }

  /* 书名 → 条目 id（跳转用；按归一化书名对账，Eagle 里改名不断链）。
     v4.2.1：书名对不上再查 aliases —— 改名前别人写的 [[旧名]] 也能解析。
     v4.2.3：manifest 没有（没打开过的条目）再查全库索引 lib —— 同一套别名机制。 */
  function idByTitle(title) {
    const nT = WL.normalize(title);
    if (!nT) return '';
    for (const id of Object.keys(manifest)) {
      const rec = manifest[id];
      if (rec && rec.title && WL.normalize(rec.title) === nT) return id;
    }
    for (const id of Object.keys(manifest)) {
      const rec = manifest[id];
      if (rec && Array.isArray(rec.aliases)
        && rec.aliases.some((a) => WL.normalize(a) === nT)) return id;
    }
    /* 全库索引：先现名，再别名（Eagle 里改过名的未打开条目） */
    for (const id of Object.keys(libMap)) {
      const rec = libMap[id];
      if (rec && WL.normalize(rec.name) === nT) return id;
    }
    for (const id of Object.keys(libMap)) {
      const rec = libMap[id];
      if (rec && Array.isArray(rec.aliases)
        && rec.aliases.some((a) => WL.normalize(a) === nT)) return id;
    }
    return '';
  }

  /* 显式同步一篇（读回 MD 的手改；没有手改就照常写出去） */
  function sync(meta, data) {
    if (!isOn() || !meta || !data) return { ok: false, skipped: true };
    return writeNow(meta, data, false);
  }

  /* 打字时高频调用：只留最后一次，安静地晚点写 */
  function schedule(meta, data) {
    if (!isOn()) return false;
    pending = { meta, data };
    if (timer) return true;
    timer = setTimeout(() => {
      timer = null;
      const p = pending;
      pending = null;
      if (p) writeNow(p.meta, p.data, false);
    }, WRITE_DELAY);
    return true;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const p = pending;
    pending = null;
    let res = { ok: true, skipped: true };
    if (p) res = writeNow(p.meta, p.data, false);
    flushManifest();
    flushLib();
    return res;
  }

  /* ---------- 删除 / 清空 / 重建 ---------- */
  function remove(meta, data) {
    if (!node || !root) return false;
    const id = keyOf(meta, data);
    let file = null;
    if (manifest[id] && manifest[id].file) file = pathMod.join(root, manifest[id].file);
    else file = fileOf(meta, data);
    let ok = false;
    if (file) {
      try { fs.unlinkSync(file); ok = true; } catch (e) { ok = false; }
    }
    const imgs = (manifest[id] && manifest[id].images) || [];
    pruneImages(id, imgs, []);
    try {
      const dir = pathMod.join(root, 'assets', id);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (e) { /* ignore */ }
    if (manifest[id]) {
      delete manifest[id];
      markManifest();
    }
    return ok;
  }

  function readManifestAt(dir) {
    try {
      const f = pathMod.join(dir, MANIFEST);
      if (!fs.existsSync(f)) return null;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      return (raw && typeof raw === 'object') ? raw : null;
    } catch (e) { return null; }
  }

  /* 一个库子目录里的东西是不是全清了：只剩 assets/（且是空的）才算。
     用户自己往里放 md / 图片 → 保留目录，不擅自删。 */
  function dirIsEmptyExceptAssets(dir) {
    try {
      const top = fs.readdirSync(dir).filter((x) => x !== 'assets' && x !== MANIFEST && x !== LIBFILE);
      if (top.length) return false;
      const as = pathMod.join(dir, 'assets');
      if (!fs.existsSync(as)) return true;
      const kids = fs.readdirSync(as);
      for (let i = 0; i < kids.length; i++) {
        const k = pathMod.join(as, kids[i]);
        try { if (!fs.statSync(k).isDirectory()) return false; } catch (e) { return false; }
        if (fs.readdirSync(k).length) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  function clearDir(dir, map) {
    let n = 0;
    Object.keys(map || {}).forEach((id) => {
      const rec = map[id];
      if (rec && rec.file) {
        try { fs.unlinkSync(pathMod.join(dir, rec.file)); n++; } catch (e) { /* 可能已手动删掉 */ }
      }
      const imgs = (rec && rec.images) || [];
      imgs.forEach((f) => {
        try { fs.unlinkSync(pathMod.join(dir, 'assets', id, f)); } catch (e) { /* ignore */ }
      });
      try { fs.rmdirSync(pathMod.join(dir, 'assets', id)); } catch (e) { /* 还非空就留着 */ }
    });
    try { fs.unlinkSync(pathMod.join(dir, MANIFEST)); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(pathMod.join(dir, LIBFILE)); } catch (e) { /* 不在就不管 */ }
    /* 全清了就把空目录一起收掉，别在资源管理器里留一串空壳 */
    if (dirIsEmptyExceptAssets(dir)) {
      try {
        const as = pathMod.join(dir, 'assets');
        if (fs.existsSync(as)) {
          fs.readdirSync(as).forEach((k) => { try { fs.rmdirSync(pathMod.join(as, k)); } catch (e) { /* ignore */ } });
          try { fs.rmdirSync(as); } catch (e) { /* ignore */ }
        }
        fs.rmdirSync(dir);
      } catch (e) { /* 被占用/有用户文件就留着 */ }
    }
    return n;
  }

  /* 清空全部：只删我们自己生成的 md（靠清单认领），用户往目录里放的东西一律不动。
     v3.36：不再只清「当前 root」—— 库名解析出错或换过资料库时，旧目录里的副本
     会全部留在磁盘上（用户点「彻底清除」，E 盘那两篇 md 还在，就是这个问题）。
     现在把知识库根下每个带清单的子目录都清一遍。 */
  function clearAll() {
    if (!node) return 0;
    let n = 0;
    const done = [];
    if (root && fs.existsSync(root)) {
      n += clearDir(root, manifest);
      done.push(root);
      manifest = {};
      manifestDirty = false;
      if (manifestTimer) { clearTimeout(manifestTimer); manifestTimer = null; }
      libMap = {};                       // v4.2.3：全库索引跟着清
      libDirty = false;
      if (libTimer) { clearTimeout(libTimer); libTimer = null; }
    }
    if (hub) {
      try {
        fs.readdirSync(hub).forEach((name) => {
          const d = pathMod.join(hub, name);
          if (done.indexOf(d) >= 0) return;
          try { if (!fs.statSync(d).isDirectory()) return; } catch (e) { return; }
          const map = readManifestAt(d);
          if (!map) return;                       // 没有清单 = 不是我们建的（或是手的）
          n += clearDir(d, map);
        });
      } catch (e) { /* ignore */ }
    }
    return n;
  }

  /* 全量回填：启动后空闲时跑一遍，把历史文档补成 MD。
     force=false 时内容没变的不重写，第二次运行几乎零开销。 */
  /* v4.3.0 空闲期回读：把 Obsidian 里手改过的 md 吸回 JSON。
     writeNow 第①步自带「先合并外部改动再写」，所以这里只需要找到
     被外部动过的条目、按 rebuildAll 同样的方式构造 meta 递进去。
     返回实际发生合并的条数。 */
  function syncExternal() {
    if (!isOn()) return { ok: false, skipped: true, changed: 0 };
    const ids = externallyChanged();
    if (!ids.length) return { ok: true, changed: 0 };
    const want = {};
    ids.forEach((id) => { want[id] = true; });
    let changed = 0, docs = 0;
    let keys = [];
    try {
      const idx = Store.getIndex();
      keys = Object.keys((idx && idx.docs) || {}).filter((k) => k !== '__daily__');
    } catch (e) { keys = []; }
    keys.forEach((k) => {
      let raw = null;
      try { raw = Store.readDocByKey(k); } catch (e) { raw = null; }
      if (!raw) return;
      const iid = raw.itemId || k;
      const info = itemInfoOf(iid, raw.fileName);
      const meta = {
        itemId: iid,
        name: raw.fileName || info.name || '',
        filePath: info.path || '',
        ext: info.ext || 'pdf',
        libraryName: libName || ''
      };
      let data = null;
      try { data = Store.normalize(raw, meta); } catch (e) { data = raw; }
      docs++;
      if (!want[keyOf(meta, data)]) return;   // 这本没被外部改过
      const r = writeNow(meta, data, false);  // 内部：readExternal → onExternal 合并 → 重写
      if (r && r.ok && !(r.skipped && !r.removed)) changed++;
    });
    flushManifest();
    return { ok: true, changed, docs };
  }

  function rebuildAll(force) {
    if (!isOn()) return { ok: false, docs: 0, written: 0 };
    let keys = [];
    try {
      const idx = Store.getIndex();
      keys = Object.keys((idx && idx.docs) || {}).filter((k) => k !== '__daily__');
    } catch (e) { keys = []; }
    let written = 0;
    keys.forEach((k) => {
      let raw = null;
      try { raw = Store.readDocByKey(k); } catch (e) { raw = null; }
      if (!raw) return;
      /* 手上只有 docs/*.json，没有 Eagle 的 item 对象 —— 靠资料库目录反查源文件，
           否则 rebuildAll 生成的 MD 会丢掉 source:，PDF 还可能被当成视频。 */
      const id = raw.itemId || k;
      const info = itemInfoOf(id, raw.fileName);
      const meta = {
        itemId: id,
        name: raw.fileName || info.name || '',
        filePath: info.path || '',
        ext: info.ext || 'pdf',
        libraryName: libName || ''
      };
      const data = (function () {
        try { return Store.normalize(raw, meta); } catch (e) { return raw; }
      })();
      const r = writeNow(meta, data, !!force);
      if (r && r.ok && !r.skipped) written++;
    });
    flushManifest();
    return { ok: true, docs: keys.length, written };
  }

  return {
    available,
    setHub,
    setPortableRoot,
    migrateLegacyIndex,
    libReady,
    hubOf,
    relocate,
    setLibrary,
    libDirName,
    itemInfoOf,
    setRoot,
    dirOf,
    isOn,
    setEnabled,
    status,
    setHooks,
    safeName,
    anchorId,
    build,
    parseBlocks,
    noteOfEx,
    bodyOfNt,
    readExternal,
    applyEdits,
    annotationOf,
    currentEcText,
    hasLiveContent,
    queueEcWrite,
    eagleApiWrite,
    drainEcWrites,
    externallyChanged,
    writeConflictFile,
    writeNow,
    sync,
    backlinksOf,
    wikiTitles,
    wikiTree,
    idByTitle,
    libSync,
    schedule,
    flush,
    remove,
    clearAll,
    rebuildAll,
    syncExternal,
    /* 测试用：观察 / 回拨注释写回状态（ecLocalAt 回拨可模拟「Eagle 迟迟不落盘」） */
    get _ec() { return { ecLocal: ecLocal, ecLocalAt: ecLocalAt, ecQueue: ecQueue, TTL: EC_LOCAL_TTL }; },
    get SUB() { return SUB; },
    get HUB_NAME() { return HUB_NAME; },
    get HAND() { return HAND; }
  };
})();

/* 调试与自动化测试入口（与其它模块保持一致） */
try { window.Projection = Projection; } catch (e) { /* ignore */ }
