import { getCachedJson } from '../../../_shared/redis';
import { sanitizeForPrompt, sanitizeHeadline } from '../../../_shared/llm-sanitize.js';
import { CHROME_UA } from '../../../_shared/constants';
import { tokenizeForMatch, findMatchingKeywords } from '../../../../src/utils/keyword-match';
import {
  GAS_STORAGE_COUNTRIES_KEY,
  GAS_STORAGE_KEY_PREFIX,
  ELECTRICITY_INDEX_KEY,
  ENERGY_INTELLIGENCE_KEY,
  SPR_KEY,
  REFINERY_UTIL_KEY,
  ENERGY_SPINE_KEY_PREFIX,
} from '../../../_shared/cache-keys';

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
  energyExposure: string;
  coalSpotPrice: string;
  gasSpotTtf: string;
  activeSources: string[];
  degraded: boolean;
  gasStorage?: string;
  electricityPrices?: string;
  energyIntelligence?: string;
  sprLevel?: string;
  refineryUtil?: string;
  productSupply?: string;
  gasFlows?: string;
  oilStocksCover?: string;
  electricityMix?: string;
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

function buildEnergyExposure(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const year = typeof d.year === 'number' ? d.year : '';
  const lines: string[] = [`Energy Generation Mix — ${year || 'recent'} data:`];

  const fuelLabels: Array<[string, string]> = [
    ['gas',       'Gas-dependent (% electricity from gas)'],
    ['coal',      'Coal-dependent'],
    ['oil',       'Oil-dependent'],
    ['imported',  'Net energy importers (% demand)'],
    ['renewable', 'Renewables-insulated'],
  ];

  for (const [fuel, label] of fuelLabels) {
    const entries = Array.isArray(d[fuel])
      ? (d[fuel] as Array<Record<string, unknown>>).slice(0, 8)
      : [];
    if (!entries.length) continue;
    const formatted = entries
      .map((e) => `${safeStr(e.name)} ${typeof e.share === 'number' ? e.share.toFixed(0) : '?'}%`)
      .join(', ');
    lines.push(`${label}: ${formatted}`);
  }
  lines.push('(Gas figures are total gas mix; LNG vs. pipeline split not in this dataset.)');
  return lines.join('\n');
}

function extractCommodityQuote(commodities: unknown, symbol: string): Record<string, unknown> | null {
  if (!commodities || typeof commodities !== 'object') return null;
  const d = commodities as Record<string, unknown>;
  const quotes = Array.isArray(d.quotes) ? d.quotes : [];
  const q = quotes.find((q: unknown) => {
    const quote = q as Record<string, unknown>;
    return safeStr(quote.symbol) === symbol;
  });
  return q ? (q as Record<string, unknown>) : null;
}

function buildSpotCommodityLine(commodities: unknown, symbol: string, label: string, unit: string, denominator = '/MWh'): string {
  const q = extractCommodityQuote(commodities, symbol);
  if (!q) return '';
  const price = safeNum(q.price);
  const change = safeNum(q.change ?? q.changePercent);
  if (!price) return '';
  const sign = change >= 0 ? '+' : '';
  return `${label}: ${unit}${price.toFixed(2)}${denominator} (${sign}${change.toFixed(2)}% today)`;
}

async function buildGasStorage(): Promise<string | undefined> {
  try {
    const countries = await getCachedJson(GAS_STORAGE_COUNTRIES_KEY, true);
    if (!Array.isArray(countries) || countries.length === 0) return undefined;
    const entries: Array<{ iso2: string; fillPct: number; trend?: string }> = [];
    await Promise.allSettled(
      (countries as string[]).map(async (iso2) => {
        try {
          const data = await getCachedJson(`${GAS_STORAGE_KEY_PREFIX}${iso2}`, true);
          if (data && typeof data === 'object') {
            const d = data as Record<string, unknown>;
            if (typeof d.fillPct === 'number') {
              entries.push({ iso2: safeStr(d.iso2) || iso2, fillPct: d.fillPct, trend: safeStr(d.trend) || undefined });
            }
          }
        } catch {
          // skip missing country
        }
      }),
    );
    if (entries.length === 0) return undefined;
    const sorted = entries.sort((a, b) => a.fillPct - b.fillPct).slice(0, 5);
    const parts = sorted.map((e) => `${e.iso2}: ${e.fillPct.toFixed(1)}%${e.trend ? ` (${e.trend})` : ''}`);
    return parts.join(' | ');
  } catch {
    return undefined;
  }
}

