// 规则版判断引擎（全手机本地，不联网）：文字规整 → 六维规则 → 套路库匹配 → 拼报告。
//
// 依据《路线调整令》第二、三节，全部是确定性计算：同一段文字每次结果完全一样。
// 规则数据来自 ruleKeywords.js（由 rules/local_rules_v1.json 生成，不手抄）。
// 套路来自 patterns.js（由 rules/patterns_v1.json 生成，与 DeepSeek 版同一份）。
//
// 输出结构对齐 localReport.js 的 { report, meta }：
//   - report 严格符合服务器 report 结构（报告页不用改）
//   - meta 放排查信息，不进 schema
import { LOCAL_RULES } from '@/common/ruleKeywords.js';
import { PATTERNS, SCHEMES, getScheme } from '@/common/patterns.js';
import {
  DIMENSION_LABELS,
  DIM_SHORT,
  OVERALL_SUMMARY,
  GREY_QUESTIONS,
  GREY_QUESTION_TEMPLATE,
  EMPTY_QUESTIONS,
  EMPTY_VERIFY,
} from '@/services/localReport.js';
import { SCHEMA_RULES_VERSION, PATTERN_DB_VERSION, RULE_RULES_VERSION } from '@/common/config.js';

export const MIN_CHARS = LOCAL_RULES.minChars || 20;

// ---- 1. 文字规整 ----
// 变形写法：诈骗话术常用谐音、繁体、全角躲关键词。这里做确定性替换。
const VARIANTS = [
  ['薇信', '微信'],
  ['威信', '微信'],
  ['V信', '微信'],
  ['v信', '微信'],
  ['Ｖ信', '微信'],
  ['卫信', '微信'],
  ['徽信', '微信'],
  ['扣扣', 'QQ'],
  ['koukou', 'QQ'],
  ['抠抠', 'QQ'],
  ['押 金', '押金'],
  ['押　金', '押金'],
  ['保证金', '保证金'],
  ['押jin', '押金'],
  ['ya金', '押金'],
  ['保征金', '保证金'],
  ['fl刷单', '刷单'],
];

// 繁体转简体的常用字（只收招聘话术里高频的字，不做全量转换——全量要引一套映射表，包体不值）
const TRAD = {
  費: '费',
  費: '费',
  繳: '缴',
  納: '纳',
  錢: '钱',
  賺: '赚',
  資: '资',
  職: '职',
  崗: '岗',
  證: '证',
  體: '体',
  檢: '检',
  試: '试',
  訓: '训',
  約: '约',
  簽: '签',
  勞: '劳',
  險: '险',
  會: '会',
  團: '团',
  務: '务',
  專: '专',
  員: '员',
  業: '业',
  應: '应',
  聯: '联',
  繫: '系',
  電: '电',
  話: '话',
  單: '单',
  簡: '简',
  歷: '历',
  學: '学',
  歷: '历',
  銀: '银',
  貸: '贷',
  墊: '垫',
  網: '网',
  騙: '骗',
};

export function normalizeText(input) {
  let s = String(input || '');
  // 全角转半角（数字、字母、标点；中文标点保持原样）
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  // 繁简
  s = s.replace(/./g, (c) => TRAD[c] || c);
  // 变形写法（做完繁简再替，避免替换后又被繁简表改掉）
  VARIANTS.forEach(([from, to]) => {
    if (!from || from === to) return;
    s = s.split(from).join(to);
  });
  // 中文数字转阿拉伯（只处理写法，不改变数字语义）
  s = cnNumber(s);
  // 去多余空格，行保留
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, arr) => line || arr[i - 1])
    .join('\n');
  return s;
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function cnToInt(raw) {
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of raw) {
    if (ch in CN_DIGIT) {
      num = CN_DIGIT[ch];
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch];
      if (unit === 10000) {
        total = (total + section + num) * unit;
        section = 0;
        num = 0;
      } else {
        section += (num || 1) * unit;
        num = 0;
      }
    }
  }
  return total + section + num;
}

// 中文数字 + 金额单位（元/万/千）才替换，避免把「一样」「一起」这类词改掉
export function cnNumber(input) {
  const s = String(input || '');
  return s.replace(
    /([零一二两三四五六七八九十百千万]{1,6})(?=\s*(?:元|块钱|块|万|千|K|k|\/月|元\/月))/g,
    (m) => {
      const n = cnToInt(m);
      return n > 0 && n <= 99999 ? String(n) : m;
    }
  );
}

