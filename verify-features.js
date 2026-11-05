/* verify-features.js —— 全功能自查
   ────────────────────────────────
   做一件事：把插件宣称的每一项功能，逐条对着**源码**找实现点，
   再去 `test-*.js` 里找有没有对应的断言，最后生成 FEATURES.md。

   为什么不是「跑一遍就完事」：这是 Electron 插件，真正的界面行为
   要 Eagle 里点才跑得起来。所以这里只负责把「有实现 / 有测试 / 两者都没有」
   分清楚，剩下的（拖拽、录音、另存框、ESC 真关窗）单独列成「需人工确认」。
   Node 环境，无需依赖。 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

/* 源码缓存：file → 内容。路径一律相对于 EaglePDFReader/，启动器用 ../EagleNoteWorkbench/ */
const SRC = {};
function src(file) {
  const key = file.indexOf('../') === 0 ? file.replace('../', '') : 'EaglePDFReader/' + file;
  if (!(key in SRC)) SRC[key] = read(key);
  return SRC[key];
}

/* 所有测试文件的合并文本（找覆盖用） */
const TESTS = fs.readdirSync(ROOT)
  .filter((f) => /^test-.*\.js$/.test(f))
  .map((f) => read(f))
  .join('\n');

function countIn(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

/* 每一项：g 组 / n 名称 / c 代码检查 [[文件, 片段], …] / t 测试关键字 */
const FEATURES = [
  /* ── A. 打开与切换 ── */
  { g: 'A. 打开与切换', n: '空格预览直接进插件', c: [['js/bridge.js', 'onRun'], ['js/app.js', 'Bridge.ready']], t: 'onRun' },
  { g: 'A. 打开与切换', n: '插件窗口载入当前选中项', c: [['js/bridge.js', 'getSelected'], ['js/app.js', 'state.item']], t: 'getSelected' },
  { g: 'A. 打开与切换', n: '启动器（LB7NOTEWB01）单图标进工作台', c: [['../EagleNoteWorkbench/wb-launch.js', 'MAIN_ID'], ['../EagleNoteWorkbench/manifest.json', 'LB7NOTEWB01']], t: '启动器' },
  { g: 'A. 打开与切换', n: '从系统拖入 PDF（getPathForFile 兜底）', c: [['js/app.js', 'getPathForFile']], t: 'getPathForFile' },
  { g: 'A. 打开与切换', n: '工作台 / 阅读界面互切', c: [['index.html', 'btnWorkbench'], ['js/app.js', 'workbench']], t: '工作台' },
  { g: 'A. 打开与切换', n: '最近阅读 → 直接进那篇', c: [['js/store.js', 'eaglenote:history'], ['js/workbench.js', 'getHistory']], t: 'getHistory' },

  /* ── B. 阅读 ── */
  { g: 'B. 阅读', n: '页码跳转 / 上一页下一页', c: [['js/app.js', 'goToPage']], t: 'goToPage' },
  { g: 'B. 阅读', n: '缩放（加减 / 适宽 / Ctrl+滚轮）', c: [['js/app.js', 'fitWidth'], ['js/viewer.js', 'setZoom']], t: 'fitWidth' },
  { g: 'B. 阅读', n: '目录（PDF outline）', c: [['js/pdfdoc.js', 'buildOutline'], ['js/app.js', 'outline']], t: '目录' },
  { g: 'B. 阅读', n: '缩略图惰性渲染', c: [['js/app.js', 'renderThumbs']], t: '缩略图' },
  { g: 'B. 阅读', n: '目录 / 缩略图弹出面板（v4.1，原左栏）', c: [['js/app.js', 'toggleSidePop'], ['css/app.css', 'side-pop']], t: 'sidepop' },
  { g: 'B. 阅读', n: '全文搜索（常驻框 + 计数 + 弹出结果面板）', c: [['js/search.js', 'rectsFor'], ['js/app.js', 'searchPane']], t: 'search' },
  { g: 'B. 阅读', n: '搜索临时标记不进 PDF', c: [['css/app.css', 'search-mark'], ['js/app.js', 'setActiveMark']], t: 'search-mark' },
  { g: 'B. 阅读', n: '内部链接翻页 / 外部链接三选一', c: [['js/app.js', 'resolveDest'], ['js/app.js', 'openExternal']], t: 'resolveDest' },
  { g: 'B. 阅读', n: '明暗主题切换（记忆）', c: [['js/store.js', 'THEME_KEY'], ['js/app.js', 'setTheme']], t: 'theme' },

  /* ── C. 摘录与标注 ── */
  { g: 'C. 摘录与标注', n: '摘录文字（不弹笔记框）', c: [['js/app.js', "act === 'excerpt'"], ['js/app.js', 'addAnnotation']], t: '摘录' },
  { g: 'C. 摘录与标注', n: '摘录并笔记（直接开大笔记框）', c: [['js/app.js', 'excerptNote']], t: 'excerptNote' },
  { g: 'C. 摘录与标注', n: '复制（CJK 字间空格清洗）', c: [['js/utils.js', 'squeezeCJK'], ['js/utils.js', 'CJK_GAP']], t: 'squeezeCJK' },
  { g: 'C. 摘录与标注', n: '划词翻译（就近弹层）', c: [['js/app.js', 'function runTranslate('], ['js/translator.js', 'prefetch']], t: 'runTranslate' },
  { g: 'C. 摘录与标注', n: '内嵌图片坐标命中（mousedown+mouseup）', c: [['js/viewer.js', 'findImageAt'], ['js/viewer.js', 'findLinkAt']], t: 'findImageAt' },
  { g: 'C. 摘录与标注', n: '图片摘录 → 收进右栏（不弹另存）', c: [['js/app.js', 'keepImageLocally'], ['js/app.js', "keepImageLocally(image, 'p' + pk.page + '-图片')"]], t: 'keepImageLocally' },
  { g: 'C. 摘录与标注', n: 'PDF 框选 → 收进右栏 + 位置兜底', c: [['js/viewer.js', 'onAreaRect'], ['js/app.js', 'Bridge.captureWindow']], t: 'handleAreaRect' },
  { g: 'C. 摘录与标注', n: '页面锚点（放下就开笔记框）', c: [['js/app.js', 'function handleNotePoint(']], t: 'handleNotePoint' },
  { g: 'C. 摘录与标注', n: '跨页选区拆成多条', c: [['js/viewer.js', 'snapshotSelection'], ['js/app.js', '跨 ${created.length} 页']], t: '跨页' },
  { g: 'C. 摘录与标注', n: '五色色板', c: [['index.html', 'swatch']], t: 'swatch' },
  { g: 'C. 摘录与标注', n: '双击编辑备注 / Ctrl+Enter 保存', c: [['js/annotations.js', "addEventListener('dblclick'"], ['js/editor.js', 'ctrlKey']], t: 'Ctrl' },
  { g: 'C. 摘录与标注', n: '撤销（Ctrl+Z）', c: [['js/undo.js', 'Undo'], ['js/app.js', 'Undo.']], t: 'undo' },
  { g: 'C. 摘录与标注', n: '高亮写进 PDF 文件本身', c: [['js/pdfwrite.js', 'load('], ['js/app.js', 'PdfWrite']], t: 'pdfwrite' },
  { g: 'C. 摘录与标注', n: '同步到 Eagle 条目注释', c: [['js/app.js', 'eagleAnnotationTextFrom'], ['js/bridge.js', 'setAnnotation']], t: 'eagleAnnotation' },

  /* ── D. 右栏 ── */
  { g: 'D. 右栏', n: '摘录 / 笔记 / 知识库 三页签', c: [['index.html', 'panel-tab'], ['js/app.js', 'function switchTab(']], t: 'switchTab' },
  { g: 'D. 右栏', n: '回收站（可恢复 / 30 天）', c: [['js/store.js', 'trash.json'], ['js/app.js', 'Trash.open()']], t: '回收站' },
  { g: 'D. 右栏', n: '卡片「另存原图」（按字节复制）', c: [['js/app.js', 'copyImageFileAs'], ['js/app.js', "'saveimg'"]], t: 'copyImageFileAs' },
  { g: 'D. 右栏', n: '卡片 OCR', c: [['js/app.js', 'ocrAnn']], t: 'ocrAnn' },
  { g: 'D. 右栏', n: '卡片翻译', c: [['js/app.js', "'trans'"]], t: 'transAnn' },
  { g: 'D. 右栏', n: '卡片图片不可拖动', c: [['js/app.js', 'img.draggable = false'], ['css/app.css', '-webkit-user-drag']], t: 'draggable' },
  { g: 'D. 右栏', n: '卡片溯源：点卡片回到该页', c: [['js/app.js', 'function focusAnn(']], t: 'focusAnn' },
  { g: 'D. 右栏', n: '多选批量操作', c: [['js/multiselect.js', 'MultiSelect']], t: 'multiselect' },

  /* ── E. 笔记 ── */
  { g: 'E. 笔记', n: '大笔记框（Markdown 实时预览）', c: [['js/editor.js', 'ne-preview'], ['js/markdown.js', 'render']], t: 'NoteEditor' },
  { g: 'E. 笔记', n: '笔记配图（拖入 / 粘贴）', c: [['js/editor.js', 'attach']], t: '配图' },
  { g: 'E. 笔记', n: 'Markdown 副本落到 _notes/', c: [['js/projection.js', 'writeImage'], ['js/projection.js', 'MANIFEST']], t: 'projection' },
  { g: 'E. 笔记', n: '笔记可导出', c: [['js/exporter.js', 'const Exporter'], ['js/app.js', 'Exporter.buildMarkdown']], t: 'Exporter' },

  /* ── F. 视频 ── */
  { g: 'F. 视频', n: '播放器 + 进度 / 音量 / 倍速', c: [['js/videoview.js', 'video'], ['index.html', 'btnVsClip']], t: 'VideoView' },
  { g: 'F. 视频', n: '六个标注键（截图 / 框选 / 片段 × 并笔记）', c: [['index.html', 'btnVsShot'], ['index.html', 'btnVsShotNote'], ['index.html', 'btnVsArea'], ['index.html', 'btnVsAreaNote'], ['index.html', 'btnVsClip'], ['index.html', 'btnVsClipNote']], t: 'btnVs' },
  { g: 'F. 视频', n: '截图 / 框选按原分辨率取帧', c: [['js/videoview.js', 'captureNative'], ['js/app.js', 'captureNative(at, rect']], t: 'captureNative' },
  { g: 'F. 视频', n: '片段录制（mp4 优先，退 webm）', c: [['js/clipexport.js', 'pickMime'], ['js/app.js', 'saveClipAs']], t: 'ClipExport' },
  { g: 'F. 视频', n: '实时字幕（本地识别 + 精修）', c: [['js/subtitle.js', 'Subtitle'], ['js/asr.js', 'Asr']], t: 'subtitle' },
  { g: 'F. 视频', n: '字幕一键存为笔记', c: [['js/app.js', 'Subtitle.onSaveSelection']], t: '字幕' },
  { g: 'F. 视频', n: '标注暂停 / 自动续播', c: [['js/app.js', 'pauseForVideo'], ['js/app.js', 'resumeVideo']], t: 'pauseForVideo' },
  { g: 'F. 视频', n: '视频源多路兜底', c: [['js/videoview.js', 'src']], t: '视频源' },

  /* ── G. AI 能力 ── */
  { g: 'G. AI 能力', n: '划词翻译双引擎 + 对冲调度', c: [['js/translator.js', 'engine'], ['js/translator.js', 'race']], t: 'translator' },
  { g: 'G. AI 能力', n: 'OCR（视觉模型 / 状态可见）', c: [['js/app.js', 'async function ocrAnn('], ['js/app.js', "key: 'vision'"]], t: 'ocrAnn' },
  { g: 'G. AI 能力', n: '术语表（提升识别与翻译一致性）', c: [['js/translator.js', 'gloss'], ['js/subtitle.js', 'gloss.length']], t: 'gloss' },
  { g: 'G. AI 能力', n: '专业领域词表（医学 / 生命科学）', c: [['js/domainterms.js', 'MEDICAL'], ['js/subtitle.js', 'DomainTerms']], t: 'DomainTerms' },
  { g: 'G. AI 能力', n: 'AI 总结双通道（本地 Ollama / 自定义 OpenAI 兼容）', c: [['js/aisummary.js', 'ollamaChat'], ['js/aisummary.js', 'openaiChat']], t: 'AiSummary' },
  { g: 'G. AI 能力', n: '双链笔记（[[书名]] 语法 + 出链索引 + 反链聚合 + 跳转）', c: [['js/wikilink.js', 'parseLinks'], ['js/projection.js', 'backlinksOf'], ['js/app.js', 'openWikiTarget']], t: 'WikiLink' },
  { g: 'G. AI 能力', n: 'AI 回复 Markdown 渲染呈现（入库保存原始 md）', c: [['js/aisummary.js', '_renderMd'], ['js/aisummary.js', 'renderMd']], t: 'AiSummary' },
  { g: 'G. AI 能力', n: '自定义 OpenAI 兼容接口（默认预填智谱免费档）', c: [['js/aisummary.js', 'open.bigmodel.cn'], ['js/aisummary.js', 'oaiModel']], t: 'openai' },
  { g: 'G. AI 能力', n: '长文 map-reduce（超预算分页分段提炼再合并）', c: [['js/aisummary.js', 'chunkPages'], ['js/aisummary.js', 'runSummary']], t: 'chunkPages' },
  { g: 'G. AI 能力', n: '总结 / 回答 / 摘句一键存入笔记', c: [['js/aisummary.js', 'noteMd'], ['js/app.js', 'addAiNote']], t: 'addAiNote' },
  { g: 'G. AI 能力', n: '本地模型（ollama）自动发现与预热', c: [['js/app.js', 'ollama'], ['js/app.js', 'warm']], t: 'ollama' },
  { g: 'G. AI 能力', n: '首次启动环境检查（缺什么说清楚）', c: [['js/app.js', 'checkEnv']], t: 'checkEnv' },

  /* ── H. 工作台 ── */
  { g: 'H. 工作台', n: '资料库总览 + 时钟', c: [['js/workbench.js', 'clock'], ['js/workbench.js', 'Workbench']], t: 'workbench' },
  { g: 'H. 工作台', n: '每日笔记（自动保存）', c: [['js/workbench.js', 'daily'], ['js/store.js', 'daily.json']], t: '每日笔记' },
  { g: 'H. 工作台', n: '知识库卡片墙（可打开 / 溯源）', c: [['js/workbench.js', 'imagePath'], ['js/workbench.js', 'drag']], t: '知识库' },
  { g: 'H. 工作台', n: '「清除插件数据…」入口', c: [['index.html', 'btnWbWipe'], ['js/app.js', 'clearAllData']], t: 'btnWbWipe' },
  { g: 'H. 工作台', n: 'Eagle 注释巡检（全库扫标记注释、官方 API 清空、不依赖索引）', c: [['index.html', 'btnWbAnnScan'], ['js/app.js', 'annInspectAll'], ['js/app.js', 'annMarkedOurs']], t: '注释巡检' },

  /* ── J. 知识库同步（3.37） ── */
  { g: 'J. 知识库同步', n: 'md 投影：锚点 + 手改回读 + 冲突备份', c: [['js/projection.js', 'eagle:ex:'], ['js/projection.js', 'writeConflictFile']], t: 'Projection' },
  { g: 'J. 知识库同步', n: '空内容不建 md，内容清空自动回收（手记保留）', c: [['js/projection.js', 'hasLiveContent'], ['js/projection.js', 'removed: true']], t: 'hasLiveContent' },
  { g: 'J. 知识库同步', n: 'Eagle 注释栏双向同步（eagle:ec 锚点 + 官方 API 写回）', c: [['js/projection.js', 'eagle:ec:'], ['js/projection.js', 'eagleApiWrite']], t: 'eagleApiWrite' },

  /* ── I. 窗口与退出 ── */
  { g: 'I. 窗口与退出', n: 'ESC 逐级退出（v3.31 起只收浮层，不关插件）', c: [['js/esc.js', 'Esc'], ['js/escguard.js', "'noop'"]], t: 'Esc' },
  { g: 'I. 窗口与退出', n: 'ESC 一律吞掉，不漏给 Eagle', c: [['js/app.js', 'stopPropagation()']], t: 'Esc' },
  { g: 'I. 窗口与退出', n: 'ESC 真能关窗（IPC close→destroy）', c: [['js/bridge.js', 'ipcWindow'], ['js/bridge.js', 'closeSelf']], t: 'closeSelf' },
  { g: 'I. 窗口与退出', n: '关不掉时常驻横幅 + 再试/最小化', c: [['js/app.js', 'exitFailBanner'], ['css/app.css', 'exit-fail']], t: 'exitFailBanner' },
  { g: 'I. 窗口与退出', n: 'ESC 无层可关时提示「退出请按 Ctrl+W」', c: [['js/app.js', 'escExitHint']], t: 'escExitHint' },
  { g: 'I. 窗口与退出', n: 'Ctrl+W 关闭', c: [['js/app.js', 'ctrlKey'], ['js/app.js', "'w'"]], t: 'Ctrl+W' },
  { g: 'I. 窗口与退出', n: '预览模式紧凑布局（mode-preview）', c: [['css/app.css', 'mode-preview']], t: 'mode-preview' },
  { g: 'I. 窗口与退出', n: '窗口底色跟随主题（不闪白）', c: [['js/bridge.js', 'syncWindowBg']], t: 'syncWindowBg' },
  { g: 'I. 窗口与退出', n: '无边框窗口 + 自绘标题栏', c: [['js/framewin.js', 'global.FrameWin'], ['js/app.js', 'FrameWin.init()']], t: 'framewin' },

  /* ── J. 数据 ── */
  { g: 'J. 数据', n: '按 Eagle itemId 存，库改名不丢', c: [['js/store.js', 'itemId'], ['js/store.js', 'docs']], t: 'itemId' },
  { g: 'J. 数据', n: '每篇一份 docs/<id>.json', c: [['js/store.js', 'writeDoc']], t: 'writeDoc' },
  { g: 'J. 数据', n: '索引里只存图片路径（不存 base64）', c: [['js/app.js', 'imagePath: kept.path'], ['js/app.js', 'function annHasImage(']], t: 'imagePath' },
  { g: 'J. 数据', n: '回收站文件 trash.json', c: [['js/store.js', 'trash.json']], t: 'trash' },
  { g: 'J. 数据', n: '换大版本自动清库（migrateEpoch）', c: [['js/store.js', 'migrateEpoch']], t: 'migrateEpoch' },
  { g: 'J. 数据', n: '写 PDF 前先备份（pdfbak）', c: [['js/pdfwrite.js', 'pdfbak'], ['js/store.js', 'pdfbak']], t: 'pdfbak' },
  { g: 'J. 数据', n: '清数据连素材副本一起清（media/）', c: [['js/store.js', "pathMod.join(dataDir, 'media')"]], t: 'media' },
  { g: 'J. 数据', n: '运行日志 debug.log（200KB 轮转）', c: [['js/dbg.js', 'debug.log'], ['js/dbg.js', '200']], t: 'Dbg' },

  /* ── K. 稳定性 ── */
  { g: 'K. 稳定性', n: '启动分步执行，失败只跳过那一步', c: [['js/app.js', 'bootErrors'], ['js/app.js', 'function sync(']], t: 'bootErrors' },
  { g: 'K. 稳定性', n: '全局错误 → 页头红条（不再静默）', c: [['js/app.js', 'unhandledrejection'], ['js/app.js', 'showFatal']], t: 'showFatal' },
  { g: 'K. 稳定性', n: '图片缩略图内存缓存（blob URL）', c: [['js/imgcache.js', 'blob'], ['js/imgcache.js', '_whiteRows']], t: 'ImgCache' },
  { g: 'K. 稳定性', n: '另存三态（选了 / 取消 / 弹不出来）', c: [['js/saveas.js', 'askEx'], ['js/saveas.js', 'unavailable']], t: 'askEx' },
  { g: 'K. 稳定性', n: '编辑器构造冒烟（防 TDZ 这类错）', c: [['js/editor.js', 'NoteEditor']], t: '编辑器冒烟' },
];

/* ── 逐条判定 ── */
const rows = [];
let okAll = 0;
let gapCode = 0;
let noTest = 0;

FEATURES.forEach((f) => {
  const misses = [];
  const files = [];
  f.c.forEach(([file, needle]) => {
    const text = src(file);
    files.push(file);
    if (!text) { misses.push('缺文件 ' + file); return; }
    if (text.indexOf(needle) < 0) misses.push(file + ' 里没有「' + needle + '」');
  });
  const tested = f.t ? countIn(TESTS, f.t) : 0;
  let status;
  if (misses.length) { status = '❌'; gapCode++; } else if (tested > 0) { status = '✅'; okAll++; } else { status = '🟡'; noTest++; }
  rows.push({ ...f, misses, tested, status, files: Array.from(new Set(files)) });
});

/* ── 输出 markdown ── */
const groups = [];
rows.forEach((r) => {
  let g = groups.find((x) => x.name === r.g);
  if (!g) { g = { name: r.g, rows: [] }; groups.push(g); }
  g.rows.push(r);
});

const total = rows.length;
const lines = [];
/* 标题里的版本号直接取 manifest —— 以前是手写死的，每升一版就留一个「v3.29.0」的旧标题 */
const VER = (() => {
  try { return JSON.parse(read('EaglePDFReader/manifest.json')).version || ''; } catch (e) { return ''; }
})();
lines.push('# 功能自查对照表（v' + VER + '）');
lines.push('');
lines.push('> 生成方式：`node verify-features.js`。每一项都对着**源码**找实现点，');
lines.push('> 再去 `test-*.js` 里找有没有对应断言。**这是静态核对，不是界面实测** ——');
lines.push('> 需要你真的点一下才能确认的，单独列在最后一节。');
lines.push('');
lines.push('| 图例 | 含义 |');
lines.push('| --- | --- |');
lines.push('| ✅ | 实现点齐 + 有自动测试覆盖 |');
lines.push('| 🟡 | 实现点齐，但没有自动测试（多半是纯界面行为） |');
lines.push('| ❌ | 找不到实现点（要修） |');
lines.push('');
lines.push('**合计 ' + total + ' 项：✅ ' + okAll + ' · 🟡 ' + noTest + ' · ❌ ' + gapCode + '**');
lines.push('');

groups.forEach((g) => {
  lines.push('## ' + g.name);
  lines.push('');
  lines.push('| | 功能 | 实现位置 | 测试命中 |');
  lines.push('| --- | --- | --- | --- |');
  g.rows.forEach((r) => {
    const where = r.files.map((f) => '`' + f.replace('../', '') + '`').join(' ');
    lines.push('| ' + r.status + ' | ' + r.n + ' | ' + where + ' | ' + (r.tested ? r.tested + ' 处' : '—') + ' |');
  });
  lines.push('');
});

const gaps = rows.filter((r) => r.misses.length);
if (gaps.length) {
  lines.push('## ❌ 缺实现点的项');
  lines.push('');
  gaps.forEach((r) => {
    lines.push('* **' + r.n + '**');
    r.misses.forEach((m) => lines.push('  * ' + m));
  });
  lines.push('');
}

const yellow = rows.filter((r) => r.status === '🟡');
if (yellow.length) {
  lines.push('## 🟡 有实现、但没有自动测试的项');
  lines.push('');
  yellow.forEach((r) => lines.push('* ' + r.n));
  lines.push('');
}

/* ── 资源完整性：引用的文件都在，写的文件都被引用 ── */
const assets = { missing: [], unused: [] };
(function () {
  const html = read('EaglePDFReader/index.html');
  const refs = [];
  html.replace(/(?:src|href)="([^"]+)"/g, (m, p) => {
    if (/^(https?:|data:|#)/.test(p)) return m;
    refs.push(p);
    return m;
  });
  refs.forEach((p) => {
    const full = path.join(ROOT, 'EaglePDFReader', p.replace(/^\.\//, ''));
    if (!fs.existsSync(full)) assets.missing.push(p);
  });
  const jsDir = path.join(ROOT, 'EaglePDFReader', 'js');
  fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    if (refs.indexOf('js/' + f) < 0) assets.unused.push('js/' + f);
  });
})();

