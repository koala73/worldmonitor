import { getCachedJson } from '../../../_shared/redis';
import { sanitizeForPrompt, sanitizeHeadline } from '../../../_shared/llm-sanitize.js';
import { CHROME_UA } from '../../../_shared/constants';
import { tokenizeForMatch, findMatchingKeywords } from '../../../../src/utils/keyword-match';

// TODO: multi-language digest search — currently only queries news:digest:v1:full:en.
// When multi-language digests are available, fan out to news:digest:v1:full:<lang>
// and merge results before scoring.

const GDELT_TOPICS: Record<string, string> = {
  geo: 'geopolitical conflict crisis diplomacy',
  market: 'financial markets economy trade stocks',
  military: 'military conflict war airstrike',
  economic: 'economy sanctions trade monetary policy',
  all: 'geopolitical conflict markets economy',
};

export interface AnalystContext {
  timestamp: string;
  worldBrief: string;
  riskScores: string;
  marketImplications: string;
  forecasts: string;
  marketData: string;
  macroSignals: string;
  predictionMarkets: string;
  countryBrief: string;
  liveHeadlines: string;
  relevantArticles: string;
  activeSources: string[];
  degraded: boolean;
}

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function formatPct(n: number): string {
  return `${Math.round(n)}%`;
}

function formatChange(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function buildWorldBrief(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const lines: string[] = [];

  const briefText = safeStr(d.brief || d.summary || d.content || d.text);
  if (briefText) lines.push(briefText.slice(0, 600));

  const stories = Array.isArray(d.topStories) ? d.topStories : Array.isArray(d.stories) ? d.stories : [];
  if (stories.length > 0) {
    lines.push('Top Events:');
    for (const s of stories.slice(0, 12)) {
      const title = sanitizeHeadline(safeStr((s as Record<string, unknown>).headline || (s as Record<string, unknown>).title || s));
      if (title) lines.push(`- ${title}`);
    }
  }
  return lines.join('\n');
}

function buildRiskScores(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const scores = Array.isArray(d.scores) ? d.scores : Array.isArray(d.countries) ? d.countries : [];
  if (!scores.length) return '';

  const top15 = scores
    .slice()
    .sort((a: unknown, b: unknown) => {
      const sa = safeNum((a as Record<string, unknown>)?.score ?? (a as Record<string, unknown>)?.cii);
      const sb = safeNum((b as Record<string, unknown>)?.score ?? (b as Record<string, unknown>)?.cii);
      return sb - sa;
    })
    .slice(0, 15);

  const lines = top15.map((s: unknown) => {
    const sc = s as Record<string, unknown>;
    const country = safeStr(sc.countryName || sc.name || sc.country);
    const score = safeNum(sc.score ?? sc.cii ?? sc.value);
    if (!country) return null;
    return `- ${country}: ${score.toFixed(1)}`;
  }).filter((l): l is string => l !== null);

  return lines.length ? `Top Risk Countries:\n${lines.join('\n')}` : '';
}

function buildMarketImplications(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const cards = Array.isArray(d.cards) ? d.cards : [];
  if (!cards.length) return '';

  const lines = cards.slice(0, 8).map((c: unknown) => {
    const card = c as Record<string, unknown>;
    const ticker = safeStr(card.ticker);
    const title = safeStr(card.title);
    const direction = safeStr(card.direction);
    const confidence = safeStr(card.confidence);
    if (!ticker || !title) return null;
    return `- ${ticker} ${direction} (${confidence}): ${title}`;
  }).filter((l): l is string => l !== null);

  return lines.length ? `AI Market Signals:\n${lines.join('\n')}` : '';
}

function buildForecasts(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const predictions = Array.isArray(d.predictions) ? d.predictions : [];
  if (!predictions.length) return '';

  const lines = predictions.slice(0, 8).map((p: unknown) => {
    const pred = p as Record<string, unknown>;
    const title = safeStr(pred.title || pred.event);
    const domain = safeStr(pred.domain || pred.category);
    const prob = safeNum(pred.probability ?? pred.prob);
    if (!title) return null;
    const probStr = prob > 0 ? ` — ${formatPct(prob > 1 ? prob : prob * 100)}` : '';
    return `- [${domain || 'General'}] ${title}${probStr}`;
  }).filter((l): l is string => l !== null);

  return lines.length ? `Active Forecasts:\n${lines.join('\n')}` : '';
}

function buildMarketData(stocks: unknown, commodities: unknown): string {
  const parts: string[] = [];

  if (stocks && typeof stocks === 'object') {
    const d = stocks as Record<string, unknown>;
    const quotes = Array.isArray(d.quotes) ? d.quotes : [];
    const stockLines = quotes.slice(0, 6).map((q: unknown) => {
      const quote = q as Record<string, unknown>;
      const sym = safeStr(quote.symbol || quote.ticker);
      const price = safeNum(quote.price ?? quote.regularMarketPrice);
      const chg = safeNum(quote.changePercent ?? quote.regularMarketChangePercent);
      if (!sym || !price) return null;
      return `${sym} $${price.toFixed(2)} (${formatChange(chg)})`;
    }).filter((l): l is string => l !== null);
    if (stockLines.length) parts.push(`Equities: ${stockLines.join(', ')}`);
  }

  if (commodities && typeof commodities === 'object') {
    const d = commodities as Record<string, unknown>;
    const quotes = Array.isArray(d.quotes) ? d.quotes : [];
    const commLines = quotes.slice(0, 4).map((q: unknown) => {
      const quote = q as Record<string, unknown>;
      const sym = safeStr(quote.symbol || quote.ticker || quote.name);
      const price = safeNum(quote.price ?? quote.regularMarketPrice);
      const chg = safeNum(quote.changePercent ?? quote.regularMarketChangePercent);
      if (!sym || !price) return null;
      return `${sym} $${price.toFixed(2)} (${formatChange(chg)})`;
    }).filter((l): l is string => l !== null);
    if (commLines.length) parts.push(`Commodities: ${commLines.join(', ')}`);
  }

  return parts.length ? `Market Data:\n${parts.join('\n')}` : '';
}

function buildMacroSignals(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const verdict = safeStr(d.verdict || d.regime || d.signal);
  const active = Array.isArray(d.activeSignals) ? d.activeSignals : Array.isArray(d.signals) ? d.signals : [];
  const lines: string[] = [];
  if (verdict) lines.push(`Regime: ${verdict}`);
  for (const s of active.slice(0, 4)) {
    const sig = s as Record<string, unknown>;
    const name = safeStr(sig.name || sig.label);
    if (name) lines.push(`- ${name}`);
  }
  return lines.length ? `Macro Signals:\n${lines.join('\n')}` : '';
}

function buildPredictionMarkets(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const all = [
    ...(Array.isArray(d.geopolitical) ? d.geopolitical : []),
    ...(Array.isArray(d.finance) ? d.finance : []),
    ...(Array.isArray(d.tech) ? d.tech : []),
  ].sort((a: unknown, b: unknown) => {
    return safeNum((b as Record<string, unknown>)?.volume) - safeNum((a as Record<string, unknown>)?.volume);
  }).slice(0, 8);

  const lines = all.map((m: unknown) => {
    const market = m as Record<string, unknown>;
    const title = sanitizeHeadline(safeStr(market.title));
    const yes = safeNum(market.yesPrice);
    if (!title) return null;
    return `- "${title}" Yes: ${formatPct(yes > 1 ? yes : yes * 100)}`;
  }).filter((l): l is string => l !== null);

  return lines.length ? `Prediction Markets:\n${lines.join('\n')}` : '';
}

function buildCountryBrief(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const brief = safeStr(d.brief || d.analysis || d.content || d.summary);
  const country = safeStr(d.countryName || d.country || d.name);
  if (!brief) return '';
  return `Country Focus${country ? ` — ${country}` : ''}:\n${brief.slice(0, 500)}`;
}

// ── Keyword extraction (shared by GDELT + digest search) ─────────────────────

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','who','what','where',
  'when','why','how','which','that','this','these','those',
  'and','or','but','not','no','nor','so','yet','both','either',
  'in','on','at','by','for','with','about','against','between',
  'into','through','of','to','from','up','down','me','i','we',
  'you','he','she','it','they','them','their','our','your','its',
  'tell','list','give','show','explain','describe','many','some',
  'any','all','more','most','than','then','just','also','now',
]);