// ---- 2. 判断是不是招聘截图 ----
export function isRecruitText(text) {
  const t = String(text || '');
  if (t.replace(/\s/g, '').length < MIN_CHARS) return false;
  return LOCAL_RULES.recruitKeywords.some((k) => t.indexOf(k) >= 0);
}

// ---- 3. 证据 ----
// 证据取「包含关键词的那一行原文」；行太长就截到关键词附近 40 字。
// 平台 / 产品名里的「微信」「QQ」：出现它们不代表对方只留了个人联系方式
const PLATFORM_NAME_RE = /(?:微信|威信|薇信|V信|vx|VX)\s*(?:视频号|公众号|小程序|支付|朋友圈|小店|商城|生态|平台|读书|群运营|社群|端)|(?:QQ|qq)\s*(?:音乐|空间|邮箱|浏览器|飞车|炫舞)/g;

// 按位置取证据：命中词可能在别处还以「平台名」的形式出现过，所以不能再按关键词从头找
function evidenceAt(text, at, kw) {
  const src = String(text || '');
  if (at < 0) return evidenceOf(src, kw);
  const lineStart = src.lastIndexOf('\n', at) + 1;
  let lineEnd = src.indexOf('\n', at);
  if (lineEnd < 0) lineEnd = src.length;
  const line = src.slice(lineStart, lineEnd).trim();
  if (line.length <= 60) return line;
  const i = Math.max(0, at - lineStart - 20);
  return src.slice(lineStart + i, lineStart + i + 60).trim();
}

export function evidenceOf(text, keyword) {
  const lines = String(text || '').split('\n');
  const kw = String(keyword || '');
  const hitLine = lines.find((l) => l.indexOf(kw) >= 0);
  if (hitLine) return clipLine(hitLine, kw);
  const idx = String(text || '').indexOf(kw);
  if (idx < 0) return '';
  return String(text || '').slice(Math.max(0, idx - 20), idx + kw.length + 20).trim();
}

function clipLine(line, kw) {
  const clean = String(line || '').trim();
  if (clean.length <= 60) return clean;
  const i = clean.indexOf(kw);
  if (i < 0) return clean.slice(0, 60);
  const start = Math.max(0, i - 20);
  return clean.slice(start, start + 60);
}

// 「收费动词」在「收费名词」附近才算收费。
// 不能整篇搜「交」字：正常岗位写「签订劳动合同」会被判成收费（自检抓到过一次）。
const NEAR_DISTANCE = 12;

// 正常用语里也含「交/缴/付」但方向相反：缴纳五险一金、交社保、缴纳社保、交公积金
// 注意不能带 /g：带 g 的正则在 replace/test 之间会保留 lastIndex，第二次调用就漏判。
const NORMAL_PAY_CONTEXT = /缴纳?(五险一金|社保|公积金|个人所得税|个税)|五险一金|社保|公积金/;

// 否定说法：「不收押金」「无需交任何费用」「免押金」是在说**不收钱**，不能当成收费。
// 2026-11-11 实测：正常岗位写了「入职不收取任何费用」被判成红灯「入职前先收钱」，就是因为没看否定词。
// 只认紧挨着的否定（中间最多隔一个常见虚词），避免「学历不限，需交押金」这种被误放过。
const NEG_BEFORE_VERB = /(?:不|无需|无须|不用|不需要?|不必|没有|未|勿|拒绝|严禁|禁止|绝不|不会|不得|免)(?:再|向你|向您|额外|另外|另行|需要|用)?$/;
const NEG_BEFORE_NOUN = /(?:免|无|零|0|没有|不收|不交|不需|无需|不用|不要)(?:任何|一切|所有)?$/;

function hasChargeVerbNear(text, noun) {
  const verbs = ['交', '缴', '付', '收', '扣', '自理', '收取', '缴纳', '垫付', '付费', '预交', '先付'];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(noun, from);
    if (idx < 0) return false;
    from = idx + 1;
    // 「免押金」「无任何押金」：名目本身被否定，这一处不算
    if (NEG_BEFORE_NOUN.test(text.slice(Math.max(0, idx - 6), idx))) continue;
    const start = Math.max(0, idx - NEAR_DISTANCE);
    const near = text.slice(start, idx + noun.length + NEAR_DISTANCE);
    // 去掉「缴纳五险一金/社保」这类正常用法，剩下的才是真的在收钱
    const stripped = near.replace(NORMAL_PAY_CONTEXT, '');
    // 附近要有一个**没被否定**的收费动词才算
    const hit = verbs.some((v) => {
      let at = stripped.indexOf(v);
      while (at >= 0) {
        if (!NEG_BEFORE_VERB.test(stripped.slice(Math.max(0, at - 6), at))) return true;
        at = stripped.indexOf(v, at + 1);
      }
      return false;
    });
    if (hit) return true;
  }
}

