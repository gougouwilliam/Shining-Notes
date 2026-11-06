/* v3.35 回归：Markdown 知识库（Windows 里可视化 + 四者一一对应 + 手改能读回）
 *
 * 这一版动的是「笔记到底存在哪、长什么样」：
 *   1. 目录  E:\Notes Collection from Eagle\<库名>\  （资源管理器里能逛）
 *   2. 命名  文件名 = 书名.md，撞名才追加短 id
 *   3. 对应  frontmatter 有 eagle / source；每条摘录、笔记各有一对锚点注释
 *   4. 同步  插件写 → MD；手改 MD → 插件（写之前先读回，绝不冲掉手打的内容）
 *   5. 安全  文件末尾「## 手记（不会被插件覆盖）」原样保留；双改冲突另存 .conflict
 *
 * 用真文件系统 + 临时目录跑真实读写 —— 这一层没法靠字符串断言假装通过。
 *
 * 运行：node test-v335.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const has = (src, s) => src.indexOf(s) >= 0;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 沙箱：真 fs/path，假 Store/U/localStorage ---------- */
function memStore() {
  const m = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _raw: m
  };
}

function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h ^ str.charCodeAt(i)) * 16777619) >>> 0;
  return h.toString(36);
}

function loadProjection(seed) {
  const code = fs.readFileSync(path.join(ROOT, 'EaglePDFReader/js/projection.js'), 'utf8');
  const ls = memStore();
  Object.keys(seed || {}).forEach((k) => ls.setItem(k, seed[k]));
  const sandbox = {
    require: (n) => require(n),
    localStorage: ls,
    Buffer,
    console,
    Date,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    U: {
      stripExt: (n) => String(n || '').replace(/\.[a-z0-9]+$/i, ''),
      hashKey
    },
    Store: {
      docKey: (m) => (m && m.itemId) || 'k',
      getIndex: () => ({ docs: {} }),
      readDocByKey: () => null,
      normalize: (r) => r
    },
    window: {}
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'projection.js' });
  const P = sandbox.Projection || sandbox.window.Projection;
  P._ls = ls;
  return P;
}

function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eaglenote-' + tag + '-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const META = {
  itemId: 'MV11TX2DS5BHY',
  name: '膜解剖实战 - 保脾胰体尾切除术.pdf',
  filePath: 'E:\\DY - Clinical Surgery.library\\images\\MV11TX2DS5BHY.pdf',
  ext: 'pdf',
  tags: ['外科', '胰腺'],
  libraryName: 'DY - Clinical Surgery'
};

function mkData() {
  return {
    fileName: '膜解剖实战 - 保脾胰体尾切除术.pdf',
    annotations: [
      { id: 'ex_a1', page: 3, color: 'yellow', text: '脾动脉的走行要贴着胰背上缘', note: '这里有个解剖变异' },
      { id: 'ex_b2', page: 7, color: 'green', text: '保留脾脏的关键是脾动静脉分支' }
    ],
    notes: [
      { id: 'nt_c3', page: 4, quote: '脾门区解剖', md: 'Cleveland 法 vs Warshaw 法，后者脾梗风险更高' }
    ]
  };
}

/* ───────────────────── 1. 目录与命名 ───────────────────── */
console.log('\n[1] 知识库目录与文件名');

const hub = mkTmp('hub');
const P = loadProjection({ 'eaglenote:mdroot': hub });
const libDir = P.relocate(hub, META.libraryName);

ok(!!libDir, 'relocate() 建出库子目录');
ok(libDir === path.join(hub, META.libraryName), '库子目录 = <知识库根>\\<资料库名>');
ok(fs.existsSync(path.join(hub, 'README.md')), '知识库根有一份 README.md（说明怎么用）');
ok(has(fs.readFileSync(path.join(hub, 'README.md'), 'utf8'), '<!-- eagle:ex:'), 'README 讲清锚点怎么对回条目');

P.setRoot(libDir);
/* 上层（app.js）会装这两个钩子：一个把 MD 里的文字写回内存，一个负责落盘。
   测试里也要装 —— 不装的话 writeNow 读回来的改动没人接，等于测了个假通路。 */
let merged = 0;
P.setHooks({
  onExternal(meta, data, edits) { P.applyEdits(edits); },
  onMerged() { merged++; }
});

const d1 = mkData();
const r1 = P.writeNow(META, d1, false);
ok(r1.ok && !r1.skipped, '首次写入成功');
ok(path.basename(r1.file) === '膜解剖实战 - 保脾胰体尾切除术.md', '文件名就是书名（不再顶一串条目 id）');