const MAX_KEYWORDS = 8;

// 2-letter tokens that are high-signal in news retrieval regardless of how
// the user typed them (lowercase queries like "us sanctions" or "ai exports"
// are just as valid as "US sanctions" or "AI exports").
const KNOWN_2CHAR_ACRONYMS = new Set(['us', 'uk', 'eu', 'un', 'ai']);

export function extractKeywords(query: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of query.split(/\W+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    // Preserve 2-char tokens that are either known acronyms (case-insensitive)
    // or typed in uppercase — both signal intentional abbreviation.
    if (raw.length === 2 && (KNOWN_2CHAR_ACRONYMS.has(lower) || /^[A-Z]{2}$/.test(raw))) {
      if (!seen.has(lower)) { seen.add(lower); result.push(lower); }
      continue;
    }
    if (lower.length > 2 && !STOPWORDS.has(lower) && !seen.has(lower)) {
      seen.add(lower);
      result.push(lower);
    }
  }
  return result.slice(0, MAX_KEYWORDS);
}

// ── GDELT live headlines ──────────────────────────────────────────────────────

async function buildLiveHeadlines(domainFocus: string, keywords: string[]): Promise<string> {
  const baseTopic = GDELT_TOPICS[domainFocus] ?? 'geopolitical conflict markets economy';
  // Append up to 3 user keywords to surface topic-relevant live articles.
  const extraTerms = keywords.slice(0, 3).join(' ');
  const topic = extraTerms ? `${baseTopic} ${extraTerms}` : baseTopic;
  try {
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    url.searchParams.set('mode', 'ArtList');
    url.searchParams.set('maxrecords', '5');
    url.searchParams.set('query', topic);
    url.searchParams.set('format', 'json');
    url.searchParams.set('timespan', '2h');
    url.searchParams.set('sort', 'DateDesc');

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(2_500),
    });

    if (!res.ok) return '';

    const data = await res.json() as { articles?: Array<{ title?: string; domain?: string; seendate?: string }> };
    const articles = (data.articles ?? []).slice(0, 5);
    if (articles.length === 0) return '';

    const lines = articles.map((a) => {
      const title = sanitizeForPrompt(safeStr(a.title)) ?? '';
      const source = safeStr(a.domain).slice(0, 40);
      if (!title) return null;
      return `- ${title}${source ? ` (${source})` : ''}`;
    }).filter((l): l is string => l !== null);

    return lines.length ? `Latest Headlines:\n${lines.join('\n')}` : '';
  } catch {
    return '';
  }
}

