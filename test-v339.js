/* v3.37.0 回归：知识库两条新语义
 *
 *  1. **空内容不建 md**：没有摘录、笔记、Eagle 注释就不落盘；产生第一条内容才建文件；
 *     内容清空且没有手记 → 整个文件回收（打开即投影的时代，E 盘留下过三篇清不掉的空壳）。
 *  2. **Eagle 注释栏双向同步**：metadata.json 的 annotation 投影为 md 的
 *     `<!-- eagle:ec:… -->` 区块；md 里手改 → 官方 API 写回 Eagle；
 *     Eagle 里改 → 投影进 md；两边都改 → md 优先，Eagle 旧值进 .conflict。
 *
 * 用真文件系统跑真实读写；Eagle API 用假对象验证写回链路。
 *
 * 运行：node test-v339.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- 沙箱 ---------- */
function memStore() {
  const m = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }
  };
}
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h ^ str.charCodeAt(i)) * 16777619) >>> 0;
  return h.toString(36);
}

function loadProjection(sandboxExtra) {
  const code = fs.readFileSync(path.join(ROOT, 'EaglePDFReader/js/projection.js'), 'utf8');
  const sandbox = {
    require: (n) => require(n),
    localStorage: memStore(),
    Buffer,
    console,
    Date,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
    U: { stripExt: (n) => String(n || '').replace(/\.[a-z0-9]+$/i, ''), hashKey },
    Store: { docKey: (m) => (m && m.itemId) || 'k', getIndex: () => ({ docs: {} }), readDocByKey: () => null, normalize: (r) => r },
    window: {}
  };
  Object.assign(sandbox, sandboxExtra || {});
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'projection.js' });
  return sandbox.Projection || sandbox.window.Projection;
}

/* ---------- 假 Eagle：getById 返回可改可存的 item，save 同步落 metadata.json ---------- */
function makeFakeEagle(libPath) {
  const ctl = { saves: 0, written: {} };
  function writeMeta(id, annotation) {
    const dir = path.join(libPath, 'images', id + '.info');
    const mf = path.join(dir, 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    meta.annotation = annotation;
    fs.writeFileSync(mf, JSON.stringify(meta), 'utf8');
  }
  const eagle = {
    item: {
      getById: (id) => {
        const mf = path.join(libPath, 'images', id + '.info', 'metadata.json');
        const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const item = {
          id,
          annotation: String(meta.annotation || ''),
          save() {
            ctl.saves++;
            ctl.written[id] = item.annotation;
            writeMeta(id, item.annotation);       // Eagle 保存 = metadata.json 落盘
            return Promise.resolve(item);
          }
        };
        return Promise.resolve(item);
      }
    }
  };
  return { eagle, ctl };
}

/* ---------- 夹具：临时 hub + 假资料库 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglenote-v339-'));
const hub = path.join(tmp, 'hub');
fs.mkdirSync(hub, { recursive: true });
const libPath = path.join(tmp, 'Test.library');
function seedItem(id, annotation) {
  const dir = path.join(libPath, 'images', id + '.info');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    id, name: 'Doc ' + id, ext: 'pdf', annotation: annotation || ''
  }), 'utf8');
}
seedItem('IT2', '');
seedItem('IT3', '');
seedItem('IT4', '');
seedItem('IT5a', '');

const fake = makeFakeEagle(libPath);
const P = loadProjection({ eagle: fake.eagle });
P.setHub(hub);
P.setLibrary(libPath, 'Test');
const rootDir = path.join(hub, 'Test');
P.setRoot(rootDir);
P.setHooks({
  onExternal(meta, data, edits) { P.applyEdits(edits); },
  onMerged() { /* 测试里不必落盘 */ }
});

const metaOf = (id) => ({ itemId: id, name: 'Doc ' + id, ext: 'pdf', filePath: path.join(libPath, 'images', id + '.info', 'Doc ' + id + '.pdf') });
const EMPTY = () => ({ annotations: [], notes: [] });
const mdOf = (id) => path.join(rootDir, 'Doc ' + id + '.md');

