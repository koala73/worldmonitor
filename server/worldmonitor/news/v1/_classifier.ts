export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_VALUES: Record<ThreatLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  info: 0,
};

export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

export interface ClassificationResult {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  // 'keyword' = pure keyword match (CRITICAL/HIGH/MEDIUM/LOW lists or
  // info-level no-match fallback). 'keyword-historical-downgrade' = a
  // CRITICAL/HIGH keyword matched, but the headline contained a historical
  // retrospective marker (e.g. "Science history:", "April 26, 1986",
  // "5 years ago"), so the level was forced to info. Distinct source tag
  // lets downstream consumers + telemetry distinguish "no-match info"
  // from "downgraded-from-critical info".
  source: 'keyword' | 'keyword-historical-downgrade';
}

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  'nuclear war': 'military',
  'invasion': 'conflict',
  'declaration of war': 'conflict',
  'martial law': 'military',
  'coup': 'military',
  'coup attempt': 'military',
  'genocide': 'conflict',
  'ethnic cleansing': 'conflict',
  'chemical attack': 'terrorism',
  'biological attack': 'terrorism',
  'dirty bomb': 'terrorism',
  'mass casualty': 'conflict',
  'pandemic declared': 'health',
  'health emergency': 'health',
  'nato article 5': 'military',
  'evacuation order': 'disaster',
  'meltdown': 'disaster',
  'nuclear meltdown': 'disaster',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict',
  'armed conflict': 'conflict',
  'airstrike': 'conflict',
  'air strike': 'conflict',
  'drone strike': 'conflict',
  'missile': 'military',
  'missile launch': 'military',
  'troops deployed': 'military',
  'military escalation': 'military',
  'bombing': 'conflict',
  'casualties': 'conflict',
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
  'ceasefire': 'diplomatic',
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
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    re = SHORT_KEYWORDS.has(kw)
      ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      : new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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

/**
 * Headline-shape patterns that flip a CRITICAL/HIGH keyword classification
 * into a historical retrospective. Triggered ONLY after a critical/high
 * keyword has already matched — i.e. these patterns alone don't downgrade
 * unrelated content; they downgrade content where the trigger word
 * (`meltdown`, `invasion`, `genocide`, …) appears in a historically-framed
 * headline. Examples that tripped the prior classifier:
 *   - "Science history: Chernobyl nuclear power plant melts down — April 26, 1986"
 *   - "On this day: Iraq invasion 5 years ago"
 * Both contain a CRITICAL keyword AND an unmistakable retrospective marker.
 */
// Highly-specific retrospective prefixes — bare "Today in" / "This day in"
// were intentionally REMOVED after PR #3429 review (round 2). Both have
// legitimate current-event uses ("Today in Ukraine: Russian missile strikes
// Kyiv") that would have falsely downgraded real critical alerts. Only
// patterns whose retrospective intent is unambiguous remain:
//   - "Science history:" — Live Science series tag, never current.
//   - "Throwback" / "Flashback" — always retrospective by definition.
const HISTORICAL_PREFIX_RE = /^(?:science history|throwback|flashback)\s*:?/i;

// "On this day in YYYY" requires a YEAR after the prefix — narrows out
// "On this day, Iran fires missile" (current event) while keeping
// "On this day in 1986, Chernobyl..." (retrospective).
const HISTORICAL_PREFIX_WITH_YEAR_RE = /^on this day in\s+(?:19|20)\d{2}\b/i;

// "This day in history" — specific phrasing, not the bare "This day in"
// (which could prefix a current-event headline).
const THIS_DAY_IN_HISTORY_RE = /^this day in history\b/i;

const HISTORICAL_PHRASE_RE =
  /\b(?:\d+\s+(?:years?|decades?|months?)\s+(?:ago|after|later)|anniversary|in memoriam|remembering|remembered|commemorat(?:e|es|ed|ion)|retrospective)\b/i;

// Full date in the headline. The year must be ≥ 2 years in the past for
// the date to count as retrospective — "April 26, 2026" (current year) or
// "April 26, 2025" (last year) appear in plenty of current-event headlines
// (court rulings, regulatory deadlines, scheduled events). Only dates from
// 2024-and-earlier (in 2026) are unambiguously retrospective.
const FULL_DATE_RE =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+((?:19|20)\d{2})\b/i;

const ISO_DATE_RE = /\b((?:19|20)\d{2})-\d{1,2}-\d{1,2}\b/;

/**
 * Year is "past" for retrospective purposes when it's at least 2 years
 * older than the current calendar year. Conservative cutoff: a 1-year-old
 * date is often current-context (last year's court ruling, last year's
 * outbreak) and we don't want to falsely downgrade those.
 */
function isPastRetrospectiveYear(year: number, nowMs: number): boolean {
  const currentYear = new Date(nowMs).getUTCFullYear();
  return year < currentYear - 1;
}

/**
 * Returns true if the title looks like a historical retrospective.
 * Used by classifyByKeyword to downgrade CRITICAL/HIGH keyword matches
 * (e.g. "meltdown") that appear in a backward-looking headline, AND by
 * enrichWithAiCache as a defense-in-depth check on LLM-promoted levels.
 *
 * The `nowMs` parameter is exposed for unit testability (so tests can pin
 * the "current year" without depending on wall-clock time). Production
 * callers omit it and get `Date.now()`.
 *
 * Exported for test coverage — DO NOT call from production code paths
 * other than classifyByKeyword and enrichWithAiCache.
 */
export function hasHistoricalMarker(title: string, nowMs: number = Date.now()): boolean {
  if (HISTORICAL_PREFIX_RE.test(title)) return true;
  if (HISTORICAL_PREFIX_WITH_YEAR_RE.test(title)) return true;
  if (THIS_DAY_IN_HISTORY_RE.test(title)) return true;
  if (HISTORICAL_PHRASE_RE.test(title)) return true;

  const fullDateMatch = title.match(FULL_DATE_RE);
  if (fullDateMatch && isPastRetrospectiveYear(parseInt(fullDateMatch[1]!, 10), nowMs)) {
    return true;
  }

  const isoDateMatch = title.match(ISO_DATE_RE);
  if (isoDateMatch && isPastRetrospectiveYear(parseInt(isoDateMatch[1]!, 10), nowMs)) {
    return true;
  }

  return false;
}

export function classifyByKeyword(title: string, variant?: string): ClassificationResult {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  const isTech = variant === 'tech';
  // Historical-retrospective downgrade applies only to CRITICAL/HIGH
  // keyword matches — those are the levels that score high enough to
  // ship in briefs, and those are where the false-positive cost is
  // highest (an anniversary listicle ranking like a current crisis).
  // LOW/MEDIUM matches are left alone since they don't clear thresholds
  // anyway, and the downgrade-to-info would be over-aggressive there.
  const isRetrospective = hasHistoricalMarker(title);

  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) {
    if (isRetrospective) {
      return { level: 'info', category: 'general', confidence: 0.85, source: 'keyword-historical-downgrade' };
    }
    return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };
  }

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    if (isRetrospective) {
      return { level: 'info', category: 'general', confidence: 0.85, source: 'keyword-historical-downgrade' };
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