async function buildElectricityPrices(): Promise<string | undefined> {
  try {
    const data = await getCachedJson(ELECTRICITY_INDEX_KEY, true);
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const entries = (data as Array<Record<string, unknown>>)
      .filter((e) => typeof e.price === 'number')
      .sort((a, b) => (b.price as number) - (a.price as number))
      .slice(0, 5);
    if (entries.length === 0) return undefined;
    const parts = entries.map((e) => {
      const region = safeStr(e.region);
      const price = (e.price as number).toFixed(1);
      const currency = safeStr(e.currency);
      const unit = safeStr(e.unit) || 'MWh';
      const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : '€';
      return `${region}: ${sym}${price}/${unit}`;
    });
    return parts.join(' | ');
  } catch {
    return undefined;
  }
}

async function buildEnergyIntelligence(): Promise<string | undefined> {
  try {
    const data = await getCachedJson(ENERGY_INTELLIGENCE_KEY, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
    if (items.length === 0) return undefined;
    const recent = items
      .filter((item) => safeStr(item.title))
      .slice(0, 3);
    if (recent.length === 0) return undefined;
    return recent.map((item) => {
      const source = safeStr(item.source);
      const title = sanitizeHeadline(safeStr(item.title));
      return source ? `${source}: ${title}` : title;
    }).join(' · ');
  } catch {
    return undefined;
  }
}

async function buildSprLevel(): Promise<string | undefined> {
  try {
    const data = await getCachedJson(SPR_KEY, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.barrels !== 'number') return undefined;
    const bbl = (d.barrels as number).toFixed(1);
    const wow = typeof d.changeWoW === 'number' ? d.changeWoW as number : null;
    const wowStr = wow != null ? ` (${wow >= 0 ? '+' : ''}${wow.toFixed(1)}M WoW)` : '';
    return `US SPR: ${bbl}M bbl${wowStr}`;
  } catch {
    return undefined;
  }
}

async function buildRefineryUtil(): Promise<string | undefined> {
  try {
    const data = await getCachedJson(REFINERY_UTIL_KEY, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.inputsMbblpd !== 'number') return undefined;
    const inputs = (d.inputsMbblpd as number).toLocaleString();
    const wow = typeof d.changeWoW === 'number' ? d.changeWoW as number : null;
    const wowStr = wow != null ? ` (${wow >= 0 ? '+' : ''}${wow} WoW)` : '';
    return `US refinery inputs: ${inputs} MBBL/D${wowStr}`;
  } catch {
    return undefined;
  }
}

async function buildProductSupply(iso2: string): Promise<string | undefined> {
  try {
    // Try spine first — single key read
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${iso2}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object' && (spine.coverage as Record<string, unknown> | undefined)?.hasJodiOil) {
      const oil = spine.oil as Record<string, unknown> | undefined;
      const src = spine.sources as Record<string, unknown> | undefined;
      const month = safeStr(src?.jodiOilMonth);
      if (!oil) return undefined;
      const fmt = (v: unknown) => typeof v === 'number' && Number.isFinite(v as number) ? Math.round(v as number) : null;
      const parts: string[] = [];
      for (const [key, label] of [['dieselDemandKbd', 'diesel'], ['jetDemandKbd', 'jet fuel'], ['gasolineDemandKbd', 'gasoline']] as [string, string][]) {
        const demand = fmt(oil[key]);
        if (demand == null) continue;
        parts.push(`${label} ${demand} kbd demand`);
      }
      if (parts.length === 0) return undefined;
      return `Oil product supply${month ? ` (${month})` : ''}: ${parts.join('; ')}`;
    }

    // Fallback to direct key
    const data = await getCachedJson(`energy:jodi-oil:v1:${iso2}`, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const month = safeStr(d.dataMonth);
    const fmt = (v: unknown) => typeof v === 'number' && Number.isFinite(v as number) ? Math.round(v as number) : null;
    const parts: string[] = [];
    for (const [key, label] of [['diesel', 'diesel'], ['jet', 'jet fuel'], ['gasoline', 'gasoline']] as [string, string][]) {
      const prod = d[key] as Record<string, unknown> | undefined;
      if (!prod) continue;
      const demand = fmt(prod.demandKbd);
      if (demand == null) continue;
      const details: string[] = [];
      const imp = fmt(prod.importsKbd);
      if (imp != null && key !== 'gasoline') details.push(`imports ${imp}`);
      if (key === 'diesel') { const ref = fmt(prod.refOutputKbd); if (ref != null) details.push(`refinery ${ref}`); }
      parts.push(`${label} ${demand} kbd demand${details.length ? ` (${details.join(', ')})` : ''}`);
    }
    if (parts.length === 0) return undefined;
    return `Oil product supply${month ? ` (${month})` : ''}: ${parts.join('; ')}`;
  } catch {
    return undefined;
  }
}

async function buildGasFlows(iso2: string): Promise<string | undefined> {
  try {
    // Try spine first
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${iso2}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object' && (spine.coverage as Record<string, unknown> | undefined)?.hasJodiGas) {
      const gas = spine.gas as Record<string, unknown> | undefined;
      if (!gas) return undefined;
      const pipeImports = typeof gas.pipeImportsTj === 'number' ? gas.pipeImportsTj as number : null;
      const lngImports = typeof gas.lngImportsTj === 'number' ? gas.lngImportsTj as number : null;
      const totalImports = (pipeImports ?? 0) + (lngImports ?? 0);
      if (!totalImports) {
        const totalDemand = typeof gas.totalDemandTj === 'number' ? Math.round((gas.totalDemandTj as number) / 1000) : null;
        if (totalDemand != null && totalDemand > 0) {
          return `Gas: domestic supply covers demand (${totalDemand} PJ total demand, no LNG or pipeline imports recorded)`;
        }
        return undefined;
      }
      const totalPj = Math.round(totalImports / 1000);
      const lngShare = typeof gas.lngShareOfImports === 'number' ? Math.round((gas.lngShareOfImports as number) * 100) : null;
      const split = lngShare != null ? ` (LNG ${lngShare}%, pipeline ${100 - lngShare}%)` : '';
      return `Gas: total imports ${totalPj} PJ${split}`;
    }

    // Fallback to direct key
    const data = await getCachedJson(`energy:jodi-gas:v1:${iso2}`, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    const totalTj = typeof d.totalImportsTj === 'number' ? d.totalImportsTj as number : null;
    if (!totalTj) {
      const demandTj = typeof d.totalDemandTj === 'number' ? d.totalDemandTj as number : null;
      if (demandTj != null && demandTj > 0) {
        return `Gas: domestic supply covers demand (${Math.round(demandTj / 1000)} PJ total demand, no LNG or pipeline imports recorded)`;
      }
      return undefined;
    }
    const totalPj = Math.round(totalTj / 1000);
    const lngShare = typeof d.lngShareOfImports === 'number' ? Math.round((d.lngShareOfImports as number) * 100) : null;
    const split = lngShare != null ? ` (LNG ${lngShare}%, pipeline ${100 - lngShare}%)` : '';
    return `Gas: total imports ${totalPj} PJ${split}`;
  } catch {
    return undefined;
  }
}

async function buildOilStocksCover(iso2: string): Promise<string | undefined> {
  try {
    // Try spine first
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${iso2}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object') {
      const cov = spine.coverage as Record<string, unknown> | undefined;
      const oil = spine.oil as Record<string, unknown> | undefined;
      if (oil?.netExporter === true) {
        const crudeImports = typeof oil.crudeImportsKbd === 'number' ? Math.round(oil.crudeImportsKbd as number) : null;
        const importNote = crudeImports != null && crudeImports > 0
          ? ` (still imports ${crudeImports} kbd crude for refinery feedstock)`
          : '';
        return `IEA oil stocks: net oil exporter${importNote}`;
      }
      if (cov?.hasIeaStocks && typeof oil?.daysOfCover === 'number') {
        const days = oil.daysOfCover as number;
        return `IEA oil stocks: ${days} days of cover`;
      }
      // Spine present but no IEA stocks coverage — return undefined (don't fall through)
      if (spine.coverage != null) return undefined;
    }

    // Fallback to direct key
    const data = await getCachedJson(`energy:iea-oil-stocks:v1:${iso2}`, true);
    if (!data || typeof data !== 'object') return undefined;
    const d = data as Record<string, unknown>;
    if (d.netExporter === true) {
      return 'IEA oil stocks: net oil exporter';
    }
    const days = typeof d.daysOfCover === 'number' ? d.daysOfCover as number : null;
    if (days == null) return undefined;
    const threshold = typeof d.obligationThreshold === 'number' ? d.obligationThreshold as number : 90;
    const breach = d.belowObligation === true ? ' (below obligation)' : '';
    return `IEA oil stocks: ${days} days of cover (obligation: ${threshold} days)${breach}`;
  } catch {
    return undefined;
  }
}

