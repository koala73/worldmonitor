/**
 * The keyword threat classifier the browser uses to label headlines.
 *
 * Extracted from `src/services/threat-classifier.ts` (#7526) so the server can
 * label a headline exactly the way the country panel does. That file keeps the
 * runtime-only halves — CSS colors, i18n labels, the batched LLM classifier —
 * and re-exports `classifyByKeyword` from here, so there is still one keyword
 * implementation and one set of keyword tables.
 *
 * NOT the same classifier as `server/worldmonitor/news/v1/_classifier.ts`.
 * That one labels the multi-source news digest and carries its own historical
 * downgrade rules; this one labels what the country panel shows. A surface that
 * must agree with the panel imports THIS module. Nothing here reads the DOM,
 * `window`, or any browser global, so the server bundles it as-is.
 */

/** Mirrors `ThreatLevel` in src/types — see the assertion in src/services/threat-classifier.ts. */
export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Mirrors `EventCategory` in src/types — see the assertion in src/services/threat-classifier.ts. */
export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

/** Mirrors `ThreatClassification` in src/types — see the assertion in src/services/threat-classifier.ts. */
export interface ThreatClassification {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  source: 'keyword' | 'ml' | 'llm';
}

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  'nuclear war': 'military',
  'invasion': 'conflict',
  'declaration of war': 'conflict',
  'declares war': 'conflict',
  'all-out war': 'conflict',
  'full-scale war': 'conflict',
  'martial law': 'military',
  'coup': 'military',
  'coup attempt': 'military',
  'genocide': 'conflict',
  'ethnic cleansing': 'conflict',
  'chemical attack': 'terrorism',
  'biological attack': 'terrorism',
  'dirty bomb': 'terrorism',
  'mass casualty': 'conflict',
  'massive strikes': 'military',
  'military strikes': 'military',
  'retaliatory strikes': 'military',
  'launches strikes': 'military',
  'launch attacks on iran': 'military',
  'launch attack on iran': 'military',
  'attacks on iran': 'military',
  'strikes on iran': 'military',
  'strikes iran': 'military',
  'bombs iran': 'military',
  'attacks iran': 'military',
  'attack on iran': 'military',
  'attack iran': 'military',
  'attacked iran': 'military',
  'attack against iran': 'military',
  'bombing iran': 'military',
  'bombed iran': 'military',
  'war with iran': 'conflict',
  'war on iran': 'conflict',
  'war against iran': 'conflict',
  'iran retaliates': 'military',
  'iran strikes': 'military',
  'iran launches': 'military',
  'iran attacks': 'military',
  'pandemic declared': 'health',
  'health emergency': 'health',
  'nato article 5': 'military',
  'evacuation order': 'disaster',
  'meltdown': 'disaster',
  'nuclear meltdown': 'disaster',
  'major combat operations': 'military',
  'declared war': 'conflict',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict',
  'armed conflict': 'conflict',
  'airstrike': 'conflict',
  'airstrikes': 'conflict',
  'air strike': 'conflict',
  'air strikes': 'conflict',
  'drone strike': 'conflict',
  'drone strikes': 'conflict',
  'strikes': 'conflict',
  'missile': 'military',
  'missile launch': 'military',
  'missiles fired': 'military',
  'troops deployed': 'military',
  'military escalation': 'military',
  'military operation': 'military',
  'ground offensive': 'military',
  'bombing': 'conflict',
  'bombardment': 'conflict',
  'shelling': 'conflict',
  'casualties': 'conflict',
  'killed in': 'conflict',
  'hostage': 'terrorism',
  'terrorist': 'terrorism',
  'terror attack': 'terrorism',
  'assassination': 'crime',
  'cyber attack': 'cyber',
  'ransomware': 'cyber',
  'data breach': 'cyber',
  'sanctions': 'economic',
  'embargo': 'economic',
  'earthquake': 'disaster',
  'tsunami': 'disaster',
  'hurricane': 'disaster',
  'typhoon': 'disaster',
  'strike on': 'conflict',
  'strikes on': 'conflict',
  'attack on': 'conflict',
  'attack against': 'conflict',
  'attacks on': 'conflict',
  'launched attack': 'conflict',
  'launched attacks': 'conflict',
  'launches attack': 'conflict',
  'launches attacks': 'conflict',
  'explosions': 'conflict',
  'military operations': 'military',
  'combat operations': 'military',
  'retaliatory strike': 'military',
  'retaliatory attack': 'military',
  'retaliatory attacks': 'military',
  'preemptive strike': 'military',
  'preemptive attack': 'military',
  'preventive attack': 'military',
  'preventative attack': 'military',
  'military offensive': 'military',
  'ballistic missile': 'military',
  'cruise missile': 'military',
  'air defense intercepted': 'military',
  'forces struck': 'conflict',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'protest': 'protest',
  'protests': 'protest',
  'riot': 'protest',
  'riots': 'protest',
  'unrest': 'protest',
  'demonstration': 'protest',
  'strike action': 'protest',
  'military exercise': 'military',
  'naval exercise': 'military',
  'arms deal': 'military',
  'weapons sale': 'military',
  'diplomatic crisis': 'diplomatic',
  'ambassador recalled': 'diplomatic',
  'expel diplomats': 'diplomatic',
  'trade war': 'economic',
  'tariff': 'economic',
  'recession': 'economic',
  'inflation': 'economic',
  'market crash': 'economic',
  'flood': 'disaster',
  'flooding': 'disaster',
  'wildfire': 'disaster',
  'volcano': 'disaster',
  'eruption': 'disaster',
  'outbreak': 'health',
  'epidemic': 'health',
  'infection spread': 'health',
  'oil spill': 'environmental',
  'pipeline explosion': 'infrastructure',
  'blackout': 'infrastructure',
  'power outage': 'infrastructure',
  'internet outage': 'infrastructure',
  'derailment': 'infrastructure',
};

