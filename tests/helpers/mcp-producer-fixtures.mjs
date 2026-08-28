import { toSeedEtfFlow } from '../../scripts/shared/etf-flow-provider.mjs';
import { toSeedQuote } from '../../scripts/shared/market-quote-provider.mjs';

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

  return fixture;
}
