import type { MarketData, NewsItem } from '@/types';
import type { MarketWatchlistEntry } from './market-watchlist';
import { getMarketWatchlistEntries } from './market-watchlist';
import type { SummarizationResult } from './summarization';

export interface DailyMarketBriefItem {
  symbol: string;
  name: string;
  display: string;
  price: number | null;
  change: number | null;
  stance: 'bullish' | 'neutral' | 'defensive';
  note: string;
  relatedHeadline?: string;
}

export interface DailyMarketBrief {
  available: boolean;
  title: string;
  dateKey: string;
  timezone: string;
  summary: string;
  actionPlan: string;
  riskWatch: string;
  items: DailyMarketBriefItem[];
  provider: string;
  model: string;
  fallback: boolean;
  generatedAt: string;
  headlineCount: number;
}

export interface RegimeMacroContext {
  compositeScore: number;
  compositeLabel: string;
  fsiValue: number;
  fsiLabel: string;
  vix: number;
  hySpread: number;
  cnnFearGreed: number;
  cnnLabel: string;
  momentum?: { score: number };
  sentiment?: { score: number };
}

export interface YieldCurveContext {
  inverted: boolean;
  spread2s10s: number;
  rate2y: number;
  rate10y: number;
  rate30y: number;
}

export interface SectorBriefContext {
  topName: string;
  topChange: number;
  worstName: string;
  worstChange: number;
  countPositive: number;
  total: number;
}

export interface BuildDailyMarketBriefOptions {
  markets: MarketData[];
  newsByCategory: Record<string, NewsItem[]>;
  timezone?: string;
  now?: Date;
  targets?: MarketWatchlistEntry[];
  regimeContext?: RegimeMacroContext;
  yieldCurveContext?: YieldCurveContext;
  sectorContext?: SectorBriefContext;
  frameworkAppend?: string;
  newsCategories?: string[];
  summarize?: (
    headlines: string[],
    onProgress?: undefined,
    geoContext?: string,
    lang?: string,
  ) => Promise<SummarizationResult | null>;
}

async function getDefaultSummarizer(): Promise<NonNullable<BuildDailyMarketBriefOptions['summarize']>> {
  const { generateSummary } = await import('./summarization');
  return generateSummary;
}

async function getPersistentCacheApi(): Promise<{
  getPersistentCache: <T>(key: string) => Promise<{ data: T } | null>;
  setPersistentCache: <T>(key: string, data: T) => Promise<void>;
}> {
  const { getPersistentCache, setPersistentCache } = await import('./persistent-cache');
  return { getPersistentCache, setPersistentCache };
}

const CACHE_PREFIX = 'premium:daily-market-brief:v1';
const DEFAULT_SCHEDULE_HOUR = 8;
const DEFAULT_TARGET_COUNT = 4;
const BRIEF_NEWS_CATEGORIES = ['markets', 'economic', 'crypto', 'finance'];
const COMMON_NAME_TOKENS = new Set(['inc', 'corp', 'group', 'holdings', 'company', 'companies', 'class', 'common', 'plc', 'limited', 'ltd', 'adr']);

function resolveTimeZone(timezone?: string): string {
  const candidate = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

function getLocalDateParts(date: Date, timezone: string): { year: string; month: string; day: string; hour: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value || '';
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
  };
}

