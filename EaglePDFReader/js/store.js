/* 持久化层

   索引位置（这决定了「资料库改名 / 移动 / 换库路径」是否丢数据）：
     <userData>/Plugins/EagleNoteManager/data/
       docs/<docKey>.json     单篇文档的摘录 + 笔记（docKey 优先用 Eagle 的 itemId）
       index.json             全库摘要/笔记索引，供「知识库」「工作台」使用
       trash.json             回收站（删除的摘录/笔记保留 30 天）
       daily.json             工作台「每日笔记」
   docKey 用 itemId 而不是文件路径 —— Eagle 条目的 id 与它所在文件夹、资料库名字、
   资料库存放位置都无关，所以库改名或整体搬盘，索引依然能对上。

   注意：v3.1 起不再从 PDF 同目录的 sidecar 或 localStorage 回读旧数据
   （旧数据会「复活」，与用户主动清空的预期冲突）。主存储只有 docs/ 一处。 */
const Store = (function () {
  let fs = null;
  let pathMod = null;
  let node = false;
  try {
    if (typeof require === 'function') {
      fs = require('fs');
      pathMod = require('path');
      node = !!fs && !!pathMod;
    }
  } catch (e) {
    node = false;
  }

  const VERSION = 4;
  const HISTORY_KEY = 'eaglenote:history';
  const THEME_KEY = 'eaglenote:theme';
  const DAILY_KEY = 'eaglenote:daily';
  const TRASH_KEY = 'eaglenote:trash';
  const TRASH_DAYS = 30;
  const EPOCH_KEY = 'eaglenote:epoch';
  const EPOCH = '3.3';

  let dataDir = null;          // 由 Bridge 在就绪后调用 setDataDir 注入

  function emptyData(meta) {
    meta = meta || {};
    return {
      version: VERSION,
      itemId: meta.itemId || null,
      fileName: meta.name || '',
      annotations: [],
      notes: [],
      reading: { page: 1, zoomMode: 'fit-width', zoom: 1 },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  /* 兼容 v1（整篇 notes 字符串）→ v2（notes 数组）→ v3（附件）→ v4（图片摘录 / 回收站） */
  function normalize(raw, meta) {
    const base = emptyData(meta);
    if (!raw || typeof raw !== 'object') return base;
    const data = Object.assign(base, raw);
    data.version = VERSION;
    // 文件名可能来自旧数据，保留最新的
    if (meta && meta.name) data.fileName = meta.name;
    if (meta && meta.itemId) data.itemId = meta.itemId;
    data.annotations = Array.isArray(data.annotations) ? data.annotations.filter(Boolean) : [];
    data.reading = Object.assign({}, base.reading, data.reading || {});

    if (!Array.isArray(data.notes)) data.notes = [];
    const legacy = typeof raw.notes === 'string' ? raw.notes.trim() : '';
    if (legacy) {
      data.notes.push({
        id: 'legacy_' + (raw.updatedAt || Date.now()),
        md: legacy,
        quote: '',
        annId: null,
        page: null,
        attachments: [],
        createdAt: raw.createdAt || Date.now(),
        updatedAt: raw.updatedAt || Date.now()
      });
    }
    delete data.notesRaw;

    data.annotations.forEach((a) => {
      if (!a.id) a.id = U.uid('an');
      if (!Array.isArray(a.rects)) a.rects = [];
      a.page = Math.max(1, parseInt(a.page, 10) || 1);
      a.type = a.type || 'highlight';
      if (typeof a.note !== 'string') a.note = '';
      if (typeof a.text !== 'string') a.text = '';
      if (!Array.isArray(a.attachments)) a.attachments = [];
      if (typeof a.image !== 'string') a.image = '';
      if (typeof a.translation !== 'string') a.translation = '';
      /* v3.3：视频标注用时间轴（秒），没有就保持 null */
      a.t = (typeof a.t === 'number' && isFinite(a.t)) ? a.t : null;
      a.t1 = (typeof a.t1 === 'number' && isFinite(a.t1)) ? a.t1 : null;
    });

    data.notes.forEach((n) => {
      if (!n.id) n.id = U.uid('nt');
      if (typeof n.md !== 'string') n.md = '';
      if (typeof n.quote !== 'string') n.quote = '';
      if (typeof n.title !== 'string') n.title = '';
      if (typeof n.image !== 'string') n.image = '';
      if (!Array.isArray(n.attachments)) n.attachments = [];
      if (!n.createdAt) n.createdAt = Date.now();
      n.page = n.page ? Math.max(1, parseInt(n.page, 10) || 1) : null;
    });

    data.notes = data.notes.filter((n) => n.md || n.annId || (n.attachments && n.attachments.length) || n.image);
    return data;
  }

  /* ---------- 目录 / 键 ---------- */
  function setDataDir(p) {
    dataDir = p || null;
    if (!node || !dataDir) return;
    try { fs.mkdirSync(pathMod.join(dataDir, 'docs'), { recursive: true }); } catch (e) { /* ignore */ }
  }
  function getDataDir() { return dataDir; }

  function docKey(meta) {
    meta = meta || {};
    if (meta.itemId) return String(meta.itemId).replace(/[^\w.-]/g, '_');
    const seed = meta.filePath || meta.name || meta.fileName || 'unknown';
    return 'local_' + U.hashKey(seed);
  }

  function docFile(meta) {
    if (!node || !dataDir) return null;
    try { return pathMod.join(dataDir, 'docs', docKey(meta) + '.json'); } catch (e) { return null; }
  }

  /* ---------- 读取 / 写入 ---------- */
  function load(meta) {
    meta = meta || {};
    const df = docFile(meta);
    if (df) {
      try {
        if (fs.existsSync(df)) return normalize(JSON.parse(fs.readFileSync(df, 'utf8')), meta);
      } catch (e) {
        console.warn('[Store] 读取索引失败：', df, e);
      }
      return emptyData(meta);      // 有数据目录就以它为准，不再回读 sidecar / localStorage
    }
    // 无 Node（纯浏览器调试）时才退回 localStorage
    try {
      const raw = localStorage.getItem('eaglenote:doc:' + docKey(meta));
      if (raw) return normalize(JSON.parse(raw), meta);
    } catch (e) { /* ignore */ }
    return emptyData(meta);
  }

  function save(meta, data) {
    data.updatedAt = Date.now();
    const df = docFile(meta);
    if (df) {
      try {
        const tmp = df + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
        fs.renameSync(tmp, df);
        scheduleIndexRebuild();
        return { ok: true, path: df };
      } catch (e) {
        console.warn('[Store] 写入索引失败：', df, e);
        return { ok: false, error: e.message };
      }
    }
    try {
      localStorage.setItem('eaglenote:doc:' + docKey(meta), JSON.stringify(data));
      return { ok: true, path: null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------- 全库索引（知识库 / 工作台） ---------- */
  let indexCache = null;
  let indexTimer = null;

  function scheduleIndexRebuild() {
    if (indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = null;
      try { rebuildIndex(); } catch (e) { console.warn('[Store] 重建索引失败', e); }
    }, 400);
  }

  function readAllDocs() {
    const out = [];
    if (!node || !dataDir) return out;
    const dir = pathMod.join(dataDir, 'docs');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    names.forEach((n) => {
      if (!/\.json$/.test(n)) return;
      try {
        const raw = JSON.parse(fs.readFileSync(pathMod.join(dir, n), 'utf8'));
        if (raw && typeof raw === 'object') out.push(raw);
      } catch (e) { /* 单个文件坏了不影响其它 */ }
    });
    return out;
  }

  /* 把 docs/*.json 压平成卡片索引：一条摘录 = 一张卡，一条笔记 = 一张卡 */
  function rebuildIndex() {
    const docs = readAllDocs();
    const entries = [];
    const docStats = {};

    docs.forEach((d) => {
      const docId = d.itemId || d.fileName || 'unknown';
      const name = d.fileName || '未命名';
      const anns = Array.isArray(d.annotations) ? d.annotations : [];
      const notes = Array.isArray(d.notes) ? d.notes : [];
      let exCount = 0;
      let noteCount = 0;

      anns.forEach((a) => {
        const hasNote = !!(a.note && a.note.trim());
        if (hasNote) noteCount++;
        const text = (a.text || '').trim();
        if (!text && !hasNote && !a.image) return;
        exCount++;
        entries.push({
          id: 'e:' + docId + ':' + a.id,
          annId: a.id,
          docId,
          docKey: docKey({ itemId: d.itemId, fileName: d.fileName }),
          docName: name,
          kind: 'excerpt',
          page: a.page || 1,
          t: (typeof a.t === 'number') ? a.t : null,
          t1: (typeof a.t1 === 'number') ? a.t1 : null,
          text: U.truncate(text, 400),
          md: hasNote ? a.note : '',
          image: a.image || '',
          /* v3.28：图片可能只存了路径，索引里带上它，知识库卡片才能按路径读图 */
          imagePath: a.imagePath || '',
          filePath: a.filePath || '',
          color: a.color || '',
          type: a.type || 'highlight',
          at: a.updatedAt || a.createdAt || d.updatedAt || 0
        });
      });

      notes.forEach((n) => {
        noteCount++;
        entries.push({
          id: 'n:' + docId + ':' + n.id,
          noteId: n.id,
          docId,
          docKey: docKey({ itemId: d.itemId, fileName: d.fileName }),
          docName: name,
          kind: 'note',
          page: n.page || null,
          text: U.truncate(n.quote || '', 400),
          md: n.md || '',
          image: n.image || '',
          color: '',
          type: 'note',
          atts: (n.attachments || []).length,
          at: n.updatedAt || n.createdAt || d.updatedAt || 0
        });
      });

      docStats[docId] = {
        docId,
        name,
        excerpts: exCount,
        notes: noteCount,
        annotations: anns.length,
        updatedAt: d.updatedAt || 0
      };
    });

    /* 每日笔记也进知识库：否则写完就找不回来了 */
    try {
      const daily = getDailyMap();
      Object.keys(daily).forEach((k) => {
        const text = daily[k];
        if (!text || !String(text).trim()) return;
        const ts = new Date(k + 'T12:00:00').getTime() || 0;
        entries.push({
          id: 'd:' + k,
          docId: '__daily__',
          docKey: '__daily__',
          dayKey: k,
          docName: '每日笔记 · ' + k,
          kind: 'daily',
          page: null,
          text: U.truncate(text, 400),
          md: text,
          image: '',
          color: '',
          type: 'daily',
          at: ts
        });
      });
    } catch (e) { /* ignore */ }

    entries.sort((a, b) => b.at - a.at);
    indexCache = { version: 2, builtAt: Date.now(), docs: docStats, entries };

    if (dataDir) {
      try {
        /* 与 docs / trash / daily 一致：tmp + rename 原子写，写一半崩了不损索引 */
        const f = pathMod.join(dataDir, 'index.json');
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(indexCache), 'utf8');
        fs.renameSync(tmp, f);
      } catch (e) { /* 索引写不进去不影响主数据 */ }
    }
    return indexCache;
  }

  function getIndex() {
    if (indexCache) return indexCache;
    if (node && dataDir) {
      try {
        const f = pathMod.join(dataDir, 'index.json');
        if (fs.existsSync(f)) {
          indexCache = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (indexCache && indexCache.version === 2) return indexCache;
        }
      } catch (e) { /* ignore */ }
    }
    return rebuildIndex();
  }

  function invalidateIndex() { indexCache = null; }

  /* 按 docKey 直接读写（回收站还原用：那里只有键，没有完整 meta） */
  function readDocByKey(key) {
    if (!node || !dataDir || !key) return null;
    try {
      const f = pathMod.join(dataDir, 'docs', key + '.json');
      if (!fs.existsSync(f)) return null;
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { return null; }
  }

  function writeDocByKey(key, data) {
    if (!node || !dataDir || !key) return false;
    try {
      const f = pathMod.join(dataDir, 'docs', key + '.json');
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, f);
      invalidateIndex();
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 回收站（删除的摘录 / 笔记保留 30 天） ---------- */
  function readJson(name, fallback) {
    if (node && dataDir) {
      try {
        const f = pathMod.join(dataDir, name);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) { /* ignore */ }
      return fallback;
    }
    try {
      const raw = localStorage.getItem(name === 'trash.json' ? TRASH_KEY : DAILY_KEY);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJson(name, value) {
    if (node && dataDir) {
      try {
        const f = pathMod.join(dataDir, name);
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
        fs.renameSync(tmp, f);
        return true;
      } catch (e) { console.warn('[Store] 写入失败', name, e); return false; }
    }
    try {
      localStorage.setItem(name === 'trash.json' ? TRASH_KEY : DAILY_KEY, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  function getTrash() {
    const box = readJson('trash.json', { items: [] }) || { items: [] };
    const items = Array.isArray(box.items) ? box.items : [];
    return items;
  }

  /* 超过 30 天的自动清理 */
  function purgeTrash() {
    const cut = Date.now() - TRASH_DAYS * 86400000;
    const items = getTrash();
    const keep = items.filter((it) => (it.deletedAt || 0) >= cut);
    if (keep.length !== items.length) writeJson('trash.json', { items: keep });
    return keep;
  }

  function pushTrash(rec) {
    const items = purgeTrash();
    items.unshift(Object.assign({ deletedAt: Date.now() }, rec));
    writeJson('trash.json', { items: items.slice(0, 400) });
    return items;
  }

  function dropTrash(id) {
    const items = getTrash().filter((it) => it.id !== id);
    writeJson('trash.json', { items });
    return items;
  }

  function emptyTrash() {
    writeJson('trash.json', { items: [] });
    return [];
  }

  /* ---------- 每日笔记 ---------- */
  function getDailyMap() {
    const box = readJson('daily.json', {}) || {};
    return box && typeof box === 'object' ? box : {};
  }
  function getDaily(key) {
    const map = getDailyMap();
    return typeof map[key] === 'string' ? map[key] : '';
  }
  function saveDaily(key, text) {
    const map = getDailyMap();
    if (text && text.trim()) map[key] = text;
    else delete map[key];
    writeJson('daily.json', map);
    return map;
  }

  /* ---------- 版本切换：清空上一版的数据（v3.3 需求） ----------
     用户明确要求「下一版本生成时清空之前的所有数据」，所以这里做一次性迁移：
     老数据先整目录归档（archive-v32-<日期>），再从工作目录里清掉，
     这样万一需要找回还来得及。主题属于「设置」不算数据，保留。 */
  function migrateEpoch() {
    let prev = null;
    try { prev = localStorage.getItem(EPOCH_KEY); } catch (e) { prev = null; }
    if (prev === EPOCH) return { wiped: false, archived: null };

    const stamp = U.dateKey().replace(/-/g, '');
    let archived = null;
    if (node && dataDir) {
      try {
        const bak = pathMod.join(dataDir, 'archive-v32-' + stamp);
        fs.mkdirSync(bak, { recursive: true });
        const docs = pathMod.join(dataDir, 'docs');
        if (fs.existsSync(docs)) {
          const dest = pathMod.join(bak, 'docs');
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          fs.renameSync(docs, dest);
        }
        fs.mkdirSync(docs, { recursive: true });
        ['index.json', 'trash.json', 'daily.json'].forEach((f) => {
          const src = pathMod.join(dataDir, f);
          if (!fs.existsSync(src)) return;
          try { fs.renameSync(src, pathMod.join(bak, f)); } catch (e) { /* ignore */ }
        });
        archived = bak;
      } catch (e) {
        console.warn('[Store] 归档旧数据失败', e);
      }
    }

    /* localStorage 里的阅读历史 / 文档缓存 / 回收站副本 */
    try {
      const keep = { [THEME_KEY]: 1, [EPOCH_KEY]: 1 };
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('eaglenote:') === 0 && !keep[k]) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(EPOCH_KEY, EPOCH);
    } catch (e) { /* ignore */ }

    indexCache = null;
    return { wiped: true, archived };
  }

  /* ---------- 清空全部数据 ---------- */
  function clearAll() {
    let n = 0;
    if (node && dataDir) {
      const dir = pathMod.join(dataDir, 'docs');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { names = []; }
      names.forEach((f) => {
        if (!/\.json$/.test(f)) return;
        try { fs.unlinkSync(pathMod.join(dir, f)); n++; } catch (e) { /* ignore */ }
      });
      ['index.json', 'trash.json'].forEach((f) => {
        try { fs.unlinkSync(pathMod.join(dataDir, f)); } catch (e) { /* ignore */ }
      });
    }
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf('eaglenote:doc:') === 0 || k === TRASH_KEY)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    indexCache = null;
    return n;
  }

  /* ---------- 文件读写 ---------- */
  /* 清掉插件写下的全部数据（v3.28）
     ──────────────────────────────
     只动本插件自己的数据目录：docs/、pdfbak/、index.json、trash.json、回收站里引用的东西。
     **识别模型（asr/ 下的模型文件）保留** —— 那是几百 MB 下载来的，
     删了要重下，和「清数据」不是一回事。
     返回删除成功的条目数（用于提示）。 */
  function wipeAll() {
    if (!node || !dataDir) return 0;
    let n = 0;
    const rm = (p) => {
      try {
        if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); n++; }
      } catch (e) { console.warn('[Store] 删除失败', p, e); }
    };
    rm(pathMod.join(dataDir, 'docs'));
    rm(pathMod.join(dataDir, 'pdfbak'));
    /* v3.29：摘录时收下的图片副本、兜底导出的文件都在这儿，一并清掉 */
    rm(pathMod.join(dataDir, 'media'));
    rm(pathMod.join(dataDir, 'exports'));
    ['index.json', 'trash.json', 'daily.json'].forEach((f) => rm(pathMod.join(dataDir, f)));
    try { fs.mkdirSync(pathMod.join(dataDir, 'docs'), { recursive: true }); } catch (e) { /* ignore */ }

    /* localStorage 里还躺着不少「内容」：回收站、阅读历史、每日笔记、术语表、
       行内翻译缓存、Markdown 投影设置……只清文件的话，重开插件它们全还在，
       等于「清了但没清干净」。只留主题、有道开关、数据版本这三个纯设置项。 */
    try {
      const keep = { [THEME_KEY]: 1, [EPOCH_KEY]: 1 };
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('eaglenote:') === 0 && !keep[k]) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(EPOCH_KEY, EPOCH);
    } catch (e) { /* localStorage 不可用就只管文件 */ }

    return n;
  }

  /* ---------- 笔记媒体库（v4.2.7） ----------
     粘贴进笔记的图片、添加为附件的本地文件，先复制一份进 <dataDir>/media/，
     笔记里只记 enmedia:<文件名> 短引用 —— 原始文件之后被删 / 挪位置，
     笔记内容与引用都不受影响（渲染时从这里读副本）。
     文件名统一重生成，不沿用原名：防重名覆盖，也防路径穿越。 */
  function mediaDir() {
    if (!node || !dataDir) return null;
    try { fs.mkdirSync(pathMod.join(dataDir, 'media'), { recursive: true }); } catch (e) { /* ignore */ }
    return pathMod.join(dataDir, 'media');
  }
  function mediaPath(name) {
    const dir = mediaDir();
    if (!dir) return '';
    const safe = String(name || '').replace(/[\\/:*?"<>|]/g, '');
    return safe ? pathMod.join(dir, safe) : '';
  }
  /* dataURL → media/ 落盘，返回 'enmedia:<文件名>' 短引用；失败返回 ''（调用方退回 dataURL 内嵌） */
  function saveMediaDataUrl(dataUrl, ext) {
    const dir = mediaDir();
    if (!dir || !dataUrl) return '';
    const mime = /^data:([^;,]+)/.exec(String(dataUrl));
    const e = String(ext || (mime ? mime[1].split('/')[1] : '') || 'png')
      .replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
    const name = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + '.' + e;
    return writeDataUrl(dir, name, dataUrl) ? ('enmedia:' + name) : '';
  }
  /* 本地文件 → media/ 副本，返回副本绝对路径；失败返回 ''（调用方退回原路径） */
  function copyMedia(srcPath) {
    const dir = mediaDir();
    if (!node || !dir || !srcPath) return '';
    try {
      const base = pathMod.basename(srcPath);
      if (!base) return '';
      const name = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '-' + base;
      const target = pathMod.join(dir, name);
      fs.copyFileSync(srcPath, target);
      return target;
    } catch (e) { return ''; }
  }

  function readFileBuffer(filePath) {
    if (!node || !filePath) return null;
    try {
      const buf = fs.readFileSync(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      console.warn('[Store] 读取 PDF 失败：', filePath, e);
      return null;
    }
  }

  function fileExists(p) {
    if (!node || !p) return false;
    try { return fs.existsSync(p); } catch (e) { return false; }
  }

  function writeTextFile(dirPath, fileName, text) {
    if (!node || !dirPath) return null;
    try {
      const target = pathMod.join(dirPath, fileName);
      fs.writeFileSync(target, text, 'utf8');
      return target;
    } catch (e) {
      console.warn('[Store] 写入文本文件失败', e);
      return null;
    }
  }

  function dirOf(filePath) {
    if (!node || !filePath) return null;
    try { return pathMod.dirname(filePath); } catch (e) { return null; }
  }

  /* ---------- 二进制落盘（v3.27：视频帧 / 片段的「另存为」） ----------
     重名不覆盖：同名文件已存在就自动加 (2)(3)…，用户反复导出同一个片段
     时不会互相顶掉，也不会被问一遍「要不要替换」。 */
  function uniqueName(dirPath, fileName) {
    if (!node || !dirPath) return fileName;
    try {
      const dot = fileName.lastIndexOf('.');
      const base = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      let target = pathMod.join(dirPath, fileName);
      let i = 2;
      while (fs.existsSync(target) && i < 999) {
        target = pathMod.join(dirPath, base + ' (' + i + ')' + ext);
        i++;
      }
      return pathMod.basename(target);
    } catch (e) { return fileName; }
  }

  function writeBinaryFile(dirPath, fileName, buffer) {
    if (!node || !dirPath || !buffer) return null;
    try {
      const name = uniqueName(dirPath, fileName);
      const target = pathMod.join(dirPath, name);
      fs.writeFileSync(target, Buffer.from(buffer));
      return target;
    } catch (e) {
      console.warn('[Store] 写入二进制文件失败', e);
      return null;
    }
  }

  /* 拼路径 / 写到指定路径（v3.28：另存为要落到用户选的那个位置） */
  function joinPath(dirPath, fileName) {
    if (!node) return String(dirPath || '') + '/' + String(fileName || '');
    try { return pathMod.join(dirPath || '', fileName || ''); } catch (e) { return String(fileName || ''); }
  }

  function writeFileAt(target, buffer) {
    if (!node || !target) return null;
    try {
      const dir = pathMod.dirname(target);
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
      fs.writeFileSync(target, Buffer.from(buffer));
      return target;
    } catch (e) {
      console.warn('[Store] 写入文件失败', target, e);
      return null;
    }
  }

  /* dataURL（image/png|jpeg…）→ 文件。返回写入后的完整路径，失败返回 null */
  function writeDataUrl(dirPath, fileName, dataUrl) {
    if (!node || !dirPath || !dataUrl) return null;
    try {
      const s = String(dataUrl);
      const comma = s.indexOf(',');
      if (comma < 0) return null;
      const meta = s.slice(0, comma);
      if (meta.indexOf('base64') < 0) {
        /* 非 base64 的 dataURL：先解码百分号转义 */
        const text = decodeURIComponent(s.slice(comma + 1));
        return writeBinaryFile(dirPath, fileName, Buffer.from(text, 'binary'));
      }
      return writeBinaryFile(dirPath, fileName, Buffer.from(s.slice(comma + 1), 'base64'));
    } catch (e) {
      console.warn('[Store] 写入 dataURL 失败', e);
      return null;
    }
  }

  function downloadText(fileName, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = U.el('a', { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* ---------- 阅读历史（只记 Eagle 条目） ---------- */
  function getHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function pushHistory(entry) {
    if (!entry || !entry.itemId) return getHistory();   // 本地文件不进历史
    try {
      const list = getHistory().filter((it) => it.itemId !== entry.itemId);
      list.unshift(Object.assign({ at: Date.now() }, entry));
      const trimmed = list.slice(0, 40);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch (e) { return getHistory(); }
  }

  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* ignore */ }
  }

  function getTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  }

  return {
    load, save, readFileBuffer, fileExists, writeTextFile, dirOf, downloadText,
    joinPath, writeFileAt, wipeAll,
    writeBinaryFile, writeDataUrl, uniqueName,
    docFile, docKey, emptyData, normalize,
    setDataDir, getDataDir, getIndex, rebuildIndex, invalidateIndex,
    readDocByKey, writeDocByKey,
    getTrash, purgeTrash, pushTrash, dropTrash, emptyTrash,
    getDaily, saveDaily, clearAll, migrateEpoch, EPOCH,
    getHistory, pushHistory, clearHistory, getTheme, setTheme,
    mediaDir, mediaPath, saveMediaDataUrl, copyMedia,
    get hasNode() { return node; },
    VERSION, TRASH_DAYS
  };
})();
