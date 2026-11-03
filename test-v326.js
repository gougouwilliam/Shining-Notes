/* v3.26 回归：视频字幕语义断句 + 译文按句重排 + 视频模式左栏加宽
 *
 * 覆盖三块：
 *   1. SentBreak 纯函数（断句点识别、缩写/小数点保护、宽段落拆分、译文对齐）
 *   2. subtitle.js 接线（落定后才翻、拆行时下标重排、译文质量闸门）
 *   3. 布局（视频模式左右两栏同宽）
 *
 * 运行：node test-v326.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  \u2717 ' + msg);
}

const S = require('./EaglePDFReader/js/sentbreak.js');

/* ───────────────────────── 1. 断句纯函数 ───────────────────────── */

console.log('\n[1] SentBreak.weight：中英混排用同一把尺子');
(() => {
  ok(S.weight('abc') === 3, '三个西文字符 = 3');
  ok(S.weight('你好') === 4, '两个汉字 = 4（一个汉字算两个西文字符）');
  ok(S.weight('') === 0 && S.weight(null) === 0, '空值 = 0');
  ok(S.weight('a b') === 2.5, '空格按半个字符算');
  ok(S.weight('a你b') === 4, '混排 1 + 2 + 1 = 4');
})();

console.log('\n[2] SentBreak.cuts：句末标点 / 缩写 / 小数点');
(() => {
  /* 末尾那句的句号之后没有内容，不算「切点」（切出来是个空尾巴） */
  const en = 'One thing. Two things! Three?';
  ok(S.cuts(en).length === 2, '英文三句 → 2 个内部切点');
  ok(S.cuts('One. Two. Three. Four.').length === 3, '四个句子 → 3 个内部切点');

  const abbr = 'We met Dr. Smith at 3.5 p.m. yesterday. Then we left.';
  const cs = S.cuts(abbr);
  ok(cs.length === 1, 'Dr. / p.m. / 3.5 都不算句末，只切出 1 处');
  ok(abbr.slice(0, cs[0]).trim() === 'We met Dr. Smith at 3.5 p.m. yesterday.',
    '切点落在真正的句号之后（缩写没有把句子切开）');

  const us = 'He lives in the U.S. now. And he likes it.';
  ok(S.cuts(us).length === 1, 'U.S. 内部点不切');

  const quoted = 'He said “this is fine.” Then he left.';
  ok(S.cuts(quoted).length === 1, '引号收在句号后 → 切点仍在句号之后（只 1 处内部切点）');
  const first = quoted.slice(0, S.cuts(quoted)[0]);
  ok(/fine\.”$/.test(first), '第一段完整带上右引号');

  const zh = '第一句。第二句！第三句？第四句。';
  ok(S.cuts(zh).length === 3, '中文句末标点 → 3 个内部切点');
  ok(S.cuts('没有标点的一句话').length === 0, '没有标点 → 没有切点');
})();

console.log('\n[3] SentBreak.plan：长段拆句，短段不动');
(() => {
  const short = '这只是一句很短的话。';
  const p1 = S.plan(short);
  ok(p1.length === 1 && p1[0] === short, '短句原样返回（不制造碎行）');

  const long = 'This is the first sentence of a rather long subtitle. '
    + 'And here comes the second one, which is also fairly long. '
    + 'Finally the third.';
  const p2 = S.plan(long);
  ok(p2.length >= 2, '长段被拆成多条');
  ok(p2[0] === 'This is the first sentence of a rather long subtitle.', '第一句单独成条');
  p2.forEach((x, i) => ok(x.trim() === x, '第 ' + (i + 1) + ' 条没有多余空白'));
  p2.forEach((x) => ok(x.length > 0, '拆出来没有空条目'));
  const joined = p2.join(' ');
  ok(joined.replace(/\s+/g, ' ').trim() === long.replace(/\s+/g, ' ').trim(),
    '拆完拼回去和原文一致（没有丢字、没有多字）');

  const zhLong = '我们今天讲的是胆囊三角的解剖结构，它由胆囊管、肝总管和肝脏下缘共同围成，'
    + '是胆囊手术中非常重要的解剖标志，需要格外注意。';
  const p3 = S.plan(zhLong);
  ok(p3.length === 2, '一长句按逗号退让成两条');
  ok(p3.every((x) => S.weight(x) <= 74 + 0.001), '每条都不超过宽度上限');

  const noPunct = 'and then he said something that went on and on without any punctuation at all '
    + 'so the segmentation has to fall back to spaces and length limits here';
  const p4 = S.plan(noPunct);
  ok(p4.length >= 2, '没有句末标点时按空格 / 长度退让');
  ok(p4.every((x) => S.weight(x) <= 74 + 0.001), '退让之后也不超宽');
  ok(p4.every((x) => /^[a-z]/i.test(x)), '没有切出以空格开头的残行');
})();