const md1 = fs.readFileSync(r1.file, 'utf8');
ok(/^---\n/.test(md1), '有 YAML frontmatter');
ok(has(md1, 'eagle: "MV11TX2DS5BHY"'), 'frontmatter 记 Eagle 条目 id');
ok(has(md1, 'source: "E:\\\\DY - Clinical Surgery.library'), 'frontmatter 记源文件真实路径');
ok(has(md1, 'library: "DY - Clinical Surgery"'), 'frontmatter 记资料库名');
ok(has(md1, 'rev: 1'), 'frontmatter 有修订号');
ok(has(md1, 'tags: ["外科", "胰腺"]'), 'frontmatter 带标签');

/* 撞名：另一个条目同名 → 追加短 id，两个文件都在 */
const META2 = Object.assign({}, META, { itemId: 'LSPDP9Z8X2QWA' });
const r2 = P.writeNow(META2, mkData(), false);
ok(r2.ok && path.basename(r2.file) !== path.basename(r1.file), '同名文档不覆盖，追加短 id 区分');
ok(path.basename(r2.file).indexOf('(2QWA)') > 0 || /\([A-Za-z0-9]{6}\)/.test(path.basename(r2.file)), '短 id 后缀取自条目 id 末尾');

/* ───────────────────── 2. 一一对应的锚点 ───────────────────── */
console.log('\n[2] 摘录 / 笔记逐条对应');

ok(has(md1, '<!-- eagle:ex:ex_a1 -->'), '每条摘录有开始锚点');
ok(has(md1, '<!-- /eagle:ex:ex_a1 -->'), '每条摘录有结束锚点');
ok(has(md1, '<!-- eagle:nt:nt_c3 -->'), '每条笔记有锚点');

const blocks = P.parseBlocks(md1);
ok(Object.keys(blocks.ex).length === 2, '解析出 2 段摘录');
ok(Object.keys(blocks.nt).length === 1, '解析出 1 段笔记');
ok(has(md1, '> 脾动脉的走行要贴着胰背上缘'), '引用原文以引用块出现');
ok(has(md1, '**笔记**'), '摘录批注用「**笔记**」起头（回读靠它切段）');
ok(P.noteOfEx(blocks.ex.ex_a1) === '这里有个解剖变异', 'noteOfEx 能取回批注正文');
ok(P.bodyOfNt(blocks.nt.nt_c3, 'Cleveland 法 vs Warshaw 法，后者脾梗风险更高') === 'Cleveland 法 vs Warshaw 法，后者脾梗风险更高', 'bodyOfNt 能取回笔记正文（v4.3.6 标题头消费后还原成存储口径）');
ok(has(md1, '## 摘录') && has(md1, '## 笔记'), '有「摘录」「笔记」两个分区');

/* ───────────────────── 3. 手改 MD → 读回插件 ───────────────────── */
console.log('\n[3] 手改 MD 能读回（写之前先读）');

const edited = md1.replace('这里有个解剖变异', '这里是解剖变异：脾动脉走脾上缘');
fs.writeFileSync(r1.file, edited, 'utf8');