// ── Digest keyword search ─────────────────────────────────────────────────────

const DIGEST_KEY_EN = 'news:digest:v1:full:en';
const MAX_RELEVANT_ARTICLES = 8;

interface DigestItem {
  title: string;
  source?: string;
  link?: string;
  publishedAt?: number;
  importanceScore?: number;
}

function flattenDigest(digest: unknown): DigestItem[] {
  if (!digest || typeof digest !== 'object') return [];
  const d = digest as Record<string, unknown>;

  if (Array.isArray(d)) return d as DigestItem[];

  if (d.categories && typeof d.categories === 'object') {
    const items: DigestItem[] = [];
    for (const bucket of Object.values(d.categories as Record<string, unknown>)) {
      const b = bucket as Record<string, unknown>;
      if (Array.isArray(b.items)) items.push(...(b.items as DigestItem[]));
    }
    return items;
  }

  if (Array.isArray(d.items)) return d.items as DigestItem[];
  return [];
}

function scoreArticle(title: string, keywords: string[]): number {
  const tokens = tokenizeForMatch(title);
  const matched = findMatchingKeywords(tokens, keywords);
  const hits = matched.length;
  if (hits === 0) return 0;
  // Boost when any two adjacent keywords co-occur consecutively in the title.
  // Using raw substring on lowercased title for the pair check is intentional:
  // false positives for two-word combinations are rare enough not to matter.
  const lower = title.toLowerCase();
  const hasAdjacentPair = keywords.length > 1 &&
    keywords.slice(0, -1).some((kw, i) => lower.includes(`${kw} ${keywords[i + 1]!}`));
  return (hasAdjacentPair ? 3 : 1) * hits;
}

async function searchDigestByKeywords(keywords: string[]): Promise<string> {
  if (keywords.length === 0) return '';

  let digest: unknown;
  try {
    digest = await getCachedJson(DIGEST_KEY_EN, true);
  } catch {
    return '';
  }
  if (!digest) return '';

  const items = flattenDigest(digest);
  if (items.length === 0) return '';

  const scored = items
    .map((item) => {
      const title = safeStr(item.title);
      if (!title) return null;
      const kwScore = scoreArticle(title, keywords);
      if (kwScore === 0) return null;
      const importance = safeNum(item.importanceScore);
      return { item, total: kwScore * Math.log1p(importance > 0 ? importance : 1) };
    })
    .filter((x): x is { item: DigestItem; total: number } => x !== null)
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_RELEVANT_ARTICLES);

  if (scored.length === 0) return '';

  const lines = scored.map(({ item }) => {
    const title = sanitizeHeadline(safeStr(item.title));
    const source = safeStr(item.source).slice(0, 40);
    const ts = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const meta = [source, ts].filter(Boolean).join(', ');
    return `- ${title}${meta ? ` (${meta})` : ''}`;
  });

  return `Matched News Articles:\n${lines.join('\n')}`;
}