// 命中：返回证据原文，没命中返回 null
// require_all 的含义：外层每个组都要命中；组里的每一项（例如「收费名目」和「收费动词」）也都要命中。
// 之前把组里的几项摊平成「任意一个词」，结果只要出现「交」「收」这类单字就会判成「入职前先收钱」。
function matchKeywords(text, rule) {
  if (!rule.require_all || !rule.require_all.length) return null;
  let firstKw = '';
  for (const group of rule.require_all) {
    for (const entry of group || []) {
      const terms = (entry && entry.terms) || [];
      const present = terms.filter((t) => t && text.indexOf(t) >= 0);
      if (!present.length) return null;
      let kw = present[0];
      // 收费名目那一项要按「就近」判定：名目附近出现没被否定的收费动词，才算真的在收钱
      if (isChargeNounEntry(entry)) {
        kw = present.find((n) => hasChargeVerbNear(text, n)) || '';
        if (!kw) return null;
      }
      if (!firstKw) firstKw = kw;
    }
  }
  return evidenceOf(text, firstKw);
}

function isChargeNounEntry(entry) {
  const terms = (entry && entry.terms) || [];
  return terms.some((t) => /押金|保证金|费$/.test(t));
}

// ---- 4. 薪资解析 ----
// 支持：8000-20000、8k-2w、8千到1.5万、日结200-500（按 22 天折月薪）、年薪 15 万
export function parseSalary(text) {
  const s = String(text || '');
  // 日结：先判断是不是日薪，再按 22 天折月薪——先折再过滤，否则「日结200-500」会被 500 元门槛筛掉
  const daily = /日结|日薪|每天|一天|按日|元\/天/.test(s);
  const nums = [];
  const reRange = /(\d+(?:\.\d+)?)\s*([kK千wW万])?\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*([kK千wW万])?/g;
  let m;
  while ((m = reRange.exec(s))) {
    let lo = toYuan(parseFloat(m[1]), m[2]);
    let hi = toYuan(parseFloat(m[3]), m[4]);
    if (!(hi >= lo)) continue;
    // 日薪换算成月薪（按 22 个工作日）
    if (daily && lo < 2000) {
      lo *= 22;
      hi *= 22;
    }
    // 只收看起来像工资的数
    if (lo >= 500) {
      nums.push({ lo, hi });
    }
  }
  if (!nums.length) return null;
  const pick = nums[0];
  return { lo: pick.lo, hi: pick.hi, daily, raw: `${Math.round(pick.lo)}-${Math.round(pick.hi)}` };
}

function toYuan(n, unit) {
  const u = String(unit || '').toLowerCase();
  if (u === 'k' || u === '千') return n * 1000;
  if (u === 'w' || u === '万') return n * 10000;
  return n;
}

// 年薪写法：15万/年、年薪 20 万
function parseAnnual(text) {
  const m = String(text || '').match(/年薪\s*(\d+(?:\.\d+)?)\s*(万|k|千)?/);
  if (!m) return null;
  const v = toYuan(parseFloat(m[1]), m[2]);
  return { lo: Math.round(v / 12), hi: Math.round(v / 12) };
}

// ---- 5. 专用判定逻辑 ----
const LOGIC = {
  // 最高是最低的 2.5 倍以上
  pay_range_ratio(text, rule) {
    const annual = parseAnnual(text);
    const salary = annual || parseSalary(text);
    if (!salary || !salary.lo) return null;
    if (salary.hi / salary.lo < (rule.ratio || 2.5)) return null;
    const m = String(text).match(/\d+(?:\.\d+)?\s*[kK千wW万]?\s*[-~到至]\s*\d+(?:\.\d+)?\s*[kK千wW万]?/);
    return evidenceOf(text, m ? m[0].trim().split(/[-~到至]/)[0].trim() : '');
  },
  // 无需经验 + 最高工资 ≥ 15000
  no_experience_high_pay(text, rule) {
    const kw = (rule.terms || []).find((t) => text.indexOf(t) >= 0);
    if (!kw) return null;
    const salary = parseAnnual(text) || parseSalary(text);
    if (!salary || salary.hi < (rule.min_top || 15000)) return null;
    return evidenceOf(text, kw);
  },
  // 只留联系方式、没有公司名
  no_company_with_contact(text, rule) {
    const hasCompany = (rule.company_terms || []).some((t) => text.indexOf(t) >= 0);
    if (hasCompany) return null;
    // 「微信视频号」「微信公众号」「微信支付」「QQ 音乐」这类是平台或产品名，不是联系方式。
    // 先把它们挖掉再找，否则「拍摄抖音、微信视频号」会被当成「只留个人微信」（2026-11-11 老板实测的误判）。
    const masked = String(text).replace(PLATFORM_NAME_RE, (m) => '＃'.repeat(m.length));
    const kw = (rule.contact_terms || []).find((t) => masked.indexOf(t) >= 0);
    if (!kw) return null;
    const at = masked.indexOf(kw);
    return evidenceAt(text, at, kw);
  },
  // 试用期超过 N 个月
  probation_months(text, rule) {
    const m = String(text).match(/试用期\s*(\d+|[一二两三四五六七八九十]+)\s*个?月/);
    if (!m) return null;
    const raw = m[1];
    const months = /^\d+$/.test(raw) ? parseInt(raw, 10) : cnToInt(raw);
    if (!months || months <= (rule.max_months || 6)) return null;
    return evidenceOf(text, m[0]);
  },
};