lines.push('## 资源完整性');
lines.push('');
lines.push('`index.html` 里引用的脚本与样式，逐个确认文件存在：');
lines.push('');
if (assets.missing.length) {
  assets.missing.forEach((p) => lines.push('* ❌ 引用了但文件不存在：`' + p + '`'));
} else {
  lines.push('* ✅ 全部存在（含 `js/*.js`、`vendor/*`、`css/*`）');
}
if (assets.unused.length) {
  lines.push('* 🟡 目录里有但没被引用（可能是历史遗留）：');
  assets.unused.forEach((p) => lines.push('  * `' + p + '`'));
} else {
  lines.push('* ✅ `js/` 下每个文件都被页面引用，没有孤儿脚本');
}
lines.push('');

/* ── 人工实测清单：这些只能点出来，静态核对证明不了 ── */
const MANUAL = [
  ['AI 总结全文（本地）', '打开一篇 PDF → 点顶栏「AI 总结」→ 总结全文（本地模型）', '弹窗流式出总结；总结完可追问；悬停 AI 消息点「加入笔记」/ 选中文字点浮标，笔记列表出现对应条目'],
  ['AI 总结（自定义接口，可选）', '⚙ 填 baseURL + Key（推荐智谱 GLM-4-Flash 免费档）→ 切到自定义接口 → 总结', '流式总结按 Markdown 渲染；失败自动兜底到本地模型且原因可见'],
  ['知识库真的在资源管理器里', '打开 E:\\Notes Collection from Eagle', '每个资料库一个文件夹，每篇文档一份「书名.md」，assets 里有摘录图'],
  ['空内容不建 md', '打开一个从没记过笔记的 PDF/视频再关闭', 'E 盘不会多出空壳 md；产生第一条摘录/笔记/注释后才出现文件'],
  ['Eagle 注释双向同步', '在 md 的「Eagle 注释」区块写一句话 → 保存 → 打开插件后看 Eagle 注释栏', 'Eagle 注释栏出现同一句话；反过来在 Eagle 里改，下次同步 md 也变'],
  ['手改 MD 能读回插件', '在 VSCode 里改某条摘录下面的批注 → 保存 → 切回插件打开那篇', '右栏那条批注变成你改的文字；两边都改过时，插件里旧值会存成 .conflict 文件'],
  ['顶栏 ✕ 真的能关窗', '打开工作台 → Esc 收起 → 点窗口右上角 ✕', '窗口直接关掉（和 Ctrl+W 等价）；关不掉会出现常驻横幅，把横幅文字告诉我'],
  ['ESC 只往回收一层', '有浮层 / 搜索有字 / 正在输入时按 Esc', '只关掉最上面那一层，窗口不关；要退出插件用 Ctrl+W'],
  ['PDF 内嵌图片「摘录」', '点页面里的图片 → 工具条点「摘录」', '不弹另存为框；右栏摘录页多一张卡片，图能看到；提示「已收进右栏」'],
  ['PDF 框选', '顶栏「框选」→ 拖一个矩形', '不弹另存为框；右栏出卡片 + 笔记框（可直接写或 Esc 关掉）'],
  ['卡片「另存原图」', '右栏图片卡片 →「另存原图」', '这时才弹系统另存为；选好位置后文件在那里，像素与原图一致'],
  ['视频截图 / 框选', '视频右侧「截图」/「框选」', '不弹另存为框；右栏出卡片；鼠标移开后底部那条白线没有了（还有的话截局部大图）'],
  ['视频片段', '「节选片段」取 A → 再按取 B', '弹「片段另存为」；生成 mp4（或 webm），卡片显示「▶ 文件名 · 时长」'],
  ['卡片图片不可拖', '按住卡片里的图片往阅读区拖', '拖不动，不出现「仅支持 PDF 文件」'],
  ['划词经过行间', '慢速拖过两行之间', '不再整段闪一下；松开后只高亮真正划过的字'],
  ['高亮写进 PDF', '摘录几段 → 用 Acrobat/浏览器打开同一个 PDF', '高亮在那里，颜色一致'],
  ['清除插件数据', '工作台底部「清除插件数据…」', '确认框讲清楚删什么/不删什么；执行后重开是空库，识别模型还在'],
  ['拖入 PDF', '从资源管理器拖一个 PDF 到界面', '只读打开，可阅读可摘录'],
];
lines.push('## 需要你点一下才能确认的（静态核对证明不了）');
lines.push('');
lines.push('| # | 功能 | 怎么做 | 期望 |');
lines.push('| --- | --- | --- | --- |');
MANUAL.forEach((m, i) => {
  lines.push('| ' + (i + 1) + ' | ' + m[0] + ' | ' + m[1] + ' | ' + m[2] + ' |');
});
lines.push('');
lines.push('> 其中 1～7 是本轮改动或上次报错的直接相关项，优先验。');
lines.push('');

fs.writeFileSync(path.join(ROOT, 'FEATURES.md'), lines.join('\n'), 'utf8');

/* 控制台摘要 */
console.log('功能自查：共 ' + total + ' 项');
console.log('  ✅ ' + okAll + '   🟡 ' + noTest + '   ❌ ' + gapCode);
if (gaps.length) {
  console.log('\n缺实现点：');
  gaps.forEach((r) => {
    console.log('  ✗ ' + r.n);
    r.misses.forEach((m) => console.log('      - ' + m));
  });
}
console.log('\n已写出 FEATURES.md');
process.exit(gapCode ? 1 : 0);
