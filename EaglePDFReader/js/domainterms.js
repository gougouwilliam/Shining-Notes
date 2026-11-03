/* domainterms.js —— 专业领域词表（v3.30）
 *
 * 为什么需要它：
 *   语音识别错专业词，几乎都不是「听不清」，而是「通用语料里另一个词更常见」。
 *   「胆囊三角」被听成「单囊三角」、「脾动脉」被听成「皮动脉」，
 *   声学上完全说得通 —— 解码器只是选了概率更高的常见词。
 *
 *   两处地方能用上这份词表：
 *     ① 热词偏置（asr.js 的 hotwordsFile）：识别时给这些词加分；
 *     ② 语境校对（subtitle.js 的 ctxPrompt）：交给本地大模型时，
 *        明确「这些写法才算对」，并给几条常见听错做示例。
 *
 *   词表内置，不需要用户先自己敲一遍术语；用户自己的术语表（划词翻译那张）
 *   仍然优先，两者会合并。
 *
 * 纯数据 + 纯函数，node 里可直接 require，见 test-v330.js。 */
const DomainTerms = (function () {
  'use strict';

  /* 医学（以外科 / 影像 / 病理为主，覆盖「手术录像 + 课件」这类视频里最常出现的词） */
  const MEDICAL = [
    /* 解剖 */
    '胰腺', '胰头', '胰颈', '胰体', '胰尾', '胰体尾', '钩突', '脾脏', '脾门', '副脾',
    '脾动脉', '脾静脉', '脾蒂', '胃', '胃窦', '胃体', '幽门', '十二指肠', '空肠', '回肠',
    '结肠', '横结肠', '系膜', '肠系膜', '肠系膜上动脉', '肠系膜上静脉', '肠系膜下动脉',
    '腹腔干', '肝总动脉', '肝固有动脉', '胃十二指肠动脉', '胃右动脉', '胃网膜右动脉',
    '门静脉', '肠系膜上静脉', '脾静脉汇合处', '腹主动脉', '下腔静脉', '肾静脉', '左肾静脉',
    '腹膜后', '肾前筋膜', 'Gerota筋膜', '肾周筋膜', '横结肠系膜', '结肠中动脉',
    '胆囊', '胆囊三角', '胆囊动脉', '胆总管', '肝总管', '肝门', '胆道', '壶腹部',
    '肝脏', '左半肝', '右半肝', '肝段', '膈肌', '食管裂孔', '腹壁', '脐', '穿刺孔',
    /* 手术与器械 */
    '腹腔镜', '开腹', '机器人手术', '气腹', '穿刺器', '套管针', 'Trocar', '超声刀',
    '电凝钩', '双极电凝', '结扎束', '血管夹', '钛夹', '生物夹', 'hem-o-lok',
    '切割吻合器', '吻合器', '直线切割闭合器', '缝线', '可吸收线', '引流管', '负压引流',
    '吸引器', '冲洗', '止血', '缝合', '结扎', '剥离', '解剖', '游离', '翻起', '悬吊',
    '显露', '间隙', '层面', '入路', '术野', '牵开器', '标本', '术中冰冻', '术中超声',
    /* 术式 */
    '胰十二指肠切除术', '胰体尾切除术', '保留脾脏', '保脾手术', '脾切除术', '淋巴结清扫',
    '根治性切除', '姑息性手术', '胆肠吻合', '胰胃吻合', '胰肠吻合', 'Roux-en-Y',
    'Whipple手术', '全胰切除', '中段胰腺切除', '剜除术', '囊壁切除',
    /* 病理与影像 */
    '病理', '良性', '恶性', '肿瘤', '囊腺瘤', '导管腺癌', '神经内分泌肿瘤', '实性假乳头状瘤',
    '浸润', '转移', '切缘', '阴性', '阳性', '免疫组化', '苏木精-伊红', '冰冻切片',
    '增强CT', '磁共振', '磁共振胰胆管成像', '超声内镜', '血管造影', '三维重建',
    '主胰管', '囊性病变', '钙化', '强化', '占位',
    /* 围手术期 */
    '麻醉', '全身麻醉', '气管插管', '生命体征', '血压', '心率', '血氧饱和度', '中心静脉压',
    '失血', '输血', '补液', '抗生素', '围手术期', '术后', '并发症', '胰瘘', '吻合口漏',
    '出血', '感染', '腹腔感染', '胃排空延迟', '肠梗阻', '血栓', '再手术',
    /* 生理与病理生理 */
    '缺血', '再灌注', '缺血再灌注损伤', '血供', '微循环', '炎症', '水肿', '渗出',
    '内环境', '代谢', '电解质', '酸碱平衡',
  ];

  /* 生命科学（细胞 / 分子 / 组学 / 实验方法） */
  const LIFE = [
    '细胞', '细胞膜', '细胞质', '细胞核', '核膜', '核仁', '线粒体', '内质网', '高尔基体',
    '溶酶体', '核糖体', '细胞骨架', '微管', '微丝', '中心体', '细胞周期', '有丝分裂',
    '减数分裂', '细胞凋亡', '细胞自噬', '坏死', '细胞衰老', '细胞迁移', '细胞侵袭',
    '干细胞', '胚胎干细胞', '诱导多能干细胞', '类器官', '原代细胞', '细胞系', '传代',
    '培养基', '血清', '转染', '质粒', '载体', '启动子', '增强子', '操纵子',
    'DNA', 'RNA', '信使RNA', '非编码RNA', '微小RNA', '基因组', '外显子', '内含子',
    '转录', '翻译', '逆转录', '复制', '突变', '缺失', '插入', '单核苷酸多态性',
    '基因表达', '基因沉默', '基因敲除', '基因敲入', '基因编辑', 'CRISPR',
    '聚合酶链反应', '实时定量PCR', '引物', '探针', '凝胶电泳', '测序', '单细胞测序',
    '转录组', '蛋白质组', '代谢组', '生物信息学', '差异表达', '富集分析', '通路分析',
    '蛋白质', '多肽', '氨基酸', '酶', '底物', '抑制剂', '激动剂', '抗体', '抗原',
    '表位', '单克隆抗体', '多克隆抗体', '免疫印迹', '免疫荧光', '免疫组化', '流式细胞术',
    '酶联免疫吸附', '亲和力', '受体', '配体', '信号通路', '磷酸化', '去磷酸化',
    '甲基化', '乙酰化', '泛素化', '转录因子', '第二信使', '级联反应',
    '小鼠模型', '敲除小鼠', '转基因小鼠', '斑马鱼', '线虫', '果蝇', '酵母双杂交',
    '冷冻电镜', '晶体结构', '共聚焦显微镜', '荧光共振能量转移',
  ];

  /* 常见听错 → 正确写法。
     这些不是「词典」，是**给校对模型看的示例**：让它明白「只改音近的错字，
     不改写句子」，比只说一句「请改正错别字」有效得多。 */
  const MISHEAR = [
    ['单囊三角', '胆囊三角'],
    ['胆囊三脚', '胆囊三角'],
    ['皮脏', '脾脏'],
    ['皮动脉', '脾动脉'],
    ['皮静脉', '脾静脉'],
    ['皮切除', '脾切除'],
    ['一腺', '胰腺'],
    ['遗体尾', '胰体尾'],
    ['遗头', '胰头'],
    ['遗瘘', '胰瘘'],
    ['十二支肠', '十二指肠'],
    ['门筋脉', '门静脉'],
    ['腹主动脉', '腹主动脉'],
    ['下腔筋脉', '下腔静脉'],
    ['覆膜后', '腹膜后'],
    ['淋巴洁清扫', '淋巴结清扫'],
    ['超生刀', '超声刀'],
    ['电宁钩', '电凝钩'],
    ['气复', '气腹'],
    ['腹腔境', '腹腔镜'],
    ['缺血在灌注', '缺血再灌注'],
    ['血氧饱合度', '血氧饱和度'],
    ['免疫组画', '免疫组化'],
    ['苏木精一红', '苏木精-伊红'],
    ['聚合酶链反映', '聚合酶链反应'],
    ['你转录', '逆转录'],
    ['单克隆抗休', '单克隆抗体'],
    ['流式细胞数', '流式细胞术'],
    ['线立体', '线粒体'],
    ['内制网', '内质网'],
    ['高尔基氏体', '高尔基体'],
    ['细胞吊亡', '细胞凋亡'],
    ['基因边辑', '基因编辑'],
  ];

  const DOMAINS = {
    general: { id: 'general', name: '通用', terms: [], mishears: [] },
    medical: { id: 'medical', name: '医学', terms: MEDICAL, mishears: MISHEAR },
    life: { id: 'life', name: '生命科学', terms: LIFE, mishears: [] },
  };

  const ALL_IDS = ['general', 'medical', 'life'];

  /* 'medical+life' 这种组合值也认，方便界面上一个下拉搞定 */
  function ids(spec) {
    const raw = String(spec == null ? '' : spec).trim();
    if (!raw || raw === 'general') return [];
    return raw.split('+').map((s) => s.trim()).filter((s) => s && s !== 'general' && DOMAINS[s]);
  }

  function normalize(spec) {
    const list = ids(spec);
    if (!list.length) return 'general';
    return list.join('+');
  }

  function label(spec) {
    const list = ids(spec);
    if (!list.length) return '通用';
    return list.map((id) => DOMAINS[id].name).join(' + ');
  }

  function terms(spec) {
    const out = [];
    const seen = Object.create(null);
    ids(spec).forEach((id) => {
      DOMAINS[id].terms.forEach((t) => {
        if (!seen[t]) { seen[t] = 1; out.push(t); }
      });
    });
    return out;
  }

  function mishears(spec) {
    const out = [];
    const seen = Object.create(null);
    ids(spec).forEach((id) => {
      DOMAINS[id].mishears.forEach((p) => {
        if (!seen[p[0]]) { seen[p[0]] = 1; out.push(p); }
      });
    });
    return out;
  }

  /* 两个字符串的最长公共子串长度（词都很短，O(n·m) 足够） */
  function lcs(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (!s || !t) return 0;
    let best = 0;
    let prev = new Array(t.length + 1).fill(0);
    for (let i = 1; i <= s.length; i++) {
      const cur = new Array(t.length + 1).fill(0);
      for (let j = 1; j <= t.length; j++) {
        if (s[i - 1] === t[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  /* 挑「跟这一句最像」的术语。
     为什么不整表塞给模型：一句话配 200 个术语，小模型会开始往句子里硬塞词。
     命中/近似的排在前面，取前 limit 条。 */
  function nearby(text, spec, limit) {
    const all = terms(spec);
    if (!all.length) return [];
    const t = String(text || '');
    const max = limit || 36;
    const scored = [];
    for (let i = 0; i < all.length; i++) {
      const w = all[i];
      let score = 0;
      if (t.indexOf(w) >= 0) score = 100 + w.length;
      else score = lcs(w, t);
      if (score >= 2) scored.push([score, w]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
    return scored.slice(0, max).map((x) => x[1]);
  }

  /* 给校对模型的那段说明文字。空领域返回 ''，调用方直接拼接即可。 */
  function promptBlock(spec, text) {
    const list = nearby(text || '', spec, 36);
    if (!list.length) return '';
    const pairs = mishears(spec).slice(0, 10);
    let out = '这是「' + label(spec) + '」领域的视频，专业词以这些写法为准：\n'
      + list.join('、');
    if (pairs.length) {
      out += '\n\n常见听错（左边是错听，右边才是正确写法）：\n'
        + pairs.map((p) => p[0] + ' → ' + p[1]).join('\n');
    }
    return out;
  }

  const mod = {
    MEDICAL, LIFE, MISHEAR, DOMAINS, ALL_IDS,
    ids, normalize, label, terms, mishears, nearby, promptBlock, lcs,
  };
  try { if (typeof module !== 'undefined' && module.exports) module.exports = mod; } catch (e) { /* ignore */ }
  try { window.DomainTerms = mod; } catch (e) { /* ignore */ }
  return mod;
})();