(async function main() {
  /* ===== 1. 空内容不建文件 ===== */
  console.log('\n— 空内容不建文件 —');
  let r = P.writeNow(metaOf('IT1'), EMPTY(), false);
  ok(r && r.empty === true, '没有任何内容 → skipped(empty)，不写文件');
  ok(!fs.existsSync(mdOf('IT1')), '磁盘上没有 md');
  ok(!P.writeNow(metaOf('IT1'), EMPTY(), false).removed, '重复触发也稳定跳过');

  /* ===== 2. 第一条摘录才建文件 ===== */
  console.log('\n— 第一条内容建文件 —');
  const data3 = { annotations: [{ id: 'A1', type: 'highlight', page: 3, text: '高亮文本', note: '' }], notes: [] };
  r = P.writeNow(metaOf('IT3'), data3, false);
  ok(r && r.ok && !r.skipped, '有摘录 → 建档成功');
  ok(fs.existsSync(mdOf('IT3')), 'md 落盘');
  const t3 = fs.readFileSync(mdOf('IT3'), 'utf8');
  ok(/## 摘录/.test(t3) && /> 高亮文本/.test(t3), '摘录投影正确');
  ok(/<!-- eagle:ec:IT3 -->/.test(t3), 'Eagle 注释区块存在（锚点用条目 id）');
  /* v4.5.0：标题前加「附 ·」，明确它是回写通道而不是正文 */
  ok(/## 附 · Eagle 注释（双向同步）/.test(t3), '注释区块标题存在');

  /* ===== 3. Eagle 注释 → md 投影 ===== */
  console.log('\n— Eagle 注释投影 —');
  writeMetaDirect('IT2', '手术要点\n第二行');
  r = P.writeNow(metaOf('IT2'), EMPTY(), false);
  ok(r && r.ok && !r.skipped, '注释非空也算内容 → 建档');
  const t2 = fs.readFileSync(mdOf('IT2'), 'utf8');
  ok(/<!-- eagle:ec:IT2 -->\s*\n手术要点\n第二行\n\s*<!-- \/eagle:ec:IT2 -->/.test(t2), '注释文本落在锚点区内');
  const built = P.build(metaOf('IT2'), EMPTY());
  ok(built.ec === '手术要点\n第二行', 'build().ec 返回当前注释');

  /* ===== 4. md 手改注释 → 写回 Eagle ===== */
  console.log('\n— md 手改 → 写回 Eagle —');
  const savesBefore = fake.ctl.saves;
  const t2b = t2.replace('手术要点\n第二行', '手改后的注释');
  fs.writeFileSync(mdOf('IT2'), t2b, 'utf8');
  r = P.writeNow(metaOf('IT2'), EMPTY(), false);
  ok(r && r.ok, '手改后的文件能正常同步');
  await P.drainEcWrites();
  ok(fake.ctl.saves > savesBefore, '官方 API save() 被调用');
  ok(fake.ctl.written.IT2 === '手改后的注释', '注释写回 Eagle 的值 = md 手改文本');
  const metaNow = JSON.parse(fs.readFileSync(path.join(libPath, 'images', 'IT2.info', 'metadata.json'), 'utf8'));
  ok(metaNow.annotation === '手改后的注释', 'Eagle 假端 metadata 已落盘');
  const t2c = fs.readFileSync(mdOf('IT2'), 'utf8');
  ok(t2c.indexOf('手改后的注释') >= 0, 'md 里的手改文本仍在');

  /* ===== 5. 写回后再次同步，不产生重复写回 ===== */
  console.log('\n— 不重复写回 —');
  const savesSnap = fake.ctl.saves;
  P.writeNow(metaOf('IT2'), EMPTY(), false);
  await P.drainEcWrites();
  ok(fake.ctl.saves === savesSnap, '内容没变 → 不再调用 save()');

  /* ===== 6. Eagle 侧改注释 → md 同步 ===== */
  console.log('\n— Eagle 侧改动 → md —');
  writeMetaDirect('IT2', 'Eagle里改的');
  P._ec.ecLocalAt.IT2 = Date.now() - 60000;   // 模拟落盘窗口已过
  P.writeNow(metaOf('IT2'), EMPTY(), false);
  const t2d = fs.readFileSync(mdOf('IT2'), 'utf8');
  ok(t2d.indexOf('Eagle里改的') >= 0, 'Eagle 的新注释投影进 md');

  /* ===== 7. 双改冲突：md 优先，Eagle 旧值进 .conflict ===== */
  console.log('\n— 双改冲突 —');
  writeMetaDirect('IT2', 'Eagle里的新版');
  const t2e = fs.readFileSync(mdOf('IT2'), 'utf8').replace('Eagle里改的', 'md里的新版');
  fs.writeFileSync(mdOf('IT2'), t2e, 'utf8');
  r = P.writeNow(metaOf('IT2'), EMPTY(), false);
  await P.drainEcWrites();
  ok(fake.ctl.written.IT2 === 'md里的新版', '冲突时 md 版本写回 Eagle');
  const conflicts = fs.readdirSync(rootDir).filter((f) => /^Doc IT2\.conflict-/.test(f));
  ok(conflicts.length === 1, '冲突备份文件已生成');
  if (conflicts.length) {
    ok(fs.readFileSync(path.join(rootDir, conflicts[0]), 'utf8').indexOf('Eagle里的新版') >= 0,
      'Eagle 那一版保存在冲突备份里');
  }
  ok(fs.readFileSync(mdOf('IT2'), 'utf8').indexOf('md里的新版') >= 0, 'md 保留手改版');

  /* ===== 8. 内容清空 → 文件回收 ===== */
  console.log('\n— 内容清空回收 —');
  writeMetaDirect('IT3', '');
  P._ec.ecLocalAt.IT3 = Date.now() - 60000;
  r = P.writeNow(metaOf('IT3'), { annotations: [], notes: [] }, false);
  ok(r && r.removed === true, '摘录清空 + 注释清空 → 文件回收');
  ok(!fs.existsSync(mdOf('IT3')), '磁盘上不再有这份 md');
  P.flush();   // manifest 是 1.5s 防抖写，测试里强制落盘再断言
  ok(!JSON.parse(fs.readFileSync(path.join(rootDir, '.eaglenote-manifest.json'), 'utf8')).IT3, '清单条目一并移除');

  /* ===== 9. 有手记的空文档：保壳不删 ===== */
  console.log('\n— 手记保壳 —');
  const data4 = { annotations: [{ id: 'B1', type: 'highlight', page: 1, text: 'x', note: '' }], notes: [] };
  P.writeNow(metaOf('IT4'), data4, false);
  const t4 = fs.readFileSync(mdOf('IT4'), 'utf8');
  fs.writeFileSync(mdOf('IT4'), t4 + '\n## 手记（不会被插件覆盖）\n\n我的私人笔记\n', 'utf8');
  writeMetaDirect('IT4', '');
  P._ec.ecLocalAt.IT4 = Date.now() - 60000;
  r = P.writeNow(metaOf('IT4'), EMPTY(), false);
  ok(r && !r.removed, '有手记 → 不回收');
  ok(fs.existsSync(mdOf('IT4')), '文件保留');
  const t4b = fs.readFileSync(mdOf('IT4'), 'utf8');
  ok(/## 手记（不会被插件覆盖）/.test(t4b) && t4b.indexOf('我的私人笔记') >= 0, '手记内容原样保留');
  ok(t4b.indexOf('这篇还没有摘录或笔记') >= 0, '空壳提示语出现');

  /* ===== 10. 手写的注释区阻止回收并写回 ===== */
  console.log('\n— 注释区手写阻止回收 —');
  const data5 = { annotations: [{ id: 'C1', type: 'highlight', page: 1, text: 'y', note: '' }], notes: [] };
  P.writeNow(metaOf('IT5a'), data5, false);
  const md5 = mdOf('IT5a');
  const t5 = fs.readFileSync(md5, 'utf8').replace(/(<!-- eagle:ec:IT5a -->\s*\n)(\s*)(<!-- \/eagle:ec:IT5a -->)/, '$1我手写的注释\n$3');
  fs.writeFileSync(md5, t5, 'utf8');
  writeMetaDirect('IT5a', '');
  P._ec.ecLocalAt.IT5a = Date.now() - 60000;
  r = P.writeNow(metaOf('IT5a'), EMPTY(), false);
  ok(r && !r.removed, '注释区有手写内容 → 不回收');
  await P.drainEcWrites();
  ok(fake.ctl.written.IT5a === '我手写的注释', '手写注释写回 Eagle');
  ok(fs.readFileSync(md5, 'utf8').indexOf('我手写的注释') >= 0, 'md 里手写注释仍在');

  /* ===== 11. 解析器 ===== */
  console.log('\n— 解析器 —');
  ok(typeof P.hasLiveContent === 'function' && typeof P.eagleApiWrite === 'function' &&
     typeof P.currentEcText === 'function' && typeof P.drainEcWrites === 'function',
    '新导出齐全：hasLiveContent / eagleApiWrite / currentEcText / drainEcWrites');
  const sample = [
    '<!-- eagle:ex:a1 -->摘录段<!-- /eagle:ex:a1 -->',
    '<!-- eagle:nt:n1 -->笔记段<!-- /eagle:nt:n1 -->',
    '<!-- eagle:ec:IT2 -->注释段<!-- /eagle:ec:IT2 -->'
  ].join('\n');
  const bl = P.parseBlocks(sample);
  ok(bl.ex.a1 === '摘录段' && bl.nt.n1 === '笔记段' && bl.ec.IT2 === '注释段', '三种锚点都能解析');

  /* ===== 12. 版本与文档 ===== */
  console.log('\n— 版本与文档 —');
  const vm1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'EaglePDFReader/manifest.json'), 'utf8'));
  const vm2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'EagleNoteWorkbench/manifest.json'), 'utf8'));
  ok(/^\d+\.\d+\.\d+$/.test(vm1.version) && /^\d+\.\d+\.\d+$/.test(vm2.version), '两个插件版本均为合法三段式（版本无关）');
  const readme = fs.readFileSync(path.join(ROOT, 'EaglePDFReader/README.md'), 'utf8');
  /* 版本号每次发版都会变，这里只断言格式正确（不锁死具体数字，免得每次升版都碎） */
  ok(/当前版本 \*\*\d+\.\d+\.\d+\*\*/.test(readme), 'README 当前版本已更新');
  ok(readme.indexOf('### 更新记录 · 3.37.0') >= 0, 'README 有 3.37.0 更新记录');

  /* ---------- 收尾 ---------- */
  console.log('\n========================================');
  console.log('PASS ' + pass + '  FAIL ' + fail);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* windows 偶发占用 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

function writeMetaDirect(id, annotation) {
  const mf = path.join(libPath, 'images', id + '.info', 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
  meta.annotation = annotation;
  fs.writeFileSync(mf, JSON.stringify(meta), 'utf8');
}
