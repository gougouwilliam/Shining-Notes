/* v4.3.4 回归：摘录笔记删光后空壳 md 能正确回收
   ─────────────────────────────────
   Bug：回收守卫只看「注释区有没有文本」——插件自己投影的旧值（hash 与上次
   写入一致）也挡住回收，删光内容后留下一具永远没人再触发的空壳 md。
   修复：ecIsOurs = 无文本 或 hash === 上次写入记录 → 放行回收；
   只有用户手改、md 独有的注释文本才保留（由 ① 合并进队列写回 Eagle）。
   ① 行为沙箱：真实临时文件 + 完整依赖桩，四分支（空 ec / 插件旧值 / 手改值 / 手记）
   ② 静态断言：判据形状 + 版本联动 4.3.4 + README */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const P = R('EaglePDFReader/js/projection.js');
const M1 = JSON.parse(R('EaglePDFReader/manifest.json'));
const M2 = JSON.parse(R('EagleNoteWorkbench/manifest.json'));
const RD = R('EaglePDFReader/README.md');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL - ' + msg); }
}
const has = (s, k) => s.indexOf(k) >= 0;

console.log('—— ① 静态断言 ——');
ok(has(P, 'const ecIsOurs = !ecInFile || (!!ecRec && U.hashKey(ecInFile) === ecRec.w);'), '回收判据：无文本 或 hash 与上次写入一致 → 放行');
ok(has(P, 'if (!hand && !prev.hand && ecIsOurs)'), '手记/手改注释仍然保留（零丢失）');
ok(has(P, '写回 Eagle，内容零丢失，同步完成后下次自然回收'), '注释了「手改值去哪」的取舍');
ok(has(P, 'v4.3.4：旧守卫只看'), '修复留痕注释');