function formatMixParts(src: Record<string, unknown>): string[] {
  const pct = (key: string) => {
    const v = src[key];
    return typeof v === 'number' && (v as number) > 1 ? Math.round(v as number) : null;
  };
  const parts: string[] = [];
  const fossilPct = pct('fossilShare');
  if (fossilPct != null) {
    const coalPct = pct('coalShare');
    const gasPct = pct('gasShare');
    const breakdown = [coalPct != null ? `coal ${coalPct}%` : null, gasPct != null ? `gas ${gasPct}%` : null]
      .filter(Boolean).join(', ');
    parts.push(`fossil ${fossilPct}%${breakdown ? ` (${breakdown})` : ''}`);
  }
  const renewPct = pct('renewShare');
  if (renewPct != null) parts.push(`renewable ${renewPct}%`);
  const nuclearPct = pct('nuclearShare');
  if (nuclearPct != null) parts.push(`nuclear ${nuclearPct}%`);
  return parts;
}

async function buildElectricityMix(iso2: string): Promise<string | undefined> {
  try {
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${iso2}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object') {
      const elec = spine.electricity as Record<string, unknown> | undefined;
      if (elec && typeof elec.fossilShare === 'number') {
        const parts = formatMixParts(elec);
        if (parts.length === 0) return undefined;
        const demandTwh = typeof elec.demandTwh === 'number' ? ` (${Math.round(elec.demandTwh as number)} TWh/month)` : '';
        return `Electricity generation mix: ${parts.join(', ')}${demandTwh}`;
      }
    }
    const ember = await getCachedJson(`energy:ember:v1:${iso2}`, true) as Record<string, unknown> | null;
    if (!ember || typeof ember.fossilShare !== 'number') return undefined;
    const parts = formatMixParts(ember as Record<string, unknown>);
    if (parts.length === 0) return undefined;
    const demandTwh = typeof ember.demandTwh === 'number' ? ` (${Math.round(ember.demandTwh as number)} TWh/month)` : '';
    return `Electricity generation mix: ${parts.join(', ')}${demandTwh}`;
  } catch {
    return undefined;
  }
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

  return lines.join('\n');
}