const LOW_KEYWORDS: KeywordMap = {
  'election': 'diplomatic',
  'vote': 'diplomatic',
  'referendum': 'diplomatic',
  'summit': 'diplomatic',
  'treaty': 'diplomatic',
  'agreement': 'diplomatic',
  'negotiation': 'diplomatic',
  'talks': 'diplomatic',
  'peacekeeping': 'diplomatic',
  'humanitarian aid': 'diplomatic',
  'ceasefire': 'diplomatic',
  'peace treaty': 'diplomatic',
  'climate change': 'environmental',
  'emissions': 'environmental',
  'pollution': 'environmental',
  'deforestation': 'environmental',
  'drought': 'environmental',
  'vaccine': 'health',
  'vaccination': 'health',
  'disease': 'health',
  'virus': 'health',
  'public health': 'health',
  'covid': 'health',
  'interest rate': 'economic',
  'gdp': 'economic',
  'unemployment': 'economic',
  'regulation': 'economic',
};

const TECH_HIGH_KEYWORDS: KeywordMap = {
  'major outage': 'infrastructure',
  'service down': 'infrastructure',
  'global outage': 'infrastructure',
  'zero-day': 'cyber',
  'critical vulnerability': 'cyber',
  'supply chain attack': 'cyber',
  'mass layoff': 'economic',
};

const TECH_MEDIUM_KEYWORDS: KeywordMap = {
  'outage': 'infrastructure',
  'breach': 'cyber',
  'hack': 'cyber',
  'vulnerability': 'cyber',
  'layoff': 'economic',
  'layoffs': 'economic',
  'antitrust': 'economic',
  'monopoly': 'economic',
  'ban': 'economic',
  'shutdown': 'infrastructure',
};

const TECH_LOW_KEYWORDS: KeywordMap = {
  'ipo': 'economic',
  'funding': 'economic',
  'acquisition': 'economic',
  'merger': 'economic',
  'launch': 'tech',
  'release': 'tech',
  'update': 'tech',
  'partnership': 'economic',
  'startup': 'tech',
  'ai model': 'tech',
  'open source': 'tech',
};

const EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
  'strikes deal', 'strikes agreement', 'strikes partnership',
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood', 'strikes',
]);

const TRAILING_BOUNDARY_KEYWORDS = new Set([
  'attack iran', 'attacked iran', 'attack on iran', 'attack against iran',
  'attacks on iran', 'launch attacks on iran', 'launch attack on iran',
  'bombing iran', 'bombed iran', 'strikes iran', 'attacks iran',
  'bombs iran', 'war on iran', 'war with iran', 'war against iran',
  'iran retaliates', 'iran strikes', 'iran launches', 'iran attacks',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (SHORT_KEYWORDS.has(kw)) {
      re = new RegExp(`\\b${escaped}\\b`);
    } else if (TRAILING_BOUNDARY_KEYWORDS.has(kw)) {
      re = new RegExp(`${escaped}(?![\\w-])`);
    } else {
      re = new RegExp(escaped);
    }
    keywordRegexCache.set(kw, re);
  }
  return re;
}

function matchKeywords(
  titleLower: string,
  keywords: KeywordMap
): { keyword: string; category: EventCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(titleLower)) {
      return { keyword: kw, category: cat };
    }
  }
  return null;
}

// Compound escalation: HIGH military/conflict + critical geopolitical target → CRITICAL
// Handles headlines like "strikes by US and Israel on Iran" where words aren't adjacent
const ESCALATION_ACTIONS = /\b(attack|attacks|attacked|strike|strikes|struck|bomb|bombs|bombed|bombing|shell|shelled|shelling|missile|missiles|intercept|intercepted|retaliates|retaliating|retaliation|killed|casualties|offensive|invaded|invades)\b/;
const ESCALATION_TARGETS = /\b(iran|tehran|isfahan|tabriz|russia|moscow|china|beijing|taiwan|taipei|north korea|pyongyang|nato|us base|us forces|american forces|us military)\b/;

function shouldEscalateToCritical(lower: string, matchCat: EventCategory): boolean {
  if (matchCat !== 'conflict' && matchCat !== 'military') return false;
  return ESCALATION_ACTIONS.test(lower) && ESCALATION_TARGETS.test(lower);
}

export function classifyByKeyword(title: string, variant = 'full'): ThreatClassification {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  const isTech = variant === 'tech';

  // Priority cascade: critical → high → medium → low → info
  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    // Compound escalation: military action + critical geopolitical target → CRITICAL
    if (shouldEscalateToCritical(lower, match.category)) {
      return { level: 'critical', category: match.category, confidence: 0.85, source: 'keyword' };
    }
    return { level: 'high', category: match.category, confidence: 0.8, source: 'keyword' };
  }

  if (isTech) {
    match = matchKeywords(lower, TECH_HIGH_KEYWORDS);
    if (match) return { level: 'high', category: match.category, confidence: 0.75, source: 'keyword' };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) return { level: 'medium', category: match.category, confidence: 0.7, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_MEDIUM_KEYWORDS);
    if (match) return { level: 'medium', category: match.category, confidence: 0.65, source: 'keyword' };
  }

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) return { level: 'low', category: match.category, confidence: 0.6, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_LOW_KEYWORDS);
    if (match) return { level: 'low', category: match.category, confidence: 0.55, source: 'keyword' };
  }

  return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
}
