import { getCachedJson } from '../../../_shared/redis';
import { sanitizeHeadline } from '../../../_shared/llm-sanitize.js';

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
    const probStr = prob > 0 ? ` — ${formatPct(prob * 100 > 1 ? prob : prob * 100)}` : '';
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

export async function assembleAnalystContext(
  geoContext?: string,
  _domainFocus?: string,
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
  ] = await Promise.allSettled([
    getCachedJson(keys.insights, true).catch(() => null),
    getCachedJson(keys.riskScores, true).catch(() => null),
    getCachedJson(keys.marketImplications, true).catch(() => null),
    getCachedJson(keys.forecasts, true).catch(() => null),
    getCachedJson(keys.stocks, true).catch(() => null),
    getCachedJson(keys.commodities, true).catch(() => null),
    getCachedJson(keys.macroSignals, true).catch(() => null),
    getCachedJson(keys.predictions, true).catch(() => null),
    countryKey ? getCachedJson(countryKey, true).catch(() => null) : Promise.resolve(null),
  ]);

  const get = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled' ? r.value : null;

  const failCount = [insightsResult, riskResult, marketImplResult, forecastsResult,
    stocksResult, commoditiesResult, macroResult, predResult]
    .filter((r) => r.status === 'rejected' || !r.value).length;

  return {
    timestamp: new Date().toUTCString(),
    worldBrief: buildWorldBrief(get(insightsResult)),
    riskScores: buildRiskScores(get(riskResult)),
    marketImplications: buildMarketImplications(get(marketImplResult)),
    forecasts: buildForecasts(get(forecastsResult)),
    marketData: buildMarketData(get(stocksResult), get(commoditiesResult)),
    macroSignals: buildMacroSignals(get(macroResult)),
    predictionMarkets: buildPredictionMarkets(get(predResult)),
    countryBrief: buildCountryBrief(get(countryResult)),
    degraded: failCount > 4,
  };
}