console.log('\n[4] SentBreak.tidy：碎片合并但不超宽');
(() => {
  const parts = S.tidy(['这是一个正常长度的句子大概三十多个字符左右在这里', '是的。'], 74);
  ok(parts.length === 1, '短尾巴并回上一条');
  ok(S.weight(parts[0]) <= 74, '合并后仍在宽度上限内');

  const wide = ['A rather long line that already fills most of the width available', 'Ok.'];
  const t = S.tidy(wide, 60);
  ok(t.length === 2, '合并会超宽时就不合并');
})();

console.log('\n[5] SentBreak.splitZh：译文按比例对到每一段');
(() => {
  const r = S.splitZh('这是第一句。这是第二句，还挺长的。这是第三句。', [40, 50, 40]);
  ok(r.length === 3, '拆成 3 段');
  ok(r[0] === '这是第一句。', '第一段落在第一个句号后');
  ok(r.every((x) => x.length > 0), '每段都有内容');
  ok(r.join('') === '这是第一句。这是第二句，还挺长的。这是第三句。', '拼回去不丢字');

  const noP = S.splitZh('没有标点的一段译文需要按比例切开才能对齐原文的每一句', [40, 50, 40]);
  ok(noP.length === 3, '没有标点也能按比例切');
  ok(noP.every((x) => x.length > 0), '按比例切也不产生空段');

  ok(S.splitZh('只有一句', [1]).length === 1, '只有一段时不拆');
  ok(S.splitZh('', [1, 2]).length === 1, '空译文返回空串，调用方按 0 处理');
})();

/* ───────────────────────── 2. subtitle.js 接线 ───────────────────────── */

console.log('\n[6] subtitle.js：文本落定 → 断句 → 逐条翻译');
(() => {
  const src = read('EaglePDFReader/js/subtitle.js');

  ok(src.indexOf('SentBreak.plan') > -1, '接入了 SentBreak.plan');
  ok(src.indexOf('function resplit(') > -1, '有 resplit：把一条拆成几条');
  ok(src.indexOf('function finalize(') > -1, '有 finalize：断句 + 翻译的统一出口');
  ok(src.indexOf('function afterFix(') > -1, '精修后统一走 afterFix');
  ok(!/if \(lang === 'en'\) enqueue\(idx\);/.test(src),
    'commit 不再先翻后修（避免翻的是错字）');
  ok(src.indexOf('function queueRow(') > -1, '有 queueRow：入队只看精修在不在跑');
  ok(/const n = resplit\(i\);/.test(src), 'finalize 里先断句再翻');
  ok(/ctxEnabled\(\) && ctxAvailable\(\)/.test(src), '语境层不可用时直接收口，不会卡住不翻');
  ok(/setBreakOn|breakOn/.test(src), '断句有开关（默认开）');
  ok(/last\.spl = 0/.test(src), '合并出新文本后允许重新断句');
})();

console.log('\n[7] subtitle.js：译文质量闸门与上下文');
(() => {
  const src = read('EaglePDFReader/js/subtitle.js');
  ok(src.indexOf('function zhOk(') > -1, '有 zhOk：译文合格性检查');
  ok(/if \(zhOk\(row\.text, zh\)\)/.test(src), '不合格的译文不落到字幕上');
  ok(src.indexOf('function transContext(') > -1, '有 transContext：前后几句当语境');
  ok(/context: ctx/.test(src), '翻译时把语境传给引擎');
  ok(/source: 'en'/.test(src), '标明源语言（MyMemory 那条链路需要）');
})();

