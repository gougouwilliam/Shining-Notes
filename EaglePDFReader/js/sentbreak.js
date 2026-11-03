/* 语义断句（v3.26）

   问题：实时字幕「一条」的长度由端点检测决定，不是由语义决定。
   换气停 1.9 秒才断，中间还允许把两条并起来（上限 110 字），
   于是一条字幕经常是「三句话连着说」—— 屏幕上是一大段，读起来很费力，
   翻译引擎也只能整段硬翻，句子之间的关系被抹平。

   解决：文本落定之后（精修 / 语境都跑完），按标点把一条拆成几句。
     · **不需要额外的模型**。句读来自已经在跑的精修模型（SenseVoice 自带标点）；
       精修没装时退回「逗号 / 空格」这类弱边界，也能拆，只是不如标点准。
     · 拆出来的每一条各自参与翻译，句子短了，译文也跟着准。

   为什么放在「文本落定之后」而不是流式阶段：流式还没有标点，那时候拆只能按长度硬切，
   等于把一句话从中间劈开 —— 比不拆更难看。

   这个文件只做字符串运算，不碰 DOM，便于单独测。 */
const SentBreak = (function () {
  /* 视觉宽度：一个汉字占两个西文字符的宽度。
     用宽度而不是字符数，中英混排才能用同一个阈值。 */
  const RE_CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

  function weight(s) {
    const str = String(s == null ? '' : s);
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (RE_CJK.test(ch)) w += 2;
      else if (ch === ' ' || ch === '\t') w += 0.5;
      else w += 1;
    }
    return w;
  }

  /* 句末标点后面可能还缀着引号 / 右括号 —— 切点必须在它们之后，
     否则会切出一段以「”」开头的残句 */
  const RE_CLOSE = /["'”’）)\]】》」』]/;

  /* 英文里这些点不是句号：缩写、缩写化头衔、常见拉丁缩写。
     不排除的话 "Dr. Smith" 会被切成两条。 */
  const RE_ABBR = /(?:^|[\s(“‘(\[])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|fig|figs|al|inc|ltd|co|corp|dept|est|approx|no|nos|vol|pp|cf|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m|b\.c|a\.d)\.$/i;

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  /* 找出「可以断句」的位置（切点下标，切在该位置之前） */
  function cuts(src) {
    const s = String(src || '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if ('。！？!?…；;'.indexOf(ch) >= 0) {
        let j = i + 1;
        while (j < s.length && RE_CLOSE.test(s[j])) j++;
        out.push(j);
        i = j - 1;
        continue;
      }
      if (ch === '.' || ch === '．') {
        /* 小数点、版本号、时间（3.5 / v1.2）都不算 */
        if (isDigit(s[i - 1]) && isDigit(s[i + 1])) continue;
        if (isDigit(s[i - 1]) && (s[i + 1] === ' ' || !s[i + 1])) {
          /* "第 3." 这种不常见，按缩写处理更安全 */
        }
        const head = s.slice(Math.max(0, i - 24), i + 1);
        if (RE_ABBR.test(head)) continue;
        /* 点后面可能是右引号 / 右括号，再后面才是空白 —— 先跳过收尾符号，
           再要求「空白或结束」，否则是 www.foo.com / U.S.A 这种内部点。 */
        let j = i + 1;
        while (j < s.length && RE_CLOSE.test(s[j])) j++;
        const after = s[j];
        if (after == null || /\s/.test(after)) {
          out.push(j);
          i = j - 1;
        }
      }
    }
    return out.filter((c) => c > 0 && c < s.length);
  }

  /* 从句切点：句子本身还是太长时用它退一级。
     顿号不算 —— 「苹果、香蕉、梨」切开会更碎。 */
  function clauseCuts(src) {
    const s = String(src || '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if ('，,：:、'.indexOf(ch) >= 0) {
        let j = i + 1;
        while (j < s.length && RE_CLOSE.test(s[j])) j++;
        out.push(j);
        i = j - 1;
        continue;
      }
      /* 英文的并列/转折连词前空格也是一个自然断点（He said | that ...） */
      if (ch === ' ') {
        const rest = s.slice(i + 1, i + 12);
        if (/^(?:and|but|so|because|which|while|then|however|although|though|yet|or)\b/i.test(rest)) {
          out.push(i + 1);
        }
      }
    }
    return out.filter((c) => c > 0 && c < s.length);
  }

  /* 最粗暴的一级：按宽度硬切。中文按字，英文尽量落在空格上。 */
  function hardCuts(src, max) {
    const s = String(src || '');
    const out = [];
    let acc = 0;
    let lastSpace = -1;
    for (let i = 0; i < s.length; i++) {
      acc += weight(s[i]);
      if (s[i] === ' ') lastSpace = i;
      if (acc >= max) {
        let at = i + 1;
        if (!RE_CJK.test(s[i]) && lastSpace > 0 && lastSpace > i - 24) at = lastSpace + 1;
        out.push(at);
        acc = 0;
        lastSpace = -1;
        i = at - 1;
      }
    }
    return out.filter((c) => c > 0 && c < s.length);
  }

  /* 一句一条：有句末标点时按句子走，不再贪心地把两句挤进一行。
     一行一句是字幕的常规做法 —— 读起来有停顿，翻译也按句走。 */
  function onePerSentence(src, ats, max) {
    const s = String(src || '');
    const pieces = [];
    let prev = 0;
    (ats || []).forEach((c) => {
      if (c > prev) { pieces.push(s.slice(prev, c)); prev = c; }
    });
    if (prev < s.length) pieces.push(s.slice(prev));

    const rows = [];
    pieces.forEach((p) => {
      const t = String(p || '').trim();
      if (!t) return;
      if (weight(t) <= max) { rows.push(t); return; }
      assembleHard(t, clauseCuts(t), max).forEach((x) => { if (x) rows.push(x); });
    });
    return rows;
  }

  /* 按给定切点切片，再把碎片攒进「不超过 max 宽」的行里。
     用于「没有句末标点」的那一路：只能按从句边界攒，攒满一条再开下一条。 */
  function assemble(src, ats, max) {
    const s = String(src || '');
    const pieces = [];
    let prev = 0;
    ats.forEach((c) => {
      if (c > prev) { pieces.push(s.slice(prev, c)); prev = c; }
    });
    if (prev < s.length) pieces.push(s.slice(prev));

    const rows = [];
    let buf = '';
    const flush = () => { const t = buf.trim(); if (t) rows.push(t); buf = ''; };
    pieces.forEach((p) => {
      if (!p) return;
      if (weight(buf + p) <= max) { buf += p; return; }
      if (buf) flush();
      if (weight(p) <= max) { buf = p; return; }
      /* 单块仍然超长 → 先从句，再从长度退让 */
      let sub = clauseCuts(p);
      let parts = assembleHard(p, sub, max);
      if (!parts.length) parts = [p.trim()];
      parts.forEach((x) => { if (x) rows.push(x); });
    });
    flush();
    return rows;
  }

  /* 二级：把一块按从句切点切，切完还超宽的再硬切 */
  function assembleHard(src, ats, max) {
    const s = String(src || '');
    const pieces = [];
    let prev = 0;
    (ats || []).forEach((c) => {
      if (c > prev) { pieces.push(s.slice(prev, c)); prev = c; }
    });
    if (prev < s.length) pieces.push(s.slice(prev));

    const rows = [];
    let buf = '';
    const flush = () => { const t = buf.trim(); if (t) rows.push(t); buf = ''; };
    pieces.forEach((p) => {
      if (!p) return;
      if (weight(buf + p) <= max) { buf += p; return; }
      if (buf) flush();
      if (weight(p) <= max) { buf = p; return; }
      /* 还没有标点的长句：只能按宽度硬切 */
      const hs = hardCuts(p, max);
      let last = 0;
      hs.forEach((c) => { rows.push(p.slice(last, c).trim()); last = c; });
      if (last < p.length) buf = p.slice(last);
    });
    flush();
    return rows.filter(Boolean);
  }

  /* 拼接两条：西文之间补一个空格，中文侧不补 —— 否则会出现 "long.Finally" */
  function glue(a, b) {
    const x = String(a == null ? '' : a);
    const y = String(b == null ? '' : b);
    if (!x) return y;
    if (!y) return x;
    const last = x[x.length - 1];
    const first = y[0];
    if (/\s/.test(last) || /\s/.test(first)) return x + y;
    if (RE_CJK.test(last) || RE_CJK.test(first)) return x + y;
    if (/[”’")\]]/.test(last)) return x + ' ' + y;
    if (/[“‘"(\[]/.test(first)) return x + ' ' + y;
    return x + ' ' + y;
  }

  /* 太短的碎片并回邻条：单条只有几个字（"是的。" / "OK."）会让列表变得毛躁。
     合并上限就是 max —— 为了消灭碎片而造出一条超宽的字幕，等于把问题换了个样子。 */
  function tidy(parts, max, minW) {
    const min = minW == null ? max * 0.34 : minW;
    const out = [];
    parts.forEach((p) => {
      const t = String(p || '').trim();
      if (!t) return;
      if (out.length && weight(t) < min && weight(glue(out[out.length - 1], t)) <= max) {
        out[out.length - 1] = glue(out[out.length - 1], t);
        return;
      }
      out.push(t);
    });
    /* 反向一遍：处理「短碎片 + 长句」，短的在前面时并进后一条 */
    for (let i = 0; i + 1 < out.length; i++) {
      if (weight(out[i]) < min && weight(glue(out[i], out[i + 1])) <= max) {
        out[i + 1] = glue(out[i], out[i + 1]);
        out.splice(i, 1);
        i--;
      }
    }
    return out;
  }

  /* 主入口：返回拆好的句子数组。
     不需要拆时返回 [原文]，长度 1，调用方据此判断「没变化」。 */
  function plan(text, opts) {
    const o = opts || {};
    const max = o.max || 74;                 // 约 37 个汉字 / 74 个西文字符
    const src = String(text == null ? '' : text).trim();
    if (!src) return [];
    if (weight(src) <= max) return [src];

    const sCuts = cuts(src);
    let parts = sCuts.length
      ? onePerSentence(src, sCuts, max)
      : assemble(src, clauseCuts(src), max);
    /* 拆完只剩一条 = 没拆成（比如整段一个标点都没有），退到硬切 */
    if (parts.length <= 1) parts = assembleHard(src, clauseCuts(src), max);
    parts = tidy(parts, max, o.min);
    if (parts.length <= 1) return [src];
    return parts;
  }

  /* 已有译文要跟着拆：按各段原文的宽度比例，在译文里找最近的句读点对齐。
     找不到句读点就按位置硬切 —— 半句译文也好过把整段中文堆在第一行。 */
  function splitZh(zh, ratios) {
    const s = String(zh == null ? '' : zh).trim();
    const n = (ratios || []).length;
    if (!s || n <= 1) return [s];
    let total = 0;
    ratios.forEach((r) => { total += r; });
    if (total <= 0) total = n;

    const cs = cuts(s);
    const used = Object.create(null);
    const out = [];
    let acc = 0;
    let prev = 0;
    for (let i = 0; i < n - 1; i++) {
      acc += ratios[i];
      const target = s.length * (acc / total);
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k];
        if (used[c] || c <= prev) continue;
        const d = Math.abs(c - target);
        if (d < bestD) { bestD = d; best = c; }
      }
      let at = best;
      /* 最近的句读点离目标太远（这段译文本身没有标点）→ 按位置切 */
      if (at < 0 || bestD > s.length / (n * 1.4)) at = Math.round(target);
      if (at <= prev) at = prev + 1;
      if (at >= s.length) at = s.length;
      used[at] = 1;
      out.push(s.slice(prev, at).trim());
      prev = at;
    }
    out.push(s.slice(prev).trim());
    return out;
  }

  const mod = { weight, cuts, clauseCuts, plan, splitZh, tidy, onePerSentence };

  try { if (typeof window !== 'undefined') window.SentBreak = mod; } catch (e) { /* ignore */ }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  return mod;
})();
