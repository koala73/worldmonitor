import type { AppContext } from '@/app/app-context';
import type { DomainAdapter, SignalEvidence } from '../types';

const WEIGHTS: Record<string, number> = {
  market_move: 0.35,
  sanctions_news: 0.30,
  commodity_spike: 0.35,
};

const SANCTIONS_KEYWORDS = /\b(sanction|tariff|embargo|trade\s+war|ban|restrict|block|seize|freeze\s+assets|export\s+control|blacklist|decouple|decoupl|subsid|dumping|countervail|quota|levy|excise|retaliat|currency\s+manipulat|capital\s+controls|swift|cbdc|petrodollar|de-?dollar|opec|cartel|price\s+cap|oil|crude|commodity|shortage|stockpile|strategic\s+reserve|supply\s+chain|rare\s+earth|chip\s+ban|semiconductor|economic\s+warfare|financial\s+weapon)\b/i;
const COMMODITY_SYMBOLS = new Set(['CL=F', 'GC=F', 'NG=F', 'SI=F', 'HG=F', 'ZW=F', 'BTC-USD', 'BZ=F', 'ETH-USD', 'KC=F', 'SB=F', 'CT=F', 'CC=F']);
const SIGNIFICANT_CHANGE_PCT = 1.5;

export const economicAdapter: DomainAdapter = {
  domain: 'economic',
  label: 'Economic Warfare',
  clusterMode: 'entity',
  spatialRadius: 0,
  timeWindow: 24,
  threshold: 20,
  weights: WEIGHTS,

  collectSignals(ctx: AppContext): SignalEvidence[] {
    const signals: SignalEvidence[] = [];
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;

    // Market moves (commodities + crypto)
    const markets = ctx.latestMarkets ?? [];
    for (const m of markets) {
      if (m.change == null || m.price == null) continue;
      const absPct = Math.abs(m.change);
      if (absPct < SIGNIFICANT_CHANGE_PCT) continue;

      const isCommodity = COMMODITY_SYMBOLS.has(m.symbol);
      const type = isCommodity ? 'commodity_spike' : 'market_move';
      const severity = Math.min(100, absPct * 10);

      // Market data from latestMarkets is always current-session quotes
      // (no per-quote timestamp available on MarketDataCore), so use `now`.
      signals.push({
        type,
        source: 'markets',
        severity,
        timestamp: now,
        label: `${m.display ?? m.symbol} ${m.change > 0 ? '+' : ''}${m.change.toFixed(1)}%`,
        rawData: m,
      });
    }

    // Sanctions/trade news clusters
    const clusters = ctx.latestClusters ?? [];
    for (const c of clusters) {
      const age = now - (c.lastUpdated.getTime());
      if (age > windowMs) continue;
      if (!SANCTIONS_KEYWORDS.test(c.primaryTitle)) continue;

      const severity = c.threat?.level === 'critical' ? 85
        : c.threat?.level === 'high' ? 70
        : 50;

      signals.push({
        type: 'sanctions_news',
        source: 'analysis-core',
        severity,
        timestamp: c.lastUpdated.getTime(),
        label: c.primaryTitle,
        rawData: c,
      });
    }

    return signals;
  },

  generateTitle(cluster: SignalEvidence[], context?: { entityKey?: string; country?: string }): string {
    const types = new Set(cluster.map(s => s.type));
    const entity = context?.entityKey;

    if (types.has('commodity_spike')) {
      const spikes = cluster.filter(s => s.type === 'commodity_spike');
      const names = spikes
        .map(s => (s.rawData as { display?: string; symbol?: string })?.display
          ?? (s.rawData as { symbol?: string })?.symbol
          ?? s.label.split(' ')[0])
        .slice(0, 2);
      const pctParts = spikes
        .map(s => {
          const change = (s.rawData as { change?: number })?.change;
          return change != null ? `${change > 0 ? '+' : ''}${change.toFixed(1)}%` : null;
        })
        .filter(Boolean);
      const pctSuffix = pctParts.length > 0 ? ` (${pctParts[0]})` : '';
      const base = `${names.join('/')} spike${pctSuffix}`;
      if (types.has('sanctions_news')) return `${base} + sanctions`;
      return base;
    }

    if (types.has('sanctions_news')) {
      const labels = cluster.filter(s => s.type === 'sanctions_news').map(s => s.label);
      const countries = extractMentionedEntities(labels);
      const qualifier = countries || displayEntity(entity) || '';
      const sanctionsBase = qualifier ? `${qualifier} sanctions activity` : 'Sanctions activity';
      if (types.has('market_move')) {
        const movers = cluster.filter(s => s.type === 'market_move');
        const moverNames = movers
          .map(s => (s.rawData as { display?: string; symbol?: string })?.display
            ?? (s.rawData as { symbol?: string })?.symbol
            ?? s.label.split(' ')[0])
          .slice(0, 2);
        return `${sanctionsBase} + ${moverNames.join('/')} disruption`;
      }
      return sanctionsBase;
    }

    if (types.has('market_move')) {
      const movers = cluster.filter(s => s.type === 'market_move');
      const names = movers
        .map(s => (s.rawData as { display?: string; symbol?: string })?.display
          ?? (s.rawData as { symbol?: string })?.symbol
          ?? s.label.split(' ')[0])
        .slice(0, 2);
      return `Market disruption: ${names.join('/')}`;
    }

    const fallbackName = displayEntity(entity);
    return fallbackName ? `Economic convergence: ${fallbackName}` : 'Economic convergence detected';
  },
};

const KNOWN_ENTITIES = /\b(Iran|Russia|China|North Korea|Venezuela|Cuba|Syria|Myanmar|Belarus|Turkey|Saudi|OPEC|EU|USA?|United States|India)\b(?![A-Za-z])/i;

function extractMentionedEntities(labels: string[]): string {
  for (const label of labels) {
    const match = KNOWN_ENTITIES.exec(label);
    if (match) return match[1]!;
  }
  return '';
}

const GENERIC_ENTITY_KEYS = new Set([
  'sanctions', 'trade', 'tariff', 'commodity', 'currency', 'energy',
  'embargo', 'semiconductor', 'crypto', 'inflation',
]);

function displayEntity(key?: string): string {
  if (!key) return '';
  if (GENERIC_ENTITY_KEYS.has(key)) return '';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
