import { KNOWN_OTHER_PLACES } from './chat-accuracy.places';

/**
 * 模型回答的准确性校验（框架，规则待定）。
 *
 * 只做「可判定的错」，不评价文笔，也不做内容审核：
 * 1. 目录里没有票价字段 → 出现具体票价即视为编造；
 * 2. 目录里没有开放时间 → 出现「8:30 开门」这类即视为编造；
 * 3. 提到别的城市景点 → 跨城市污染。
 *
 * 误报比漏报更伤：宁可少抓，也不要把正确答案标成错误。
 * 因此所有规则都要求上下文关键词，且后缀抽取默认关闭。
 */

export type AccuracyCode = 'FABRICATED_PRICE' | 'FABRICATED_HOURS' | 'PLACE_OUTSIDE_CATALOG';

export interface AccuracyFinding {
  code: AccuracyCode;
  /** block 表示必须重试或拒绝；warn 表示只在界面上标注。 */
  severity: 'block' | 'warn';
  /** 命中的原文片段，便于排查。 */
  excerpt: string;
  /** 疑似目录外的地点名（仅 PLACE_OUTSIDE_CATALOG 有值）。 */
  place?: string;
}

export interface AccuracyReport {
  findings: AccuracyFinding[];
  /** 是否必须处理（重试或拒绝）。 */
  blocking: boolean;
}

export interface AccuracyPolicy {
  blockPrices: boolean;
  blockOpeningHours: boolean;
  /** 目录外地点：off 不检测、warn 标注、block 触发重试。 */
  unknownPlace: 'off' | 'warn' | 'block';
  /** 额外用后缀正则抽候选，误报较多，默认关闭。 */
  suffixExtraction: boolean;
  knownPlaces: readonly string[];
}

export const DEFAULT_ACCURACY_POLICY: AccuracyPolicy = {
  blockPrices: true,
  blockOpeningHours: true,
  unknownPlace: 'warn',
  suffixExtraction: false,
  knownPlaces: KNOWN_OTHER_PLACES,
};

/** 句子级截断，避免一条命中把整段回答塞进日志。 */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12);
  return text.slice(start, Math.min(text.length, index + length + 12)).trim();
}

// 票价必须同时出现「价格类关键词」和「数字+元」。单纯说「3000 元预算」不算。
const PRICE_PATTERNS: readonly RegExp[] = [
  /(?:门票|票价|成人票|学生票|儿童票|老人票|通票|联票|套票|半价|免票|一张票|单人票|每张)[^。，,；;\n]{0,12}?\d[\d,]*(?:\.\d+)?\s*元/g,
  /\d[\d,]*(?:\.\d+)?\s*元[^。，,；;\n]{0,8}?(?:门票|票价|一张|每人|一人)/g,
];

// 时间必须同时出现「开关门类关键词」和具体时刻。单纯说「9 点出发」不算。
const HOURS_PATTERNS: readonly RegExp[] = [
  /(?:开门|开园|开馆|开放时间|营业时间|开始入场|闭馆|闭园|停止入场|停止入园|最后入场|最后入园)[^。，,；;\n]{0,10}?\d{1,2}\s*[:：]\s*\d{2}/g,
  /\d{1,2}\s*[:：]\s*\d{2}[^。，,；;\n]{0,8}?(?:开门|开园|开馆|闭馆|闭园|停止入场|停止入园)/g,
  /\d{1,2}\s*点(?:半)?[^。，,；;\n]{0,4}?(?:开门|开园|开馆|闭馆|闭园)/g,
  /(?:开门|开园|开馆)[^。，,；;\n]{0,6}?\d{1,2}\s*点半?/g,
];

const PLACE_SUFFIX =
  /[\u4e00-\u9fa5]{2,6}(?:公园|博物馆|美术馆|纪念馆|长城|故宫|寺|塔|湖|山|陵|宫|馆|园|古城|古镇|湿地)/g;

function scan(text: string, patterns: readonly RegExp[], code: AccuracyCode): AccuracyFinding[] {
  const found: AccuracyFinding[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const matched = match[0].trim();
      if (!matched) continue;
      const at = match.index ?? 0;
      const snippet = excerpt(text, at, matched.length);
      // 同一类规则命中同一片段时只保留一条；不同类（票价/时间）各自计数。
      if (found.some((item) => item.code === code && item.excerpt === snippet)) continue;
      found.push({ code, severity: 'block', excerpt: snippet });
    }
  }
  return found;
}

/**
 * 找出回答里「不在当前目录内」的地名。
 *
 * 先删掉目录内的名字再找，避免「故宫博物院」被拆出「故宫」误判；
 * 同时把候选与目录名做互相包含判断，容忍「故宫」/「故宫博物院」这类简称。
 */
export function findOutsidePlaces(
  reply: string,
  catalog: readonly string[],
  policy: Pick<AccuracyPolicy, 'unknownPlace' | 'suffixExtraction' | 'knownPlaces'>,
): AccuracyFinding[] {
  if (policy.unknownPlace === 'off' || catalog.length === 0) return [];

  const names = catalog.map((name) => name.trim()).filter(Boolean);
  let scrubbed = reply;
  for (const name of names) scrubbed = scrubbed.split(name).join(' ');

  const candidates = new Set<string>();
  for (const known of policy.knownPlaces) {
    if (known && scrubbed.includes(known)) {
      // 只保留最长命中：「上海外滩」命中时不再记「外滩」。
      const covered = [...candidates].some((item) => item.includes(known));
      if (!covered) {
        for (const item of [...candidates]) if (known.includes(item)) candidates.delete(item);
        candidates.add(known);
      }
    }
  }
  if (policy.suffixExtraction) {
    for (const match of scrubbed.matchAll(PLACE_SUFFIX)) {
      const name = match[0].trim();
      if (name.length >= 2) candidates.add(name);
    }
  }

  const outside = [...candidates].filter(
    (name) => !names.some((entry) => entry.includes(name) || name.includes(entry)),
  );
  return outside.slice(0, 5).map((place) => ({
    code: 'PLACE_OUTSIDE_CATALOG' as const,
    severity: policy.unknownPlace === 'block' ? ('block' as const) : ('warn' as const),
    excerpt: place,
    place,
  }));
}

/**
 * 检查一条模型回答。`catalog` 是这次发给模型的景点名单；
 * 没有名单（用户还没选城市）时跳过地点检查，否则会把所有地名都判成越界。
 */
export function inspectReply(
  reply: string,
  catalog: readonly string[],
  policy: AccuracyPolicy = DEFAULT_ACCURACY_POLICY,
): AccuracyReport {
  const findings: AccuracyFinding[] = [];
  if (policy.blockPrices) findings.push(...scan(reply, PRICE_PATTERNS, 'FABRICATED_PRICE'));
  if (policy.blockOpeningHours) findings.push(...scan(reply, HOURS_PATTERNS, 'FABRICATED_HOURS'));
  findings.push(...findOutsidePlaces(reply, catalog, policy));
  return { findings, blocking: findings.some((item) => item.severity === 'block') };
}
