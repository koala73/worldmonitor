// Simplified threat classifier — keyword-only (no AI/RPC dependency)
// Preserved from original src/services/threat-classifier.ts

export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

export interface ThreatClassification {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  source: 'keyword' | 'ml' | 'llm';
}

export const THREAT_PRIORITY: Record<ThreatLevel, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
};

export const THREAT_COLORS: Record<ThreatLevel, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
  info: '#3b82f6',
};

export function getThreatColor(level: string): string {
  return THREAT_COLORS[level as ThreatLevel] || '#6b7280';
}

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military', 'nuclear attack': 'military', 'nuclear war': 'military',
  'invasion': 'conflict', 'declaration of war': 'conflict', 'declares war': 'conflict',
  'all-out war': 'conflict', 'full-scale war': 'conflict', 'martial law': 'military',
  'coup': 'military', 'coup attempt': 'military', 'genocide': 'conflict',
  'ethnic cleansing': 'conflict', 'chemical attack': 'terrorism', 'biological attack': 'terrorism',
  'dirty bomb': 'terrorism', 'mass casualty': 'conflict', 'massive strikes': 'military',
  'military strikes': 'military', 'retaliatory strikes': 'military', 'launches strikes': 'military',
  'pandemic declared': 'health', 'health emergency': 'health', 'nato article 5': 'military',
  'evacuation order': 'disaster', 'meltdown': 'disaster', 'nuclear meltdown': 'disaster',
  'major combat operations': 'military', 'declared war': 'conflict',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict', 'armed conflict': 'conflict', 'airstrike': 'conflict',
  'airstrikes': 'conflict', 'air strike': 'conflict', 'air strikes': 'conflict',
  'drone strike': 'conflict', 'drone strikes': 'conflict', 'missile': 'military',
  'missile launch': 'military', 'missiles fired': 'military', 'troops deployed': 'military',
  'military escalation': 'military', 'military operation': 'military',
  'ground offensive': 'military', 'bombing': 'conflict', 'bombardment': 'conflict',
  'shelling': 'conflict', 'casualties': 'conflict', 'killed in': 'conflict',
  'hostage': 'terrorism', 'terrorist': 'terrorism', 'terror attack': 'terrorism',
  'assassination': 'crime', 'cyber attack': 'cyber', 'ransomware': 'cyber',
  'data breach': 'cyber', 'sanctions': 'economic', 'embargo': 'economic',
  'earthquake': 'disaster', 'tsunami': 'disaster', 'hurricane': 'disaster',
  'typhoon': 'disaster', 'explosions': 'conflict',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'protest': 'protest', 'protests': 'protest', 'riot': 'protest', 'riots': 'protest',
  'unrest': 'protest', 'demonstration': 'protest', 'strike action': 'protest',
  'military exercise': 'military', 'naval exercise': 'military',
  'arms deal': 'military', 'weapons sale': 'military',
  'diplomatic crisis': 'diplomatic', 'ambassador recalled': 'diplomatic',
  'trade war': 'economic', 'tariff': 'economic', 'recession': 'economic',
  'inflation': 'economic', 'market crash': 'economic',
  'flood': 'disaster', 'flooding': 'disaster', 'wildfire': 'disaster',
  'volcano': 'disaster', 'eruption': 'disaster',
  'outbreak': 'health', 'epidemic': 'health', 'infection spread': 'health',
  'oil spill': 'environmental', 'pipeline explosion': 'infrastructure',
  'blackout': 'infrastructure', 'power outage': 'infrastructure',
  'internet outage': 'infrastructure', 'derailment': 'infrastructure',
  'outage': 'infrastructure', 'breach': 'cyber', 'hack': 'cyber',
  'vulnerability': 'cyber', 'layoff': 'economic', 'layoffs': 'economic',
};

const LOW_KEYWORDS: KeywordMap = {
  'election': 'diplomatic', 'vote': 'diplomatic', 'referendum': 'diplomatic',
  'summit': 'diplomatic', 'treaty': 'diplomatic', 'agreement': 'diplomatic',
  'negotiation': 'diplomatic', 'talks': 'diplomatic', 'peacekeeping': 'diplomatic',
  'humanitarian aid': 'diplomatic', 'ceasefire': 'diplomatic', 'peace treaty': 'diplomatic',
  'climate change': 'environmental', 'emissions': 'environmental',
  'pollution': 'environmental', 'deforestation': 'environmental', 'drought': 'environmental',
  'vaccine': 'health', 'vaccination': 'health', 'disease': 'health',
  'public health': 'health', 'interest rate': 'economic', 'gdp': 'economic',
  'unemployment': 'economic', 'regulation': 'economic',
  'ipo': 'economic', 'funding': 'economic', 'acquisition': 'economic',
  'merger': 'economic', 'launch': 'tech', 'release': 'tech', 'update': 'tech',
  'partnership': 'economic', 'startup': 'tech', 'ai model': 'tech',
};

const EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'strikes deal', 'strikes agreement',
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood', 'strikes',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (SHORT_KEYWORDS.has(kw)) {
      re = new RegExp(`\\b${escaped}\\b`);
    } else {
      re = new RegExp(escaped);
    }
    keywordRegexCache.set(kw, re);
  }
  return re;
}

function matchKeywords(lower: string, keywords: KeywordMap): { keyword: string; category: EventCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(lower)) {
      return { keyword: kw, category: cat };
    }
  }
  return null;
}

// Compound escalation: military/conflict action + critical geopolitical target → CRITICAL
const ESCALATION_ACTIONS = /\b(attack|attacks|attacked|strike|strikes|struck|bomb|bombs|bombed|bombing|missile|missiles|retaliates|retaliating|killed|casualties|offensive|invaded|invades)\b/;
const ESCALATION_TARGETS = /\b(iran|tehran|russia|moscow|china|beijing|taiwan|taipei|north korea|pyongyang|nato|us base|us forces)\b/;

function shouldEscalateToCritical(lower: string, matchCat: EventCategory): boolean {
  if (matchCat !== 'conflict' && matchCat !== 'military') return false;
  return ESCALATION_ACTIONS.test(lower) && ESCALATION_TARGETS.test(lower);
}

export function classifyByKeyword(title: string): ThreatClassification {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    if (shouldEscalateToCritical(lower, match.category)) {
      return { level: 'critical', category: match.category, confidence: 0.85, source: 'keyword' };
    }
    return { level: 'high', category: match.category, confidence: 0.8, source: 'keyword' };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) return { level: 'medium', category: match.category, confidence: 0.7, source: 'keyword' };

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) return { level: 'low', category: match.category, confidence: 0.6, source: 'keyword' };

  return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
}