// ── Source labels ─────────────────────────────────────────────────────────────

const SOURCE_LABELS: Array<[keyof Omit<AnalystContext, 'timestamp' | 'degraded' | 'activeSources'>, string]> = [
  ['relevantArticles', 'Articles'],
  ['worldBrief', 'Brief'],
  ['riskScores', 'Risk'],
  ['marketImplications', 'Signals'],
  ['forecasts', 'Forecasts'],
  ['marketData', 'Markets'],
  ['energyExposure', 'EnergyMix'],
  ['coalSpotPrice', 'CoalSpot'],
  ['gasSpotTtf',    'GasTTF'],
  ['macroSignals', 'Macro'],
  ['predictionMarkets', 'Prediction'],
  ['countryBrief', 'Country'],
  ['liveHeadlines', 'Live'],
  ['gasStorage', 'GasStorage'],
  ['electricityPrices', 'Electricity'],
  ['energyIntelligence', 'EnergyIntel'],
  ['sprLevel', 'SPR'],
  ['refineryUtil', 'Refinery'],
  ['productSupply', 'JODIOil'],
  ['gasFlows', 'JODIGas'],
  ['oilStocksCover', 'IEAStocks'],
  ['electricityMix', 'ElecMix'],
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
    energyExposure: 'energy:exposure:v1:index',
  };

  const countryKey = geoContext && /^[A-Z]{2}$/.test(geoContext.toUpperCase())
    ? `intelligence:country-brief:v1:${geoContext.toUpperCase()}`
    : null;

  const resolvedDomain = domainFocus ?? 'all';
  const keywords = userQuery ? extractKeywords(userQuery) : [];

  const ENERGY_EXPOSURE_DOMAINS = new Set(['geo', 'economic', 'all']);
  const needsEnergyExposure = ENERGY_EXPOSURE_DOMAINS.has(resolvedDomain);

  const SPOT_ENERGY_DOMAINS = new Set(['economic', 'geo', 'all']);
  const needsSpotEnergy = SPOT_ENERGY_DOMAINS.has(resolvedDomain);

  const needsGasStorage = new Set(['geo', 'economic', 'all']).has(resolvedDomain);
  const needsElectricity = new Set(['economic', 'all']).has(resolvedDomain);
  const needsEnergyIntel = new Set(['economic', 'geo', 'all']).has(resolvedDomain);
  const needsSpr = new Set(['economic', 'all']).has(resolvedDomain);
  const needsRefinery = new Set(['economic', 'all']).has(resolvedDomain);

  const iso2 = geoContext && /^[A-Z]{2}$/i.test(geoContext) ? geoContext.toUpperCase() : null;
  const needsProductSupply = iso2 != null && new Set(['economic', 'geo', 'all']).has(resolvedDomain);
  const needsGasFlows = iso2 != null && new Set(['economic', 'geo', 'all']).has(resolvedDomain);
  const needsOilStocksCover = iso2 != null && new Set(['economic', 'all']).has(resolvedDomain);
  const needsElectricityMix = iso2 != null && new Set(['economic', 'geo', 'all']).has(resolvedDomain);

  const [
    insightsResult,
    riskResult,
    marketImplResult,
    forecastsResult,
    stocksResult,
    commoditiesResult,
    macroResult,
    predResult,
    energyExposureResult,
    countryResult,
    headlinesResult,
    relevantArticlesResult,
    gasStorageResult,
    electricityResult,
    energyIntelResult,
    sprResult,
    refineryResult,
    productSupplyResult,
    gasFlowsResult,
    oilStocksCoverResult,
    electricityMixResult,
  ] = await Promise.allSettled([
    getCachedJson(keys.insights, true),
    getCachedJson(keys.riskScores, true),
    getCachedJson(keys.marketImplications, true),
    getCachedJson(keys.forecasts, true),
    getCachedJson(keys.stocks, true),
    getCachedJson(keys.commodities, true),
    getCachedJson(keys.macroSignals, true),
    getCachedJson(keys.predictions, true),
    needsEnergyExposure ? getCachedJson(keys.energyExposure, true) : Promise.resolve(null),
    countryKey ? getCachedJson(countryKey, true) : Promise.resolve(null),
    buildLiveHeadlines(resolvedDomain, keywords),
    keywords.length > 0 ? searchDigestByKeywords(keywords) : Promise.resolve(''),
    needsGasStorage ? buildGasStorage() : Promise.resolve(undefined),
    needsElectricity ? buildElectricityPrices() : Promise.resolve(undefined),
    needsEnergyIntel ? buildEnergyIntelligence() : Promise.resolve(undefined),
    needsSpr ? buildSprLevel() : Promise.resolve(undefined),
    needsRefinery ? buildRefineryUtil() : Promise.resolve(undefined),
    needsProductSupply ? buildProductSupply(iso2!) : Promise.resolve(undefined),
    needsGasFlows ? buildGasFlows(iso2!) : Promise.resolve(undefined),
    needsOilStocksCover ? buildOilStocksCover(iso2!) : Promise.resolve(undefined),
    needsElectricityMix ? buildElectricityMix(iso2!) : Promise.resolve(undefined),
  ]);

  const get = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled' ? r.value : null;

  const getStr = (r: PromiseSettledResult<unknown>): string =>
    r.status === 'fulfilled' && typeof r.value === 'string' ? r.value : '';

  const getOptStr = (r: PromiseSettledResult<unknown>): string | undefined => {
    if (r.status !== 'fulfilled') return undefined;
    return typeof r.value === 'string' ? r.value : undefined;
  };

  const coreResults: PromiseSettledResult<unknown>[] = [
    insightsResult, riskResult, marketImplResult, forecastsResult,
    stocksResult, commoditiesResult, macroResult, predResult,
  ];
  if (needsEnergyExposure) coreResults.push(energyExposureResult);
  const failCount = coreResults.filter((r) => r.status === 'rejected' || !r.value).length;

  const commoditiesData = get(commoditiesResult);

  const ctx: AnalystContext = {
    timestamp: new Date().toUTCString(),
    worldBrief: buildWorldBrief(get(insightsResult)),
    riskScores: buildRiskScores(get(riskResult)),
    marketImplications: buildMarketImplications(get(marketImplResult)),
    forecasts: buildForecasts(get(forecastsResult)),
    marketData: buildMarketData(get(stocksResult), commoditiesData),
    macroSignals: buildMacroSignals(get(macroResult)),
    energyExposure: buildEnergyExposure(get(energyExposureResult)),
    coalSpotPrice: needsSpotEnergy ? buildSpotCommodityLine(get(commoditiesResult), 'MTF=F', 'Newcastle coal', '$', '/t') : '',
    gasSpotTtf:    needsSpotEnergy ? buildSpotCommodityLine(get(commoditiesResult), 'TTF=F', 'TTF gas', '€')            : '',
    predictionMarkets: buildPredictionMarkets(get(predResult)),
    countryBrief: buildCountryBrief(get(countryResult)),
    liveHeadlines: getStr(headlinesResult),
    relevantArticles: getStr(relevantArticlesResult),
    activeSources: [],
    degraded: failCount > 4,
    gasStorage: getOptStr(gasStorageResult),
    electricityPrices: getOptStr(electricityResult),
    energyIntelligence: getOptStr(energyIntelResult),
    sprLevel: getOptStr(sprResult),
    refineryUtil: getOptStr(refineryResult),
    productSupply: getOptStr(productSupplyResult),
    gasFlows: getOptStr(gasFlowsResult),
    oilStocksCover: getOptStr(oilStocksCoverResult),
    electricityMix: getOptStr(electricityMixResult),
  };

  ctx.activeSources = SOURCE_LABELS
    .filter(([field]) => Boolean(ctx[field]))
    .map(([, label]) => label);

  return ctx;
}
