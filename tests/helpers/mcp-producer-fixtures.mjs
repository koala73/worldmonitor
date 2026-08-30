import { toSeedEtfFlow } from '../../scripts/shared/etf-flow-provider.mjs';
import { toSeedQuote } from '../../scripts/shared/market-quote-provider.mjs';
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

  const evaluatedAt = Date.parse('2026-08-18T12:30:00.000Z');
  const fx = {
    pair: 'CNY/USD',
    rate: 0.1486,
    source: 'shared:fx-rates:v1',
    asOf: '2026-08-18T12:28:48.000Z',
  };
  const premiums = ['gold', 'silver'].map((metal) => ({
    metal,
    physical: {
      price: metal === 'gold' ? 953.88 : 12_345,
      currency: 'CNY',
      unit: metal === 'gold' ? 'gram' : 'kilogram',
      source: `Shanghai Gold Exchange ${metal === 'gold' ? 'SHAU' : 'SHAG'} PM benchmark`,
      asOf: '2026-08-18',
    },
    paper: {
      price: metal === 'gold' ? 4455.6 : 77.2,
      currency: 'USD',
      unit: 'troy ounce',
      source: `COMEX ${metal === 'gold' ? 'GC=F' : 'SI=F'} futures snapshot`,
      asOf: '2026-08-18T12:22:24.000Z',
    },
    premiumUsdPerOz: metal === 'gold' ? -46.7889 : 9.891,
    premiumPct: metal === 'gold' ? -1.0501 : 12.8122,
    computedAt: '2026-08-18T12:30:00.000Z',
  }));
  const readings = premiums.map((premium) => buildPhysicalDivergenceReading({
    metal: premium.metal,
    current: premium,
    history: Array.from({ length: 60 }, (_, index) => ({
      date: new Date(evaluatedAt - index * 86_400_000).toISOString().slice(0, 10),
      premiumPct: premium.premiumPct + index / 100,
      premiumUsdPerOz: premium.premiumUsdPerOz + index / 10,
      physicalAsOf: new Date(evaluatedAt - index * 86_400_000).toISOString().slice(0, 10),
      paperAsOf: new Date(evaluatedAt - index * 86_400_000).toISOString(),
      methodologyVersion: METHODOLOGY_VERSION,
    })),
    fx,
    nowMs: evaluatedAt,
  }));
  fixture.data['physical-premium'] = { premiums, fx };
  fixture.data['physical-divergence'] = {
    readings,
    composite: buildPhysicalStressComposite(readings),
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
  };

  return fixture;
}