console.log('\n[8] 沙箱：一条长字幕真的被拆成多条，索引与时间都跟着走');
(() => {
  const src = read('EaglePDFReader/js/subtitle.js');
  const store = new Map();
  const fakeDoc = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        addEventListener() {},
        replaceWith() {}
      };
    },
    addEventListener() {}
  };
  const fakeWin = { addEventListener() {}, localStorage: null };
  const fakeAsr = {
    status: () => ({ engine: 'ready', model: 'ready' }),
    refineProbe: () => ({ ready: false }),
    tidyCase: (t) => t,
    langOf: () => 'en',
    pcmRead: () => null,
    refineAsync: async () => null,
    get rootDir() { return ''; }
  };
  const calls = [];
  const fakeTr = {
    translate: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true, text: '译：' + text, provider: 'mock' };
    },
    looksUntranslated: (t) => /^[A-Za-z\s.]+$/.test(String(t)),
    complete: async () => null,
    pickGlossary: () => []
  };
  const fakeU = { toast() {}, el: () => fakeDoc.createElement() };

  const sub = new Function('document', 'window', 'localStorage', 'Asr', 'Translator', 'U', 'SentBreak', 'VideoView',
    src + '\nreturn Subtitle;')(fakeDoc, fakeWin, {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }, fakeAsr, fakeTr, fakeU, S, undefined);

  sub._loadRows([
    {
      t: 10, t1: 20, lang: 'en', fix: 1, ctx: 1,
      text: 'This is the first sentence of a rather long subtitle. '
        + 'And here comes the second one, which is also fairly long.'
    },
    { t: 20, t1: 24, lang: 'en', fix: 1, ctx: 1, text: 'A short one.' }
  ]);

  const n = sub._resplit(0);
  const rows = sub.rows();
  ok(n >= 2, '长条被拆成 ' + n + ' 条');
  ok(rows.length === n + 1, '总数 = 拆出的条数 + 原本剩余的一条');
  ok(rows[0].t === 10, '第一条起点还是原来的起点');
  ok(Math.abs(rows[n - 1].t1 - 20) < 0.01, '最后一条终点还是原来的终点（时间轴没被拉长）');
  ok(rows[1].t >= rows[0].t1 - 0.01, '拆出来的时间不重叠');
  ok(rows.every((r) => r.text.trim() === r.text), '拆出来的文本没有多余空白');
  ok(rows.every((r) => r.lang === 'en'), '语言标记跟着拆');
  ok(sub.rows()[n].text === 'A short one.', '后面那条没有被挤掉');
})();

console.log('\n[9] 沙箱：finalize 会为每一条排一次翻译，且带上语境');
(() => {
  const src = read('EaglePDFReader/js/subtitle.js');
  const store = new Map();
  const fakeDoc = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, dataset: {}, classList: { add() {}, toggle() {} }, appendChild() {}, addEventListener() {}, replaceWith() {} }; },
    addEventListener() {}
  };
  const fakeAsr = {
    status: () => ({ engine: 'ready', model: 'ready' }),
    refineProbe: () => ({ ready: false }),
    tidyCase: (t) => t, langOf: () => 'en', pcmRead: () => null,
    refineAsync: async () => null,
    get rootDir() { return ''; }
  };
  const calls = [];
  const fakeTr = {
    translate: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true, text: '这是一句译文内容足够长', provider: 'mock' };
    },
    looksUntranslated: () => false,
    complete: async () => null,
    pickGlossary: () => []
  };
  const sub = new Function('document', 'window', 'localStorage', 'Asr', 'Translator', 'U', 'SentBreak', 'VideoView',
    src + '\nreturn Subtitle;')(fakeDoc, {}, {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }, fakeAsr, fakeTr, { toast() {} }, S, undefined);

  sub._loadRows([
    { t: 0, t1: 3, lang: 'en', fix: 1, ctx: 1, text: 'First line here.' },
    { t: 3, t1: 9, lang: 'en', fix: 1, ctx: 0,
      text: 'This is the second line and it is long enough to be split into two separate rows.' }
  ]);
  sub._finalize(1);

  setTimeout(() => {
    ok(calls.length >= 1, '至少发出一次翻译请求');
    const last = calls[calls.length - 1];
    ok(!!last.opts && last.opts.target === 'zh', '目标语言是中文');
    ok(!!last.opts && typeof last.opts.context === 'string' && last.opts.context.length > 0,
      '翻译带上了前后文语境');
    ok(!!last.opts && last.opts.context.indexOf('First line here.') > -1,
      '语境里确实有上一条原文');
    ok(sub._zhOk('This is a sentence.', '这是半句译文') === true, '正常译文通过检查');
    ok(sub._zhOk('This is a sentence.', 'This is a sentence.') === false,
      '原样回显（没翻）被判为不合格');
    ok(sub._zhOk('Hello.', '这是一个明显过长而且完全不像译文的句子被模型自己发挥出来的东西' ) === false,
      '长度比例离谱的被判为不合格');

    console.log('\n────────────────────────────────');
    console.log(`  PASS ${pass}   FAIL ${fail}`);
    console.log('────────────────────────────────');
    process.exit(fail ? 1 : 0);
  }, 120);
})();