// 绿灯判定
function matchGreen(text, rule) {
  if (rule.duty_terms) {
    const hit = rule.duty_terms.filter((t) => text.indexOf(t) >= 0);
    return hit.length >= 2 ? true : false;
  }
  return matchKeywords(text, rule) !== null;
}

// ---- 6. 套路库匹配（简单包含匹配，不做向量检索） ----
// 用每条套路的 examples 原样做包含；命中后取最长的那条 example 作为证据线索。
export function matchPatterns(text) {
  const out = [];
  PATTERNS.forEach((p) => {
    const examples = (p.examples || []).slice().sort((a, b) => b.length - a.length);
    const hitExample = examples.find((ex) => {
      const norm = String(ex || '').replace(/\s/g, '');
      if (norm.length < 4) return false;
      // 整句包含
      if (text.replace(/\s/g, '').indexOf(norm) >= 0) return true;
      // 否则要求 70% 的字符按序出现（应对同一句话里的标点/换行差异）
      return seqCover(text, norm) >= 0.7;
    });
    if (!hitExample) return;
    const ev = evidenceOf(text, subsequenceAnchor(text, hitExample)) || hitExample;
    if (!ev) return;
    out.push({ pattern_id: p.pattern_id, level: p.level, dimension: p.dimension, evidence: ev });
  });
  return out;
}

// 按序包含率：needle 的字符在 hay 中按顺序出现了多少比例
function seqCover(hay, needle) {
  const h = String(hay || '');
  const n = String(needle || '');
  if (!n.length) return 0;
  let i = 0;
  let matched = 0;
  for (let k = 0; k < n.length; k += 1) {
    const idx = h.indexOf(n[k], i);
    if (idx < 0) break;
    matched += 1;
    i = idx + 1;
  }
  return matched / n.length;
}

// 从 example 里找一个在原文中真实出现的短锚点，用来定位证据行
function subsequenceAnchor(text, example) {
  const norm = String(example || '').replace(/\s/g, '');
  for (let len = Math.min(8, norm.length); len >= 4; len -= 1) {
    for (let i = 0; i + len <= norm.length; i += 1) {
      const sub = norm.slice(i, i + len);
      if (text.indexOf(sub) >= 0) return sub;
    }
  }
  return norm.slice(0, 4);
}

// ---- 7. 拼报告 ----
const LEVEL_RANK = { none: 0, green: 1, amber: 2, red: 3 };
const DIMENSION_KEYS = ['fee', 'work', 'title', 'pay', 'company', 'contract'];