function getDateKey(date: Date, timezone: string): string {
  const parts = getLocalDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLocalHour(date: Date, timezone: string): number {
  return Number.parseInt(getLocalDateParts(date, timezone).hour || '0', 10) || 0;
}

function formatTitleDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimeZone(timezone),
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function sanitizeCacheKeyPart(value: string): string {
  return value.replace(/[^a-z0-9/_-]+/gi, '-').toLowerCase();
}

function getCacheKey(timezone: string): string {
  return `${CACHE_PREFIX}:${sanitizeCacheKeyPart(resolveTimeZone(timezone))}`;
}

function isMeaningfulToken(token: string): boolean {
  return token.length >= 3 && !COMMON_NAME_TOKENS.has(token);
}

function getSymbolTokens(item: Pick<MarketData, 'symbol' | 'display' | 'name'>): string[] {
  const raw = [
    item.symbol,
    item.display,
    ...item.name.toLowerCase().split(/[^a-z0-9]+/gi),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    const normalized = token.trim().toLowerCase();
    if (!isMeaningfulToken(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function matchesMarketHeadline(market: Pick<MarketData, 'symbol' | 'display' | 'name'>, title: string): boolean {
  const normalizedTitle = title.toLowerCase();
  return getSymbolTokens(market).some((token) => {
    if (token.length <= 4) {
      return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(normalizedTitle);
    }
    return normalizedTitle.includes(token);
  });
}

function collectHeadlinePool(newsByCategory: Record<string, NewsItem[]>, extraCategories?: string[]): NewsItem[] {
  const cats = extraCategories ?? BRIEF_NEWS_CATEGORIES;
  return cats
    .flatMap((category) => newsByCategory[category] || [])
    .filter((item) => !!item?.title)
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

function resolveTargets(markets: MarketData[], explicitTargets?: MarketWatchlistEntry[]): MarketData[] {
  const explicitEntries = explicitTargets?.length ? explicitTargets : null;
  const watchlistEntries = explicitEntries ? null : getMarketWatchlistEntries();
  const targetEntries = explicitEntries || (watchlistEntries && watchlistEntries.length > 0 ? watchlistEntries : []);

  const bySymbol = new Map(markets.map((market) => [market.symbol, market]));
  const resolved: MarketData[] = [];
  const seen = new Set<string>();

  for (const entry of targetEntries) {
    const match = bySymbol.get(entry.symbol);
    if (!match || seen.has(match.symbol)) continue;
    seen.add(match.symbol);
    resolved.push(match);
    if (resolved.length >= DEFAULT_TARGET_COUNT) return resolved;
  }

  if (!explicitEntries && !(watchlistEntries && watchlistEntries.length > 0)) {
    for (const market of markets) {
      if (seen.has(market.symbol)) continue;
      seen.add(market.symbol);
      resolved.push(market);
      if (resolved.length >= DEFAULT_TARGET_COUNT) break;
    }
  }

  return resolved;
}

function getStance(change: number | null): DailyMarketBriefItem['stance'] {
  if (typeof change !== 'number') return 'neutral';
  if (change >= 1) return 'bullish';
  if (change <= -1) return 'defensive';
  return 'neutral';
}

function formatSignedPercent(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'flat';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function buildItemNote(change: number | null, relatedHeadline?: string): string {
  const stance = getStance(change);
  const moveNote = stance === 'bullish'
    ? 'Momentum is constructive; favor leaders over laggards.'
    : stance === 'defensive'
      ? 'Price action is under pressure; protect capital first.'
      : 'Tape is balanced; wait for confirmation before pressing size.';
  return relatedHeadline
    ? `${moveNote} Headline driver: ${relatedHeadline}`
    : moveNote;
}

function buildRuleSummary(items: DailyMarketBriefItem[], headlineCount: number): string {
  const bullish = items.filter((item) => item.stance === 'bullish').length;
  const defensive = items.filter((item) => item.stance === 'defensive').length;
  const neutral = items.length - bullish - defensive;

  const bias = bullish > defensive
    ? 'Risk appetite is leaning positive across the tracked watchlist.'
    : defensive > bullish
      ? 'The watchlist is trading defensively and breadth is soft.'
      : 'The watchlist is mixed and conviction is limited.';

  const breadth = `Leaders: ${bullish}, neutral setups: ${neutral}, defensive names: ${defensive}.`;
  const headlines = headlineCount > 0
    ? `News flow remains active with ${headlineCount} relevant headline${headlineCount === 1 ? '' : 's'} in scope.`
    : 'Headline flow is thin, so price action matters more than narrative today.';

  return `${bias} ${breadth} ${headlines}`;
}

function buildActionPlan(items: DailyMarketBriefItem[], headlineCount: number): string {
  const bullish = items.filter((item) => item.stance === 'bullish').length;
  const defensive = items.filter((item) => item.stance === 'defensive').length;

  if (defensive > bullish) {
    return headlineCount > 0
      ? 'Keep gross exposure light, wait for downside to stabilize, and let macro headlines clear before adding risk.'
      : 'Keep exposure light and wait for price to reclaim short-term momentum before adding risk.';
  }

  if (bullish >= 2) {
    return headlineCount > 0
      ? 'Lean into relative strength, but size entries around macro releases and company-specific headlines.'
      : 'Lean into the strongest names on pullbacks and avoid chasing extended opening moves.';
  }

  return 'Stay selective, trade the cleanest relative-strength setups, and let index direction confirm before scaling.';
}

function buildRiskWatch(items: DailyMarketBriefItem[], headlines: NewsItem[]): string {
  const defensive = items.filter((item) => item.stance === 'defensive').map((item) => item.display);
  const headlineTitles = headlines.slice(0, 2).map((item) => item.title);

  if (defensive.length > 0 && headlineTitles.length > 0) {
    return `Watch ${defensive.join(', ')} for further weakness while monitoring: ${headlineTitles.join(' | ')}`;
  }
  if (defensive.length > 0) {
    return `Watch ${defensive.join(', ')} for further weakness and avoid averaging into fading momentum.`;
  }
  if (headlineTitles.length > 0) {
    return `Headline watch: ${headlineTitles.join(' | ')}`;
  }
  return 'Risk watch is centered on macro follow-through, index breadth, and any abrupt reversal in the strongest names.';
}

function buildSummaryInputs(items: DailyMarketBriefItem[], headlines: NewsItem[]): { headlines: string[]; marketContext: string } {
  const marketContext = items.map((item) => {
    const change = formatSignedPercent(item.change);
    return `${item.name} (${item.display}) ${change}`;
  }).join(', ');

  const headlineLines = headlines.slice(0, 6).map((item) => item.title.trim()).filter(Boolean);
  return { headlines: headlineLines, marketContext };
}

function buildExtendedMarketContext(
  baseContext: string,
  regime?: RegimeMacroContext,
  yieldCurve?: YieldCurveContext,
  sector?: SectorBriefContext,
): string {
  const parts: string[] = [`Markets: ${baseContext}`];

  if (regime && regime.compositeScore > 0) {
    const lines = [
      `Fear & Greed: ${regime.compositeScore.toFixed(0)} (${regime.compositeLabel})`,
    ];
    if (regime.fsiValue > 0) lines.push(`FSI: ${regime.fsiValue.toFixed(2)} (${regime.fsiLabel})`);
    if (regime.vix > 0) lines.push(`VIX: ${regime.vix.toFixed(1)}`);
    if (regime.hySpread > 0) lines.push(`HY Spread: ${regime.hySpread.toFixed(0)}bps`);
    if (regime.cnnFearGreed > 0) lines.push(`CNN F&G: ${regime.cnnFearGreed.toFixed(0)} (${regime.cnnLabel})`);
    if (regime.momentum) lines.push(`Momentum: ${regime.momentum.score.toFixed(0)}/100`);
    if (regime.sentiment) lines.push(`Sentiment: ${regime.sentiment.score.toFixed(0)}/100`);
    parts.push(`Market Stress Indicators:\n${lines.join('\n')}`);
  }

  if (yieldCurve && yieldCurve.rate10y > 0) {
    const spreadStr = (yieldCurve.spread2s10s >= 0 ? '+' : '') + yieldCurve.spread2s10s.toFixed(0);
    parts.push([
      `Yield Curve: ${yieldCurve.inverted ? 'INVERTED' : 'NORMAL'} (2s/10s ${spreadStr}bps)`,
      `2Y: ${yieldCurve.rate2y.toFixed(2)}%  10Y: ${yieldCurve.rate10y.toFixed(2)}%  30Y: ${yieldCurve.rate30y.toFixed(2)}%`,
    ].join('\n'));
  }

  if (sector && sector.total > 0) {
    const topSign = sector.topChange >= 0 ? '+' : '';
    const worstSign = sector.worstChange >= 0 ? '+' : '';
    parts.push([
      `Sectors: ${sector.countPositive}/${sector.total} positive`,
      `Top: ${sector.topName} ${topSign}${sector.topChange.toFixed(1)}%  Worst: ${sector.worstName} ${worstSign}${sector.worstChange.toFixed(1)}%`,
    ].join('\n'));
  }

  return parts.join('\n\n');
}

export function shouldRefreshDailyBrief(
  brief: DailyMarketBrief | null | undefined,
  timezone = 'UTC',
  now = new Date(),
  scheduleHour = DEFAULT_SCHEDULE_HOUR,
): boolean {
  if (!brief?.available) return true;
  const resolvedTimezone = resolveTimeZone(timezone || brief.timezone);
  const dateKey = getDateKey(now, resolvedTimezone);
  if (brief.dateKey === dateKey) return false;
  return getLocalHour(now, resolvedTimezone) >= scheduleHour;
}

export async function getCachedDailyMarketBrief(timezone?: string): Promise<DailyMarketBrief | null> {
  const resolvedTimezone = resolveTimeZone(timezone);
  const { getPersistentCache } = await getPersistentCacheApi();
  const envelope = await getPersistentCache<DailyMarketBrief>(getCacheKey(resolvedTimezone));
  return envelope?.data ?? null;
}

export async function cacheDailyMarketBrief(brief: DailyMarketBrief): Promise<void> {
  const { setPersistentCache } = await getPersistentCacheApi();
  await setPersistentCache(getCacheKey(brief.timezone), brief);
}

export async function buildDailyMarketBrief(options: BuildDailyMarketBriefOptions): Promise<DailyMarketBrief> {
  const now = options.now || new Date();
  const timezone = resolveTimeZone(options.timezone);
  const trackedMarkets = resolveTargets(options.markets, options.targets).slice(0, DEFAULT_TARGET_COUNT);
  const relevantHeadlines = collectHeadlinePool(options.newsByCategory, options.newsCategories);

  const items: DailyMarketBriefItem[] = trackedMarkets.map((market) => {
    const relatedHeadline = relevantHeadlines.find((headline) => matchesMarketHeadline(market, headline.title))?.title;
    return {
      symbol: market.symbol,
      name: market.name,
      display: market.display,
      price: market.price,
      change: market.change,
      stance: getStance(market.change),
      note: buildItemNote(market.change, relatedHeadline),
      ...(relatedHeadline ? { relatedHeadline } : {}),
    };
  });

  if (items.length === 0) {
    return {
      available: false,
      title: `Daily Market Brief • ${formatTitleDate(now, timezone)}`,
      dateKey: getDateKey(now, timezone),
      timezone,
      summary: 'Market data is not available yet for the daily brief.',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: now.toISOString(),
      headlineCount: 0,
    };
  }

  const { headlines: summaryHeadlines, marketContext } = buildSummaryInputs(items, relevantHeadlines);
  let extendedContext = buildExtendedMarketContext(marketContext, options.regimeContext, options.yieldCurveContext, options.sectorContext);
  if (options.frameworkAppend) {
    extendedContext = `${extendedContext}\n\n---\nAnalytical Framework:\n${options.frameworkAppend}`;
  }
  let summary = buildRuleSummary(items, relevantHeadlines.length);
  let provider = 'rules';
  let model = '';
  let fallback = true;

  if (summaryHeadlines.length >= 1) {
    try {
      const summaryProvider = options.summarize || await getDefaultSummarizer();
      const generated = await summaryProvider(
        summaryHeadlines,
        undefined,
        extendedContext,
        'en',
      );
      if (generated?.summary) {
        summary = generated.summary.trim();
        provider = generated.provider;
        model = generated.model;
        fallback = false;
      }
    } catch (err) {
      console.warn('[DailyBrief] AI summarization failed, using rules-based fallback:', (err as Error).message);
    }
  }

  return {
    available: true,
    title: `Daily Market Brief • ${formatTitleDate(now, timezone)}`,
    dateKey: getDateKey(now, timezone),
    timezone,
    summary,
    actionPlan: buildActionPlan(items, relevantHeadlines.length),
    riskWatch: buildRiskWatch(items, relevantHeadlines),
    items,
    provider,
    model,
    fallback,
    generatedAt: now.toISOString(),
    headlineCount: relevantHeadlines.length,
  };
}
