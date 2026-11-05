/* Eagle 宿主桥接层
   实测要点（来自 Eagle 4.0.0 app.asar）：
   - preload 里 `eagle.item` 是 class，`typeof` 为 "function"（旧版按 "object" 判断会误判为未连接）
   - 窗口插件 URL 是 eagleplugin://<id>/index.html；预览（空格）插件是 file://.../index.html?id=&path=
   - 两种形态都注入了完整 eagle API，因此预览里同样可以入库 */
const Bridge = (function () {
  const state = {
    ready: false,
    eagle: false,
    mode: 'browser',        // window | preview | browser
    pluginPath: null,
    manifest: null,
    libraryPath: null,
    libraryName: null,
    dataDir: null,
    projectionDir: null,
    theme: null,
    rawTheme: null,
    eagleTheme: null,
    epochWiped: null,
    query: { id: null, path: null, theme: null, lang: null }
  };

  const onRunHandlers = [];
  const ERR = '未检测到 Eagle 环境';

  /* 本插件自己的固定配色 → 原生窗口底色。
     注意：**不再跟随 Eagle 主题**。跟随的结果是「空格预览」按 Eagle 主题走、而独立窗口
     在 plugin-create 前读不到 app.theme 就退回浅色，两个入口色系必然不一致。
     固定深色（v1 的方案）两边永远一样。 */
  const MODEL_BG = { dark: '#18191c', light: '#f3f4f6' };

  let readyPromise = null;
  let createdPlugin = null;
  const createdWaiters = [];

  function api() {
    try {
      const e = window.eagle;
      if (!e) return null;
      // 关键：item 是 class（function），不能用 typeof === 'object'
      return (e.item && e.library) ? e : null;
    } catch (e) { return null; }
  }
  function isEagle() { return !!api(); }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function parseQuery() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { q = { get: () => null }; }
    return {
      id: q.get('id') || null,
      path: cleanPath(q.get('path')),
      theme: q.get('theme') || null,
      lang: q.get('lang') || null,
      /* v3.17：伴生插件「闪灵面板」跳转进来时带 launcher=1。
         此时窗口里的 plugin-create 事件指向的是启动器自己的目录，
         不能拿它当 pluginPath（pdf.js worker / cmaps 都在主插件目录里）。 */
      launcher: q.get('launcher') === '1'
    };
  }

  /* 预览 URL 里的 path 可能被编码两次、也可能是 file:// 形式，统一还原成可交给 fs 的原生路径 */
  function cleanPath(p) {
    if (!p) return null;
    let s = String(p).trim();
    if (/^file:/i.test(s)) {
      s = s.replace(/^file:\/{2,}/i, '');
      try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
    }
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    if (/%[0-9A-Fa-f]{2}/.test(s)) {
      try {
        const once = decodeURIComponent(s);
        if (once && once !== s) s = once;
      } catch (e) { /* 非法百分号编码，保持原样 */ }
    }
    // 统一成本机原生分隔符，便于与 Item.filePath、sidecar 目录做字符串比较
    const m = nodeMods();
    if (m && m.path && m.path.normalize) {
      try { s = m.path.normalize(s); } catch (e) { /* ignore */ }
    }
    return s || null;
  }

  /* Eagle 当前主题的原始名（LIGHT / DARK / GRAY / BLUE / PURPLE / LIGHTGRAY），仅用于诊断 */
  function rawTheme() {
    let t = '';
    try { t = (api() && api().app && api().app.theme) || ''; } catch (e) { /* ignore */ }
    if (!t) t = state.query.theme || '';
    return String(t).toUpperCase();
  }

  /* plugin-create 是否已经到达。Eagle 的 ipcRenderer.r2r 在拿到插件 id 之前一律 reject：
     "This method can only be used after the `plugin-create` event is triggered."
     所以任何走 IPC 的 API（library.info / item.get / dialog…）都必须等这一步之后。 */
  function isCreated() {
    if (createdPlugin) return true;
    try {
      const e = api();
      return !!(e && e.plugin && e.plugin.id);
    } catch (err) { return false; }
  }

  /* 本插件主题 → 窗口底色 */
  function modelBg(theme) {
    return MODEL_BG[theme === 'light' ? 'light' : 'dark'];
  }

  /* 把原生窗口背景设成与页面一致的底色，避免窗口边缘露出一圈异色 */
  function syncWindowBg(theme) {
    if (!isEagle() || !isCreated()) return false;
    try {
      const w = api().window;
      if (w && typeof w.setBackgroundColor === 'function') {
        w.setBackgroundColor(modelBg(theme));
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }


  function nodeMods() {
    try {
      if (typeof require === 'function') return { fs: require('fs'), path: require('path') };
    } catch (e) { /* ignore */ }
    return null;
  }

  function validDir(p) {
    if (!p || typeof p !== 'string') return false;
    const m = nodeMods();
    if (!m) {
      // 无 Node 时无法校验文件，只排除“根目录”这类明显无效的值
      return p.replace(/[\\/]+$/, '').length > 2 && /^([A-Za-z]:[\\/]|\/)/.test(p);
    }
    try { return m.fs.existsSync(m.path.join(p, 'manifest.json')); } catch (e) { return false; }
  }

  function themeName(t) {
    const raw = String(t || '').toUpperCase();
    if (!raw) return null;
    return /DARK|GRAY|BLUE|PURPLE/.test(raw) ? 'dark' : 'light';
  }

  function emitRun() {
    onRunHandlers.forEach((fn) => { try { fn(); } catch (e) { console.warn('[Bridge] onRun 回调异常', e); } });
  }

  /* ---------- 初始化 ---------- */
  // 尽早注册回调：主进程在 dom-ready 后约 100ms 广播 plugin-create。
  // 由脚本加载时立即调用一次（见文件末尾），boot() 里的调用是幂等的。
  let hooksDone = false;
  function initHooks() {
    if (hooksDone) return;
    if (!isEagle()) return;
    hooksDone = true;
    try {
      api().onPluginCreate((plugin) => {
        createdPlugin = plugin || createdPlugin;
        if (plugin) {
          state.manifest = plugin.manifest || state.manifest;
          if (validDir(plugin.path)) state.pluginPath = plugin.path;
        }
        createdWaiters.splice(0).forEach((fn) => fn(createdPlugin));
      });
    } catch (e) { /* ignore */ }
    try {
      api().onPluginRun(() => emitRun());
    } catch (e) { /* ignore */ }
    try {
      api().onThemeChanged((t) => {
        state.eagleTheme = String(t || '').toUpperCase();
        // 不跟随 Eagle 主题（两个入口要一致）；但 Eagle 每次换主题都会重设窗口底色，
        // 所以紧跟着把窗口底色改回与页面一致的颜色。
        syncWindowBg(document.documentElement.dataset.theme);
      });
    } catch (e) { /* ignore */ }
  }

  /* 等 plugin-create。若它已经发生（race），立即返回。 */
  function whenCreated(timeout) {
    if (isCreated()) {
      try {
        const e = api();
        if (e && e.plugin && e.plugin.id) return Promise.resolve(e.plugin);
      } catch (err) { /* ignore */ }
      return Promise.resolve(createdPlugin);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (p) => { if (settled) return; settled = true; resolve(p || null); };
      createdWaiters.push(done);
      setTimeout(() => done(null), timeout == null ? 3000 : timeout);
    });
  }

  function ready() {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      for (let i = 0; i < 25 && !isEagle(); i++) await sleep(40);

      state.eagle = isEagle();
      state.query = parseQuery();
      state.mode = state.eagle
        ? ((state.query.id || state.query.path) ? 'preview' : 'window')
        : 'browser';
      if (document.body) document.body.classList.add('mode-' + state.mode);
      document.documentElement.dataset.mode = state.mode;

      if (state.eagle) {
        const e = api();

        // 0) 必须先等 plugin-create：在此之前任何走 IPC 的 API 都会 reject
        //    预览（空格）窗口里这个事件不一定会来，所以只等很短，靠 path 参数走本地读取
        const waitMs = state.mode === 'preview' ? 1200 : 2500;
        const created = await whenCreated(waitMs);
        /* launcher=1：跳转前的窗口注册信息属于启动器插件，manifest 和 path 都不能用 */
        if (created && created.manifest && !state.query.launcher) state.manifest = created.manifest;

        // 1) 插件目录（pdf.js worker / cmaps 需要真实路径）
        try {
          const p = state.query.launcher ? null
            : ((created && created.path) || (e.plugin && e.plugin.path));
          if (validDir(p)) state.pluginPath = p;
        } catch (err) { /* ignore */ }
        if (!state.pluginPath) {
          try { if (validDir(__dirname)) state.pluginPath = __dirname; } catch (err) { /* ignore */ }
        }
        if (!state.pluginPath) {
          try {
            if (location.protocol === 'file:') {
              const u = new URL('.', location.href);
              let p = safeDecode(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
              if (validDir(p)) state.pluginPath = p;
            }
          } catch (err) { /* ignore */ }
        }

        /* launcher=1：pluginPath 是靠 location.href 兜出来的主插件目录，
           把真实的 manifest 补读进来 —— 否则关于页会显示启动器的名字和版本。 */
        if (state.query.launcher && state.pluginPath) {
          try {
            const m = nodeMods();
            const mf = m.path.join(state.pluginPath, 'manifest.json');
            if (m.fs.existsSync(mf)) state.manifest = JSON.parse(m.fs.readFileSync(mf, 'utf8'));
          } catch (err) { /* ignore */ }
        }

        // 2) 资源库路径（Item.filePath 由它推导，缺了会得到 undefined/images/...）
        try { state.libraryPath = e.library.path || null; } catch (err) { /* ignore */ }
        if (!state.libraryPath && isCreated()) {
          try {
            const info = await e.library.info();
            if (info) {
              state.libraryPath = info.path || null;
              state.libraryName = info.name || null;
              if (info.path) e.library.path = info.path;
            }
          } catch (err) { console.warn('[Bridge] library.info 失败', err); }
        }
        try { if (!state.libraryName) state.libraryName = e.library.name || null; } catch (err) { /* ignore */ }

        // 3) 索引目录：与资料库路径无关，库改名/搬盘都不受影响
        try { state.dataDir = await resolveDataDir(e); } catch (err) { /* ignore */ }

        /* 3.5) v4.2.8：笔记数据随库走。
           用户换电脑的习惯是整个 Eagle 库文件夹一起搬 —— 笔记正文、附件副本、
           粘贴贴图如果还藏在 userData 里就会掉队。现在 Store 的根目录优先用
           <资料库>\.eaglenote：库搬走，笔记跟着走；重装 Eagle + 插件后指回同一个
           库目录，数据原样都在。写不进去（库在只读盘 / 路径异常）就回退 userData
           老目录，行为与旧版完全一致。
           首次切换时把老数据整目录复制过来（老目录原样保留 = 天然备份）；
           之后以库内为准，不再反向覆盖。语音模型体积大，仍留在 userData。 */
        try {
          const pm = nodeMods();
          if (pm && pm.fs && pm.path && state.libraryPath && state.dataDir) {
            state.legacyDataDir = state.dataDir;               // Asr 等大块头继续用 userData
            const portable = pm.path.join(state.libraryPath, '.eaglenote');
            try {
              pm.fs.mkdirSync(portable, { recursive: true });
              const probe = pm.path.join(portable, '.write-probe');
              pm.fs.writeFileSync(probe, 'ok');
              pm.fs.unlinkSync(probe);
              if (portable !== state.dataDir) {
                migrateIntoPortable(pm, state.dataDir, portable);
                state.dataDir = portable;
              }
              state.portableDir = portable;
            } catch (err) {
              console.warn('[Bridge] 库内 .eaglenote 不可用，回退 userData 数据目录', err);
              state.portableDir = null;
            }
          }
        } catch (err) { console.warn('[Bridge] 随库数据目录初始化失败', err); }

        /* 4) v4.2.12：md 投影下线，只保留全库改名别名索引（.eaglenote-lib.json）。
              索引根 = state.dataDir（v4.2.8 起 = <库>\.eaglenote，随库走）。
              旧位置（盘根 Notes Collection from Eagle\<库名>、v4.2.11 过渡的
              .eaglenote\md）里的索引启动时自动搬进来，[[旧名]] 解析不断链。 */
        try {
          if (typeof Projection !== 'undefined') {
            const mm = nodeMods();
            if (mm && state.dataDir) {
              /* 反查源文件用资料库根（rebuildAll 手上没有 Eagle 的 item 对象） */
              if (Projection.setLibrary) Projection.setLibrary(state.libraryPath || null, state.libraryName || '');
              if (Projection.migrateLegacyIndex) {
                try { Projection.migrateLegacyIndex(state.dataDir); } catch (e) { /* 迁移失败不影响启动 */ }
              }
              state.projectionHub = null;
              /* v4.3.0：vault 固定在 <库>\.eaglenote\<vault 目录>\ —— 随库整体迁移，
                 重装后 Obsidian「打开文件夹作为仓库」指回这个路径即可。
                 MANIFEST/LIBFILE 跟着 root 写进 vault（点开头文件，Obsidian 不理），
                 docs/*.json 权威数据不受影响。
                 v4.3.2：目录名 = 闪灵笔记 - <库名>（库名 = 库文件夹去掉 .library 后缀，
                 与 Eagle 界面显示一致）——Obsidian 仓库切换器里多库一眼区分，
                 不再是一排毫无辨识度的「vault」。旧 vault/ 目录同盘 rename 迁移，
                 内容零拷贝零丢失；新名已存在则不动（避免覆盖）。 */
              let vaultDir = null;
              try {
                const libBase = mm.path.basename(state.libraryPath || '')
                  .replace(/\.library$/i, '').replace(/[\\/:*?"<>|]/g, ' ')
                  .replace(/\s+/g, ' ').trim();
                const vname = libBase ? ('闪灵笔记 - ' + libBase) : '闪灵笔记';
                vaultDir = mm.path.join(state.dataDir, vname);
                const legacyVault = mm.path.join(state.dataDir, 'vault');
                if (mm.fs.existsSync(legacyVault) && !mm.fs.existsSync(vaultDir)) {
                  mm.fs.renameSync(legacyVault, vaultDir);
                  console.info('[Bridge] vault 已按库名改名迁移:', vname);
                }
              } catch (e) { vaultDir = null; }
              state.projectionDir = (vaultDir && Projection.setRoot(vaultDir)) ? vaultDir : null;
            }
          }
        } catch (err) { console.warn('[Bridge] 初始化别名索引失败', err); }

        if (state.dataDir) {
          try {
            Store.setDataDir(state.dataDir);
            /* 语音识别的引擎、模型和字幕缓存都放在同一个数据目录下，
               和资料库路径无关 —— 库搬盘、改名都不影响已经下好的模型。 */
            try {
              if (typeof Asr !== 'undefined' && Asr.setDataDir) Asr.setDataDir(state.legacyDataDir || state.dataDir);
            } catch (err) { /* ignore */ }
            /* v3.3：升版时按用户要求清空上一版数据（老数据先归档再清） */
            try {
              const mg = Store.migrateEpoch();
              state.epochWiped = mg;
              if (mg && mg.wiped) {
                console.info('[Bridge] 已清空 v3.2 及更早的数据', mg.archived || '');
              }
            } catch (err) { console.warn('[Bridge] 版本迁移失败', err); }
            Store.rebuildIndex();
          } catch (err) { console.warn('[Bridge] 初始化索引目录失败', err); }
        }

        // 主题：只记录 Eagle 的主题名用于诊断，页面配色固定由插件自己决定
        state.eagleTheme = rawTheme();
        state.rawTheme = state.eagleTheme;
        state.theme = themeName(state.eagleTheme);
        document.documentElement.dataset.rawTheme = state.eagleTheme || '';
        console.info('[Bridge] Eagle 就绪', {
          mode: state.mode,
          pluginPath: state.pluginPath,
          libraryPath: state.libraryPath,
          eagleTheme: state.eagleTheme,
          version: (state.manifest && state.manifest.version) || '?'
        });
      }

      state.ready = true;
      return state;
    })();

    return readyPromise;
  }

  function onRun(fn) { onRunHandlers.push(fn); }

  /* 索引目录：<userData>/Plugins/EagleNoteManager/data
     选 userData 而不是资料库目录，是为了让索引与资料库的位置、名字彻底解耦。 */
  async function resolveDataDir(e) {
    const m = nodeMods();
    if (!m) return null;
    let base = null;
    try { base = (e.app && e.app.userDataPath) || null; } catch (err) { /* ignore */ }
    if (!base) {
      try { base = await e.app.getPath('userData'); } catch (err) { /* ignore */ }
    }
    if (!base) base = state.pluginPath;
    if (!base) return null;
    const dir = m.path.join(base, 'Plugins', 'EagleNoteManager', 'data');
    try {
      m.fs.mkdirSync(m.path.join(dir, 'docs'), { recursive: true });
      return dir;
    } catch (err) {
      console.warn('[Bridge] 创建索引目录失败', dir, err);
      return null;
    }
  }

  /* v4.2.8：旧 userData 数据 → 库内 .eaglenote 的一次性迁移。
     只在目标还没有 index.json（= 从没用过库内目录）时复制，避免旧数据
     反过来盖掉新数据；archive-* 快照目录和 .write-probe 不搬。
     复制失败不阻塞启动 —— Store 照常用库内目录，老数据仍在原地。 */
  function migrateIntoPortable(m, fromDir, toDir) {
    try {
      if (!fromDir || fromDir === toDir) return;
      if (!m.fs.existsSync(m.path.join(fromDir, 'index.json'))) return;   // 旧目录本来就空
      if (m.fs.existsSync(m.path.join(toDir, 'index.json'))) return;      // 库内已有数据，别覆盖
      const entries = m.fs.readdirSync(fromDir, { withFileTypes: true });
      for (const ent of entries) {
        const s = m.path.join(fromDir, ent.name);
        const d = m.path.join(toDir, ent.name);
        if (ent.name.startsWith('archive-') || ent.name === '.write-probe') continue;
        try {
          if (ent.isDirectory()) m.fs.cpSync(s, d, { recursive: true });
          else m.fs.copyFileSync(s, d);
        } catch (err) { console.warn('[Bridge] 迁移跳过', ent.name, err); }
      }
      console.info('[Bridge] 笔记数据已迁移到库内', toDir);
    } catch (err) { console.warn('[Bridge] 数据迁移失败（不影响启动）', err); }
  }

  /* 整个资料库的条目概要（工作台统计用） */
  async function getAllItems(fields) {
    if (!isEagle() || !isCreated()) return [];
    try {
      const list = await api().item.get({
        fields: fields || ['id', 'name', 'ext', 'lastModified', 'folders', 'tags', 'annotation', 'width', 'height']
      });
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('[Bridge] item.get 全量失败', e);
      return [];
    }
  }

  async function countItems() {
    if (!isEagle() || !isCreated()) return 0;
    try { return await api().item.countAll(); } catch (e) { return 0; }
  }

  /* 搜索资源库条目（附件从 Eagle 导入用） */
  async function searchItems(keyword, limit) {
    if (!isEagle() || !isCreated()) return [];
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const e = api();
    const max = limit || 40;
    const tries = [
      () => e.item.query({ query: kw }),
      () => e.item.get({ keywords: kw }),
      () => e.item.get({ keyword: kw })
    ];
    for (const run of tries) {
      try {
        const r = await run();
        const list = (Array.isArray(r) ? r : []).filter(Boolean);
        if (list.length) {
          return list.slice(0, max).map((it) => ({
            id: it.id,
            name: it.name || '',
            ext: (it.ext || U.extOf(it.name) || '').toLowerCase(),
            filePath: (function () { try { return it.filePath || ''; } catch (x) { return ''; } })(),
            annotation: it.annotation || ''
          }));
        }
      } catch (err) { /* 换下一种 */ }
    }
    return [];
  }


  /* v4.2.3：全库扫描 —— 双链候选不再只限「插件打开过的书」。
     按 ext 过滤拉一批 pdf / 视频条目（id + 名字 + 扩展名就够，
     不取 filePath：路径会因移动文件夹失效，id 永不失效）。
     Eagle 各版本 API 参数支持不一，逐种降级；失败就返回空，搜索退回旧范围。 */
  async function listLibraryItems(exts, max) {
    if (!isEagle() || !isCreated()) return [];
    const e = api();
    const want = (Array.isArray(exts) ? exts : ['pdf', 'mp4']).map((x) => String(x).toLowerCase());
    const cap = max || 3000;
    const pick = (list) => (Array.isArray(list) ? list : []).filter(Boolean)
      .map((it) => ({
        id: it.id,
        name: it.name || '',
        ext: (it.ext || U.extOf(it.name) || '').toLowerCase()
      }))
      .filter((it) => it.id && it.name && (want.indexOf(it.ext) >= 0))
      .slice(0, cap);
    const tries = [
      () => e.item.get({ ext: want }),     // Eagle3 支持 ext 过滤
      () => e.item.get({}),                // 不带参数拉全量，本地再筛
      () => e.item.get()
    ];
    for (const run of tries) {
      try {
        const out = pick(await run());
        if (out.length) return out;
      } catch (err) { /* 换下一种 */ }
    }
    return [];
  }


  function normalizeItem(it) {
    if (!it) return null;
    let filePath = '';
    let thumbnailPath = '';
    try { filePath = it.filePath || ''; } catch (e) { /* ignore */ }
    try { thumbnailPath = it.thumbnailPath || ''; } catch (e) { /* ignore */ }
    if (filePath && /[\\/]undefined[\\/]/.test(filePath)) filePath = '';

    return {
      id: it.id || null,
      name: it.name || '',
      ext: (it.ext || U.extOf(it.name) || '').toLowerCase(),
      folders: (function () { try { return it.folders || []; } catch (e) { return []; } })(),
      filePath: filePath || null,
      thumbnailPath: thumbnailPath || null,
      modifiedAt: it.modifiedAt || it.lastModified || 0,
      width: it.width || 0,
      height: it.height || 0,
      annotation: (function () { try { return it.annotation || ''; } catch (e) { return ''; } })(),
      tags: (function () { try { return it.tags || []; } catch (e) { return []; } })()
    };
  }

  async function getItemById(itemId) {
    if (!isEagle() || !itemId) return null;
    const e = api();
    // e.item 是 Item 类（静态方法）；不同版本对 get / getById 的支持略有差异，逐个降级
    const attempts = [
      () => e.item.getById(itemId),
      () => e.item.get({ id: itemId, ids: [itemId] }),
      () => e.item.get({ ids: [itemId] })
    ];
    for (const run of attempts) {
      try {
        const r = await run();
        const it = Array.isArray(r) ? r[0] : r;
        if (it) {
          const n = normalizeItem(it);
          if (n) return n;
        }
      } catch (err) { /* 换下一种 */ }
    }
    console.warn('[Bridge] getById 未取到条目', itemId);
    return null;
  }

  /* 原生「打开文件」对话框：比 <input type=file> 在 Electron webview 里可靠得多。
     返回：路径字符串 = 选中；'' = 用户取消；null = 该环境没有 dialog API */
  async function pickFile() {
    if (!isEagle()) return null;
    try {
      const dlg = api().dialog;
      if (!dlg || typeof dlg.showOpenDialog !== 'function') return null;
      const r = await dlg.showOpenDialog({
        title: '打开 PDF',
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (!r) return '';
      if (r.canceled) return '';
      if (Array.isArray(r.filePaths) && r.filePaths[0]) return r.filePaths[0];
      if (r.filePath) return r.filePath;
      return '';
    } catch (err) {
      console.warn('[Bridge] showOpenDialog 失败', err);
      return null;
    }
  }

  /* 任意类型文件的对话框（附件用）。返回数组，空数组表示取消 */
  async function pickAnyFile(opts) {
    if (!isEagle()) return [];
    try {
      const dlg = api().dialog;
      if (!dlg || typeof dlg.showOpenDialog !== 'function') return [];
      const r = await dlg.showOpenDialog(Object.assign({
        title: '选择附件',
        properties: ['openFile', 'multiSelections']
      }, opts || {}));
      if (!r || r.canceled) return [];
      return Array.isArray(r.filePaths) ? r.filePaths : (r.filePath ? [r.filePath] : []);
    } catch (err) {
      console.warn('[Bridge] 选择附件失败', err);
      return [];
    }
  }

  /* 当前选中的、本插件能打开的条目：PDF + 视频（3.3.3 起）。
     之前只放行 ext === 'pdf'，于是「资源库里选中视频按 P」永远是空的。 */
  const OPENABLE = ['pdf', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'];

  async function getSelectedDocs() {
    if (!isEagle()) return [];
    try {
      const items = await api().item.getSelected();
      return (items || [])
        .map(normalizeItem)
        .filter((it) => it && OPENABLE.indexOf(it.ext) >= 0);
    } catch (e) {
      console.warn('[Bridge] getSelected 失败', e);
      return [];
    }
  }

  /* 老名字留着：只关心 PDF 的地方还在用 */
  async function getSelectedPdfs() {
    return (await getSelectedDocs()).filter((it) => it.ext === 'pdf');
  }

  /* 本地文件（拖入 / 历史记录）→ 伪条目。ext 从文件名推，别写死 pdf ——
     否则「按路径打开一个 mp4」会被当成 PDF 送去 pdf.js。 */
  function localItem(filePath, name) {
    const base = name || String(filePath).split(/[\\/]/).pop() || '本地文档.pdf';
    return {
      id: null,
      name: base,
      ext: (U.extOf(base) || 'pdf').toLowerCase(),
      folders: [],
      filePath: filePath,
      thumbnailPath: null,
      modifiedAt: Date.now(),
      width: 0,
      height: 0,
      annotation: '',
      tags: [],
      local: true
    };
  }

  /* ---------- 写回 Eagle ---------- */
  async function addImageBase64(dataUrl, options) {
    if (!isEagle()) throw new Error(ERR + '，无法入库');
    const e = api();
    const payload = {
      name: options.name,
      annotation: options.annotation || '',
      tags: options.tags || [],
      folders: options.folders || []
    };
    try {
      return await e.item.addFromBase64(dataUrl, payload);
    } catch (err) {
      // 部分构建只接受不带 data URI 前缀的纯 base64
      const plain = U.dataUrlToBase64(dataUrl);
      if (plain === dataUrl) throw err;
      return await e.item.addFromBase64(plain, payload);
    }
  }

  const ANNOTATION_MAX = 10000;

  function clipAnnotation(text) {
    const s = String(text || '');
    return s.length > ANNOTATION_MAX ? s.slice(0, ANNOTATION_MAX - 16) + '\n…（已截断）' : s;
  }

  async function getAnnotation(itemId) {
    if (!isEagle() || !itemId) return '';
    try {
      const it = await api().item.getById(itemId);
      return (it && it.annotation) || '';
    } catch (e) { return ''; }
  }

  function annSame(a, b) {
    const norm = (s) => String(s == null ? '' : s)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t\u00a0]+$/gm, '')
      .trim();
    return norm(a) === norm(b);
  }

  /* 写 Eagle 条目的「注释」。
     v3.27：从「调一下就完事」改成「写完必须读回来对上」。
     用户反馈「PDF 的笔记没进注释、清空后又还在」—— 这两件事同一个根因：
     我们以为写成功了，实际 Eagle 那边没落盘（Item 可能是缓存副本，
     或者 save() 静默返回 false）。现在每次写都读回核对，不对就重新取一次
     再写一遍；三次还不对就抛错，让上层如实告诉用户，而不是假装成功。 */
  async function setAnnotation(itemId, text) {
    if (!isEagle()) throw new Error(ERR);
    const next = clipAnnotation(text);
    const e = api();
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const it = await e.item.getById(itemId);
        if (!it) {
          lastErr = new Error('找不到条目：' + itemId);
        } else {
          it.annotation = next;
          if (typeof it.save === 'function') {
            const r = await it.save();
            if (r === false) lastErr = new Error('Eagle 拒绝保存（save() 返回 false）');
          } else if (e.item && typeof e.item.update === 'function') {
            await e.item.update(it);
          }
          /* 先看这次拿到的对象有没有被回写（快路径，省一次 IPC） */
          if (annSame(it.annotation, next)) return next;
        }
      } catch (err) { lastErr = err; }

      /* 慢路径：重新取一条再读，Eagle 有时要等一次落盘才读得到新值 */
      const back = await getAnnotation(itemId);
      if (annSame(back, next)) return next;
      await new Promise((r) => setTimeout(r, 120 + attempt * 180));
    }
    throw new Error('Eagle 注释未写入'
      + (lastErr ? '：' + (lastErr.message || lastErr) : '（读回的内容和写入的不一致）'));
  }

  async function addTags(itemId, tags) {
    if (!isEagle()) return false;
    try {
      const it = await api().item.getById(itemId);
      if (!it) return false;
      const set = new Set(it.tags || []);
      tags.forEach((t) => set.add(t));
      it.tags = Array.from(set);
      await it.save();
      return true;
    } catch (e) {
      console.warn('[Bridge] addTags 失败', e);
      return false;
    }
  }

  async function openItem(itemId) {
    if (!isEagle()) return false;
    try { await api().item.open(itemId); return true; } catch (e) { return false; }
  }

  function openExternal(url) {
    /* v4.2：只把真正的网页地址交给系统浏览器。
       以前 wikilink（href=javascript:void(0)）漏到这里，Eagle 直接弹
       「Failed to open」红条。 */
    if (!url || !/^(https?|mailto):/i.test(url)) return;
    if (isEagle()) {
      try { api().shell.openExternal(url); return; } catch (e) { /* ignore */ }
    }
    try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
  }

  /* 关闭插件窗口（回到 Eagle 资料库）
     只在「独立窗口」形态下动窗口：预览模式的 webContents 属于 Eagle 主窗口，
     调 hide()/minimize() 会把 Eagle 整个收进托盘，这是个很容易踩的坑。 */
  function closeWindow() {
    if (state.mode !== 'window') return false;
    try {
      const e = api();
      const w = e && e.window;
      if (w) {
        /* Eagle 官方 API 里其实没有 window.close，只有 hide / minimize；
           这里仍按 close → hide 的顺序探测，兼容不同版本 */
        if (typeof w.close === 'function') { w.close(); return true; }
        if (typeof w.hide === 'function') { w.hide(); return true; }
      }
    } catch (e) { /* ignore */ }
    try { window.close(); return true; } catch (e) { /* ignore */ }
    return false;
  }

  /* v3.28：真正关掉这个窗口 —— 走主进程，不再指望 window.close()
     ────────────────────────────────────────────────────────────
     翻 Eagle 的 app.asar 才看清的机制：
       ipcMain.handle('plugin.window.', (event, { method, value, value2 }) => {
         const bw = BrowserWindow.fromWebContents(event.sender);
         if (bw && bw[method]) return bw[method](value, value2);
       })
     主进程会把**任意** BrowserWindow 方法，转发给「发出这条消息的那个窗口」。
     eagle.window 只包了 show/hide/minimize…，没有 close，所以以前只能退回 hide()，
     而 hide() 并不是「关掉插件窗口」，窗口还在，用户看到的就是「按 ESC 什么也没发生」。
     这里直接走 IPC：先 close（走正常关闭流程），不成就 destroy（无条件销毁）。

     v3.27 之前一直以为是按键没送到、或者 ESC 栈还有残留层 —— 都不是。
     真正的出口在这里。 */
  function ipcWindow(method) {
    try {
      if (typeof require !== 'function') return false;
      const el = require('electron') || {};
      const ipc = el.ipcRenderer;
      if (!ipc || typeof ipc.invoke !== 'function') return false;
      ipc.invoke('plugin.window.', { method: method, value: undefined });
      return true;
    } catch (e) { return false; }
  }

  /* 能不能走 IPC 关窗（决定 ESC 用哪条路，UI 上也据此给提示） */
  function canIpcWindow() {
    try {
      if (typeof require !== 'function') return false;
      const el = require('electron') || {};
      return !!(el.ipcRenderer && typeof el.ipcRenderer.invoke === 'function');
    } catch (e) { return false; }
  }

  /* v3.30：@electron/remote 直连
     ────────────────────────────────────────────────────────────
     Eagle 自己是这么用的（app.asar 里到处是 `require('@electron/remote')`），
     插件窗口也开了 nodeIntegration，所以这里能拿到**真正的** BrowserWindow 对象 ——
     不必再靠 `plugin.window.` 那条转发通道猜主进程收到没有。

     好处有两个：
       1) close() 是同步的、有返回值的，能立刻知道成功与否；
       2) 能拿到 Eagle 主窗口（window.parentID 就是它的 webContents.id），
          退出前把它 restore + show + focus —— 否则插件关掉之后，
          用户落到的是一个缩在任务栏里的 Eagle，看着像「被切走了」。 */
  function remoteApi() {
    try {
      if (typeof require !== 'function') return null;
      return require('@electron/remote') || null;
    } catch (e) { return null; }
  }

  function selfWindow() {
    const r = remoteApi();
    if (!r || typeof r.getCurrentWindow !== 'function') return null;
    try { return r.getCurrentWindow(); } catch (e) { return null; }
  }

  /* 把 Eagle 主窗口叫回来。找不到就安静失败（预览窗口形态下没有 parentID）。 */
  function focusParent() {
    const r = remoteApi();
    if (!r || !r.BrowserWindow) return false;
    try {
      const wantId = (typeof window !== 'undefined') ? window.parentID : null;
      const all = r.BrowserWindow.getAllWindows() || [];
      let win = null;
      if (wantId != null) {
        for (let i = 0; i < all.length; i++) {
          const w = all[i];
          try { if (w && w.webContents && w.webContents.id === wantId) { win = w; break; } } catch (e) { /* ignore */ }
        }
      }
      if (!win) return false;
      if (win.isMinimized && win.isMinimized()) win.restore();
      if (win.isVisible && !win.isVisible()) win.show();
      if (win.focus) win.focus();
      return true;
    } catch (e) { return false; }
  }

  /* 关窗：优先 remote（同步、可靠），没有就退回 IPC 转发 */
  function closeSelf() {
    const w = selfWindow();
    if (w) {
      try {
        w.close();
        return true;
      } catch (e) { /* 落到 IPC */ }
    }
    return ipcWindow('close');
  }

  function destroySelf() {
    const w = selfWindow();
    if (w) {
      try {
        if (w.isDestroyed && w.isDestroyed()) return true;
        w.destroy();
        return true;
      } catch (e) { /* 落到 IPC */ }
    }
    return ipcWindow('destroy');
  }

  /* 把 dataURL 图片写入系统剪贴板（Electron 的 clipboard 比 navigator.clipboard 可靠） */
  function copyImageDataUrl(dataUrl) {
    try {
      if (typeof require === 'function') {
        const el = require('electron') || {};
        const clip = el.clipboard;
        const ni = el.nativeImage;
        if (clip && ni && typeof clip.writeImage === 'function') {
          const img = ni.createFromDataURL(dataUrl);
          if (img && (!img.isEmpty || !img.isEmpty())) { clip.writeImage(img); return true; }
        }
      }
    } catch (e) { console.warn('[Bridge] 复制图片失败', e); }
    return false;
  }

  /* 把链接存进 Eagle 资料库（「在 Eagle 中打开」的落点） */
  async function addUrlToLibrary(url, name) {
    if (!isEagle() || !isCreated()) return null;
    const e = api();
    const tries = [
      () => (typeof e.item.addFromURL === 'function' ? e.item.addFromURL(url, { name: name || url }) : null),
      () => (typeof e.item.addBookmark === 'function' ? e.item.addBookmark(url, { name: name || url }) : null)
    ];
    for (const run of tries) {
      try {
        const r = await run();
        if (r) return (typeof r === 'string') ? r : (r.id || null);
      } catch (err) { /* 换下一种 */ }
    }
    return null;
  }

  function showInFolder(p) {
    if (!isEagle() || !p) return false;
    try { api().shell.showItemInFolder(p); return true; } catch (e) { return false; }
  }

  /* 用系统默认程序打开一个本地文件（v3.28：片段的「打开」） */
  function openPath(p) {
    if (!p) return false;
    try {
      const sh = (typeof require === 'function') ? (require('electron') || {}).shell : null;
      if (sh && typeof sh.openPath === 'function') { sh.openPath(p); return true; }
    } catch (e) { /* 退回下面 */ }
    try {
      if (isEagle() && api().shell && typeof api().shell.openPath === 'function') {
        api().shell.openPath(p);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* 直接从窗口上截一块（v3.28.3）：PDF 框选的兜底通道
     ────────────────────────────────────────────────
     正常路径是让 pdf.js 把那一页按 2px/点重渲染再裁 —— 清晰，但依赖页面
     渲染成功。万一 pdf.js 那边抛错（页面正在重排、render task 被取消…），
     以前就整段静默失败，用户只看到一个框。这里给一条不依赖 pdf.js 的路：
     把「发消息的那个 webContents」直接截屏一块。
       ipcMain.handle('plugin.window.webContents.', …) 里对 capturePage
       取的就是 event.sender（插件自己的页面），返回 NativeImage。
     rect 是 CSS 像素（相对窗口内容区），不传就整窗。拿不到就返回 ''。 */
  async function captureWindow(rect) {
    try {
      if (typeof require !== 'function') return '';
      const el = require('electron') || {};
      const ipc = el.ipcRenderer;
      if (!ipc || typeof ipc.invoke !== 'function') return '';
      const r = rect && typeof rect === 'object'
        ? {
          x: Math.max(0, Math.round(rect.x || 0)),
          y: Math.max(0, Math.round(rect.y || 0)),
          width: Math.max(1, Math.round(rect.width || rect.w || 1)),
          height: Math.max(1, Math.round(rect.height || rect.h || 1))
        }
        : undefined;
      const img = await ipc.invoke('plugin.window.webContents.', { method: 'capturePage', value: r });
      if (!img) return '';
      if (typeof img === 'string') return img;                       // 某些版本直接给 dataURL
      if (typeof img.toDataURL === 'function') return img.toDataURL();
      if (img && img.constructor && typeof img.constructor.toDataURL === 'function') {
        return img.constructor.toDataURL(img);
      }
      return '';
    } catch (e) {
      console.warn('[Bridge] capturePage 失败', e);
      return '';
    }
  }

  /* 自检：这个窗口到底能不能被主进程认出来（v3.28.3）
     ─────────────────────────────────────────────────
     主进程的转发写法是 `BrowserWindow.fromWebContents(event.sender)`，
     拿不到窗口就静默回 undefined —— 这正是「另存为框不出现」的根因所在。
     探一下 isMaximized：能回 true/false 说明窗口句柄拿到了；
     回 undefined 说明这一层通道是断的（那么 dialog 也一定是断的）。 */
  async function windowProbe() {
    const out = { ipc: false, bw: 'unknown', dialog: false, capture: false };
    try { out.dialog = !!(window.eagle && window.eagle.dialog && window.eagle.dialog.showSaveDialog); } catch (e) { /* ignore */ }
    try {
      if (typeof require !== 'function') return out;
      const el = require('electron') || {};
      const ipc = el.ipcRenderer;
      if (!ipc || typeof ipc.invoke !== 'function') return out;
      out.ipc = true;
      const r = await ipc.invoke('plugin.window.', { method: 'isMaximized' });
      out.bw = r === undefined ? 'undefined' : (r === true ? 'max' : 'ok');
      try {
        const img = await ipc.invoke('plugin.window.webContents.', { method: 'isDestroyed' });
        out.capture = img === false || img === true;
      } catch (e) { out.capture = false; }
    } catch (e) {
      out.err = String((e && e.message) || e);
    }
    return out;
  }

  return {
    state,
    initHooks,
    ready,
    onRun,
    getItemById,
    getSelectedPdfs,
    getSelectedDocs,
    localItem,
    pickFile,
    pickAnyFile,
    modelBg,
    syncWindowBg,
    rawTheme,
    whenCreated,
    isCreated,
    getAllItems,
    countItems,
    searchItems,
    listLibraryItems,
    addImageBase64,
    getAnnotation,
    setAnnotation,
    annSame,
    clipAnnotation,
    addTags,
    openItem,
    openExternal,
    closeWindow,
    closeSelf,
    destroySelf,
    focusParent,
    canIpcWindow,
    copyImageDataUrl,
    addUrlToLibrary,
    showInFolder,
    openPath,
    captureWindow,
    windowProbe,
    get hasEagle() { return isEagle(); }
  };
})();

/* 脚本一加载就注册回调：早于主进程 dom-ready+100ms 的 plugin-create 广播 */
try { Bridge.initHooks(); } catch (e) { /* ignore */ }
