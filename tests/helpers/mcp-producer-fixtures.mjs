import { toSeedEtfFlow } from '../../scripts/shared/etf-flow-provider.mjs';
import { toSeedQuote } from '../../scripts/shared/market-quote-provider.mjs';
import { buildPhysicalPremiumPayload } from '../../scripts/seed-physical-premiums.mjs';
import {
  METHODOLOGY_VERSION,
  buildPhysicalDivergenceReading,
  buildPhysicalStressComposite,
} from '../../scripts/lib/physical-divergence.mjs';

/**
 * Overlay deterministic outputs from the real market seed mappers onto the
 * captured market bundle. The capture remains useful for broad shape/render
 * coverage, while these rows make schema and JMESPath checks fail if a mapper
 * stops emitting the fields the MCP surface promises.
 */
export function buildProducerBackedPhysicalComparisonFixture(state = 'ok') {
  const premium = buildPhysicalPremiumPayload({
    goldRows: [{ price: 953.88, unit: 'gram', session: 'PM', asOf: '2026-08-18' }],
    silverRows: [{ price: 12_345, unit: 'kilogram', session: 'PM', asOf: '2026-08-18' }],
    commodityQuotes: { quotes: [{ symbol: 'GC=F', price: 4455.6 }, { symbol: 'SI=F', price: 77.2 }] },
    fxRates: { CNY: 0.1486, fallbackCurrencies: [] },
    computedAt: '2026-08-18T12:30:00.000Z',
    paperAsOf: '2026-08-18T12:22:24.000Z',
    fxAsOf: '2026-08-18T12:28:48.000Z',
  });
  const baseNowMs = Date.parse('2026-08-18T12:30:00.000Z');
  const nowMs = state === 'stale_input' ? baseNowMs + 13 * 86_400_000 : baseNowMs;
  const historyPoints = state === 'insufficient_history' ? 59 : 60;
  const readings = premium.premiums.map((current) => buildPhysicalDivergenceReading({
    metal: current.metal,
    current: state === 'missing_input' ? null : current,
    history: Array.from({ length: historyPoints }, (_, index) => ({
      date: new Date(baseNowMs - index * 86_400_000).toISOString().slice(0, 10),
      premiumPct: current.premiumPct + index / 100,
      premiumUsdPerOz: current.premiumUsdPerOz + index / 10,
      physicalAsOf: new Date(baseNowMs - index * 86_400_000).toISOString().slice(0, 10),
      paperAsOf: new Date(baseNowMs - index * 86_400_000).toISOString(),
      methodologyVersion: METHODOLOGY_VERSION,
    })),
    fx: premium.fx,
    nowMs,
  }));
  return {
    premium,
    divergence: {
      readings,
      composite: buildPhysicalStressComposite(readings),
      evaluatedAt: new Date(nowMs).toISOString(),
      methodologyVersion: METHODOLOGY_VERSION,
    },
  };
}

export function buildProducerBackedMarketFixture(captured) {
  const fixture = structuredClone(captured);
  const quoteLists = [
    ['stocks-bootstrap', 'quotes'],
    ['commodities-bootstrap', 'quotes'],
    ['crypto', 'quotes'],
    ['gulf-quotes', 'quotes'],
  ];

  for (const [section, list] of quoteLists) {
    const rows = fixture.data?.[section]?.[list];
    if (!Array.isArray(rows)) continue;
    fixture.data[section][list] = rows.map((row, index) => ({
      ...row,
      ...toSeedQuote(
        row.symbol,
        { price: 100 + index, change: index % 2 === 0 ? 1.25 : -0.75, sparkline: [99 + index, 100 + index] },
        { name: row.name, display: row.display },
      ),
    }));
  }

  const sectors = fixture.data?.sectors?.sectors;
  if (Array.isArray(sectors)) {
    fixture.data.sectors.sectors = sectors.map((row, index) => ({
      ...row,
      change: index % 2 === 0 ? 1.1 : -0.6,
    }));
  }

  const etfs = fixture.data?.['etf-flows']?.etfs;
  if (Array.isArray(etfs)) {
    fixture.data['etf-flows'].etfs = etfs.map((row, index) => ({
      ...row,
      ...toSeedEtfFlow({
        ticker: row.ticker,
        issuer: row.issuer,
        price: 40 + index,
        priceChange: index % 2 === 0 ? 2.5 : -1.5,
        volume: 1_000_000 + index * 10_000,
        avgVolume: 900_000 + index * 10_000,
        volumeRatio: 1.1,
      }),
    }));
  }

  const physical = buildProducerBackedPhysicalComparisonFixture('ok');
  fixture.data['physical-premium'] = physical.premium;
  fixture.data['physical-divergence'] = physical.divergence;

  return fixture;
}