console.log('—— ② 行为沙箱：真实临时文件四分支 ——');
{
  /* 提取回收分支（⓪ 整块），桩掉周边依赖，跑真实 fs */
  const m = /    \(if \(!hasLiveContent[\s\S]*?\)/.test(P) ? null : null;
  const start = P.indexOf('    if (!hasLiveContent(data, currentEcText(id))) {');
  const endMarker = '\n\n    /* ① 写之前先看';
  const end = P.indexOf(endMarker, start);
  ok(start > 0 && end > start, '能定位回收分支');
  if (start > 0 && end > start) {
    const block = P.slice(start, end);
    const factory = new Function('fs', 'pathMod', 'root', 'file', 'prev', 'manifest', 'data', 'id',
      'hasLiveContent', 'currentEcText', 'handOf', 'parseBlocks', 'dropNoise', 'anchorId', 'pruneImages', 'markManifest', 'U',
      'return (function () {\n' + block + '\n  return "FALLTHROUGH";\n})();');
    const H = (s) => crypto.createHash('md5').update(String(s == null ? '' : s)).digest('hex').slice(0, 10);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4340-'));
    const mdPath = path.join(tmpRoot, '书.md');
    const mkEnv = () => {
      const manifest = {};
      let marked = 0, pruned = 0;
      const env = {
        manifest, markedRef: () => marked, prunedRef: () => pruned,
        deps: {
          hasLiveContent: (data) => !data || !data.empty,
          currentEcText: (id) => env.ecText || '',
          handOf: (text) => { const m2 = /^## 手记[ \t]*$/m.exec(text); return m2 ? text.slice(m2.index + m2[0].length).trim() : ''; },
          parseBlocks: (text) => {
            const m3 = /<!-- eagle:ec:([^>]+) -->\n([\s\S]*?)\n<!-- \/eagle:ec/.exec(text);
            const ec = {};
            if (m3) ec[m3[1]] = m3[2];          // 真实锚文本就是条目 id 本身
            return { ec };
          },
          dropNoise: (s) => String(s || '').trim(),
          anchorId: (id2) => id2,               // anchorId(id, 'ec') 真实返回 id
          pruneImages: () => { pruned++; },
          markManifest: () => { marked++; }
        }
      };
      return env;
    };
    const run = (env) => {
      const d = env.deps;
      return factory(fs, path, tmpRoot, mdPath, env.manifest[env.id] || env.prev, env.manifest, env.data, env.id,
        d.hasLiveContent, d.currentEcText, d.handOf, d.parseBlocks, d.dropNoise, d.anchorId, d.pruneImages, d.markManifest,
        { hashKey: H });
    };

    /* 分支1：注释区全空（hash 记录也是空文本）→ 回收 */
    {
      const env = mkEnv();
      env.id = 'IT1';
      env.data = { empty: true };
      env.ecText = '';
      fs.writeFileSync(mdPath, '# 书\n\n<!-- eagle:ec:IT1 -->\n<!-- /eagle:ec:IT1 -->\n', 'utf8');
      env.manifest['IT1'] = { file: '书.md', hand: '', items: { 'ec:IT1': { w: H(''), l: H('') } } };
      const r = run(env);
      ok(r && r.removed === true, '分支1：注释区空 → 回收');
      ok(!fs.existsSync(mdPath), '分支1：文件已删除');
      ok(!env.manifest['IT1'], '分支1：manifest 条目删除');
      ok(env.markedRef() === 1, '分支1：manifest 落盘');
    }

    /* 分支2：注释区是插件上次投影的旧值（hash 与 rec.w 一致）→ 回收（本 bug 的场景） */
    {
      const env = mkEnv();
      env.id = 'IT2';
      env.data = { empty: true };
      env.ecText = '';
      const oldText = '【摘录 · 第 2 页】在 253名入组患者…（插件自己写回的旧总结）';
      fs.writeFileSync(mdPath, '# 书\n\n<!-- eagle:ec:IT2 -->\n' + oldText + '\n<!-- /eagle:ec:IT2 -->\n', 'utf8');
      env.manifest['IT2'] = { file: '书.md', hand: '', items: { 'ec:IT2': { w: H(oldText), l: H(oldText) } } };
      const r = run(env);
      ok(r && r.removed === true, '分支2：注释区为插件旧值（hash 一致）→ 回收（bug 修复点）');
      ok(!fs.existsSync(mdPath), '分支2：空壳文件已删除');
    }

    /* 分支3：注释区是用户手改文本（hash ≠ rec.w）→ 保留，走空壳+队列写回 */
    {
      const env = mkEnv();
      env.id = 'IT3';
      env.data = { empty: true };
      env.ecText = '';
      fs.writeFileSync(mdPath, '# 书\n\n<!-- eagle:ec:IT3 -->\n我在 OB 里手写的一句话\n<!-- /eagle:ec:IT3 -->\n', 'utf8');
      env.manifest['IT3'] = { file: '书.md', hand: '', items: { 'ec:IT3': { w: H('旧投影'), l: H('旧投影') } } };
      const r = run(env);
      ok(r === 'FALLTHROUGH', '分支3：手改注释 hash 不一致 → 不回收');
      ok(fs.existsSync(mdPath), '分支3：文件保留（内容随后进队列写回 Eagle）');
    }

    /* 分支4：有手记 → 保留（手记只存在于 md） */
    {
      const env = mkEnv();
      env.id = 'IT4';
      env.data = { empty: true };
      env.ecText = '';
      fs.writeFileSync(mdPath, '# 书\n\n## 手记\n\n我自己的自由内容', 'utf8');
      env.manifest['IT4'] = { file: '书.md', hand: '', items: {} };
      const r = run(env);
      ok(r === 'FALLTHROUGH', '分支4：有手记 → 不回收');
      ok(fs.existsSync(mdPath), '分支4：文件保留');
    }

    /* 分支5：权威数据还有内容（hasLiveContent true）→ 压根不进回收分支 */
    {
      const env = mkEnv();
      env.id = 'IT5';
      env.data = { empty: false };
      env.ecText = '';
      fs.writeFileSync(mdPath, '# 书', 'utf8');
      env.manifest['IT5'] = { file: '书.md', items: {} };
      const r = run(env);
      ok(r === 'FALLTHROUGH' && fs.existsSync(mdPath), '分支5：还有摘录/笔记/注释 → 不进回收逻辑');
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

console.log('—— ③ 版本联动 + README ——');
ok(M1.version === '4.3.4' && M2.version === '4.3.4', '双插件版本号一致 4.3.4');
ok(/^\d+\.\d+\.\d+$/.test(M1.version), '版本三段式');
ok(has(RD, '当前版本 **4.3.4**'), 'README 当前版本已更新');
ok(has(RD, '更新记录 · 4.3.4'), 'README 更新记录存在');

console.log('\n====');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