// ── Source labels ─────────────────────────────────────────────────────────────

const SOURCE_LABELS: Array<[keyof Omit<AnalystContext, 'timestamp' | 'degraded' | 'activeSources'>, string]> = [
  ['relevantArticles', 'Articles'],
  ['worldBrief', 'Brief'],
  ['riskScores', 'Risk'],
  ['marketImplications', 'Signals'],
  ['forecasts', 'Forecasts'],
  ['marketData', 'Markets'],
  ['macroSignals', 'Macro'],
  ['predictionMarkets', 'Prediction'],
  ['countryBrief', 'Country'],
  ['liveHeadlines', 'Live'],
];

export async function assembleAnalystContext(
  geoContext?: string,
  domainFocus?: string,
  userQuery?: string,
): Promise<AnalystContext> {
  const keys = {
    insights: 'news:insights:v1',
    riskScores: 'risk:scores:sebuf:stale:v1',
    marketImplications: 'intelligence:market-implications:v1',
    forecasts: 'forecast:predictions:v2',
    stocks: 'market:stocks-bootstrap:v1',
    commodities: 'market:commodities-bootstrap:v1',
    macroSignals: 'economic:macro-signals:v1',
    predictions: 'prediction:markets-bootstrap:v1',
  };

  const countryKey = geoContext && /^[A-Z]{2}$/.test(geoContext.toUpperCase())
    ? `intelligence:country-brief:v1:${geoContext.toUpperCase()}`
    : null;

  const resolvedDomain = domainFocus ?? 'all';
  const keywords = userQuery ? extractKeywords(userQuery) : [];

  const [
    insightsResult,
    riskResult,
    marketImplResult,
    forecastsResult,
    stocksResult,
    commoditiesResult,
    macroResult,
    predResult,
    countryResult,
    headlinesResult,
    relevantArticlesResult,
  ] = await Promise.allSettled([
    getCachedJson(keys.insights, true),
    getCachedJson(keys.riskScores, true),
    getCachedJson(keys.marketImplications, true),
    getCachedJson(keys.forecasts, true),
    getCachedJson(keys.stocks, true),
    getCachedJson(keys.commodities, true),
    getCachedJson(keys.macroSignals, true),
    getCachedJson(keys.predictions, true),
    countryKey ? getCachedJson(countryKey, true) : Promise.resolve(null),
    buildLiveHeadlines(resolvedDomain, keywords),
    keywords.length > 0 ? searchDigestByKeywords(keywords) : Promise.resolve(''),
  ]);

  const get = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled' ? r.value : null;

  const getStr = (r: PromiseSettledResult<unknown>): string =>
    r.status === 'fulfilled' && typeof r.value === 'string' ? r.value : '';

  const failCount = [insightsResult, riskResult, marketImplResult, forecastsResult,
    stocksResult, commoditiesResult, macroResult, predResult]
    .filter((r) => r.status === 'rejected' || !r.value).length;

  const ctx: AnalystContext = {
    timestamp: new Date().toUTCString(),
    worldBrief: buildWorldBrief(get(insightsResult)),
    riskScores: buildRiskScores(get(riskResult)),
    marketImplications: buildMarketImplications(get(marketImplResult)),
    forecasts: buildForecasts(get(forecastsResult)),
    marketData: buildMarketData(get(stocksResult), get(commoditiesResult)),
    macroSignals: buildMacroSignals(get(macroResult)),
    predictionMarkets: buildPredictionMarkets(get(predResult)),
    countryBrief: buildCountryBrief(get(countryResult)),
    liveHeadlines: getStr(headlinesResult),
    relevantArticles: getStr(relevantArticlesResult),
    activeSources: [],
    degraded: failCount > 4,
  };

  ctx.activeSources = SOURCE_LABELS
    .filter(([field]) => Boolean(ctx[field]))
    .map(([, label]) => label);

  return ctx;
}