export function buildRuleReport(text, { minChars = MIN_CHARS } = {}) {
  const plain = normalizeText(text);
  const enough = plain.replace(/\s/g, '').length >= minChars;
  const isJob = enough && isRecruitText(plain);

  const findings = [];
  const dimLevel = {};

  if (isJob) {
    LOCAL_RULES.dimensions.forEach((dim) => {
      const levels = [];
      ['red', 'amber'].forEach((lv) => {
        (dim[lv] || []).forEach((rule) => {
          const ev = rule.logic ? (LOGIC[rule.logic] ? LOGIC[rule.logic](plain, rule) : null) : matchKeywords(plain, rule);
          if (!ev) return;
          levels.push(lv);
          findings.push({
            level: lv,
            dimension: dim.dimension,
            title: rule.title,
            evidence: ev,
            context: ev,
            reason: rule.what,
            action: rule.action || '',
            ask: rule.ask || '',
            source: 'rule',
            pattern_id: null,
            rule_id: rule.rule_id,
          });
        });
      });
      (dim.green || []).forEach((rule) => {
        if (matchGreen(plain, rule)) levels.push('green');
      });
      if (!levels.length) {
        dimLevel[dim.dimension] = 'none';
      } else {
        dimLevel[dim.dimension] = levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'none');
      }
    });

    // 套路库匹配：同一维度已由规则判过的，套路只做补充，不重复算同一个维度
    matchPatterns(plain).forEach((h) => {
      const p = PATTERNS.find((x) => x.pattern_id === h.pattern_id) || {};
      findings.push({
        level: h.level === 'red' ? 'red' : 'amber',
        dimension: h.dimension || 'work',
        title: p.name || '这条要问清楚',
        evidence: h.evidence,
        context: h.evidence,
        reason: p.why || '',
        action: p.how || '',
        ask: p.how || '',
        source: 'pattern',
        pattern_id: h.pattern_id,
        rule_id: null,
      });
      dimLevel[h.dimension || 'work'] = LEVEL_RANK[h.level === 'red' ? 'red' : 'amber'] > LEVEL_RANK[dimLevel[h.dimension || 'work'] || 'none']
        ? (h.level === 'red' ? 'red' : 'amber')
        : dimLevel[h.dimension || 'work'] || 'none';
    });
  }

  const dimensions = DIMENSION_KEYS.map((key) => ({
    key,
    level: dimLevel[key] || 'none',
    short: DIM_SHORT[dimLevel[key] || 'none'],
  }));

  const levels = dimensions.map((d) => d.level);
  let overall = 'unknown';
  if (isJob) {
    if (levels.includes('red')) overall = 'red';
    else if (levels.includes('amber')) overall = 'amber';
    else if (levels.includes('green')) overall = 'green';
  }

  // 排序：红灯在前
  findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);

  const questions = [];
  findings.forEach((f) => {
    if (f.ask && questions.indexOf(f.ask) < 0) questions.push(f.ask);
  });
  if (isJob) {
    dimensions.forEach((d) => {
      if (d.level !== 'none') return;
      const q = GREY_QUESTION_TEMPLATE
        .replace('{label}', DIMENSION_LABELS[d.key] || d.key)
        .replace('{question}', GREY_QUESTIONS[d.key] || '');
      if (questions.indexOf(q) < 0) questions.push(q);
    });
  }

  const verify = [];
  findings.forEach((f) => {
    if (f.action && verify.indexOf(f.action) < 0) verify.push(f.action);
  });

  // 整体套路：取命中最多的维度对应的 scheme；没有命中就 S-00
  const schemeId = pickScheme(findings);
  const schemeInfo = getScheme(schemeId) || getScheme('S-00') || {};
  const confidence = findings.length ? 'medium' : 'high';

  return {
    report: {
      is_job_posting: isJob,
      overall,
      summary: OVERALL_SUMMARY[overall] || OVERALL_SUMMARY.unknown,
      dimensions,
      findings,
      questions_to_ask: questions.length ? questions.slice(0, 5) : EMPTY_QUESTIONS,
      how_to_verify: verify.length ? verify.slice(0, 5) : EMPTY_VERIFY,
      rules_version: SCHEMA_RULES_VERSION,
      pattern_db_version: PATTERN_DB_VERSION,
    },
    meta: {
      engine: 'rules',
      path_tag: RULE_RULES_VERSION, // 'v3.0-local'
      ocr_text: plain,
      ocr_source: 'local-ocr',
      text_len: plain.replace(/\s/g, '').length,
      scheme_id: schemeId,
      scheme: schemeInfo,
      confidence,
      pattern_count: PATTERNS.length,
      scheme_count: SCHEMES.length,
    },
  };
}

// 套路方案选择：按「命中发现所属维度」对到固定 scheme 表；只选得出来的，不硬编
const DIM_TO_SCHEME = {
  fee: 'S-08', // 入职收费
  work: 'S-03', // 刷单返利
  title: 'S-04', // 电销保险包装成文职
  pay: 'S-06', // 无底薪高提成
  contract: 'S-08',
};

function pickScheme(findings) {
  if (!findings.length) return 'S-00';
  const reds = findings.filter((f) => f.level === 'red');
  const first = reds[0] || findings[0];
  const id = DIM_TO_SCHEME[first.dimension] || 'S-00';
  return SCHEMES.some((s) => s.scheme_id === id) ? id : 'S-00';
}