const d2 = mkData();
function prevOf(id) {
  P.flush();                                   // manifest 是延迟落盘的，先催一下
  const f = path.join(libDir, '.eaglenote-manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  return m[id];
}
const edits = P.readExternal(META, d2, edited, prevOf(META.itemId));
ok(edits.length === 1, '只识别出真正被改的那 1 条（没改的不算）');
ok(edits[0].kind === 'ex' && edits[0].id === 'ex_a1', '认得出是哪条摘录');
ok(edits[0].text === '这里是解剖变异：脾动脉走脾上缘', '取回的是手改后的文本');
ok(edits[0].conflict === false, '本地没动过 → 不算冲突');
P.applyEdits(edits);
ok(d2.annotations[0].note === '这里是解剖变异：脾动脉走脾上缘', 'applyEdits 写回了内存对象');

/* 关键：writeNow 自己也会先读再写，不需要上层手动调 */
const d3 = mkData();
const r3 = P.writeNow(META, d3, false);
ok(r3.ok, '第二次写入仍然成功');
ok(d3.annotations[0].note === '这里是解剖变异：脾动脉走脾上缘', 'writeNow 内部先读了手改内容，没被冲掉');
ok(has(fs.readFileSync(r1.file, 'utf8'), '这里是解剖变异：脾动脉走脾上缘'), '落盘的文件也保留了手改');
ok(merged >= 1, 'onMerged 被叫到（上层据此落盘）');

/* 两边都改 → 冲突标记 + 备份文件 */
console.log('\n[4] 双改冲突：MD 优先，插件旧值另存');
const md2 = fs.readFileSync(r1.file, 'utf8');
fs.writeFileSync(r1.file, md2.replace('这里是解剖变异：脾动脉走脾上缘', 'MD 里改的版本'), 'utf8');
const d4 = mkData();
d4.annotations[0].note = '插件里改的版本';        // 本地也改了
const r4 = P.writeNow(META, d4, false);
ok(r4.ok, '冲突时写入照样完成');
ok(d4.annotations[0].note === 'MD 里改的版本', '冲突时以 MD 手改版为准');
const conf = fs.readdirSync(libDir).filter((f) => /\.conflict-\d{8}-\d{6}\.md$/.test(f));
ok(conf.length === 1, '插件那一版落成 .conflict 文件，没悄悄丢');
ok(has(fs.readFileSync(path.join(libDir, conf[0]), 'utf8'), '插件里改的版本'), '冲突文件里是插件旧值');

/* ───────────────────── 5. 手记区 ───────────────────── */
console.log('\n[5] 「## 手记」区块不被覆盖');
const withHand = fs.readFileSync(r1.file, 'utf8').replace(/\s*$/, '\n\n' + P.HAND + '\n\n我自己补的一段：术后随访 3 个月复查 CT。\n');
fs.writeFileSync(r1.file, withHand, 'utf8');
const d5 = mkData();
P.writeNow(META, d5, false);
const afterHand = fs.readFileSync(r1.file, 'utf8');
ok(has(afterHand, '我自己补的一段：术后随访 3 个月复查 CT。'), '手记原文在重写后仍在');
ok((afterHand.match(/## 手记（不会被插件覆盖）/g) || []).length === 1, '手记标题不会重复堆叠');

/* ───────────────────── 6. 变更扫描与开关 ───────────────────── */
console.log('\n[6] 外部变更扫描 / 清空');
/* mtime 偶发与写入时刻同拍，扫描会当成「没动过」；轮询追加到 mtime 确实越过清单的 at，
   模拟「写完之后才改」（本机 fs shim 不支持 utimesSync，只能靠真实时钟） */
(function touchChanged() {
  /* 直接以 externallyChanged 的真实判定为准轮追加：清单落盘有防抖，
     磁盘上的 at 可能落后于内存 —— 用磁盘 at 当门槛会偶发漏检（3.37 踩过）。 */
  let changed = [];
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(r1.file, fs.readFileSync(r1.file, 'utf8') + '\n', 'utf8');
    changed = P.externallyChanged();
    if (changed.indexOf(META.itemId) >= 0) return;
    const spin = Date.now() + 6;
    while (Date.now() < spin) { /* 等 mtime 走一拍 */ }
  }
  throw new Error('追加 100 次都没被 externallyChanged 认出 —— 判定或计时环境异常');
})();
const changed = P.externallyChanged();
ok(changed.indexOf(META.itemId) >= 0, 'externallyChanged 认出被外部改过的文件');

const n = P.clearAll();
ok(n >= 2, 'clearAll 删掉清单认领的 md（' + n + ' 个）');
const left = fs.readdirSync(libDir).filter((f) => f.endsWith('.md') && !/\.conflict-/.test(f));
ok(left.length === 0, '清空后目录里没有残留 md');
ok(fs.readdirSync(libDir).some((f) => /\.conflict-/.test(f)), '冲突备份不在清空范围内（那是留给你找旧稿的）');
ok(fs.existsSync(path.join(libDir, 'assets')), 'assets 目录保留（用户可能往里放东西）');

rmrf(hub);

/* ───────────────────── 7. PDF 与视频不能认错 ───────────────────── */
console.log('\n[7] 时间轴只给视频，源文件要反查得到');

const P2 = loadProjection({});
const pdfMd = P2.build({ itemId: 'p1', name: 'a.pdf', ext: 'pdf' },
  { annotations: [{ id: 'a1', page: 3, t: 12.5, text: '脾动脉' }] }).text;
ok(pdfMd.indexOf('### p.3') >= 0, 'PDF 按页码分节');
ok(pdfMd.indexOf('00:12') < 0, 'PDF 的框选虽然带 t，也不会被写成时间轴（3.35 的坑）');

const vidMd = P2.build({ itemId: 'v1', name: 'b.mp4', ext: 'mp4' },
  { annotations: [{ id: 'b1', t: 12.5, t1: 18, text: '这里' }] }).text;
ok(vidMd.indexOf('### 00:12–00:18') >= 0, '视频按时间轴分节');

/* 假资料库：images/<id>.info/metadata.json 里有 name + ext，真实文件按 <name>.<ext> 落盘 */
const tmpLib = mkTmp('lib');
const itemDir = path.join(tmpLib, 'images', 'AB123.info');
fs.mkdirSync(itemDir, { recursive: true });
fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({ id: 'AB123', name: '膜解剖实战', ext: 'mp4' }), 'utf8');
fs.writeFileSync(path.join(itemDir, '膜解剖实战.mp4'), 'x');
fs.writeFileSync(path.join(itemDir, '膜解剖实战_thumbnail.png'), 'x');
fs.writeFileSync(path.join(itemDir, '片段-01.webm'), 'x');
P2.setLibrary(tmpLib, 'DY - Clinical Surgery');
const info = P2.itemInfoOf('AB123');
ok(info.path === path.join(itemDir, '膜解剖实战.mp4'), '源文件按 metadata 的 name+ext 反查，不会被同名片段抢走');
ok(info.ext === 'mp4', '扩展名取自 metadata');
rmrf(tmpLib);

/* ───────────────────── 8. 源码契约 ───────────────────── */
console.log('\n[8] 源码契约');

const PJ = read('EaglePDFReader/js/projection.js');
const BR = read('EaglePDFReader/js/bridge.js');
const APP = read('EaglePDFReader/js/app.js');
const HTML = read('EaglePDFReader/index.html');
const WB = read('EaglePDFReader/js/workbench.js');

ok(has(PJ, "const HUB_NAME = 'Notes Collection from Eagle'"), '知识库默认名就是用户指定的 Notes Collection from Eagle');
ok(has(PJ, "['E:', 'D:', 'F:']"), '默认优先落在 E 盘（其次 D/F，再退回「文档」）');
ok(has(PJ, ".eaglenote-write-test"), '选目录时真写探针，只读盘会被跳过');
ok(has(PJ, 'function writeConflictFile'), '有冲突备份实现');
ok(has(PJ, 'function externallyChanged'), '有外部变更扫描');
ok(has(PJ, "const WRITE_DELAY = 2600"), '打字停 2.6 秒才落盘（别把同步盘写爆）');

/* v4.2.12：md 投影下线，断言随功能反转更新 —— 索引随库走，md 同步面全删 */
ok(has(BR, 'migrateLegacyIndex(state.dataDir)'), 'Bridge 启动时把旧位置别名索引迁入 .eaglenote（v4.2.12）');
ok(has(BR, "mm.path.join(state.dataDir, 'vault')") && has(BR, 'Projection.setRoot(vaultDir)'), 'v4.3.0 vault 根 = <库>\\.eaglenote\\vault（随库走）');
ok(!has(APP, 'function syncFromDisk'), '「立即同步」实现已随 md 下线删除');
ok(!has(APP, 'function changeProjRoot'), '「更换位置」实现已删');
ok(!has(APP, "await step('知识库同步钩子'"), '同步钩子启动步骤已删');

ok(!has(HTML, 'id="btnWbChangeProj"'), '「更换位置」按钮已随 md 下线删除');
ok(!has(HTML, 'id="btnWbSyncProj"'), '「立即同步 MD」按钮已删');
ok(!has(HTML, 'id="btnWbOpenHub"'), '「打开知识库根目录」按钮已删');
ok(has(HTML, '打开本库数据目录'), '「打开本库数据目录」入口保留');

ok(has(WB, 'function projText()') && has(WB, 'Obsidian vault · 随库走'), '工作台路径显示 Obsidian vault（<库>\\.eaglenote\\vault）');
ok(has(WB, 'refreshPath'), '换目录后能就地刷新那行路径');

/* ESC 那套规则不许被这版带坏（v4.4.0 起空栈档恢复为 exit-plugin，noop 退役） */
ok(has(APP, 'exitPlugin();'), 'ESC 空栈走 exitPlugin() 关闭插件（v4.4.0 契约）');
const FW = read('EaglePDFReader/js/framewin.js');
ok(has(FW, 'App.exit'), '顶栏 ✕ 仍然走 App.exit');

console.log('\n' + (fail === 0 ? 'PASS ' : 'FAIL ') + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
